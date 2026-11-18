import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APPROVAL_KINDS, approvalAuthorIds, approverStanding, mayApprove } from './self-approval.mjs'
import { withCanApprove, withCanApproveOne } from './approval-rights.mjs'
import { buildTodayWork, rowForApprover } from './today-work.mjs'
import { mapPurchaseOrder, mapPurchaseRequest } from '../repositories/db-procurement-read-repository.mjs'

// Design audit C4 follow-up (2026-11-18 walkthrough, PR #378): a request's
// requester still met an Approve button that the server then refused. Every
// read of a purchase request, purchase order, supplier invoice, customer
// invoice and return now says whether the reader may approve it now
// (canApprove), by the same rule and the same authors as the approval
// command; pages, the phone, Today and the assistant's card offer Approve and
// Reject only then.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const counting = (others) => ({ user: { count: async () => others } })
const everyPermission = () => true

test('each approval reads its document\'s authors from one table, as its command does', () => {
  assert.deepEqual(Object.keys(APPROVAL_KINDS).sort(), ['customer_invoice', 'purchase_order', 'purchase_request', 'return_authorization', 'supplier_invoice'])
  const submitted = { action: 'submit', actorId: 'U3' }
  assert.deepEqual(approvalAuthorIds('purchase_request', { requester: 'U1', metadata: { requesterId: 'U1', timeline: [{ action: 'create', actorId: 'U9' }, submitted] } }), ['U1', 'U3'])
  assert.deepEqual(approvalAuthorIds('purchase_order', { metadata: { createdBy: 'U2', approvalTimeline: [submitted] } }), ['U2', 'U3'])
  assert.deepEqual(approvalAuthorIds('supplier_invoice', { submittedById: 'U4' }), ['U4'])
  assert.deepEqual(approvalAuthorIds('customer_invoice', { submittedById: null }), [])
  assert.deepEqual(approvalAuthorIds('return_authorization', { requestedById: 'U5', submittedById: 'U5' }), ['U5'])
  // The five commands take their authors from it.
  for (const [file, kind] of [
    ['server/services/procurement-request-command-service.mjs', 'purchase_request'],
    ['server/domain/procurement-db-command-service.mjs', 'purchase_order'],
    ['server/domain/operational-finance-command-service.mjs', 'supplier_invoice'],
    ['server/domain/operational-finance-o2c-command-service.mjs', 'customer_invoice'],
    ['server/domain/return-governance-command-service.mjs', 'return_authorization'],
  ]) assert.match(read(file), new RegExp(`authorIds: approvalAuthorIds\\("${kind}", (row|current|invoice)\\)`), file)
})

test('a reader may approve what they hold the permission for, and their own only as the sole approver', async () => {
  const actor = { tenantId: 'T1', user: { id: 'U1' } }
  const shared = await approverStanding(counting(2), actor, everyPermission, ['purchase_request'])
  assert.deepEqual([[...shared.held], [...shared.sole]], [['procurement.purchase_request.approve'], []])
  assert.equal(mayApprove(shared, 'purchase_request', ['U2']), true)
  assert.equal(mayApprove(shared, 'purchase_request', ['U1', 'U2']), false)
  // Only kinds asked for are counted, and only permissions held.
  assert.equal(mayApprove(shared, 'purchase_order', ['U2']), false)
  const sole = await approverStanding(counting(0), actor, everyPermission, ['purchase_request'])
  assert.equal(mayApprove(sole, 'purchase_request', ['U1']), true)
  const none = await approverStanding(counting(0), actor, () => false)
  assert.equal(mayApprove(none, 'purchase_request', ['U2']), false)
  assert.equal(mayApprove(null, 'purchase_request', []), false)
  // A count that cannot be read counts as someone else.
  const unread = await approverStanding({ user: { count: async () => { throw new Error('down') } } }, actor, everyPermission, ['purchase_request'])
  assert.equal(mayApprove(unread, 'purchase_request', ['U1']), false)
})

test('request and order reads carry canApprove and not the author ids', async () => {
  const request = mapPurchaseRequest({ id: 'PR-1', number: 'PR-1', status: 'submitted', requester: 'U1', metadata: { requesterId: 'U1', timeline: [{ action: 'submit', actorId: 'U1' }] }, lines: [] })
  assert.deepEqual(request.approvalAuthorIds, ['U1'])
  const order = mapPurchaseOrder({ id: 'PO-1', number: 'PO-1', status: 'pending_approval', version: 1, metadata: { createdBy: 'U2' }, lines: [] })
  assert.deepEqual(order.approvalAuthorIds, ['U2'])
  const standing = await approverStanding(counting(1), { tenantId: 'T1', user: { id: 'U1' } }, everyPermission)
  const [own, other, draft] = withCanApprove([request, { ...request, id: 'PR-2', approvalAuthorIds: ['U2'] }, { ...request, id: 'PR-3', status: 'draft', approvalAuthorIds: ['U2'] }], 'purchase_request', standing)
  assert.deepEqual([own.canApprove, other.canApprove, draft.canApprove], [false, true, false])
  assert.ok(!('approvalAuthorIds' in own))
  assert.equal(withCanApproveOne(order, 'purchase_order', standing).canApprove, true)
  assert.equal(withCanApproveOne({ ...order, status: 'approved' }, 'purchase_order', standing).canApprove, false)
  assert.equal(withCanApproveOne(order, 'purchase_order', null).canApprove, false)
  // Every route that lists or opens requests and orders says it.
  const workflow = read('server/routes/procurement-workflow.routes.mjs')
  assert.match(workflow, /kind \? withCanApprove\(rows, kind, await readerApprovalStanding\(ctx, \[kind\]\)\) : rows/)
  assert.match(workflow, /withCanApproveOne\(maskProcurementRecord\(await requestCommands\(ctx\)\.readPurchaseRequest/)
  const orders = read('server/routes/purchase-orders.routes.mjs')
  assert.equal(orders.match(/withCanApprove(One)?\(snapshot\.purchaseOrders(\[0\])?, 'purchase_order', await readerApprovalStanding\(ctx, \['purchase_order'\]\)\)/g)?.length, 3)
})

test('the invoice, return and phone reads offer Approve only to who may give it', () => {
  const supplier = read('server/domain/operational-finance-read-service.mjs')
  assert.match(supplier, /\(!standing \|\| mayApprove\(standing, "supplier_invoice", approvalAuthorIds\("supplier_invoice", row\)\)\)\n    \)\n      values\.push\("approve"\);/)
  assert.match(supplier, /return \{ \.\.\.summary, canApprove: summary\.availableActions\.includes\("approve"\) \};/)
  assert.equal(supplier.match(/await approvalStanding\(current\)/g)?.length, 2)
  const customer = read('server/domain/operational-finance-o2c-read-service.mjs')
  assert.match(customer, /row\.status === "submitted" && \(!standing \|\| mayApprove\(standing, "customer_invoice", approvalAuthorIds\("customer_invoice", row\)\)\)\) actions\.push\("approve"\);/)
  assert.equal(customer.match(/await approvalStanding\(current\)/g)?.length, 3)
  const returns = read('server/domain/return-governance-read-service.mjs')
  assert.match(returns, /authorIds: approvalAuthorIds\("return_authorization", request\),\n\s+permissionCode: "returns\.authorization\.approve",\n\s+warehouseIds: warehouseIds\(request\.lines\),/)
  assert.match(returns, /selfBlocked \? \{ \.\.\.actions, authorize: false, reject: false \} : actions/)
  assert.match(returns, /canApprove: availableActions\.authorize === true,/)
  const mobile = read('server/domain/mobile-operations-service.mjs')
  assert.match(mobile, /mayApprovePo\(standing, po\) \? \["approve", "reject", "return_for_revision"\] : \[\]/)
  assert.match(mobile, /availableActions: canApprove && actor\.permissionCodes\.has\("mobile\.procurement\.approval\.execute"\)/)
})

test('Today\'s order and bill approval rows skip their own authors too', () => {
  const approver = (codes, sole = []) => ({ userId: 'U1', permissionCodes: new Set(codes), soleApprover: new Set(sole) })
  const orderPermission = 'procurement.purchase_order.approve'
  const billPermission = 'finance.supplier_invoice.approve'
  const authors = (id) => (id.endsWith('-1') ? ['U1'] : ['U2'])
  assert.equal(rowForApprover({ kind: 'purchase_order_to_approve', recordId: 'PO-1' }, approver([orderPermission]), authors), false)
  assert.equal(rowForApprover({ kind: 'purchase_order_to_approve', recordId: 'PO-1' }, approver([orderPermission], [orderPermission]), authors), true)
  assert.equal(rowForApprover({ kind: 'bill_to_approve', recordId: 'B-1' }, approver([billPermission]), authors), false)
  assert.equal(rowForApprover({ kind: 'bill_to_approve', recordId: 'B-2' }, approver([billPermission]), authors), true)
  const sources = {
    purchaseOrders: [
      { id: 'PO-1', orderNumber: 'PO-1', status: 'pending_approval', approvalAuthorIds: ['U1'], lines: [] },
      { id: 'PO-2', orderNumber: 'PO-2', status: 'pending_approval', approvalAuthorIds: ['U2'], lines: [] },
    ],
    supplierInvoices: [
      { id: 'B-1', invoiceNumber: 'B-1', status: 'matched', approvalAuthorIds: ['U1'] },
      { id: 'B-2', invoiceNumber: 'B-2', status: 'matched', approvalAuthorIds: ['U2'] },
    ],
  }
  const now = new Date('2026-11-18T15:00:00Z')
  const ids = (work, kind) => work.all.filter((row) => row.kind === kind).map((row) => row.recordId).sort()
  const work = buildTodayWork(sources, { now, approver: approver([orderPermission, billPermission]) })
  assert.deepEqual([ids(work, 'purchase_order_to_approve'), ids(work, 'bill_to_approve')], [['PO-2'], ['B-2']])
})

test('the request and order pages offer Approve and Reject only with canApprove', () => {
  const requests = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.match(requests, /const APPROVER_ACTIONS = new Set<RequestAction>\(\["approve", "reject"\]\);/)
  assert.match(requests, /\(!APPROVER_ACTIONS\.has\(action\) \|\| pr\.canApprove === true\)/)
  const actions = read('src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx')
  assert.match(actions, /\(\(action !== "approve" && action !== "reject"\) \|\| canApprove\)/)
  assert.match(read('src/modules/purchasing/Page.tsx'), /canApprove=\{selectedPO\.canApprove === true\}/)
  // The assistant's record card follows the same rule.
  const card = read('server/domain/ai-assistant-v2-ui-tools.mjs')
  assert.match(card, /!\(ownRecord && \(step === 'approve' \|\| step === 'reject'\)\)/)
})

test('the US-trial sales orders are what confirming requires (C5): a customer from Customers and a price on every line', () => {
  const fixture = read('scripts/browser-product-recovery-api.mjs')
  assert.match(fixture, /customerId: US_TRIAL_CUSTOMERS\.harbor\.id, customerName: US_TRIAL_CUSTOMERS\.harbor\.name, workflowStatus: "confirmed"/)
  assert.match(fixture, /customerId: US_TRIAL_CUSTOMERS\.lakeside\.id, customerName: US_TRIAL_CUSTOMERS\.lakeside\.name, workflowStatus: "on_hold"/)
  assert.match(fixture, /unitPrice: PRICES\[sku\], amount: orderedQuantity \* PRICES\[sku\]/)
  assert.match(fixture, /namespace: "master-data\.customers", recordKey: customer\.code,\n\s+payload: \{ \.\.\.customer, status: "active"/)
  assert.doesNotMatch(fixture, /customerName: "", workflowStatus/)
})
