import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import pg from 'pg'
import { createAuthorizationAdminService } from '../../server/auth/authorization-admin-service.mjs'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { resolveAuthorizationContext } from '../../server/auth/authorization-service.mjs'
import { defaultRoleTemplates } from '../../server/auth/permission-catalog.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { CUSTOMER_NAMESPACE } from '../../server/domain/master-data-commands.mjs'
import { resolveProvisionedActor } from '../../server/domain/pilot-identity.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// A fresh workspace can build its own master data: items, customers and the
// suppliers each item is bought from, with versions, validation, unique
// codes, audit rows and no reach into another workspace.
const tenantA = 'tenant-master-writes-a'
const tenantB = 'tenant-master-writes-b'
// Who may write is decided by Roles & permissions.
const tenantRoles = 'tenant-master-writes-roles'
// A workspace whose default roles predate the master data codes.
const tenantExisting = 'tenant-master-writes-existing'
const tenantCustomOnly = 'tenant-master-writes-custom-only'
const permissionsMigration = '20261002030000_master_data_permissions'
const hasChinese = (value) => /[㐀-鿿]/.test(String(value))

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}`, currency: 'USD' } })
  await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: `writer-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' } })
  await prisma.user.create({ data: { id: `${tenantId}-specialist`, tenantId, email: `specialist-${tag.toLowerCase()}@example.com`, name: `Specialist ${tag}`, role: 'business-specialist' } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Supplier ${tag}`, metadata: { defaultCurrency: 'USD', version: 1 } } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}2`, tenantId, code: `SUP-${tag}2`, name: `Second Supplier ${tag}`, metadata: { defaultCurrency: 'EUR', version: 1 } } })
  await prisma.warehouse.create({ data: { id: `WH-${tag}`, tenantId, code: `WH-${tag}`, name: `Warehouse ${tag}` } })
  await prisma.item.create({ data: { id: `ITEM-${tag}`, tenantId, sku: `SKU-${tag}`, name: `Item ${tag}`, unit: 'EA' } })
}

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

test('items, customers and item suppliers can be created and edited in PostgreSQL', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previousTenant = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')
    // Sign-in resolves the configured workspace; the session keeps it.
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantA
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const login = await request(port, 'POST', '/api/auth/login', { body: { email: 'writer-a@example.com', name: 'Manager A', company: 'Workspace A' } })
    assert.equal(login.status, 200)
    assert.equal(login.payload.user.tenantId, tenantA)
    const headers = { Authorization: `Bearer ${login.payload.token}` }
    const call = (method, path, body) => request(port, method, path, { headers, body })

    // Items: create, read back, edit with the version, and the guards.
    const created = await call('POST', '/api/master-data/items', { sku: 'NEW-100', itemName: 'Flow Valve', baseUnit: 'EA', category: 'Valves', safetyStock: 5, reorderPoint: 8, minimumOrderQuantity: 10, purchaseLeadTimeDays: 7, defaultSupplierId: 'SUP-A', defaultWarehouseId: 'WH-A', status: 'active' })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    const item = created.payload.item
    assert.deepEqual([item.sku, item.itemName, item.baseUnit, item.safetyStock, item.reorderPoint, item.minimumOrderQuantity, item.purchaseLeadTimeDays, item.preferredSupplierId, item.version], ['NEW-100', 'Flow Valve', 'EA', 5, 8, 10, 7, 'SUP-A', 1])
    const stored = await prisma.item.findFirst({ where: { tenantId: tenantA, sku: 'NEW-100' } })
    assert.equal(stored.tenantId, tenantA)
    const listed = await call('GET', '/api/master-data/items')
    assert.ok(listed.payload.items.some((row) => row.sku === 'NEW-100'))
    const edited = await call('PATCH', `/api/master-data/items/${item.itemId}`, { itemName: 'Flow Valve 2in', expectedVersion: 1 })
    assert.equal(edited.status, 200, JSON.stringify(edited.payload))
    assert.deepEqual([edited.payload.item.itemName, edited.payload.item.version, edited.payload.item.sku], ['Flow Valve 2in', 2, 'NEW-100'])
    const stale = await call('PATCH', `/api/master-data/items/${item.itemId}`, { itemName: 'Lost update', expectedVersion: 1 })
    assert.deepEqual([stale.status, stale.payload.code], [409, 'VERSION_CONFLICT'])
    const duplicate = await call('POST', '/api/master-data/items', { sku: 'NEW-100', itemName: 'Twin', baseUnit: 'EA' })
    assert.deepEqual([duplicate.status, duplicate.payload.code], [409, 'DUPLICATE_SKU'])
    const renamedSku = await call('PATCH', `/api/master-data/items/${item.itemId}`, { sku: 'OTHER-1', expectedVersion: 2 })
    assert.deepEqual([renamedSku.status, renamedSku.payload.details.map((row) => row.field)], [422, ['sku']])
    const invalid = await call('POST', '/api/master-data/items', { sku: 'BAD 1', itemName: '', baseUnit: 'EA', safetyStock: -1, defaultSupplierId: 'SUP-B' })
    assert.equal(invalid.status, 422)
    assert.deepEqual(invalid.payload.details.map((row) => row.field).sort(), ['defaultSupplierId', 'itemName', 'safetyStock', 'sku'])
    // Another workspace's item and supplier are out of reach.
    const foreign = await call('PATCH', '/api/master-data/items/ITEM-B', { itemName: 'Taken over', expectedVersion: 1 })
    assert.equal(foreign.status, 404)
    assert.equal((await prisma.item.findFirst({ where: { id: 'ITEM-B' } })).name, 'Item B')

    // Customers: create, edit, deactivate, duplicates and validation.
    const customer = await call('POST', '/api/master-data/customers', { code: 'CUST-RED', name: 'Redwood Retail', currency: 'usd', email: 'buyer@redwood.example', paymentTerms: 'NET30' })
    assert.equal(customer.status, 201, JSON.stringify(customer.payload))
    assert.deepEqual([customer.payload.customer.code, customer.payload.customer.currency, customer.payload.customer.version, customer.payload.customer.status], ['CUST-RED', 'USD', 1, 'active'])
    const customerId = customer.payload.customer.id
    const renamed = await call('PATCH', `/api/master-data/customers/${customerId}`, { name: 'Redwood Retail Co.', expectedVersion: 1 })
    assert.deepEqual([renamed.status, renamed.payload.customer.name, renamed.payload.customer.version], [200, 'Redwood Retail Co.', 2])
    const deactivated = await call('POST', `/api/master-data/customers/${customerId}/deactivate`, { expectedVersion: 2 })
    assert.deepEqual([deactivated.status, deactivated.payload.customer.status], [200, 'inactive'])
    const twin = await call('POST', '/api/master-data/customers', { code: 'CUST-RED', name: 'Twin' })
    assert.deepEqual([twin.status, twin.payload.code], [409, 'DUPLICATE_CODE'])
    const badEmail = await call('POST', '/api/master-data/customers', { code: 'CUST-X', name: 'X', email: 'not-an-email', currency: 'ZZZ' })
    assert.deepEqual(badEmail.payload.details.map((row) => row.field).sort(), ['currency', 'email'])
    const customers = await call('GET', '/api/master-data/customers')
    assert.deepEqual(customers.payload.customers.map((row) => row.code), ['CUST-RED'])

    // Item suppliers: link two suppliers, move the preferred one, and the
    // item and its approved sources follow.
    const first = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-A', preferred: true, leadTimeDays: 5, minimumOrderQuantity: 20, referencePrice: 12.5 })
    assert.equal(first.status, 201, JSON.stringify(first.payload))
    assert.deepEqual([first.payload.relationship.preferred, first.payload.relationship.currency, first.payload.relationship.referencePrice], [true, 'USD', 12.5])
    const second = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-A2', leadTimeDays: 9, minimumOrderQuantity: 1, referencePrice: 0 })
    assert.equal(second.status, 201)
    assert.deepEqual([second.payload.relationship.currency, second.payload.relationship.referencePrice], ['EUR', null])
    const again = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-A' })
    assert.deepEqual([again.status, again.payload.code], [409, 'RELATIONSHIP_EXISTS'])
    const foreignSupplier = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-B' })
    assert.equal(foreignSupplier.status, 422)
    const moved = await call('PATCH', `/api/master-data/items/${item.itemId}/suppliers/${second.payload.relationship.relationshipId}`, { preferred: true, expectedVersion: 1 })
    assert.deepEqual([moved.status, moved.payload.relationship.preferred], [200, true])
    assert.equal((await prisma.item.findFirst({ where: { id: item.itemId } })).preferredSupplierId, 'SUP-A2')
    const sources = await call('GET', `/api/master-data/items/${item.itemId}/suppliers`)
    assert.equal(sources.status, 200)
    assert.deepEqual(sources.payload.suppliers.map((row) => [row.id, row.preferred]), [['SUP-A2', true], ['SUP-A', false]])
    const deactivatedLink = await call('PATCH', `/api/master-data/items/${item.itemId}/suppliers/${second.payload.relationship.relationshipId}`, { active: false, expectedVersion: 2 })
    assert.deepEqual([deactivatedLink.payload.relationship.active, deactivatedLink.payload.relationship.preferred], [false, false])
    assert.equal((await prisma.item.findFirst({ where: { id: item.itemId } })).preferredSupplierId, null)
    const supplierItems = await call('GET', '/api/master-data/suppliers/SUP-A/items')
    assert.equal(supplierItems.status, 200)
    assert.deepEqual(supplierItems.payload.relationships.map((row) => [row.itemId, row.item?.sku]), [[item.itemId, 'NEW-100']])

    // Registration, tax and bank details need finance.partner_snapshot.read and
    // reference prices need procurement.prices.read. The operations specialist
    // has neither: it sees "****" plus the last four characters, and saving the
    // supplier with those masked values keeps what is stored.
    await prisma.supplier.update({ where: { id: 'SUP-A' }, data: { metadata: { defaultCurrency: 'USD', version: 1, creditCode: '91310000MA1K', taxIdentificationNumber: '12-3456789', bankName: 'First Bank', bankAccountName: 'Supplier A LLC', bankAccountNumber: '000123456789' } } })
    const managerView = await call('GET', '/api/master-data/suppliers/SUP-A')
    assert.equal(managerView.payload.supplier.bankAccountNumber, '000123456789')
    const specialistLogin = await request(port, 'POST', '/api/auth/login', { body: { email: 'specialist-a@example.com', name: 'Specialist A', company: 'Workspace A' } })
    assert.equal(specialistLogin.status, 200)
    const asSpecialist = (method, path, body) => request(port, method, path, { headers: { Authorization: `Bearer ${specialistLogin.payload.token}` }, body })
    for (const path of ['/api/master-data/suppliers', '/api/master-data/suppliers/SUP-A', '/api/master-data/suppliers/select', '/api/master-data']) {
      const seen = await asSpecialist('GET', path)
      assert.equal(seen.status, 200, path)
      const row = seen.payload.supplier || seen.payload.suppliers.find((entry) => entry.id === 'SUP-A')
      assert.deepEqual([row.creditCode, row.taxIdentificationNumber, row.bankAccountName, row.bankAccountNumber], ['****MA1K', '****6789', '**** LLC', '****6789'], path)
      assert.equal(JSON.stringify(seen.payload).includes('000123456789'), false, path)
    }
    const masked = (await asSpecialist('GET', '/api/master-data/suppliers/SUP-A')).payload.supplier
    const resaved = await asSpecialist('PATCH', '/api/master-data/suppliers/SUP-A', { ...masked, contactName: 'Dana Lee', expectedVersion: masked.version })
    assert.equal(resaved.status, 200, JSON.stringify(resaved.payload))
    const kept = (await prisma.supplier.findUnique({ where: { id: 'SUP-A' } })).metadata
    assert.deepEqual([kept.creditCode, kept.taxIdentificationNumber, kept.bankAccountName, kept.bankAccountNumber, kept.contactName], ['91310000MA1K', '12-3456789', 'Supplier A LLC', '000123456789', 'Dana Lee'])
    const hiddenPrices = await asSpecialist('GET', `/api/master-data/items/${item.itemId}/suppliers`)
    assert.ok(hiddenPrices.payload.relationships.length > 0)
    assert.ok(hiddenPrices.payload.relationships.every((row) => row.referencePrice === null && row.restrictedFields.includes('referencePrice')))
    const managerPrices = await call('GET', `/api/master-data/items/${item.itemId}/suppliers`)
    assert.ok(managerPrices.payload.relationships.some((row) => row.referencePrice === 12.5))

    // Every write left an audit row in its own workspace.
    const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantA, source: 'master-data' } })
    assert.ok(audits.length >= 7, String(audits.length))
    assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantB, source: 'master-data' } }), 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (previousTenant === undefined) delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    else process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenant
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})

test('master data writes follow the roles in Roles & permissions, not the legacy role', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previousTenant = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    // Legacy roles; the first request backfills each into its default role.
    const people = { admin: 'admin', manager: 'manager', demoted: 'manager', emptied: 'manager', specialist: 'business-specialist', buyer: 'buyer', finance: 'finance-specialist', viewer: 'viewer' }
    await prisma.tenant.create({ data: { id: tenantRoles, name: 'Roles workspace', currency: 'USD' } })
    for (const [key, role] of Object.entries(people)) {
      await prisma.user.create({ data: { id: `${tenantRoles}-${key}`, tenantId: tenantRoles, email: `${key}-roles@example.com`, name: `Roles ${key}`, role } })
    }
    await prisma.supplier.create({ data: { id: 'SUP-ROLES', tenantId: tenantRoles, code: 'SUP-ROLES', name: 'Roles Supplier', metadata: { defaultCurrency: 'USD', version: 1 } } })
    await prisma.item.create({ data: { id: 'ITEM-ROLES', tenantId: tenantRoles, sku: 'SKU-ROLES', name: 'Roles Item', unit: 'EA' } })
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantRoles
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const signIn = async (key) => {
      const login = await request(port, 'POST', '/api/auth/login', { body: { email: `${key}-roles@example.com`, name: `Roles ${key}`, company: 'Roles workspace' } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      const headers = { Authorization: `Bearer ${login.payload.token}` }
      return (method, path, body) => request(port, method, path, { headers, body })
    }
    const supplier = (code) => ({ supplierCode: code, supplierName: `Supplier ${code}`, defaultCurrency: 'USD' })
    const item = (sku) => ({ sku, itemName: `Item ${sku}`, baseUnit: 'EA' })
    const customer = (code) => ({ code, name: `Customer ${code}` })
    const assertDenied = (response, permission, label) => {
      assert.equal(response.status, 403, `${label} ${JSON.stringify(response.payload)}`)
      assert.equal(response.payload.code, 'PERMISSION_DENIED', label)
      assert.equal(response.payload.permission, permission, label)
      assert.match(response.payload.message, /^Your roles do not allow changing /, label)
      assert.equal(hasChinese(response.payload.message), false, label)
    }

    // Operations Manager: items, suppliers and customers.
    const asManager = await signIn('manager')
    assert.equal((await asManager('POST', '/api/master-data/suppliers', supplier('SUP-MGR'))).status, 201)
    assert.equal((await asManager('POST', '/api/master-data/items', item('MGR-1'))).status, 201)
    assert.equal((await asManager('POST', '/api/master-data/customers', customer('CUST-MGR'))).status, 201)

    // Procurement Specialist (legacy buyer, which the old role list left out):
    // items, suppliers and the suppliers of an item, but not customers.
    const asBuyer = await signIn('buyer')
    const buyerSupplier = await asBuyer('POST', '/api/master-data/suppliers', supplier('SUP-BUY'))
    assert.equal(buyerSupplier.status, 201, JSON.stringify(buyerSupplier.payload))
    const { id: buyerSupplierId, version } = buyerSupplier.payload.supplier
    const renamed = await asBuyer('PATCH', `/api/master-data/suppliers/${buyerSupplierId}`, { supplierName: 'Buyer Supplier Ltd', expectedVersion: version })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.payload))
    const buyerItem = await asBuyer('POST', '/api/master-data/items', item('BUY-1'))
    assert.equal(buyerItem.status, 201, JSON.stringify(buyerItem.payload))
    const link = await asBuyer('POST', `/api/master-data/items/${buyerItem.payload.item.itemId}/suppliers`, { supplierId: buyerSupplierId, preferred: true })
    assert.equal(link.status, 201, JSON.stringify(link.payload))
    assertDenied(await asBuyer('POST', '/api/master-data/customers', customer('CUST-BUY')), 'master_data.customer.manage', 'buyer customer')

    // Finance Specialist: pays suppliers, so cannot change them.
    const asFinance = await signIn('finance')
    assertDenied(await asFinance('PATCH', '/api/master-data/suppliers/SUP-ROLES', { bankAccountNumber: '999900001111', expectedVersion: 1 }), 'master_data.supplier.manage', 'finance supplier')

    // Read-only Viewer: reads everything, changes nothing.
    const asViewer = await signIn('viewer')
    assert.equal((await asViewer('GET', '/api/master-data/suppliers')).status, 200)
    assertDenied(await asViewer('POST', '/api/master-data/suppliers', supplier('SUP-VIEW')), 'master_data.supplier.manage', 'viewer supplier')
    assertDenied(await asViewer('POST', '/api/master-data/items', item('VIEW-1')), 'master_data.item.manage', 'viewer item')
    assertDenied(await asViewer('PATCH', '/api/master-data/items/ITEM-ROLES', { itemName: 'Viewed', expectedVersion: 1 }), 'master_data.item.manage', 'viewer item edit')
    assertDenied(await asViewer('POST', '/api/master-data/items/ITEM-ROLES/suppliers', { supplierId: 'SUP-ROLES' }), 'master_data.item.manage', 'viewer item supplier')
    assertDenied(await asViewer('POST', '/api/master-data/customers', customer('CUST-VIEW')), 'master_data.customer.manage', 'viewer customer')

    // A manager an administrator narrowed to Read-only Viewer keeps the
    // legacy role but loses the writes.
    const demotedId = `${tenantRoles}-demoted`
    assert.equal((await (await signIn('demoted'))('POST', '/api/master-data/customers', customer('CUST-DEM'))).status, 201)
    const admin = await resolveProvisionedActor(prisma, { authenticated: true, tenantId: tenantRoles, userId: `${tenantRoles}-admin`, role: 'admin' })
    const viewerRole = await prisma.tenantRole.findFirst({ where: { tenantId: tenantRoles, roleKey: 'read-only-viewer', isDefaultTemplate: true } })
    await createAuthorizationAdminService({ prisma }).assignUserRoles(admin, demotedId, [viewerRole.id])
    assert.equal((await prisma.user.findUnique({ where: { id: demotedId } })).role, 'manager')
    // The role change ended the demoted manager's sessions; sign in again.
    const asDemoted = await signIn('demoted')
    assert.equal((await asDemoted('GET', '/api/master-data/items')).status, 200)
    assertDenied(await asDemoted('POST', '/api/master-data/suppliers', supplier('SUP-DEM')), 'master_data.supplier.manage', 'demoted supplier')
    assertDenied(await asDemoted('POST', '/api/master-data/items', item('DEM-1')), 'master_data.item.manage', 'demoted item')
    assertDenied(await asDemoted('PATCH', '/api/master-data/customers/CUST-DEM', { name: 'Renamed', expectedVersion: 1 }), 'master_data.customer.manage', 'demoted customer')

    // A code an administrator removes from a default role survives the legacy
    // backfill that runs again, for the whole workspace, when someone who
    // never had a role signs in, such as an invited colleague.
    const asAdmin = await signIn('admin')
    const opsRole = await prisma.tenantRole.findFirst({ where: { tenantId: tenantRoles, roleKey: 'operations-specialist', isDefaultTemplate: true }, include: { permissions: true } })
    const opsCodes = opsRole.permissions.map((grant) => grant.permissionCode).filter((code) => code !== 'master_data.supplier.manage')
    const narrowed = await asAdmin('PATCH', `/api/authorization/roles/${opsRole.id}`, { permissionCodes: opsCodes })
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.payload))
    const invitation = await asAdmin('POST', '/api/workspace/invitations', { email: 'newcomer-roles@example.com', role: 'business-specialist' })
    assert.equal(invitation.status, 201, JSON.stringify(invitation.payload))
    assert.equal((await request(port, 'POST', '/api/workspace/invitations/accept', { body: { token: invitation.payload.invitationToken, name: 'Roles newcomer' } })).status, 200)
    const asNewcomer = await signIn('newcomer')
    const newcomer = await asNewcomer('GET', '/api/authorization/context')
    assert.equal(newcomer.status, 200, JSON.stringify(newcomer.payload))
    // The newcomer gets the role as the administrator left it.
    assert.deepEqual(newcomer.payload.roles.map((role) => role.roleKey), ['operations-specialist'])
    assert.equal(newcomer.payload.effectivePermissions.includes('master_data.supplier.manage'), false)
    assertDenied(await asNewcomer('POST', '/api/master-data/suppliers', supplier('SUP-NEW')), 'master_data.supplier.manage', 'newcomer supplier')
    // The code stayed removed from the role.
    assert.equal(await prisma.tenantRolePermission.count({ where: { roleId: opsRole.id, permissionCode: 'master_data.supplier.manage' } }), 0)
    // The existing specialist still edits items but no longer suppliers.
    const asSpecialist = await signIn('specialist')
    assertDenied(await asSpecialist('POST', '/api/master-data/suppliers', supplier('SUP-OPS')), 'master_data.supplier.manage', 'specialist supplier')
    assert.equal((await asSpecialist('POST', '/api/master-data/items', item('OPS-1'))).status, 201)

    // Nothing refused was written.
    assert.deepEqual((await prisma.supplier.findMany({ where: { tenantId: tenantRoles }, orderBy: { code: 'asc' } })).map((row) => row.code), ['SUP-BUY', 'SUP-MGR', 'SUP-ROLES'])
    assert.deepEqual((await prisma.item.findMany({ where: { tenantId: tenantRoles }, orderBy: { sku: 'asc' } })).map((row) => row.sku), ['BUY-1', 'MGR-1', 'OPS-1', 'SKU-ROLES'])
    assert.deepEqual((await prisma.runtimeRecord.findMany({ where: { tenantId: tenantRoles, namespace: CUSTOMER_NAMESPACE }, orderBy: { recordKey: 'asc' } })).map((row) => [row.recordKey, row.payload.name]), [['CUST-DEM', 'Customer CUST-DEM'], ['CUST-MGR', 'Customer CUST-MGR']])
    assert.equal((await prisma.supplier.findUnique({ where: { id: 'SUP-ROLES' } })).metadata.bankAccountNumber, undefined)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (previousTenant === undefined) delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    else process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenant
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})

test('the master data permissions migration grants the new codes to existing default roles, once', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  const migration = readFileSync(new URL(`../../prisma/migrations/${permissionsMigration}/migration.sql`, import.meta.url), 'utf8')
  const managerId = `${tenantExisting}-manager`
  const grants = async () => (await prisma.tenantRolePermission.findMany({ where: { tenantId: { in: [tenantExisting, tenantCustomOnly] } }, include: { role: true }, orderBy: { id: 'asc' } }))
    .map(({ id, tenantId, roleId, permissionCode, role }) => ({ id, tenantId, roleId, permissionCode, roleKey: role.roleKey }))
  const masterDataGrants = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.roleKey))].sort().map((roleKey) => [roleKey, rows.filter((row) => row.roleKey === roleKey && row.permissionCode.startsWith('master_data.')).map((row) => row.permissionCode).sort()]))
  const catalogConstraint = async () => (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'TenantRolePermission_permissionCode_catalog_check'`)).rows[0].definition
  try {
    await client.connect()
    // The default roles of an existing workspace, as the backfill created them
    // before the master data codes existed.
    await prisma.tenant.create({ data: { id: tenantExisting, name: 'Existing workspace' } })
    await prisma.user.create({ data: { id: `${tenantExisting}-admin`, tenantId: tenantExisting, email: 'admin-existing@example.com', name: 'Existing Admin', role: 'admin' } })
    await prisma.user.create({ data: { id: managerId, tenantId: tenantExisting, email: 'manager-existing@example.com', name: 'Existing Manager', role: 'manager' } })
    await backfillTenantAuthorization(prisma, tenantExisting)
    await prisma.tenantRolePermission.deleteMany({ where: { tenantId: tenantExisting, permissionCode: { startsWith: 'master_data.' } } })
    // A workspace role an administrator made, with a template's key but not a
    // default template, gets nothing.
    await prisma.tenant.create({ data: { id: tenantCustomOnly, name: 'Custom roles workspace' } })
    await prisma.tenantRole.create({ data: { id: `${tenantCustomOnly}-buyers`, tenantId: tenantCustomOnly, roleKey: 'procurement-specialist', name: 'Our buyers', isDefaultTemplate: false } })
    const before = await grants()
    assert.equal(before.some((row) => row.permissionCode.startsWith('master_data.')), false)
    const manager = () => resolveAuthorizationContext({ authenticated: true, tenantId: tenantExisting, userId: managerId }, { prisma, performLegacyBackfill: false })
    assert.equal((await manager()).permissionCodes.has('master_data.supplier.manage'), false)

    await client.query(migration)

    const after = await grants()
    const expected = Object.fromEntries(defaultRoleTemplates.map((template) => [template.roleKey, template.permissions.filter((code) => code.startsWith('master_data.')).sort()]).sort(([a], [b]) => a.localeCompare(b)))
    assert.deepEqual(masterDataGrants(after.filter((row) => row.tenantId === tenantExisting)), expected)
    assert.deepEqual(masterDataGrants(after.filter((row) => row.tenantId === tenantCustomOnly)), {})
    // Every other grant is untouched, and the new ones have deterministic ids.
    assert.deepEqual(after.filter((row) => !row.permissionCode.startsWith('master_data.')), before)
    for (const row of after.filter((entry) => entry.permissionCode.startsWith('master_data.'))) {
      assert.equal(row.id, `AUTH-${createHash('md5').update(`${row.tenantId}:${row.roleId}:${row.permissionCode}`).digest('hex').slice(0, 28)}`)
    }
    assert.ok((await manager()).permissionCodes.has('master_data.supplier.manage'))

    // Running it again changes neither the grants nor the catalog constraint.
    const constraint = await catalogConstraint()
    assert.equal(constraint.split("'master_data.item.manage'").length - 1, 1)
    await client.query(migration)
    assert.deepEqual(await grants(), after)
    assert.equal(await catalogConstraint(), constraint)
    // The constraint still refuses codes outside the catalog.
    const role = await prisma.tenantRole.findFirst({ where: { tenantId: tenantExisting, roleKey: 'read-only-viewer' } })
    await assert.rejects(() => prisma.tenantRolePermission.create({ data: { id: `${tenantExisting}-unknown`, tenantId: tenantExisting, roleId: role.id, permissionCode: 'master_data.warehouse.manage' } }))
  } finally {
    await client.end().catch(() => {})
    await prisma.$disconnect()
  }
})
