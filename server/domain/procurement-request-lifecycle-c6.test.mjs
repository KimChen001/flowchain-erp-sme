import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROCUREMENT_STATUS_TRANSITIONS } from './procurement-status-authority.mjs'
import { ENDED_PURCHASE_ORDER_STATUSES, purchaseOrderPlan } from '../services/procurement-request-command-service.mjs'

// Design audit batch C6 (2026-11-17): the purchase request and PO lifecycle.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

const line = (index, { amount = '10.0000', quantity = '1.0000', unitPrice = '10.0000', supplierId = 'SUP-A', currency = 'USD', warehouse = 'WH-1' } = {}) => ({
  id: `L${index}`, amount, quantity, unitPrice, metadata: { supplierId, currency, targetWarehouseId: warehouse, supplierSnapshot: { supplierName: supplierId } },
})
const suppliers = (statuses) => ({ supplier: { findMany: async ({ where }) => where.id.in.filter((id) => statuses[id] !== undefined).map((id) => ({ id, status: statuses[id] })) } })

test('a rejected request can go back to draft, and a converted one back to approved (L1-16, L1-09)', () => {
  const pr = PROCUREMENT_STATUS_TRANSITIONS.purchaseRequest
  assert.deepEqual(pr.rejected, ['draft'])
  assert.deepEqual(pr.converted, ['approved'])
  assert.deepEqual(pr.cancelled, [])
  // A rejected PO is not revised here: that is OC8, in December.
  assert.deepEqual(PROCUREMENT_STATUS_TRANSITIONS.purchaseOrderWorkflow.rejected, ['draft'])
  const service = read('server/services/procurement-request-command-service.mjs')
  assert.match(service, /reopen: PURCHASE_REQUEST_STATUS\.DRAFT,/)
  assert.match(service, /reopen: \[PURCHASE_REQUEST_STATUS\.REJECTED\],/)
  assert.match(service, /withdraw: \[PURCHASE_REQUEST_STATUS\.SUBMITTED, PURCHASE_REQUEST_STATUS\.APPROVED\],/)
  assert.match(read('server/routes/procurement-workflow.routes.mjs'), /\(submit\|approve\|reject\|withdraw\|reopen\|cancel\)\$/)
})

test('cancelling a submitted or approved request needs a reason; a draft is its author\'s own (L1-16)', () => {
  const service = read('server/services/procurement-request-command-service.mjs')
  assert.match(service, /if \(action === "cancel" && row\.status !== PURCHASE_REQUEST_STATUS\.DRAFT && !reason\) fail\("CANCEL_REASON_REQUIRED"/)
})

test('a rejected PO no longer counts as the request\'s live order (L1-09 with its downstream check)', () => {
  assert.deepEqual([...ENDED_PURCHASE_ORDER_STATUSES], ['cancelled', 'rejected'])
  const service = read('server/services/procurement-request-command-service.mjs')
  assert.match(service, /status: \{ notIn: \[\.\.\.ENDED_PURCHASE_ORDER_STATUSES\] \}/)
  const po = read('server/domain/procurement-db-command-service.mjs')
  assert.match(po, /const restoredRequest = action === "cancel" \|\| action === "reject" \? await restoreRequestDemand\(tx, actor, row, action, text\(input\.reason\)\) : null;/)
  assert.match(po, /status: \{ notIn: \[CANCELLED, PURCHASE_ORDER_STATUS\.REJECTED\] \}/)
  assert.match(po, /if \(!request \|\| request\.status !== PURCHASE_REQUEST_STATUS\.CONVERTED\) return null;/)
  assert.match(po, /action: "purchase_request_demand_restored", entityType: "PurchaseRequest"/)
})

test('the conversion plan groups lines into orders and refuses unpriced lines and inactive suppliers (L1-03, L1-28, L1-26)', async () => {
  const row = { lines: [line(0), line(1), line(2, { supplierId: 'SUP-B' }), line(3, { warehouse: 'WH-2' })] }
  const plan = await purchaseOrderPlan(suppliers({ 'SUP-A': 'active', 'SUP-B': 'Active' }), 'T', row)
  assert.deepEqual(plan.issues, [])
  assert.deepEqual([...plan.groups.values()].map((group) => [group.supplierId, group.warehouseId, group.lines.length]), [['SUP-A', 'WH-1', 2], ['SUP-B', 'WH-1', 1], ['SUP-A', 'WH-2', 1]])

  // A price of 0 on a quantity line, and an amount line at 0.
  const unpriced = await purchaseOrderPlan(suppliers({ 'SUP-A': 'active' }), 'T', { lines: [line(0), line(1, { amount: '0.0000', unitPrice: '0.0000' }), line(2, { amount: '0', quantity: null, unitPrice: null })] })
  assert.deepEqual(unpriced.issues.map((issue) => [issue.code, issue.details.map((detail) => detail.field)]), [['PURCHASE_REQUEST_LINE_UNPRICED', ['lines.1.estimatedUnitPrice', 'lines.2.estimatedAmount']]])

  // A draft or inactive supplier, or one that is gone.
  const inactive = await purchaseOrderPlan(suppliers({ 'SUP-A': 'draft', 'SUP-B': 'inactive' }), 'T', { lines: [line(0), line(1, { supplierId: 'SUP-B' }), line(2, { supplierId: 'SUP-GONE' })] })
  assert.deepEqual(inactive.issues.map((issue) => [issue.code, issue.details.map((detail) => [detail.field, detail.supplierStatus])]), [['SUPPLIER_NOT_ACTIVE', [['lines.0.supplierId', 'draft'], ['lines.1.supplierId', 'inactive'], ['lines.2.supplierId', null]]]])

  // A line without a warehouse comes first, as before.
  const missing = await purchaseOrderPlan(suppliers({ 'SUP-A': 'active' }), 'T', { lines: [line(0, { warehouse: '' })] })
  assert.equal(missing.issues[0].code, 'DIRECT_PO_NOT_ALLOWED')
})

test('a PO is issued only to an active supplier (L1-28)', () => {
  const po = read('server/domain/procurement-db-command-service.mjs')
  assert.match(po, /if \(action === "issue"\) \{\n\s+const supplier = row\.supplierId \? await tx\.supplier\.findFirst/)
  assert.match(po, /fail\("SUPPLIER_NOT_ACTIVE", "This purchase order's supplier is not active\./)
})

test('the request page cancels with a reason, revises a rejected request and shows the orders before creating them (L1-16, L1-26)', () => {
  const panel = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.match(panel, /draft: \["edit", "submit", "cancel"\],\n\s+submitted: \["approve", "reject", "withdraw", "cancel"\],\n\s+approved: \["generate-purchase-orders", "cancel"\],\n\s+rejected: \["reopen"\],/)
  assert.match(panel, /if \(\(action === "reject" \|\| action === "cancel"\) && !reason\) return;/)
  assert.match(panel, /if \(action === "generate-purchase-orders" && !\(await confirmConversion\(pr\)\)\) return;/)
  assert.match(panel, /\/api\/procurement\/requests\/\$\{encodeURIComponent\(pr\.id\)\}\/purchase-order-preview/)
  assert.match(panel, /data-testid="pr-convert-order"/)
  assert.match(read('server/routes/procurement-workflow.routes.mjs'), /purchase-order-preview\$/)
  // Each new code has a sentence in both languages.
  const errors = read('src/modules/procurement/procurementErrors.ts')
  for (const code of ['CANCEL_REASON_REQUIRED', 'PURCHASE_REQUEST_LINE_UNPRICED', 'SUPPLIER_NOT_ACTIVE']) assert.match(errors, new RegExp(`  ${code}: \\["[^"]+", "[^"]+"\\],`), code)
  // The assistant's request card asks why too.
  const card = read('src/modules/ai-assistant/v2/parts/PurchaseRequestFormPart.tsx')
  assert.match(card, /data-testid="ai-v2-pr-cancel-reason"/)
  assert.match(card, /void transition\("cancel", cancelReason\.trim\(\)\)/)
})

test('a new request has no need-by date of today; a line\'s date comes from its supplier\'s lead time (L7-09)', () => {
  const panel = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.match(panel, /\[defaultDate, setDefaultDate\] = useState\(""\),/)
  assert.match(panel, /const makeLine = \(date = ""\): Line => \(\{/)
  assert.doesNotMatch(panel, /untouchedDefault/)
  // The form's first line starts without a date too.
  assert.match(panel, /\[lines, setLines\] = useState<Line\[\]>\(\(\) => \[makeLine\(\)\]\),/)
  assert.doesNotMatch(panel, /makeLine\(today\(/)
  // The lead time still sets a line still on the (empty) default.
  assert.match(panel, /i === index && line\.needByDate === defaultDate && !keepsUserDate\(line\) \? \{ \.\.\.line, needByDate: leadDate \}/)
})

test('a rejected PO says what can be done, not "revise it" (L1-09)', () => {
  const page = read('src/modules/purchasing/Page.tsx')
  assert.doesNotMatch(page, /revise it and submit again/)
  assert.match(page, /if \(code === "rejected"\) return \{ kind: "rejected", fromRequest: Boolean\(po\.sourceRequest\) \};/)
})
