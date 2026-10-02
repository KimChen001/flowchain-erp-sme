import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { resolveProvisionedActor } from '../../server/domain/pilot-identity.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { REPORT_VIEW_NAMESPACE, createReportViewRepository, reportViewActor } from '../../server/repositories/report-view-repository.mjs'
import { handleReportViewsRoute } from '../../server/routes/report-views.routes.mjs'

// Saved report views through /api/report-views, against PostgreSQL: each view
// is a RuntimeRecord of one workspace, private views stay with their owner
// (administrators included), team views reach only the same workspace, and
// every change is version checked and audited in that workspace.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/report-views.test.mjs

const tenantA = 'tenant-report-views-a'
const tenantB = 'tenant-report-views-b'
const users = {
  owner: { id: 'rv-owner-a', tenantId: tenantA, email: 'owner@report-views-a.invalid', name: 'Olivia Owner', role: 'manager' },
  member: { id: 'rv-member-a', tenantId: tenantA, email: 'member@report-views-a.invalid', name: 'Milo Member', role: 'viewer' },
  admin: { id: 'rv-admin-a', tenantId: tenantA, email: 'admin@report-views-a.invalid', name: 'Ada Admin', role: 'admin' },
  ownerB: { id: 'rv-owner-b', tenantId: tenantB, email: 'owner@report-views-b.invalid', name: 'Bea Owner', role: 'manager' },
  adminB: { id: 'rv-admin-b', tenantId: tenantB, email: 'admin@report-views-b.invalid', name: 'Ben Admin', role: 'admin' },
}
const identityOf = (user) => ({ authenticated: true, tenantId: user.tenantId, userId: user.id, role: user.role })
const viewInput = (name, visibility = 'private') => ({ name, subject: 'purchase_orders', sourceRoute: '/app/reports/procurement', columns: ['id', 'supplier', 'amount'], measures: ['purchase_order_amount'], filters: { status: 'open' }, visibility })

async function call(prisma, user, method, pathname, body, headers = {}) {
  let sent
  const ctx = {
    identity: identityOf(user), reportViewsPrisma: prisma,
    req: { method, headers }, res: {}, url: new URL(`http://local${pathname}`),
    readBody: async () => typeof body === 'function' ? body() : body ?? {},
    send: (_res, status, payload) => { sent = { status, payload } },
  }
  assert.equal(await handleReportViewsRoute(ctx), true, `${method} ${pathname}`)
  return sent
}
const names = (payload) => payload.views.map((view) => view.name).sort()
const viewPath = (view) => `/api/report-views/${encodeURIComponent(view.viewId)}`

test('saved report views are persisted per workspace and authorized from the signed-in actor', async (t) => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    for (const tenantId of [tenantA, tenantB]) await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: user })
    await backfillTenantAuthorization(prisma, tenantA, { actorId: users.admin.id })
    await backfillTenantAuthorization(prisma, tenantB, { actorId: users.adminB.id })

    const created = {}
    for (const [key, user, name, visibility] of [
      ['privateA', users.owner, 'Owner private review', 'private'],
      ['teamA', users.owner, 'Owner team review', 'team'],
      ['privateB', users.ownerB, 'Tenant B private review', 'private'],
      ['teamB', users.ownerB, 'Tenant B team review', 'team'],
    ]) {
      const result = await call(prisma, user, 'POST', '/api/report-views', viewInput(name, visibility))
      assert.equal(result.status, 201, JSON.stringify(result.payload))
      created[key] = result.payload.view
    }

    await t.test('each view is one RuntimeRecord of its own workspace, keyed by the view id', async () => {
      const rows = await prisma.runtimeRecord.findMany({ where: { namespace: REPORT_VIEW_NAMESPACE }, orderBy: { recordKey: 'asc' } })
      assert.equal(rows.length, 4)
      const byKey = new Map(rows.map((row) => [row.recordKey, row]))
      for (const [key, tenantId] of [['privateA', tenantA], ['teamA', tenantA], ['privateB', tenantB], ['teamB', tenantB]]) {
        const row = byKey.get(created[key].viewId)
        assert.equal(row.tenantId, tenantId, key)
        assert.equal(row.payload.name, created[key].name)
      }
      assert.deepEqual([created.teamA.ownerId, created.teamA.ownerName, created.teamA.version], [users.owner.id, users.owner.name, 1])
      assert.deepEqual(created.teamA.filters, { status: 'open' })
    })

    await t.test('a private view is visible to its owner only, never to an administrator', async () => {
      const owner = await call(prisma, users.owner, 'GET', '/api/report-views')
      assert.equal(owner.status, 200)
      assert.deepEqual(names(owner.payload), ['Owner private review', 'Owner team review'])
      assert.deepEqual(owner.payload.actor, { id: users.owner.id, name: users.owner.name, role: 'manager', canManageTeamViews: false })
      for (const user of [users.member, users.admin]) {
        const list = await call(prisma, user, 'GET', '/api/report-views')
        assert.deepEqual(names(list.payload), ['Owner team review'], user.id)
        assert.equal((await call(prisma, user, 'GET', viewPath(created.privateA))).status, 404, user.id)
        assert.equal((await call(prisma, user, 'PUT', viewPath(created.privateA), { name: 'Taken over', expectedVersion: 1 })).status, 404, user.id)
        assert.equal((await call(prisma, user, 'POST', `${viewPath(created.privateA)}/share`, { expectedVersion: 1 })).status, 404, user.id)
        assert.equal((await call(prisma, user, 'POST', `${viewPath(created.privateA)}/clone`, {})).status, 404, user.id)
        assert.equal((await call(prisma, user, 'DELETE', viewPath(created.privateA))).status, 404, user.id)
      }
      assert.equal((await call(prisma, users.admin, 'GET', '/api/report-views')).payload.actor.canManageTeamViews, true)
      assert.deepEqual(names((await call(prisma, users.owner, 'GET', '/api/report-views?visibility=private')).payload), ['Owner private review'])
    })

    await t.test('nothing crosses workspaces: a team view reaches only its own workspace', async () => {
      for (const user of [users.ownerB, users.adminB]) {
        assert.deepEqual(names((await call(prisma, user, 'GET', '/api/report-views')).payload), user === users.ownerB ? ['Tenant B private review', 'Tenant B team review'] : ['Tenant B team review'])
        for (const view of [created.privateA, created.teamA]) {
          assert.equal((await call(prisma, user, 'GET', viewPath(view))).status, 404)
          assert.equal((await call(prisma, user, 'PUT', viewPath(view), { name: 'Cross-tenant edit', expectedVersion: 1 })).status, 404)
          assert.equal((await call(prisma, user, 'POST', `${viewPath(view)}/clone`, {})).status, 404)
          assert.equal((await call(prisma, user, 'DELETE', viewPath(view))).status, 404)
        }
      }
      for (const user of [users.owner, users.member, users.admin]) {
        assert.ok(!names((await call(prisma, user, 'GET', '/api/report-views')).payload).some((name) => name.startsWith('Tenant B')), user.id)
        assert.equal((await call(prisma, user, 'GET', viewPath(created.teamB))).status, 404)
      }
      // The same record key in another workspace is a different view.
      await prisma.runtimeRecord.create({ data: { id: 'rv-same-key-b', tenantId: tenantB, namespace: REPORT_VIEW_NAMESPACE, recordKey: created.teamA.viewId, payload: { ...created.teamB, viewId: created.teamA.viewId, name: 'Tenant B same id' } } })
      assert.equal((await call(prisma, users.member, 'GET', viewPath(created.teamA))).payload.name, 'Owner team review')
      assert.equal((await call(prisma, users.adminB, 'GET', viewPath(created.teamA))).payload.name, 'Tenant B same id')
      await prisma.runtimeRecord.delete({ where: { id: 'rv-same-key-b' } })
    })

    await t.test('legacy role and user headers grant nothing', async () => {
      const headers = { 'x-flowchain-role': 'admin', 'x-flowchain-user': users.owner.id }
      const list = await call(prisma, users.member, 'GET', '/api/report-views', undefined, headers)
      assert.deepEqual([names(list.payload), list.payload.actor.id, list.payload.actor.canManageTeamViews], [['Owner team review'], users.member.id, false])
      assert.equal((await call(prisma, users.member, 'GET', viewPath(created.privateA), undefined, headers)).status, 404)
      assert.equal((await call(prisma, users.member, 'DELETE', viewPath(created.teamA), undefined, headers)).status, 403)
    })

    await t.test('a body that is not JSON is refused with a 400', async () => {
      const refused = await call(prisma, users.owner, 'POST', '/api/report-views', () => JSON.parse('{not json'))
      assert.deepEqual([refused.status, refused.payload.code], [400, 'REPORT_VIEW_INVALID_BODY'])
    })

    await t.test('a member cannot change a team view; the owner and a workspace administrator can', async () => {
      const denied = await call(prisma, users.member, 'PUT', viewPath(created.teamA), { name: 'Member edit', expectedVersion: 1 })
      assert.deepEqual([denied.status, denied.payload.code], [403, 'REPORT_VIEW_FORBIDDEN'])
      assert.equal((await call(prisma, users.member, 'POST', `${viewPath(created.teamA)}/share`, { visibility: 'private', expectedVersion: 1 })).status, 403)
      assert.equal((await call(prisma, users.member, 'DELETE', viewPath(created.teamA))).status, 403)

      const edited = await call(prisma, users.admin, 'PUT', viewPath(created.teamA), { name: 'Team review (admin)', expectedVersion: 1, ownerId: users.admin.id, version: 99 })
      assert.equal(edited.status, 200, JSON.stringify(edited.payload))
      // The body cannot move ownership or the version.
      assert.deepEqual([edited.payload.view.name, edited.payload.view.ownerId, edited.payload.view.version, edited.payload.view.visibility], ['Team review (admin)', users.owner.id, 2, 'team'])
      const byOwner = await call(prisma, users.owner, 'PUT', viewPath(created.teamA), { name: 'Owner team review', columns: ['id', 'amount'], expectedVersion: 2 })
      assert.deepEqual([byOwner.status, byOwner.payload.view.version, byOwner.payload.view.columns], [200, 3, ['id', 'amount']])
    })

    await t.test('a stale or missing version is refused and the view is left as it was', async () => {
      const stale = await call(prisma, users.admin, 'PUT', viewPath(created.teamA), { name: 'Lost update', expectedVersion: 2 })
      assert.deepEqual([stale.status, stale.payload.code, stale.payload.currentVersion, stale.payload.expectedVersion], [409, 'VERSION_CONFLICT', 3, 2])
      const missing = await call(prisma, users.owner, 'PUT', viewPath(created.teamA), { name: 'No version' })
      assert.deepEqual([missing.status, missing.payload.code], [422, 'REPORT_VIEW_INVALID'])
      assert.equal((await call(prisma, users.owner, 'POST', `${viewPath(created.teamA)}/share`, { visibility: 'private' })).status, 422)
      const invalid = await call(prisma, users.owner, 'PUT', viewPath(created.teamA), { columns: ['password'], expectedVersion: 3 })
      assert.deepEqual([invalid.status, invalid.payload.errors], [422, ['field password is not governed for purchase_orders']])
      const view = (await call(prisma, users.owner, 'GET', viewPath(created.teamA))).payload
      assert.deepEqual([view.name, view.version], ['Owner team review', 3])

      // Two people saving the same version at once: one wins, one is told to reload.
      const racing = await Promise.all([
        call(prisma, users.owner, 'PUT', viewPath(created.teamA), { description: 'Owner note', expectedVersion: 3 }),
        call(prisma, users.admin, 'PUT', viewPath(created.teamA), { description: 'Admin note', expectedVersion: 3 }),
      ])
      assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409])
      assert.equal((await call(prisma, users.owner, 'GET', viewPath(created.teamA))).payload.version, 4)
    })

    await t.test('sharing needs ownership only; unsharing takes a view back from the team', async () => {
      const mine = await call(prisma, users.member, 'POST', '/api/report-views', viewInput('Member layout'))
      assert.equal(mine.status, 201)
      const shared = await call(prisma, users.member, 'POST', `${viewPath(mine.payload.view)}/share`, { expectedVersion: 1 })
      assert.deepEqual([shared.status, shared.payload.view.visibility, shared.payload.view.version], [200, 'team', 2])
      assert.ok(names((await call(prisma, users.owner, 'GET', '/api/report-views')).payload).includes('Member layout'))
      const unshared = await call(prisma, users.member, 'PUT', viewPath(mine.payload.view), { visibility: 'private', expectedVersion: 2 })
      assert.deepEqual([unshared.status, unshared.payload.view.visibility], [200, 'private'])
      for (const user of [users.owner, users.admin]) assert.ok(!names((await call(prisma, user, 'GET', '/api/report-views')).payload).includes('Member layout'), user.id)
    })

    await t.test('a copy is a private view of whoever copies it', async () => {
      const copy = await call(prisma, users.member, 'POST', `${viewPath(created.teamA)}/clone`, {})
      assert.equal(copy.status, 201)
      assert.deepEqual([copy.payload.view.name, copy.payload.view.ownerId, copy.payload.view.visibility, copy.payload.view.version], ['Owner team review (Copy)', users.member.id, 'private', 1])
      assert.ok(names((await call(prisma, users.member, 'GET', '/api/report-views')).payload).includes('Owner team review (Copy)'))
      for (const user of [users.owner, users.admin]) assert.ok(!names((await call(prisma, user, 'GET', '/api/report-views')).payload).includes('Owner team review (Copy)'), user.id)
      assert.equal((await call(prisma, users.member, 'DELETE', viewPath(copy.payload.view))).status, 200)
    })

    await t.test('views survive a new repository instance and a new database client', async () => {
      const restarted = await createPrismaClient(process.env)
      try {
        const actor = reportViewActor(await resolveProvisionedActor(restarted, identityOf(users.owner)))
        const views = await createReportViewRepository({ prisma: restarted }).list(actor)
        assert.deepEqual(views.map((view) => [view.name, view.version]).sort(), [['Owner private review', 1], ['Owner team review', 4]])
        assert.deepEqual(names((await call(restarted, users.member, 'GET', '/api/report-views')).payload), ['Member layout', 'Owner team review'])
      } finally {
        await restarted.$disconnect()
      }
    })

    await t.test('a workspace administrator may delete a team view; the owner deletes a private one', async () => {
      const removed = await call(prisma, users.admin, 'DELETE', viewPath(created.teamA))
      assert.deepEqual([removed.status, removed.payload.deleted], [200, true])
      assert.equal((await call(prisma, users.owner, 'GET', viewPath(created.teamA))).status, 404)
      assert.equal((await call(prisma, users.owner, 'DELETE', viewPath(created.privateA))).status, 200)
      assert.deepEqual(names((await call(prisma, users.owner, 'GET', '/api/report-views')).payload), [])
      assert.deepEqual(names((await call(prisma, users.ownerB, 'GET', '/api/report-views')).payload), ['Tenant B private review', 'Tenant B team review'])
    })

    await t.test('every change is audited in the workspace it happened in', async () => {
      const rows = await prisma.auditLog.findMany({ where: { entityType: 'SavedReportView' }, orderBy: { createdAt: 'asc' } })
      const ofTenant = (tenantId) => rows.filter((row) => row.tenantId === tenantId)
      const actionsA = new Set(ofTenant(tenantA).map((row) => row.action))
      for (const action of ['report_view_created', 'report_view_updated', 'report_view_shared', 'report_view_unshared', 'report_view_cloned', 'report_view_deleted']) assert.ok(actionsA.has(action), action)
      assert.deepEqual(ofTenant(tenantB).map((row) => [row.action, row.actorId]), [['report_view_created', users.ownerB.id], ['report_view_created', users.ownerB.id]])
      const teamA = ofTenant(tenantA).filter((row) => row.entityId === created.teamA.viewId)
      const last = teamA.at(-1)
      assert.deepEqual([last.action, last.actorId, last.source, last.module, last.metadata.ownerId], ['report_view_deleted', users.admin.id, 'report_views', 'reports', users.owner.id])
      // Refused and conflicting requests leave no audit row.
      assert.equal(teamA.filter((row) => row.action === 'report_view_updated').length, 3)
    })
  } finally {
    await prisma.$disconnect()
  }
})
