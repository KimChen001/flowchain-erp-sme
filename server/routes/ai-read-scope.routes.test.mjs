import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRoute } from './ai.routes.mjs'
import { handleAiRuntimeGatewayRoute, loadAiRuntimeFacts } from './ai-runtime-gateway.routes.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { defaultRoleTemplates, permissionCodes } from '../auth/permission-catalog.mjs'
import { aiSkillScenario } from '../domain/test-fixtures/ai-skill-scenario.mjs'

// The assistant answers from the business read context as the reader may see
// it: no records from collections their role cannot read, no hidden amounts,
// invoice partners or supplier bank details, and stock from their warehouses.

const roleAccess = (roleKey, warehouseIds = null) => ({
  ...reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-ai', permissionCodes: new Set(roleKey === '*' ? permissionCodes : defaultRoleTemplates.find(role => role.roleKey === roleKey).permissions) }),
  warehouseIds,
})

const balances = [
  { sku: 'SKU-1', itemName: 'Valve', warehouseId: 'WH-EAST', onHandQuantity: 150, availableQuantity: 150 },
  { sku: 'SKU-2', itemName: 'Gasket', warehouseId: 'WH-WEST', onHandQuantity: 999, availableQuantity: 999 },
]

// The production read path: repositories behind the business read context
// service. The inventory repository honours the warehouse ids it is given.
function repositories(seen = {}) {
  return {
    masterData: {
      listItems: async () => [{ id: 'SKU-1', sku: 'SKU-1', name: 'Valve' }, { id: 'SKU-2', sku: 'SKU-2', name: 'Gasket' }],
      listSuppliers: async () => [{ id: 'SUP-1', name: 'Harbor Supply', bankAccountNumber: '000123456789', taxIdentificationNumber: '12-3456789' }],
      listCustomers: async () => [],
      listAllItemSupplierRelationships: async () => [],
    },
    inventoryRuntime: { listItems: async (scope) => { seen.warehouseIds = scope?.warehouseIds ?? null; return scope?.warehouseIds ? balances.filter(row => scope.warehouseIds.includes(row.warehouseId)) : balances } },
    salesOrders: { listOrders: async () => [{ id: 'SO-1', salesOrderId: 'SO-1', customerName: 'Redwood Retail', sku: 'SKU-1', orderedQty: 4, status: 'confirmed', totalAmount: 720 }] },
    procurementRuntime: { snapshot: async () => ({
      purchaseRequests: [{ id: 'PR-1', status: 'approved', totalAmount: 48125, lines: [{ sku: 'SKU-1', quantity: 10, unitPrice: 4812.5 }] }],
      rfqs: [],
      purchaseOrders: [{ id: 'PO-1', sourcePrId: 'PR-1', status: 'approved', supplierId: 'SUP-1', supplierSnapshot: { supplierName: 'Harbor Supply' }, currency: 'USD', totalAmount: 48125, lines: [{ sku: 'SKU-1', quantity: 10, unitPrice: 4812.5, amount: 48125 }] }],
      receipts: [{ id: 'GRN-1', poId: 'PO-1', status: 'posted' }],
      supplierInvoices: [{ id: 'INV-1', invoiceNumber: 'INV-1', supplierId: 'SUP-1', supplierName: 'Harbor Supply', poId: 'PO-1', receiptId: 'GRN-1', currency: 'USD', totalAmount: 37950, varianceAmount: 1200, status: 'exception', matchStatus: 'variance' }],
    }) },
  }
}

// POST /api/ai/chat, the legacy chat route (served while the rollback flag is on).
async function chat(question, access) {
  let response
  const seen = {}
  const handled = await handleAiRoute({
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai/chat'), db: {}, env: {},
    repositories: repositories(seen), dataMode: 'user', identity: { authenticated: true, tenantId: 'tenant-ai' }, reportReadAccess: access,
    readBody: async () => ({ question }),
    send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  assert.equal(handled, true)
  return { ...response, text: JSON.stringify(response.payload), seen }
}

const AMOUNTS = ['48125', '4812.5', '37950', '1200']
const QUESTIONS = ['PR-1 金额', '采购风险', '今天有什么需要处理？', 'PO-1 证据链', '哪些销售订单需要跟进？']

test('a reader with every permission gets amounts, invoices and sales orders from the assistant', async () => {
  const all = roleAccess('*')
  assert.match((await chat('PR-1 金额', all)).text, /48125/)
  const risks = await chat('采购风险', all)
  assert.match(risks.text, /INV-1/)
  assert.match(risks.text, /1200/)
  assert.match((await chat('PO-1 证据链', all)).text, /Redwood/)
  assert.match((await chat('哪些销售订单需要跟进？', all)).text, /SO-1/)
})

test('the read-only viewer gets no purchase order or invoice amounts from the assistant', async () => {
  const viewer = roleAccess('read-only-viewer')
  for (const question of QUESTIONS) {
    const { status, text } = await chat(question, viewer)
    assert.equal(status, 200, question)
    for (const secret of [...AMOUNTS, '000123456789', '12-3456789']) assert.equal(text.includes(secret), false, `${question} leaks ${secret}`)
  }
})

test('the procurement specialist gets no supplier invoices or sales orders from the assistant', async () => {
  const buyer = roleAccess('procurement-specialist')
  for (const question of QUESTIONS) {
    const { status, text } = await chat(question, buyer)
    assert.equal(status, 200, question)
    for (const secret of ['INV-1', '37950', '1200', 'SO-1', 'Redwood']) assert.equal(text.includes(secret), false, `${question} leaks ${secret}`)
  }
  // The buyer may read prices, so purchase amounts stay in their answers.
  assert.match((await chat('PR-1 金额', buyer)).text, /48125/)
})

test("the assistant reads inventory from the reader's warehouses only", async () => {
  const east = await chat('SKU-2 库存风险为什么？', roleAccess('operations-specialist', ['WH-EAST']))
  assert.deepEqual(east.seen.warehouseIds, ['WH-EAST'])
  assert.equal(east.text.includes('999'), false)
})

// POST /api/ai-runtime/respond: the workspace skills read the facts through
// the same scoped context.
async function respond(message, roleKey) {
  const scenario = aiSkillScenario({ roleKey })
  let response
  await handleAiRuntimeGatewayRoute({
    ...scenario.ctx, env: {}, req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'), db: {},
    readBody: async () => ({ message, answerLanguage: 'en-US' }),
    send: (_res, status, payload) => { response = { status, payload } },
  })
  return { ...response, text: JSON.stringify(response.payload) }
}

const SKILL_QUESTIONS = ['What is our committed PO spend?', 'Tell me about PO-001', 'What should I handle first today?', 'Which invoices have variances?', 'Which SKUs are at risk?']

test('the read-only viewer gets no purchase order or invoice amounts from the workspace skills', async () => {
  // The administrator's answers carry the committed PO and invoice totals.
  const admin = await respond('What is our committed PO spend?', 'workspace-administrator')
  assert.match(admin.text, /17,?920/)
  assert.match(admin.text, /7,?381\.5/)
  for (const question of SKILL_QUESTIONS) {
    const { status, text } = await respond(question, 'read-only-viewer')
    assert.equal(status, 200, question)
    // PO totals 5,000, 4,000, 3,920, 500 (EUR) and 17,920; invoices 2,381.50, 7,381.50 and a 200 variance.
    for (const secret of [/17,?920/, /3,?920/, /5,000/, /2,?381\.5/, /7,?381\.5/]) assert.doesNotMatch(text, secret, question)
  }
})

test('the procurement specialist gets no supplier invoices or sales orders from the workspace skills', async () => {
  for (const question of SKILL_QUESTIONS) {
    const { status, text } = await respond(question, 'procurement-specialist')
    assert.equal(status, 200, question)
    for (const secret of [/INV-00\d/, /SO-001/, /Redwood/, /2,?381\.5/, /7,?381\.5/]) assert.doesNotMatch(text, secret, question)
  }
})

// The retired template gateway (rollback flag) reads its facts the same way.
test('the rollback template gateway facts are scoped to the reader', async () => {
  const seen = {}
  const rows = {
    procurementRead: { snapshot: async () => ({
      purchaseRequests: [{ id: 'PR-1', totalAmount: 48125 }],
      purchaseOrders: [{ id: 'PO-1', supplierId: 'SUP-1', totalAmount: 48125, lines: [{ unitPrice: 4812.5 }] }],
      receivingDocs: [{ grn: 'GRN-1', po: 'PO-1' }],
      supplierInvoices: [{ id: 'INV-1', supplierId: 'SUP-1', supplier: 'Harbor Supply', supplierName: 'Harbor Supply', totalAmount: 37950, varianceAmount: 1200 }],
    }) },
    inventoryRead: { listItems: async (scope) => { seen.warehouseIds = scope.warehouseIds; return balances.filter(row => !scope.warehouseIds || scope.warehouseIds.includes(row.warehouseId)) } },
    masterData: { listSuppliers: async () => [{ id: 'SUP-1', name: 'Harbor Supply', bankAccountNumber: '000123456789' }] },
  }
  const viewer = await loadAiRuntimeFacts(rows, 'tenant-ai', roleAccess('read-only-viewer', ['WH-EAST']))
  const text = JSON.stringify(viewer)
  for (const secret of [...AMOUNTS, '000123456789']) assert.equal(text.includes(secret), false, secret)
  assert.deepEqual(viewer.supplierInvoices.map(row => [row.id, row.supplierId, row.totalAmount]), [['INV-1', null, null]])
  assert.deepEqual(seen.warehouseIds, ['WH-EAST'])
  assert.deepEqual(viewer.products.map(row => row.sku), ['SKU-1'])
  const buyer = await loadAiRuntimeFacts(rows, 'tenant-ai', roleAccess('procurement-specialist'))
  assert.deepEqual(buyer.supplierInvoices, [])
  assert.equal(buyer.purchaseOrders[0].totalAmount, 48125)
})
