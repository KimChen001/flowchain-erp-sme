import { canReadProcurementDocument, maskProcurementSnapshot, procurementReadAccess } from '../domain/procurement-read-access.mjs'
import { purchaseOrderWorkbenchSummary } from '../domain/purchase-order-workbench-summary.mjs'
import { purchaseOrderLinesProjection, purchaseOrderListProjection } from '../domain/purchase-order-lines-projection.mjs'

export async function handlePurchaseOrdersRoute(ctx) {
  const { req, res, url, send, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/purchase-orders') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }) || true
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' }) || true
    const access = await procurementReadAccess(ctx)
    if (!canReadProcurementDocument('po', access)) return send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view purchase orders.', details: [] }) || true
    const snapshot = maskProcurementSnapshot(await repositories.procurementRead.snapshot({ tenantId: identity.tenantId }), access)
    return send(res, 200, snapshot.purchaseOrders) || true
  }

  if (req.method === 'GET' && url.pathname === '/api/purchase-orders-workbench') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }) || true
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' }) || true
    const access = await procurementReadAccess(ctx)
    if (!canReadProcurementDocument('po', access)) return send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view purchase orders.', details: [] }) || true
    const loaded = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    const snapshot = maskProcurementSnapshot(loaded, access)
    // The Order lines page reads only the line fields.
    if (url.searchParams.get('view') === 'lines') return send(res, 200, purchaseOrderLinesProjection(snapshot)) || true
    // Counts from the orders; the committed value only when prices are visible.
    const summary = purchaseOrderWorkbenchSummary(loaded.purchaseOrders)
    const workbench = {
      purchaseOrders: snapshot.purchaseOrders,
      receivingDocs: snapshot.receivingDocs,
      supplierInvoices: snapshot.supplierInvoices,
      documentLinks: snapshot.documentLinks,
      procurementFollowups: snapshot.procurementFollowups,
      summary: access.prices ? summary : { ...summary, committedValueByCurrency: null, restrictedFields: ['amounts'] },
    }
    // The PO list reads the headers and only the line fields it searches and totals.
    if (url.searchParams.get('view') === 'list') return send(res, 200, { ...purchaseOrderListProjection(workbench), summary: workbench.summary }) || true
    return send(res, 200, workbench) || true
  }

  // One order for the PO detail page: the same checks and masking as the
  // workbench above, the same record shapes, and only this order's receipts,
  // invoices, links and follow-ups. An order of another workspace answers
  // exactly as an unknown id does.
  const workbenchOrderMatch = url.pathname.match(/^\/api\/purchase-orders-workbench\/([^/]+)$/)
  if (req.method === 'GET' && workbenchOrderMatch) {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }) || true
    if (!repositories?.procurementRead?.purchaseOrderWorkbench) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' }) || true
    const access = await procurementReadAccess(ctx)
    if (!canReadProcurementDocument('po', access)) return send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view purchase orders.', details: [] }) || true
    let id
    try { id = decodeURIComponent(workbenchOrderMatch[1]) } catch { return send(res, 400, { code: 'INVALID_PURCHASE_ORDER_ID', message: 'The purchase order id is not valid.' }) || true }
    const loaded = await repositories.procurementRead.purchaseOrderWorkbench({ tenantId: identity.tenantId, id })
    if (!loaded) return send(res, 404, { code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Purchase order not found.' }) || true
    const snapshot = maskProcurementSnapshot(loaded, access)
    return send(res, 200, {
      purchaseOrder: snapshot.purchaseOrders[0],
      receivingDocs: snapshot.receivingDocs,
      supplierInvoices: snapshot.supplierInvoices,
      documentLinks: snapshot.documentLinks,
      procurementFollowups: snapshot.procurementFollowups,
    }) || true
  }

  return false
}
