import test from 'node:test'
import assert from 'node:assert/strict'
import { answerAiSkill } from './ai-skills.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { refineAiSkillRoute } from './ai-skill-entities.mjs'

// Seven suppliers on 2026-10-03. S1 has the longest overdue order, S2 a
// shorter one and more open work, S3 only an order due soon, S4 an invoice
// variance open since Sep 25, S5 a receipt not posted since Oct 1, S6 an
// order due in 3 days, S7 an overdue order too. S8 has nothing open.
const asOf = '2026-10-03'
function facts({ purchaseOrders = true } = {}) {
  const po = (id, supplierId, overdueDays, dueDate) => ({ id, orderNumber: id, supplierId, supplier: `Supplier ${supplierId}`, status: 'issued', dueDate, overdueDays, remaining: 10, unit: 'pcs' })
  const suppliers = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].map((id) => ({ id, code: id, name: `Supplier ${id}` }))
  return {
    asOf, today: asOf, generatedAt: `${asOf}T12:00:00.000Z`, locale: 'en-US', currency: 'USD', timezone: 'America/New_York',
    checked: ['purchase_orders', 'receipts', 'supplier_invoices'], limitations: [], hidden: [], records: [],
    visibility: { sources: { purchase_orders: purchaseOrders, receipts: true, supplier_invoices: true }, amounts: {}, partner: true },
    suppliers,
    purchaseOrders: purchaseOrders ? {
      rows: [po('PO-1', 'S1', 18, '2026-09-15'), po('PO-2', 'S2', 3, '2026-09-30'), po('PO-3', 'S2', 1, '2026-10-02'), po('PO-4', 'S3', 0, '2026-10-05'), po('PO-6', 'S6', 0, '2026-10-06'), po('PO-7', 'S7', 2, '2026-10-01')],
      index: [{ id: 'PO-9', orderNumber: 'PO-9', supplierId: 'S8', createdDate: '2026-10-02', isOpen: true }, { id: 'PO-8', orderNumber: 'PO-8', supplierId: 'S8', createdDate: '2026-09-01', isOpen: true }],
    } : null,
    invoices: { variances: [{ id: 'INV-4', invoiceNumber: 'INV-4', supplierId: 'S4', supplier: 'Supplier S4', variance: 20, currency: 'USD', invoiceDate: '2026-09-25' }], recent: [{ id: 'INV-5', invoiceNumber: 'INV-5', supplierId: 'S1', invoiceDate: '2026-10-01' }] },
    receipts: { rejected: [], unposted: [{ id: 'GRN-5', documentNumber: 'GRN-5', supplierId: 'S5', supplier: 'Supplier S5', poId: 'PO-5', arrivedDay: '2026-10-01' }], recent: [{ id: 'GRN-5', documentNumber: 'GRN-5', supplierId: 'S5', supplier: 'Supplier S5', arrivedDay: '2026-10-01' }] },
  }
}
const ask = (input, language = 'en-US', route = null) => answerAiSkill({ skillId: 'supplier_attention', facts: input, language, query: 'q', route }).response

test('suppliers are ordered by the date of their most urgent record, five at most', () => {
  const answer = ask(facts())
  // Overdue first, longest first (S1 18 days, S2 3 days, S7 2 days); then due
  // soonest (S3 Oct 5, S6 Oct 6); then open the longest (S4 since Sep 25, S5
  // since Oct 1). Five are listed; the scorecard holds the rest.
  assert.deepEqual(answer.keyEvidence.map((item) => item.entityId), ['S1', 'S2', 'S7', 'S3', 'S6'])
  assert.equal(answer.conclusion.title, '7 suppliers have open work; the most urgent is Supplier S1 (18 days overdue)')
  assert.match(answer.conclusion.summary, /^In all: 4 overdue purchase orders, 2 purchase orders due within 7 days, 1 receipt not posted and 1 invoice variance\./)
  assert.match(answer.conclusion.summary, /2 more suppliers have open work; open the supplier scorecard to see all of them\./)
  assert.match(answer.conclusion.summary, /1 other supplier has nothing open\./)
  // Recent activity names who the workspace dealt with this week, problems or not.
  assert.match(answer.conclusion.summary, /In the last 7 days: Supplier S1 \(1 invoice\), Supplier S5 \(1 receipt\) and Supplier S8 \(1 new order\)\./)
  // The first three say which record is most urgent and its date; the others only count.
  assert.equal(answer.keyEvidence[0].summary, '1 overdue purchase order. Most urgent: PO-1. 18 days past the promised date (Sep 15, 2026); 10 pcs still to receive from Supplier S1.')
  assert.equal(answer.keyEvidence[1].summary, '2 overdue purchase orders. Most urgent: PO-2. 3 days past the promised date (Sep 30, 2026); 10 pcs still to receive from Supplier S2.')
  assert.equal(answer.keyEvidence[3].summary, '1 purchase order due within 7 days.')
  assert.deepEqual(answer.navigationLinks.map((link) => link.moduleId), ['master-data:suppliers', 'master-data:suppliers', 'master-data:suppliers', 'reports:suppliers'])
  assert.equal(answer.navigationLinks.at(-1).label, 'View all suppliers (scorecard)')
  assert.deepEqual(answer.followUpSuggestions.map((item) => item.skillHint), ['purchase_orders', 'receiving_issues', 'invoice_summary', 'today_priorities'])
})

test('the same answer in Chinese, with no link to all suppliers when five or fewer have work', () => {
  const answer = ask(facts(), 'zh-CN')
  assert.equal(answer.conclusion.title, '7 家供应商有待处理的事，最急的是 Supplier S1（逾期 18 天）')
  assert.match(answer.conclusion.summary, /还有 2 家供应商有待处理的事，可打开供应商评分卡查看全部。/)
  const few = facts()
  few.purchaseOrders.rows = few.purchaseOrders.rows.slice(0, 2)
  const short = ask(few)
  assert.equal(short.conclusion.title, '4 suppliers have open work; the most urgent is Supplier S1 (18 days overdue)')
  assert.ok(!short.navigationLinks.some((link) => link.moduleId === 'reports:suppliers'))
  assert.doesNotMatch(short.conclusion.summary, /scorecard/)
})

test('a named supplier narrows the list, and a role that sees none of the sources is told so', () => {
  const named = ask(facts(), 'en-US', { entities: { suppliers: [{ id: 'S4' }] } })
  assert.equal(named.conclusion.title, '1 supplier has open work: Supplier S4 (open 8 days)')
  assert.equal(named.keyEvidence[0].summary, '1 invoice variance. Most urgent: INV-4. Invoice variance of $20.00 from Supplier S4. Open 8 days, since Sep 25, 2026.')
  const quiet = ask(facts(), 'en-US', { entities: { suppliers: [{ id: 'S8' }] } })
  assert.equal(quiet.conclusion.title, 'Supplier S8 has no open work (as of Oct 3, 2026)')
  const blind = facts({ purchaseOrders: false })
  blind.receipts = null
  blind.invoices = null
  assert.equal(ask(blind).conclusion.title, 'Your role cannot see supplier orders, receipts or invoices')
})

test('general supplier questions route here; specific ones keep their skills', () => {
  for (const message of ['供应商数据给我呢', '给我看看供应商', '所有供应商的情况', 'Show me supplier data', 'How are our suppliers doing?', 'Which suppliers need follow-up?', '哪些供应商需要优先处理？', '供应商 Acme Components 的数据']) {
    assert.equal(routeSkill({ message }).skillId, 'supplier_attention', message)
  }
  assert.equal(routeSkill({ message: 'Which suppliers are late on purchase orders?' }).skillId, 'purchase_orders')
  assert.equal(routeSkill({ message: 'Which supplier invoices have a price variance?' }).skillId, 'invoice_summary')
  assert.equal(routeSkill({ message: 'Which suppliers are at risk?' }).skillId, 'highest_risk_items')
  assert.notEqual(routeSkill({ message: '这些供应商还有什么事情没有处理？' }).skillId, 'supplier_attention')
  assert.equal(routeSkill({ message: 'supplier test' }).greeting, true)
  // A supplier the question names narrows the answer to it.
  const named = facts()
  named.suppliers[3].name = 'Northwind Traders'
  const message = 'How is supplier Northwind Traders doing?'
  const refined = refineAiSkillRoute(routeSkill({ message }), message, named)
  assert.deepEqual([refined.skillId, refined.mode, refined.entities.suppliers.map((row) => row.id)], ['supplier_attention', 'supplier', ['S4']])
  assert.equal(ask(named, 'en-US', refined).conclusion.title, '1 supplier has open work: Northwind Traders (open 8 days)')
})
