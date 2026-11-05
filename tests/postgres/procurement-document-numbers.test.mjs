import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createReceivingDraftCommandService } from '../../server/domain/receiving-draft-command-service.mjs'
import { searchRuntimeBusinessContext } from '../../server/domain/runtime-business-search.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDbMasterDataRepository } from '../../server/repositories/db-master-data-repository.mjs'
import { createDbProcurementReadRepository, getDirectProcurementDocument, readProcurementDocumentNumbers } from '../../server/repositories/db-procurement-read-repository.mjs'
import { createDbProcurementRuntimeRepository } from '../../server/repositories/db-procurement-runtime-repository.mjs'
import { createProcurementRequestCommandService } from '../../server/services/procurement-request-command-service.mjs'

// Purchase requests, RFQs and purchase orders take the workspace's next
// PR-, RFQ- or PO-YYYYMM-NNNN when they are created (owner decisions
// 2026-11-04): in the workspace's month, one after another within it, never
// a number the client sends. Their id stays the internal id, and documents
// created before numbering keep the id they show as their number.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/procurement-document-numbers.test.mjs

const tenantId = 'tenant-procurement-numbers'
const otherTenantId = 'tenant-procurement-numbers-other'
const admin = { identity: { authenticated: true, tenantId, userId: 'pn-admin', role: 'admin', source: 'signed-session' } }
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database' }
const needBy = '2026-12-15'
const line = (overrides = {}) => ({
  lineId: `pn-line-${Math.random()}`, sourceType: 'catalog_item', lineBasis: 'quantity',
  itemId: 'PN-ITEM', sku: 'PN-SKU', itemNameSnapshot: 'Valve', unitSnapshot: 'EA',
  supplierId: 'PN-SUP', quantity: 10, estimatedUnitPrice: 12.5, estimatedAmount: 125,
  currency: 'USD', targetWarehouseId: 'PN-WH', needByDate: needBy, ...overrides,
})

let prisma
test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run through scripts/run-postgres-test-files.mjs against its disposable server.')
  prisma = await createPrismaClient(process.env)
  for (const id of [tenantId, otherTenantId]) await prisma.tenant.create({ data: { id, name: id, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
  await prisma.user.create({ data: { id: 'pn-admin', tenantId, email: 'pn-admin@procurement-numbers.invalid', name: 'Pat Admin', role: 'admin' } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: 'pn-admin' })
  await prisma.warehouse.create({ data: { id: 'PN-WH', tenantId, code: 'PN-WH', name: 'Main', status: 'active' } })
  await prisma.userWarehouseScope.create({ data: { id: 'pn-scope', tenantId, userId: 'pn-admin', warehouseId: 'PN-WH', accessLevel: 'operate' } })
  await prisma.supplier.create({ data: { id: 'PN-SUP', tenantId, code: 'PN-SUP', name: 'Harbor Supply', status: 'active' } })
  await prisma.item.create({ data: { id: 'PN-ITEM', tenantId, sku: 'PN-SKU', name: 'Valve', unit: 'EA', preferredSupplierId: 'PN-SUP', metadata: { defaultWarehouseId: 'PN-WH', purchasable: true } } })
})
test.after(async () => { await prisma?.$disconnect() })

// 03:30 UTC on 1 December 2026 is still 30 November in New York.
const commandsAt = (at) => createProcurementRequestCommandService({ prisma, masterData: createDbMasterDataRepository({ env, prisma }), env, now: () => new Date(at) })
const commands = commandsAt('2026-12-01T03:30:00Z')
const approved = async (service, id) => {
  await service.transitionPurchaseRequest(id, 'submit', { expectedVersion: 1 }, admin)
  return service.transitionPurchaseRequest(id, 'approve', { expectedVersion: 2 }, admin)
}

test('a new purchase request is numbered by the server in the workspace month, ignoring a sent number', async () => {
  const lines = [line({ lineId: 'pn-pr-1-line' })]
  const first = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-1', number: 'PR-TYPED-1', lines }, admin)
  const second = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-2', number: 'PR-TYPED-2', lines: [line()] }, admin)
  assert.deepEqual([first.number, second.number], ['PR-202611-0001', 'PR-202611-0002'])
  // The id stays the internal id, in its own format.
  assert.match(first.id, /^PR-[0-9A-F]{8}$/)
  assert.equal((await prisma.purchaseRequest.findUnique({ where: { id: first.id } })).number, 'PR-202611-0001')
  assert.equal(await prisma.purchaseRequest.count({ where: { number: { startsWith: 'PR-TYPED' } } }), 0)
  // A sent number is not part of the request: the same key with another
  // number is the same command, replayed, and takes no number.
  const replay = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-1', number: 'PR-TYPED-3', lines }, admin)
  assert.deepEqual([replay.idempotentReplay, replay.number], [true, 'PR-202611-0001'])
  // The audit names the request by its number.
  const audit = await prisma.auditLog.findFirst({ where: { tenantId, entityType: 'PurchaseRequest', entityId: first.id, action: 'purchase_request_created' } })
  assert.equal(audit.summary, 'Created purchase request PR-202611-0001.')
})

test('a number another request already shows, as its number or its id, is skipped', async () => {
  await prisma.purchaseRequest.create({ data: { id: 'PN-TYPED-BEFORE', number: 'PR-202611-0003', tenantId, status: 'draft', currency: 'USD' } })
  await prisma.purchaseRequest.create({ data: { id: 'PR-202611-0004', tenantId, status: 'draft', currency: 'USD' } })
  const next = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-5', lines: [line()] }, admin)
  assert.equal(next.number, 'PR-202611-0005')
})

test('requests saved at the same time all succeed with consecutive numbers', async () => {
  const together = await Promise.all([6, 7, 8].map((index) => commands.createPurchaseRequest({ idempotencyKey: `pn-pr-${index}`, lines: [line()] }, admin)))
  assert.deepEqual(together.map((row) => row.number).sort(), ['PR-202611-0006', 'PR-202611-0007', 'PR-202611-0008'])
})

test('an RFQ and purchase orders made from approved requests are numbered too', async () => {
  const forRfq = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-rfq', lines: [line()] }, admin)
  await approved(commands, forRfq.id)
  const { rfq, purchaseRequest } = await commands.createRfqFromPurchaseRequest(forRfq.id, { expectedVersion: 3 }, admin)
  assert.equal(rfq.number, 'RFQ-202611-0001')
  assert.match(rfq.id, /^RFQ-[0-9A-F]{8}$/)
  // An RFQ without a title is named after the request's number.
  assert.equal(rfq.title, `RFQ for ${forRfq.number}`)
  assert.equal(purchaseRequest.linkedRfq, rfq.id)

  const forOrders = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-po', lines: [line()] }, admin)
  await approved(commands, forOrders.id)
  const converted = await commands.createPurchaseOrdersFromPurchaseRequest(forOrders.id, { expectedVersion: 3, number: 'PO-TYPED' }, admin)
  const [order] = converted.createdPurchaseOrders
  assert.equal(order.number, 'PO-202611-0001')
  assert.equal(order.orderNumber, 'PO-202611-0001')
  assert.match(order.id, /^PO-[0-9A-F]{8}$/)
  const row = await prisma.purchaseOrder.findUnique({ where: { id: order.id } })
  // Older readers of metadata.orderNumber see the same number.
  assert.deepEqual([row.number, row.metadata.orderNumber], ['PO-202611-0001', 'PO-202611-0001'])
  const audit = await prisma.auditLog.findFirst({ where: { tenantId, entityType: 'PurchaseRequest', entityId: forOrders.id, action: 'purchase_request_converted_to_purchase_orders' } })
  assert.match(audit.summary, new RegExp(`from purchase request ${forOrders.number}: PO-202611-0001\\.$`))
  assert.deepEqual(audit.metadata.purchaseOrderNumbers, ['PO-202611-0001'])

  // The PO detail, its printable read, and receiving name the order by number.
  const detail = await createDbProcurementCommandService({ prisma, env }).readPurchaseOrder(order.id, admin)
  assert.deepEqual([detail.id, detail.number, detail.orderNumber], [order.id, 'PO-202611-0001', 'PO-202611-0001'])
  assert.equal((await createDbProcurementCommandService({ prisma, env }).readPurchaseOrder('PO-202611-0001', admin)).id, order.id)
  const receivable = await createReceivingDraftCommandService({ prisma }).listReceivablePurchaseOrders({ search: '202611-0001' }, admin)
  assert.deepEqual(receivable.items.map((item) => [item.id, item.number]), [[order.id, 'PO-202611-0001']])
})

test('the workspace month decides the sequence: in Shanghai the same moment is December', async () => {
  await prisma.tenant.update({ where: { id: tenantId }, data: { timezone: 'Asia/Shanghai' } })
  try {
    const december = await commands.createPurchaseRequest({ idempotencyKey: 'pn-pr-dec', lines: [line()] }, admin)
    assert.equal(december.number, 'PR-202612-0001')
  } finally {
    await prisma.tenant.update({ where: { id: tenantId }, data: { timezone: 'America/New_York' } })
  }
})

test('reads, the lookup and search find a document by its number, in its own workspace only', async () => {
  const order = await prisma.purchaseOrder.findFirst({ where: { tenantId, number: 'PO-202611-0001' } })
  const request = await prisma.purchaseRequest.findFirst({ where: { tenantId, number: 'PR-202611-0001' } })
  const rfq = await prisma.rfq.findFirst({ where: { tenantId, number: 'RFQ-202611-0001' } })
  // Another workspace has the same numbers: they are per workspace.
  await prisma.purchaseOrder.create({ data: { id: 'PN-OTHER-PO', number: 'PO-202611-0001', tenantId: otherTenantId, status: 'draft', currency: 'USD' } })

  const numbers = await readProcurementDocumentNumbers(prisma, { tenantId, ids: { purchase_order: [order.id, 'PN-OTHER-PO', 'PO-MISSING'], purchase_request: [request.id, 'PN-TYPED-BEFORE'], rfq: [rfq.id] } })
  assert.deepEqual(numbers, {
    purchase_order: { [order.id]: 'PO-202611-0001' },
    purchase_request: { [request.id]: 'PR-202611-0001', 'PN-TYPED-BEFORE': 'PR-202611-0003' },
    rfq: { [rfq.id]: 'RFQ-202611-0001' },
  })

  const byNumber = await getDirectProcurementDocument(prisma, 'po', 'po-202611-0001', tenantId)
  assert.deepEqual([byNumber.id, byNumber.number], [order.id, 'PO-202611-0001'])
  assert.equal((await getDirectProcurementDocument(prisma, 'pr', 'PR-202611-0001', tenantId)).id, request.id)
  assert.equal((await getDirectProcurementDocument(prisma, 'po', 'PO-202611-0001', otherTenantId)).id, 'PN-OTHER-PO')
  assert.equal((await commands.readPurchaseRequest('PR-202611-0001', admin)).id, request.id)

  const read = createDbProcurementReadRepository({ env, prisma })
  const snapshot = await read.snapshot({ tenantId })
  const listed = snapshot.purchaseOrders.find((row) => row.id === order.id)
  assert.deepEqual([listed.number, listed.orderNumber, listed.prNumber], ['PO-202611-0001', 'PO-202611-0001', (await prisma.purchaseRequest.findUnique({ where: { id: order.sourceRequestId } })).number])

  const business = await createDbProcurementRuntimeRepository({ prisma, env }).snapshot({ tenantId })
  const [found] = searchRuntimeBusinessContext(business, 'PO-202611-0001')
  assert.deepEqual([found.entityType, found.entityId, found.number], ['purchase_order', order.id, 'PO-202611-0001'])
  assert.equal(searchRuntimeBusinessContext(business, 'RFQ-202611-0001')[0].entityId, rfq.id)
  assert.equal(searchRuntimeBusinessContext(business, 'PR-202611-0001')[0].entityId, request.id)
})

test('the migration keeps the numbers documents showed before it, and runs twice safely', async () => {
  const sql = await readFile(new URL('../../prisma/migrations/20261104130000_procurement_document_numbers/migration.sql', import.meta.url), 'utf8')
  const statements = sql.split('\n').filter((row) => !row.trim().startsWith('--')).join('\n').split(';').map((row) => row.trim()).filter(Boolean)
  // Rows as they stood before the migration: no number.
  await prisma.purchaseRequest.create({ data: { id: 'LOCAL-DEMO-PR-OLD', tenantId, status: 'submitted', currency: 'USD' } })
  await prisma.rfq.create({ data: { id: 'RFQ-0A0A0A0A', tenantId, title: 'Old RFQ', status: 'open', currency: 'USD' } })
  await prisma.purchaseOrder.create({ data: { id: 'PO-0B0B0B0B', tenantId, status: 'issued', currency: 'USD', metadata: { orderNumber: 'PO-0B0B0B0B' } } })
  for (let run = 0; run < 2; run += 1) for (const statement of statements) await prisma.$executeRawUnsafe(statement)
  assert.equal((await prisma.purchaseRequest.findUnique({ where: { id: 'LOCAL-DEMO-PR-OLD' } })).number, 'LOCAL-DEMO-PR-OLD')
  assert.equal((await prisma.rfq.findUnique({ where: { id: 'RFQ-0A0A0A0A' } })).number, 'RFQ-0A0A0A0A')
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'PO-0B0B0B0B' } })).number, 'PO-0B0B0B0B')
  // Numbers assigned before are left as they are.
  assert.equal((await prisma.purchaseOrder.findFirst({ where: { tenantId, number: 'PO-202611-0001' } }))?.metadata.orderNumber, 'PO-202611-0001')
  // A number is unique in its workspace.
  await assert.rejects(prisma.purchaseRequest.create({ data: { id: 'PN-DUPLICATE', number: 'PR-202611-0001', tenantId, status: 'draft', currency: 'USD' } }), (error) => error.code === 'P2002')
})
