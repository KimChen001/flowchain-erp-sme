import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { summarizeScorecardLines } from './supplier-scorecard.mjs'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'
import { buildAiSupplierOperationalResponse } from './ai-supplier-operational-query.mjs'
import { createAiUserScenarioDb } from './test-fixtures/ai-user-scenario.mjs'
import { analyticsCopy, analyticsCopyPairs } from '../../src/modules/reports/analyticsCopy.ts'
import { reportWorkbook } from '../../src/modules/reports/reportWorkbook.ts'
import { metricDisplayValue } from '../../src/modules/reports/metricDisplay.ts'
import { supplierCopyPairs } from '../../src/modules/srm/supplierCopy.ts'
import { contractCopy, contractCopyPairs } from '../../src/modules/contracts/contractCopy.ts'
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
    // A money KPI over records in two currencies has no value; the amounts are
    // kept per currency. A money KPI over records in one currency (the
    // overview's sales amount beside mixed purchase orders) is that currency's total.
    for (const kpi of report.kpis.filter((item) => item.unit === 'currency')) {
      if (kpi.currencyAmounts.length > 1) assert.equal(kpi.currentValue, null, `${subject} ${kpi.id}`)
      else assert.equal(kpi.currentValue, kpi.currencyAmounts[0]?.amount ?? 0, `${subject} ${kpi.id}`)
    }
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

test('rule 4: no supplier rate is shown below the minimum sample of 5', () => {
  // One line per PO, so each line is its own delivery (scorecard v3 counts deliveries).
  const line = (index, extra = {}) => ({ purchaseOrderId: `PO${index}`, purchaseOrderLineId: `L${index}`, originalPromisedDate: '2026-09-20', unit: 'pcs', orderedQuantity: 10, receivedQuantity: 10, rejectedQuantity: 0, onTime: true, onTimeCurrent: true, inFull: true, inFullPending: false, otif: true, otifCurrent: true, early: false, daysLate: 0, ...extra })
  const four = summarizeScorecardLines({ lines: Array.from({ length: 4 }, (_, index) => line(index)) }).metrics
  for (const metric of ['onTime', 'inFull', 'otif', 'rejection']) assert.equal(four[metric].rate, null, `${metric} with 4 deliveries`)
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

test('rule 5: the reports, supplier and contract copy have English and Chinese for every entry', () => {
  assertPaired('analyticsCopy', analyticsCopyPairs)
  assertPaired('supplierCopy', supplierCopyPairs)
  assertPaired('contractCopy', contractCopyPairs)
  // English is the source text; Chinese keeps every {placeholder}.
  for (const [english, chinese] of Object.entries(contractCopyPairs)) {
    assert.equal(contractCopy(english, 'en-US'), english)
    assert.equal(contractCopy(english, 'zh-CN'), chinese)
    assert.deepEqual((chinese.match(/\{\w+\}/g) || []).sort(), (english.match(/\{\w+\}/g) || []).sort(), `contractCopy: "${english}" keeps its placeholders`)
  }
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
