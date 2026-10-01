import { buildRuntimeGovernedReport, getRuntimeReportCatalog } from '../domain/runtime-report-read-model.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { buildOpenPurchaseOrdersReport } from '../domain/open-purchase-orders-report.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'

export async function handleReportsAnalyticsRoute(ctx) {
  const { req, res, url, send, readBody } = ctx

  if (req.method === 'GET' && url.pathname === '/api/reports/open-purchase-orders') {
    if (ctx.repositories && !ctx.identity?.tenantId) { send(res, 403, { error: 'Workspace identity is required.' }); return true }
    const repository = ctx.repositories?.procurementRuntime
    const rows = repository?.listForReport
      ? await repository.listForReport({ tenantId: ctx.identity?.tenantId })
      : !ctx.repositories && ctx.db ? (await readBusinessContext(ctx)).purchaseOrders : null
    if (!rows) { send(res, 503, { error: 'Purchase order reporting is unavailable.' }); return true }
    try {
      send(res, 200, buildOpenPurchaseOrdersReport(rows, Object.fromEntries(url.searchParams.entries()), ctx.reportNow || new Date(), { timeZone: await readTenantTimezone(ctx) }))
    } catch (error) {
      if (error.code !== 'REPORT_DATE_RANGE_INVALID') throw error
      send(res, 422, { error: error.message, code: error.code })
    }
    return true
  }

  // Overdue counts use the workspace's calendar day.
  const reportOptions = async () => ({ now: ctx.reportNow || new Date(), timeZone: await readTenantTimezone(ctx) })

  if (req.method === 'GET' && url.pathname === '/api/reports-analytics') {
    send(res, 200, buildRuntimeGovernedReport(await readBusinessContext(ctx), { subject: 'overview' }, await reportOptions()))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/reports/catalog') {
    send(res, 200, getRuntimeReportCatalog())
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/reports/query') {
    const body = await readBody(req)
    send(res, 200, buildRuntimeGovernedReport(await readBusinessContext(ctx), body, await reportOptions()))
    return true
  }

  const dashboardMatch = url.pathname.match(/^\/api\/reports\/(overview|procurement|sales|inventory|finance|suppliers)$/)
  if (req.method === 'GET' && dashboardMatch) {
    const filters = Object.fromEntries(url.searchParams.entries())
    send(res, 200, buildRuntimeGovernedReport(await readBusinessContext(ctx), { subject: dashboardMatch[1], filters }, await reportOptions()))
    return true
  }

  return false
}
