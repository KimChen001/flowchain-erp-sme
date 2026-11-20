import { SUPPLIER_RELIABILITY_ROUTE } from '../../shared/supplier-reliability-contract.mjs'
import { createSupplierReliabilityReadService } from '../domain/supplier-reliability.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

// Every supplier's reliability figures for the supplier evaluation page
// (docs/supplier-reply-dates-design.md §4.12; shape in
// shared/supplier-reliability-contract.mjs), for the signed-in reader: what
// they may not read comes back null. Read once per page load, as
// /api/master-data/supplier-insights is.
//   GET /api/master-data/supplier-reliability
export async function handleSupplierReliabilityRoute(ctx) {
  const { req, res, send, url } = ctx
  if (req.method === 'GET' && url.pathname === SUPPLIER_RELIABILITY_ROUTE) {
    if (!ctx.identity?.authenticated) {
      send(res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to read supplier reliability.' })
      return true
    }
    try {
      const service = ctx.supplierReliabilityService || createSupplierReliabilityReadService({ prisma: await getPrismaClient(ctx.env || process.env) })
      send(res, 200, await service.read({ identity: ctx.identity }))
    } catch (error) {
      if (error?.status === 401) send(res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to read supplier reliability.' })
      else send(res, 500, { code: 'SUPPLIER_RELIABILITY_UNAVAILABLE', message: 'Supplier reliability is unavailable. Try again.' })
    }
    return true
  }
  return false
}
