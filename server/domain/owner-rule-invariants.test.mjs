import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { buildSupplierActionSummaries } from './supplier-action-summary-read-service.mjs'
import { summarizeScorecardLines } from './supplier-scorecard.mjs'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { aiSkillFormatter } from './ai-skill-presenter.mjs'
import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'
import { buildAiSupplierOperationalResponse } from './ai-supplier-operational-query.mjs'
import { createAiUserScenarioDb } from './test-fixtures/ai-user-scenario.mjs'
import { analyticsCopy, analyticsCopyPairs } from '../../src/modules/reports/analyticsCopy.ts'
import { reportWorkbook } from '../../src/modules/reports/reportWorkbook.ts'
import { metricDisplayValue } from '../../src/modules/reports/metricDisplay.ts'
import { supplierCopyPairs } from '../../src/modules/srm/supplierCopy.ts'
import { chinese as inventoryChinese, chineseCodes, english as inventoryEnglish, englishCodes } from '../../src/modules/inventory/inventoryOperationsCopyMaps.ts'
import { statusCodeLabel } from '../../src/i18n/statusLabels.ts'

// The owner's rules (2026-10-03, reaffirmed 2026-10-05), checked on the
// payloads the reports and the assistant return, so CI fails when one breaks:
//   1. amounts are never added across currencies, nor quantities across SKUs or units;
//   2. ranked lists are ordered by date, and each line prints its date;
//   3. no list carries a hand-set weight or score;
//   4. no rate is shown below the minimum sample;
//   5. the copy those features use has English and Chinese for every entry.

const CJK = /[㐀-鿿]/u
const LANGUAGES = ['en-US', 'zh-CN']

// Two currencies, two SKUs and two units.
const context = (extra = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [], ...extra,
})
const poLine = (id, sku, unit, quantity, price) => ({ id, sku, itemName: sku, unit, orderedQuantity: quantity, receivedQuantity: 0, unitPrice: price, amount: quantity * price, originalPromisedDate: '2026-09-20' })
const po = (id, supplierName, currency, lines) => ({ id, supplierName, status: 'issued', currency, totalAmount: lines.reduce((sum, line) => sum + line.amount, 0), createdAt: '2026-09-02T12:00:00.000Z', expectedDate: '2026-09-20T00:00:00.000Z', lines })
const mixedContext = () => context({
  purchaseOrders: [
    po('PO-USD-SKUS', 'Acme', 'USD', [poLine('L1', 'BOLT', 'pcs', 10, 2), poLine('L2', 'CABLE', 'pcs', 5, 3)]),
    po('PO-EUR-UNITS', 'Bolt', 'EUR', [poLine('L3', 'BOLT', 'pcs', 4, 5), poLine('L4', 'BOLT', 'box', 2, 40)]),
    po('PO-USD-ONE', 'Acme', 'USD', [poLine('L5', 'BOLT', 'pcs', 3, 2)]),
  ],
  salesOrders: [{ id: 'SO-1', status: 'confirmed', currency: 'USD', totalAmount: 10, createdAt: '2026-09-03', customerName: 'Northwind', lines: [{ sku: 'BOLT', unit: 'pcs', orderedQuantity: 3, fulfilledQuantity: 0 }, { sku: 'CABLE', unit: 'm', orderedQuantity: 4, fulfilledQuantity: 0 }] }],
  inventoryItems: [{ sku: 'BOLT', unit: 'pcs', onHandQuantity: 8 }, { sku: 'CABLE', unit: 'm', onHandQuantity: 2 }],
  supplierInvoices: [
    { id: 'INV-USD', invoiceNumber: 'INV-USD', status: 'approved', currency: 'USD', totalAmount: 20, invoiceDate: '2026-09-04', supplierName: 'Acme' },
    { id: 'INV-EUR', invoiceNumber: 'INV-EUR', status: 'approved', currency: 'EUR', totalAmount: 80, invoiceDate: '2026-09-05', supplierName: 'Bolt' },
  ],
})
const asOf = { now: new Date('2026-10-05T16:00:00.000Z'), timeZone: 'America/New_York' }
const SUBJECTS = ['overview', 'procurement', 'sales', 'inventory', 'finance', 'suppliers']

test('rule 1: report KPIs, charts and totals never add amounts across currencies', () => {
  for (const subject of SUBJECTS) {
    const report = buildRuntimeGovernedReport(mixedContext(), { subject }, asOf)
    if (report.dataScope.currencyAggregationStatus !== 'multi_currency_unconverted') continue
    // A money KPI has no value; the amounts are kept per currency.
    for (const kpi of report.kpis.filter((item) => item.unit === 'currency')) assert.equal(kpi.currentValue, null, `${subject} ${kpi.id}`)
    // A money chart over two currencies draws nothing rather than one total.
    for (const chart of report.charts.filter((item) => item.unit === 'currency')) assert.deepEqual(chart.data, [], `${subject} ${chart.id}`)
    for (const row of report.dataScope.currencyAmounts) assert.match(row.currencyCode, /^[A-Z]{3}$/, subject)
  }
  const procurement = buildRuntimeGovernedReport(mixedContext(), { subject: 'procurement' }, asOf)
  assert.deepEqual(procurement.dataScope.currencyAmounts.map((row) => [row.currencyCode, row.amount]), [['EUR', 100], ['USD', 41]])
  const finance = buildRuntimeGovernedReport(mixedContext(), { subject: 'finance' }, asOf)
  assert.deepEqual(finance.dataScope.currencyAmounts.map((row) => [row.currencyCode, row.amount]), [['EUR', 80], ['USD', 20]])
  // The workbook names the mix instead of a number.
  for (const language of LANGUAGES) {
    const copy = (value) => analyticsCopy(value, language)
    const summary = reportWorkbook(procurement, {}, copy, [], { locale: 'en-US', language })[0].rows
    const amount = summary.find((row) => row[copy('Metric')] === copy('Committed PO amount'))
    assert.equal(amount[copy('Current value')], copy('多币种，未折算'), language)
  }
})

test('rule 1: quantities are never added across SKUs or units, in English and Chinese', () => {
  const sales = buildRuntimeGovernedReport(mixedContext(), { subject: 'sales' }, asOf)
  const inventory = buildRuntimeGovernedReport(mixedContext(), { subject: 'inventory' }, asOf)
  const demand = sales.kpis.find((item) => item.id === 'open_sales_demand')
  const onHand = inventory.kpis.find((item) => item.id === 'inventory_on_hand')
  assert.deepEqual([demand.currentValue, demand.limitations], [null, ['sales_demand_units_mixed']])
  assert.deepEqual([onHand.currentValue, onHand.limitations], [null, ['inventory_units_mixed']])
  // Two SKUs in one unit: still no total.
  const sameUnit = buildRuntimeGovernedReport(context({ inventoryItems: [{ sku: 'BOLT', unit: 'pcs', onHandQuantity: 8 }, { sku: 'CABLE', unit: 'pcs', onHandQuantity: 2 }] }), { subject: 'inventory' }, asOf)
  const skus = sameUnit.kpis.find((item) => item.id === 'inventory_on_hand')
  assert.deepEqual([skus.currentValue, skus.limitations], [null, ['inventory_skus_mixed']])

  const procurement = buildRuntimeGovernedReport(mixedContext(), { subject: 'procurement' }, asOf)
  for (const [language, multipleSkus, mixedUnits] of [['en-US', 'Multiple SKUs', 'Mixed units'], ['zh-CN', '多个 SKU', '混合计量单位']]) {
    const copy = (value) => analyticsCopy(value, language)
    const workbook = reportWorkbook(procurement, {}, copy, [], { locale: 'en-US', language })
    const detail = workbook[2].rows
    const row = (id) => detail.find((entry) => entry[copy('业务编号')] === id)
    assert.deepEqual([row('PO-USD-SKUS')[copy('单位')], row('PO-EUR-UNITS')[copy('单位')], row('PO-USD-ONE')[copy('单位')]], [multipleSkus, mixedUnits, 'pcs'], language)
    // No quantity total for an order of several SKUs or units.
    assert.deepEqual([row('PO-USD-SKUS')[copy('数量')], row('PO-EUR-UNITS')[copy('数量')], row('PO-USD-ONE')[copy('数量')]], ['—', '—', 3], language)
    for (const report of [sales, inventory]) {
      const values = reportWorkbook(report, {}, copy, [], { locale: 'en-US', language })[0].rows.map((entry) => entry[copy('Current value')])
      assert.ok(values.includes(mixedUnits), `${language} ${report.query.subject}`)
    }
  }
})

test('rule 1: the supplier summary keeps rejected quantities per SKU and unit', () => {
  const actor = { tenantId: 't1', permissionCodes: new Set(['receiving.read', 'procurement.purchase_order.read', 'finance.partner_snapshot.read']) }
  // The last two lines have no SKU or unit: they may be different items.
  const lines = [{ sku: 'BOLT', unit: 'pcs', rejectedQty: 2 }, { sku: 'BOLT', unit: 'box', rejectedQty: 1 }, { sku: 'CABLE', unit: 'm', rejectedQty: 3 }, { id: 'n1', rejectedQty: 4 }, { id: 'n2', sku: null, unit: null, rejectedQty: 5 }]
  const result = buildSupplierActionSummaries({
    actor, now: new Date('2026-07-24T12:00:00.000Z'),
    records: { suppliers: [{ tenantId: 't1', id: 'a', name: 'Acme' }], payables: [], invoices: [], settlements: [], purchaseOrders: [], rfqs: [], bankExceptions: [], receiving: [{ tenantId: 't1', id: 'GRN-1', documentNumber: 'GRN-1', supplierId: 'a', poId: 'PO-1', status: 'posted', arrivedAt: '2026-07-20T10:00:00.000Z', lines }] },
  })
  const receiving = result.items[0].receiving
  assert.deepEqual(receiving.rejectedQuantities.map((row) => [row.sku, row.unit, row.quantity]), [[null, null, 4], [null, null, 5], ['BOLT', 'box', 1], ['BOLT', 'pcs', 2], ['CABLE', 'm', 3]])
  assert.ok(Object.values(receiving).every((value) => typeof value !== 'number' || value === receiving.exceptionCount || value === receiving.pendingEvidenceCount), 'no single rejected total')
})

// The skill scenario, with PO-008 moved to Summit Packaging so that the
// supplier list has two suppliers to order.
async function skillAnswers() {
  const scenario = aiSkillScenario()
  const read = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const facts = { ...read, purchaseOrders: { ...read.purchaseOrders, rows: read.purchaseOrders.rows.map((row) => row.id === 'PO-008' ? { ...row, supplierId: 'SUP-002', supplier: 'Summit Packaging' } : row) } }
  const answer = (skillId, language) => answerAiSkill({ skillId, facts, language, query: 'q', actor: scenario.actor })
  return { facts, answer }
}

// Each ranked list's lines in the order shown, with the date that orders them.
const rankedLists = {
  today_priorities: (result) => result.items,
  highest_risk_items: (result) => result.items,
  supplier_attention: (result) => result.suppliers.map((group) => ({ ...group.items[0], lineId: `supplier_attention:${group.supplierId}` })),
}

// The documented order, written out here rather than taken from the code
// under test: the groups in this order, and within a group the printed date
// never goes back. Today's priorities and the supplier list: past due (the
// longest late first), due within 7 days, open problems (the oldest first),
// undated, due later. The open problems list: by the printed date alone, the
// undated stock problems last.
const DOCUMENTED_GROUPS = ['overdue', 'due_soon', 'open', 'undated', 'due_later']
const groupOf = (when) => when?.kind === 'due' ? (when.days <= 7 ? 'due_soon' : 'due_later') : when?.kind || 'undated'
const orderKey = {
  today_priorities: (line) => [DOCUMENTED_GROUPS.indexOf(groupOf(line.when)), line.when?.date || ''],
  supplier_attention: (line) => [DOCUMENTED_GROUPS.indexOf(groupOf(line.when)), line.when?.date || ''],
  highest_risk_items: (line) => [line.when?.date ? 0 : 1, line.when?.date || ''],
}
function assertDocumentedOrder(skillId, lines) {
  for (let index = 1; index < lines.length; index += 1) {
    const [previousGroup, previousDate] = orderKey[skillId](lines[index - 1])
    const [group, day] = orderKey[skillId](lines[index])
    assert.ok(previousGroup < group || (previousGroup === group && previousDate <= day), `${skillId}: line ${index + 1} (${lines[index].id} ${day || 'undated'}) comes after ${lines[index - 1].id} ${previousDate || 'undated'}`)
  }
}

test('rule 2: ranked assistant lists are ordered by date and every dated line prints its date', async () => {
  const { facts, answer } = await skillAnswers()
  for (const [skillId, linesOf] of Object.entries(rankedLists)) {
    for (const language of LANGUAGES) {
      const { result, response } = answer(skillId, language)
      const lines = linesOf(result)
      assert.ok(lines.length >= 2, `${skillId} has a list to check`)
      assertDocumentedOrder(skillId, lines)
      const day = aiSkillFormatter(facts, language).day
      for (const line of lines.filter((entry) => entry.when?.date)) {
        const evidence = response.keyEvidence.find((item) => item.id === (line.lineId || line.id))
        assert.ok(evidence, `${skillId} ${line.id} is shown`)
        assert.ok(evidence.summary.includes(day(line.when.date)), `${skillId} ${language}: "${evidence.summary}" does not print ${day(line.when.date)}`)
      }
    }
  }
  // The open problems list on the scenario: INV-001 (open since Sep 24) is
  // older than PO-001 (promised Sep 25), so it comes first.
  const risk = answer('highest_risk_items', 'en-US').result.items.map((item) => [item.id, item.when.date])
  assert.ok(risk.findIndex(([id]) => id === 'invoice_variance:INV-001') < risk.findIndex(([id]) => id === 'po_overdue:PO-001'), JSON.stringify(risk))
  // Overdue purchase orders: the longest late first, each with its promised date.
  for (const language of LANGUAGES) {
    const { result, response } = answer('purchase_orders', language)
    const days = result.overdue.map((row) => row.overdueDays)
    assert.ok(days.length >= 2)
    assert.deepEqual(days, [...days].sort((a, b) => b - a))
    const day = aiSkillFormatter(facts, language).day
    for (const row of result.overdue) assert.ok(response.keyEvidence.find((item) => item.entityId === row.id).summary.includes(day(row.dueDate)), `${row.id} ${language}`)
  }
})

const FORBIDDEN_KEYS = new Set(['score', 'weight', 'weights', 'priorityScore', 'signalScore', 'riskScore', 'points'])
function forbiddenKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) value.forEach((entry, index) => forbiddenKeys(entry, `${path}[${index}]`, found))
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) found.push(`${path}.${key}`)
      // A supplier's priority is its dated reasons only: no level or algorithm version.
      if (key === 'priority' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        for (const extra of ['level', 'algorithmVersion']) if (extra in entry) found.push(`${path}.priority.${extra}`)
      }
      forbiddenKeys(entry, `${path}.${key}`, found)
    }
  }
  return found
}

test('rule 3: assistant and supplier payloads carry no weight or score', async () => {
  const { answer } = await skillAnswers()
  for (const skillId of [...Object.keys(rankedLists), 'purchase_orders', 'prepare_action_draft']) {
    for (const language of LANGUAGES) {
      const { result, response } = answer(skillId, language)
      assert.deepEqual(forbiddenKeys({ result, response }), [], `${skillId} ${language}`)
    }
  }
  const actor = { tenantId: 't1', permissionCodes: new Set(['finance.payable.read', 'finance.supplier_invoice.read', 'finance.amounts.read', 'finance.partner_snapshot.read', 'procurement.purchase_order.read', 'receiving.read']) }
  const invoice = { tenantId: 't1', id: 'inv', supplierId: 'a', invoiceNumber: 'INV-1', amount: 100, currency: 'USD', status: 'disputed', matchStatus: 'exception', invoiceDate: '2026-07-01T00:00:00.000Z' }
  const summaries = buildSupplierActionSummaries({
    actor, now: new Date('2026-07-24T12:00:00.000Z'),
    records: { suppliers: [{ tenantId: 't1', id: 'a', name: 'Acme' }, { tenantId: 't1', id: 'b', name: 'Beta' }], invoices: [invoice], payables: [{ tenantId: 't1', id: 'pay', supplierId: 'a', supplierInvoiceId: 'inv', supplierInvoice: invoice, currency: 'USD', outstandingAmount: 100, dueDate: '2026-07-10T00:00:00.000Z', status: 'approved' }], settlements: [], purchaseOrders: [], receiving: [], rfqs: [], bankExceptions: [] },
  })
  assert.deepEqual(forbiddenKeys(summaries), [])
  // The older supplier answers: the response contract and the SRM module cards.
  const db = createAiUserScenarioDb()
  for (const question of ['哪些供应商有潜在风险？', '这个供应商最近有什么问题？', '今天有什么需要我处理？']) {
    const contract = buildAiResponseContractV2(db, { moduleId: 'overview', question }).cards[0].data
    assert.deepEqual(forbiddenKeys(contract.keyEvidence), [], question)
  }
  for (const question of ['查看高风险供应商', '解释评分规则', '下一步跟进']) {
    assert.deepEqual(forbiddenKeys(buildAiSupplierOperationalResponse(db, { moduleId: 'srm', question }).cards), [], question)
  }
  // Ordered by the oldest open reason, each dated.
  assert.deepEqual(summaries.items.map((row) => [row.supplier.id, row.priority.since]), [['a', '2026-07-01'], ['b', null]])
})

test('rule 4: no supplier rate is shown below the minimum sample of 5', () => {
  const line = (index, extra = {}) => ({ purchaseOrderLineId: `L${index}`, originalPromisedDate: '2026-09-20', unit: 'pcs', receivedQuantity: 10, rejectedQuantity: 0, onTime: true, onTimeCurrent: true, inFull: true, inFullPending: false, otif: true, otifCurrent: true, early: false, daysLate: 0, ...extra })
  const four = summarizeScorecardLines({ lines: Array.from({ length: 4 }, (_, index) => line(index)) }).metrics
  for (const metric of ['onTime', 'inFull', 'otif', 'rejection']) assert.equal(four[metric].rate, null, `${metric} with 4 lines`)
  const five = summarizeScorecardLines({ lines: Array.from({ length: 5 }, (_, index) => line(index)) }).metrics
  assert.equal(five.onTime.rate, 1)

  // On the supplier dashboard: Acme has 6 orders of one line each, each with
  // its own promised date (6 deliveries, so a rate) but only 4 received lines
  // and 2 decided invoices, so no accepted or matched rate; Bolt has 2, so no
  // on-time rate.
  const promised = (id) => ({ id, sku: 'A', itemName: 'A', unit: 'pcs', orderedQuantity: 10, receivedQuantity: 0, unitPrice: 10, amount: 100, originalPromisedDate: '2026-09-20' })
  const order = (id, supplierName, lineId, day) => ({ id, supplierName, status: 'issued', currency: 'USD', totalAmount: 100, createdAt: '2026-09-02T12:00:00.000Z', expectedDate: `${day}T00:00:00.000Z`, lines: [{ ...promised(lineId), originalPromisedDate: day }] })
  const receipt = (poId, supplierName, lineId) => ({ id: `GRN-${lineId}`, poId, supplierName, status: 'received', postingStatus: 'posted', arrivedAt: '2026-09-09T15:00:00.000Z', lines: [{ purchaseOrderLineId: lineId, acceptedQty: 10, rejectedQty: 0 }] })
  const acme = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((lineId, index) => order(`PO-${lineId}`, 'Acme', lineId, `2026-09-1${index}`))
  const bolt = ['B1', 'B2'].map((lineId, index) => order(`PO-${lineId}`, 'Bolt', lineId, `2026-09-1${index}`))
  const received = (count) => [...acme.slice(0, count).map((po) => receipt(po.id, 'Acme', po.lines[0].id)), ...bolt.map((po) => receipt(po.id, 'Bolt', po.lines[0].id))]
  const matched = (id, poId) => ({ id, invoiceNumber: id, poId, supplierName: 'Acme', status: 'approved', matchStatus: 'matched', totalAmount: 100, amount: 100, currency: 'USD', invoiceDate: '2026-09-21T12:00:00.000Z', lines: [{ amount: 100 }] })
  const thin = context({
    purchaseOrders: [...acme, ...bolt],
    receipts: received(4),
    supplierInvoices: [matched('INV-1', 'PO-A'), matched('INV-2', 'PO-A')],
  })
  const report = buildRuntimeGovernedReport(thin, { subject: 'suppliers', filters: { from: '2026-09-01', to: '2026-09-30' } }, asOf)
  const chart = (id) => report.charts.find((item) => item.id === id)
  assert.deepEqual(chart('supplier_on_time').data.map((row) => row.name), ['Acme'])
  assert.ok(!chart('supplier_scorecard').seriesKeys.includes('Lines accepted in full'))
  assert.ok(!chart('supplier_scorecard').seriesKeys.includes('Invoices matched'))
  assert.ok(chart('supplier_performance_matrix').data.every((row) => row.name !== 'Bolt'))
  // With a fifth received line, Acme's accepted rate is shown.
  const enough = { ...thin, receipts: received(5) }
  const shown = buildRuntimeGovernedReport(enough, { subject: 'suppliers', filters: { from: '2026-09-01', to: '2026-09-30' } }, asOf)
  assert.ok(shown.charts.find((item) => item.id === 'supplier_scorecard').seriesKeys.includes('Lines accepted in full'))
})

// English to Chinese maps: every entry has Chinese, and no two English
// entries share one Chinese text, so the reverse map loses none.
function assertPaired(name, pairs) {
  const byChinese = new Map()
  for (const [english, chinese] of Object.entries(pairs)) {
    assert.ok(english && !CJK.test(english), `${name}: "${english}" is not English`)
    assert.ok(chinese && CJK.test(chinese), `${name}: "${english}" has no Chinese`)
    assert.ok(!byChinese.has(chinese), `${name}: "${english}" and "${byChinese.get(chinese)}" share "${chinese}"`)
    byChinese.set(chinese, english)
  }
}

test('rule 5: the reports and supplier copy have English and Chinese for every entry', () => {
  assertPaired('analyticsCopy', analyticsCopyPairs)
  assertPaired('supplierCopy', supplierCopyPairs)
  for (const [english, chinese] of Object.entries(analyticsCopyPairs)) assert.equal(analyticsCopy(chinese, 'en-US'), english)
  // The English labels a KPI shows when it has no total (mixed units, several
  // SKUs, too few lines) have Chinese. The Chinese-source ones are translated
  // by the dashboard's own map (BiDashboard.tsx).
  const scope = { currencyCode: null, currencyAggregationStatus: 'multi_currency_unconverted' }
  const kpi = (extra) => ({ id: 'k', label: 'k', unit: 'number', currentValue: null, dataStatus: 'complete', limitations: [], ...extra })
  const labels = [
    kpi({ limitations: ['inventory_units_mixed'] }), kpi({ limitations: ['sales_demand_skus_mixed'] }), kpi({ dataStatus: 'restricted' }),
    kpi({ limitations: ['insufficient_sample'] }), kpi({ limitations: ['period_too_long'] }), kpi({ dataStatus: 'no_records' }),
    kpi({ unit: 'currency', currencyAggregationStatus: 'no_currency_data' }), kpi({ unit: 'currency', currencyAggregationStatus: 'multi_currency_unconverted' }),
    kpi({ unit: 'currency', currencyAggregationStatus: 'currency_unknown' }), kpi({ dataStatus: 'incomplete' }),
  ].map((item) => metricDisplayValue(item, scope, { locale: 'en-US', language: 'en-US' }))
  assert.equal(new Set(labels).size, labels.length)
  const english = [...labels, 'Single currency', 'Filtered currency'].filter((label) => !CJK.test(label))
  // The too-few label is taken from the display code, whatever its wording.
  assert.ok(english.includes('Mixed units') && english.includes('Multiple SKUs') && english.includes(labels[3]))
  for (const label of english) {
    assert.match(analyticsCopy(label, 'zh-CN'), CJK, `"${label}" in Chinese`)
    assert.equal(analyticsCopy(label, 'en-US'), label)
  }
})

test('rule 5: the inventory operations copy has both languages for every entry and code', () => {
  for (const [chinese, english] of Object.entries(inventoryEnglish)) {
    assert.ok(CJK.test(chinese) || /：/.test(chinese), `"${chinese}" is a Chinese source string`)
    assert.ok(english && !CJK.test(english), `"${chinese}" has English`)
  }
  for (const [english, chinese] of Object.entries(inventoryChinese)) assert.ok(chinese && CJK.test(chinese), `"${english}" has Chinese`)
  const zh = (code) => chineseCodes[code] || inventoryChinese[code] || statusCodeLabel(code, 'zh-CN')
  const en = (code) => englishCodes[code] || statusCodeLabel(code, 'en-US')
  for (const code of Object.keys(englishCodes)) assert.match(String(zh(code) || ''), CJK, `code ${code} has Chinese`)
  for (const code of Object.keys(chineseCodes)) assert.ok(en(code) && !CJK.test(en(code)), `code ${code} has English`)
})
