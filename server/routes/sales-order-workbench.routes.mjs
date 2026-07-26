import { createSalesOrderReadService, createSalesOrderWorkbenchService, SalesWorkbenchError } from '../domain/sales-order-workbench-service.mjs'
import { PilotIdentityError } from '../domain/pilot-identity.mjs'
import { createOutboundWorkbenchReadService } from '../domain/outbound-workbench-read-service.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { capabilityForEnvironment } from '../domain/capability-registry.mjs'

const decode = (value) => decodeURIComponent(value)
function errorResponse(ctx, error) {
  if (!(error instanceof SalesWorkbenchError) && !(error instanceof PilotIdentityError) && error?.name !== 'AuthorizationError') throw error
  ctx.send(ctx.res, error.status || 400, { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) })
}

export async function handleSalesOrderWorkbenchRoute(ctx) {
  const path = ctx.url.pathname
  const collection = path === '/api/sales/orders'
  const entryData = path === '/api/sales/order-entry-data'
  const detail = path.match(/^\/api\/sales\/orders\/([^/]+)$/)
  const transition = path.match(/^\/api\/sales\/orders\/([^/]+)\/(confirm|hold|resume)$/)
  const orderRead = path.match(/^\/api\/sales\/orders\/([^/]+)\/(workbench|evidence|links|reconciliation)$/)
  const shipmentRead = path.match(/^\/api\/sales\/shipments\/([^/]+)\/(workbench|evidence|links|reconciliation)$/)
  if (!collection && !entryData && !detail && !transition && !orderRead && !shipmentRead) return false
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' }); return true }
  const isRead = (collection || entryData || orderRead || shipmentRead) && ctx.req.method === 'GET'
  const isCreate = collection && ctx.req.method === 'POST'
  const isEdit = detail && ctx.req.method === 'PATCH'
  const isTransition = transition && ctx.req.method === 'POST'
  if (!isRead && !isCreate && !isEdit && !isTransition) return false
  const lifecycleCapability = capabilityForEnvironment('sales-order-lifecycle', ctx.env || process.env)
  if (!isRead && !lifecycleCapability?.enabled) { ctx.send(ctx.res, 409, { code: 'OUTBOUND_CAPABILITY_NOT_AVAILABLE', message: 'Authoritative outbound lifecycle is not enabled for this runtime.', details: { capability: 'sales-order-lifecycle' } }); return true }
  try {
    const prisma = ctx.outboundPrisma || await getPrismaClient(ctx.env || process.env)
    const context = { identity: ctx.identity }
    if (isRead) {
      if (entryData) { ctx.send(ctx.res, 200, await createSalesOrderReadService({ prisma, lifecycleCapability }).entryData(context)); return true }
      if (orderRead || shipmentRead) {
        const capabilities = {
          lifecycle: lifecycleCapability,
          reservation: capabilityForEnvironment('sales-reservation', ctx.env || process.env),
          shipmentDraft: capabilityForEnvironment('sales-shipment-draft', ctx.env || process.env),
          shipmentPosting: capabilityForEnvironment('sales-shipment-posting', ctx.env || process.env),
          shipmentReversal: capabilityForEnvironment('sales-shipment-reversal', ctx.env || process.env),
        }
        const service = createOutboundWorkbenchReadService({ prisma, capabilities })
        const result = orderRead ? await service.orderWorkbench(decode(orderRead[1]), context) : await service.shipmentWorkbench(decode(shipmentRead[1]), context)
        const section = (orderRead || shipmentRead)[2]
        const sections = { workbench: result, evidence: result.evidence, links: result.smartLinks, reconciliation: result.reconciliation }
        ctx.send(ctx.res, 200, sections[section]); return true
      }
      const query = Object.fromEntries(ctx.url.searchParams.entries())
      ctx.send(ctx.res, 200, await createSalesOrderReadService({ prisma, lifecycleCapability }).listOrders(query, context)); return true
    }
    const body = await ctx.readBody(ctx.req), service = createSalesOrderWorkbenchService({ prisma })
    if (isCreate) ctx.send(ctx.res, 201, await service.createOrder(body, context))
    else if (isEdit) ctx.send(ctx.res, 200, await service.reviseOrder(decode(detail[1]), body, context))
    else ctx.send(ctx.res, 200, await service[`${transition[2]}Order`](decode(transition[1]), body, context))
  } catch (error) { errorResponse(ctx, error) }
  return true
}
