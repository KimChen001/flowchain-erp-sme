export async function handleRfqsRoute(ctx) {
  const { req, res, url, send, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/rfqs') {
    if (!identity?.authenticated || !identity.tenantId) {
      return send(res, 401, {
        code: 'TENANT_CONTEXT_REQUIRED',
        message: 'An authenticated tenant context is required.',
      }) || true
    }
    if (!repositories?.procurementRead) {
      return send(res, 503, {
        code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE',
        capability: 'rfq-read',
        message: 'The PostgreSQL procurement read model is unavailable.',
      }) || true
    }
    const documents = await repositories.procurementRead.listDocuments({
      type: 'rfq',
      tenantId: identity.tenantId,
    })
    return send(res, 200, documents) || true
  }

  return false
}
