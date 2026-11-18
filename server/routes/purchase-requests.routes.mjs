export async function handlePurchaseRequestsRoute(ctx) {
  const { req, res, url, send, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/purchase-requests') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }) || true
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' }) || true
    const snapshot = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    return send(res, 200, snapshot.purchaseRequests) || true
  }

  return false
}
