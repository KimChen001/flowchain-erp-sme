import { buildRuntimeGovernedReport, getRuntimeReportCatalog } from '../domain/runtime-report-read-model.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { buildOpenPurchaseOrdersReport } from '../domain/open-purchase-orders-report.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'
import { createSupplierScorecardReadService } from '../domain/supplier-scorecard.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'
import { createReorderListReadService } from '../domain/reorder-list-read-service.mjs'
import { buildRuntimeInventoryAllocation } from '../domain/runtime-inventory-allocation-read-model.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'

// The dashboards with their own subject; any other subject reads as the overview.
const DASHBOARD_SUBJECTS = new Set(['overview', 'procurement', 'sales', 'inventory', 'finance', 'suppliers'])

export async function handleReportsAnalyticsRoute(ctx) {
  try { return await routeReports(ctx) } catch (error) { sendReadAccessError(ctx, error); return true }
}

async function routeReports(ctx) {
  const { req, res, url, send, readBody } = ctx
  // The business read context as the signed-in reader may see it, and the
  // unscoped context for each SKU's reserved and available quantity.
  // Inventory is read in the reader's warehouses only, so availability counts
  // every order's demand against the stock the reader may see.
  const readerContext = async () => {
    const access = await reportReadAccess(ctx)
    const context = await readBusinessContext(ctx, { warehouseIds: access.warehouseIds })
    return { context: scopeBusinessContext(context, access), allocationContext: context, warehouseIds: access.warehouseIds, access }
  }

  if (req.method === 'GET' && url.pathname === '/api/reports/open-purchase-orders') {
    if (ctx.repositories && !ctx.identity?.tenantId) { send(res, 403, { error: 'Workspace identity is required.' }); return true }
    const access = await reportReadAccess(ctx)
    if (!access.collections.purchaseOrders) { send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view purchase orders.', details: { permission: 'procurement.purchase_order.read' } }); return true }
    const repository = ctx.repositories?.procurementRuntime
    const rows = repository?.listForReport
      ? await repository.listForReport({ tenantId: ctx.identity?.tenantId })
      : !ctx.repositories && ctx.db ? (await readBusinessContext(ctx)).purchaseOrders : null
    const visibleRows = rows && !access.prices ? scopeBusinessContext({ purchaseOrders: rows }, { ...access, collections: {} }).purchaseOrders : rows
    if (!rows) { send(res, 503, { error: 'Purchase order reporting is unavailable.' }); return true }
    try {
      send(res, 200, buildOpenPurchaseOrdersReport(visibleRows, Object.fromEntries(url.searchParams.entries()), ctx.reportNow || new Date(), { timeZone: await readTenantTimezone(ctx) }))
    } catch (error) {
      if (error.code !== 'REPORT_DATE_RANGE_INVALID') throw error
      send(res, 422, { error: error.message, code: error.code })
    }
    return true
  }

  // Supplier delivery scorecard, measured against each line's original
  // promised date. ?from&to (YYYY-MM-DD, default the last 90 days), graceDays,
  // supplierId. The service checks the reader's permissions.
  if (req.method === 'GET' && url.pathname === '/api/reports/supplier-scorecard') {
    if (!ctx.identity?.authenticated || !ctx.identity.tenantId) { send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }); return true }
    try {
      const service = ctx.repositories?.supplierScorecard || createSupplierScorecardReadService({ prisma: await getPrismaClient(ctx.env || process.env) })
      send(res, 200, await service.read(Object.fromEntries(url.searchParams.entries()), { identity: ctx.identity }))
    } catch (error) {
      if (!error?.status) throw error
      send(res, error.status, { code: error.code || 'SUPPLIER_SCORECARD_FAILED', message: error.message, details: Array.isArray(error.details) ? error.details : [] })
    }
    return true
  }
  // Overdue counts use the workspace's calendar day. On-time deliveries count the
  // receipts in the reader's warehouses, as the supplier scorecard does.
  const reportOptions = async (allocationContext, warehouseIds) => ({ now: ctx.reportNow || new Date(), timeZone: await readTenantTimezone(ctx), allocationContext, warehouseIds })
  // The overview adds the reorder list's "order now" count, read as the
  // reorder list and Today read it, so the three agree. It is left out when
  // the reader cannot see stock or sees only some warehouses (the list does
  // not judge items then), or the database cannot be read.
  const overviewOptions = async (reader, subject) => {
    const options = await reportOptions(reader.allocationContext, reader.warehouseIds)
    if (DASHBOARD_SUBJECTS.has(subject) && subject !== 'overview') return options
    return { ...options, reorder: await reorderSummary(reader, options) }
  }
  const reorderSummary = async ({ allocationContext, access }, { now, timeZone }) => {
    if (!access.collections.inventoryItems || !ctx.identity?.tenantId) return null
    try {
      const env = ctx.env || process.env
      const prisma = ctx.reportsPrisma || ctx.inventoryPrisma || (env.DATABASE_URL ? await getPrismaClient(env) : null)
      if (!prisma) return null
      const list = await createReorderListReadService({ prisma }).read({
        tenantId: ctx.identity.tenantId,
        warehouseIds: access.warehouseIds ?? null,
        today: tenantCalendarDay(now, timeZone),
        timeZone,
        allocationRows: buildRuntimeInventoryAllocation(allocationContext).availability,
        showPurchaseOrders: Boolean(access.collections.purchaseOrders),
        truncatedSubjects: (allocationContext.truncatedSubjects || []).filter((entry) => ['inventory_items', 'sales_orders', 'purchase_orders'].includes(entry?.subject)),
      })
      return list.scope?.kind === 'all_warehouses' ? { orderNow: list.summary.orderNow } : null
    } catch {
      return null
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/reports-analytics') {
    const reader = await readerContext()
    send(res, 200, buildRuntimeGovernedReport(reader.context, { subject: 'overview' }, await overviewOptions(reader, 'overview')))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/reports/catalog') {
    send(res, 200, getRuntimeReportCatalog())
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/reports/query') {
    const body = await readBody(req)
    const reader = await readerContext()
    send(res, 200, buildRuntimeGovernedReport(reader.context, body, await overviewOptions(reader, body?.subject)))
    return true
  }

  const dashboardMatch = url.pathname.match(/^\/api\/reports\/(overview|procurement|sales|inventory|finance|suppliers)$/)
  if (req.method === 'GET' && dashboardMatch) {
    const filters = Object.fromEntries(url.searchParams.entries())
    const reader = await readerContext()
    send(res, 200, buildRuntimeGovernedReport(reader.context, { subject: dashboardMatch[1], filters }, await overviewOptions(reader, dashboardMatch[1])))
    return true
  }

  return false
}
