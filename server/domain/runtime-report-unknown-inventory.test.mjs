import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { searchRuntimeBusinessContext } from './runtime-business-search.mjs'
import { businessContextToReadDb } from '../services/runtime-business-read-service.mjs'
import { handleReportsAnalyticsRoute } from '../routes/reports-analytics.routes.mjs'

const context = inventoryItems => ({
  items: inventoryItems.map(row => ({ sku: row.sku, itemName: row.sku })), inventoryItems,
  salesOrders: [], purchaseOrders: [], supplierInvoices: [], suppliers: [], customers: [],
  purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [], itemSupplierRelationships: [], dataLimitations: [],
})
const metric = report => report.kpis.find(row => row.id === 'inventory_on_hand')

test('inventory_on_hand distinguishes empty, complete, and incomplete runtime data', () => {
  const empty = buildRuntimeGovernedReport(context([]), { subject: 'inventory' })
  assert.equal(metric(empty).currentValue, 0)
  assert.equal(metric(empty).value, 0)
  assert.equal(metric(empty).dataStatus, 'empty')

  const complete = buildRuntimeGovernedReport(context([
    { sku: 'SKU-4', onHandQuantity: 4 },
    { sku: 'SKU-6', onHandQuantity: 6 },
  ]), { subject: 'inventory' })
  assert.equal(metric(complete).currentValue, 10)
  assert.equal(metric(complete).dataStatus, 'complete')

  const incompleteContext = context([
    { sku: 'SKU-KNOWN', onHandQuantity: 4 },
    { sku: 'SKU-UNKNOWN' },
  ])
  const incomplete = buildRuntimeGovernedReport(incompleteContext, { subject: 'inventory' })
  assert.equal(metric(incomplete).currentValue, null)
  assert.equal(metric(incomplete).value, null)
  assert.equal(metric(incomplete).dataStatus, 'incomplete')
  assert.ok(metric(incomplete).limitations.includes('inventory_on_hand_incomplete'))
  assert.ok(incomplete.limitations.includes('inventory_on_hand_incomplete'))
  assert.equal(JSON.parse(JSON.stringify(incomplete)).kpis.find(row => row.id === 'inventory_on_hand').currentValue, null)

  const chart = incomplete.charts[0]
  assert.deepEqual(chart.data, [{ name: 'SKU-KNOWN', value: 4 }])
  assert.equal(chart.data.some(row => row.name === 'SKU-UNKNOWN' || row.value === 0 || row.value === 1), false)

  const allocation = buildRuntimeInventoryAllocation(incompleteContext)
  assert.equal(allocation.availability.find(row => row.sku === 'SKU-UNKNOWN').onHand, null)
  assert.equal(searchRuntimeBusinessContext(incompleteContext, 'SKU-UNKNOWN')[0].entityType, 'item')
  assert.equal(incompleteContext.inventoryItems[1].onHandQuantity, undefined)
  assert.equal(businessContextToReadDb(incompleteContext).products.find(row => row.sku === 'SKU-UNKNOWN').currentStock, undefined)
})

test('reports API and KPI UI preserve null and present data insufficiency without flat comparison', async () => {
  let response
  await handleReportsAnalyticsRoute({
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('/api/reports/query', 'http://local'),
    db: { __dataMode: 'user', inventoryItems: [{ sku: 'SKU-KNOWN', onHandQuantity: 4 }, { sku: 'SKU-UNKNOWN' }], products: [], salesOrders: [], purchaseOrders: [], suppliers: [], supplierInvoices: [] },
    readBody: async () => ({ subject: 'inventory' }), send(_res, status, payload) { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  assert.equal(response.status, 200)
  assert.equal(metric(response.payload).currentValue, null)

  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const dashboard = await readFile(join(root, 'src/modules/reports/BiDashboard.tsx'), 'utf8')
  const currencyFormatting = await readFile(join(root, 'src/modules/reports/currencyFormatting.mjs'), 'utf8')
  assert.match(currencyFormatting, /if \(value === null\) return '—'/)
  assert.match(dashboard, /import \{ formatMetric \} from "\.\/currencyFormatting\.mjs"/)
  assert.match(dashboard, /if \(item\.dataStatus === "incomplete"\) return "数据不足"/)
  assert.match(dashboard, /item\.dataStatus === "incomplete" \? copy\("库存数据不完整"\)/)
  assert.match(dashboard, /\?\.value \?\? null/)
  assert.doesNotMatch(dashboard, /\?\.value \|\| 0/)
})
