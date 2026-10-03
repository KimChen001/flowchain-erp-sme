import { authorizeMutation } from '../domain/mutation-authorization.mjs'
import { can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

// The signed-in actor with its permissions: the session identity when it
// already carries a resolved authorization context, else the provisioned user.
async function actorFor(ctx) {
  if (ctx.salesDemandActor) return ctx.salesDemandActor
  const identity = ctx.identity
  if (identity?.complete && identity.permissionCodes) return identity
  return resolveProvisionedActor(await getPrismaClient(ctx.env || process.env), identity)
}

function query(url) {
  return { q: url.searchParams.get('q') || '', sku: url.searchParams.get('sku') || '', status: url.searchParams.get('status') || '', risk: url.searchParams.get('risk') || '' }
}

export async function handleSalesDemandRoute(ctx) {
  const { req, res, url, send } = ctx
  const repository = ctx.repositories?.salesOrders
  if (!repository || !url.pathname.startsWith('/api/sales-demand')) return false
  if (!ctx.identity?.authenticated) {
    send(res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' })
    return true
  }
  const filters = () => ({ ...query(url), tenantId: ctx.identity.tenantId })
  // Every sales-demand read returns customer orders, so it needs sales_order.read.
  if (req.method === 'GET') {
    const actor = await actorFor(ctx)
    if (!can({ actor, permission: 'sales_order.read', tenantId: actor.tenantId })) {
      send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view sales orders.', details: { permission: 'sales_order.read' } })
      return true
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/sales-demand/summary') {
    send(res, 200, { summary: await repository.getSummary(filters()), evidenceLinks: [], dataLimitations: [] })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/sales-demand/orders') {
    send(res, 200, { orders: await repository.listOrders(filters()), summary: await repository.getSummary(filters()), evidenceLinks: [], dataLimitations: [] })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/sales-demand/orders') {
    const authorization = authorizeMutation(ctx, { allowedRoles: ['admin', 'manager', 'business-specialist'], action: 'sales.order.upsert', resource: 'sales-orders' })
    if (authorization.blocked) return true
    send(res, 501, {
      code: 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED',
      message: 'Legacy sales-demand order mutation is not available. Use the formal sales order workflow.',
      capability: 'sales-order-lifecycle',
      limitations: ['legacy_sales_demand_mutation_removed'],
    })
    return true
  }
  const match = url.pathname.match(/^\/api\/sales-demand\/orders\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const order = await repository.getOrder(match[1], filters())
    if (!order) send(res, 404, { error: 'Sales order not found', dataLimitations: ['record_not_found'] })
    else send(res, 200, { order, evidenceLinks: order.evidence || [], dataLimitations: order.dataLimitations || [] })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/sales-demand/risks') {
    const orders = await repository.listOrders(filters())
    send(res, 200, { risks: orders.filter(row => row.deliveryRiskLevel !== 'low'), summary: await repository.getSummary(filters()), evidenceLinks: [], dataLimitations: [] })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/sales-demand/impact') {
    const sku = url.searchParams.get('sku') || ''
    send(res, 200, { sku, orders: await repository.listOrders({ sku, tenantId: ctx.identity.tenantId }), evidenceLinks: [], dataLimitations: [] })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/sales-demand/po-impact') {
    const poId = url.searchParams.get('poId') || ''
    const orders = (await repository.listOrders({ tenantId: ctx.identity.tenantId })).filter(row => (row.linkedPurchaseOrders || []).some(po => (po.id || po.poId) === poId))
    send(res, 200, { poId, orders, evidenceLinks: [], dataLimitations: [] })
    return true
  }
  send(res, 405, { error: 'Method not allowed' })
  return true
}
