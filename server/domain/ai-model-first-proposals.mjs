import { aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter } from './ai-skill-presenter.mjs'
import { aiToolRef, aiToolSupplier } from './ai-read-tool-contract.mjs'

// Proposal tools of the model-first assistant (docs/ai-model-first-design.md
// §4, propose_*; the first step of L2 in #151 under the approved rule: the
// assistant proposes, a person confirms, the system executes). A proposal
// opens a prefilled form in the panel for the user to review and submit; it
// never saves anything. Its card is the one the rules' order answer opens
// (ai-skill-start-order.mjs): a purchase_request_draft the panel opens itself
// (autoOpenDraftCard) with the item, the quantity and the supplier filled in.
//
// The model never chooses for the user: a proposal names only an item the
// user named, in this question or an earlier one, or chose from the items the
// previous answer offered ("the first one", 好的). A quantity or a supplier the
// user did not give is left for them to fill in.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).normalize('NFKC').toLowerCase()
const PROHIBITED = ['send', 'approve', 'pay', 'issue', 'cancel', 'delete']

export const AI_PROPOSE_PURCHASE_REQUEST = 'propose_purchase_request'

// The tool, for a user who may draft (the rules' own test, facts.visibility).
export function aiProposalToolDefinitions(facts) {
  if (!facts?.visibility?.canDraft || !facts.inventory) return []
  return [{
    name: AI_PROPOSE_PURCHASE_REQUEST,
    description: 'Opens a purchase request form in the panel, filled in, for the user to review and submit; nothing is saved. In FlowChain a purchase request comes first and becomes a purchase order after approval. Use it only for an item the user named, in this question or an earlier one, or chose from items you offered; if they did not say which item, ask, offering the items at risk or on the reorder list. Give the quantity and the supplier only when the user gave them. If open purchase orders already cover the item, say so first and propose only if the user still wants more.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sku'],
      properties: {
        sku: { type: 'string', maxLength: 80, description: 'The item\'s SKU.' },
        quantity: { type: 'number', description: 'The quantity the user asked for.' },
        supplier: { type: 'string', maxLength: 120, description: 'The supplier the user named.' },
      },
    },
  }]
}

// A reply that picks one of the choices the previous answer offered ("the
// first one", 就这个), or a short yes to what it proposed (好的, OK). A longer
// question with 可以 or 这个 in it ("可以帮我下单吗", 这个月) is not a pick.
const PICK = /\b(?:the\s+)?(?:first|second|third|last)(?:\s+one)?\b|\b(?:that|this|the)\s+one\b|第[一二三四五1-5]个?|最后一个|(?:就|选|要)(?:这个|那个|它)|(?:这个|那个)吧/i
const AGREE = /^(?:yes|ok(?:ay)?|sure|go ahead|do it|please do|好的?|可以|行|是的?|对|就这样|没问题)[\s,.!。！，]*$/i
export const aiProposalPicksChoice = (question) => PICK.test(text(question)) || AGREE.test(text(question))

// The words the user has given for this proposal: the question, the earlier
// questions, and, when the question picks or agrees, the previous answer.
export function aiProposalUserWords({ question, turns = [] }) {
  const words = [text(question), ...array(turns).map((turn) => text(turn?.question))]
  const last = array(turns).at(-1)
  if (last && aiProposalPicksChoice(question)) words.push(text(last.answer))
  return fold(words.join('\n'))
}

const mentions = (words, value) => {
  const needle = fold(value)
  return Boolean(needle) && new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'u').test(words)
}

function itemOf(facts, sku) {
  const wanted = fold(sku)
  return [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)].find((row) => fold(row.sku) === wanted) || null
}

// Runs a proposal call. Returns { ok: true, result, proposal } (the proposal
// becomes the answer's card) or { ok: false, error, details }.
export function runAiProposal(name, args = {}, { facts, words = '' } = {}) {
  if (name !== AI_PROPOSE_PURCHASE_REQUEST || !aiProposalToolDefinitions(facts).length) return { ok: false, error: 'not_allowed' }
  if (!args || typeof args !== 'object' || typeof args.sku !== 'string' || !text(args.sku)) return { ok: false, error: 'invalid_arguments', details: ['sku is required'] }
  const item = itemOf(facts, args.sku)
  if (!item) return { ok: false, error: 'not_found', details: ['No item with this SKU is readable. Search for it or ask the user.'] }
  if (!mentions(words, item.sku)) return { ok: false, error: 'item_not_named', details: ['The user has not named or chosen this item. Ask which item they want, offering the items at risk or on the reorder list as choices.'] }
  const quantity = typeof args.quantity === 'number' && Number.isFinite(args.quantity) && args.quantity > 0 && mentions(words, String(args.quantity)) ? args.quantity : null
  let supplier = null
  if (text(args.supplier)) {
    const found = aiToolSupplier(facts, args.supplier)
    if (found.supplier && (mentions(words, found.supplier.name) || mentions(words, found.supplier.code) || mentions(words, args.supplier))) supplier = found.supplier
  }
  const result = {
    opens: 'purchase_request_form',
    sku: item.sku,
    itemName: item.itemName || null,
    unit: item.unit || null,
    quantity,
    supplier: supplier ? supplier.name : null,
    note: [
      'The form opens in the panel for the user to review and submit; nothing is saved until they submit it. After approval the request becomes a purchase order.',
      ...(quantity === null ? ['The user gave no quantity, so the form opens without one.'] : []),
      ...(text(args.supplier) && !supplier ? ['The supplier was not one the user named, so the form opens with its usual supplier.'] : []),
    ].join(' '),
    ref: aiToolRef('item', item.itemId || item.sku, item.sku),
  }
  return { ok: true, result, proposal: { kind: 'purchase_request', itemId: item.itemId || null, sku: item.sku, unit: item.unit || null, quantity, supplierId: supplier?.id || null } }
}

// The card the panel opens: the first proposal opens by itself.
export function aiProposalCard(proposal, facts, language, { autoOpen }) {
  const fmt = aiSkillFormatter(facts || {}, language)
  const values = { sku: proposal.sku, quantity: proposal.quantity ? fmt.quantity(proposal.quantity, proposal.unit) : '' }
  const title = aiSkillText(values.quantity ? 'order.card.title' : 'order.card.title_no_quantity', language, values)
  const reason = aiSkillText('model_first.request.reason', language)
  return {
    previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: PROHIBITED,
    allowedNextStep: aiSkillText(values.quantity ? 'order.action.open' : 'order.action.open_no_quantity', language, values),
    title, draftTitle: title, description: reason,
    draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: proposal.itemId || proposal.sku,
    payload: { itemIdOrSku: proposal.sku, ...(proposal.quantity ? { quantity: proposal.quantity } : {}), ...(proposal.supplierId ? { supplierId: proposal.supplierId } : {}), reason, language },
    originEvidence: [{ entityType: 'item', entityId: proposal.itemId || proposal.sku }],
    autoOpen,
  }
}
