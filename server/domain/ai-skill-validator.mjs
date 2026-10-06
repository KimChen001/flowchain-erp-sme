import { AI_SKILL_DRAFT_TYPES } from './ai-skill-prepare-action-draft.mjs'
import { aiAnswerClaimsAction } from './ai-answer-claims.mjs'

// Checks a skill answer before it leaves the server:
//   - every evidence, link and review card id is a record the readers returned;
//   - links return to the assistant, and review cards are review-only drafts of
//     a supported type;
//   - an English answer has no Chinese outside stored values (record names and
//     ids), which are allowlisted;
//   - no text claims the assistant sent, approved, paid, issued or placed
//     anything. Word-bounded, so "delivered quantity", "feedback", "working
//     capital" and "evaluation" pass.
// This path does not use validateAiRuntimeResponseV2, whose substring rules
// treat Chinese labels as identifiers.

const CJK = /[㐀-鿿豈-﫿]/u
const array = (value) => Array.isArray(value) ? value : []
const text = (value) => value === null || value === undefined ? '' : String(value)

// Ids and stored names the readers returned; only these may appear as record
// references, and only these may carry Chinese in an English answer.
export function aiSkillKnownValues(facts) {
  const ids = new Set()
  const stored = new Set()
  const add = (...values) => { for (const value of values) if (text(value).trim()) ids.add(text(value).trim()) }
  const keep = (...values) => { for (const value of values) if (text(value).trim()) stored.add(text(value).trim()) }
  if (!facts) return { ids, stored }
  for (const row of array(facts.purchaseOrders?.rows)) { add(row.id, row.orderNumber, row.supplierId); keep(row.supplier, row.orderNumber, row.sku, row.unit) }
  for (const row of array(facts.purchaseOrders?.index)) { add(row.id, row.orderNumber, row.supplierId); keep(row.supplier, row.orderNumber, row.unit) }
  for (const row of [...array(facts.purchaseOrders?.rows), ...array(facts.purchaseOrders?.index)]) for (const line of array(row.openLines)) keep(line.sku, line.itemName, line.unit)
  for (const row of array(facts.suppliers)) { add(row.id, row.code); keep(row.name, row.code, row.contactName, row.email) }
  for (const row of array(facts.inventory?.rows)) {
    add(row.itemId, row.sku, ...array(row.purchaseOrderIds))
    keep(row.sku, row.itemName, row.unit)
    for (const line of array(row.incomingOtherUnit)) { add(line.purchaseOrderId, line.orderNumber); keep(line.orderNumber, line.unit) }
  }
  for (const row of array(facts.inventory?.masterOnly)) { add(row.itemId, row.sku); keep(row.sku, row.itemName, row.unit) }
  for (const row of array(facts.invoices?.variances)) { add(row.id, row.invoiceNumber, row.supplierId, row.poId); keep(row.supplier, row.invoiceNumber) }
  for (const row of array(facts.purchaseRequests?.awaitingApproval)) { add(row.id); keep(row.sku, row.unit) }
  for (const row of [...array(facts.rfqs?.readyToAward), ...array(facts.rfqs?.open)]) { add(row.id); keep(row.title) }
  for (const row of [...array(facts.receipts?.rejected), ...array(facts.receipts?.unposted)]) { add(row.id, row.documentNumber, row.poId, row.supplierId); keep(row.supplier, row.documentNumber, row.unit) }
  for (const row of array(facts.records)) { add(row.entityId); keep(row.label) }
  for (const value of ids) stored.add(value)
  return { ids, stored }
}

function visibleTexts(response) {
  const out = [
    ['conclusion.title', response.conclusion?.title], ['conclusion.summary', response.conclusion?.summary],
    ['answerSourceLabel', response.answerSourceLabel], ['checkedLabel', response.checkedLabel], ['dataScopeLabel', response.dataScopeLabel],
  ]
  for (const [index, item] of array(response.keyEvidence).entries()) for (const key of ['label', 'entityLabel', 'summary', 'status', 'value', 'sourceLabel', 'nextStep']) out.push([`keyEvidence.${index}.${key}`, item[key]])
  for (const [index, item] of array(response.businessImpact).entries()) for (const key of ['area', 'impact', 'explanation']) out.push([`businessImpact.${index}.${key}`, item[key]])
  for (const [index, item] of array(response.navigationLinks).entries()) out.push([`navigationLinks.${index}.label`, item.label])
  for (const [index, item] of array(response.dataLimitations).entries()) for (const key of ['label', 'description', 'consequence']) out.push([`dataLimitations.${index}.${key}`, item[key]])
  for (const [index, item] of array(response.reviewCards).entries()) {
    for (const key of ['title', 'description', 'allowedNextStep', 'draftTitle']) out.push([`reviewCards.${index}.${key}`, item[key]])
    for (const key of ['message', 'reason', 'subject']) out.push([`reviewCards.${index}.payload.${key}`, item.payload?.[key]])
  }
  for (const [index, item] of array(response.sections).entries()) for (const key of ['title', 'summary']) out.push([`sections.${index}.${key}`, item[key]])
  for (const [index, item] of array(response.followUpSuggestions).entries()) for (const key of ['label', 'prompt']) out.push([`followUpSuggestions.${index}.${key}`, item[key]])
  for (const [index, item] of array(response.safetyBoundaries).entries()) out.push([`safetyBoundaries.${index}`, item])
  return out.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([path, value]) => [path, String(value)])
}

// `extra` adds the ids and stored names another read service returned for this
// answer: the supplier business query's records in an agent planning answer.
export function validateAiSkillResponse(response, facts, extra = {}) {
  const errors = []
  const { ids, stored } = aiSkillKnownValues(facts)
  for (const value of array(extra.ids)) if (text(value).trim()) { ids.add(text(value).trim()); stored.add(text(value).trim()) }
  for (const value of array(extra.stored)) if (text(value).trim()) stored.add(text(value).trim())
  const known = (id) => ids.has(text(id).trim())
  for (const item of array(response.keyEvidence)) if (item.entityId && !known(item.entityId)) errors.push(`evidence id not read: ${item.entityId}`)
  for (const link of array(response.navigationLinks)) {
    if (link.returnTo !== 'ai-assistant') errors.push(`link does not return to the assistant: ${link.label}`)
    if (link.entityId && !known(link.entityId)) errors.push(`link id not read: ${link.entityId}`)
  }
  for (const card of array(response.reviewCards)) {
    if (card.previewOnly !== true || card.reviewRequired !== true || card.requiresHumanReview !== true) errors.push(`review card is not review-only: ${card.title}`)
    if (!AI_SKILL_DRAFT_TYPES.includes(card.draftType)) errors.push(`unsupported draft type: ${card.draftType}`)
    if (card.targetEntityId && !known(card.targetEntityId)) errors.push(`review card id not read: ${card.targetEntityId}`)
  }
  // Longest first, so a name containing a shorter stored value is removed whole.
  const allowlist = [...stored].sort((a, b) => b.length - a.length)
  for (const [path, value] of visibleTexts(response)) {
    // Stored names and ids are removed first: a supplier called "We Paid
    // Logistics" is a name, not a claim.
    const stripped = allowlist.reduce((output, entry) => output.split(entry).join(''), value)
    if (response.language !== 'zh-CN' && CJK.test(stripped)) errors.push(`Chinese text in an English answer at ${path}`)
    if (aiAnswerClaimsAction(stripped)) errors.push(`claims an action was taken at ${path}`)
  }
  for (const figure of array(response.figures)) if (figure.entityId && !known(figure.entityId)) errors.push(`figure id not read: ${figure.entityId}`)
  return { ok: errors.length === 0, errors }
}

export function assertValidAiSkillResponse(response, facts, extra = {}) {
  const result = validateAiSkillResponse(response, facts, extra)
  if (!result.ok) throw Object.assign(new Error('The assistant answer failed validation.'), { code: 'AI_SKILL_ANSWER_INVALID', status: 503, details: result.errors })
  return response
}
