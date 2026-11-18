// Records the plan's purchase requests [assumed] (planPurchaseRequests in
// plan.mjs; design audit L1-33 = L7-07, W-06) through FlowChain's own request
// and purchase order commands, each on its own day:
//   draft       raised by the buyer
//   submitted   raised and submitted
//   approved    submitted, approved by a second person
//   converted   approved, turned into a purchase order by the buyer (approved
//               with the request) and issued
//   rejected    submitted, rejected by a second person with a reason
//   cancelled   submitted, then cancelled by the buyer with a reason
// Who raised a request does not approve it (design audit C4). The commands
// stamp the seed's own clock on createdAt; each record is then dated by the
// plan and labelled assumed, as the documents before it are.
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createDbMasterDataRepository } from '../../server/repositories/db-master-data-repository.mjs'
import { createProcurementRequestCommandService } from '../../server/services/procurement-request-command-service.mjs'
import { PUBLIC_DATA_STOCK_UNIT } from './plan.mjs'

// What the buyer needs; the second person needs approve and reject.
export const REQUEST_PERMISSIONS = ['procurement.purchase_request.create', 'procurement.purchase_request.submit', 'procurement.purchase_order.revise']
export const REQUEST_REVIEW_PERMISSIONS = ['procurement.purchase_request.approve', 'procurement.purchase_request.reject']

const TIMES = Object.freeze({ create: '09:00', submit: '09:10', cancel: '11:00', decide: '14:00', convert: '15:00', issue: '15:30' })
const REASONS = Object.freeze({
  rejected: 'Not needed now: stock and open orders cover it [assumed].',
  cancelled: 'No longer needed: the requester withdrew it [assumed].',
})
const round2 = (value) => Math.round(value * 100) / 100

// requester and approver: identities of the buyer and a second person.
// itemIdOf(key) and supplierIdOf(key): the seed's ids. retrying(work) runs a
// command again after a serializable conflict. Returns { requests, byState,
// purchaseOrders }.
export async function seedPurchaseRequests(prisma, { plan, env, requester, approver, tenantId, calendar, warehouseId, itemIdOf, supplierIdOf, metadata, retrying }) {
  const { at, isoDay } = calendar
  const offset = plan.offsetOf
  const currency = plan.profile.currency
  let clock = new Date()
  const now = () => clock
  const commands = createProcurementRequestCommandService({ prisma, masterData: createDbMasterDataRepository({ env, prisma }), env, now })
  const orders = createDbProcurementCommandService({ prisma, env, now })
  const asBuyer = { identity: requester }
  const asApprover = { identity: approver }
  const itemOf = new Map(plan.items.map((item) => [item.key, item]))
  const recorded = []
  for (const spec of plan.requests || []) {
    const item = itemOf.get(spec.itemKey)
    const key = (step) => `public-data:${plan.dataset}:purchase-request:${step}:${spec.key}`
    const times = {}
    const step = (name) => {
      clock = at(offset(spec.day), TIMES[name])
      times[name] = clock
    }
    const needBy = isoDay(offset(spec.needBy))
    step('create')
    let request = await retrying(() => commands.createPurchaseRequest({
      idempotencyKey: key('create'), defaultNeedByDate: needBy, defaultCurrency: currency,
      reason: `Monday review: ${item.sku} [assumed].`,
      lines: [{
        lineId: `${plan.dataset}-${spec.key}-1`, sourceType: 'catalog_item', lineBasis: 'quantity',
        itemId: itemIdOf(item.key), sku: item.sku, itemNameSnapshot: item.name, unitSnapshot: PUBLIC_DATA_STOCK_UNIT,
        supplierId: supplierIdOf(item.supplierKey), quantity: spec.quantity, estimatedUnitPrice: spec.unitPrice, estimatedAmount: round2(spec.quantity * spec.unitPrice),
        currency, targetWarehouseId: warehouseId, needByDate: needBy,
      }],
    }, asBuyer))
    const move = async (name, action, context, reason) => {
      step(name)
      const version = request.version
      request = await retrying(() => commands.transitionPurchaseRequest(request.id, action, { idempotencyKey: key(action), expectedVersion: version, ...(reason ? { reason } : {}) }, context))
    }
    if (spec.state !== 'draft') await move('submit', 'submit', asBuyer)
    if (spec.state === 'approved' || spec.state === 'converted') await move('decide', 'approve', asApprover)
    if (spec.state === 'rejected') await move('decide', 'reject', asApprover, REASONS.rejected)
    if (spec.state === 'cancelled') await move('cancel', 'cancel', asBuyer, REASONS.cancelled)
    let purchaseOrder = null
    if (spec.state === 'converted') {
      step('convert')
      const version = request.version
      const converted = await retrying(() => commands.createPurchaseOrdersFromPurchaseRequest(request.id, { idempotencyKey: key('convert'), expectedVersion: version }, asBuyer))
      purchaseOrder = converted.createdPurchaseOrders[0]
      step('issue')
      const { version: orderVersion } = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrder.id }, select: { version: true } })
      await retrying(() => orders.issuePurchaseOrder(purchaseOrder.id, { idempotencyKey: key('issue'), expectedVersion: orderVersion }, asBuyer))
    }
    const row = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: request.id }, select: { status: true, metadata: true } })
    if (row.status !== spec.state) throw new Error(`Purchase request ${spec.key} is ${row.status}, not ${spec.state}.`)
    recorded.push({ spec, id: request.id, purchaseOrderId: purchaseOrder?.id || null, times })
  }

  // Labels and business times.
  const actionTimes = { purchase_request_created: 'create', purchase_request_submit: 'submit', purchase_request_approve: 'decide', purchase_request_reject: 'decide', purchase_request_cancel: 'cancel', purchase_request_converted_to_purchase_orders: 'convert' }
  for (const { spec, id, purchaseOrderId, times } of recorded) {
    const current = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id }, select: { metadata: true } })
    await prisma.purchaseRequest.update({ where: { id }, data: { createdAt: times.create, metadata: { ...(current.metadata || {}), ...metadata, assumed: true, requestStateAssumed: spec.state } } })
    for (const [action, name] of Object.entries(actionTimes)) if (times[name]) await prisma.auditLog.updateMany({ where: { tenantId, entityId: id, action }, data: { createdAt: times[name] } })
    if (purchaseOrderId) {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, select: { metadata: true } })
      await prisma.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { createdAt: times.convert, metadata: { ...(order.metadata || {}), ...metadata, assumed: true, purchasingRule: 'purchase_request' } } })
      await prisma.auditLog.updateMany({ where: { tenantId, entityId: purchaseOrderId }, data: { createdAt: times.issue } })
    }
  }
  const byState = Object.fromEntries([...new Set(recorded.map((row) => row.spec.state))].map((state) => [state, recorded.filter((row) => row.spec.state === state).length]))
  return { requests: recorded.length, byState, purchaseOrders: recorded.filter((row) => row.purchaseOrderId).length }
}
