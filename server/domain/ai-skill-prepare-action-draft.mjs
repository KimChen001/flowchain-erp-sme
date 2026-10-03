import { aiSkillCountText, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillNavigation, aiSkillSignalReason, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItems } from './ai-skill-signals.mjs'
import { matchesAiSkillFocus } from './ai-skill-today-priorities.mjs'

// Review-only drafts for the top signals. A draft is never sent, approved or
// saved by the assistant: each card opens the action draft review, and there
// is never a purchase order draft (the draft boundary has no PO type).
//   overdue, due or partially received PO, or a shortage an open PO covers -> po_followup_draft
//   shortage no open PO or pending request covers                      -> purchase_request_draft
//   invoice variance                                                    -> supplier_followup_draft
//   request awaiting approval, RFQ ready to award                       -> a link only

export const AI_SKILL_DRAFT_TYPES = Object.freeze(['po_followup_draft', 'supplier_followup_draft', 'purchase_request_draft'])
const MAX_CARDS = 3
const STOCK = new Set(['stock_shortage', 'stock_below_safety', 'stock_below_reorder'])
const PO = new Set(['po_overdue', 'po_due_7d', 'po_partially_received'])

function candidates(facts, ranked) {
  const poRows = new Map((facts.purchaseOrders?.rows || []).map((row) => [row.id, row]))
  const out = []
  for (const item of ranked) {
    if (PO.has(item.type) && poRows.has(item.entityId)) out.push({ kind: 'po_followup_draft', key: `po:${item.entityId}`, item, po: poRows.get(item.entityId) })
    else if (STOCK.has(item.type)) {
      // Prefer the most overdue open PO that brings this SKU.
      const supplying = (item.data.purchaseOrderIds || []).map((id) => poRows.get(id)).filter(Boolean).sort((a, b) => b.overdueDays - a.overdueDays || a.id.localeCompare(b.id))
      if (supplying.length) out.push({ kind: 'po_followup_draft', key: `po:${supplying[0].id}`, item, po: supplying[0] })
      else if (!item.data.pendingRequests) {
        const target = Math.max(item.data.reorder ?? 0, item.data.safety ?? 0, (item.data.demand ?? 0))
        const quantity = Math.max(1, Math.ceil(target - (item.data.available ?? 0) - (item.data.incoming ?? 0) - (item.data.pendingRequests ?? 0)))
        out.push({ kind: 'purchase_request_draft', key: `pr:${item.entityId}`, item, quantity, target })
      } else out.push({ kind: 'link', key: `link:${item.id}`, item })
    } else if (item.type === 'invoice_variance') out.push({ kind: 'supplier_followup_draft', key: `inv:${item.entityId}`, item })
    else out.push({ kind: 'link', key: `link:${item.id}`, item })
  }
  return out
}

export function runPrepareActionDraft(facts, { focus = null } = {}) {
  const ranked = rankAiSkillItems(buildAiSkillSignals(facts)).filter((item) => matchesAiSkillFocus(item, focus))
  const all = candidates(facts, ranked)
  const seen = new Set()
  const drafts = []
  const take = (candidate) => { if (drafts.length < MAX_CARDS && !seen.has(candidate.key)) { seen.add(candidate.key); drafts.push(candidate) } }
  // The best candidate of each draft type first, then the rest by rank.
  for (const kind of AI_SKILL_DRAFT_TYPES) { const first = all.find((candidate) => candidate.kind === kind); if (first) take(first) }
  for (const candidate of all.filter((entry) => entry.kind !== 'link')) take(candidate)
  drafts.sort((a, b) => a.item.rank - b.item.rank)
  const canDraft = Boolean(facts.visibility?.canDraft)
  return {
    skillId: 'prepare_action_draft', focus, canDraft,
    drafts: canDraft ? drafts : [],
    links: all.filter((candidate) => candidate.kind === 'link').slice(0, 3).map((candidate) => candidate.item),
    items: [...(canDraft ? drafts : all.filter((candidate) => candidate.kind !== 'link').slice(0, MAX_CARDS)).map((candidate) => candidate.item), ...all.filter((candidate) => candidate.kind === 'link').slice(0, 2).map((candidate) => candidate.item)]
      .filter((item, index, rows) => rows.findIndex((row) => row.id === item.id) === index),
  }
}

function card(candidate, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const { item } = candidate
  const base = { previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: ['send', 'approve', 'pay', 'issue', 'cancel', 'delete'], allowedNextStep: aiSkillText('draft.review', language) }
  if (candidate.kind === 'po_followup_draft') {
    const po = candidate.po
    const message = po.sku && po.remaining !== null
      ? aiSkillText('draft.po_followup.message', language, { remaining: fmt.number(po.remaining), unit: po.unit && po.unit !== 'mixed' ? po.unit : '', sku: po.sku, po: po.orderNumber }).replace(/\s{2,}/g, ' ')
      : aiSkillText('draft.po_followup.message_generic', language, { po: po.orderNumber })
    const title = aiSkillText('draft.po_followup.title', language, { supplier: po.supplier || po.supplierId, po: po.orderNumber })
    return { ...base, title, draftTitle: title, description: aiSkillSignalReason(item, facts, language), draftType: 'po_followup_draft', targetModule: AI_SKILL_MODULES.purchase_order, targetEntityType: 'purchase_order', targetEntityId: po.id,
      payload: { poId: po.id, supplierId: po.supplierId, supplierName: po.supplier, message, language, reason: aiSkillSignalReason(item, facts, language) }, originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
  }
  if (candidate.kind === 'supplier_followup_draft') {
    const title = aiSkillText('draft.invoice.title', language, { supplier: item.supplier || item.supplierId, invoice: item.label })
    return { ...base, title, draftTitle: title, description: aiSkillSignalReason(item, facts, language), draftType: 'supplier_followup_draft', targetModule: AI_SKILL_MODULES.supplier_invoice, targetEntityType: 'supplier_invoice', targetEntityId: item.entityId,
      payload: { supplierId: item.supplierId, supplierName: item.supplier, invoiceId: item.entityId, poId: item.data.poId, message: item.data.variance === null ? aiSkillText('draft.invoice.message_hidden', language, { invoice: item.label }) : aiSkillText('draft.invoice.message', language, { invoice: item.label, amount: fmt.money(item.data.variance, item.data.currency) }), language, reason: aiSkillSignalReason(item, facts, language) }, originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
  }
  const title = aiSkillText('draft.pr.title', language, { quantity: fmt.number(candidate.quantity), unit: '', sku: item.label }).replace(/\s{2,}/g, ' ')
  const reason = aiSkillText('draft.pr.reason', language, { available: fmt.number(item.data.available), target: fmt.number(candidate.target) })
  return { ...base, allowedNextStep: aiSkillText('draft.create_pr', language), title, draftTitle: title, description: reason, draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: item.entityId,
    payload: { itemIdOrSku: item.label, quantity: candidate.quantity, reason, language }, originEvidence: [{ entityType: item.entityType, entityId: item.entityId }] }
}

// Narrowed to one record, the title names it.
function focusTitle(id, count, fmt, language) {
  if (!count) return aiSkillText('draft.focus_none', language, { id })
  return aiSkillText(count === 1 ? 'draft.focus_title' : 'draft.focus_title_many', language, { id, count: fmt.number(count) })
}

export function presentPrepareActionDraft(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const reviewCards = result.drafts.map((candidate) => card(candidate, facts, language))
  const extraLimitations = result.canDraft ? [] : [{ code: 'draft_permission', label: aiSkillText('limitation.draft_permission.label', language), description: aiSkillText('draft.no_permission', language), severity: 'warning', missingData: [] }]
  return presentAiSkillAnswer({
    skill, facts, language, query,
    title: !result.canDraft ? aiSkillText('draft.title_blocked', language) : result.focus ? focusTitle(result.focus.entityId, reviewCards.length, fmt, language) : aiSkillCountText('draft.title', reviewCards.length, language, { count: fmt.number(reviewCards.length) }),
    summary: aiSkillText(!result.canDraft ? 'draft.no_permission' : reviewCards.length ? 'draft.summary' : 'draft.none_summary', language),
    severity: result.items[0]?.severity || 'info',
    items: result.items,
    navigation: [...result.drafts.map((candidate) => candidate.item), ...result.links].slice(0, 4).map((item) => aiSkillNavigation(item, language)),
    reviewCards,
    extraLimitations,
    followUpIds: ['today_priorities', 'highest_risk_items'],
  })
}
