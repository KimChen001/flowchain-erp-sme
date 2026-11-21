import { loadAiSkillContext } from '../domain/ai-skill-context.mjs'
import { aiSkillVisibility } from '../domain/ai-skill-registry.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { supplierReplyStockEffects } from '../domain/supplier-reply-stock.mjs'
import { SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, parseSupplierReplyStockDates } from '../../shared/supplier-reply-stock-contract.mjs'
import { readSupplierReplyStockInputs } from './supplier-reply-stock-inputs.mjs'

// The "Stock:" line's read (shared/supplier-reply-stock-contract.mjs): the
// reply card, read as the card is (the order's read permission, its tenant,
// the reply on that order); then, for a reader of inventory, the stock of the
// card's SKUs alone (supplier-reply-stock-inputs.mjs: the reader's
// warehouses, sales orders only for their readers), and the projection with
// the card's dates (supplier-reply-stock.mjs). A read only: nothing here
// writes, and the reply service is used through its list read.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details })

// What the reader may read for the stock line: inventory (inventory.balance.read,
// as the assistant's inventory source), their warehouses (null for every
// one), and sales orders.
export function supplierReplyStockAccess(actor) {
  const access = reportReadAccessFor(actor)
  return {
    inventory: Boolean(aiSkillVisibility(actor).sources.inventory),
    warehouseIds: Array.isArray(access?.warehouseIds) ? access.warehouseIds : null,
    salesOrders: Boolean(access?.collections?.salesOrders),
  }
}

export function createSupplierReplyStockReadService({ replies, loadContext = loadAiSkillContext, readInputs = readSupplierReplyStockInputs, accessOf = supplierReplyStockAccess } = {}) {
  async function read(orderId, replyId, query, ctx) {
    const dates = parseSupplierReplyStockDates(query?.dates)
    if (dates === null) throw fail(422, 'SUPPLIER_REPLY_INVALID', 'dates must be lineId:YYYY-MM-DD pairs of real days, comma separated.', [{ field: 'dates', code: 'invalid' }])
    // The card, as its list reads it: refuses another tenant's order, a
    // reader without the order's read permission, an order not found.
    const { replies: cards } = await replies.listReplies(orderId, ctx)
    const card = array(cards).find((entry) => text(entry.id) === text(replyId))
    if (!card) throw fail(404, 'SUPPLIER_REPLY_NOT_FOUND', 'No such reply on this order.')
    // The card's lines only, with their SKUs; without dates, its proposal.
    const skuByLine = new Map([...array(card.formLines), ...array(card.lines)].filter((line) => line.purchaseOrderLineId && line.sku).map((line) => [text(line.purchaseOrderLineId), text(line.sku)]))
    const overrides = (dates.length
      ? dates
      : array(card.lines).filter((line) => line.outcome === 'proposed' && line.purchaseOrderLineId && line.proposedDate).map((line) => ({ lineId: line.purchaseOrderLineId, date: line.proposedDate })))
      .filter((entry) => skuByLine.has(text(entry.lineId)))

    const context = await loadContext(ctx)
    const today = text(context.today)
    const answer = (fields) => ({ contractVersion: SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, asOf: today, available: true, reason: null, effects: [], ...fields })
    // Stock needs inventory read; without it the card shows no stock line.
    const access = accessOf(context.actor)
    if (!access.inventory) return answer({ available: false, reason: 'inventory_hidden' })
    if (!overrides.length) return answer({})
    const inputs = await readInputs({
      prisma: context.prisma, tenantId: context.tenantId, today, timeZone: context.tenant?.timezone,
      skus: [...new Set(overrides.map((entry) => skuByLine.get(text(entry.lineId))))],
      warehouseIds: access.warehouseIds,
      salesOrdersVisible: access.salesOrders,
    })
    return answer({ effects: supplierReplyStockEffects({ today, purchaseOrderId: card.purchaseOrderId, ...inputs, overrides }) })
  }
  return { read }
}
