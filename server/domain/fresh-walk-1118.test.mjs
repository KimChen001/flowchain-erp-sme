import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildProcurementThreeWayMatches } from './procurement-read-model.mjs'

// The fresh-eyes walkthrough of main 90e76f57 (2026-11-18): P2P and O2C in
// English and Chinese on one local instance, then the reorder list, Today,
// finance, reports, supplier evaluation and shipments. What it found and fixed.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

const invoice = (overrides) => ({
  id: 'INV-1', invoiceNumber: 'INV-1', supplier: 'Supplier', relatedPo: 'PO-1', relatedGrn: 'GRN-1',
  amount: 1524, currency: 'USD', varianceAmount: 18.6, workflowStatus: 'matched', ...overrides,
})

test('a match inside the tolerance carries its small variance but asks no one to review it', () => {
  const data = (rows) => ({ purchaseOrders: [{ po: 'PO-1', supplier: 'Supplier', amount: 1505.4, currency: 'USD' }], receivingDocs: [], supplierInvoices: rows })
  // Matched within ±2% / 1 unit since design audit B2: the list read "PO and
  // invoice amounts differ; review" under an auto-matched invoice.
  for (const matchStatus of ['auto_matched', 'matched', '自动匹配', '已匹配']) {
    const [row] = buildProcurementThreeWayMatches(data([invoice({ matchStatus, status: matchStatus })]))
    assert.equal(row.varianceAmount, 18.6, `${matchStatus}: the variance stays on record`)
    assert.equal(row.blockingReason, '', matchStatus)
    assert.equal(row.exceptionReason, '', matchStatus)
  }
  // An exception still asks for the review.
  const [held] = buildProcurementThreeWayMatches(data([invoice({ matchStatus: 'exception', status: 'exception', workflowStatus: 'exception' })]))
  assert.match(held.blockingReason, /需复核/)
})

test('unit prices show to 4 decimals when they have them, so quantity × price is the amount', () => {
  // "120 boxes × $12.55" beside an amount of $1,505.40 (12.545 a box).
  assert.match(read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx'), /formatUnitPrice\(Number\(line\.estimatedUnitPrice\), line\.currency \|\| selected\.defaultCurrency, locale\)/)
  assert.match(read('src/modules/purchasing/Page.tsx'), /<td className=\{tdNumericRightClass\}>\{formatUnitPrice\(line\.unitPrice, line\.currency \|\| currency, locale\)\}<\/td>/)
  // The reorder list's order-up-to level is an estimate: one decimal, like daily demand ("340.3108 pcs").
  assert.match(read('src/modules/inventory/ReorderListPage.tsx'), /level: withUnit\(oneDecimal\(row\.orderUpTo\.level\), row\.unit, t\.language\)/)
})

test('a purchase order made from a request has its own history from the start', () => {
  const service = read('server/services/procurement-request-command-service.mjs')
  assert.match(service, /action: "purchase_order_created_from_pr", entityType: "PurchaseOrder", entityId: poId/)
  assert.match(service, /if \(approvedWithRequest\) await tx\.auditLog\.create\(\{ data: \{ [^\n]*action: "purchase_order_approved_with_request", entityType: "PurchaseOrder", entityId: poId/)
  assert.match(read('src/components/ui/index.tsx'), /purchase_order_approved_with_request: \["Approved with its purchase request", "随采购申请一并批准"\]/)
})

test('a profile change names its version, and keeps a name it does not send', () => {
  const route = read('server/routes/pilot-workspace.routes.mjs')
  // Without a version the update reached the database as NaN and answered 500.
  assert.match(route, /fail\('VERSION_REQUIRED', 'Send the profile version you are changing\.', 422\)/)
  assert.match(route, /name: Object\.hasOwn\(body, 'name'\) \? text\(body\.name\) : actor\.user\.name/)
  assert.match(route, /jobTitle: Object\.hasOwn\(body, 'jobTitle'\) \? text\(body\.jobTitle\) \|\| null : actor\.user\.jobTitle/)
})
