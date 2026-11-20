import { loadAiSkillContext } from '../domain/ai-skill-context.mjs'
import { readAiSkillFacts } from '../domain/ai-skill-readers.mjs'
import { AI_ASSISTANT_V2_TOOLS } from '../domain/ai-assistant-v2-data-tools.mjs'
import { supplierReplyStockEffects } from '../domain/supplier-reply-stock.mjs'
import { SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, parseSupplierReplyStockDates } from '../../shared/supplier-reply-stock-contract.mjs'

// The "Stock:" line's read (shared/supplier-reply-stock-contract.mjs): the
// reply card, read as the card is (the order's read permission, its tenant,
// the reply on that order), then the stock facts the assistant reads, under
// the same permissions and warehouse scope (readAiSkillFacts), and the
// projection with the card's dates (supplier-reply-stock.mjs). A read only:
// nothing here writes, and the reply service is used through its list read.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details })

// The average shipped per day over the last 90 days, per SKU, as the
// assistant's stock_projection reads it (its recordedDemand); none when the
// reader's warehouse scope or the item's history does not give one.
async function recordedRates(facts, context, skus) {
  const tool = AI_ASSISTANT_V2_TOOLS.find((entry) => entry.name === 'stock_projection')
  const rates = new Map()
  if (!tool || !tool.available(facts, context)) return rates
  for (const sku of skus) {
    try {
      const result = await tool.run({ sku, weeks: 1 }, { facts, context })
      const rate = Number(result?.recordedDemand?.averageDailyDemand)
      if (Number.isFinite(rate) && rate > 0) rates.set(sku, rate)
    } catch { /* no rate basis for this SKU */ }
  }
  return rates
}

export function createSupplierReplyStockReadService({ replies, loadContext = loadAiSkillContext, readFacts = readAiSkillFacts, readRates = recordedRates } = {}) {
  async function read(orderId, replyId, query, ctx) {
    const dates = parseSupplierReplyStockDates(query?.dates)
    if (dates === null) throw fail(422, 'SUPPLIER_REPLY_INVALID', 'dates must be lineId:YYYY-MM-DD pairs, comma separated.', [{ field: 'dates', code: 'invalid' }])
    // The card, as its list reads it: refuses another tenant's order, a
    // reader without the order's read permission, an order not found.
    const { replies: cards } = await replies.listReplies(orderId, ctx)
    const card = array(cards).find((entry) => text(entry.id) === text(replyId))
    if (!card) throw fail(404, 'SUPPLIER_REPLY_NOT_FOUND', 'No such reply on this order.')
    // The card's lines only; without dates, its proposal.
    const ownLines = new Set([...array(card.lines), ...array(card.formLines)].map((line) => text(line.purchaseOrderLineId)).filter(Boolean))
    const overrides = (dates.length
      ? dates
      : array(card.lines).filter((line) => line.outcome === 'proposed' && line.purchaseOrderLineId && line.proposedDate).map((line) => ({ lineId: line.purchaseOrderLineId, date: line.proposedDate })))
      .filter((entry) => ownLines.has(text(entry.lineId)))

    const context = await loadContext(ctx)
    const asOf = text(context.today)
    const answer = (fields) => ({ contractVersion: SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, asOf, available: true, reason: null, effects: [], ...fields })
    if (!overrides.length) return answer({})
    const facts = await readFacts(context)
    // Stock needs inventory read; without it the card shows no stock line.
    if (!facts?.inventory) return answer({ available: false, reason: 'inventory_hidden' })
    const order = array(facts.purchaseOrders?.index).find((entry) => text(entry.id) === text(card.purchaseOrderId))
    if (!order) return answer({ asOf: text(facts.asOf) || asOf })
    const skus = [...new Set(array(order.openLines).filter((line) => overrides.some((entry) => text(entry.lineId) === text(line.lineId))).map((line) => text(line.sku)).filter(Boolean))]
    const fold = (value) => text(value).toLowerCase()
    const wanted = new Set(skus.map(fold))
    const items = array(facts.inventory.rows).filter((row) => wanted.has(fold(row.sku)))
      .map((row) => ({ sku: row.sku, itemName: row.itemName, unit: row.unit, available: row.available, reorderPoint: row.reorderPoint }))
    const incoming = array(facts.purchaseOrders?.index).filter((entry) => entry.isOpen).flatMap((po) => array(po.openLines)
      .filter((line) => wanted.has(fold(line.sku)))
      .map((line) => ({ lineId: line.lineId, purchaseOrderId: po.id, sku: line.sku, unit: line.unit, remaining: line.remaining, promisedDate: line.promisedDate })))
    // Open sales orders' unreserved demand, for readers of sales orders.
    const demand = Array.isArray(facts.salesOrders)
      ? facts.salesOrders.flatMap((salesOrder) => array(salesOrder.lines).filter((line) => wanted.has(fold(line.sku))).map((line) => ({ sku: line.sku, quantity: line.open, promisedDate: salesOrder.promisedDate })))
      : null
    const rates = await readRates(facts, context, items.map((row) => row.sku))
    const effects = supplierReplyStockEffects({ today: text(facts.asOf) || asOf, purchaseOrderId: order.id, items, incoming, demand, rates, overrides })
    return answer({ asOf: text(facts.asOf) || asOf, effects })
  }
  return { read }
}
