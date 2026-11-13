// Wording that claims the assistant acted: "I approved", "was paid", 已下达.
// One list for the server's answer validator and the assistant evaluation, so
// the server refuses to send exactly what the evaluation flags. A status
// label states a record's state ("Approved, not yet issued", 审批通过) and
// never uses these forms. A Chinese state word right after a status label
// (状态：已过账, 过账状态：已过账, 当前状态是已取消, 状态为已批准) is that status too
// (the owner's decision of 2026-10-30); the same word anywhere else reads as
// an action ("收货单已过账", "我已付款").
// "What we paid: £2.95 per pcs" and "we paid £2.95 a piece" give a price,
// not an act (2026-11-11 on Flash: the line was left out as a claim).
const SELF_CLAIMS = [
  /(?<!\b(?:what|price|prices|amount|cost|costs)\s+)\b(I|we)\s+(have\s+|had\s+|just\s+|already\s+)?(sent|emailed|approved|paid(?!\s+(?:about\s+|around\s+|roughly\s+|only\s+|just\s+|on\s+average\s+|an\s+average\s+of\s+)?(?:[$€£¥]|\d|per\b|for\s+(?:it|each|them|one|a)\b))|issued|placed|posted|cancelled|canceled|deleted|removed)\b/i,
]
const EN_STATE_CLAIM = /\b(was|were|has been|have been)\s+(sent|emailed|approved|paid|issued|placed|posted|cancelled|canceled|deleted|removed)\b/i
const STATE_CLAIMS = [
  EN_STATE_CLAIM,
  /(?<!状态\s*(?:[：:]|是|为)?\s*)(?:已发送|已批准|已付款|已支付|已下单|已下达|已过账|已删除|已取消)/,
]
export const AI_ANSWER_ACTION_CLAIMS = Object.freeze([...SELF_CLAIMS, ...STATE_CLAIMS])

// Chinese wording in which the assistant says it acted itself: 我已付款,
// 我们已经为你下单, 已为您发送, 我帮你把订单取消了. Assistant v2 reads Chinese
// claims only in this form (2026-11-05): a state word on its own describes a
// record ("已批准的采购订单", "订单已取消"), and taking those sentences out left
// answers with holes where facts were.
const ZH_ACTS = '(?:发送|发出|批准|审批|付款|支付|下单|下达|过账|删除|取消)'
const ZH_FOR_YOU = '(?:为你|帮你|替你|给你|为您|帮您|替您|给您)'
const ZH_OBJECT = '(?:把[^。！？；\\n]{0,20}?)?'
const ZH_SELF_CLAIMS = [
  new RegExp(`(?:我|我们)(?:已经|已|刚刚|刚才|刚)${ZH_FOR_YOU}?${ZH_OBJECT}${ZH_ACTS}`, 'g'),
  // With no subject, at the start of a clause: 已为你下单.
  new RegExp(`(?<=^|[\\s。！？；，、,:：])已经?${ZH_FOR_YOU}${ZH_OBJECT}${ZH_ACTS}`, 'g'),
  new RegExp(`(?:我|我们)${ZH_FOR_YOU}${ZH_OBJECT}${ZH_ACTS}了`, 'g'),
]
// English in the same way: a passive state word ("PO-023 was approved but not
// issued", "all eight were issued") describes records; it is a claim only
// when the sentence says it was done for the user or by the assistant
// ("it was sent for you", "has been approved on your behalf").
const EN_ASSISTANT_STATE_CLAIM = new RegExp(`${EN_STATE_CLAIM.source}[^.!?\\n]{0,60}?\\b(?:for you|on your behalf|by me|by us|by the assistant)\\b`, 'gi')

export function aiAnswerClaimsAction(value) {
  const text = String(value ?? '')
  return AI_ANSWER_ACTION_CLAIMS.some((pattern) => pattern.test(text))
}

// Each state word, the kinds of record it can describe (null: any) and the
// statuses a record of that kind is in once it is in that state.
const WORD_STATES = [
  { word: /^(?:issued|sent|placed|已下达|已发送|已下单)$/i, types: ['purchase_order'], states: ['issued', 'partially_received', 'fully_received', 'closed'] },
  { word: /^(?:approved|已批准)$/i, types: ['purchase_order', 'purchase_request', 'supplier_invoice'], states: ['approved', 'issued', 'partially_received', 'fully_received', 'closed'] },
  { word: /^(?:posted|已过账)$/i, types: ['receiving_doc', 'supplier_invoice'], states: ['posted'] },
  { word: /^(?:cancelled|canceled|已取消)$/i, types: null, states: ['cancelled', 'canceled'] },
  { word: /^(?:paid|已付款|已支付)$/i, types: ['supplier_invoice', 'receivable'], states: ['paid'] },
]
const SENTENCE_END = /[。！？!?；;\n]|\.(?=\s|$)/g
const fold = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase()
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The records an answer may name, by number (an id or a label), each with its
// kind and statuses: from the tools' results for the model-first check, or
// from the database for the evaluation. Each entry is { type, numbers, states }.
export function aiAnswerRecordStates(records) {
  const index = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const states = new Set((record?.states || []).map(fold).filter(Boolean))
    if (!states.size) continue
    const entry = { type: record.type, states }
    for (const number of record.numbers || []) if (fold(number) && !index.has(fold(number))) index.set(fold(number), entry)
  }
  return index
}

// The wording in `value` that claims an action. "I/we" forms always do. A
// state word ("has been issued", 已过账) in a sentence that names records is
// their status when they are in that state (the owner's decision of
// 2026-11-01): "PO-021 has been issued" when PO-021 is issued. At least one
// record of a kind the word describes must be named in the sentence, and every
// one named must be in that state. Without `states` every form counts, as
// aiAnswerClaimsAction reads them.
export function aiAnswerActionClaims(value, states = null) {
  const text = String(value ?? '')
  const claims = []
  for (const pattern of SELF_CLAIMS) {
    const found = text.match(pattern)
    if (found) claims.push(found[0])
  }
  for (const pattern of STATE_CLAIMS) {
    for (const found of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      if (!statedStatus(text, found, states)) claims.push(found[0])
    }
  }
  return claims
}

// The claims of an assistant v2 answer (2026-11-05): "I/we" forms, an
// English state word said to be done for the user or by the assistant,
// Chinese with the assistant as the subject (ZH_SELF_CLAIMS), and an English
// state word whose clause names a record that the results do not show in that
// state ("PR-001 has been approved" with no result or a draft PR-001). A
// state word whose clause names no record describes records ("all eight were
// issued") and is no claim. Assistant v2 then lets a note of the user's own
// step back a state word.
export function aiAnswerAssistantActionClaims(value, states = null) {
  const text = String(value ?? '')
  const claims = []
  for (const pattern of SELF_CLAIMS) {
    const found = text.match(pattern)
    if (found) claims.push(found[0])
  }
  const said = new Set()
  for (const found of text.matchAll(EN_ASSISTANT_STATE_CLAIM)) { claims.push(found[0]); said.add(found.index) }
  for (const found of text.matchAll(new RegExp(EN_STATE_CLAIM.source, 'gi'))) {
    if (!said.has(found.index) && unbackedNamedState(text, found, states)) claims.push(found[0])
  }
  for (const pattern of ZH_SELF_CLAIMS) for (const found of text.matchAll(pattern)) claims.push(found[0])
  return [...new Set(claims)]
}

// A record number as answers write them: PR-001, LOCAL-DEMO-PO-023.
const RECORD_NUMBER = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d[\w-]*/
// Where a clause starts inside a sentence; "and" may join two subjects
// ("PO-021 and PO-023 were issued"), so it is no break.
const CLAUSE_BREAK = /[,;:，；：]|\b(?:but|while|whereas|although|though|except|so)\b/gi

// The clause before a state word: from the sentence's start or the last break.
function clauseBefore(text, index) {
  let start = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match.index < index) start = match.index + 1
    else break
  }
  const lead = text.slice(start, index)
  let from = 0
  for (const match of lead.matchAll(CLAUSE_BREAK)) from = match.index + match[0].length
  return lead.slice(from)
}

// The clause names a record, and no record it names of a kind the word
// describes is in that state in the results.
function unbackedNamedState(text, found, states) {
  const clause = clauseBefore(text, found.index)
  if (!RECORD_NUMBER.test(clause)) return false
  const rule = WORD_STATES.find((row) => row.word.test(found[0].trim().split(/\s+/).at(-1)))
  if (!rule || !states?.size) return true
  const named = recordsIn(clause, states).filter((record) => !rule.types || rule.types.includes(record.type))
  return !named.some((record) => rule.states.some((state) => record.states.has(state)))
}

function statedStatus(text, found, states) {
  if (!states?.size) return false
  const rule = WORD_STATES.find((row) => row.word.test(found[0].trim().split(/\s+/).at(-1)))
  if (!rule) return false
  const named = recordsIn(sentenceAt(text, found.index), states).filter((record) => !rule.types || rule.types.includes(record.type))
  return named.length > 0 && named.every((record) => rule.states.some((state) => record.states.has(state)))
}

function sentenceAt(text, index) {
  let start = 0
  let end = text.length
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match.index < index) start = match.index + 1
    else { end = match.index; break }
  }
  return text.slice(start, end)
}

// The records a sentence names: by the whole number, or by its end ("PO-021"
// for LOCAL-DEMO-PO-021), as answers write them.
function recordsIn(sentence, states) {
  const folded = fold(sentence)
  const named = new Set()
  for (const [number, record] of states) {
    const tail = number.match(/[a-z]+-?\d+$/)?.[0]
    if (folded.includes(number) || (tail && new RegExp(`(?<![a-z0-9])${escape(tail)}(?!\\d)`, 'u').test(folded))) named.add(record)
  }
  return [...named]
}
