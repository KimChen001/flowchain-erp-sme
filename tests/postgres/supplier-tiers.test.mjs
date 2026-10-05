import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// Supplier tiers and business owners (docs/supplier-tiers-design.md, T1): a
// person with master_data.supplier.manage sets the tier with a reason, every
// change is an audit row, the list tabs filter and count in the database, and
// the owner is an active user of the same workspace.
const tenant = 'tenant-supplier-tiers'
const otherTenant = 'tenant-supplier-tiers-other'

async function request(port, method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = text
        try { payload = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: res.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

test('supplier tiers and owners are set with a reason, audited, filtered and counted', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previousTenant = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    // Legacy roles; the first request backfills each into its default role.
    const people = { manager: 'manager', buyer: 'buyer', finance: 'finance-specialist', viewer: 'viewer' }
    await prisma.tenant.createMany({ data: [{ id: tenant, name: 'Tiers workspace', currency: 'USD' }, { id: otherTenant, name: 'Other workspace', currency: 'USD' }] })
    for (const [key, role] of Object.entries(people)) {
      await prisma.user.create({ data: { id: `${tenant}-${key}`, tenantId: tenant, email: `${key}-tiers@example.com`, name: `Tiers ${key}`, role } })
    }
    await prisma.user.create({ data: { id: `${tenant}-left`, tenantId: tenant, email: 'left-tiers@example.com', name: 'Tiers left', role: 'buyer', status: 'disabled' } })
    await prisma.user.create({ data: { id: `${otherTenant}-buyer`, tenantId: otherTenant, email: 'buyer-other@example.com', name: 'Other buyer', role: 'buyer' } })
    for (const [id, name] of [['SUP-T1', 'Alpha Components'], ['SUP-T2', 'Beta Packaging'], ['SUP-T3', 'Gamma Freight']]) {
      await prisma.supplier.create({ data: { id, tenantId: tenant, code: id, name, metadata: { defaultCurrency: 'USD', version: 1 } } })
    }
    await prisma.supplier.create({ data: { id: 'SUP-OTHER', tenantId: otherTenant, code: 'SUP-OTHER', name: 'Other Supplier', metadata: { defaultCurrency: 'USD', version: 1 } } })
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenant
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const signIn = async (key) => {
      const login = await request(port, 'POST', '/api/auth/login', { body: { email: `${key}-tiers@example.com`, name: `Tiers ${key}`, company: 'Tiers workspace' } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      const headers = { Authorization: `Bearer ${login.payload.token}` }
      return (method, path, body) => request(port, method, path, { headers, body })
    }
    const asManager = await signIn('manager')
    const tierOf = (path, body) => asManager('PATCH', path, body)

    // Set, with the reason and the version; the supplier version moves on.
    const set = await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: 1, reason: 'Only source of the flow controller', expectedVersion: 1 })
    assert.equal(set.status, 200, JSON.stringify(set.payload))
    assert.deepEqual([set.payload.supplier.tier, set.payload.supplier.tierReason, set.payload.supplier.tierSetBy?.name, set.payload.supplier.version], [1, 'Only source of the flow controller', 'Tiers manager', 2])
    assert.ok(set.payload.supplier.tierSetAt)

    // Guards: a stale version, a tier outside 1-3, a short reason, no change.
    assert.deepEqual(await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: 2, reason: 'Stale screen', expectedVersion: 1 }).then((r) => [r.status, r.payload.code]), [409, 'VERSION_CONFLICT'])
    assert.deepEqual(await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: 4, reason: 'No such tier', expectedVersion: 2 }).then((r) => [r.status, r.payload.details.map((d) => d.field)]), [422, ['tier']])
    assert.deepEqual(await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: 2, reason: 'ok', expectedVersion: 2 }).then((r) => [r.status, r.payload.details.map((d) => d.field)]), [422, ['reason']])
    assert.deepEqual(await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: 1, reason: 'Same again', expectedVersion: 2 }).then((r) => [r.status, r.payload.code]), [422, 'TIER_UNCHANGED'])

    // Clearing needs a reason too; the cleared supplier keeps no reason.
    const cleared = await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: null, reason: 'Second source approved', expectedVersion: 2 })
    assert.deepEqual([cleared.status, cleared.payload.supplier.tier, cleared.payload.supplier.tierReason, cleared.payload.supplier.version], [200, null, null, 3])
    const accepted = await tierOf('/api/master-data/suppliers/SUP-T1/tier', { tier: 1, reason: 'Second source withdrawn', acceptedSuggestion: true, expectedVersion: 3 })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.payload))

    // Every change is an audit row, and the detail shows them newest first.
    const rows = await prisma.auditLog.findMany({ where: { tenantId: tenant, entityId: 'SUP-T1', action: 'tier_change' }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(rows.map((row) => [row.metadata.fromTier, row.metadata.toTier, row.metadata.acceptedSuggestion, row.actorId]), [[null, 1, false, `${tenant}-manager`], [1, null, false, `${tenant}-manager`], [null, 1, true, `${tenant}-manager`]])
    const detail = await asManager('GET', '/api/master-data/suppliers/SUP-T1')
    assert.deepEqual(detail.payload.supplier.tierHistory.map((row) => [row.kind, row.fromTier, row.toTier, row.reason, row.by?.name]), [
      ['tier', null, 1, 'Second source withdrawn', 'Tiers manager'],
      ['tier', 1, null, 'Second source approved', 'Tiers manager'],
      ['tier', null, 1, 'Only source of the flow controller', 'Tiers manager'],
    ])

    // Owners: active users of this workspace only, picked without user administration.
    const owners = await asManager('GET', '/api/master-data/supplier-owners')
    assert.equal(owners.status, 200)
    assert.deepEqual(owners.payload.owners.map((row) => row.name), ['Tiers buyer', 'Tiers finance', 'Tiers manager', 'Tiers viewer'])
    const ownerOf = (body) => asManager('PATCH', '/api/master-data/suppliers/SUP-T1/owner', body)
    const owned = await ownerOf({ businessOwnerId: `${tenant}-buyer`, expectedVersion: 4 })
    assert.deepEqual([owned.status, owned.payload.supplier.businessOwner?.name, owned.payload.supplier.version], [200, 'Tiers buyer', 5])
    assert.deepEqual(await ownerOf({ businessOwnerId: `${tenant}-left`, expectedVersion: 5 }).then((r) => [r.status, r.payload.details?.[0]?.field]), [422, 'businessOwnerId'])
    assert.deepEqual(await ownerOf({ businessOwnerId: `${otherTenant}-buyer`, expectedVersion: 5 }).then((r) => [r.status, r.payload.details?.[0]?.field]), [422, 'businessOwnerId'])
    assert.deepEqual(await ownerOf({ businessOwnerId: `${tenant}-buyer`, expectedVersion: 5 }).then((r) => [r.status, r.payload.code]), [422, 'OWNER_UNCHANGED'])
    const ownerRow = await prisma.auditLog.findFirst({ where: { tenantId: tenant, entityId: 'SUP-T1', action: 'owner_change' } })
    assert.deepEqual([ownerRow.metadata.fromOwnerId, ownerRow.metadata.toOwnerId], [null, `${tenant}-buyer`])
    assert.deepEqual((await asManager('GET', '/api/master-data/suppliers/SUP-T1')).payload.supplier.tierHistory[0], { kind: 'owner', at: ownerRow.createdAt.toISOString(), by: { id: `${tenant}-manager`, name: 'Tiers manager' }, fromOwner: null, toOwner: { id: `${tenant}-buyer`, name: 'Tiers buyer' } })

    // A profile save keeps the tier and the owner; an edit opened before the
    // tier change is refused instead of undoing it.
    assert.deepEqual(await asManager('PATCH', '/api/master-data/suppliers/SUP-T1', { supplierName: 'Old screen', expectedVersion: 2 }).then((r) => [r.status, r.payload.code]), [409, 'VERSION_CONFLICT'])
    const renamed = await asManager('PATCH', '/api/master-data/suppliers/SUP-T1', { supplierName: 'Alpha Components Ltd', expectedVersion: 5 })
    assert.deepEqual([renamed.status, renamed.payload.supplier.tier, renamed.payload.supplier.businessOwner?.name, renamed.payload.supplier.version], [200, 1, 'Tiers buyer', 6])

    // Tabs: filtered and counted in the database, under the same search.
    assert.equal((await tierOf('/api/master-data/suppliers/SUP-T2/tier', { tier: 2, reason: 'Regular orders, other sources exist', expectedVersion: 1 })).status, 200)
    const ids = (response) => response.payload.suppliers.map((row) => row.id)
    const all = await asManager('GET', '/api/master-data/suppliers')
    assert.deepEqual(all.payload.counts, { all: 3, mine: 0, tier1: 1, tier2: 1, tier3: 0, untiered: 1 })
    assert.deepEqual(all.payload.suppliers.map((row) => [row.id, row.tier, row.businessOwner?.name || null]), [['SUP-T1', 1, 'Tiers buyer'], ['SUP-T2', 2, null], ['SUP-T3', null, null]])
    assert.deepEqual(ids(await asManager('GET', '/api/master-data/suppliers?tier=1')), ['SUP-T1'])
    assert.deepEqual(ids(await asManager('GET', '/api/master-data/suppliers?tier=none')), ['SUP-T3'])
    assert.deepEqual(ids(await asManager('GET', '/api/master-data/suppliers?owner=none')), ['SUP-T2', 'SUP-T3'])
    assert.deepEqual((await asManager('GET', '/api/master-data/suppliers?query=beta')).payload.counts, { all: 1, mine: 0, tier1: 0, tier2: 1, tier3: 0, untiered: 0 })
    const asBuyer = await signIn('buyer')
    const mine = await asBuyer('GET', '/api/master-data/suppliers?owner=me')
    assert.deepEqual([ids(mine), mine.payload.counts.mine], [['SUP-T1'], 1])

    // Who may change a tier: master_data.supplier.manage. Everyone may read it.
    const asFinance = await signIn('finance')
    const asViewer = await signIn('viewer')
    for (const [label, call] of [['finance', asFinance], ['viewer', asViewer]]) {
      const denied = await call('PATCH', '/api/master-data/suppliers/SUP-T3/tier', { tier: 3, reason: 'Not allowed', expectedVersion: 1 })
      assert.deepEqual([denied.status, denied.payload.code, denied.payload.permission], [403, 'PERMISSION_DENIED', 'master_data.supplier.manage'], label)
    }
    assert.equal((await asViewer('GET', '/api/master-data/supplier-owners')).status, 403)
    assert.deepEqual((await asViewer('GET', '/api/master-data/suppliers?tier=1')).payload.suppliers.map((row) => [row.id, row.tierReason, row.businessOwner?.name]), [['SUP-T1', 'Second source withdrawn', 'Tiers buyer']])

    // Another workspace's supplier is out of reach.
    assert.equal((await tierOf('/api/master-data/suppliers/SUP-OTHER/tier', { tier: 1, reason: 'Not ours', expectedVersion: 1 })).status, 404)
    assert.equal((await prisma.supplier.findUnique({ where: { id: 'SUP-OTHER' } })).tier, null)

    // The database refuses a tier outside 1-3 even without the command.
    await assert.rejects(prisma.supplier.update({ where: { id: 'SUP-T3' }, data: { tier: 7 } }))
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (previousTenant === undefined) delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    else process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenant
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
