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
    return send(res, 200, await repositories.inventoryRead.listMovements({
      tenantId: identity.tenantId,
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || '',
      warehouse: url.searchParams.get('warehouse') || '',
      limit: url.searchParams.get('limit') || '',
    }))
  }

  return false
}
