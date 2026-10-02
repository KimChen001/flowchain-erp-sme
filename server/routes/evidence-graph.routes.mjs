import { buildRuntimeEvidenceGraph } from '../domain/runtime-evidence-graph.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'

// The business read context collection each anchor type is read from.
const ANCHOR_COLLECTION = {
  sales_order: 'salesOrders', customer_order: 'salesOrders', purchase_request: 'purchaseRequests', pr: 'purchaseRequests', rfq: 'rfqs',
  purchase_order: 'purchaseOrders', po: 'purchaseOrders', receiving_doc: 'receipts', receiving: 'receipts', grn: 'receipts',
  supplier_invoice: 'supplierInvoices', invoice: 'supplierInvoices', inventory_item: 'inventoryItems', inventory: 'inventoryItems', inventory_availability: 'inventoryItems',
}

function missingAnchor(ctx, entityType, entityId) {
  ctx.send(ctx.res, 404, { error: 'Evidence graph anchor not found', anchor: { entityType, entityId }, dataLimitations: ['record_not_found'] })
  return true
}

export async function handleEvidenceGraphRoute(ctx) {
  const { req, res, url, send } = ctx
  if (url.pathname.startsWith('/api/evidence-graph') && req.method !== 'GET') { send(res, 405, { error: 'Method not allowed' }); return true }
  if (req.method !== 'GET') return false
  let entityType = url.searchParams.get('entityType') || ''
  let entityId = url.searchParams.get('entityId') || ''
  const shortcuts = [
    [/^\/api\/evidence-graph\/sales-order\/([^/]+)$/, 'sales_order'], [/^\/api\/evidence-graph\/sku\/([^/]+)$/, 'item'],
    [/^\/api\/evidence-graph\/purchase-order\/([^/]+)$/, 'purchase_order'], [/^\/api\/evidence-graph\/purchase-request\/([^/]+)$/, 'purchase_request'],
    [/^\/api\/evidence-graph\/rfq\/([^/]+)$/, 'rfq'], [/^\/api\/evidence-graph\/receiving\/([^/]+)$/, 'receiving_doc'],
    [/^\/api\/evidence-graph\/supplier\/([^/]+)$/, 'supplier'], [/^\/api\/evidence-graph\/invoice\/([^/]+)$/, 'supplier_invoice'],
  ]
  if (!['/api/evidence-graph', '/api/evidence-graph/related'].includes(url.pathname)) {
    const matched = shortcuts.map(([pattern, type]) => ({ match: url.pathname.match(pattern), type })).find(row => row.match)
    if (!matched) return false
    entityType = matched.type; entityId = decodeURIComponent(matched.match[1])
  }
  // The graph holds only what the reader may read: nodes from collections
  // their role cannot open are left out, hidden amounts and invoice partners
  // are null, and inventory comes from the reader's warehouses.
  let context
  try {
    const access = await reportReadAccess(ctx)
    const collection = ANCHOR_COLLECTION[entityType.toLowerCase()]
    // An anchor of a type the role cannot read is refused by its type alone,
    // so the answer never tells whether that record exists.
    if (collection && !access.collections[collection]) {
      send(res, 403, { code: 'AUTHORIZATION_PERMISSION_DENIED', message: 'Your role cannot view this record.', anchor: { entityType, entityId }, restrictedSubjects: scopeBusinessContext({}, access).restrictedSubjects })
      return true
    }
    context = scopeBusinessContext(await readBusinessContext(ctx, { warehouseIds: access.warehouseIds }), access)
  } catch (error) { sendReadAccessError(ctx, error); return true }
  const graph = buildRuntimeEvidenceGraph(context, { entityType, entityId })
  if (graph.dataLimitations.includes('record_not_found')) return missingAnchor(ctx, entityType, entityId)
  send(res, 200, { ...graph, restrictedSubjects: context.restrictedSubjects })
  return true
}
