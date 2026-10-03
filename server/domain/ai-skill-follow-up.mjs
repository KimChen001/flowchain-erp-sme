import { aiSkillQuestionTopic } from './ai-skill-capabilities.mjs'
import { AI_SKILL_IDS } from './ai-skill-registry.mjs'

// Follow-up questions, read with the previous answer: "What about PO-020?",
// 那 Northstar 呢？, "Why?", 为什么？, "the first one", 第二个, "only the overdue
// ones", 只看逾期的. Only a short question that no rule, chip or record answers
// on its own is read this way, and only against the previous answer the panel
// sends back (conversationContext): its skill (`previousIntent`), the records
// it cited, in order (`previousEvidenceRefs`), and the records of the latest
// answer that listed several (`previousListRefs`), which "the second one"
// counts in.
//
// The follow-up becomes a question the rules answer the usual way, so the
// records are still looked up for the signed-in actor: a record of a source
// the actor cannot read stays hidden, and an id the panel did not really show
// answers the same as a made-up one. The answer language stays the one of the
// question as typed. No model is called and nothing is stored.

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []
const matches = (patterns, value) => patterns.some((pattern) => pattern.test(value))

// The panel names record types for the conversation context (PO, SKU, ...);
// the answers name them as the skills do. Both are read.
const RECORD_TYPES = Object.freeze({
  purchase_order: 'purchase_order', PO: 'purchase_order',
  item: 'item', SKU: 'item',
  supplier: 'supplier', Supplier: 'supplier',
  supplier_invoice: 'supplier_invoice', Invoice: 'supplier_invoice',
  receiving_doc: 'receiving_doc', GRN: 'receiving_doc',
  rfq: 'rfq', RFQ: 'rfq',
  purchase_request: 'purchase_request', PR: 'purchase_request',
})
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/
// The types a "this record" question can answer for with the record's own card.
const CARD_TYPES = new Set(['purchase_order', 'item', 'supplier'])

const MAX_LENGTH = 60
const WHY = [
  /^(?:(?:but|and|so|ok(?:ay)?)[,\s]+)?why(?:\s+(?:is\s+(?:that|it)|that|so|not|is it so))?\s*[?？!.]*$/i,
  /^(?:那|那么)?(?:为什么|为啥|怎么回事|什么原因|原因是什么|原因呢)(?:呢)?[？?！!。.]*$/,
]
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }
const ORDINAL = [
  /^(?:(?:and|what about|how about|show me|open|tell me (?:more )?about)\s+)?(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+(?:one|item|record|order|po))?\s*[?？!.]*$/i,
  /^(?:那|看看|打开|说说)?第\s*([一二三四五1-5])\s*(?:个|条|项|张|笔|家)?(?:呢|吧)?[？?！!。.]*$/,
]
const OVERDUE_ONLY = [
  /^(?:(?:show\s+(?:me\s+)?)?(?:only|just)\s+(?:the\s+)?(?:overdue|late)(?:\s+(?:ones?|orders?|pos?))?|(?:overdue|late)\s+(?:ones\s+)?only)\s*[?？!.]*$/i,
  /^(?:只看|只要|只显示|只列)(?:逾期|延期|超期)(?:的)?(?:订单|PO)?[？?！!。.]*$/i,
]
// "What about X?", "And X?", 那 X 呢？, X 呢？
const ABOUT = [
  /^(?:(?:and|so)\s+)?(?:what|how)\s+about\s+(.+?)\s*[?？!.]*$/i,
  /^and\s+(.+?)\s*[?？]+$/i,
  /^(?:那|还有|那么)?\s*(.+?)\s*呢\s*[？?！!。.]*$/,
]
const ONLY_RECORD_IDS = /^(?:\s*[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d+\s*[,，、和]?)+\s*[?？]*$/

// The previous skill's question about another record, written so that the
// rules route it back to that skill. Only routing reads it; the answer keeps
// the language of the question as typed.
const ABOUT_QUESTION = Object.freeze({
  today_priorities: 'Why does {x} need attention?',
  highest_risk_items: 'What is the risk on {x}?',
  records_needing_data: 'Which records need more data for {x}?',
  prepare_action_draft: 'Prepare a draft for {x}',
  purchase_orders: 'Which open purchase orders are there for {x}?',
  workspace_metrics: 'Which open purchase orders are there for {x}?',
  pending_approvals: 'Which purchase orders for {x} are waiting for approval?',
  inventory_availability: 'What is the available stock for {x}?',
  invoice_summary: 'What is the status of the supplier invoices for {x}?',
  rfq_followups: 'Which RFQs are open for {x}?',
  receiving_issues: 'Which receipts need attention for {x}?',
})
// "What about invoices?" after another answer: that topic's own question.
const TOPIC_QUESTION = Object.freeze({
  rfqs: 'Which RFQs are still open?',
  receiving: 'Which receipts need attention?',
  invoices: 'What is the status of the supplier invoices?',
  inventory: 'What is the stock status of our items?',
  purchase_orders: 'Which purchase orders are overdue?',
})

function recordsOf(refs) {
  const records = []
  for (const ref of array(refs).slice(0, 8)) {
    const entityType = RECORD_TYPES[text(ref?.entityType)]
    const entityId = text(ref?.entityId)
    if (entityType && RECORD_ID.test(entityId) && !records.some((record) => record.entityId === entityId)) records.push({ entityType, entityId })
  }
  return records
}

function previousAnswer(context) {
  if (!context || typeof context !== 'object') return null
  const skillId = AI_SKILL_IDS.includes(text(context.previousIntent)) ? text(context.previousIntent) : null
  const records = recordsOf(context.previousEvidenceRefs)
  const list = recordsOf(context.previousListRefs)
  return skillId || records.length || list.length ? { skillId, records, list: list.length ? list : records } : null
}

// "Why?" about a record: today's priorities narrowed to it.
const why = (record, kind) => ({ kind, message: 'Why does this record need attention?', skillHint: 'today_priorities', focusTarget: record })

function ordinalOf(raw) {
  for (const pattern of ORDINAL) {
    const match = raw.match(pattern)
    if (match) return ORDINALS[match[1].toLowerCase()] || ORDINALS[match[1]] || null
  }
  return null
}

function aboutSubject(raw) {
  if (ONLY_RECORD_IDS.test(raw)) return raw.replace(/[?？]+$/u, '').trim()
  for (const pattern of ABOUT) {
    const match = raw.match(pattern)
    if (match && text(match[1])) return text(match[1])
  }
  return null
}

// The question the skills answer for a follow-up, or null when the message is
// not one: { kind, message, skillHint?, focusTarget? }.
export function resolveAiSkillFollowUp({ message, route, conversationContext } = {}) {
  const raw = text(message)
  if (!raw || raw.length > MAX_LENGTH || !route || route.skillId || route.capability || route.greeting) return null
  const previous = previousAnswer(conversationContext)
  if (!previous) return null
  if (matches(WHY, raw)) return previous.records[0] ? why(previous.records[0], 'why') : null
  const nth = ordinalOf(raw)
  if (nth) {
    const record = previous.list[nth - 1]
    if (!record) return null
    return CARD_TYPES.has(record.entityType) ? { kind: 'ordinal', message: 'What is the status of this record?', focusTarget: record } : why(record, 'ordinal')
  }
  if (matches(OVERDUE_ONLY, raw)) return ['purchase_orders', 'workspace_metrics', 'today_priorities', 'highest_risk_items'].includes(previous.skillId) ? { kind: 'overdue_only', message: 'Which purchase orders are overdue?' } : null
  const subject = aboutSubject(raw)
  if (!subject || subject.length > 40) return null
  // A topic on its own ("What about invoices?") asks that topic's question.
  const topic = route.ids?.length ? null : aiSkillQuestionTopic(subject)
  if (topic && TOPIC_QUESTION[topic.id]) return { kind: 'topic', message: TOPIC_QUESTION[topic.id] }
  const template = ABOUT_QUESTION[previous.skillId]
  if (!template) return null
  // "Why does PO-012 need attention?" asked by its rule would get the order's
  // card; the hint keeps it the reason why, as the previous answer was.
  const keepSkill = previous.skillId === 'today_priorities' && route.ids?.length
  return { kind: 'about', message: template.replace('{x}', subject), ...(keepSkill ? { skillHint: 'today_priorities' } : {}) }
}
