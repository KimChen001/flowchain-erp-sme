import { searchRuntimeBusinessContext } from '../domain/runtime-business-search.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'

export async function handleSearchRoute(ctx) {
  const { req, res, url, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim()
    const limit = Number(url.searchParams.get('limit') || 15)
    // Search only what the reader may read: collections their role cannot
    // open are empty, hidden amounts are null (so a query cannot match them),
    // and inventory comes from the reader's warehouses.
    let context
    try {
      const access = await reportReadAccess(ctx)
      context = scopeBusinessContext(await readBusinessContext(ctx, { warehouseIds: access.warehouseIds }), access)
    } catch (error) { sendReadAccessError(ctx, error); return true }
    const results = query ? searchRuntimeBusinessContext(context, query, { limit }) : []
    send(res, 200, { query, results, total: results.length, restrictedSubjects: context.restrictedSubjects, dataLimitations: context.dataLimitations })
    return true
  }

  return false
}
