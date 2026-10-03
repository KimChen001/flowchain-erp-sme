import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createAuthorizationAdminService } from '../../server/auth/authorization-admin-service.mjs'
import { can, resolveAuthorizationContext } from '../../server/auth/authorization-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// The legacy User.role grants a role template once per user, only while the
// user's roles have never been set. After that the role assignments an
// administrator chose are the user's roles, even when they are none: a later
// backfill, a new teammate's first request or the user's own next request
// never brings an old template back.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/role-backfill-once.test.mjs

const tenantId = 'tenant-role-backfill'
const identity = (userId, role) => ({ authenticated: true, tenantId, userId, role, source: 'test' })

async function context(prisma, userId, role) {
  return resolveAuthorizationContext(identity(userId, role), { prisma })
}
const roleKeys = (actor) => (actor.roles || []).map((role) => role.roleKey).sort()

test('removed roles stay removed', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Role backfill' } })
    await prisma.warehouse.create({ data: { id: 'rb-wh', tenantId, code: 'RB-WH', name: 'Main', status: 'active' } })
    for (const [id, role] of [['rb-admin', 'admin'], ['rb-ops', 'manager'], ['rb-buyer', 'buyer']]) await prisma.user.create({ data: { id, tenantId, email: `${id}@role-backfill.invalid`, name: id, role } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: 'rb-admin' })
    const marked = await prisma.user.findMany({ where: { tenantId }, select: { id: true, rolesAssignedAt: true } })
    assert.ok(marked.every((user) => user.rolesAssignedAt), 'the backfill marks every user it assigned')

    const admin = await context(prisma, 'rb-admin', 'admin')
    const roles = await prisma.tenantRole.findMany({ where: { tenantId } })
    const roleId = (roleKey) => roles.find((role) => role.roleKey === roleKey).id
    const service = createAuthorizationAdminService({ prisma })

    // The admin moves the ops lead from Operations Manager to Read-only Viewer.
    assert.equal(can({ actor: await context(prisma, 'rb-ops', 'manager'), permission: 'procurement.purchase_order.approve', tenantId }), true)
    await service.assignUserRoles(admin, 'rb-ops', [roleId('read-only-viewer')])
    // ...and removes every role from the buyer, the offboarding path.
    await service.assignUserRoles(admin, 'rb-buyer', [])

    // A new teammate's first request runs the backfill for the workspace.
    await prisma.user.create({ data: { id: 'rb-new', tenantId, email: 'rb-new@role-backfill.invalid', name: 'New teammate', role: 'manager' } })
    const newcomer = await context(prisma, 'rb-new', 'manager')
    assert.deepEqual(roleKeys(newcomer), ['operations-manager'], 'a user whose roles were never set still gets the legacy template once')

    // Neither change is undone, by that backfill, by another run, or by the
    // users' own next requests.
    await backfillTenantAuthorization(prisma, tenantId, { actorId: 'rb-admin' })
    const ops = await context(prisma, 'rb-ops', 'manager')
    assert.deepEqual(roleKeys(ops), ['read-only-viewer'])
    assert.equal(can({ actor: ops, permission: 'procurement.purchase_order.approve', tenantId }), false)
    const buyer = await context(prisma, 'rb-buyer', 'buyer')
    assert.deepEqual(roleKeys(buyer), [])
    assert.equal(buyer.permissionCodes.size, 0)
    assert.equal(await prisma.userRoleAssignment.count({ where: { tenantId, userId: 'rb-buyer' } }), 0)

    // An administrator who later gives the buyer a role again is obeyed.
    await service.assignUserRoles(admin, 'rb-buyer', [roleId('procurement-specialist')])
    assert.deepEqual(roleKeys(await context(prisma, 'rb-buyer', 'buyer')), ['procurement-specialist'])
  } finally {
    await prisma.$disconnect()
  }
})
