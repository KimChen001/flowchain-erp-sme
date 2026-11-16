import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The supplier on-time copy in both languages: it counts deliveries, and until
// suppliers confirm dates it names the date on the PO, which may be the buyer's
// need date.

const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const panel = source('src/modules/srm/supplierPerformance.tsx')

let bundles
async function loadModules() {
  if (bundles) return bundles
  bundles = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'supplier-copy-'))
    const load = async (entry, name) => {
      const outfile = path.join(dir, `${name}.mjs`)
      await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
      return import(pathToFileURL(outfile).href)
    }
    const insights = await load('src/modules/reports/reportInsights.ts', 'insights')
    const analytics = await load('src/modules/reports/analyticsCopy.ts', 'analytics')
    const supplier = await load('src/modules/srm/supplierCopy.ts', 'supplier')
    return { insights, analytics, supplier, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return bundles
}

test.after(async () => {
  if (!bundles) return
  await (await bundles).cleanup()
})

const suppliersReport = () => ({
  kpis: [],
  charts: [
    { id: 'supplier_on_time', data: [{ name: 'Acme', value: 66.7 }, { name: 'Bolt', value: 40 }] },
    {
      id: 'supplier_performance_matrix',
      measures: [{ key: 'Committed amount', axis: 'x' }, { key: 'On-time deliveries', axis: 'y' }],
      guides: { x: 100, y: 53.4 },
      data: [{ name: 'Acme', 'Committed amount': 300, 'On-time deliveries': 66.7 }, { name: 'Bolt', 'Committed amount': 200, 'On-time deliveries': 40 }],
    },
  ],
})

test('the Suppliers dashboard insights count deliveries on time, in English and Chinese', async () => {
  const { insights } = await loadModules()
  const options = (language) => ({ language, format: (value) => `${value}%`, category: (_chart, name) => name })
  const en = insights.reportInsights('suppliers', suppliersReport(), options('en-US'))
  assert.deepEqual(en.map((item) => item.text), [
    'Acme has the highest share of deliveries on time (66.7%); Bolt the lowest (40%).',
    'Bolt combines at least median spend with a below-average share of deliveries on time.',
  ])
  const zh = insights.reportInsights('suppliers', suppliersReport(), options('zh-CN'))
  assert.deepEqual(zh.map((item) => item.text), [
    'Acme 的准时交付占比最高（66.7%），Bolt 最低（40%）。',
    'Bolt 的采购额不低于中位数，但准时交付占比低于平均值。',
  ])
  for (const item of [...en, ...zh]) assert.doesNotMatch(item.text, /lines on time|准时行/)
})

test("the on-time KPI definition names the buyer's need date in both languages", async () => {
  const { analytics } = await loadModules()
  const [, definition] = source('server/domain/runtime-report-read-model.mjs').match(/on_time_receipt_rate: \['On-time deliveries \(date on the PO\)', 'receipts', 'percentage', "([^"]+)"/)
  assert.match(definition, /buyer's need date/)
  assert.match(analytics.analyticsCopy(definition, 'zh-CN'), /采购方的需求日期/)
  // Orders approved but never sent are not measured, in both languages.
  assert.match(definition, /not sent to the supplier are left out/)
  assert.match(analytics.analyticsCopy(definition, 'zh-CN'), /已批准但未下达的采购订单不计入/)
})

test("the supplier performance panel and table show the PO-date basis in both languages", () => {
  const copy = (key) => JSON.parse(`[${panel.match(new RegExp(`\\b${key}: (\\[".*?", ".*?"\\])`))[1].slice(1, -1)}]`)
  const [en, zh] = copy('basisNote')
  assert.match(en, /buyer's need date/)
  assert.match(zh, /采购方的需求日期/)
  // Rendered on the Performance tab and in Reports › Supplier analytics.
  assert.equal(panel.match(/data\?\.rules\.promiseBasis === "po_date" && <span data-testid="supplier-performance-basis"> \{tr\("basisNote"\)\}<\/span>/g)?.length, 2)
  // Only POs the supplier got count (owner decision 2026-10-06); a PO approved
  // but not sent is listed apart. A closed line never received is late.
  assert.match(panel, /only POs the supplier actually got count: issued to the supplier, or with a posted receipt/)
  assert.match(panel, /已批准但未下达且没有收货的采购订单不计入任何指标/)
  assert.doesNotMatch(panel, /even before it is sent|即使尚未发送给供应商/)
  assert.deepEqual(copy('notSent'), ['Not sent to supplier: {n}', '未下达：{n} 张'])
  assert.match(panel, /a line closed with nothing received counts as late/)
  // Settled-sample and waiting copy is distinct from "Fewer than 5 deliveries".
  assert.deepEqual(copy('fewerSettled'), ['Fewer than 5 settled deliveries', '已判定的交付少于 5 次'])
  assert.deepEqual(copy('waiting'), ['No deliveries judged yet; {n} waiting for lines not yet due', '暂无已判定的交付；{n} 次交付仍有行未到期'])
  assert.deepEqual(copy('multipleSkus'), ['Multiple SKUs', '多个 SKU'])
})

test("the supplier list's 90-day on-time column says it counts deliveries against the date on the PO", async () => {
  const { supplier } = await loadModules()
  const tooltip = "{count} of {of} deliveries on time against the date on the PO, which may be the buyer's need date"
  // The list and Supplier evaluation share the cell (supplierMetrics.tsx).
  assert.ok(source('src/modules/srm/supplierMetrics.tsx').includes(`"${tooltip}"`))
  assert.ok(source('src/modules/srm/Page.tsx').includes('useSupplierMetricCells()'))
  assert.equal(supplier.supplierCopy(tooltip, 'zh-CN'), '{of} 次交付中 {count} 次按采购订单日期准时（该日期可能是采购方的需求日期）')
  // The header is short; its tooltip says the date is the one on the PO.
  assert.equal(supplier.supplierCopy('On time, 90 days', 'zh-CN'), '90 天准时率')
  const headerTip = "Share of deliveries received by the date on the PO, over the last 90 days. That date may be the buyer's need date."
  assert.ok(source('src/modules/srm/supplierMetrics.tsx').includes(`ON_TIME_HEADER_TIP = "${headerTip}"`))
  // Each metric header's tip comes from one table both pages read.
  assert.ok(source('src/modules/srm/supplierMetrics.tsx').includes('"On time, 90 days": ON_TIME_HEADER_TIP'))
  assert.ok(source('src/modules/srm/Page.tsx').includes('copy(METRIC_HEADER_TIPS[h])'))
  assert.ok(source('src/modules/srm/SupplierEvaluationPage.tsx').includes('t(METRIC_HEADER_TIPS[label])'))
  assert.equal(supplier.supplierCopy(headerTip, 'zh-CN'), '最近 90 天内按采购订单上的日期收货的交付占比；该日期可能是采购方的需求日期。')
})

// Design audit C7: OTIF beside on time (L9-03), the counts below the
// minimum sample (L9-13), the deliveries withheld for warehouses the reader
// cannot see (L9-06), incomplete spend (L9-17), and what "Overdue POs" and
// "Open issues" count (L9-14, L9-18), each in English and Chinese.
test('the OTIF column, sample counts, withheld deliveries and header tips are in both languages', async () => {
  const { supplier } = await loadModules()
  const metrics = source('src/modules/srm/supplierMetrics.tsx')
  for (const page of ['src/modules/srm/Page.tsx', 'src/modules/srm/SupplierEvaluationPage.tsx']) {
    assert.ok(source(page).includes('"OTIF, 90 days"'), page)
    assert.ok(source(page).includes('otifCell('), page)
  }
  const pairs = {
    'OTIF, 90 days': '90 天准时足量率',
    'OTIF, lowest first': '准时足量率从低到高',
    "{count} of {of} deliveries on time and in full against the date on the PO, which may be the buyer's need date": '{of} 次交付中 {count} 次按采购订单日期准时且足量（该日期可能是采购方的需求日期）',
    'A percentage needs 5 deliveries.': '至少 5 次交付才计算百分比。',
    '{n} deliveries received in warehouses you cannot see are left out.': '有 {n} 次交付在你无权查看的仓库收货，未计入。',
    'Some orders in the last 12 months have no amount on record, so this total leaves them out.': '近 12 个月有订单没有记录金额，此合计未包含这些订单。',
    'Open purchase orders sent to the supplier and past their promised date today.': '已发给供应商、截至今天已过承诺交期的未结采购订单。',
    'Receipts with rejections and invoice variances still open. Overdue orders are counted under Overdue POs.': '仍未结的拒收收货和发票差异。逾期订单计入“逾期 PO”，不在此重复计算。',
  }
  for (const [english, chinese] of Object.entries(pairs)) {
    assert.equal(supplier.supplierCopy(english, 'zh-CN'), chinese)
    assert.equal(supplier.supplierCopy(chinese, 'en-US'), english)
  }
  for (const english of ['A percentage needs 5 deliveries.', '{n} deliveries received in warehouses you cannot see are left out.', 'Open purchase orders sent to the supplier and past their promised date today.']) assert.ok(metrics.includes(english), english)
})
