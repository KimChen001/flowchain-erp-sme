import { AI_SKILL_IDS } from './ai-skill-registry.mjs'
import { aiSkillRefersToRecord } from './ai-skill-router.mjs'
import { resolveAiSkillEntities } from './ai-skill-entities.mjs'

// Conversation memory (owner decision 2 of 2026-10-07, docs/ai-assistant-plan.md):
// the question asked just before and the records its answer showed, so that
// "draft a follow-up email for it", 帮我给这家供应商写个催货邮件 or "compare
// these two" are read with the previous answer.
//
// The panel sends the previous answer back (conversationContext). Nothing is
// stored on the server. Each record it names is looked up again in the
// signed-in actor's own facts, and only records found there are remembered,
// under the names the facts give them: a record the actor cannot read, or an
// id the panel did not really show, is not remembered at all, and no label the
// panel sends reaches a model.
//
// Two readers:
//   - the rules (aiSkillMemoryReference): a question that points at one
//     record ("this supplier", 它, "it") and names none is narrowed to the
//     remembered record of that kind, as a question on that record's page is;
//   - the models, only for a question that refers to the earlier answer: the
//     planner may name remembered records as a call's records, and the
//     composer reads the previous question (aiMemoryForModels).

export const AI_MEMORY_LIMITS = Object.freeze({ question: 300, records: 8 })

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])

// The panel names record types for the conversation context (PO, SKU, ...);
// the answers name them as the skills do. Both are read.
const RECORD_TYPES = Object.freeze({
  purchase_order: 'purchase_order', PO: 'purchase_order',
  item: 'item', SKU: 'item',
  supplier: 'supplier', Supplier: 'supplier',
  supplier_invoice: 'supplier_invoice', Invoice: 'supplier_invoice',
  receiving_doc: 'receiving_doc', GRN: 'receiving_doc',
})
// The panel's own sources of a previous-answer record; the page it is on
// ("activePage") is the page focus, read by the router.
const ANSWER_SOURCES = new Set(['evidence', 'navigation', 'reviewCard', 'session'])

// A record as the actor's facts have it, or null.
function lookUp(entityType, entityId, facts) {
  const id = text(entityId)
  if (!id) return null
  if (entityType === 'purchase_order') {
    const row = [...array(facts.purchaseOrders?.index), ...array(facts.purchaseOrders?.rows)].find((entry) => entry.id === id || entry.orderNumber === id)
    return row ? { entityType, entityId: row.id, name: text(row.orderNumber) || row.id, supplierId: text(row.supplierId) || null, supplier: text(row.supplier) || null, skus: array(row.skus).length ? array(row.skus) : array(row.openLines).map((line) => line.sku).filter(Boolean) } : null
  }
  if (entityType === 'item') {
    const row = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((entry) => entry.itemId === id || entry.sku === id)
    return row ? { entityType, entityId: text(row.itemId) || row.sku, name: row.sku, supplierId: null, supplier: null } : null
  }
  if (entityType === 'supplier') {
    const row = array(facts.suppliers).find((entry) => entry.id === id || entry.code === id || entry.name === id)
    return row ? { entityType, entityId: row.id, name: row.name, supplierId: row.id, supplier: row.name } : null
  }
  if (entityType === 'supplier_invoice') {
    const row = array(facts.invoices?.variances).find((entry) => entry.id === id || entry.invoiceNumber === id)
    return row ? { entityType, entityId: row.id, name: text(row.invoiceNumber) || row.id, supplierId: text(row.supplierId) || null, supplier: text(row.supplier) || null } : null
  }
  if (entityType === 'receiving_doc') {
    const row = [...array(facts.receipts?.rejected), ...array(facts.receipts?.unposted)].find((entry) => entry.id === id || entry.documentNumber === id)
    return row ? { entityType, entityId: row.id, name: text(row.documentNumber) || row.id, supplierId: text(row.supplierId) || null, supplier: text(row.supplier) || null } : null
  }
  return null
}

function recordsOf(refs, facts, records = []) {
  for (const ref of array(refs)) {
    if (records.length >= AI_MEMORY_LIMITS.records) break
    if (ref?.source && !ANSWER_SOURCES.has(text(ref.source))) continue
    const entityType = RECORD_TYPES[text(ref?.entityType)]
    const record = entityType ? lookUp(entityType, ref.entityId, facts) : null
    if (record && !records.some((entry) => entry.entityType === record.entityType && entry.entityId === record.entityId)) records.push(record)
  }
  return records
}

// The previous question as the user typed it. The panel sends the previous
// skill's id in its place when it has no question; that is not a question.
function questionOf(context) {
  const value = text(context?.previousQuestion).replace(/\s+/g, ' ')
  if (!value || AI_SKILL_IDS.includes(value) || /^[a-z_]+$/.test(value)) return null
  return value.slice(0, AI_MEMORY_LIMITS.question)
}

// { question, records, list } or null: the records of the previous answer in
// the order it showed them (its evidence first), and those of the latest
// answer that listed several, which "the second one" counts in.
export function aiConversationMemory(context, facts) {
  if (!context || typeof context !== 'object' || !facts) return null
  const records = recordsOf(context.previousEntityRefs, facts, recordsOf(context.previousEvidenceRefs, facts))
  const list = recordsOf(context.previousListRefs, facts)
  const question = questionOf(context)
  return records.length || question ? { question, records, list: list.length ? list : records } : null
}

// Words that refer to the earlier answer: one record ("this supplier", "it",
// 这家, 它) or several ("these", "them", 这些, 它们, 上面的), or a place in its
// list ("the second one", "the first two", 第二个, 前两家).
const EARLIER = [
  /\b(?:these|those|them|they|their|above|previous|earlier|last answer|the (?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last|top) (?:one|two|three|order|supplier|item|record)s?)\b/i,
  /这些|那些|它们|他们|她们|上面|上述|刚才|刚刚|前面|之前|那家|那个|那张|那笔|第\s*[一二三四五1-5]\s*(?:个|条|项|张|笔|家|位)|前\s*[两二三四五2-5]\s*(?:个|条|项|张|笔|家|位)|最后一\s*(?:个|条|项|张|笔|家|位)/,
]
export function aiQuestionRefersToEarlierAnswer(message) {
  const raw = text(message)
  return Boolean(raw) && (aiSkillRefersToRecord(raw) || EARLIER.some((pattern) => pattern.test(raw)))
}

// The kind of record a reference names: 这家供应商 is a supplier, "this
// order" a purchase order, 它 or "it" whichever record came first.
const KINDS = [
  ['supplier', /供应商|厂商|厂家|\b(?:supplier|vendor)s?\b/i],
  ['supplier_invoice', /发票|\binvoices?\b/i],
  ['receiving_doc', /收货|入库单|\b(?:receipts?|grns?)\b/i],
  ['item', /\bskus?\b|物料|商品|产品|货品|\b(?:items?|products?)\b/i],
  ['purchase_order', /订单|采购单|这张单|这单|该单|此单|\b(?:po|order|purchase order)s?\b/i],
]
// Several records: left to the planner.
const PLURAL = [/\b(?:these|those|them|they|their)\b/i, /这些|那些|它们|他们|她们/]
// The kind a skill answers about, for a reference that names no kind ("why
// is it late?" asks about an order).
const SKILL_KINDS = Object.freeze({ inventory_availability: 'item', supplier_attention: 'supplier', invoice_summary: 'supplier_invoice', receiving_issues: 'receiving_doc', purchase_orders: 'purchase_order' })

function kindOf(message) {
  for (const [kind, pattern] of KINDS) if (pattern.test(message)) return kind
  return null
}

// The remembered record a question points at, as a page focus
// ({ entityType, entityId }), or null. Only a question that points at one
// record, names none, and is not on a record's page (route.focus) is read
// this way; a reference to several, or to a kind the previous answer did not
// show, is left to the planner.
export function aiSkillMemoryReference({ message, route, memory, facts }) {
  const raw = text(message)
  if (!raw || !memory?.records.length || !route || route.capability || route.greeting || route.explicit || route.focus || array(route.ids).length) return null
  if (!aiSkillRefersToRecord(raw) || PLURAL.some((pattern) => pattern.test(raw))) return null
  // A record the question names itself wins.
  const named = resolveAiSkillEntities(raw, [], facts)
  if (named.purchaseOrders.length || named.skus.length || named.suppliers.length) return null
  const said = kindOf(raw)
  const kind = said || SKILL_KINDS[route.skillId] || null
  const first = (type) => memory.records.find((record) => record.entityType === type) || null
  let record = kind ? first(kind) : memory.records[0]
  // "This supplier" after an answer about its orders: the supplier of the
  // first record that has one. "This item" after one about an order of one
  // SKU: that SKU.
  if (!record && kind === 'supplier') {
    const owner = memory.records.find((entry) => entry.supplierId && array(facts.suppliers).some((row) => row.id === entry.supplierId))
    record = owner ? lookUp('supplier', owner.supplierId, facts) : null
  }
  if (!record && kind === 'item') {
    const order = memory.records.find((entry) => entry.entityType === 'purchase_order' && array(entry.skus).length === 1)
    record = order ? lookUp('item', order.skus[0], facts) : null
  }
  // A kind only the skill implies: the first record, whatever its kind.
  if (!record && !said) record = memory.records[0]
  return record ? { kind: 'reference', focus: { entityType: record.entityType, entityId: record.entityId } } : null
}

// What the models get: the previous question and the remembered records by
// the names the actor's facts give them (type, name, supplier), never ids.
// Only for a question that refers to the earlier answer.
export function aiMemoryForModels(memory, message) {
  if (!memory || !aiQuestionRefersToEarlierAnswer(message)) return null
  const records = memory.records.map((record) => ({ type: record.entityType, name: record.name, ...(record.supplier && record.supplier !== record.name ? { supplier: record.supplier } : {}) }))
  return memory.question || records.length ? { previousQuestion: memory.question, records } : null
}

// The names a planned call may use besides the question's own words: the
// remembered records and their suppliers.
export function aiMemoryNames(models) {
  return [...new Set(array(models?.records).flatMap((record) => [record.name, record.supplier]).filter(Boolean))]
}
