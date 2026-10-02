import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { handlePilotWorkspaceRoute } from '../routes/pilot-workspace.routes.mjs'
import { createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { createReceivingWorkbenchQueryService } from './receiving-workbench-query-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

const execFileAsync = promisify(execFile)

test('Pilot workspace APIs provision users, protect admin actions, and enforce warehouse scope', async t => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const admin = { authenticated: true, source: 'local_signed_session', tenantId: scenario.tenantId, userId: `admin-${randomUUID()}`, role: 'admin', name: 'Admin', email: 'admin@flowchain.local' }
    const manager = { ...scenario.actor, source: 'local_signed_session' }
    const viewer = { authenticated: true, source: 'local_signed_session', tenantId: scenario.tenantId, userId: `viewer-${randomUUID()}`, role: 'viewer', name: 'Viewer', email: 'viewer@example.com' }
    await prisma.user.createMany({ data: [
      { id: admin.userId, tenantId: scenario.tenantId, email: admin.email, name: admin.name, role: 'admin', status: 'active' },
      { id: manager.userId, tenantId: scenario.tenantId, email: 'kim@example.com', name: 'Kim', role: 'manager', jobTitle: '供应链经理', status: 'active', defaultWarehouseId: scenario.warehouseId },
      { id: viewer.userId, tenantId: scenario.tenantId, email: viewer.email, name: viewer.name, role: 'viewer', status: 'active' },
    ] })
    await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: scenario.tenantId, userId: manager.userId, warehouseId: scenario.warehouseId, accessLevel: 'operate' } })
    async function call(identity, method, path, body = {}) {
      let response
      const handled = await handlePilotWorkspaceRoute({ req: { method }, res: {}, url: new URL(path, 'http://local'), env: process.env, identity, readBody: async () => body, send(_res, status, payload) { response = { status, payload } } })
      assert.equal(handled, true)
      return response
    }
    try {
      const profile = await call(manager, 'GET', '/api/me/profile')
      assert.equal(profile.status, 200); assert.equal(profile.payload.name, 'Kim'); assert.equal(profile.payload.roleLabel, '供应链经理')
      assert.equal((await call(manager, 'PATCH', '/api/workspace', { version: 0, name: 'Forged' })).status, 403)
      const workspace = await call(admin, 'PATCH', '/api/workspace', { version: 0, name: 'Pilot Workspace', legalName: 'Pilot Legal', countryCode: 'CN', baseCurrency: 'CNY', timezone: 'Asia/Shanghai' })
      assert.equal(workspace.status, 200); assert.equal(workspace.payload.version, 1)

      const query = createReceivingWorkbenchQueryService({ prisma, capabilities: { posting: { enabled: true }, reversal: { enabled: true } } })
      assert.equal((await query.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: manager })).availableActions.canPost, true)
      await expectCommandError(query.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: viewer }), 'RECEIVING_NOT_FOUND')
      await expectCommandError(createReceivingPostingCommandService({ prisma, env: { NODE_ENV: 'production' } }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'viewer-scope-denied' }, { identity: { ...viewer, role: 'manager' } }), 'SESSION_STALE')
      const noScopeManager = { ...viewer, role: 'manager' }
      await prisma.user.update({ where: { id: viewer.userId }, data: { role: 'manager' } })
      await prisma.userRoleAssignment.deleteMany({ where: { userId: viewer.userId } })
      await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: scenario.tenantId, userId: viewer.userId, warehouseId: scenario.warehouseId, accessLevel: 'read' } })
      const readOnlyDetail = await query.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: noScopeManager })
      assert.equal(readOnlyDetail.availableActions.blockingReasonCodes.includes('WAREHOUSE_SCOPE_DENIED'), true)
      await expectCommandError(createReceivingPostingCommandService({ prisma, env: { NODE_ENV: 'production' } }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'manager-scope-denied' }, { identity: noScopeManager }), 'WAREHOUSE_SCOPE_DENIED')

      const invitation = await call(admin, 'POST', '/api/workspace/invitations', { email: 'new.user@example.com', role: 'viewer', expiryHours: 24 })
      assert.equal(invitation.status, 201); assert.ok(invitation.payload.invitationToken)
      assert.equal((await call(admin, 'POST', '/api/workspace/invitations', { email: 'new.user@example.com', role: 'manager' })).status, 409)
      const listed = await call(admin, 'GET', '/api/workspace/invitations')
      assert.equal(JSON.stringify(listed.payload).includes('tokenHash'), false); assert.equal(JSON.stringify(listed.payload).includes(invitation.payload.invitationToken), false)
      const accepted = await call({ authenticated: false }, 'POST', '/api/workspace/invitations/accept', { token: invitation.payload.invitationToken, name: 'New User', role: 'admin', tenantId: 'forged' })
      assert.equal(accepted.status, 200); assert.equal(accepted.payload.user.role, 'viewer'); assert.equal(accepted.payload.user.email, 'new.user@example.com')

      // An invitation needs an address sign-in accepts, and nobody already in the workspace.
      const badEmail = await call(admin, 'POST', '/api/workspace/invitations', { email: 'not an email', role: 'viewer' })
      assert.deepEqual([badEmail.status, badEmail.payload.code], [422, 'INVITATION_EMAIL_INVALID'])
      const member = await call(admin, 'POST', '/api/workspace/invitations', { email: 'New.User@Example.com', role: 'manager' })
      assert.deepEqual([member.status, member.payload.code], [409, 'INVITATION_ALREADY_MEMBER'])
      // The link shows what it is for before it is accepted, without a session.
      const financeInvite = await call(admin, 'POST', '/api/workspace/invitations', { email: 'finance.lead@example.com', role: 'finance-specialist' })
      assert.equal(financeInvite.status, 201)
      const inspected = await call({ authenticated: false }, 'POST', '/api/workspace/invitations/inspect', { token: financeInvite.payload.invitationToken })
      assert.equal(inspected.status, 200)
      assert.deepEqual([inspected.payload.email, inspected.payload.role, inspected.payload.workspaceName], ['finance.lead@example.com', 'finance-specialist', 'Pilot Workspace'])
      assert.equal((await call({ authenticated: false }, 'POST', '/api/workspace/invitations/inspect', { token: 'forged' })).status, 400)
      // Accepting assigns the invitation's role template at once.
      const financeAccepted = await call({ authenticated: false }, 'POST', '/api/workspace/invitations/accept', { token: financeInvite.payload.invitationToken, name: 'Fin Lead' })
      assert.equal(financeAccepted.status, 200)
      const assignments = await prisma.userRoleAssignment.findMany({ where: { userId: financeAccepted.payload.user.id }, include: { role: true } })
      assert.deepEqual(assignments.map((entry) => entry.role.roleKey), ['finance-specialist'])
      assert.equal((await call({ authenticated: false }, 'POST', '/api/workspace/invitations/inspect', { token: financeInvite.payload.invitationToken })).status, 400)
      // An administrator cannot disable themselves; disabling a member works.
      const self = await prisma.user.findUnique({ where: { id: admin.userId } })
      const selfDisable = await call(admin, 'PATCH', `/api/workspace/users/${admin.userId}`, { status: 'disabled', version: self.version })
      assert.deepEqual([selfDisable.status, selfDisable.payload.code], [409, 'CANNOT_DISABLE_SELF'])
      const disabled = await call(admin, 'PATCH', `/api/workspace/users/${financeAccepted.payload.user.id}`, { status: 'disabled', version: financeAccepted.payload.user.version })
      assert.deepEqual([disabled.status, disabled.payload.status], [200, 'disabled'])

      const setupTenantId = `setup-${randomUUID()}`
      const setupScript = resolve('scripts/setup-pilot-workspace.mjs')
      await execFileAsync(process.execPath, [setupScript, `--tenant-id=${setupTenantId}`, '--workspace-name=First Pilot'], { env: process.env })
      const setupKim = await prisma.user.findFirst({ where: { tenantId: setupTenantId, email: 'kim@example.com' }, include: { warehouseScopes: true } })
      assert.equal(setupKim.role, 'manager'); assert.equal(setupKim.jobTitle, 'Supply Chain Manager'); assert.equal(setupKim.warehouseScopes[0].accessLevel, 'operate')
      assert.equal(await prisma.user.count({ where: { tenantId: setupTenantId, role: 'admin' } }), 1)
      await prisma.tenant.update({ where: { id: setupTenantId }, data: { name: 'Preserved Workspace' } })
      await execFileAsync(process.execPath, [setupScript, `--tenant-id=${setupTenantId}`, '--workspace-name=Must Not Overwrite'], { env: process.env })
      assert.equal((await prisma.tenant.findUnique({ where: { id: setupTenantId } })).name, 'Preserved Workspace')
      await prisma.userWarehouseScope.deleteMany({ where: { tenantId: setupTenantId } }); await prisma.user.deleteMany({ where: { tenantId: setupTenantId } }); await prisma.auditLog.deleteMany({ where: { tenantId: setupTenantId } }); await prisma.warehouse.deleteMany({ where: { tenantId: setupTenantId } }); await prisma.tenant.delete({ where: { id: setupTenantId } })
    } finally {
      await prisma.workspaceInvitation.deleteMany({ where: { tenantId: scenario.tenantId } })
      await prisma.userWarehouseScope.deleteMany({ where: { tenantId: scenario.tenantId } })
      await cleanupReceivingScenario(prisma, scenario)
    }
  })
})
