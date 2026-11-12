import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildProcurementFollowups,
  buildProcurementSummary,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
  settledMatchStatus,
} from './procurement-read-model.mjs'
import { acceptedAroundByPoLine, receiptLineProgress } from './receiving-workbench-query-service.mjs'
import { receivingDecimalString, receivingDecimalUnits } from './receiving-transaction-policy.mjs'

// UI review round 7b, purchasing: what a re-walk of the purchase-to-pay flow
// found on the PO, the match, the receipt, the request and the workbench.

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

// The English walk's INV-UI7-B002 and the Chinese walk's S21-7781: a price
// variance approved before the server stored "variance_approved", then the
// invoice approved. The stored match status still says exception.
const decidedBeforeRound7 = {
  id: 'INV-B002', invoiceNumber: 'INV-B002', supplierInvoiceNumber: 'INV-UI7-B002', supplier: 'Supplier', relatedPo: 'PO-1', relatedGrn: 'GRN-1',
  amount: 29.4, currency: 'USD', varianceAmount: 1.96, matchStatus: 'exception', status: '存在差异',
  workflowStatus: 'approved', matchExceptions: { count: 2, open: 0, approved: 2, rejected: 0 },
}
const openVariance = { ...decidedBeforeRound7, id: 'INV-OPEN', invoiceNumber: 'INV-OPEN', supplierInvoiceNumber: 'INV-OPEN', workflowStatus: 'exception', matchExceptions: { count: 2, open: 1, approved: 1, rejected: 0 } }

test('finding 3: a variance already decided reads variance_approved at read time, from the invoice status or its exceptions', () => {
  // Approved (or later) invoice: its differences were accepted.
  assert.equal(settledMatchStatus(decidedBeforeRound7, 1.96), 'variance_approved')
  for (const workflowStatus of ['approved', 'held', 'paid', 'settled']) {
    assert.equal(settledMatchStatus({ matchStatus: 'exception', workflowStatus }, 1.96), 'variance_approved', workflowStatus)
  }
  // Every exception approved, the invoice not approved yet: settled too.
  assert.equal(settledMatchStatus({ matchStatus: '差异待处理', workflowStatus: 'exception', matchExceptions: { count: 1, open: 0, approved: 1, rejected: 0 } }, 2), 'variance_approved')
  assert.equal(settledMatchStatus({ matchStatus: 'exception', matchExceptions: [{ status: 'approved' }, { status: 'approved' }] }, 2), 'variance_approved')
  // Still open, rejected, or nothing decided: as stored.
  assert.equal(settledMatchStatus(openVariance, 1.96), 'exception')
  assert.equal(settledMatchStatus({ matchStatus: 'exception', workflowStatus: 'exception', matchExceptions: { count: 1, open: 0, approved: 0, rejected: 1 } }, 2), 'exception')
  assert.equal(settledMatchStatus({ matchStatus: 'exception', workflowStatus: 'submitted' }, 2), 'exception')
  assert.equal(settledMatchStatus({ matchStatus: 'exception', workflowStatus: 'cancelled' }, 2), 'exception')
  // No variance: an approved invoice keeps its matched status.
  assert.equal(settledMatchStatus({ matchStatus: '自动匹配', workflowStatus: 'approved' }, 0), '自动匹配')
  assert.equal(settledMatchStatus({ matchStatus: 'matched', workflowStatus: 'approved' }, 0), 'matched')
  // The stored word stays the stored word.
  assert.equal(settledMatchStatus({ matchStatus: 'variance_approved' }, 2), 'variance_approved')
})

test('finding 3: the match list, its counters, follow-ups and the summary no longer count a decided variance', () => {
  const data = { purchaseOrders: [{ po: 'PO-1', supplier: 'Supplier', amount: 49, currency: 'USD' }], receivingDocs: [], supplierInvoices: [decidedBeforeRound7, openVariance] }
  const invoices = buildProcurementSupplierInvoices(data)
  assert.deepEqual(invoices.map((invoice) => invoice.matchStatus), ['variance_approved', 'exception'])
  const [decided, open] = buildProcurementThreeWayMatches(data)
  assert.equal(decided.matchStatus, 'variance_approved')
  assert.equal(decided.varianceAmount, 1.96, 'the variance stays on record')
  assert.equal(decided.blockingReason, '')
  assert.equal(decided.exceptionReason, '')
  assert.equal(open.matchStatus, 'exception')
  assert.notEqual(open.blockingReason, '')
  assert.deepEqual(buildProcurementFollowups(data).map((item) => item.documentId), ['INV-OPEN'])
  const summary = buildProcurementSummary(data)
  assert.equal(summary.invoiceExceptionCount, 1)
  assert.equal(summary.threeWayMatchExceptionCount, 1)
})

test('finding 3: every read of a supplier invoice carries its workflow status and decided exceptions', () => {
  const repository = read('server/repositories/db-procurement-read-repository.mjs')
  assert.match(repository, /const INVOICE_DOCUMENT_INCLUDE = Object\.freeze\(\{ lines: true, matchExceptions: \{ select: \{ status: true \} \} \}\)/)
  assert.match(repository, /return \{ \.\.\.mapSupplierInvoice\(record\), workflowStatus: text\(record\.status\), matchExceptions: matchExceptionCounts\(record\) \}/)
  // The snapshot (lists), the invoice and the match reads.
  assert.equal((repository.match(/include: INVOICE_DOCUMENT_INCLUDE/g) || []).length, 3)
  assert.match(repository, /supplierInvoices: \[mapInvoiceWithDecisions\(invoice\)\]/)
})

const units = (value) => receivingDecimalUnits(String(value))
const quantities = (result) => ({ previous: receivingDecimalString(result.previous), remaining: receivingDecimalString(result.remaining) })

test('finding 5: received before counts only the receipts posted before this one, and open is as of then', () => {
  // The Chinese walk's PO: 110 ordered; GRN-0011 posted first (70), GRN-0012 later (40).
  const first = { id: 'GRN-0011', poId: 'PO-1', postingStatus: 'posted', postedAt: '2026-11-11T10:00:00Z', createdAt: '2026-11-11T09:50:00Z', lines: [{ purchaseOrderLineId: 'POL-1', acceptedQty: '70' }] }
  const second = { id: 'GRN-0012', poId: 'PO-1', postingStatus: 'posted', postedAt: '2026-11-11T11:00:00Z', createdAt: '2026-11-11T10:55:00Z', lines: [{ purchaseOrderLineId: 'POL-1', acceptedQty: '40' }] }
  const reversed = { id: 'GRN-R', poId: 'PO-1', postingStatus: 'reversed', postedAt: '2026-11-11T09:00:00Z', lines: [{ purchaseOrderLineId: 'POL-1', acceptedQty: '5' }] }
  const otherOrder = { ...second, id: 'GRN-X', poId: 'PO-2' }
  const around = acceptedAroundByPoLine(first, [second, reversed, otherOrder, first])
  assert.equal(around.before.get('POL-1'), undefined)
  assert.equal(receivingDecimalString(around.after.get('POL-1')), '40.0000')
  // GRN-0011: nothing before it, 40 still open after it (not today's 0).
  const firstLine = receiptLineProgress({ posted: true, ordered: units(110), currentReceived: units(110), acceptedBefore: around.before.get('POL-1'), acceptedAfter: around.after.get('POL-1'), documentAccepted: units(70) })
  assert.deepEqual(quantities(firstLine), { previous: '0.0000', remaining: '40.0000' })
  // GRN-0012: GRN-0011's 70 before it, nothing open after.
  const later = acceptedAroundByPoLine(second, [first, second])
  const secondLine = receiptLineProgress({ posted: true, ordered: units(110), currentReceived: units(110), acceptedBefore: later.before.get('POL-1'), acceptedAfter: later.after.get('POL-1'), documentAccepted: units(40) })
  assert.deepEqual(quantities(secondLine), { previous: '70.0000', remaining: '0.0000' })
  // A received quantity no receipt accounts for (an older record) counts as before.
  assert.deepEqual(quantities(receiptLineProgress({ posted: true, ordered: units(110), currentReceived: units(80), documentAccepted: units(70) })), { previous: '10.0000', remaining: '30.0000' })
  // Not posted (or reversed): everything posted so far, and what is open now.
  assert.deepEqual(quantities(receiptLineProgress({ posted: false, ordered: units(110), currentReceived: units(70), documentAccepted: units(40) })), { previous: '70.0000', remaining: '40.0000' })
  // Same posting time: creation time, then id, decide; never both before the other.
  const twinA = { ...first, id: 'A', postedAt: second.postedAt, createdAt: second.createdAt }
  const twinB = { ...second, id: 'B' }
  assert.equal(acceptedAroundByPoLine(twinA, [twinB]).before.size + acceptedAroundByPoLine(twinB, [twinA]).before.size, 1)
  // The detail reads the order's other posted receipts only for a posted receipt.
  const service = read('server/domain/receiving-workbench-query-service.mjs')
  assert.match(service, /if \(grn\.postingStatus !== 'posted' \|\| !grn\.poId\) return \[\]/)
  assert.match(service, /where: \{ tenantId, poId: grn\.poId, postingStatus: 'posted', id: \{ not: grn\.id \} \}/)
})

test('finding 1, 4, 6, 7, 11: the PO says paid of the whole order, offers no invoice entry when all is invoiced, and fits a phone', () => {
  const page = read('src/modules/purchasing/Page.tsx')
  const actions = read('src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx')
  // 1: the payment stage knows the order's amount and what is not invoiced.
  assert.match(page, /return paymentSummary\(invoices\.map\(storyInvoice\), \{ ordered: poAmount\(po\), notInvoiced: notInvoicedOnPo\(po, facts\) \}\)/)
  assert.match(page, /paymentAmountsText\(payment, words, \{ brief: true \}\)/)
  // 4: hidden in the header, the row menu and the action notes once every line is invoiced.
  assert.match(page, /BILLABLE_PO_STATUSES\.has\(selectedPO\.status\) && !selectedPOFullyInvoiced && <span/)
  assert.match(page, /entryRules\.canRecordBill\(order\.status\) && !fullyInvoiced\(order, facts\) && <button/)
  assert.match(page, /nothingToInvoice: selectedPOFullyInvoiced/)
  assert.match(actions, /if \(rules\.canRecordBill\(status\) && !nothingToInvoice\) notes\.push\(tr\("billNote"\)\)/)
  // 6: the invoice step's label fits one line on a phone.
  assert.match(page, /\{ label: "开票", done: invoiced, warning: invoice === "发票差异", helper: invoice \}/)
  assert.match(page, /"开票": "Invoice"/)
  assert.doesNotMatch(page, /label: "供应商开票"/)
  // 7: related links, receipt and invoice numbers are 36 px tall on a phone.
  assert.match(page, /const relatedLinkClass = `[^`]*max-sm:min-h-9`/)
  assert.match(page, /const evidenceLinkClass = "max-sm:inline-flex max-sm:min-h-9 max-sm:items-center"/)
  assert.equal((page.match(/\$\{evidenceLinkClass\}/g) || []).length, 3)
  // 11: the full-width colon in Chinese.
  assert.match(page, /say\("QC: ", "质检："\)/)
  assert.doesNotMatch(page, /say\("QC", "质检"\)\}:/)
})

test('finding 8: posting, submitting and issuing say what was done, by number, and a part receipt offers the rest', () => {
  const actions = read('src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx')
  const page = read('src/modules/purchasing/Page.tsx')
  const receipt = read('src/modules/receiving/ReceivingPostingWorkbench.tsx')
  const form = read('src/modules/procurement/ReceivingForm.tsx')
  assert.match(actions, /doneIssue: \["Issued \{po\}", "已下达 \{po\}"\]/)
  assert.match(page, /<PurchaseOrderWorkflowActions poId=\{selectedPO\.po\} number=\{selectedPONumber\}/)
  assert.match(receipt, /posted: \["Posted \{doc\}", "已过账 \{doc\}"\]/)
  assert.match(receipt, /receiveRest: \["Receive the rest", "收货剩余"\]/)
  assert.match(receipt, /toast\.success\(message, \{ action: \{ label: draftCopy\("receiveRest"\), onClick: \(\) => navigate\(receiveRestPath\(next\)\) \} \}\)/)
  assert.match(receipt, /data-testid="receiving-receive-rest"/)
  assert.match(receipt, /next\.purchaseOrder\.fulfillmentStatus === "partially_received"/)
  // The timeline says submitted, as the form's Save and submit does.
  assert.match(receipt, /receiving_submitted: \["Receipt \{doc\} submitted", "收货单 \{doc\} 已提交"\]/)
  assert.doesNotMatch(receipt, /已提交过账"/)
  assert.match(form, /doneSubmit: \["Submitted \{doc\}", "已提交 \{doc\}"\]/)
})

test('finding 2: a match whose differences were approved says so, with no link to resolve it', () => {
  const detail = read('src/modules/procurement/ProcurementDocumentDetailPage.tsx')
  const list = read('src/modules/procurement/ThreeWayMatchListPage.tsx')
  assert.match(detail, /const varianceApproved = \[status, match\?\.matchStatus, record\?\.matchStatus\]\.includes\("variance_approved"\)/)
  assert.match(detail, /const blockingReason = varianceApproved \? "" :/)
  assert.match(detail, /"Differences approved on \{invoice\}\.": "差异已在 \{invoice\} 上批准。"/)
  assert.match(detail, /data-testid="three-way-match-variance-approved"/)
  // The Matched tile says it counts approved differences too.
  assert.match(list, /matchedNote: \["Amounts agree, or differences approved", "金额一致，或差异已批准"\]/)
})

test('findings 9 and 10: the request note wraps on a phone, its unit reads in words, and the workbench loads the reorder list last', () => {
  const panel = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  const workbench = read('src/modules/procurement/ProcurementWorkbench.tsx')
  assert.match(panel, /className="line-clamp-2 max-sm:line-clamp-none max-sm:whitespace-normal max-sm:break-words" title=\{line\.internalLineComment\} data-testid="pr-detail-line-note"/)
  assert.match(panel, /value=\{line\.unitSnapshot \? unitLabel\(line\.unitSnapshot, language\) : ""\} data-testid="pr-line-unit"/)
  assert.match(workbench, /reorderNote: \["\{now\} to order now · \{n\} items checked", "需立即下单 \{now\} 项 · 已检查 \{n\} 项"\]/)
  // The reorder list is asked for only after the queue's three lists.
  const load = workbench.slice(workbench.indexOf('const load = async'), workbench.indexOf('useEffect(() => { void load(); }'))
  assert.ok(load.indexOf('procurementApi.listDocuments("invoice")') < load.indexOf('window.setTimeout(loadReorder, 0)'))
  assert.doesNotMatch(load, /reorder-list/)
})
