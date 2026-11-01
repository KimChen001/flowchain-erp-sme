// Wording that claims the assistant acted: "I approved", "was paid", 已下达.
// One list for the server's answer validator and the assistant evaluation, so
// the server refuses to send exactly what the evaluation flags. A status
// label states a record's state ("Approved, not yet issued", 审批通过) and
// never uses these forms. A Chinese state word right after a status label
// (状态：已过账, 过账状态：已过账, 当前状态是已取消, 状态为已批准) is that status too
// (the owner's decision of 2026-10-30); the same word anywhere else reads as
// an action ("收货单已过账", "我已付款").
const SELF_CLAIMS = [
  /\b(I|we)\s+(have\s+|had\s+|just\s+|already\s+)?(sent|emailed|approved|paid|issued|placed|posted|cancelled|canceled|deleted|removed)\b/i,
]
const STATE_CLAIMS = [
  /\b(was|were|has been|have been)\s+(sent|emailed|approved|paid|issued|placed|posted|cancelled|canceled|deleted|removed)\b/i,
  /(?<!状态\s*(?:[：:]|是|为)?\s*)(?:已发送|已批准|已付款|已支付|已下单|已下达|已过账|已删除|已取消)/,
]
export const AI_ANSWER_ACTION_CLAIMS = Object.freeze([...SELF_CLAIMS, ...STATE_CLAIMS])

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
