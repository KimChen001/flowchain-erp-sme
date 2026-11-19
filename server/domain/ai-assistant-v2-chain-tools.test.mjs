import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_ASSISTANT_V2_CHAIN_TOOLS, CHAIN_LIMITS, describeDocumentChain, walkDocumentChain } from './ai-assistant-v2-chain-tools.mjs'
import { aiReadToolDefinitions, aiReadToolRefs, runAiReadTool } from './ai-read-tool-runner.mjs'
import { aiGroundingRecordNumbers, checkAiModelFirstGrounding } from './ai-model-first-grounding.mjs'
import { buildRuntimeEvidenceGraph } from './runtime-evidence-graph.mjs'
import { reportReadAccessFor, scopeBusinessContext } from './report-read-access.mjs'
import { inMemoryModel } from './test-fixtures/in-memory-prisma.mjs'
import { defaultRoleTemplates } from '../auth/permission-catalog.mjs'
import { ASSISTANT_V2_SYSTEM } from './ai-assistant-v2.mjs'
import { matchResultOf } from '../../src/modules/procurement/threeWayMatchResult.ts'

// trace_document_chain (ai-assistant-v2-chain-tools.mjs): one document's chain
// from the evidence graph, as the reader may see it. The workspace, on
// 2026-11-18:
//
//   PR-202611-0001 (converted) -> RFQ-202611-0001 (closed, awarded) -> PO-202611-0001
//   PR-202611-0001 -> PO-202611-0001: 500 pcs of 85123A at 2.50, promised
//     2026-11-13, 280 received: 220 still to receive, 5 days late
//   PO-202611-0001 -> GRN-202611-0001 (WH-1, posted, 200 pcs)
//                  -> GRN-202611-0002 (WH-2, posted, 80 pcs, 5 rejected)
//   GRN-202611-0001 -> INV-SUP-22-0031 (approved, payable 500.00 due
//     2026-11-16: 2 days overdue)
//   GRN-202611-0002 -> INV-SUP-22-0049 (held at the match: 80 pcs at 2.58,
//     price +3.2%; PO-202611-0003, ordered later, has 2.58)
//   PR-202611-0002 approved, nothing came of it yet
//   PO-202611-0002 another supplier's order, not linked: never in the chain

const T = 'tenant-chain'
const OTHER = 'tenant-chain-other'
const TODAY = '2026-11-18'
const NOW = new Date('2026-11-18T12:00:00Z')

function workspace() {
  const poLine = (id, sku, ordered, received, price, promised) => ({ id, sku, itemName: 'White Hanging Heart T-Light Holder', quantity: String(ordered), orderedQuantity: String(ordered), receivedQuantity: String(received), unit: 'pcs', unitPrice: price, amount: String(Number(price) * ordered), promisedDate: promised })
  return {
    purchaseRequests: [
      { id: 'pr-1', pr: 'pr-1', number: 'PR-202611-0001', status: 'converted', requiredDate: '2026-11-13', supplier: 'Acme Components', createdAt: '2026-11-02', lines: [{ id: 'pr-1-L1', sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', quantity: 500, unit: 'pcs' }] },
      { id: 'pr-2', pr: 'pr-2', number: 'PR-202611-0002', status: 'approved', requiredDate: '2026-11-30', createdAt: '2026-11-16', lines: [{ id: 'pr-2-L1', sku: '22423', quantity: 12, unit: 'pcs' }] },
    ],
    rfqs: [{ id: 'rfq-1', number: 'RFQ-202611-0001', status: 'closed', title: 'Heart holders', suppliers: 3, quoted: 2, due: '2026-11-03', sourcePrId: 'pr-1', sourceRequest: 'pr-1', linkedPo: 'po-1', bestSupplier: 'Acme Components', createdAt: '2026-11-02' }],
    purchaseOrders: [
      { id: 'po-1', number: 'PO-202611-0001', orderNumber: 'PO-202611-0001', supplierId: 'sup-1', supplierSnapshot: { id: 'sup-1', supplierName: 'Acme Components' }, currency: 'GBP', totalAmount: '1250.0000', status: 'partially_received', sourcePrId: 'pr-1', sourceRfqId: 'rfq-1', issuedAt: '2026-11-04T10:00:00.000Z', createdAt: '2026-11-04T09:00:00.000Z', lines: [poLine('po-1-L001', '85123A', 500, 280, '2.5000', '2026-11-13')], metadata: {} },
      { id: 'po-2', number: 'PO-202611-0002', orderNumber: 'PO-202611-0002', supplierId: 'sup-2', supplierSnapshot: { id: 'sup-2', supplierName: 'Summit Packaging' }, currency: 'GBP', totalAmount: '40.0000', status: 'issued', createdAt: '2026-11-05T09:00:00.000Z', lines: [poLine('po-2-L001', '22423', 10, 10, '4.0000', '2026-11-12')], metadata: {} },
    ],
    receipts: [
      { id: 'grn-1', documentNumber: 'GRN-202611-0001', poId: 'po-1', supplierName: 'Acme Components', postingStatus: 'posted', warehouseId: 'WH-1', arrivedAt: '2026-11-06T07:00:00.000Z', postedAt: '2026-11-06T07:10:00.000Z', createdAt: '2026-11-06T07:00:00.000Z', lines: [{ id: 'grn-1-L1', purchaseOrderLineId: 'po-1-L001', sku: '85123A', acceptedQty: '200', rejectedQty: '0', unit: 'pcs', warehouseId: 'WH-1' }] },
      { id: 'grn-2', documentNumber: 'GRN-202611-0002', poId: 'po-1', supplierName: 'Acme Components', postingStatus: 'posted', warehouseId: 'WH-2', arrivedAt: '2026-11-10T07:00:00.000Z', postedAt: '2026-11-10T07:10:00.000Z', createdAt: '2026-11-10T07:00:00.000Z', lines: [{ id: 'grn-2-L1', purchaseOrderLineId: 'po-1-L001', sku: '85123A', acceptedQty: '80', rejectedQty: '5', unit: 'pcs', warehouseId: 'WH-2' }] },
      { id: 'grn-3', documentNumber: 'GRN-202611-0003', poId: 'po-2', supplierName: 'Summit Packaging', postingStatus: 'posted', warehouseId: 'WH-1', arrivedAt: '2026-11-12T07:00:00.000Z', createdAt: '2026-11-12T07:00:00.000Z', lines: [{ id: 'grn-3-L1', purchaseOrderLineId: 'po-2-L001', sku: '22423', acceptedQty: '10', rejectedQty: '0', unit: 'pcs', warehouseId: 'WH-1' }] },
    ],
    supplierInvoices: [
      { id: 'inv-31', invoiceNumber: 'INV-SUP-22-0031', supplierId: 'sup-1', supplierName: 'Acme Components', poId: 'po-1', receiptId: 'grn-1', relatedPo: 'po-1', relatedGrn: 'grn-1', amount: '500.0000', totalAmount: '500.0000', currency: 'GBP', status: 'approved', matchStatus: 'matched', varianceAmount: '0.0000', invoiceDate: '2026-11-07T00:00:00.000Z', dueDate: '2026-11-16T00:00:00.000Z', createdAt: '2026-11-07T10:00:00.000Z', lines: [{ id: 'inv-31-L1', purchaseOrderLineId: 'po-1-L001', receivingLineId: 'grn-1-L1', sku: '85123A', quantity: '200', unitPrice: '2.5000', amount: '500.0000', unit: 'pcs' }] },
      { id: 'inv-49', invoiceNumber: 'INV-SUP-22-0049', supplierId: 'sup-1', supplierName: 'Acme Components', poId: 'po-1', receiptId: 'grn-2', relatedPo: 'po-1', relatedGrn: 'grn-2', amount: '206.4000', totalAmount: '206.4000', currency: 'GBP', status: 'exception', matchStatus: 'exception', varianceAmount: '6.4000', invoiceDate: '2026-11-11T00:00:00.000Z', dueDate: '2026-12-11T00:00:00.000Z', createdAt: '2026-11-11T10:00:00.000Z', lines: [{ id: 'inv-49-L1', purchaseOrderLineId: 'po-1-L001', receivingLineId: 'grn-2-L1', sku: '85123A', quantity: '80', unitPrice: '2.5800', amount: '206.4000', unit: 'pcs' }] },
    ],
    truncatedSubjects: [],
  }
}

// The records the tool reads beyond the business read context, as Prisma
// holds them; another workspace's payable for the same invoice id must never
// be read.
function prisma() {
  const order = (id, number, createdAt, status = 'issued') => ({ id, tenantId: T, number, metadata: {}, supplierId: 'sup-1', status, createdAt: new Date(createdAt) })
  return {
    payableObligation: inMemoryModel([
      { id: 'ap-31', tenantId: T, supplierInvoiceId: 'inv-31', obligationNumber: 'AP-202611-0001', status: 'approved', outstandingAmount: '500.0000', currency: 'GBP', dueDate: new Date('2026-11-16T00:00:00Z') },
      { id: 'ap-x', tenantId: OTHER, supplierInvoiceId: 'inv-49', obligationNumber: 'AP-OTHER-0001', status: 'held', outstandingAmount: '9.0000', currency: 'GBP', dueDate: new Date('2026-10-01T00:00:00Z') },
    ]),
    supplierInvoice: inMemoryModel([{ id: 'inv-49', tenantId: T, invoiceNumber: 'INV-SUP-22-0049', supplierId: 'sup-1', supplierName: 'Acme Components', relatedPoId: 'po-1', currency: 'GBP' }]),
    financeMatchException: inMemoryModel([
      { id: 'fme-1', tenantId: T, matchLineId: 'twml-1', supplierInvoiceId: 'inv-49', exceptionType: 'price', status: 'open', expectedValue: '2.5000', actualValue: '2.5800', varianceValue: '0.0800', createdAt: new Date('2026-11-11T10:05:00Z') },
      { id: 'fme-x', tenantId: OTHER, matchLineId: 'twml-1', supplierInvoiceId: 'inv-49', exceptionType: 'quantity', status: 'open', expectedValue: '1', actualValue: '2', varianceValue: '1', createdAt: new Date('2026-11-11T10:05:00Z') },
    ]),
    threeWayMatchLine: inMemoryModel([{ id: 'twml-1', sku: '85123A', unit: 'pcs', orderedQuantity: '500', receivedQuantity: '80', previouslyInvoicedQuantity: '0', invoiceQuantity: '80', poUnitPrice: '2.5000', invoiceUnitPrice: '2.5800' }]),
    purchaseOrder: inMemoryModel([order('po-1', 'PO-202611-0001', '2026-11-04T09:00:00Z', 'partially_received')]),
    purchaseOrderLine: inMemoryModel([
      { id: 'po-1-L001', sku: '85123A', unitPrice: '2.5000', purchaseOrder: order('po-1', 'PO-202611-0001', '2026-11-04T09:00:00Z', 'partially_received') },
      { id: 'po-3-L001', sku: '85123A', unitPrice: '2.5800', purchaseOrder: order('po-3', 'PO-202611-0003', '2026-11-15T09:00:00Z') },
    ]),
  }
}

const roleCodes = (roleKey) => new Set(defaultRoleTemplates.find((role) => role.roleKey === roleKey).permissions)
const actorOf = (roleKey = 'workspace-administrator', { warehouses = null } = {}) => ({
  authenticated: true, complete: true, tenantId: T, userId: `${roleKey}-user`, roleIds: [roleKey], permissionCodes: roleCodes(roleKey),
  permissionSourceRoleIds: new Map(), allWarehouses: !warehouses, readWarehouseIds: warehouses ? new Set(warehouses) : null, operateWarehouseIds: warehouses ? new Set(warehouses) : null,
})

// The tool through the assistant's one door (runAiReadTool), as the reader.
async function trace(document, { roleKey, warehouses, data = workspace(), db = prisma() } = {}) {
  const actor = actorOf(roleKey, { warehouses })
  const context = { actor, tenantId: T, tenant: { timezone: 'Europe/London', currency: 'GBP' }, now: NOW, today: TODAY, prisma: db, routeContext: { aiSkillBusinessContext: data, identity: { tenantId: T } } }
  return runAiReadTool('trace_document_chain', { document }, { facts: { today: TODAY, asOf: TODAY }, context })
}
const numbers = (result) => result.nodes.map((node) => node.number)
const nodeOf = (result, number) => result.nodes.find((node) => node.number === number)

test('an invoice\'s chain: its request, RFQ, order, the order\'s receipts and invoices, in process order, with the evidence graph\'s links', async () => {
  const { ok, result } = await trace('INV-SUP-22-0049')
  assert.ok(ok)
  assert.equal(result.document, 'INV-SUP-22-0049')
  assert.equal(result.documentType, 'supplier_invoice')
  assert.deepEqual(numbers(result), ['PR-202611-0001', 'RFQ-202611-0001', 'PO-202611-0001', 'GRN-202611-0001', 'GRN-202611-0002', 'INV-SUP-22-0031', 'INV-SUP-22-0049'])
  assert.deepEqual(result.nodes.map((node) => node.type), ['purchase_request', 'rfq', 'purchase_order', 'receipt', 'receipt', 'supplier_invoice', 'supplier_invoice'])
  const links = result.links.map((link) => `${link.from} ${link.relation} ${link.to}`).sort()
  assert.deepEqual(links, [
    'GRN-202611-0001 invoiced_by INV-SUP-22-0031',
    'GRN-202611-0002 invoiced_by INV-SUP-22-0049',
    'PO-202611-0001 invoiced_by INV-SUP-22-0031',
    'PO-202611-0001 invoiced_by INV-SUP-22-0049',
    'PO-202611-0001 received_by GRN-202611-0001',
    'PO-202611-0001 received_by GRN-202611-0002',
    'PR-202611-0001 converted_to_po PO-202611-0001',
    'PR-202611-0001 sourced_by_rfq RFQ-202611-0001',
    'RFQ-202611-0001 awarded_to_po PO-202611-0001',
  ])
  // Another supplier's order and the request nothing came of are not in it.
  assert.doesNotMatch(JSON.stringify(result), /PO-202611-0002|GRN-202611-0003|PR-202611-0002/)
  assert.ok(!result.cut)
  // Each document with its own figures, as the pages read them.
  const order = nodeOf(result, 'PO-202611-0001')
  assert.deepEqual([order.status, order.supplier, order.dueDate, order.overdueDays, order.open, order.amount, order.currency], ['partially_received', 'Acme Components', '2026-11-13', 5, true, 1250, 'GBP'])
  assert.deepEqual(order.lines, [{ sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', ordered: 500, received: 280, remaining: 220, unit: 'pcs', promisedDate: '2026-11-13', overdueDays: 5, unitPrice: 2.5 }])
  assert.deepEqual(nodeOf(result, 'GRN-202611-0002').lines, [{ sku: '85123A', accepted: 80, rejected: 5, unit: 'pcs' }])
  const held = nodeOf(result, 'INV-SUP-22-0049')
  assert.deepEqual([held.status, held.matchStatus, held.nextStep, held.amount, held.variance, held.preparedStep], ['exception', 'exception', 'bill_exception', 206.4, 6.4, 'review_price'])
  assert.deepEqual(held.differences, [{ kind: 'price', sku: '85123A', unit: 'pcs', cause: 'price_changed', expected: 2.5, actual: 2.58, variance: 0.08, percent: 3.2, evidenceOrder: 'PO-202611-0003' }])
  assert.equal(held.payable, undefined, 'a held invoice has no payable, and another workspace\'s is never read')
  const paid = nodeOf(result, 'INV-SUP-22-0031')
  assert.deepEqual([paid.status, paid.matchStatus, paid.nextStep], ['to_pay', 'matched', undefined])
  assert.deepEqual(paid.payable, { number: 'AP-202611-0001', status: 'approved', outstanding: 500, currency: 'GBP', dueDate: '2026-11-16', overdueDays: 2 })
  assert.deepEqual(result.nodes.map((node) => node.ref.type), ['purchase_request', 'rfq', 'purchase_order', 'receiving_doc', 'receiving_doc', 'supplier_invoice', 'supplier_invoice'])
})

test('open points come from the app\'s rules, the asked document\'s first', async () => {
  const { result } = await trace('INV-SUP-22-0049')
  assert.deepEqual(result.openPoints.map((point) => [point.document, point.kind]), [
    ['INV-SUP-22-0049', 'held_at_match'],
    ['PO-202611-0001', 'late_to_receive'],
    ['GRN-202611-0002', 'rejected'],
    ['INV-SUP-22-0031', 'payment_overdue'],
  ])
  const [held, late, rejected, overdue] = result.openPoints
  assert.deepEqual(held, { document: 'INV-SUP-22-0049', kind: 'held_at_match', text: 'Held by a match exception: price +3.2% on 85123A', percent: 3.2 })
  assert.deepEqual(late, { document: 'PO-202611-0001', kind: 'late_to_receive', text: '220 pcs of 85123A still to receive, 5 days past the promised date 2026-11-13', sku: '85123A', remaining: 220, unit: 'pcs', promisedDate: '2026-11-13', overdueDays: 5 })
  assert.equal(rejected.text, '5 pcs of 85123A rejected')
  assert.deepEqual(overdue, { document: 'INV-SUP-22-0031', kind: 'payment_overdue', text: 'Not paid, 2 days past its due date 2026-11-16', outstanding: 500, currency: 'GBP', dueDate: '2026-11-16', overdueDays: 2 })
  // A request approved with nothing after it, and a receipt no invoice covers.
  const request = (await trace('PR-202611-0002')).result
  assert.deepEqual(numbers(request), ['PR-202611-0002'])
  assert.deepEqual(request.openPoints, [{ document: 'PR-202611-0002', kind: 'no_order_yet', text: 'Approved, no purchase order or RFQ yet' }])
  const other = (await trace('PO-202611-0002')).result
  assert.deepEqual(other.openPoints, [{ document: 'GRN-202611-0003', kind: 'not_invoiced', text: 'Received, no supplier invoice yet' }])
  // A request out for quotes: the RFQ's state, not "no order yet".
  const data = workspace()
  data.purchaseRequests.push({ id: 'pr-3', pr: 'pr-3', number: 'PR-202611-0003', status: 'approved', createdAt: '2026-11-17', lines: [] })
  data.rfqs.push({ id: 'rfq-2', number: 'RFQ-202611-0002', status: 'collecting_quotes', title: 'Cake stands', suppliers: 3, quoted: 1, due: '2026-11-25', sourcePrId: 'pr-3', createdAt: '2026-11-17' })
  const quoting = (await trace('PR-202611-0003', { data })).result
  assert.deepEqual(quoting.links, [{ from: 'PR-202611-0003', to: 'RFQ-202611-0002', relation: 'sourced_by_rfq' }])
  assert.deepEqual(quoting.openPoints, [{ document: 'RFQ-202611-0002', kind: 'collecting_quotes', text: '1 of 3 suppliers quoted, due 2026-11-25', quotes: 1, invited: 3, due: '2026-11-25' }])
})

test('an invoice\'s match state agrees with the three-way match list (matchResultOf) and Today\'s next step', async () => {
  const data = workspace()
  // Inside the tolerance (design audit B2): matched, with its small variance on record.
  data.supplierInvoices.push({ ...data.supplierInvoices[0], id: 'inv-50', invoiceNumber: 'INV-SUP-22-0050', status: 'matched', matchStatus: 'matched', varianceAmount: '0.4000', receiptId: 'grn-1', relatedGrn: 'grn-1', lines: [] })
  // Every difference approved, the invoice still to approve.
  data.supplierInvoices.push({ ...data.supplierInvoices[0], id: 'inv-51', invoiceNumber: 'INV-SUP-22-0051', status: 'exception', matchStatus: 'variance_approved', varianceAmount: '3.0000', receiptId: 'grn-1', relatedGrn: 'grn-1', lines: [] })
  const { result } = await trace('PO-202611-0001', { data })
  const invoices = result.nodes.filter((node) => node.type === 'supplier_invoice')
  assert.deepEqual(invoices.map((node) => [node.number, node.matchStatus, node.nextStep ?? null, matchResultOf({ matchStatus: node.matchStatus })]), [
    ['INV-SUP-22-0031', 'matched', null, 'matched'],
    ['INV-SUP-22-0050', 'matched', 'bill_to_approve', 'matched'],
    ['INV-SUP-22-0051', 'variance_approved', 'bill_to_approve', 'matched'],
    ['INV-SUP-22-0049', 'exception', 'bill_exception', 'variance'],
  ])
  // Held only where the list counts a variance.
  for (const node of invoices) assert.equal(result.openPoints.some((point) => point.document === node.number && point.kind === 'held_at_match'), matchResultOf({ matchStatus: node.matchStatus }) === 'variance', node.number)
  assert.equal(result.openPoints.find((point) => point.document === 'INV-SUP-22-0051').text, 'Every difference approved, waiting for approval')
})

test('a reader without finance read sees no supplier invoice, and an invoice number is not found', async () => {
  // A procurement specialist: requests, orders and receipts, no finance pages.
  const { result } = await trace('PO-202611-0001', { roleKey: 'procurement-specialist' })
  assert.deepEqual(numbers(result), ['PR-202611-0001', 'RFQ-202611-0001', 'PO-202611-0001', 'GRN-202611-0001', 'GRN-202611-0002'])
  assert.doesNotMatch(JSON.stringify(result), /INV-SUP|AP-2026|Held by|payment/i)
  assert.deepEqual(result.notShown, ['supplier_invoices'])
  // Never says whether the invoice exists.
  assert.deepEqual(await trace('INV-SUP-22-0049', { roleKey: 'procurement-specialist' }), { ok: false, error: 'not_found' })
  // A receipt not invoiced is not said to a reader who cannot see invoices.
  assert.ok(!result.openPoints.some((point) => point.kind === 'not_invoiced'))
})

test('a reader without amounts, prices or invoice suppliers sees the chain with those values left out', async () => {
  const { result } = await trace('INV-SUP-22-0049', { roleKey: 'read-only-viewer' })
  assert.deepEqual(result.hidden, { prices: true, invoiceAmounts: true, invoiceSuppliers: true })
  const order = nodeOf(result, 'PO-202611-0001')
  assert.equal(order.amount, undefined)
  assert.equal(order.lines[0].unitPrice, undefined)
  assert.equal(order.lines[0].remaining, 220, 'quantities stay')
  const held = nodeOf(result, 'INV-SUP-22-0049')
  for (const key of ['amount', 'variance', 'supplier']) assert.equal(held[key], undefined, key)
  assert.deepEqual(held.lines, [{ sku: '85123A', quantity: 80, unit: 'pcs' }])
  // The difference is named, not valued; its cause is not read without prices.
  assert.deepEqual(held.differences, [{ kind: 'price', sku: '85123A', unit: 'pcs' }])
  assert.equal(result.openPoints[0].text, 'Held by a match exception: price on 85123A')
  assert.equal(result.openPoints[0].percent, undefined)
  const paid = nodeOf(result, 'INV-SUP-22-0031')
  assert.equal(paid.payable.outstanding, undefined)
  assert.doesNotMatch(JSON.stringify(result), /1250|206\.4|2\.58|"outstanding"/)
})

test('a reader limited to one warehouse sees only that warehouse\'s receipts', async () => {
  const { ok, result } = await trace('INV-SUP-22-0031', { warehouses: ['WH-1'] })
  assert.ok(ok)
  assert.deepEqual(numbers(result), ['PR-202611-0001', 'RFQ-202611-0001', 'PO-202611-0001', 'GRN-202611-0001', 'INV-SUP-22-0031', 'INV-SUP-22-0049'])
  assert.doesNotMatch(JSON.stringify(result), /GRN-202611-0002/)
  assert.equal(result.receiptsInYourWarehousesOnly, true)
  // Its invoice still links to the order it bills.
  assert.ok(result.links.some((link) => link.from === 'PO-202611-0001' && link.to === 'INV-SUP-22-0049'))
  // A receipt outside them is not found, as on the receipt list.
  assert.deepEqual(await trace('GRN-202611-0002', { warehouses: ['WH-1'] }), { ok: false, error: 'not_found' })
  // Every warehouse: both.
  assert.ok(numbers((await trace('INV-SUP-22-0031')).result).includes('GRN-202611-0002'))
})

test('the walk is bounded: at most CHAIN_LIMITS.nodes documents, nearest first, and the result says when it was cut', async () => {
  const data = workspace()
  // A request turned into 30 orders, each with a receipt.
  for (let at = 0; at < 30; at += 1) {
    const id = `po-x${at}`
    data.purchaseOrders.push({ ...data.purchaseOrders[1], id, number: `PO-202611-1${String(at).padStart(3, '0')}`, orderNumber: `PO-202611-1${String(at).padStart(3, '0')}`, sourcePrId: 'pr-2' })
    data.receipts.push({ ...data.receipts[2], id: `grn-x${at}`, documentNumber: `GRN-202611-1${String(at).padStart(3, '0')}`, poId: id })
  }
  const { result } = await trace('PR-202611-0002', { data })
  assert.equal(result.nodes.length, CHAIN_LIMITS.nodes)
  assert.deepEqual(result.cut, { maxDepth: CHAIN_LIMITS.depth, maxNodes: CHAIN_LIMITS.nodes, leftOut: 61 - CHAIN_LIMITS.nodes })
  // The request and its orders (one link away) before any receipt (two).
  assert.equal(result.nodes[0].number, 'PR-202611-0002')
  assert.equal(result.nodes.filter((node) => node.type === 'purchase_order').length, 24)
  assert.ok(!result.nodes.some((node) => node.type === 'receipt'))
  // Every link shown is between documents shown.
  const shown = new Set(numbers(result))
  assert.ok(result.links.every((link) => shown.has(link.from) && shown.has(link.to)))
  // A cut walk does not say a request has no order or a receipt no invoice.
  assert.ok(!result.openPoints.some((point) => ['no_order_yet', 'not_invoiced'].includes(point.kind)))
  // Depth: one link from the invoice reaches its order and receipt only.
  const scoped = scopeBusinessContext(workspace(), reportReadAccessFor(actorOf()))
  const near = walkDocumentChain(scoped, { document: 'INV-SUP-22-0049', limits: { ...CHAIN_LIMITS, depth: 1 } })
  assert.deepEqual(near.members.map((member) => member.number), ['PO-202611-0001', 'GRN-202611-0002', 'INV-SUP-22-0049'])
  assert.equal(near.cut.maxDepth, 1)
})

test('an unknown number is not found; one several documents share is ambiguous; a number\'s end is enough when one document has it', async () => {
  assert.deepEqual(await trace('INV-NOPE-1'), { ok: false, error: 'not_found' })
  assert.deepEqual(await trace(''), { ok: false, error: 'invalid_arguments', details: ['missing argument document'] })
  const data = workspace()
  // Two suppliers' invoices with the same number.
  data.supplierInvoices.push({ ...data.supplierInvoices[0], id: 'inv-other', invoiceNumber: 'INV-SUP-22-0031', supplierId: 'sup-2', supplierName: 'Summit Packaging', poId: 'po-2', relatedPo: 'po-2', receiptId: 'grn-3', relatedGrn: 'grn-3' })
  const twice = await trace('INV-SUP-22-0031', { data })
  assert.equal(twice.error, 'ambiguous')
  assert.deepEqual(twice.candidates.map((row) => [row.type, row.number, row.supplier]), [['supplier_invoice', 'INV-SUP-22-0031', 'Acme Components'], ['supplier_invoice', 'INV-SUP-22-0031', 'Summit Packaging']])
  // Each candidate's ref reads it.
  const picked = await trace(twice.candidates[1].ref.id, { data })
  assert.deepEqual(numbers(picked.result).slice(-2), ['GRN-202611-0003', 'INV-SUP-22-0031'])
  assert.equal((await trace('0049')).result.document, 'INV-SUP-22-0049')
  assert.equal((await trace('pr-202611-0001')).result.document, 'PR-202611-0001')
  // The end of several numbers is ambiguous too.
  assert.equal((await trace('0001')).error, 'ambiguous')
})

test('every record number, date and figure an answer takes from the result passes the grounding check', async () => {
  const { result } = await trace('INV-SUP-22-0049')
  const refs = aiReadToolRefs(result)
  assert.equal(refs.length, 7)
  // Every record number anywhere in the result, cited in one answer.
  const all = [...new Set(aiGroundingRecordNumbers(JSON.stringify(result)))]
  assert.ok(all.includes('PO-202611-0003') && all.includes('AP-202611-0001'))
  const listed = checkAiModelFirstGrounding({ answer: { answer: `The chain: ${all.join(', ')}.` }, results: [result], refs, question: 'Why is INV-SUP-22-0049 held?', today: TODAY })
  assert.deepEqual(listed.problems, [])
  // An answer as the model would write it, with records cited.
  const answer = {
    answer: [
      'INV-SUP-22-0049 from Acme Components is held by a match exception: its price is 3.2% above PO-202611-0001 (2.58 against 2.5 per pcs), and PO-202611-0003 already has 2.58, so the price likely moved.',
      'PO-202611-0001 still has 220 pcs of 85123A to receive, 5 days past the promised date 2026-11-13; GRN-202611-0002 rejected 5 pcs.',
      'INV-SUP-22-0031 is not paid: £500.00 is 2 days past its due date of 2026-11-16 (AP-202611-0001).',
      'It started with PR-202611-0001 and RFQ-202611-0001; 280 pcs arrived on GRN-202611-0001 and GRN-202611-0002.',
    ].join(' '),
    records: result.nodes.map((node) => ({ type: node.ref.type, id: node.ref.id })),
  }
  const checked = checkAiModelFirstGrounding({ answer, results: [result], refs, question: 'Why is INV-SUP-22-0049 held?', today: TODAY })
  assert.deepEqual(checked.problems, [])
  assert.ok(checked.checked.record >= 9 && checked.checked.number >= 8 && checked.checked.date >= 2, JSON.stringify(checked.checked))
  // A figure the result does not hold is still caught.
  assert.deepEqual(checkAiModelFirstGrounding({ answer: { answer: 'PO-202611-0001 still has 230 pcs to receive.' }, results: [result], refs, today: TODAY }).problems, [{ kind: 'number', value: '230' }])
})

test('the evidence graph links an RFQ to its request and its order, for the route as for the chain', () => {
  const graph = buildRuntimeEvidenceGraph(workspace(), { entityType: 'rfq', entityId: 'rfq-1' })
  assert.deepEqual(graph.edges.map((edge) => `${edge.fromType}:${edge.from} ${edge.relation} ${edge.toType}:${edge.to}`).sort(), [
    'purchase_order:po-1 sourced_from_pr purchase_request:pr-1',
    'purchase_request:pr-1 converted_to_po purchase_order:po-1',
    'purchase_request:pr-1 sourced_by_rfq rfq:rfq-1',
    'rfq:rfq-1 awarded_to_po purchase_order:po-1',
  ])
  assert.deepEqual(graph.relatedRecords.purchaseOrders.map((row) => row.id), ['po-1'])
  assert.deepEqual(graph.relatedRecords.purchaseRequests.map((row) => row.id), ['pr-1'])
})

test('the tool is offered to assistant v2 alone, to a reader of some chain document, with a short description and the prompt line', () => {
  const [tool] = AI_ASSISTANT_V2_CHAIN_TOOLS
  assert.equal(tool.name, 'trace_document_chain')
  assert.ok(tool.assistantV2Only)
  assert.ok(tool.description.length <= 120, tool.description)
  assert.deepEqual(tool.schema, { type: 'object', properties: { document: { type: 'string' } }, required: ['document'], additionalProperties: false })
  const facts = { today: TODAY }
  const offered = (roleKey) => aiReadToolDefinitions(facts, { context: { actor: actorOf(roleKey), tenantId: T } }).some((entry) => entry.name === 'trace_document_chain')
  assert.ok(offered('workspace-administrator'))
  assert.ok(offered('finance-specialist'))
  assert.ok(!offered('intake-uploader'))
  assert.match(ASSISTANT_V2_SYSTEM, /What happened to a document, why it is stuck or where its linked documents stand: one trace_document_chain call; lead with its openPoints\./)
})

test('the chain is described from the walk alone: no payable or difference read leaves those out and says nothing wrong', () => {
  const access = reportReadAccessFor(actorOf())
  const scoped = scopeBusinessContext(workspace(), access)
  const walk = walkDocumentChain(scoped, { document: 'INV-SUP-22-0049' })
  const result = describeDocumentChain(walk, { business: scoped, access, today: TODAY, now: NOW, timeZone: 'Europe/London', payablesReadable: false })
  assert.deepEqual(result.openPoints[0], { document: 'INV-SUP-22-0049', kind: 'held_at_match', text: 'Held by a match exception' })
  assert.equal(nodeOf(result, 'INV-SUP-22-0031').payable, undefined)
  assert.deepEqual(result.notShown, ['payables'])
  // A read cut at the repository's limit is said.
  const partial = describeDocumentChain(walk, { business: { ...scoped, truncatedSubjects: [{ subject: 'receipts', limit: 500 }] }, access, today: TODAY, now: NOW })
  assert.deepEqual(partial.partial.sources, ['receipts'])
})
