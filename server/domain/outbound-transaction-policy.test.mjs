import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSalesOrderReservationPlan,
  buildShipmentDraftPlan,
  buildShipmentPostingPlan,
  buildShipmentReversalPlan,
  outboundDecimalString,
  outboundDecimalUnits,
  outboundOrderStatuses,
  outboundReservationStatus,
} from './outbound-transaction-policy.mjs'

const order = () => ({
  id: 'so-1', tenantId: 'tenant-1', orderNumber: 'SO-1', workflowStatus: 'confirmed',
  reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', version: 0,
  lines: [{ id: 'sol-1', salesOrderId: 'so-1', itemId: 'item-1', sku: 'SKU-1', itemName: 'Item', orderedQuantity: '10.0000', reservedQuantity: '0.0000', fulfilledQuantity: '0.0000', unit: 'EA', version: 0 }],
})

const balance = (overrides = {}) => ({ id: 'bal-1', tenantId: 'tenant-1', itemId: 'item-1', sku: 'SKU-1', warehouseId: 'wh-1', warehouseKey: 'wh-1', location: 'A-01', locationKey: 'a-01', onHandQuantity: '10.0000', reservedQuantity: '0.0000', availableQuantity: '10.0000', version: 0, ...overrides })
const itemApi = { findMany: async () => [{ id: 'item-1', tenantId: 'tenant-1', sku: 'SKU-1', name: 'Item', status: 'active' }] }

test('outbound decimal arithmetic is fixed four-place BigInt arithmetic', () => {
  assert.equal(outboundDecimalUnits('123456789012.3456'), 1234567890123456n)
  assert.equal(outboundDecimalString(-12500n), '-1.2500')
  assert.throws(() => outboundDecimalUnits('0.00001'), /four decimal places/)
})

test('reservation and order statuses keep workflow dimensions separate', () => {
  assert.equal(outboundReservationStatus({ reservedQuantity: '4', allocatedQuantity: '2', consumedQuantity: '0', releasedQuantity: '0' }), 'partially_allocated')
  assert.deepEqual(outboundOrderStatuses([{ orderedQuantity: '4', reservedQuantity: '1', fulfilledQuantity: '3' }]), { reservationStatus: 'fully_reserved', fulfillmentStatus: 'partially_fulfilled' })
})

test('reserve plan cumulatively checks one balance key and preserves on-hand identity', async () => {
  const prisma = {
    salesOrder: { findFirst: async () => order() },
    item: itemApi,
    warehouse: { findMany: async () => [{ id: 'wh-1' }] },
    inventoryBalance: { findUnique: async () => balance() },
  }
  const plan = await buildSalesOrderReservationPlan({ prisma, tenantId: 'tenant-1', salesOrderId: 'so-1', allocations: [
    { salesOrderLineId: 'sol-1', warehouseId: 'wh-1', location: 'A-01', quantity: '2.0000' },
    { salesOrderLineId: 'sol-1', warehouseId: 'wh-1', location: 'A-01', quantity: '3.0000' },
  ] })
  assert.equal(plan.allowed, true)
  assert.equal(plan.balanceImpacts.length, 1)
  assert.equal(plan.balanceImpacts[0].onHandBefore, '10.0000')
  assert.equal(plan.balanceImpacts[0].onHandAfter, '10.0000')
  assert.equal(plan.balanceImpacts[0].reservedAfter, '5.0000')
  assert.equal(plan.balanceImpacts[0].availableAfter, '5.0000')
  assert.equal(plan.salesOrderLineImpacts[0].reservedAfter, '5.0000')
})

test('reserve plan rejects cumulative over-allocation without floating point', async () => {
  const prisma = {
    salesOrder: { findFirst: async () => order() },
    item: itemApi,
    warehouse: { findMany: async () => [{ id: 'wh-1' }] },
    inventoryBalance: { findUnique: async () => balance({ availableQuantity: '4.0000', onHandQuantity: '4.0000' }) },
  }
  const plan = await buildSalesOrderReservationPlan({ prisma, tenantId: 'tenant-1', salesOrderId: 'so-1', allocations: [
    { salesOrderLineId: 'sol-1', warehouseId: 'wh-1', location: 'A-01', quantity: '2.5000' },
    { salesOrderLineId: 'sol-1', warehouseId: 'wh-1', location: 'A-01', quantity: '2.5000' },
  ] })
  assert.equal(plan.allowed, false)
  assert.ok(plan.blockingIssues.some((issue) => issue.code === 'RESERVATION_INSUFFICIENT_AVAILABLE'))
})

const reserved = () => ({ id: 'res-1', tenantId: 'tenant-1', salesOrderId: 'so-1', salesOrderLineId: 'sol-1', itemId: 'item-1', sku: 'SKU-1', warehouseId: 'wh-1', location: 'A-01', locationKey: 'a-01', reservedQuantity: '4.0000', allocatedQuantity: '0.0000', consumedQuantity: '0.0000', releasedQuantity: '0.0000', status: 'active', version: 0 })

test('shipment draft allocates reservation but has no balance or movement impact', async () => {
  const prisma = { salesOrder: { findFirst: async () => order() }, item: itemApi, shipmentDocument: { findFirst: async () => null }, inventoryReservation: { findMany: async () => [reserved()] } }
  const plan = await buildShipmentDraftPlan({ prisma, tenantId: 'tenant-1', salesOrderId: 'so-1', shipmentNumber: 'SHIP-1', lines: [{ salesOrderLineId: 'sol-1', allocations: [{ reservationId: 'res-1', quantity: '4.0000' }] }] })
  assert.equal(plan.allowed, true)
  assert.equal(plan.balanceImpacts.length, 0)
  assert.equal(plan.factsToCreate.inventoryMovements.length, 0)
  assert.equal(plan.reservationImpacts[0].allocatedAfter, '4.0000')
})

const shipment = (postingStatus = 'unposted', allocationStatus = 'allocated') => {
  const so = order(); so.lines[0].reservedQuantity = '4.0000'; so.reservationStatus = 'fully_reserved'
  const reservation = reserved(); reservation.allocatedQuantity = allocationStatus === 'allocated' ? '4.0000' : '0.0000'; reservation.consumedQuantity = allocationStatus === 'consumed' ? '4.0000' : '0.0000'
  return { id: 'ship-1', tenantId: 'tenant-1', shipmentNumber: 'SHIP-1', salesOrderId: 'so-1', workflowStatus: 'ready', postingStatus, version: 0, salesOrder: so, lines: [{ id: 'sl-1', salesOrderLineId: 'sol-1', requestedQuantity: '4.0000', postedQuantity: postingStatus === 'posted' ? '4.0000' : '0.0000', unit: 'EA', version: 0, allocations: [{ id: 'alloc-1', reservationId: 'res-1', warehouseId: 'wh-1', location: 'A-01', locationKey: 'a-01', quantity: '4.0000', status: allocationStatus, reservation }] }] }
}

test('posting decreases on-hand and reserved together so available is unchanged', async () => {
  const prisma = { shipmentDocument: { findFirst: async () => shipment() }, item: itemApi, inventoryBalance: { findUnique: async () => balance({ itemId: 'item-1', reservedQuantity: '4.0000', availableQuantity: '6.0000' }) } }
  const plan = await buildShipmentPostingPlan({ prisma, tenantId: 'tenant-1', shipmentId: 'ship-1' })
  assert.equal(plan.allowed, true)
  assert.deepEqual([plan.balanceImpacts[0].onHandBefore, plan.balanceImpacts[0].onHandAfter, plan.balanceImpacts[0].reservedBefore, plan.balanceImpacts[0].reservedAfter, plan.balanceImpacts[0].availableBefore, plan.balanceImpacts[0].availableAfter], ['10.0000', '6.0000', '4.0000', '0.0000', '6.0000', '6.0000'])
  assert.deepEqual([plan.reservationImpacts[0].allocatedAfter, plan.reservationImpacts[0].consumedAfter], ['0.0000', '4.0000'])
})

// A posted shipment ready to reverse, plus the customer invoices that bill it.
// The invoice lookup honours the tenant, shipment and status filter, so a test
// fails if the guard stops filtering on status.
const reversalPrisma = (invoices = []) => {
  const posted = shipment('posted', 'consumed'); posted.salesOrder.lines[0].reservedQuantity = '0.0000'; posted.salesOrder.lines[0].fulfilledQuantity = '4.0000'
  return {
    shipmentDocument: { findFirst: async () => posted },
    item: itemApi,
    inventoryMovement: { findMany: async () => [{ id: 'mov-1', tenantId: 'tenant-1', movementType: 'shipment_posting', sourceDocumentType: 'ShipmentDocument', sourceDocumentId: 'ship-1', sourceDocumentLineId: 'alloc-1', relatedSalesOrderId: 'so-1', quantityIn: '0', quantityOut: '4.0000', sku: 'SKU-1', itemId: 'item-1', warehouseId: 'wh-1', locationKey: 'a-01', unit: 'EA', reversedByMovementId: null }] },
    inventoryBalance: { findUnique: async () => balance({ itemId: 'item-1', onHandQuantity: '6.0000', reservedQuantity: '0.0000', availableQuantity: '6.0000' }) },
    customerInvoice: { findFirst: async ({ where }) => invoices.find((row) => row.tenantId === where.tenantId && row.shipmentId === where.shipmentId && where.status.in.includes(row.status)) || null },
  }
}
const invoice = (status, overrides = {}) => ({ id: `inv-${status}`, tenantId: 'tenant-1', shipmentId: 'ship-1', invoiceNumber: `INV-${status}`, status, ...overrides })

test('reversal restores reserved inventory without reallocation or changing available', async () => {
  const plan = await buildShipmentReversalPlan({ prisma: reversalPrisma(), tenantId: 'tenant-1', shipmentId: 'ship-1', reason: 'Customer correction' })
  assert.equal(plan.allowed, true)
  assert.deepEqual([plan.balanceImpacts[0].onHandAfter, plan.balanceImpacts[0].reservedAfter, plan.balanceImpacts[0].availableAfter], ['10.0000', '4.0000', '6.0000'])
  assert.deepEqual([plan.reservationImpacts[0].consumedAfter, plan.reservationImpacts[0].allocatedAfter, plan.reservationImpacts[0].statusAfter], ['0.0000', '0.0000', 'active'])
})

test('reversal is refused while a submitted, approved, issued or disputed customer invoice bills the shipment', async () => {
  for (const status of ['submitted', 'approved', 'issued', 'disputed']) {
    const plan = await buildShipmentReversalPlan({ prisma: reversalPrisma([invoice(status)]), tenantId: 'tenant-1', shipmentId: 'ship-1', reason: 'Customer correction' })
    assert.equal(plan.allowed, false, status)
    const blocked = plan.blockingIssues.find((issue) => issue.code === 'SHIPMENT_REVERSAL_BLOCKED_BY_INVOICE')
    assert.ok(blocked, status)
    assert.equal(blocked.status, 409)
    assert.deepEqual(blocked.details, { customerInvoiceId: `inv-${status}`, invoiceNumber: `INV-${status}`, invoiceStatus: status })
  }
})

test('a draft or cancelled invoice, or an invoice for another shipment or tenant, does not block reversal', async () => {
  const invoices = [invoice('draft'), invoice('cancelled'), invoice('issued', { id: 'inv-other', shipmentId: 'ship-2' }), invoice('issued', { id: 'inv-tenant', tenantId: 'tenant-2' })]
  const plan = await buildShipmentReversalPlan({ prisma: reversalPrisma(invoices), tenantId: 'tenant-1', shipmentId: 'ship-1', reason: 'Customer correction' })
  assert.equal(plan.allowed, true)
})
