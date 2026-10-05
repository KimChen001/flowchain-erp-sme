import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillEvidence, aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItems } from './ai-skill-signals.mjs'
import { aiSkillDraftCard } from './ai-skill-drafts.mjs'

// Starting an order: prepare_action_draft in mode `order`, for "can you help
// me generate the order?", "create a PO for LDM-001", 帮我下单 (the router's
// aiSkillOrderRequest). The assistant never places, saves or submits an
// order. It works out what to buy and how much, and its purchase request card
// opens the purchase request form prefilled (structuredDraftHandoff.ts). In
// FlowChain a purchase order is generated from an approved purchase request.
//
// A card with `autoOpen: true` is opened by the assistant as the answer
// arrives, when the choice is clear and the question asks for the order:
//   a SKU the question or the page names       -> that SKU, opened
//   no SKU, one SKU needs ordering              -> that SKU, opened
//   no SKU, several need ordering               -> a card each (up to three), none opened
//   short, but open orders or requests cover it -> a follow-up on the latest supplying
//                                                 order and a request card, none opened
//                                                 unless the question says "anyway"
//   nothing needs ordering                      -> a blank request card, not opened
// A question that asks whether or what to order ("should I reorder LDM-001?")
// gets the same cards, none opened.
//
// A SKU needs ordering when its target, the highest of the reorder point, the
// safety stock and open sales demand (as for the drafts), is above what is
// available, incoming on open POs and in requests awaiting approval. The
// quantity is that gap; ordered on top of open orders, it is the target less
// what is available. A quantity the question names wins.

const STOCK = new Set(['stock_shortage', 'stock_below_safety', 'stock_below_reorder'])
const MAX_CARDS = 3
const array = (value) => Array.isArray(value) ? value : []
const PROHIBITED = ['send', 'approve', 'pay', 'issue', 'cancel', 'delete']

// A SKU's position from its stock signal, or, for a named SKU with none, from
// its stock row and the requests awaiting approval.
function stockPlan(facts, row, item = null) {
  const pendingRequests = array(facts.purchaseRequests?.awaitingApproval).filter((request) => request.sku === row.sku).reduce((sum, request) => sum + (request.quantity ?? 0), 0)
  const data = item?.data || { available: row.available, demand: row.openSalesDemand, incoming: row.incomingApprovedPo, safety: row.safetyStock, reorder: row.reorderPoint, pendingRequests, purchaseOrderIds: row.purchaseOrderIds }
  const available = data.available ?? 0
  const incoming = data.incoming ?? 0
  const pending = data.pendingRequests ?? 0
  const target = Math.max(data.reorder ?? 0, data.safety ?? 0, data.demand ?? 0)
  const gap = Math.ceil(target - available - incoming - pending)
  return { target, available, incoming, pending, gap, onTop: Math.ceil(target - available), purchaseOrderIds: array(data.purchaseOrderIds) }
}

// The SKU a focus names: the item, or the item a named purchase order buys.
function focusRow(facts, focus) {
  if (!focus) return null
  const rows = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)]
  let id = focus.entityId
  if (focus.entityType === 'purchase_order') {
    const po = [...array(facts.purchaseOrders?.rows), ...array(facts.purchaseOrders?.index)].find((row) => [row.id, row.orderNumber].includes(id))
    id = po?.itemId || po?.sku
  } else if (focus.entityType !== 'item') return null
  return id ? rows.find((row) => [row.itemId, row.sku].includes(id)) || null : null
}

// Open orders that bring a SKU, the latest first.
function supplyingOrders(facts, plan) {
  const rows = new Map(array(facts.purchaseOrders?.rows).map((row) => [row.id, row]))
  return plan.purchaseOrderIds.map((id) => rows.get(id)).filter(Boolean).sort((a, b) => (b.overdueDays || 0) - (a.overdueDays || 0) || a.id.localeCompare(b.id))
}

export function runStartOrder(facts, { focus = null, route = null, canDraft = false } = {}) {
  const request = route?.order || {}
  const base = { skillId: 'prepare_action_draft', mode: 'order', canDraft, advice: Boolean(request.advice), quantity: request.quantity ?? null }
  if (!facts.inventory) return { ...base, outcome: 'no_stock', targets: [] }
  const stockItems = rankAiSkillItems(buildAiSkillSignals(facts)).filter((item) => STOCK.has(item.type))
  const rowOf = (item) => facts.inventory.rows.find((row) => row.itemId === item.entityId || row.sku === item.label)
  const named = focusRow(facts, focus)
  if (named) {
    const item = stockItems.find((entry) => entry.entityId === named.itemId || entry.label === named.sku) || null
    const plan = facts.inventory.rows.includes(named) ? stockPlan(facts, named, item) : null
    return { ...base, outcome: 'named', targets: [{ row: named, item, plan, supplying: plan ? supplyingOrders(facts, plan) : [] }] }
  }
  const planned = stockItems.map((item) => { const row = rowOf(item); const plan = stockPlan(facts, row, item); return { row, item, plan, supplying: supplyingOrders(facts, plan) } })
  const needed = planned.filter((entry) => entry.plan.gap > 0)
  if (needed.length) return { ...base, outcome: needed.length === 1 ? 'one' : 'several', targets: needed.slice(0, MAX_CARDS), more: Math.max(0, needed.length - MAX_CARDS) }
  if (planned.length) return { ...base, outcome: 'covered', anyway: Boolean(request.anyway), targets: planned.slice(0, 1) }
  return { ...base, outcome: 'none', targets: [] }
}

// The quantity to open the form with: the one the question names, else the
// gap, else (ordered on top of what is coming) the target less what is
// available. null leaves it to the user.
function quantityFor(target, result) {
  if (result.quantity) return result.quantity
  const plan = target.plan
  if (!plan) return null
  if (plan.gap > 0) return plan.gap
  return plan.onTop > 0 ? plan.onTop : null
}

function requestCard(target, result, facts, language, { autoOpen, anyway = false }) {
  const fmt = aiSkillFormatter(facts, language)
  const { row, plan } = target
  const quantity = quantityFor(target, result)
  const amount = quantity ? fmt.quantity(quantity, row.unit) : ''
  const values = { sku: row.sku, quantity: amount, available: fmt.number(plan?.available), target: fmt.number(plan?.target), coming: fmt.quantity((plan?.incoming ?? 0) + (plan?.pending ?? 0), row.unit) }
  // The reason is also the request line's note.
  const reason = !plan ? aiSkillText('order.reason.no_levels', language, values)
    : result.quantity ? aiSkillText('order.reason.asked', language, values)
      : plan.gap > 0 ? aiSkillText(plan.incoming || plan.pending ? 'order.reason.gap_after_incoming' : 'draft.pr.reason', language, values)
        : aiSkillText(plan.onTop > 0 ? 'order.reason.on_top' : 'order.reason.not_needed', language, values)
  const title = aiSkillText(amount ? 'order.card.title' : 'order.card.title_no_quantity', language, values)
  return {
    previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: PROHIBITED,
    allowedNextStep: aiSkillText(anyway ? 'order.action.anyway' : amount ? 'order.action.open' : 'order.action.open_no_quantity', language, values),
    title, draftTitle: title, description: reason,
    draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: row.itemId || row.sku,
    payload: { itemIdOrSku: row.sku, ...(quantity ? { quantity } : {}), reason, language },
    originEvidence: [{ entityType: 'item', entityId: row.itemId || row.sku }],
    autoOpen,
  }
}

function blankCard(language) {
  const title = aiSkillText('order.action.blank', language)
  return {
    previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: PROHIBITED,
    allowedNextStep: title, title, draftTitle: title, description: aiSkillText('order.none_summary', language),
    draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, payload: { language }, originEvidence: [], autoOpen: false,
  }
}

// The PO follow-up is the drafts' own (ai-skill-drafts.mjs): recipient,
// subject, greeting and each open line. Only its button and description say
// why it comes first here: the order is late.
function followUpCard(target, po, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const card = aiSkillDraftCard({ kind: 'po_followup_draft', key: `po:${po.id}`, item: target.item, po, chases: true }, facts, language)
  return {
    ...card,
    allowedNextStep: aiSkillText('order.action.follow_up', language, { po: po.orderNumber }),
    ...(po.overdueDays > 0 ? { description: aiSkillCountText('order.late', po.overdueDays, language, { po: po.orderNumber, days: fmt.number(po.overdueDays) }) } : {}),
  }
}

// What is already on order for a SKU. Whenever there is any, the answer says
// it first, so the user hears about the open orders before anything else
// (owner, 2026-10-04): the open POs and what they bring, the requests awaiting
// approval, and how late the latest PO is.
const onOrder = (plan) => Boolean(plan && (plan.incoming > 0 || plan.pending > 0))
function onOrderSentences(target, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const { row, plan, supplying } = target
  const sku = row.sku
  const parts = []
  if (plan?.incoming > 0) {
    parts.push(supplying.length
      ? aiSkillText('order.on_order_pos', language, { sku, incoming: fmt.quantity(plan.incoming, row.unit), pos: aiSkillList(supplying.map((po) => po.orderNumber), language) })
      : aiSkillText('order.on_order', language, { sku, incoming: fmt.quantity(plan.incoming, row.unit) }))
  }
  if (plan?.pending > 0) parts.push(aiSkillText(plan.incoming > 0 ? 'order.pending' : 'order.pending_only', language, { sku, quantity: fmt.quantity(plan.pending, row.unit) }))
  const late = supplying.find((po) => po.overdueDays > 0)
  if (late) parts.push(aiSkillCountText('order.late', late.overdueDays, language, { po: late.orderNumber, days: fmt.number(late.overdueDays) }))
  return parts
}

// A SKU with a stock signal is cited by it; a named SKU without one by its
// stock levels.
function evidenceFor(target, facts, language) {
  if (target.item) return aiSkillEvidence(target.item, facts, language)
  const { row } = target
  const fmt = aiSkillFormatter(facts, language)
  return aiSkillRecordEvidence({
    evidenceType: 'stock_level', entityType: 'item', entityId: row.itemId || row.sku, label: row.sku,
    status: aiSkillText('order.evidence.status', language),
    summary: row.noStock ? aiSkillText('order.reason.no_levels', language, { sku: row.sku }) : aiSkillText('order.evidence.summary', language, { available: fmt.number(row.available), reorder: fmt.number(row.reorderPoint), safety: fmt.number(row.safetyStock) }),
  }, language)
}

export function presentStartOrder(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const ask = !result.advice
  const items = result.targets.map((target) => target.item).filter(Boolean)
  const navigation = result.targets.map((target) => aiSkillNavigation(target.item || { label: target.row.sku, entityType: 'item', entityId: target.row.itemId || target.row.sku }, language))
  const answer = (title, summaryParts, reviewCards, extra = {}) => presentAiSkillAnswer({
    skill, facts, language, query, title, summary: aiSkillSentences(summaryParts, language),
    severity: items[0]?.severity || 'info', items, navigation: navigation.slice(0, 3), reviewCards,
    evidence: result.targets.map((target) => evidenceFor(target, facts, language)),
    followUpIds: ['inventory_availability', 'today_priorities'], ...extra,
  })
  if (!result.canDraft) {
    return answer(aiSkillText('order.title_blocked', language), [aiSkillText('order.blocked_summary', language)], [], { extraLimitations: [{ code: 'draft_permission', label: aiSkillText('limitation.draft_permission.label', language), description: aiSkillText('order.blocked_summary', language), severity: 'warning', missingData: [] }] })
  }
  if (result.outcome === 'no_stock') return answer(aiSkillText('order.title_no_stock', language), [aiSkillText('order.no_stock_summary', language)], [blankCard(language)])
  if (result.outcome === 'none') return answer(aiSkillText('order.title_none', language), [aiSkillText('order.none_summary', language)], [blankCard(language)])
  if (result.outcome === 'several') {
    const cards = result.targets.map((target) => requestCard(target, result, facts, language, { autoOpen: false }))
    return answer(aiSkillCountText('order.title_several', result.targets.length + result.more, language, { count: fmt.number(result.targets.length + result.more) }), [aiSkillText('order.several_summary', language)], cards)
  }
  const [target] = result.targets
  const plan = target.plan
  const sku = target.row.sku
  if (result.outcome === 'covered' && !result.anyway) {
    // Open orders already bring enough. The answer says so first; chasing the
    // latest order comes next, and a request is one click away, not opened.
    const latest = target.supplying[0]
    const cards = [...(latest ? [followUpCard(target, latest, facts, language)] : []), requestCard(target, result, facts, language, { autoOpen: false, anyway: true })]
    return answer(aiSkillText(plan.incoming > 0 ? 'order.title_covered' : 'order.title_covered_requested', language, { sku }), [
      ...onOrderSentences(target, facts, language),
      aiSkillText('order.covered_why', language),
      aiSkillText('order.position', language, { available: fmt.number(plan.available), target: fmt.number(plan.target) }),
      aiSkillText(latest ? 'order.covered_next' : 'order.covered_next_no_po', language, { po: latest?.orderNumber }),
    ], cards)
  }
  // One SKU: named, the only one that needs ordering, or ordered anyway.
  const card = requestCard(target, result, facts, language, { autoOpen: ask })
  const quantity = card.payload.quantity ? fmt.quantity(card.payload.quantity, target.row.unit) : ''
  // Asked whether to order: yes (the gap), covered by what is on order, not
  // needed, or no stock levels to judge by.
  const advice = !plan ? 'order.title_advice_no_levels' : plan.gap > 0 ? 'order.title_advice_yes' : plan.onTop > 0 ? 'order.title_advice_covered' : 'order.title_advice_no'
  // Ordered on top of what is on order: the title and the first sentences
  // say what is already on order.
  const onTop = plan?.gap <= 0 && onOrder(plan)
  const opening = !quantity ? 'order.title_open_no_quantity' : onTop ? 'order.title_open_on_top' : 'order.title_open'
  const title = aiSkillText(ask ? opening : advice, language, { sku, quantity })
  return answer(title, [
    ...(onTop ? onOrderSentences(target, facts, language) : []),
    card.description,
    aiSkillText(ask ? 'order.open_summary' : 'order.advice_summary', language),
  ], [card])
}
