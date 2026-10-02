import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { handlePilotWorkspaceRoute } from '../routes/pilot-workspace.routes.mjs'
import { countActiveRoleManagers, createAuthorizationAdminService } from '../auth/authorization-admin-service.mjs'
import { backfillTenantAuthorization } from '../auth/authorization-backfill.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { createReceivingWorkbenchQueryService } from './receiving-workbench-query-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

const execFileAsync = promisify(execFile)

async function call(identity, method, path, body = {}) {
  let response
  const handled = await handlePilotWorkspaceRoute({ req: { method }, res: {}, url: new URL(path, 'http://local'), env: process.env, identity, readBody: async () => body, send(_res, status, payload) { response = { status, payload } } })
  assert.equal(handled, true)
  return response
}

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
      await prisma.user.update({ where: { id: viewer.userId }, data: { role: 'manager', rolesAssignedAt: null } })
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

      // The user endpoint changes status only. Roles come from role
      // assignments, so a legacy role change is refused and nothing is written.
      const kimBefore = await prisma.user.findUnique({ where: { id: manager.userId } })
      const roleChange = await call(admin, 'PATCH', `/api/workspace/users/${manager.userId}`, { role: 'admin', status: 'active', version: kimBefore.version })
      assert.deepEqual([roleChange.status, roleChange.payload.code], [422, 'USER_ROLE_CHANGE_NOT_SUPPORTED'])
      assert.match(roleChange.payload.message, /Roles & permissions/)
      const kimAfter = await prisma.user.findUnique({ where: { id: manager.userId } })
      assert.deepEqual([kimAfter.role, kimAfter.status, kimAfter.version], ['manager', 'active', kimBefore.version])
      // Status changes still work, also when the current role is sent back unchanged.
      const enabled = await call(admin, 'PATCH', `/api/workspace/users/${financeAccepted.payload.user.id}`, { role: 'finance-specialist', status: 'active', version: disabled.payload.version })
      assert.deepEqual([enabled.status, enabled.payload.status, enabled.payload.role], [200, 'active', 'finance-specialist'])

      // Whether a member may be disabled follows role assignments too. Kim
      // keeps the legacy manager role but is made Workspace Administrator.
      const governance = createAuthorizationAdminService({ prisma })
      const tenantRoles = await prisma.tenantRole.findMany({ where: { tenantId: scenario.tenantId } })
      const administratorRole = tenantRoles.find(role => role.roleKey === 'workspace-administrator')
      await governance.assignUserRoles(await resolveProvisionedActor(prisma, admin), manager.userId, [administratorRole.id])
      // So Kim may disable the only legacy admin: Kim can still manage roles.
      const adminRow = await prisma.user.findUnique({ where: { id: admin.userId } })
      const adminDisabled = await call(manager, 'PATCH', `/api/workspace/users/${admin.userId}`, { status: 'disabled', version: adminRow.version })
      assert.deepEqual([adminDisabled.status, adminDisabled.payload.status], [200, 'disabled'])
      // A user administrator who may disable members but not manage roles
      // cannot disable Kim, the last active user who can manage roles.
      const kimActor = await resolveProvisionedActor(prisma, manager)
      const userAdministrator = await governance.createRole(kimActor, { name: 'User Administrator', permissionCodes: ['settings.users.read', 'settings.users.manage'] })
      await governance.assignUserRoles(kimActor, viewer.userId, [userAdministrator.id])
      const kimRow = await prisma.user.findUnique({ where: { id: manager.userId } })
      const lastManager = await call(noScopeManager, 'PATCH', `/api/workspace/users/${manager.userId}`, { status: 'disabled', version: kimRow.version })
      assert.deepEqual([lastManager.status, lastManager.payload.code], [409, 'AUTHORIZATION_LAST_ROLES_MANAGER'])
      const kimKept = await prisma.user.findUnique({ where: { id: manager.userId } })
      assert.deepEqual([kimKept.status, kimKept.version], ['active', kimRow.version])
      // Once another role manager is active again, Kim can be disabled.
      const adminEnabled = await call(noScopeManager, 'PATCH', `/api/workspace/users/${admin.userId}`, { status: 'active', version: adminDisabled.payload.version })
      assert.deepEqual([adminEnabled.status, adminEnabled.payload.status], [200, 'active'])
      const kimDisabled = await call(noScopeManager, 'PATCH', `/api/workspace/users/${manager.userId}`, { status: 'disabled', version: kimRow.version })
      assert.deepEqual([kimDisabled.status, kimDisabled.payload.status], [200, 'disabled'])
      // Inviting assigns the invited role on acceptance, so it needs
      // settings.roles.assign as well as settings.users.manage.
      const userAdminInvite = await call(noScopeManager, 'POST', '/api/workspace/invitations', { email: 'second.admin@example.com', role: 'admin' })
      assert.deepEqual([userAdminInvite.status, userAdminInvite.payload.code], [403, 'AUTHORIZATION_PERMISSION_DENIED'])

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

test('Workspace member reads show every warehouse, and concurrent status changes keep a role manager', async t => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const tenantId = scenario.tenantId
    const secondWarehouseId = `warehouse-second-${randomUUID()}`
    await prisma.warehouse.create({ data: { id: secondWarehouseId, tenantId, code: `WH2-${randomUUID()}`, name: 'Second Warehouse', status: 'active' } })
    const person = (key, role) => ({ authenticated: true, source: 'local_signed_session', tenantId, userId: `${key}-${randomUUID()}`, role, name: key, email: `${key}@example.com` })
    const owner = person('owner', 'admin'); const deputy = person('deputy', 'admin')
    const userAdmin = person('user-admin', 'viewer'); const reader = person('reader', 'viewer'); const buyer = person('buyer', 'buyer')
    const members = Array.from({ length: 12 }, (_, index) => person(`member-${index}`, 'viewer'))
    await prisma.user.createMany({ data: [owner, deputy, userAdmin, reader, buyer, ...members].map(identity => ({ id: identity.userId, tenantId, email: identity.email, name: identity.name, role: identity.role, status: 'active' })) })
    await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: buyer.userId, warehouseId: scenario.warehouseId, accessLevel: 'read' } })
    // Legacy admins get Workspace Administrator and operate on every warehouse;
    // legacy viewers get Read-only Viewer and no warehouse.
    await backfillTenantAuthorization(prisma, tenantId)
    try {
      // A Read-only Viewer with no warehouse of their own may read members'
      // access, so they get every warehouse to show it against. Someone who
      // cannot read members' access gets only their own warehouses.
      const readerUsers = await call(reader, 'GET', '/api/workspace/users')
      assert.equal(readerUsers.status, 200)
      assert.deepEqual(readerUsers.payload.users.find(user => user.id === owner.userId).warehouseScopes.map(scope => scope.warehouseId).sort(), [scenario.warehouseId, secondWarehouseId].sort())
      const readerWarehouses = await call(reader, 'GET', '/api/workspace/warehouses')
      assert.deepEqual(readerWarehouses.payload.warehouses.map(warehouse => warehouse.id).sort(), [scenario.warehouseId, secondWarehouseId].sort())
      const buyerWarehouses = await call(buyer, 'GET', '/api/workspace/warehouses')
      assert.deepEqual(buyerWarehouses.payload.warehouses.map(warehouse => warehouse.id), [scenario.warehouseId])

      // A user administrator may disable members but not manage roles.
      const governance = createAuthorizationAdminService({ prisma })
      const ownerActor = await resolveProvisionedActor(prisma, owner)
      const userAdministrator = await governance.createRole(ownerActor, { name: 'User Administrator', permissionCodes: ['settings.users.read', 'settings.users.manage'] })
      await governance.assignUserRoles(ownerActor, userAdmin.userId, [userAdministrator.id])
      // Sets the status of several users at the same moment. Versions are read
      // first, so the requests start together.
      const setStatus = async (identities, status) => {
        const rows = await prisma.user.findMany({ where: { id: { in: identities.map(identity => identity.userId) } } })
        const version = id => rows.find(row => row.id === id).version
        return Promise.all(identities.map(identity => call(userAdmin, 'PATCH', `/api/workspace/users/${identity.userId}`, { status, version: version(identity.userId) })))
      }

      // Members disabled at the same moment all succeed: a transaction aborted
      // by a concurrent one is run again, not answered with an error. Whether
      // two transactions collide depends on timing, so this runs a few rounds.
      for (let round = 0; round < 3; round += 1) {
        const batch = members.slice(round * 4, round * 4 + 4)
        const results = await setStatus(batch, 'disabled')
        assert.deepEqual(results.map(result => [result.status, result.payload.status]), batch.map(() => [200, 'disabled']))
      }
      assert.equal(await prisma.user.count({ where: { id: { in: members.map(member => member.userId) }, status: 'disabled' } }), members.length)

      // Disabling the last two role managers at the same moment: one goes
      // through, the other is refused, and one role manager stays active.
      for (let round = 0; round < 3; round += 1) {
        const results = await setStatus([owner, deputy], 'disabled')
        assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
        assert.equal(results.find(result => result.status === 409).payload.code, 'AUTHORIZATION_LAST_ROLES_MANAGER')
        assert.equal(await countActiveRoleManagers(prisma, tenantId), 1)
        const [enabled] = await setStatus([[owner, deputy][results.findIndex(result => result.status === 200)]], 'active')
        assert.deepEqual([enabled.status, enabled.payload.status], [200, 'active'])
      }
    } finally {
      await cleanupReceivingScenario(prisma, scenario)
    }
  })
})
