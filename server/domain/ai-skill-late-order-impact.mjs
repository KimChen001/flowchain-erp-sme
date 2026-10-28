import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillNavigation, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

// Analysis tool 3 (owner decision 3 of 2026-10-07): what a late purchase order
// puts at risk. "What will a delay of PO-001 affect?", "If PO-001 is late,
// which customers are hit?", PO-001 延误会影响哪些客户？, and on a purchase
// order's page "What will a delay affect?". With no order named, the overdue
// orders together: "What do the late orders put at risk?"
//
// In the inventory page's own terms (runtime-inventory-allocation-read-model):
// a SKU's available to promise is its available stock plus what open orders
// bring, less the open sales demand not yet reserved. If the late lines do not
// arrive, their remaining quantity drops out of available to promise. Where
// that leaves it below zero, the open sales orders for that SKU cannot all
// ship: the answer says by how much more they fall short, and names those
// orders, their customers and the days promised to them (readers of sales
// orders only). A named order is judged on its own; the overdue orders are
// judged together, per SKU, since two late orders for one SKU can each be
// covered alone and not together. A line in another unit than the item's
// stock unit was never counted as coming (the inventory page leaves it out
// too), so its delay changes nothing. No dates are guessed: the answer does
// not say which customer order ships first.

const LATE_LISTED = 3
const ORDERS_LISTED = 3
const array = (value) => Array.isArray(value) ? value : []

// The effect on one SKU of the lines of these orders not arriving.
function skuImpact(sku, pos, facts) {
  const row = array(facts.inventory?.rows).find((entry) => entry.sku === sku) || null
  const lines = pos.flatMap((po) => array(po.openLines).filter((line) => line.sku === sku).map((line) => ({ po, line })))
  const remaining = lines.reduce((sum, { line }) => sum + (Number(line.remaining) || 0), 0)
  const unit = lines.find(({ line }) => line.unit)?.line.unit || row?.unit || null
  const base = { sku, itemId: row?.itemId || null, pos, unit, remaining }
  if (!row || row.availableToPromise === null || row.availableToPromise === undefined) return { ...base, known: false }
  const counted = lines.filter(({ po }) => array(row.purchaseOrderIds).includes(po.id))
  const lost = counted.reduce((sum, { line }) => sum + (Number(line.remaining) || 0), 0)
  const atp = row.availableToPromise
  const without = atp - lost
  const orders = array(facts.salesOrders)
    .map((order) => ({ ...order, open: array(order.lines).filter((entry) => entry.sku === sku).reduce((sum, entry) => sum + entry.open, 0) }))
    .filter((order) => order.open > 0)
    .sort((a, b) => (a.promisedDate || '9999').localeCompare(b.promisedDate || '9999') || a.number.localeCompare(b.number))
  return { ...base, known: true, counted: counted.length > 0, lost, atp, without, added: Math.max(0, -without) - Math.max(0, -atp), orders }
}

const skusOf = (pos) => [...new Set(pos.flatMap((po) => array(po.openLines).map((line) => line.sku).filter(Boolean)))]

export function runLateOrderImpact(facts, { route = null } = {}) {
  const base = { skillId: 'late_order_impact' }
  if (!facts?.purchaseOrders || !facts?.inventory) return { ...base, hidden: true }
  const index = array(facts.purchaseOrders.index)
  const find = (id) => index.find((row) => row.id === id || row.orderNumber === id) || null
  // The orders the question names, else the purchase order of the page it is
  // asked on (the page's chip "What will a delay affect?").
  const named = array(route?.entities?.purchaseOrders).length
    ? array(route.entities.purchaseOrders).map((row) => find(row.id) || row)
    : route?.focus?.entityType === 'purchase_order' ? [find(route.focus.entityId)].filter(Boolean) : []
  const salesVisible = Array.isArray(facts.salesOrders)
  if (named.length) {
    // Each named order on its own.
    return { ...base, mode: 'named', salesVisible, groups: named.flatMap((po) => skusOf([po]).map((sku) => skuImpact(sku, [po], facts))), pos: named }
  }
  const late = index.filter((row) => row.isOpen && (row.overdueDays || 0) > 0).sort((a, b) => b.overdueDays - a.overdueDays || a.orderNumber.localeCompare(b.orderNumber))
  // The overdue orders together, per SKU.
  const groups = skusOf(late).map((sku) => skuImpact(sku, late.filter((po) => skusOf([po]).includes(sku)), facts))
    .sort((a, b) => (b.added || 0) - (a.added || 0) || a.sku.localeCompare(b.sku))
  return { ...base, mode: 'late', salesVisible, groups, pos: late, more: Math.max(0, groups.length - LATE_LISTED) }
}

const customerOf = (order, language) => order.customer || aiSkillText('impact.customer_unknown', language)

export function presentLateOrderImpact(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const empty = { skill, facts, language, query, severity: 'info', evidence: [], impacts: [], navigation: [] }
  if (result.hidden) return presentAiSkillAnswer({ ...empty, title: aiSkillText('impact.title_hidden', language), summary: aiSkillText('impact.summary_hidden', language) })
  if (!result.groups.length) {
    return presentAiSkillAnswer({ ...empty, severity: 'success', title: aiSkillText(result.mode === 'late' ? 'impact.title_no_late' : 'impact.title_no_lines', language, { date: fmt.day(facts.asOf), po: result.pos[0]?.orderNumber || '' }), summary: aiSkillText('impact.basis', language) })
  }
  const qty = (value, unit) => fmt.quantity(value, unit)
  const poList = (pos) => aiSkillList(pos.map((po) => po.orderNumber), language)
  const shown = result.groups.slice(0, LATE_LISTED)
  const hit = result.groups.filter((group) => group.known && group.added > 0)
  const evidence = []
  const sentences = []
  // When nothing falls short, each line says why: what is left to promise.
  const reasons = []
  for (const group of shown) {
    let value
    let detail
    if (!group.known) {
      value = aiSkillText('impact.value_unknown', language)
      detail = aiSkillText('impact.line_unknown', language, { sku: group.sku })
    } else if (group.added > 0) {
      value = aiSkillText('impact.value_short', language, { quantity: qty(group.added, group.unit), sku: group.sku })
      detail = aiSkillText('impact.line_short', language, { sku: group.sku, atp: qty(group.atp, group.unit), without: qty(group.without, group.unit), remaining: qty(group.lost, group.unit), po: poList(group.pos) })
    } else if (!group.counted) {
      value = aiSkillText('impact.value_not_counted', language)
      detail = aiSkillText('impact.line_not_counted', language, { sku: group.sku })
    } else {
      value = aiSkillText('impact.value_covered', language)
      detail = aiSkillText('impact.line_covered', language, { sku: group.sku, without: qty(group.without, group.unit), remaining: qty(group.lost, group.unit), po: poList(group.pos) })
    }
    if (!(group.known && group.added > 0)) reasons.push(detail)
    const late = group.pos.filter((po) => (po.overdueDays || 0) > 0).map((po) => aiSkillText('impact.po_late', language, { po: po.orderNumber, late: aiSkillCountText('impact.days_late', po.overdueDays, language, { days: fmt.number(po.overdueDays) }) }))
    // A named order is the line's record; for the late orders together, the item.
    const record = result.mode === 'named'
      ? { entityLabel: group.pos[0].orderNumber, entityType: 'purchase_order', entityId: group.pos[0].id, moduleId: AI_SKILL_MODULES.purchase_order }
      : { entityLabel: group.sku, entityType: 'item', entityId: group.itemId || group.sku, moduleId: AI_SKILL_MODULES.item }
    evidence.push({
      id: `impact:${result.mode === 'named' ? group.pos[0].id : 'late'}:${group.sku}`, label: value, ...record, evidenceType: 'late_order_impact',
      summary: aiSkillSentences([...late, detail], language), value, status: value,
      statusCode: group.known ? (group.added > 0 ? 'impact_short' : 'impact_covered') : 'impact_unknown', severity: group.added > 0 ? 'risk' : 'info', rank: evidence.length + 1,
      sourceLabel: aiSkillText('area.inventory', language), linkTarget: { moduleId: record.moduleId, entityType: record.entityType, entityId: record.entityId },
    })
    // The sales orders waiting on the SKU, by the day promised to the customer.
    if (group.known && group.added > 0 && result.salesVisible && group.orders.length) {
      for (const order of group.orders.slice(0, ORDERS_LISTED)) {
        evidence.push({
          id: `impact_so:${group.sku}:${order.id}`, label: aiSkillText('impact.label_sales_order', language), entityLabel: order.number, entityType: 'sales_order', entityId: order.id, evidenceType: 'late_order_impact_sales_order',
          summary: aiSkillText(order.promisedDate ? 'impact.sales_order' : 'impact.sales_order_undated', language, { customer: customerOf(order, language), date: order.promisedDate ? fmt.day(order.promisedDate) : '', quantity: qty(order.open, group.unit), sku: group.sku }),
          value: qty(order.open, group.unit), status: aiSkillText('impact.label_sales_order', language), statusCode: 'impact_sales_order', severity: 'warning', rank: evidence.length + 1, sourceLabel: aiSkillText('area.sales', language),
        })
      }
      sentences.push(aiSkillCountText('impact.waiting', group.orders.length, language, {
        sku: group.sku, count: fmt.number(group.orders.length),
        list: aiSkillList(group.orders.slice(0, ORDERS_LISTED).map((order) => aiSkillText('impact.order_customer', language, { order: order.number, customer: customerOf(order, language) })), language),
      }))
    }
  }
  const first = hit[0]
  const customers = [...new Set(hit.flatMap((group) => group.orders.map((order) => customerOf(order, language))))]
  const title = result.mode === 'named'
    ? (first
      ? aiSkillText('impact.title_short', language, { po: poList(result.pos), sku: first.sku, quantity: qty(first.added, first.unit) })
      : aiSkillText('impact.title_covered', language, { po: poList(result.pos) }))
    : first
      ? aiSkillCountText('impact.title_late_short', result.pos.length, language, { count: fmt.number(result.pos.length), sku: first.sku, quantity: qty(first.added, first.unit) })
      : aiSkillCountText('impact.title_late_covered', result.pos.length, language, { count: fmt.number(result.pos.length) })
  const summary = aiSkillSentences([
    ...sentences,
    ...(hit.length ? [] : reasons.slice(0, 2)),
    customers.length && result.salesVisible ? aiSkillCountText('impact.customers', customers.length, language, { count: fmt.number(customers.length), list: aiSkillList(customers.slice(0, 5), language) }) : '',
    hit.length && !result.salesVisible ? aiSkillText('impact.sales_hidden', language) : '',
    result.more ? aiSkillCountText('impact.more', result.more, language, { count: fmt.number(result.more) }) : '',
    aiSkillText('impact.basis', language),
  ], language)
  const figures = hit.map((group) => ({ key: `late_impact_short:${group.sku}`, code: 'late_impact_short', entityId: group.itemId || null, value: group.added, unit: group.unit || null }))
  return presentAiSkillAnswer({
    ...empty, title, summary, evidence,
    severity: hit.length ? 'risk' : 'info',
    impacts: evidence.map((item) => ({ area: item.sourceLabel, impact: item.status, severity: item.severity, explanation: aiSkillText(item.entityType === 'sales_order' ? 'impact.explain_sales_order' : 'impact.explain_po', language), affectedObjects: [item.entityId] })),
    navigation: result.pos.slice(0, 3).map((po) => aiSkillNavigation({ label: po.orderNumber, entityType: 'purchase_order', entityId: po.id }, language)),
    figures,
    followUpIds: ['inventory_availability', 'prepare_action_draft'],
  })
}
