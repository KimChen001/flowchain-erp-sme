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
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { permissionCodes } from '../auth/permission-catalog.mjs'

// A reader who may see everything.
const fullReportAccess = reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-any', permissionCodes: new Set(permissionCodes) })

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
    readBody: async () => ({ subject: 'inventory' }), reportReadAccess: fullReportAccess, send(_res, status, payload) { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  assert.equal(response.status, 200)
  assert.equal(metric(response.payload).currentValue, null)

  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const dashboard = await readFile(join(root, 'src/modules/reports/BiDashboard.tsx'), 'utf8')
  const currencyFormatting = await readFile(join(root, 'src/modules/reports/currencyFormatting.mjs'), 'utf8')
  assert.match(currencyFormatting, /if \(value === null\) return '—'/)
  // KPI values read the same on the dashboard and in the export (metricDisplay.ts).
  const metricDisplay = await readFile(join(root, 'src/modules/reports/metricDisplay.ts'), 'utf8')
  assert.match(metricDisplay, /import \{ formatMetric \} from '\.\/currencyFormatting\.mjs'/)
  assert.match(metricDisplay, /if \(item\.dataStatus === 'incomplete'\) return '数据不足'/)
  assert.match(dashboard, /import \{ metricCurrency, metricDisplayValue \} from "\.\/metricDisplay"/)
  assert.match(dashboard, /item\.dataStatus === "incomplete" \? copy\([^;]*"库存数据不完整"\)/)
  // A chart value that is not recorded stays empty in the visual and its data table; it never becomes 0.
  const { chartTable } = await import('../../src/modules/reports/charts/chartTable.ts')
  const { chartOption } = await import('../../src/modules/reports/charts/chartOptions.ts')
  const chart = { id: 'inventory_on_hand_by_sku', title: 'On hand by SKU', type: 'horizontal_bar', data: [{ name: 'SKU-KNOWN', value: 4 }, { name: 'SKU-UNKNOWN', value: null }], drilldownPath: '/app/inventory' }
  const labels = { copy: value => value, category: (_chart, value) => value }
  assert.deepEqual(chartTable(chart, labels).rows.map(row => row.values[0]), [4, null])
  const option = chartOption(chart, { ...labels, format: String, compact: String, ratio: String, language: 'en-US' })
  assert.deepEqual(option.series[0].data.map(point => point.value), [4, null])
})
