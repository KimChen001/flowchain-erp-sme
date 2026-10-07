import { aiAnswerClaimsAction } from './ai-answer-claims.mjs'
import { aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillKnownValues, assertValidAiSkillResponse } from './ai-skill-validator.mjs'
import { FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN, callConfiguredProvider, canCallConfiguredProvider, providerRuntimeConfig } from './ai-runtime-provider-adapter-v2.mjs'

// P3, answer wording (agent mode decisions 4 and 7, approved by the owner on
// 2026-10-07; docs/ai-agent-mode-design.md §4). The rules and the skills
// still decide what the answer says: its records, figures, statuses, dates,
// cards and links. The model only writes the title and the summary around
// them, in the user's words ("why", "summarise it for my boss", "compare").
//
// Facts reach the model, and come back, only as slots. Every value of the
// template answer (a record's name, status, figure, reason sentence, a card
// title, a section) gets a key; the model writes {key} where the value goes,
// and the server puts the value there. The values are the asking user's own
// answer, so they are already masked to what that user may see.
//
// The wording is used only when it passes the verifier: valid JSON, every
// slot known, no digits, number words, currency, dates or stored names
// outside the slots, no claimed action, no technical words, the answer's
// language, sensible lengths, and the finished answer passes the skill
// answer validator. Anything else keeps the template answer, which is already
// built, so a rejection costs only the call's time. The audit row records the
// outcome as codes (aiAnswerComposeAudit), never the question or the text.
//
// On only with FLOWCHAIN_AI_AGENT_MODE=compose and a callable provider; a
// workspace without the model switched on never gets there
// (ai-workspace-access.mjs).

export const AI_COMPOSE_LIMITS = Object.freeze({ timeoutMs: 7000, maxTimeoutMs: 10000, records: 8, cards: 3, sections: 3, title: 160, summary: 1200 })

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const CJK = /[㐀-鿿豈-﫿]/u
const SLOT = /\{([a-z][a-z0-9]*(?:\.[a-z0-9_]+)?)\}/g
// Outside the slots: no figures, number words, currency or dates.
const DIGITS = /[0-9０-９]/
const ZH_NUMBER = /[零〇一二两三四五六七八九十百千万亿]+\s*(?:张|个|家|天|项|件|笔|条|份|位|次|周|月|年|批|箱|卷|台|只|套|元|块|号|日|小时|分钟|倍)/
// "the first", 第一, 唯一, 这一 are not counts.
const ZH_NOT_A_NUMBER = /第[一二三]|唯一|这一|那一|每一|同一|统一|一起|一些|一下|一直|一定|一般|一旦|进一步|一致|之一/g
const EN_NUMBER = /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|twice|triple|percent)\b/i
const CURRENCY = /[$€£¥￥]|\b(?:USD|EUR|CNY|RMB|GBP|JPY|CAD|AUD)\b|美元|欧元|人民币/
// Abbreviations a Chinese answer may write in Latin letters.
const ZH_ALLOWED_LATIN = /\b(?:PO|POs|SKU|SKUs|RFQ|RFQs|PR|PRs|ERP|AI|GRN)\b/g
const DATES = /\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\b|\b(?:yesterday|tomorrow)\b|\b(?:last|next)\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday)\b|昨天|明天|前天|后天|上周|下周|上个月|下个月|去年|明年|星期[一二三四五六日天]|周[一二三四五六日]/

function setting(env, name, fallback, max) {
  return Math.min(max, Math.max(1000, Number(env?.[name]) || fallback))
}

export function aiAnswerComposeEnabled(env = {}) {
  return text(env.FLOWCHAIN_AI_AGENT_MODE).toLowerCase() === 'compose' && canCallConfiguredProvider(env)
}

// A data answer the skills built: not the help answer, a refusal, a knowledge
// answer (already written by a model from documents) or a supplier business
// query (it has its own panel).
export function aiAnswerComposable(response) {
  if (!response || response.version !== 'v2' || response.rag) return false
  if (['capability_overview', 'knowledge_retrieval', 'business_query'].includes(response.intent) || response.businessQuery) return false
  return array(response.keyEvidence).length > 0 || array(response.sections).length > 0
}

// The supplier a cited record belongs to, from the actor's own facts (null
// when the actor may not see it, as in the answer itself).
function supplierOf(item, facts) {
  const id = item.entityId
  const find = (rows, key = 'id') => array(rows).find((row) => row[key] === id || row.orderNumber === id || row.documentNumber === id || row.invoiceNumber === id)
  const row = item.entityType === 'purchase_order' ? find(facts?.purchaseOrders?.rows) || find(facts?.purchaseOrders?.index)
    : item.entityType === 'supplier_invoice' ? find(facts?.invoices?.variances)
      : item.entityType === 'receiving_doc' ? find([...array(facts?.receipts?.rejected), ...array(facts?.receipts?.unposted)])
        : null
  return text(row?.supplier) || null
}

// The slots: every value the template answer shows, by key, the counts of
// what it cites, and groups that say which slots belong together. Counts are
// slots too, so the model never writes a number.
export function aiAnswerComposeSlots(response, facts = null) {
  const slots = {}
  const groups = []
  const add = (key, value) => { const v = text(value); if (v) slots[key] = v; return v ? key : null }
  groups.push({ about: 'the standard wording of this answer; use it only when nothing better fits the question', slots: [add('answer.title', response.conclusion?.title), add('answer.summary', response.conclusion?.summary)].filter(Boolean) })
  const impacts = array(response.businessImpact)
  const evidence = array(response.keyEvidence).slice(0, AI_COMPOSE_LIMITS.records)
  evidence.forEach((item, index) => {
    const ref = `r${index + 1}`
    const impact = impacts.find((entry) => array(entry.affectedObjects).includes(item.entityId))
    const name = text(item.entityLabel || item.entityId)
    const supplier = supplierOf(item, facts)
    groups.push({ about: text(item.entityType) || 'record', slots: [
      add(ref, name),
      supplier && supplier !== name ? add(`${ref}.supplier`, supplier) : null,
      add(`${ref}.status`, item.status || item.label),
      add(`${ref}.value`, item.value),
      add(`${ref}.detail`, item.summary),
      add(`${ref}.impact`, impact?.explanation),
    ].filter(Boolean) })
  })
  // How many records of each kind the answer cites, and how many drafts.
  // By kind (count.purchase_order) and by the reason they are cited
  // (count.po_overdue), so "two orders are late" has a slot.
  const counts = new Map()
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1)
  for (const item of evidence) { bump(text(item.entityType) || 'record'); if (item.statusCode) bump(text(item.statusCode)) }
  const countSlots = [add('count.records', String(evidence.length)), ...[...counts].map(([key, count]) => add(`count.${key.replace(/[^a-z0-9_]/gi, '')}`, String(count)))]
  const cards = array(response.reviewCards).slice(0, AI_COMPOSE_LIMITS.cards)
  if (cards.length) countSlots.push(add('count.drafts', String(cards.length)))
  groups.push({ about: 'counts of the records and drafts above', slots: countSlots.filter(Boolean) })
  cards.forEach((card, index) => {
    groups.push({ about: 'draft prepared for review', slots: [add(`c${index + 1}`, card.title || card.draftTitle)].filter(Boolean) })
  })
  array(response.sections).slice(0, AI_COMPOSE_LIMITS.sections).forEach((section, index) => {
    groups.push({ about: 'part of the answer', slots: [add(`s${index + 1}.title`, section.title), add(`s${index + 1}.summary`, section.summary)].filter(Boolean) })
  })
  return { slots, groups: groups.filter((group) => group.slots.length) }
}

// The model's reply as { title, summary }: a JSON object, possibly fenced.
function parseReply(raw) {
  if (raw && typeof raw === 'object' && ('title' in raw || 'summary' in raw)) return raw
  const candidate = text(raw?.conclusion?.summary ?? raw)
  const cleaned = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { /* a raw line break or quote inside a string: read the two fields */ }
  const field = (name) => {
    const match = cleaned.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'))
    if (!match) return null
    try { return JSON.parse(`"${match[1].replace(/\n/g, '\\n')}"`) } catch { return match[1] }
  }
  const title = field('title')
  const summary = field('summary')
  return title !== null && summary !== null ? { title, summary } : null
}

// Stored names and ids the facts hold. Those this answer shows (inside one of
// its slots' values) may also be written as such; any other is a name the
// answer has no fact about, and is rejected. Units and other short lowercase
// words are left out ("pcs", "box").
function namesOf(facts, slots) {
  const values = Object.values(slots)
  const stored = [...aiSkillKnownValues(facts).stored].filter((value) => value.length >= 4 && !/^[a-z]+$/.test(value))
  for (const [key, value] of Object.entries(slots)) if (/^r\d+(?:\.supplier)?$/.test(key) && value.length >= 3) stored.push(value)
  const longestFirst = (list) => [...new Set(list)].sort((a, b) => b.length - a.length)
  return { shown: longestFirst(stored.filter((name) => values.some((value) => value.includes(name)))), other: longestFirst(stored.filter((name) => !values.some((value) => value.includes(name)))) }
}

// A number word's value ("two", 两, 十二), or null.
const EN_VALUES = Object.freeze({ zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, twice: 2, triple: 3 })
const ZH_DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })
function zhValue(word) {
  const numeral = word.replace(/[^零〇一二两三四五六七八九十百千万亿]/g, '')
  if (!numeral || /[百千万亿]/.test(numeral)) return null
  if (!numeral.includes('十')) return numeral.length === 1 ? ZH_DIGITS[numeral] : null
  const [tens, ones] = numeral.split('十')
  return (tens ? ZH_DIGITS[tens] ?? NaN : 1) * 10 + (ones ? ZH_DIGITS[ones] ?? NaN : 0)
}
// True when some match of the pattern is not allowed.
function offends(pattern, value, allowed) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (const match of value.matchAll(global)) if (!allowed(match[0])) return true
  return false
}

// The checks on one field's text. Returns a reason code, or the slots used.
// Allowed outside the slots: what the question itself says (its words, dates
// and numbers), a count equal to one of this answer's counts ("两张" when two
// orders are overdue), and the names this answer shows.
function checkField(value, { slots, names, language, question, counts }) {
  const used = []
  for (const match of value.matchAll(SLOT)) {
    if (!(match[1] in slots)) return 'unknown_slot'
    used.push(match[1])
  }
  const raw = value.replace(SLOT, ' ')
  if (/[{}]/.test(raw)) return 'unknown_slot'
  const asked = question.toLowerCase()
  const inQuestion = (token) => asked.includes(token.toLowerCase())
  if (names.other.some((name) => raw.includes(name) && !inQuestion(name))) return 'raw_name'
  const outside = names.shown.reduce((rest, name) => rest.split(name).join(' '), raw)
  if (offends(/[0-9０-９]+(?:[.,][0-9]+)*/, outside, (token) => inQuestion(token) || counts.has(Number(token)))) return 'digits'
  if (offends(EN_NUMBER, outside, (word) => inQuestion(word) || counts.has(EN_VALUES[word.toLowerCase()]))) return 'number_words'
  if (offends(ZH_NUMBER, outside.replace(ZH_NOT_A_NUMBER, ' '), (word) => inQuestion(word) || counts.has(zhValue(word)))) return 'number_words'
  if (offends(CURRENCY, outside, inQuestion)) return 'currency'
  if (offends(DATES, outside, inQuestion)) return 'date'
  if (FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN.test(outside)) return 'technical'
  if (language !== 'zh-CN' && CJK.test(outside)) return 'language'
  if (language === 'zh-CN' && offends(/[A-Za-z]{3,}/, outside.replace(ZH_ALLOWED_LATIN, ' '), inQuestion)) return 'language'
  return { used }
}

// Slots filled in; a slot's value is never changed. In Chinese, the spaces the
// model wrote between Chinese characters or punctuation are dropped, inside its
// own text and where its text meets a slot ("{r1} 也已 {r1.value}， 需要" reads
// "PO-001 也已逾期 4 天，需要"); a space next to a Latin letter or a digit stays.
const ZH_CHAR = /[　-〿一-鿿＀-￯]/u
const ZH_INNER = /(?<=[　-〿一-鿿＀-￯])\s+(?=[　-〿一-鿿＀-￯])/gu
function renderChinese(value, slots) {
  const parts = []
  let last = 0
  for (const match of value.matchAll(SLOT)) {
    parts.push({ text: value.slice(last, match.index).replace(ZH_INNER, ''), slot: false })
    parts.push({ text: slots[match[1]], slot: true })
    last = match.index + match[0].length
  }
  parts.push({ text: value.slice(last).replace(ZH_INNER, ''), slot: false })
  // The model's own punctuation in full width, as Chinese text writes it.
  for (const part of parts) if (!part.slot) part.text = part.text.replace(/[,:;?!]/g, (mark) => ZH_PUNCTUATION[mark])
  let out = ''
  for (const part of parts) {
    const left = out.replace(/\s+$/u, '')
    const right = part.text.replace(/^\s+/u, '')
    const spaced = left.length < out.length || right.length < part.text.length
    out = left + (spaced && left && right && !(ZH_CHAR.test(left.at(-1)) && ZH_CHAR.test(right[0])) ? ' ' : '') + right
  }
  return out.trim()
}
const ZH_PUNCTUATION = Object.freeze({ ',': '，', ':': '：', ';': '；', '?': '？', '!': '！' })
// A sentence slot ends with its own full stop; the model's mark after it is dropped ("发票。；" reads "发票。").
const tidy = (value, language) => (language === 'zh-CN'
  ? value.replace(/([。！？；，：、])(?:\s*[。；，、])+/g, '$1')
  : value.replace(/\.(?:\s*\.)+/g, '.').replace(/([.!?])\s*[,;](?=\s|$)/g, '$1').replace(/\s{2,}/g, ' '))
const render = (value, slots, language) => tidy(language === 'zh-CN' ? renderChinese(value, slots) : value.replace(SLOT, (_, key) => slots[key]), language).trim()

// Verifies the reply and returns the answer with the model's title and
// summary, or a reason code.
export function verifyAiAnswerComposition(reply, { response, facts, slots, question = '' }) {
  const parsed = parseReply(reply)
  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') return { ok: false, reason: 'invalid_reply' }
  const title = text(parsed.title)
  const summary = text(parsed.summary)
  if (!title || !summary) return { ok: false, reason: 'empty' }
  const language = response.language === 'zh-CN' ? 'zh-CN' : 'en-US'
  const counts = new Set(Object.entries(slots).filter(([key]) => key.startsWith('count.')).map(([, value]) => Number(value)))
  const context = { slots, names: namesOf(facts, slots), language, question: text(question), counts }
  const used = []
  for (const value of [title, summary]) {
    const checked = checkField(value, context)
    if (typeof checked === 'string') return { ok: false, reason: checked }
    used.push(...checked.used)
  }
  // Grounded: the wording uses the answer's facts, it does not replace them.
  if (!used.length) return { ok: false, reason: 'no_slots' }
  const renderedTitle = render(title, slots, language)
  const renderedSummary = render(summary, slots, language)
  if (renderedTitle.length > AI_COMPOSE_LIMITS.title || renderedSummary.length > AI_COMPOSE_LIMITS.summary) return { ok: false, reason: 'too_long' }
  // Only the standard wording, unchanged: the template stays, unlabelled.
  if (renderedTitle === text(response.conclusion?.title) && renderedSummary === text(response.conclusion?.summary)) return { ok: false, reason: 'unchanged' }
  if (aiAnswerClaimsAction(renderedTitle) || aiAnswerClaimsAction(renderedSummary)) return { ok: false, reason: 'action_claim' }
  const composed = {
    ...response,
    conclusion: { ...response.conclusion, title: renderedTitle, summary: renderedSummary },
    answerSource: 'workspace_agent',
    answerSourceLabel: aiSkillText('answer.source_agent', language),
    runtimeModeLabel: aiSkillText('answer.source_agent', language),
  }
  try {
    return { ok: true, response: assertValidAiSkillResponse(composed, facts), slotCount: new Set(used).size }
  } catch {
    return { ok: false, reason: 'invalid_answer' }
  }
}

// Asks the model to word the answer, and returns the composed answer or the
// template answer with the outcome for the audit row.
// `resolvedQuestion`: what a follow-up means once the rules have read it with
// the previous answer ("what about the second one?" is "What about PO-011?").
export async function composeAiAnswer({ response, facts, message, resolvedQuestion = null, env = {}, provider = callConfiguredProvider, fetchImpl = globalThis.fetch } = {}) {
  if (!aiAnswerComposeEnabled(env)) return { response, compose: null }
  if (!aiAnswerComposable(response)) return { response, compose: { status: 'skipped', reason: 'not_composable' } }
  const started = Date.now()
  const { slots, groups } = aiAnswerComposeSlots(response, facts)
  const resolved = text(resolvedQuestion) && text(resolvedQuestion) !== text(message) ? text(resolvedQuestion).slice(0, 600) : null
  const input = { task: { type: 'answer_composition', question: text(message).slice(0, 1200), ...(resolved ? { resolvedQuestion: resolved } : {}), answerLanguage: response.language === 'zh-CN' ? 'zh-CN' : 'en-US' }, facts: { slots, groups } }
  const controller = new AbortController()
  const timeoutMs = setting(env, 'FLOWCHAIN_AI_COMPOSE_TIMEOUT_MS', AI_COMPOSE_LIMITS.timeoutMs, AI_COMPOSE_LIMITS.maxTimeoutMs)
  const abortable = (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ ok: false, reason: 'timeout' }) }, timeoutMs) })
  let reply
  try {
    // The wording may use its own model (FLOWCHAIN_AI_COMPOSE_MODEL, models per
    // task, owner decision 5 of 2026-10-07): a stronger one than the planner's.
    const composeEnv = text(env.FLOWCHAIN_AI_COMPOSE_MODEL) ? { ...env, FLOWCHAIN_AI_PROVIDER_MODEL: text(env.FLOWCHAIN_AI_COMPOSE_MODEL) } : env
    reply = await Promise.race([Promise.resolve(provider(input, composeEnv, abortable)), timeout])
  } catch {
    reply = { ok: false, reason: 'provider_error' }
  } finally {
    clearTimeout(timer)
  }
  const base = { provider: providerRuntimeConfig(env).kind, ...(text(env.FLOWCHAIN_AI_COMPOSE_MODEL) ? { model: 'compose_model' } : {}), latencyMs: Date.now() - started, slotsOffered: Object.keys(slots).length, ...(reply?.usage ? { usage: { input: reply.usage.inputTokens ?? null, output: reply.usage.outputTokens ?? null } } : {}) }
  if (!reply?.ok) return { response, compose: { status: 'degraded', reason: reply?.reason || 'provider_error', ...base } }
  const verified = verifyAiAnswerComposition(reply.rawOutput ?? reply.output, { response, facts, slots, question: [message, resolved].filter(Boolean).join('\n') })
  if (!verified.ok) return { response, compose: { status: verified.reason === 'unchanged' ? 'unchanged' : 'rejected', reason: verified.reason, ...base } }
  return { response: verified.response, compose: { status: 'composed', slotsUsed: verified.slotCount, ...base } }
}

// The audit block: codes and counts only, never the question or any text.
export function aiAnswerComposeAudit(compose) {
  if (!compose) return null
  return {
    status: compose.status,
    ...(compose.reason ? { reason: compose.reason } : {}),
    ...(compose.provider ? { provider: compose.provider } : {}),
    ...(Number.isFinite(compose.latencyMs) ? { latencyMs: compose.latencyMs } : {}),
    ...(Number.isFinite(compose.slotsOffered) ? { slotsOffered: compose.slotsOffered } : {}),
    ...(Number.isFinite(compose.slotsUsed) ? { slotsUsed: compose.slotsUsed } : {}),
    ...(compose.usage ? { usage: compose.usage } : {}),
  }
}
