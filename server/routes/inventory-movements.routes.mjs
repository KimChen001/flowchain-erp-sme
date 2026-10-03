import { reportReadAccess, sendReadAccessError } from '../domain/report-read-access.mjs'

export async function handleInventoryMovementsRoute(ctx) {
  const { req, res, url, send, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/inventory-movements') {
    if (!identity?.authenticated || !identity.tenantId) {
      return send(res, 401, {
        code: 'TENANT_CONTEXT_REQUIRED',
        message: 'An authenticated tenant context is required.',
      })
    }
    if (!repositories?.inventoryRead) {
      return send(res, 503, {
        code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE',
        capability: 'inventory-movement-read',
        message: 'The PostgreSQL inventory read model is unavailable.',
      })
    }
    // Movements need inventory.balance.read and follow the reader's warehouses.
    let access
    try { access = await reportReadAccess(ctx) } catch (error) { sendReadAccessError(ctx, error); return true }
    if (!access.collections.inventoryItems) return send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view inventory.', details: { permission: 'inventory.balance.read' } })
    return send(res, 200, await repositories.inventoryRead.listMovements({
      tenantId: identity.tenantId,
      ...(access.warehouseIds ? { warehouseIds: access.warehouseIds } : {}),
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || '',
      warehouse: url.searchParams.get('warehouse') || '',
      limit: url.searchParams.get('limit') || '',
    }))
  }

  return false
}
