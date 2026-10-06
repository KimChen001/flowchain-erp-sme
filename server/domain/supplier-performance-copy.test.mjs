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
})

test("the supplier performance panel and table show the PO-date basis in both languages", () => {
  const copy = (key) => JSON.parse(`[${panel.match(new RegExp(`\\b${key}: (\\[".*?", ".*?"\\])`))[1].slice(1, -1)}]`)
  const [en, zh] = copy('basisNote')
  assert.match(en, /buyer's need date/)
  assert.match(zh, /采购方的需求日期/)
  // Rendered on the Performance tab and in Reports › Supplier analytics.
  assert.equal(panel.match(/data\?\.rules\.promiseBasis === "po_date" && <span data-testid="supplier-performance-basis"> \{tr\("basisNote"\)\}<\/span>/g)?.length, 2)
  // An approved PO counts before it is sent; a closed line never received is late.
  assert.match(panel, /an approved PO counts from approval even before it is sent to the supplier/)
  assert.match(panel, /采购订单自审批起计入，即使尚未发送给供应商/)
  assert.match(panel, /a line closed with nothing received counts as late/)
  // Settled-sample and waiting copy is distinct from "Fewer than 5 deliveries".
  assert.deepEqual(copy('fewerSettled'), ['Fewer than 5 settled deliveries', '已判定的交付少于 5 次'])
  assert.deepEqual(copy('waiting'), ['No deliveries judged yet; {n} waiting for lines not yet due', '暂无已判定的交付；{n} 次交付仍有行未到期'])
  assert.deepEqual(copy('multipleSkus'), ['Multiple SKUs', '多个 SKU'])
})

test("the supplier list's 90-day on-time column says it counts deliveries against the date on the PO", async () => {
  const { supplier } = await loadModules()
  const tooltip = "{count} of {of} deliveries on time against the date on the PO, which may be the buyer's need date"
  assert.ok(source('src/modules/srm/Page.tsx').includes(`copy("${tooltip}")`))
  assert.equal(supplier.supplierCopy(tooltip, 'zh-CN'), '{of} 次交付中 {count} 次按采购订单日期准时（该日期可能是采购方的需求日期）')
  assert.equal(supplier.supplierCopy('On time (PO date), 90 days', 'zh-CN'), '90 天准时率（按采购订单日期）')
})
