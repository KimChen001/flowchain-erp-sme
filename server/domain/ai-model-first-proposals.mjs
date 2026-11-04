import { aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter } from './ai-skill-presenter.mjs'
import { aiToolRef, aiToolSupplier } from './ai-read-tool-contract.mjs'
import { runAiReadTool } from './ai-read-tool-runner.mjs'
import { aiGroundingSources } from './ai-model-first-grounding.mjs'
import { aiSkillOrderRequest } from './ai-skill-router.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'

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
// previous answer offered ("the first one", 好的).
//
// Clarify, then fill (owner, 2026-11-03): the rest of the form comes from the
// user's words or from the records, never from the model. The quantity is the
// one the user gave, else the reorder list's suggestion for the item (its
// shortfall raised to the supplier's minimum); the supplier is the one the
// user named, else the item's preferred supplier; the need-by day is the one
// the user gave, else today plus the supplier's lead time; the reason is the
// user's own words, else the reorder list's basis. The form says where each
// value came from, and the person submits it on the page.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).normalize('NFKC').toLowerCase()
// Letters and digits only, to find the user's reason in what they wrote.
const squeeze = (value) => fold(value).replace(/[\s\p{P}\p{S}]+/gu, '')
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(text(value))
const PROHIBITED = ['send', 'approve', 'pay', 'issue', 'cancel', 'delete']
const REASON_MAX = 200
// A request for an empty new-item line: "Open a blank request for a new item", 空白申请.
const BLANK_REQUEST = /\bblank\b|\bempty\b|空白|空的/i
// "Order it as suggested": no need to confirm the suggestion first.
const GO_AHEAD = /直接|按建议|照建议|就按|按补货清单|as suggested|the suggested|right away|go ahead|just open/i

export const AI_PROPOSE_PURCHASE_REQUEST = 'propose_purchase_request'

// The tool, for a user who may draft (the rules' own test, facts.visibility).
export function aiProposalToolDefinitions(facts) {
  if (!facts?.visibility?.canDraft || !facts.inventory) return []
  return [{
    name: AI_PROPOSE_PURCHASE_REQUEST,
    description: 'Opens the purchase request form in the panel, filled in, for the user to check and submit on the page; nothing is saved or submitted here. In FlowChain a purchase request comes first and becomes a purchase order after approval. Use it only for an item the user named, in this question or an earlier one, or chose from items you offered; if they did not say which item, ask, offering the items at risk or on the reorder list. Leave out what the user did not give: without a quantity the form takes the reorder list\'s suggested quantity, without a supplier the item\'s preferred supplier, without a date today plus the supplier\'s lead time, and without a reason the reorder list\'s basis. When the user asked to order and has not settled the quantity, it opens nothing and returns the suggestion to offer first (needsConfirmation). Otherwise the result says what the form holds and where each value came from. If open purchase orders already cover the item, say so first and propose only if the user still wants more. For an item the workspace does not have, give newItem: true instead of a sku, with the description, quantity and unit in the user\'s own words: it opens one Other (non-catalog) line; with newItem alone it opens that line blank. Never give a SKU, a price or a supplier the user did not name for a new item.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sku: { type: 'string', maxLength: 80, description: 'The item\'s SKU.' },
        newItem: { type: 'boolean', description: 'true for an item the workspace does not have: an Other (non-catalog) line, in place of sku.' },
        description: { type: 'string', maxLength: 200, description: 'For a new item: what it is, copied from the user\'s words.' },
        unit: { type: 'string', maxLength: 20, description: 'For a new item: the unit the user gave (pcs, box, pairs).' },
        quantity: { type: 'number', description: 'The quantity the user asked for.' },
        supplier: { type: 'string', maxLength: 120, description: 'The supplier the user named.' },
        needByDate: { type: 'string', maxLength: 10, description: 'YYYY-MM-DD: the date the user asked for.' },
        reason: { type: 'string', maxLength: REASON_MAX, description: 'Why the user wants it, copied from their own words.' },
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

// The user's own words only: the question and the earlier questions.
const askedWords = ({ question, turns = [] }) => fold([text(question), ...array(turns).map((turn) => text(turn?.question))].join('\n'))

const mentions = (words, value) => {
  const needle = fold(value)
  return Boolean(needle) && new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'u').test(words)
}

function itemOf(facts, sku) {
  const wanted = fold(sku)
  return [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)].find((row) => fold(row.sku) === wanted) || null
}

// The item's reorder list row as the reorder_list tool gives it, or null when
// the user may not read the list or the item is not on it.
async function reorderRowOf(sku, { facts, context }) {
  if (!context) return null
  const read = await runAiReadTool('reorder_list', { sku }, { facts, context })
  return read.ok ? array(read.result?.rows).find((row) => fold(row.sku) === fold(sku)) || null : null
}

// The reorder list's basis for the request, as its reason line.
function reorderReason(row, unit, language) {
  if (!(row?.requestQuantity > 0)) return ''
  const key = row.raisedToMinimum ? 'model_first.request.reason_reorder_minimum' : 'model_first.request.reason_reorder'
  return aiSkillText(key, language, { date: row.orderByDate, shortfall: row.shortfall, quantity: row.requestQuantity, unit: unit || '' })
}

// A date the user wrote (2026-11-20, 11月20日, Nov 20) is the one asked for.
function userDate(day, asked) {
  if (!isDay(day)) return false
  // Read as prose, so 11月20日 and Nov 20 count, not only 2026-11-20.
  return [...aiGroundingSources([{ excerpt: asked }]).days].some((known) => known === day || (known.startsWith('????') && known.endsWith(day.slice(4))))
}

// An item the workspace does not have (owner, 2026-11-04: ordering a new item
// looped on "tell me the SKU and supplier"). It opens one Other (non-catalog)
// line from the user's own words only: the description, the quantity and unit
// they wrote, a supplier only when they named one the workspace has, their
// date and their reason. Never a SKU, a price or a category: the person adds
// those. With no description the line opens blank. Adding the item to the
// catalog is done under Items, not here.
function runNewItemProposal(args, { facts, words, question, turns, language }) {
  const asked = askedWords({ question, turns })
  const own = (value) => squeeze(value).length >= 2 && squeeze(asked).includes(squeeze(value))
  const description = text(args.description).slice(0, 200)
  // A blank line only when the user asked for one (the chip "Open a blank
  // request for a new item"); otherwise the user is asked once what it is.
  const blankAsked = BLANK_REQUEST.test(text(question)) || (AGREE.test(text(question)) && BLANK_REQUEST.test(text(array(turns).at(-1)?.answer)))
  if (!description && !blankAsked) {
    return { ok: true, result: { opens: null, needsDetails: true, note: 'Nothing opened: the user has not said what the new item is. Ask once, in one short line, what it is and how many (and the supplier and need-by date if they know them), and make the first followUp "Open a blank request for a new item".' } }
  }
  if (description && !own(description)) return { ok: false, error: 'description_not_users', details: ["Copy the user's own words for the item, or ask what it is."] }
  const known = description ? [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)].find((row) => fold(row.itemName) === fold(description) || fold(row.sku) === fold(description)) : null
  if (known) return { ok: false, error: 'catalog_item', details: [`The workspace has this item as ${known.sku}: propose it by its sku instead.`] }
  const notes = []
  const given = typeof args.quantity === 'number' && Number.isFinite(args.quantity) && args.quantity > 0 ? args.quantity : null
  const quantity = given !== null && mentions(words, String(given)) ? given : null
  if (given !== null && quantity === null) notes.push(`${given} is not a quantity the user gave, so the line opens without one.`)
  const unit = text(args.unit) && fold(asked).includes(fold(args.unit)) ? text(args.unit).slice(0, 20) : null
  let supplier = null
  if (text(args.supplier)) {
    const found = aiToolSupplier(facts, args.supplier)
    if (found.supplier && (mentions(words, found.supplier.name) || mentions(words, found.supplier.code) || mentions(words, args.supplier))) supplier = { id: found.supplier.id, name: found.supplier.name }
    else notes.push('That supplier is not one the workspace has, or the user did not name it, so the line opens without a supplier.')
  }
  const needByDate = userDate(text(args.needByDate), asked) ? text(args.needByDate) : null
  const said = text(args.reason).slice(0, REASON_MAX)
  const reason = said && own(said) && !aiSkillOrderRequest(said) ? said : ''
  const result = {
    opens: 'purchase_request_form',
    line: 'other_non_catalog',
    description: description || null,
    quantity,
    unit,
    supplier: supplier?.name || null,
    needByDate,
    reason: reason || null,
    note: [
      description ? 'One Other (non-catalog) line with what the user gave, each field marked as theirs.' : 'A blank Other (non-catalog) line for the user to fill in.',
      'No SKU, price or category is filled: the user adds them on the page and submits it; nothing is saved until then. To keep the item in the catalog, it is added under Items.',
      ...notes,
    ].join(' '),
  }
  return { ok: true, result, proposal: { kind: 'purchase_request', nonCatalog: true, sku: null, description: description || null, unit, quantity, quantitySource: quantity ? 'user' : null, supplierId: supplier?.id || null, supplierName: supplier?.name || null, supplierSource: supplier ? 'user' : null, needByDate, needBySource: needByDate ? 'user' : null, reason, reasonSource: reason ? 'user' : null } }
}

// Runs a proposal call. Returns { ok: true, result, proposal } (the proposal
// becomes the answer's card) or { ok: false, error, details }. `words`: what
// the user gave (aiProposalUserWords); `question` and `turns` give the user's
// own words for a date and a reason; `context` reads the reorder list;
// `today` is the workspace day.
export async function runAiProposal(name, args = {}, { facts, words = '', question = '', turns = [], context = null, language = 'en-US', today = null } = {}) {
  if (name !== AI_PROPOSE_PURCHASE_REQUEST || !aiProposalToolDefinitions(facts).length) return { ok: false, error: 'not_allowed' }
  if (args && typeof args === 'object' && args.newItem === true && !text(args.sku)) return runNewItemProposal(args, { facts, words, question, turns, language })
  if (!args || typeof args !== 'object' || typeof args.sku !== 'string' || !text(args.sku)) return { ok: false, error: 'invalid_arguments', details: ['sku is required, or newItem: true for an item the workspace does not have'] }
  const item = itemOf(facts, args.sku)
  if (!item) return { ok: false, error: 'not_found', details: ['No item with this SKU is readable. Search for it or ask the user.'] }
  if (!mentions(words, item.sku)) return { ok: false, error: 'item_not_named', details: ['The user has not named or chosen this item. Ask which item they want, offering the items at risk or on the reorder list as choices.'] }
  const row = await reorderRowOf(item.sku, { facts, context })
  const suggested = row?.requestQuantity > 0 ? row.requestQuantity : null
  const leadDate = Number.isInteger(row?.leadTimeDays) && isDay(today) ? addCalendarDays(today, row.leadTimeDays) : null
  const notes = []

  // Clarify, then fill: a request to order an item the reorder list suggests a
  // quantity for, with no quantity and no "as suggested", gets the suggestion
  // to offer first; the form opens once the user answers.
  const order = aiSkillOrderRequest(question)
  if (order && !order.advice && order.quantity === null && !GO_AHEAD.test(text(question)) && suggested !== null) {
    return {
      ok: true,
      result: {
        opens: null,
        needsConfirmation: true,
        sku: item.sku,
        itemName: item.itemName || null,
        unit: row.unit || item.unit || null,
        suggestion: { quantity: suggested, supplier: row.supplier || null, needByDate: leadDate, leadTimeDays: row.leadTimeDays ?? null, orderByDate: row.orderByDate ?? null, shortfall: row.shortfall ?? null, minimumOrderQuantity: row.minimumOrderQuantity ?? null, raisedToMinimum: Boolean(row.raisedToMinimum) },
        note: 'Not opened yet. The user asked to order without a quantity: offer this suggestion as the default and ask whether to go ahead or change anything, and what the order is for. Open the form when they answer.',
        ref: aiToolRef('item', item.itemId || item.sku, item.sku),
      },
    }
  }

  // The quantity: the user's, else the reorder list's suggestion.
  const given = typeof args.quantity === 'number' && Number.isFinite(args.quantity) && args.quantity > 0 ? args.quantity : null
  let quantity = null
  let quantitySource = null
  if (given !== null && mentions(words, String(given))) [quantity, quantitySource] = [given, 'user']
  else if (suggested !== null) {
    [quantity, quantitySource] = [suggested, 'reorder_list']
    if (given !== null && given !== suggested) notes.push(`${given} is not a quantity the user gave, so the form has the reorder list's suggestion.`)
  } else notes.push('The user gave no quantity and the reorder list suggests none, so the form opens without one for the user to enter.')

  // The supplier: one the user named, else the preferred one.
  let supplier = null
  let supplierSource = null
  if (text(args.supplier)) {
    const found = aiToolSupplier(facts, args.supplier)
    if (found.supplier && (mentions(words, found.supplier.name) || mentions(words, found.supplier.code) || mentions(words, args.supplier))) [supplier, supplierSource] = [{ id: found.supplier.id, name: found.supplier.name }, 'user']
  }
  if (!supplier && row?.supplierId) [supplier, supplierSource] = [{ id: row.supplierId, name: row.supplier }, 'preferred']
  if (!supplier) notes.push('No supplier was named; the form fills the item\'s preferred supplier when it has one.')

  // The need-by day: one the user wrote, else today plus the lead time.
  const asked = askedWords({ question, turns })
  let needByDate = null
  let needBySource = null
  if (userDate(text(args.needByDate), asked)) [needByDate, needBySource] = [text(args.needByDate), 'user']
  else if (supplierSource === 'preferred' && leadDate) [needByDate, needBySource] = [leadDate, 'lead_time']

  // The reason: the user's own words, else the reorder list's basis. The
  // request itself ("帮我给 LDM-002 下单") is not a reason.
  const said = text(args.reason).slice(0, REASON_MAX)
  let reason = ''
  let reasonSource = null
  if (said && squeeze(said).length >= 2 && squeeze(asked).includes(squeeze(said)) && !aiSkillOrderRequest(said)) [reason, reasonSource] = [said, 'user']
  else {
    reason = reorderReason(row, row?.unit || item.unit, language)
    reasonSource = reason ? 'reorder_list' : null
    if (said) notes.push('The reason given is not in the user\'s own words, so the form has the reorder list\'s basis instead.')
  }

  const result = {
    opens: 'purchase_request_form',
    sku: item.sku,
    itemName: item.itemName || null,
    unit: item.unit || null,
    quantity,
    quantitySource,
    supplier: supplier?.name || null,
    supplierSource,
    needByDate,
    needBySource,
    reason: reason || null,
    reasonSource,
    // The reorder list's figures behind the defaults, so the answer can give them.
    ...(row ? { reorderList: { orderByDate: row.orderByDate ?? null, shortfall: row.shortfall ?? null, suggestedQuantity: suggested, minimumOrderQuantity: row.minimumOrderQuantity ?? null, raisedToMinimum: Boolean(row.raisedToMinimum), leadTimeDays: row.leadTimeDays ?? null } } : {}),
    note: ['The form opens in the panel filled in like this; the user checks it and submits it on the page. Nothing is saved or submitted until they do. After approval the request becomes a purchase order.', ...notes].join(' '),
    ref: aiToolRef('item', item.itemId || item.sku, item.sku),
  }
  return { ok: true, result, proposal: { kind: 'purchase_request', itemId: item.itemId || null, sku: item.sku, unit: item.unit || null, quantity, quantitySource, supplierId: supplier?.id || null, supplierName: supplier?.name || null, supplierSource, needByDate, needBySource, reason, reasonSource } }
}

// The card the panel opens: the first proposal opens by itself. The page
// takes the quantity, the reason, a supplier the user named and a date the
// user gave; it fills the preferred supplier and the lead-time date itself,
// labelled as such, so those are shown on the card only.
export function aiProposalCard(proposal, facts, language, { autoOpen }) {
  if (proposal.nonCatalog) return newItemCard(proposal, facts, language, { autoOpen })
  const fmt = aiSkillFormatter(facts || {}, language)
  const values = { sku: proposal.sku, quantity: proposal.quantity ? fmt.quantity(proposal.quantity, proposal.unit) : '' }
  const title = aiSkillText(values.quantity ? 'order.card.title' : 'order.card.title_no_quantity', language, values)
  const reason = text(proposal.reason) || aiSkillText('model_first.request.reason', language)
  return {
    previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: PROHIBITED,
    allowedNextStep: aiSkillText(values.quantity ? 'order.action.open' : 'order.action.open_no_quantity', language, values),
    title, draftTitle: title, description: reason,
    draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: proposal.itemId || proposal.sku,
    payload: {
      itemIdOrSku: proposal.sku,
      ...(proposal.quantity ? { quantity: proposal.quantity, ...(proposal.unit ? { unit: proposal.unit } : {}), ...(proposal.quantitySource ? { quantitySource: proposal.quantitySource } : {}) } : {}),
      ...(proposal.supplierId && proposal.supplierSource !== 'preferred' ? { supplierId: proposal.supplierId } : {}),
      ...(proposal.supplierName ? { supplierName: proposal.supplierName } : {}),
      ...(proposal.needByDate ? { needByDate: proposal.needByDate } : {}),
      ...(proposal.needByDate && proposal.needBySource === 'user' ? { requestedDeliveryDate: proposal.needByDate } : {}),
      reason,
      ...(proposal.reasonSource ? { reasonSource: proposal.reasonSource } : {}),
      language,
    },
    originEvidence: [{ entityType: 'item', entityId: proposal.itemId || proposal.sku }],
    autoOpen,
  }
}

// The card for an item the workspace does not have: it opens the request page
// with one Other line from the user's words (lineType non_catalog).
function newItemCard(proposal, facts, language, { autoOpen }) {
  const fmt = aiSkillFormatter(facts || {}, language)
  const values = { description: text(proposal.description), quantity: proposal.quantity ? fmt.quantity(proposal.quantity, proposal.unit) : '' }
  const key = !values.description ? 'blank' : values.quantity ? 'quantity' : 'named'
  const title = aiSkillText(`order.card.new_item_${key}`, language, values)
  const reason = text(proposal.reason) || aiSkillText('model_first.request.reason', language)
  return {
    previewOnly: true, reviewRequired: true, requiresHumanReview: true, prohibitedActions: PROHIBITED,
    allowedNextStep: aiSkillText(`order.action.new_item_${key}`, language, values),
    title, draftTitle: title, description: reason,
    draftType: 'purchase_request_draft', targetModule: AI_SKILL_MODULES.purchase_request, targetEntityType: 'item', targetEntityId: 'non_catalog',
    payload: {
      nonCatalog: true,
      ...(values.description ? { description: values.description } : {}),
      ...(proposal.quantity ? { quantity: proposal.quantity, quantitySource: 'user' } : {}),
      ...(proposal.unit ? { unit: proposal.unit } : {}),
      ...(proposal.supplierId ? { supplierId: proposal.supplierId, supplierName: proposal.supplierName } : {}),
      ...(proposal.needByDate ? { needByDate: proposal.needByDate, requestedDeliveryDate: proposal.needByDate } : {}),
      ...(proposal.reason ? { reason: proposal.reason, reasonSource: 'user' } : {}),
      language,
    },
    originEvidence: [],
    autoOpen,
  }
}
