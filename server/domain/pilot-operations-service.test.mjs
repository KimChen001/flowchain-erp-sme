import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPilotOperationsService } from './pilot-operations-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { createAuthorizationAdminService } from '../auth/authorization-admin-service.mjs'
import { backfillTenantAuthorization } from '../auth/authorization-backfill.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

test('Pilot diagnostics are admin-only and exports honor tenant and warehouse scope', async t => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const actor = { ...scenario.actor, source: 'local_signed_session', role: 'admin' }
    await prisma.user.create({ data: { id: actor.userId, tenantId: scenario.tenantId, email: 'pilot-ops@example.com', name: 'Pilot Ops Admin', role: 'admin', status: 'active' } })
    const service = createPilotOperationsService({ prisma, now: () => new Date('2026-07-15T00:00:00.000Z') })
    try {
      const diagnostics = await service.diagnostics(actor)
      assert.equal(diagnostics.safe, true)
      assert.equal(diagnostics.checks.find(check => check.id === 'migrations').status, 'pass')
      assert.doesNotMatch(JSON.stringify(diagnostics), /DATABASE_URL|password|tokenHash|session/i)

      const adminExport = await service.exportDataset('receiving_documents', actor)
      assert.equal(adminExport.rowCount, 1); assert.equal(adminExport.rows[0].documentNumber.startsWith('GRN-'), true)

      await prisma.user.update({ where: { id: actor.userId }, data: { role: 'manager', rolesAssignedAt: null } }); actor.role = 'manager'
      await prisma.userRoleAssignment.deleteMany({ where: { userId: actor.userId } })
      await prisma.userWarehouseScope.upsert({ where: { tenantId_userId_warehouseId: { tenantId: scenario.tenantId, userId: actor.userId, warehouseId: scenario.warehouseId } }, create: { id: randomUUID(), tenantId: scenario.tenantId, userId: actor.userId, warehouseId: scenario.warehouseId, accessLevel: 'read' }, update: { accessLevel: 'read' } })
      assert.equal((await service.exportDataset('receiving_documents', actor)).rowCount, 1)
      await expectCommandError(service.diagnostics(actor), 'AUTHORIZATION_PERMISSION_DENIED')
      await expectCommandError(service.exportDataset('unknown', actor), 'EXPORT_DATASET_UNSUPPORTED')
    } finally { await cleanupReceivingScenario(prisma, scenario) }
  })
})

test('Pilot diagnostics count role managers and unscoped users from assignments, not the legacy role', async t => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const tenantId = scenario.tenantId
    const person = (key, role) => ({ authenticated: true, source: 'local_signed_session', tenantId, userId: `${key}-${randomUUID()}`, role, name: key, email: `${key}@example.com` })
    const lead = person('lead', 'manager'); const founder = person('founder', 'admin'); const auditor = person('auditor', 'viewer')
    await prisma.user.createMany({ data: [lead, founder, auditor].map(identity => ({ id: identity.userId, tenantId, email: identity.email, name: identity.name, role: identity.role, status: 'active' })) })
    await prisma.userWarehouseScope.createMany({ data: [lead, auditor].map(identity => ({ id: randomUUID(), tenantId, userId: identity.userId, warehouseId: scenario.warehouseId, accessLevel: 'read' })) })
    // The legacy admin gets Workspace Administrator and an operate scope.
    await backfillTenantAuthorization(prisma, tenantId)
    const service = createPilotOperationsService({ prisma })
    const governance = createAuthorizationAdminService({ prisma })
    const check = async (identity, id) => (await service.diagnostics(identity)).checks.find(row => row.id === id)
    try {
      // The legacy manager is made Workspace Administrator and the legacy
      // admin is disabled, so the only user who can manage roles is not named
      // admin. That is a pass.
      const roles = await prisma.tenantRole.findMany({ where: { tenantId } })
      const administratorRoleId = roles.find(role => role.roleKey === 'workspace-administrator').id
      await governance.assignUserRoles(await resolveProvisionedActor(prisma, founder), lead.userId, [administratorRoleId])
      await prisma.user.update({ where: { id: founder.userId }, data: { status: 'disabled' } })
      const users = await check(lead, 'users')
      assert.deepEqual([users.status, users.detail], ['pass', '2 active users; 1 can manage roles'])
      assert.equal((await check(lead, 'warehouse_scopes')).status, 'pass')

      // An active legacy admin without a warehouse scope has no warehouse
      // access, so it is reported like any other unscoped user.
      await prisma.user.update({ where: { id: founder.userId }, data: { status: 'active' } })
      await prisma.userWarehouseScope.deleteMany({ where: { tenantId, userId: founder.userId } })
      const scopes = await check(lead, 'warehouse_scopes')
      assert.deepEqual([scopes.status, scopes.detail], ['warn', '1 active users without warehouse scope'])

      // Once no active user holds Workspace Administrator, nobody can manage
      // roles and the check fails, though a legacy admin is still active. The
      // auditor reads diagnostics through a custom role.
      const leadActor = await resolveProvisionedActor(prisma, lead)
      const auditorRole = await governance.createRole(leadActor, { name: 'Readiness Auditor', permissionCodes: ['settings.diagnostics.read'] })
      await governance.assignUserRoles(leadActor, auditor.userId, [auditorRole.id])
      await prisma.userRoleAssignment.deleteMany({ where: { tenantId, roleId: administratorRoleId } })
      const lost = await check(auditor, 'users')
      assert.deepEqual([lost.status, lost.detail], ['fail', '3 active users; 0 can manage roles'])
    } finally { await cleanupReceivingScenario(prisma, scenario) }
  })
})
