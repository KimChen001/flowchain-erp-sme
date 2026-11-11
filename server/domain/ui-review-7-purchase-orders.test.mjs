import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// UI review round 7, purchase orders: what the PO detail, the PO list, the
// purchasing workbench and the promised dates table read and show. The story
// logic itself is unit-tested in purchase-order-story.test.mjs.

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const page = read('src/modules/purchasing/Page.tsx')
const workbench = read('src/modules/procurement/ProcurementWorkbench.tsx')
const promises = read('src/modules/purchasing/components/PurchaseOrderPromiseDates.tsx')
const actions = read('src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx')

test('finding 1: the PO reads its invoices to the end, with a payment stage and the next action from what is left', () => {
  // The variance state comes from the exceptions (or the server's variance_approved), not the stored match status alone.
  assert.match(page, /invoiceVarianceState\(storyInvoice\(invoice\)\)/)
  assert.match(page, /"差异已批准": "Variance approved"/)
  // Five stages, the fifth the payment.
  assert.match(page, /\{ label: "付款", done: invoiced && payment\.state === "paid", helper: paymentNote \}/)
  // The overview has a Payment field and the next action from nextOpenAction.
  assert.match(page, /label: say\("Payment", "付款"\), value: <StatusChip label=\{paymentStateLabel\(payment\.state, language\)\}/)
  assert.match(page, /return nextOpenAction\(\{/)
  assert.doesNotMatch(page, /nextStepForPo/)
})

test('finding 2: a receipt line is valued at its accepted quantity to the cent, the rejected quantity beside it', () => {
  assert.match(page, /lineAmount: roundCents\(unitPrice \* acceptedQty\)/)
  assert.doesNotMatch(page, /Math\.round\(unitPrice \* receivedQty\)/)
  assert.match(page, /say\(`\(\$\{formatNumber\(row\.rejectedQty\)\} rejected\)`, `（拒收 \$\{formatNumber\(row\.rejectedQty\)\}）`\)/)
})

test('finding 3: an invoice line belongs to a receipt line only when it names it', () => {
  assert.match(page, /invoiceLine\.grnLine && invoiceLine\.grnLine === line\.grnLineId/)
  assert.doesNotMatch(page, /invoiceLine\.poLine === poLine\?\.poLineId\)\)/)
  // The invoice recorded without lines no longer borrows the first receipt's line.
  assert.doesNotMatch(page, /grnsForPo\(po\.po, facts\)\[0\]\?\.lines\?\.\[0\]\?\.grnLineId/)
})

test('finding 4: receipts and invoices show their numbers and statuses as labels, never ids or codes', () => {
  assert.match(page, /const receiptNumberOf = \(grn: ReceivingDoc\) => grn\.documentNumber \|\| grn\.grn/)
  assert.match(page, /poInvoice\(invoice\)\.supplierInvoiceNumber \|\| invoice\.invoiceNumber/)
  assert.match(page, /onClick=\{\(\) => openReceipt\(row\.grn\)\} data-testid="po-receipt-number">\{row\.receiptNumber\}/)
  assert.match(page, /data-testid="po-invoice-number">\{row\.displayNumber\}/)
  assert.match(page, /<StatusChip label=\{codeLabel\(row\.receiptStatus\)\}/)
})

test('finding 5: a rejection shows the reason recorded on the receipt and links to it', () => {
  assert.match(page, /rejectionReason: String\(stored\?\.rejectionReason \?\? ""\)\.trim\(\)/)
  assert.match(page, /row\.rejectionReason \|\| say\("no reason recorded", "未记录原因"\)/)
  assert.doesNotMatch(page, /拒收数量需要采购与财务协同复核/)
})

test('finding 6: late orders are flagged on the PO list and the workbench, which sorts by date and links to the reorder list', () => {
  assert.match(page, /data-testid=\{`po-late-\$\{order\.po\}`\}/)
  assert.match(workbench, /\.\.\.\(daysLate \? \["overdue"\] : \[\]\)/)
  assert.match(workbench, /late: \["\{n\} days late", "逾期 \{n\} 天"\]/)
  // A late order is not an invoice or match issue.
  assert.match(workbench, /ISSUE_SIGNALS = new Set\(\["invoice_variance", "match_exception"\]\)/)
  assert.match(workbench, /\|\| byDate\(left, right\)\)/)
  assert.match(workbench, /to="\/app\/inventory\/reorder"/)
  assert.match(workbench, /apiJson<[^>]+>\("\/api\/inventory\/reorder-list"\)/)
})

test('finding 7: the PO list row menu offers Receive and Record supplier invoice by the detail page rules', () => {
  assert.match(actions, /export function usePurchaseOrderEntryRules\(\)/)
  assert.match(actions, /const rules = usePurchaseOrderEntryRules\(\);\n  const navigate = useNavigate\(\);\n  if \(!rules\.canReceive\(status\)\) return null;/)
  assert.match(page, /entryRules\.canReceive\(order\.status\) && <button type="button" data-testid=\{`po-row-receive-\$\{order\.po\}`\}/)
  assert.match(page, /entryRules\.canRecordBill\(order\.status\) && <button type="button" data-testid=\{`po-row-record-bill-\$\{order\.po\}`\}/)
})

test('finding 8: the promised dates table turns into phone cards with a full-size change button', () => {
  assert.match(promises, /ref=\{listTableCardsRef\}/)
  assert.match(promises, /data-card-title/)
  assert.match(promises, /className="inline-flex h-8 items-center/)
})

test('finding 9: one name per state and action, and Chinese labels without PO / PR abbreviations', () => {
  assert.match(actions, /issue: \["Mark as issued", "标记为已下达"\]/)
  assert.match(page, /"Send the PO to the supplier, then mark it issued", "将采购订单发给供应商，然后标记为已下达"/)
  assert.match(page, /if \(ordered > 0 && received >= ordered\) return "全部收货";\n  if \(received > 0\) return "部分收货";\n  return "未收货";/)
  for (const label of ['"PO 明细行"', '"单行"', '"来源 PR"', '"当前 PO 暂无收货记录。"', '"PO 编号"', 'say("Awaiting receipt"']) {
    assert.ok(!page.includes(label), label)
  }
  assert.match(page, /say\("PO line items", "采购订单明细行"\)/)
  assert.match(page, /say\("Source PR", "来源采购申请"\)/)
})
