import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { runAiReadTool } from './ai-read-tool-runner.mjs'

// Design audit 2026-11-15 (L5-09 = L11-11): a held supplier invoice or an
// approved purchase request set aside on Today came back in the assistant's
// answers as something new; an item whose reorder was set aside as not
// needed was still suggested. Every tool that lists such a record now
// carries the decision, and the suggestions leave the item out.

const link = { id: 'ITEM-001::SUP-001', payload: { itemId: 'ITEM-001', supplierId: 'SUP-001', preferred: true, active: true, approved: true, leadTimeDays: 12, minimumOrderQuantity: 100, referencePrice: 95, currency: 'USD' } }
const decided = (kind, recordId, decision, extra = {}) => ({ kind, recordId, state: 'decided', activeKey: `${kind}:${recordId}`, decision, snapshot: { decidedOn: '2026-09-28' }, ...extra })

async function setUp({ decisions = [] } = {}) {
  const scenario = aiSkillScenario({ supplierLinks: [link] })
  // LDM-001 below its reorder point; an approved request waiting to become an order.
  scenario.data.items[0].reorderPoint = 200
  scenario.data.balances[0].reorderPoint = 200
  scenario.data.purchaseRequests.push({ id: 'PR-003', pr: 'PR-003', status: 'approved', priority: 'medium', requiredDate: '2026-10-10T12:00:00Z', totalAmount: 900, currency: 'USD', lines: [{ id: 'PRL-003', sku: 'LDM-002', itemId: 'ITEM-002', quantity: 10, unit: 'pcs' }], createdAt: '2026-09-25T12:00:00Z', updatedAt: '2026-09-27T12:00:00Z' })
  scenario.data.decisionItems = decisions
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const run = async (name, args = {}) => {
    const output = await runAiReadTool(name, args, { facts, context })
    assert.ok(output.ok, `${name}: ${output.error}`)
    return output.result
  }
  return { run }
}

const SET_ASIDE = [
  decided('bill_exception', 'INV-001', 'not_now', { returnOn: '2026-10-06' }),
  decided('purchase_request_to_convert', 'PR-003', 'not_now', { returnOn: '2026-10-02' }),
  decided('reorder_now', 'ITEM-001', 'not_needed', { reasonCode: 'discontinued' }),
]

test('a held invoice set aside on Today is marked wherever the assistant lists it', async () => {
  const { run } = await setUp({ decisions: SET_ASIDE })
  const problems = await run('attention_list', { kind: 'problems', types: ['invoice_variance'] })
  const invoiceRow = problems.rows.find((row) => row.label === 'INV-001')
  assert.deepEqual(invoiceRow.setAside, { decision: 'not_now', decidedOn: '2026-09-28', returnOn: '2026-10-06' })
  assert.equal(problems.setAsideCount, 1)
  const differences = await run('list_supplier_invoices', { kind: 'differences' })
  assert.deepEqual(differences.rows.find((row) => row.invoiceNumber === 'INV-001').setAside?.decision, 'not_now')
  // Without the decision, the same rows carry none.
  const fresh = await setUp()
  assert.equal((await fresh.run('attention_list', { kind: 'problems', types: ['invoice_variance'] })).rows.find((row) => row.label === 'INV-001').setAside, undefined)
})

test('an approved request set aside on Today is marked in the request list', async () => {
  const { run } = await setUp({ decisions: SET_ASIDE })
  const requests = await run('list_purchase_requests', { status: 'approved' })
  assert.deepEqual(requests.rows.map((row) => [row.request, row.setAside?.decision ?? null]), [['PR-003', 'not_now']])
  assert.equal(requests.setAsideCount, 1)
})

test('an item whose reorder was set aside is left out of the suggestions unless the user names it', async () => {
  const { run } = await setUp({ decisions: SET_ASIDE })
  const suggested = await run('suggest_purchase_lines')
  assert.ok(!suggested.rows.some((row) => row.item.sku === 'LDM-001'))
  assert.deepEqual(suggested.setAsideLeftOut, [{ sku: 'LDM-001', decision: 'not_needed', reasonCode: 'discontinued', decidedOn: '2026-09-28' }])
  const named = await run('suggest_purchase_lines', { skus: ['LDM-001'] })
  assert.equal(named.rows[0].setAside?.reasonCode, 'discontinued')
  // Without the decision it is suggested.
  const fresh = await setUp()
  assert.ok((await fresh.run('suggest_purchase_lines')).rows.some((row) => row.item.sku === 'LDM-001'))
})

test('decision_history finds a supplier invoice by its number', async () => {
  const { run } = await setUp({ decisions: [decided('bill_exception', 'INV-001', 'chased', { note: 'copied' })] })
  const history = await run('decision_history', { record: 'INV-001' })
  assert.deepEqual(history.record.ref, { type: 'supplier_invoice', id: 'INV-001', label: 'INV-001' })
  assert.deepEqual(history.items.map((row) => [row.kind, row.decision]), [['bill_exception', 'chased']])
})
