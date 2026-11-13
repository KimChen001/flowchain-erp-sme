import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  customerMatches,
  invoicingProgressText,
  invoicingState,
  lineShortfall,
  paymentTermsLabel,
  plainQuantity,
  quantityWithUnit,
  smallerQuantity,
} from '../../src/modules/sales/salesOrderFacts.ts'
import { foldReservationAudits, timelineSummary } from '../../src/modules/sales/outboundTimeline.ts'
import { createOutboundWorkbenchReadService } from './outbound-workbench-read-service.mjs'
import { createSalesOrderReadService } from './sales-order-workbench-service.mjs'

// Round 8b, order to cash: what the walk on the UCI data found on the sales
// order, shipment and shipment risk pages (findings 1, 4, 12, 14–22, 27, 29,
// 30, 33).

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('#1 a timeline summary is read by its kind of record: an SKU of digits stays an SKU', () => {
  const lookup = {
    language: 'en-US',
    reservation: (id) => (id === 'R1' ? { place: 'Main warehouse / A-01', unit: 'pcs' } : undefined),
    warehouse: (id) => (id === 'WH-1' ? 'Main warehouse' : undefined),
    unitForSku: (sku) => (sku === '15036' ? 'pcs' : undefined),
  }
  // "Stock shipped out · 15,036 · Main warehouse · 30" was the bug.
  const movement = { eventType: 'shipment_posting', title: '发货出库流水已创建', summary: '15036 · WH-1 · 30.0000', entityType: 'InventoryMovement', entityId: 'M1', occurredAt: '' }
  assert.equal(timelineSummary(movement, lookup), '15036 · Main warehouse · 30 pcs')
  assert.equal(timelineSummary(movement, { ...lookup, language: 'zh-CN' }), '15036 · Main warehouse · 30 件')
  const reserved = { eventType: 'reservation_reserved', title: '库存预留已创建', summary: '44.0000 · R1', entityType: 'InventoryReservation', entityId: 'R1', occurredAt: '' }
  assert.equal(timelineSummary(reserved, lookup), '44 pcs · Main warehouse / A-01')
  // A reservation the reader cannot see is left out, never named by its id.
  assert.equal(timelineSummary({ ...reserved, summary: '44.0000 · R-HIDDEN' }, lookup), '44')
  // An audit summary (a document number and a reason) is shown as recorded, digits and all.
  const audit = { eventType: 'sales_shipment_reversed', title: '发货单已冲销', summary: 'DN-202611-0108 · 12345', entityType: 'ShipmentDocument', entityId: 'SH-1', occurredAt: '' }
  assert.equal(timelineSummary(audit, lookup), 'DN-202611-0108 · 12345')
  // A movement without a warehouse.
  assert.equal(timelineSummary({ ...movement, summary: '15036 · 未指定仓库 · 2' }, lookup), '15036 · No warehouse · 2 pcs')
  // The page no longer formats every all-digit part as a quantity.
  const page = read('src/modules/sales/OutboundWorkbench.tsx')
  assert.doesNotMatch(page, /\/\^-\?\\d\+\(\\\.\\d\+\)\?\$\/\.test\(part\)/)
  assert.match(page, /timelineSummary\(row, lookup\)/)
})

test('#21 each reservation reads once on the timeline; a release keeps its reason', () => {
  const rows = [
    { eventType: 'reservation_reserved', title: 't', summary: '44 · R1', entityType: 'InventoryReservation', entityId: 'R1', occurredAt: 'a', idempotencyKey: 'k1' },
    { eventType: 'sales_inventory_reserved', title: 'Stock reserved for the order', summary: 'SO-1', entityType: 'SalesOrder', entityId: 'SO', occurredAt: 'a', idempotencyKey: 'k1' },
    { eventType: 'reservation_released', title: 't', summary: '2 · R1', entityType: 'InventoryReservation', entityId: 'R1', occurredAt: 'b', idempotencyKey: 'k2' },
    { eventType: 'sales_reservation_released', title: 'Released', summary: 'SO-1 · Customer changed the date', entityType: 'SalesOrder', entityId: 'SO', occurredAt: 'b', idempotencyKey: 'k2' },
    // An audit row whose events are not on the page stays.
    { eventType: 'sales_inventory_reserved', title: 'Stock reserved for the order', summary: 'SO-1', entityType: 'SalesOrder', entityId: 'SO', occurredAt: 'c', idempotencyKey: 'k3' },
  ]
  const folded = foldReservationAudits(rows)
  assert.deepEqual(folded.map((row) => row.eventType), ['reservation_reserved', 'reservation_released', 'sales_inventory_reserved'])
  assert.equal(folded[1].summary, '2 · R1 · Customer changed the date')
})

test('#18 #20 #27 quantities, units and terms read as a person writes them', () => {
  assert.equal(plainQuantity('50.0000'), '50')
  assert.equal(plainQuantity('2.5000'), '2.5')
  assert.equal(plainQuantity('1500.0000'), '1500')
  // The reserve dialog starts at what can be reserved: the smaller of open and available.
  assert.equal(smallerQuantity('50.0000', '44.0000'), '44')
  assert.equal(smallerQuantity('6.0000', '44.0000'), '6')
  assert.equal(smallerQuantity(null, '44.0000'), '44')
  assert.equal(quantityWithUnit('30.0000', 'pcs', 'en-US'), '30 pcs')
  assert.equal(quantityWithUnit('30.0000', 'pcs', 'zh-CN'), '30 件')
  assert.equal(quantityWithUnit('1', 'box', 'en-US'), '1 box')
  assert.equal(paymentTermsLabel('NET30', 'en-US'), 'Net 30 days')
  assert.equal(paymentTermsLabel('Net 45', 'en-US'), 'Net 45 days')
  assert.equal(paymentTermsLabel('NET30', 'zh-CN'), '30 天账期')
  assert.equal(paymentTermsLabel('2/10 net 30', 'en-US'), '2/10 net 30')
  assert.equal(lineShortfall('50.0000', '44.0000'), '6')
  assert.equal(lineShortfall('6.0000', '0.0000'), '6')
  assert.equal(lineShortfall('6.0000', '44.0000'), '')
  assert.equal(lineShortfall('0.0000', '0.0000'), '')
})

test('#4 invoicing progress is against what was shipped', () => {
  assert.equal(invoicingState('0.0000', '0.0000'), 'nothing_shipped')
  assert.equal(invoicingState('60.0000', '0.0000'), 'not_invoiced')
  assert.equal(invoicingState('60.0000', '40.0000'), 'partly_invoiced')
  assert.equal(invoicingState('60.0000', '60.0000'), 'invoiced')
  assert.equal(invoicingProgressText('60.0000', '40.0000', 'pcs', 'en-US'), 'Invoiced 40 of 60 pcs shipped')
  assert.equal(invoicingProgressText('60.0000', '40.0000', 'pcs', 'zh-CN'), '已开票 40，已发货 60 件')
  assert.equal(invoicingProgressText('60.0000', '40.0000', null, 'en-US'), 'Invoiced 40 of 60 shipped')
})

test('#14 the customer picker searches number, name and country', () => {
  const customer = { id: 'C1', code: 'CUS-12748', name: 'Customer 12748 (United Kingdom)', country: null, address: 'United Kingdom' }
  assert.equal(customerMatches(customer, ''), true)
  assert.equal(customerMatches(customer, '12748'), true)
  assert.equal(customerMatches(customer, 'cus-127'), true)
  assert.equal(customerMatches(customer, 'united kingdom 12748'), true)
  assert.equal(customerMatches(customer, 'France'), false)
  assert.equal(customerMatches({ ...customer, name: 'Redwood Plumbing', country: 'US' }, 'redwood us'), true)
  const page = read('src/modules/sales/OutboundWorkbench.tsx')
  assert.match(page, /<CustomerPicker/)
  const picker = read('src/modules/sales/CustomerPicker.tsx')
  assert.match(picker, /role="combobox"/)
  assert.match(picker, /role="listbox"/)
})

const TENANT = 'tenant-a'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const userWith = (permissions) => ({
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [{ warehouseId: 'WH-1', accessLevel: 'operate' }],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'sales', name: 'Sales', status: 'active', permissions: permissions.map((permissionCode) => ({ permissionCode })) } }],
})
const shipment = (id, number, lineId, quantity) => ({
  id, shipmentNumber: number, salesOrderId: 'SO-1', workflowStatus: 'ready', postingStatus: 'posted', version: 1,
  postedAt: new Date('2026-11-12T08:02:00Z'), reversedAt: null, createdAt: new Date('2026-11-12T08:00:00Z'), updatedAt: new Date('2026-11-12T08:02:00Z'),
  lines: [{ id: `${id}-L1`, salesOrderLineId: lineId, sku: lineId === 'L1' ? '15036' : '15034', requestedQuantity: quantity, postedQuantity: quantity, unit: 'pcs', version: 1, salesOrderLine: { itemName: 'Fan' }, allocations: [{ id: `${id}-A1`, reservationId: `R-${id}`, warehouseId: 'WH-1', location: 'A-01', locationKey: 'a-01', quantity, status: 'consumed', reservation: { sku: lineId === 'L1' ? '15036' : '15034' } }] }],
})
const order = {
  id: 'SO-1', tenantId: TENANT, orderNumber: 'SO-202611-0108', customerId: 'CUS-1', customerName: 'Customer 12748 (United Kingdom)',
  currency: 'GBP', workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'partially_fulfilled',
  promisedDate: null, version: 5, createdAt: new Date('2026-11-12T07:58:00Z'), updatedAt: new Date('2026-11-12T08:03:00Z'),
  lines: [
    { id: 'L1', itemId: 'ITEM-1', sku: '15036', itemName: 'Fan', orderedQuantity: '50', reservedQuantity: '0', fulfilledQuantity: '44', unit: 'pcs', unitPrice: '3.75', version: 3 },
    { id: 'L2', itemId: 'ITEM-2', sku: '15034', itemName: 'Paper fan', orderedQuantity: '10', reservedQuantity: '0', fulfilledQuantity: '10', unit: 'pcs', unitPrice: '2.10', version: 3 },
  ],
  reservations: [],
  shipments: [shipment('SH-1', 'DN-202611-0108', 'L1', '30'), shipment('SH-2', 'DN-202611-0109', 'L1', '14'), shipment('SH-3', 'DN-202611-0110', 'L2', '10')],
}
// CI-0108 (issued) bills DN-0108; CI-0109 is a draft for DN-0109, which holds nothing.
const invoiceLines = [
  { salesOrderLineId: 'L1', shipmentLineId: 'SH-1-L1', quantity: '30', customerInvoice: { id: 'CI-1', invoiceNumber: 'CI-202611-0108', status: 'issued', shipmentId: 'SH-1', salesOrderId: 'SO-1' } },
  { salesOrderLineId: 'L1', shipmentLineId: 'SH-2-L1', quantity: '14', customerInvoice: { id: 'CI-2', invoiceNumber: 'CI-202611-0109', status: 'draft', shipmentId: 'SH-2', salesOrderId: 'SO-1' } },
]
function fakePrisma(permissions, calls = []) {
  const empty = { findMany: async () => [] }
  return {
    calls,
    user: { findFirst: async () => userWith(permissions) },
    salesOrder: {
      findFirst: async () => order,
      count: async () => 1,
      findMany: async (args) => (args.distinct ? [{ currency: 'GBP' }] : [order]),
    },
    shipmentDocument: { findFirst: async ({ where }) => ({ ...order.shipments.find((row) => row.id === where.id), salesOrder: order }) },
    customerInvoiceLine: {
      findMany: async (args) => {
        calls.push(args)
        assert.equal(args.where.customerInvoice.tenantId, TENANT)
        const holding = args.where.customerInvoice.status?.in
        const shipments = args.where.customerInvoice.shipmentId?.in
        return invoiceLines.filter((row) => (!holding || holding.includes(row.customerInvoice.status)) && (!shipments || shipments.includes(row.customerInvoice.shipmentId)))
      },
    },
    customerInvoice: { findFirst: async ({ where }) => (invoiceLines.find((row) => row.customerInvoice.shipmentId === where.shipmentId && where.status.in.includes(row.customerInvoice.status)) ? { id: 'x' } : null) },
    inventoryBalance: empty, auditLog: empty, inventoryReservationEvent: empty, inventoryMovement: empty, businessCommandExecution: empty,
  }
}

test('#4 the order read service says how much of each line is invoiced, to a reader who may read invoices', async () => {
  const service = createOutboundWorkbenchReadService({ prisma: fakePrisma(['sales_order.read', 'shipment.read', 'finance.customer_invoice.read']) })
  const workbench = await service.orderWorkbench('SO-1', { identity })
  // Only an invoice that holds its shipment counts: the draft for DN-0109 does not.
  assert.deepEqual(workbench.lines.map((line) => line.invoicedQuantity), ['30.0000', '0.0000'])
  assert.deepEqual(workbench.invoices.map((row) => [row.invoiceNumber, row.status, row.shipmentId]), [['CI-202611-0108', 'issued', 'SH-1'], ['CI-202611-0109', 'draft', 'SH-2']])
  // Without customer invoice access: no figure, no invoice, no read.
  const calls = []
  const plain = await createOutboundWorkbenchReadService({ prisma: fakePrisma(['sales_order.read', 'shipment.read'], calls) }).orderWorkbench('SO-1', { identity })
  assert.deepEqual(plain.lines.map((line) => line.invoicedQuantity), [null, null])
  assert.equal(plain.invoices, null)
  assert.equal(calls.length, 0)
})

test('#12 a shipment a customer invoice holds offers the invoice, not a reversal; its timeline is its own', async () => {
  const prisma = fakePrisma(['sales_order.read', 'shipment.read', 'finance.customer_invoice.read'])
  const service = createOutboundWorkbenchReadService({ prisma })
  const invoiced = await service.shipmentWorkbench('SH-1', { identity })
  assert.equal(invoiced.reversalBlockedByInvoice, true)
  assert.deepEqual(invoiced.lines.map((line) => line.invoicedQuantity), ['30.0000'])
  assert.deepEqual(invoiced.invoices.map((row) => row.invoiceNumber), ['CI-202611-0108'])
  // A draft invoice does not hold the shipment.
  const drafted = await service.shipmentWorkbench('SH-2', { identity })
  assert.equal(drafted.reversalBlockedByInvoice, false)
  assert.deepEqual(drafted.lines.map((line) => line.invoicedQuantity), ['0.0000'])
  // The reversal rule itself is unchanged: the read model only reports.
  assert.equal(typeof invoiced.availableActions.canReverse, 'boolean')
  const source = read('server/domain/outbound-workbench-read-service.mjs')
  assert.doesNotMatch(source, /row\.eventType\.includes\("shipment"\)/)
})

test('#4 the order list says how much of each order is invoiced, to a reader who may read invoices', async () => {
  const prisma = fakePrisma(['sales_order.read', 'finance.customer_invoice.read'])
  const list = await createSalesOrderReadService({ prisma }).listOrders({}, { identity })
  assert.equal(list.orders[0].invoicedQuantity, '30.0000')
  assert.deepEqual(prisma.calls[0].where.customerInvoice.status.in, ['submitted', 'approved', 'issued', 'disputed'])
  const plain = await createSalesOrderReadService({ prisma: fakePrisma(['sales_order.read']) }).listOrders({}, { identity })
  assert.equal(plain.orders[0].invoicedQuantity, null)
})

test('#12 #22 the posted shipment page: invoice first, reversal an outlined undo, plain facts', () => {
  const page = read('src/modules/sales/OutboundWorkbench.tsx')
  const shipmentPage = page.slice(page.indexOf('function ShipmentDetail('), page.indexOf('function Table('))
  assert.match(shipmentPage, /<InvoiceButton shipmentId=\{id\} primary \/>/)
  assert.match(shipmentPage, /tone="dangerOutline"/)
  assert.match(shipmentPage, /canReverse = data\.availableActions\.canReverse && !invoicedAlready/)
  // Buttons keep their height beside the heading.
  assert.match(shipmentPage, /flex flex-wrap items-start justify-between gap-3/)
  // No "Posted — · Reversed —" placeholders, no "In 0 / Out 30".
  assert.doesNotMatch(shipmentPage, /Posted \{posted\} · Reversed \{reversed\}/)
  assert.doesNotMatch(shipmentPage, /copy\("入"\)/)
  for (const fact of ['shipment-customer', 'shipment-warehouse', 'shipment-date']) assert.match(shipmentPage, new RegExp(`testId="${fact}"`))
  // Posting is one confirmation: the preview is read as the dialog opens.
  assert.match(shipmentPage, /if \(x === "post"\) void loadPreview\("post"\)/)
  assert.match(shipmentPage, /intent !== "post" && \(\s*<Button tone="secondary" testId="shipment-preview"/)
})

test('#16 #17 no reason is prefilled before the language is known, and every sales action toasts', () => {
  const page = read('src/modules/sales/OutboundWorkbench.tsx')
  assert.doesNotMatch(page, /useState\(\(\) => copy\("业务冲销"\)\)/)
  assert.doesNotMatch(page, /useState\(\(\) => copy\("业务调整"\)\)/)
  for (const toast of ['saved as a draft', 'confirmed', 'put on hold', 'resumed', 'cancelled`', 'Reserved ${', 'Released ${', 'Shipment ${shipmentNumber} created', 'Shipment ${number} posted', 'Shipment ${number} reversed']) {
    assert.ok(page.includes(toast), toast)
  }
  assert.match(page, /import \{ toast \} from "sonner"/)
})

test('#15 #33 the shipment risk page shows each line, plain notes and a reorder link; names are not cut off', () => {
  const page = read('src/modules/sales/Page.tsx')
  const risks = page.slice(page.indexOf('function RiskView()'), page.indexOf('function EvidenceChainView('))
  assert.doesNotMatch(risks, /copy\("数据限制："\)/)
  assert.match(risks, /riskLines\(order\)/)
  assert.match(risks, /to="\/app\/inventory\/reorder"/)
  // The reason column holds its width under the sticky actions column.
  assert.match(risks, /<div className="w-\[200px\] whitespace-normal">/)
  assert.match(risks, /risks\.pages > 1 && <ListPager/)
  assert.doesNotMatch(page, /max-w-\[200px\] truncate/)
  const list = read('src/modules/sales/OutboundWorkbench.tsx')
  assert.doesNotMatch(list, /max-w-\[220px\] truncate`\} title=\{row\.customerName\}/)
})

test('#21 one Chinese word for on hand: 在手 as on the inventory pages', () => {
  for (const file of ['src/modules/sales/OutboundWorkbench.tsx', 'src/modules/sales/outboundCopy.ts', 'src/modules/sales/outboundPreviewText.ts']) {
    const source = read(file)
    assert.doesNotMatch(source, /在库量|现有量|"现有 \{n\}"/, file)
  }
})
