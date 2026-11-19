import { readerApprovalStanding, withCanApprove } from '../domain/approval-rights.mjs'

export async function handlePurchaseRequestsRoute(ctx) {
  const { req, res, url, send, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/purchase-requests') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }) || true
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' }) || true
    const snapshot = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    return send(res, 200, withCanApprove(snapshot.purchaseRequests, 'purchase_request', await readerApprovalStanding(ctx, ['purchase_request']))) || true
  }

  return false
}
