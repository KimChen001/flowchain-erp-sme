import { aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillSignalReason } from './ai-skill-presenter.mjs'
import { aiSkillPurchaseOrderNotSent } from './ai-skill-signals.mjs'

// Review-only drafts for attention signals, shared by the "prepare a draft"
// answer and the draft offered on each answer line (ai-skill-next-steps.mjs).
// A draft is never sent, approved or saved by the assistant: each card opens
// the action draft review or a creation form, and there is never a purchase
// order draft (the draft boundary has no PO type).
//   PO issued to its supplier and overdue (partially received or not),
//   or a shortage such a PO covers                                      -> po_followup_draft
//   PO issued and not yet overdue, or a shortage only such a PO covers  -> a link: on order, no follow-up yet
//   shortage no open PO or pending request covers                      -> purchase_request_draft
//   invoice variance                                                    -> supplier_followup_draft
//   PO approved but not yet issued, or a shortage only such a PO covers -> a link, to send it first
//   anything else                                                       -> a link only
// Only an order the supplier has received is chased (decision V5), and only
// once it is overdue (owner decision, 2026-10-06): an order due soon is listed
// with its due date and gets no draft. In a draft answer, several follow-ups
// to one supplier become one message (aiSkillCombineFollowups).
//
// Every value a card fills is a record field, master data or a fixed
// template filled from them, and the card's prefill map names which
// (docs/ai-prefill-autocomplete-design.md §3).

export const AI_SKILL_DRAFT_TYPES = Object.freeze(['po_followup_draft', 'supplier_followup_draft', 'purchase_request_draft'])
// Drafts addressed to a supplier, reviewed as a message.
const MESSAGE_TYPES = new Set(['po_followup_draft', 'supplier_followup_draft'])
const STOCK = new Set(['stock_shortage', 'stock_below_safety', 'stock_below_reorder'])
const PO = new Set(['po_overdue', 'po_due_7d', 'po_partially_received'])
const array = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const overdue = (po) => Number(po?.overdueDays) > 0

const poRowsCache = new WeakMap()
function poRowsOf(facts) {
  if (!poRowsCache.has(facts)) poRowsCache.set(facts, new Map(array(facts.purchaseOrders?.rows).map((row) => [row.id, row])))
  return poRowsCache.get(facts)
}

// What a signal calls for: a draft of some kind, or only a link.
// "Raised to the supplier's minimum order": the request asks for the minimum,
// more than the gap.
export function aiSkillMinimumText(raised, fmt, language) {
  return aiSkillText(raised.supplier ? 'draft.pr.minimum' : 'draft.pr.minimum_unnamed', language, { minimum: fmt.number(raised.minimum), gap: fmt.number(raised.gap), supplier: raised.supplier || '' })
}

export function aiSkillDraftCandidate(item, facts) {
  const poRows = poRowsOf(facts)
  if (PO.has(item.type) && poRows.has(item.entityId)) {
    const po = poRows.get(item.entityId)
    if (aiSkillPurchaseOrderNotSent(po)) return { kind: 'link', key: `link:${item.id}`, item, po, notSent: true }
    return overdue(po) ? { kind: 'po_followup_draft', key: `po:${item.entityId}`, item, po } : { kind: 'link', key: `link:${item.id}`, item, po, notDue: true }
  }
  if (STOCK.has(item.type)) {
    // Prefer the most overdue open PO that brings this SKU and was issued.
    const supplying = array(item.data.purchaseOrderIds).map((id) => poRows.get(id)).filter(Boolean).sort((a, b) => b.overdueDays - a.overdueDays || a.id.localeCompare(b.id))
    const issued = supplying.filter((po) => !aiSkillPurchaseOrderNotSent(po))
    if (issued.length && overdue(issued[0])) return { kind: 'po_followup_draft', key: `po:${issued[0].id}`, item, po: issued[0], chases: true }
    // On order and not late yet: nothing to chase.
    if (issued.length) return { kind: 'link', key: `link:${item.id}`, item, po: issued[0], onOrder: true }
    // Only orders not yet issued bring it: send them; a new request would order it twice.
    if (supplying.length) return { kind: 'link', key: `link:${item.id}`, item, po: supplying[0], notSent: true }
    if (!item.data.pendingRequests) {
      const target = Math.max(item.data.reorder ?? 0, item.data.safety ?? 0, (item.data.demand ?? 0))
      const gap = Math.max(1, Math.ceil(target - (item.data.available ?? 0) - (item.data.incoming ?? 0) - (item.data.pendingRequests ?? 0)))
      // At least the preferred supplier's minimum order, as the reorder list asks
      // for (requestMinimumOf in reorder-list.mjs); the answer says so.
      const minimum = Number(item.data.minimum) > 0 ? Number(item.data.minimum) : 0
      const quantity = Math.max(gap, minimum)
      return { kind: 'purchase_request_draft', key: `pr:${item.entityId}`, item, quantity, target, ...(minimum > gap ? { raisedToMinimum: { minimum, gap, supplier: item.data.minimumSupplier || null } } : {}) }
    }
    return { kind: 'link', key: `link:${item.id}`, item, pendingRequest: true }
  }
  if (item.type === 'invoice_variance') return { kind: 'supplier_followup_draft', key: `inv:${item.entityId}`, item }
  return { kind: 'link', key: `link:${item.id}`, item }
}

// One message per supplier: in a draft answer, several follow-ups to one
// supplier become one draft that covers each order's open lines, in the place
// of the first of them (the most urgent).
export function aiSkillCombineFollowups(candidates) {
  const ordersOf = new Map()
  for (const candidate of candidates) {
    if (candidate.kind !== 'po_followup_draft' || !candidate.po?.supplierId) continue
    const orders = ordersOf.get(candidate.po.supplierId) || new Map()
    orders.set(candidate.po.id, candidate.po)
    ordersOf.set(candidate.po.supplierId, orders)
  }
  const combined = new Set()
  return candidates.flatMap((candidate) => {
    const orders = candidate.kind === 'po_followup_draft' ? ordersOf.get(candidate.po?.supplierId) : null
    if (!orders || orders.size < 2) return [candidate]
    if (combined.has(candidate.po.supplierId)) return []
    combined.add(candidate.po.supplierId)
    return [{ ...candidate, key: `supplier:${candidate.po.supplierId}`, pos: [...orders.values()] }]
  })
}

// The orders a follow-up card's message covers.
export function aiSkillDraftOrders(card) {
  if (card?.draftType !== 'po_followup_draft') return []
  return array(card.payload?.poIds).length ? card.payload.poIds : [card.payload?.poId].filter(Boolean)
}

// The supplier's contact from master data, for readers who may draft
// (ai-skill-readers.mjs adds it only for them).
function supplierContact(facts, supplierId) {
  const supplier = supplierId ? array(facts.suppliers).find((row) => row.id === supplierId) : null
  return { email: text(supplier?.email), contactName: text(supplier?.contactName) }
}

// The recipient fields: the email on file, or a note that there is none.
const recipient = (contact) => ({ ...(contact.email ? { to: contact.email } : { toMissing: true }), ...(contact.contactName ? { contactName: contact.contactName } : {}) })

function withGreeting(name, body, language) {
  return [aiSkillText('draft.greeting', language, { name }), '', body, '', aiSkillText('draft.closing', language)].join('\n')
}

const knownLines = (po) => {
  const lines = array(po.openLines)
  return lines.length && !lines.some((line) => !line.sku || line.remaining === null || line.remaining === undefined) ? lines : null
}

// One bullet per open line: its remaining quantity, how much of the order
// arrived when part of it did, and the date promised for it (and the original
// date when it moved). `prefix` names the order in a message about several.
function lineBullet(line, fmt, language, prefix = '') {
  const partial = Number(line.received) > 0 && Number(line.ordered) > 0
  return aiSkillText(partial ? 'draft.po_followup.bullet_partial' : 'draft.po_followup.bullet', language, {
    prefix,
    sku: line.sku,
    item: line.itemName && line.itemName !== line.sku ? ` ${line.itemName}` : '',
    quantity: fmt.quantity(line.remaining, line.unit),
    ...(partial ? { ordered: fmt.number(line.ordered), received: fmt.number(line.received) } : {}),
    promised: line.promisedDate ? aiSkillText('draft.po_followup.promised', language, { date: fmt.day(line.promisedDate) }) + (line.originalPromisedDate && line.originalPromisedDate !== line.promisedDate ? aiSkillText('draft.po_followup.originally', language, { date: fmt.day(line.originalPromisedDate) }) : '') : '',
  })
}

// One line per open PO line. When the open lines are unknown (none, or one
// without a SKU or a known quantity) the message names none.
function poFollowupBody(po, fmt, language) {
  const lines = knownLines(po)
  if (!lines) return aiSkillText('draft.po_followup.message_generic', language, { po: po.orderNumber })
  return [aiSkillText(lines.length === 1 ? 'draft.po_followup.intro_one' : 'draft.po_followup.intro_many', language, { po: po.orderNumber }), ...lines.map((line) => lineBullet(line, fmt, language))].join('\n')
}

// Several orders to one supplier: each order's open lines, named by order.
function ordersFollowupBody(pos, fmt, language) {
  const bullets = pos.flatMap((po) => {
    const lines = knownLines(po)
    return lines ? lines.map((line) => lineBullet(line, fmt, language, aiSkillText('draft.po_followup.order_prefix', language, { po: po.orderNumber }))) : [aiSkillText('draft.po_followup.bullet_order_generic', language, { po: po.orderNumber })]
  })
  return [aiSkillText('draft.po_followup.intro_orders', language), ...bullets].join('\n')
}

function poFollowupSubject(po, language) {
  const lines = array(po.openLines)
  if (!lines.length || lines.some((line) => !line.sku)) return aiSkillText('draft.po_followup.subject_generic', language, { po: po.orderNumber })
  return lines.length === 1
    ? aiSkillText('draft.po_followup.subject_one', language, { po: po.orderNumber, sku: lines[0].sku })
    : aiSkillText('draft.po_followup.subject', language, { po: po.orderNumber, count: aiSkillFormatter({}, language).number(lines.length) })
}

// The prefill map: which payload fields were filled, and from where.
function prefillOf(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, entry]) => entry.value).map(([field, entry]) => [field, { source: entry.source, ref: entry.ref, value: entry.value }]))
}

export function aiSkillDraftCard(candidate, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const { item } = candidate
  const base = { previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: ['send', 'approve', 'pay', 'issue', 'cancel', 'delete'], allowedNextStep: aiSkillText('draft.review', language) }
  if (candidate.kind === 'po_followup_draft') {
    const pos = array(candidate.pos).length > 1 ? candidate.pos : [candidate.po]
    const po = pos[0]
    const several = pos.length > 1
    const contact = supplierContact(facts, po.supplierId)
    // Asked about partial delivery: whether what is ready can ship first.
    const ask = candidate.askPartial ? aiSkillText('draft.po_followup.ask_partial', language) : ''
    const message = withGreeting(contact.contactName || po.supplier || po.supplierId, [several ? ordersFollowupBody(pos, fmt, language) : poFollowupBody(po, fmt, language), ask].filter(Boolean).join('\n\n'), language)
    const orders = pos.map((row) => row.orderNumber || row.id)
    const subject = several ? aiSkillText('draft.po_followup.subject_orders', language, { pos: orders.join(language === 'zh-CN' ? '、' : ', ') }) : poFollowupSubject(po, language)
    const supplier = po.supplier || po.supplierId
    const title = several ? aiSkillText('draft.po_followup.title_orders', language, { supplier, count: fmt.number(pos.length) }) : aiSkillText('draft.po_followup.title', language, { supplier, po: po.orderNumber })
    // The open lines travel with the message, for the review form to show;
    // in a message about several orders each line names its order.
    const lines = pos.flatMap((row) => array(row.openLines).map((line) => ({ ...line, ...(several ? { po: row.orderNumber || row.id } : {}) })))
    return { ...base, title, draftTitle: title, description: aiSkillSignalReason(item, facts, language), draftType: 'po_followup_draft', targetModule: AI_SKILL_MODULES.purchase_order,
      ...(several ? { targetEntityType: 'supplier', targetEntityId: po.supplierId } : { targetEntityType: 'purchase_order', targetEntityId: po.id }),
      payload: { poId: po.id, ...(several ? { poIds: pos.map((row) => row.id) } : {}), supplierId: po.supplierId, supplierName: po.supplier, ...recipient(contact), subject, message, lines, language, reason: aiSkillSignalReason(item, facts, language) },
      prefill: prefillOf({ to: { source: 'default', ref: 'supplier:email', value: contact.email }, subject: { source: 'template', ref: several ? 'draft.po_followup.subject_orders' : 'draft.po_followup.subject', value: subject }, message: { source: 'template', ref: 'draft.po_followup.message', value: message } }),
      originEvidence: several ? pos.map((row) => ({ entityType: 'purchase_order', entityId: row.id })) : [{ entityType: item.entityType, entityId: item.entityId }] }
  }
  if (candidate.kind === 'supplier_followup_draft') {
    // A supplier the role may not see on invoices has no id here, so no contact either.
    const contact = supplierContact(facts, item.supplierId)
    const body = item.data.variance === null ? aiSkillText('draft.invoice.message_hidden', language, { invoice: item.label }) : aiSkillText('draft.invoice.message', language, { invoice: item.label, amount: fmt.money(item.data.variance, item.data.currency) })
    const message = withGreeting(contact.contactName || item.supplier || aiSkillText('value.a_supplier', language), body, language)
    const subject = aiSkillText('draft.invoice.subject', language, { invoice: item.label })
    const title = aiSkillText('draft.invoice.title', language, { supplier: item.supplier || item.supplierId, invoice: item.label })
    return { ...base, title, draftTitle: title, description: aiSkillSignalReason(item, facts, language), draftType: 'supplier_followup_draft', targetModule: AI_SKILL_MODULES.supplier_invoice, targetEntityType: 'supplier_invoice', targetEntityId: item.entityId,
      payload: { supplierId: item.supplierId, supplierName: item.supplier, invoiceId: item.entityId, poId: item.data.poId, ...(item.supplierId ? recipient(contact) : {}), subject, message, language, reason: aiSkillSignalReason(item, facts, language) },
      prefill: prefillOf({ to: { source: 'default', ref: 'supplier:email', value: contact.email }, subject: { source: 'template', ref: 'draft.invoice.subject', value: subject }, message: { source: 'template', ref: 'draft.invoice.message', value: message } }),
      originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
  }
  const title = aiSkillText('draft.pr.title', language, { quantity: fmt.number(candidate.quantity), unit: '', sku: item.label }).replace(/\s{2,}/g, ' ')
  const reason = [aiSkillText('draft.pr.reason', language, { available: fmt.number(item.data.available), target: fmt.number(candidate.target) }), candidate.raisedToMinimum ? aiSkillMinimumText(candidate.raisedToMinimum, fmt, language) : ''].filter(Boolean).join(language === 'zh-CN' ? '' : ' ')
  return { ...base, allowedNextStep: aiSkillText('draft.create_pr', language), title, draftTitle: title, description: reason, draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: item.entityId,
    payload: { itemIdOrSku: item.label, quantity: candidate.quantity, reason, language }, originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
}

// The documents an answer cited (its knowledge supplement) on each supplier
// message: up to two sections, a section within a document first, so the
// review shows which rule the draft follows. Never added to the message.
export function aiSkillDraftBasis(response) {
  const citations = array(response?.supplementalKnowledge?.rag?.citations)
  if (!citations.length || !array(response.reviewCards).some((card) => MESSAGE_TYPES.has(card.draftType))) return response
  const sectionOf = (citation) => text(citation.heading).split(' › ')
  const ranked = [...citations].sort((a, b) => Number(sectionOf(b).length > 1) - Number(sectionOf(a).length > 1))
  const basis = [...new Map(ranked.map((citation) => [`${citation.title}|${text(citation.heading)}`, { title: citation.title, section: sectionOf(citation).at(-1) || null, citationId: citation.id }])).values()].slice(0, 2)
  return { ...response, reviewCards: response.reviewCards.map((card) => MESSAGE_TYPES.has(card.draftType) ? { ...card, payload: { ...card.payload, basis } } : card) }
}

// The next step a signal calls for, as a sentence in the answer language.
export function aiSkillNextStepText(candidate, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const { item } = candidate
  const supplier = item.supplier || item.data?.supplier || aiSkillText('value.a_supplier', language)
  if (candidate.kind === 'po_followup_draft' && candidate.chases) return aiSkillText('next.chase_po', language, { po: candidate.po.orderNumber })
  if (candidate.kind === 'po_followup_draft') return aiSkillText('next.po_followup', language, { supplier: candidate.po.supplier || supplier })
  if (candidate.kind === 'purchase_request_draft') return aiSkillText(candidate.raisedToMinimum ? (candidate.raisedToMinimum.supplier ? 'next.raise_pr_minimum' : 'next.raise_pr_minimum_unnamed') : 'next.raise_pr', language, { quantity: fmt.number(candidate.quantity), supplier: candidate.raisedToMinimum?.supplier || '' })
  if (candidate.kind === 'supplier_followup_draft') return aiSkillText('next.invoice_query', language, { supplier })
  if (candidate.notSent) return aiSkillText('next.send_po', language, { po: candidate.po.orderNumber || candidate.po.id })
  if (candidate.notDue) return candidate.po.dueDate ? aiSkillText('next.not_due', language, { date: fmt.day(candidate.po.dueDate) }) : ''
  if (candidate.onOrder) return aiSkillText(candidate.po.dueDate ? 'next.on_order' : 'next.on_order_no_date', language, { po: candidate.po.orderNumber || candidate.po.id, date: candidate.po.dueDate ? fmt.day(candidate.po.dueDate) : '' })
  if (candidate.pendingRequest) return aiSkillText('next.await_pr', language)
  const key = { grn_rejected_qty: 'next.rejected', grn_received_unposted: 'next.post_receipt', pr_awaiting_approval: 'next.review_request', rfq_ready_to_award: 'next.compare_quotes' }[item.type]
  return key ? aiSkillText(key, language, { supplier }) : ''
}
