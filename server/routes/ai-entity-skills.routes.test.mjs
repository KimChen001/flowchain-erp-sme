import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from '../domain/test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from './ai-runtime-gateway.routes.mjs'

// The record skills end to end through /api/ai-runtime/respond, on the skill
// test scenario (seed day 2026-09-29): a purchase order, supplier or SKU the
// question names, orders waiting for approval, stock and supplier invoices,
// for roles that see different sources.

const CJK = /[㐀-鿿]/
const MONEY = /[$€¥£]\s?\d|\b(?:USD|EUR|CNY|GBP)\s?\d/

function harness(roleKey = 'workspace-administrator') {
  const scenario = aiSkillScenario({ roleKey })
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => entry } }
  const ask = async (message, answerLanguage = 'en-US') => {
    ctx.readBody = async () => ({ message, answerLanguage })
    assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
    const { status, payload } = sent.at(-1)
    assert.equal(status, 200, message)
    return payload
  }
  return { ask, scenario }
}

const figures = (payload) => Object.fromEntries((payload.figures || []).map((figure) => [figure.key, figure.value]))
const text = (payload) => `${payload.conclusion.title} ${payload.conclusion.summary}`

test('a named purchase order, supplier or SKU gets its own answer and figures', async () => {
  const { ask } = harness()
  const order = await ask("What's the status of PO-001?")
  assert.equal(order.intent, 'purchase_orders')
  assert.equal(order.conclusion.title, 'PO-001: 30 pcs still to receive')
  assert.deepEqual(figures(order), { 'po_remaining:PO-001': 30 })
  // The spaced and unpadded forms name the same order.
  assert.deepEqual(figures(await ask('Where is PO 1?')), { 'po_remaining:PO-001': 30 })
  const supplier = await ask('Which purchase orders from Acme Components are open?')
  assert.deepEqual(figures(supplier), { 'supplier_open_po:SUP-001': 3, 'supplier_overdue_po:SUP-001': 2 })
  const partial = await ask('Any open POs from Summit?')
  assert.equal(partial.conclusion.title, 'Summit Packaging: 1 open purchase order, 0 overdue')
  assert.deepEqual(figures(await ask('Which POs are open for LDM-002?')), { 'sku_open_po:LDM-002': 2, 'sku_overdue_po:LDM-002': 0 })
  const typo = await ask('Wich purchse orders are overdue?')
  assert.deepEqual([typo.intent, figures(typo)], ['purchase_orders', { overdue_po_count: 2, open_po_count: 4 }])
  // An order that will not be received says so.
  assert.equal((await ask('Is PO-005 still coming?')).conclusion.title, 'PO-005: Cancelled, nothing will be received')
  const missing = await ask("What's the status of PO-999?")
  assert.deepEqual([missing.intent, missing.conclusion.title, missing.keyEvidence.length], ['purchase_orders', "I couldn't find PO-999 in this workspace", 0])
})

test('approvals, stock and invoices answer with the report figures', async () => {
  const { ask } = harness()
  const approvals = await ask('Which POs are waiting for approval?')
  assert.equal(approvals.intent, 'pending_approvals')
  assert.deepEqual(figures(approvals), { pending_approval_po_count: 1, pending_approval_pr_count: 1 })
  assert.deepEqual(approvals.keyEvidence.map((item) => item.entityId), ['PO-006', 'PR-001'])
  // A supplier the question names narrows the list; requests have no supplier.
  const acme = await ask('Which POs from Acme are waiting for approval?')
  assert.equal(acme.conclusion.title, 'Acme Components: 1 purchase order waiting for approval')
  assert.deepEqual(acme.keyEvidence.map((item) => item.entityId), ['PO-006'])
  const stock = await ask("What's the ATP for LDM-001?")
  assert.equal(stock.intent, 'inventory_availability')
  assert.deepEqual(figures(stock), { 'atp:LDM-001': 63, 'available:LDM-001': 28, 'on_hand:LDM-001': 28 })
  assert.deepEqual(figures(await ask('How much Flow Controller do we have?')), figures(stock))
  const invoices = await ask('How much did we invoice in total?')
  assert.equal(invoices.intent, 'invoice_summary')
  assert.deepEqual(figures(invoices), { 'committed_invoices:USD': 7381.5, committed_invoice_count: 2, invoice_variance_count: 1 })
  // Another document number is not looked up, and the answer says so.
  const invoice = await ask("What's the status of INV-001?")
  assert.equal(invoice.intent, 'capability_overview')
  assert.match(invoice.conclusion.summary, /^I can't look up INV-001 by its number yet\./)
})

test('the answer is in the question language and carries the same facts', async () => {
  const { ask } = harness()
  for (const [english, chinese] of [
    ["What's the status of PO-001?", 'PO-001 的状态是什么？'],
    ['How much stock is left for LDM-001?', 'LDM-001 还有多少库存？'],
    ['Which POs are waiting for approval?', '哪些采购订单在等审批？'],
  ]) {
    const en = await ask(english, 'zh-CN')
    const zh = await ask(chinese, 'en-US')
    assert.deepEqual([en.language, zh.language], ['en-US', 'zh-CN'], english)
    assert.doesNotMatch(text(en), CJK, english)
    assert.match(text(zh), CJK, chinese)
    assert.equal(zh.intent, en.intent, chinese)
    assert.deepEqual(figures(zh), figures(en), chinese)
    assert.deepEqual(zh.keyEvidence.map((item) => item.entityId), en.keyEvidence.map((item) => item.entityId), chinese)
  }
  // An English question about a Chinese term stays English.
  const mixed = await ask('How many 未结采购订单 do we have?', 'zh-CN')
  assert.equal(mixed.language, 'en-US')
})

test('a role that cannot read a source gets the same answer for any record number', async () => {
  const operations = harness('operations-specialist')
  const existing = await operations.ask("What's the status of PO-001?")
  const missing = await operations.ask("What's the status of PO-999?")
  assert.equal(existing.conclusion.title, "Your role can't view purchase orders, so I can't look up PO-001")
  assert.equal(missing.conclusion.title.replace('PO-999', 'PO-001'), existing.conclusion.title)
  for (const payload of [existing, missing]) assert.deepEqual([payload.keyEvidence.length, payload.figures.length], [0, 0])
  const finance = harness('finance-specialist')
  const sku = await finance.ask("What's the ATP for LDM-001?")
  const unknown = await finance.ask("What's the ATP for LDM-999?")
  assert.equal(sku.conclusion.title, "Your role can't view inventory, so I can't look up LDM-001")
  assert.equal(unknown.conclusion.title.replace('LDM-999', 'LDM-001'), sku.conclusion.title)
})

test('a role without amounts sees counts, never money', async () => {
  const { ask } = harness('read-only-viewer')
  for (const question of ["What's the status of PO-001?", 'Which POs are waiting for approval?', 'How much did we invoice in total?', 'Which purchase orders from Acme Components are open?']) {
    const payload = await ask(question)
    assert.doesNotMatch(JSON.stringify([payload.conclusion, payload.keyEvidence, payload.metrics]), MONEY, question)
    assert.ok(!(payload.figures || []).some((figure) => figure.currency), question)
  }
  assert.deepEqual(figures(await ask('How much did we invoice in total?')), { committed_invoice_count: 2, invoice_variance_count: 1 })
})

test('a question about the world outside the workspace reads no business data', async () => {
  const { ask, scenario } = harness()
  for (const question of ["What's the weather in Boston?", "What's Apple's stock price?", '今天天气怎么样？']) {
    const before = { repositories: scenario.calls.repositories.length, prisma: scenario.calls.prisma.filter(([model]) => model !== 'tenant').length }
    const payload = await ask(question)
    assert.equal(payload.intent, 'capability_overview', question)
    assert.equal(scenario.calls.repositories.length, before.repositories, question)
    assert.equal(scenario.calls.prisma.filter(([model]) => model !== 'tenant').length, before.prisma, question)
  }
})
