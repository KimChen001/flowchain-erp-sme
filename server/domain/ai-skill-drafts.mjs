import { aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillSignalReason } from './ai-skill-presenter.mjs'

// Review-only drafts for attention signals, shared by the "prepare a draft"
// answer and the draft offered on each answer line (ai-skill-next-steps.mjs).
// A draft is never sent, approved or saved by the assistant: each card opens
// the action draft review or a creation form, and there is never a purchase
// order draft (the draft boundary has no PO type).
//   overdue, due or partially received PO, or a shortage an open PO covers -> po_followup_draft
//   shortage no open PO or pending request covers                      -> purchase_request_draft
//   invoice variance                                                    -> supplier_followup_draft
//   anything else                                                       -> a link only
//
// Every value a card fills is a record field, master data or a fixed
// template filled from them, and the card's prefill map names which
// (docs/ai-prefill-autocomplete-design.md §3).

export const AI_SKILL_DRAFT_TYPES = Object.freeze(['po_followup_draft', 'supplier_followup_draft', 'purchase_request_draft'])
const STOCK = new Set(['stock_shortage', 'stock_below_safety', 'stock_below_reorder'])
const PO = new Set(['po_overdue', 'po_due_7d', 'po_partially_received'])
const array = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()

const poRowsCache = new WeakMap()
function poRowsOf(facts) {
  if (!poRowsCache.has(facts)) poRowsCache.set(facts, new Map(array(facts.purchaseOrders?.rows).map((row) => [row.id, row])))
  return poRowsCache.get(facts)
}

// What a signal calls for: a draft of some kind, or only a link.
export function aiSkillDraftCandidate(item, facts) {
  const poRows = poRowsOf(facts)
  if (PO.has(item.type) && poRows.has(item.entityId)) return { kind: 'po_followup_draft', key: `po:${item.entityId}`, item, po: poRows.get(item.entityId) }
  if (STOCK.has(item.type)) {
    // Prefer the most overdue open PO that brings this SKU.
    const supplying = array(item.data.purchaseOrderIds).map((id) => poRows.get(id)).filter(Boolean).sort((a, b) => b.overdueDays - a.overdueDays || a.id.localeCompare(b.id))
    if (supplying.length) return { kind: 'po_followup_draft', key: `po:${supplying[0].id}`, item, po: supplying[0], chases: true }
    if (!item.data.pendingRequests) {
      const target = Math.max(item.data.reorder ?? 0, item.data.safety ?? 0, (item.data.demand ?? 0))
      const quantity = Math.max(1, Math.ceil(target - (item.data.available ?? 0) - (item.data.incoming ?? 0) - (item.data.pendingRequests ?? 0)))
      return { kind: 'purchase_request_draft', key: `pr:${item.entityId}`, item, quantity, target }
    }
    return { kind: 'link', key: `link:${item.id}`, item, pendingRequest: true }
  }
  if (item.type === 'invoice_variance') return { kind: 'supplier_followup_draft', key: `inv:${item.entityId}`, item }
  return { kind: 'link', key: `link:${item.id}`, item }
}

// The supplier's contact from master data, for readers who may draft
// (ai-skill-readers.mjs adds it only for them).
function supplierContact(facts, supplierId) {
  const supplier = supplierId ? array(facts.suppliers).find((row) => row.id === supplierId) : null
  return { email: text(supplier?.email), contactName: text(supplier?.contactName) }
}

function withGreeting(name, body, language) {
  return [aiSkillText('draft.greeting', language, { name }), '', body, '', aiSkillText('draft.closing', language)].join('\n')
}

// One line per open PO line, each with its own remaining quantity and the
// date promised for it (and the original date when it moved). When the open
// lines are unknown (none, or one without a SKU or a known quantity) the
// message names none.
export function poFollowupBody(po, fmt, language) {
  const lines = array(po.openLines)
  if (!lines.length || lines.some((line) => !line.sku || line.remaining === null || line.remaining === undefined)) return aiSkillText('draft.po_followup.message_generic', language, { po: po.orderNumber })
  const bullets = lines.map((line) => aiSkillText('draft.po_followup.bullet', language, {
    sku: line.sku,
    item: line.itemName && line.itemName !== line.sku ? ` ${line.itemName}` : '',
    quantity: fmt.quantity(line.remaining, line.unit),
    promised: line.promisedDate ? aiSkillText('draft.po_followup.promised', language, { date: fmt.day(line.promisedDate) }) + (line.originalPromisedDate && line.originalPromisedDate !== line.promisedDate ? aiSkillText('draft.po_followup.originally', language, { date: fmt.day(line.originalPromisedDate) }) : '') : '',
  }))
  return [aiSkillText(lines.length === 1 ? 'draft.po_followup.intro_one' : 'draft.po_followup.intro_many', language, { po: po.orderNumber }), ...bullets].join('\n')
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
    const po = candidate.po
    const contact = supplierContact(facts, po.supplierId)
    const message = withGreeting(contact.contactName || po.supplier || po.supplierId, poFollowupBody(po, fmt, language), language)
    const subject = poFollowupSubject(po, language)
    const title = aiSkillText('draft.po_followup.title', language, { supplier: po.supplier || po.supplierId, po: po.orderNumber })
    // The open lines travel with the message, for the review form to show.
    return { ...base, title, draftTitle: title, description: aiSkillSignalReason(item, facts, language), draftType: 'po_followup_draft', targetModule: AI_SKILL_MODULES.purchase_order, targetEntityType: 'purchase_order', targetEntityId: po.id,
      payload: { poId: po.id, supplierId: po.supplierId, supplierName: po.supplier, ...(contact.email ? { to: contact.email } : {}), ...(contact.contactName ? { contactName: contact.contactName } : {}), subject, message, lines: array(po.openLines).map((line) => ({ ...line })), language, reason: aiSkillSignalReason(item, facts, language) },
      prefill: prefillOf({ to: { source: 'default', ref: 'supplier:email', value: contact.email }, subject: { source: 'template', ref: 'draft.po_followup.subject', value: subject }, message: { source: 'template', ref: 'draft.po_followup.message', value: message } }),
      originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
  }
  if (candidate.kind === 'supplier_followup_draft') {
    // A supplier the role may not see on invoices has no id here, so no contact either.
    const contact = supplierContact(facts, item.supplierId)
    const body = item.data.variance === null ? aiSkillText('draft.invoice.message_hidden', language, { invoice: item.label }) : aiSkillText('draft.invoice.message', language, { invoice: item.label, amount: fmt.money(item.data.variance, item.data.currency) })
    const message = withGreeting(contact.contactName || item.supplier || aiSkillText('value.a_supplier', language), body, language)
    const subject = aiSkillText('draft.invoice.subject', language, { invoice: item.label })
    const title = aiSkillText('draft.invoice.title', language, { supplier: item.supplier || item.supplierId, invoice: item.label })
    return { ...base, title, draftTitle: title, description: aiSkillSignalReason(item, facts, language), draftType: 'supplier_followup_draft', targetModule: AI_SKILL_MODULES.supplier_invoice, targetEntityType: 'supplier_invoice', targetEntityId: item.entityId,
      payload: { supplierId: item.supplierId, supplierName: item.supplier, invoiceId: item.entityId, poId: item.data.poId, ...(contact.email ? { to: contact.email } : {}), ...(contact.contactName ? { contactName: contact.contactName } : {}), subject, message, language, reason: aiSkillSignalReason(item, facts, language) },
      prefill: prefillOf({ to: { source: 'default', ref: 'supplier:email', value: contact.email }, subject: { source: 'template', ref: 'draft.invoice.subject', value: subject }, message: { source: 'template', ref: 'draft.invoice.message', value: message } }),
      originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
  }
  const title = aiSkillText('draft.pr.title', language, { quantity: fmt.number(candidate.quantity), unit: '', sku: item.label }).replace(/\s{2,}/g, ' ')
  const reason = aiSkillText('draft.pr.reason', language, { available: fmt.number(item.data.available), target: fmt.number(candidate.target) })
  return { ...base, allowedNextStep: aiSkillText('draft.create_pr', language), title, draftTitle: title, description: reason, draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: item.entityId,
    payload: { itemIdOrSku: item.label, quantity: candidate.quantity, reason, language }, originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
}

// The next step a signal calls for, as a sentence in the answer language.
export function aiSkillNextStepText(candidate, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const { item } = candidate
  const supplier = item.supplier || item.data?.supplier || aiSkillText('value.a_supplier', language)
  if (candidate.kind === 'po_followup_draft' && candidate.chases) return aiSkillText('next.chase_po', language, { po: candidate.po.orderNumber })
  if (candidate.kind === 'po_followup_draft') return aiSkillText('next.po_followup', language, { supplier: candidate.po.supplier || supplier })
  if (candidate.kind === 'purchase_request_draft') return aiSkillText('next.raise_pr', language, { quantity: fmt.number(candidate.quantity) })
  if (candidate.kind === 'supplier_followup_draft') return aiSkillText('next.invoice_query', language, { supplier })
  if (candidate.pendingRequest) return aiSkillText('next.await_pr', language)
  const key = { grn_rejected_qty: 'next.rejected', grn_received_unposted: 'next.post_receipt', pr_awaiting_approval: 'next.review_request', rfq_ready_to_award: 'next.compare_quotes' }[item.type]
  return key ? aiSkillText(key, language, { supplier }) : ''
}

// Starting an order (ai-skill-start-order.mjs) words its follow-up as the drafts do.
export { poFollowupBody as poFollowupMessage }
