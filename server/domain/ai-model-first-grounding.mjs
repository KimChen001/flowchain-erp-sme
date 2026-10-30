import { AI_ANSWER_ACTION_CLAIMS } from './ai-answer-claims.mjs'

// The grounding check of the model-first assistant (docs/ai-model-first-design.md
// §3, decision M3): it replaces the slot templates. From the answer's title and
// text the server reads
//   - every record number (PO-020, LDM-001, SO-001);
//   - every name of a supplier, customer or item the workspace knows;
//   - every date (2026-10-28, Oct 28, 10月28日);
//   - every number, with its currency, percent sign or days;
// and each must appear in a tool result of this answer, after normalising
// formats (1,234.50 is 1234.5; $47.2k is 47,200 give or take 50), or come from
// the calculate tool, whose results are tool results too. A number may be
// rounded. The question's own words count as given: a figure or a name the
// user wrote is not the model's invention. A cited record must be one a tool
// returned, and the text may not claim the assistant acted. What fails is
// listed with its kind; the loop gives the model one retry with the list, and
// the audit row keeps the kinds and counts only, never the text.
//
// What it cannot see: rankings ("the most urgent"), "all" or "none" claims,
// numbers written as words (three, 三), a shortened name ("Acme" for Acme
// Components), and reasoning between correct numbers. The prompt asks for the
// basis of a ranking; the evaluation measures the rest (§7).

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).normalize('NFKC').toLowerCase()
const CJK = /[㐀-鿿]/u
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const AI_GROUNDING_KINDS = Object.freeze(['record', 'name', 'date', 'number', 'citation', 'action_claim', 'format'])

// Record numbers: letters, then hyphenated parts ending in digits.
const RECORD = /(?<![\w-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+[A-Za-z0-9]*(?![\w-])/g
const NOT_RECORD = /^tier-\d$/i
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const DATE_PATTERNS = [
  { pattern: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }) },
  { pattern: /(?<!\d)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, read: (m) => ({ year: m[1] ? +m[1] : null, month: +m[2], day: +m[3] }) },
  { pattern: /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月/g, read: (m) => ({ year: +m[1], month: +m[2], day: null }) },
  // A month alone (上季度 7月至9月), not a count of months (3 个月).
  { pattern: /(?<![\d.])(\d{1,2})\s*月(?!\s*\d)/g, read: (m) => ({ year: null, month: +m[1], day: null }) },
  { pattern: new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\d)`, 'gi'), read: (m) => ({ year: m[3] ? +m[3] : null, month: MONTHS[m[1].slice(0, 3).toLowerCase()], day: +m[2] }) },
  { pattern: new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi'), read: (m) => ({ year: m[3] ? +m[3] : null, month: MONTHS[m[2].slice(0, 3).toLowerCase()], day: +m[1] }) },
  { pattern: new RegExp(`\\b${MONTH}\\s+(\\d{4})(?!\\d)`, 'gi'), read: (m) => ({ year: +m[2], month: MONTHS[m[1].slice(0, 3).toLowerCase()], day: null }) },
  { pattern: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g, read: (m) => ({ year: +m[3], month: +m[1], day: +m[2] }) },
]
// A month and day written 10/28 is a date only when the tool results hold
// one; otherwise its parts are checked as numbers ("4/5 deliveries").
const SLASH_DAY = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g
const CURRENCY_WORDS = [
  [/^(?:US\$|\$|USD|美元)$/i, ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD']], [/^(?:€|EUR|欧元)$/i, ['EUR']], [/^(?:£|GBP|英镑)$/i, ['GBP']],
  [/^(?:¥|￥|CNY|RMB|元|人民币)$/i, ['CNY', 'JPY']], [/^(?:JPY|日元)$/i, ['JPY']], [/^(?:CAD)$/i, ['CAD']], [/^(?:AUD)$/i, ['AUD']],
]
const NUMBER = /(?<cur>US\$|\$|€|£|¥|￥|\b(?:USD|EUR|GBP|CNY|RMB|JPY|CAD|AUD)\b)?\s?(?<![\w.])(?<num>[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d.,]\d)(?!(?:st|nd|rd|th)\b)(?<scale>[kK](?![a-zA-Z])|[mM](?![a-zA-Z])|bn\b|万|亿|千)?\s?(?<suffix>%|％|percent\b|per cent\b|个百分点|USD\b|EUR\b|GBP\b|CNY\b|美元|欧元|英镑|人民币|元|days?\b|天|日)?/g
const SCALES = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, bn: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 }
const MONEY_KEY = /amount|value|total|spend|committed|difference|variance|price|cost|balance|outstanding|result/i
const PERCENT_KEY = /percent|share|rate|result/i
const DAYS_KEY = /day|delay|overdue|result|between|lead/i

function currencyCodes(word) {
  const found = CURRENCY_WORDS.find(([pattern]) => pattern.test(text(word)))
  return found ? found[1] : null
}

// Fields that hold a document's own words (search_documents passages): a
// number or a date written in them counts as given, whatever it measures.
const PROSE_KEYS = new Set(['excerpt', 'section', 'document'])
const PROSE_NUMBER = /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?/g

// Everything the tool results of this answer hold: their strings (one text to
// search), their numbers with the key and currency they came with, and their
// dates and months. A date written in a passage without its year is kept as
// ????-MM-DD, which matches the same day in any year.
export function aiGroundingSources(results = []) {
  const strings = []
  const numbers = []
  const days = new Set()
  const months = new Set()
  const addDates = (value) => {
    for (const match of value.matchAll(/(?<!\d)(\d{4})-(\d{2})(?:-(\d{2}))?(?!\d)/g)) {
      months.add(`${match[1]}-${match[2]}`)
      if (match[3]) days.add(`${match[1]}-${match[2]}-${match[3]}`)
    }
  }
  const addProse = (value) => {
    let rest = value.normalize('NFKC')
    for (const { pattern, read } of DATE_PATTERNS) {
      rest = rest.replace(pattern, (...match) => {
        const date = read(match)
        if (!date.month || date.month > 12) return match[0]
        const year = date.year ? String(date.year) : '????'
        const month = String(date.month).padStart(2, '0')
        months.add(`${year}-${month}`)
        if (date.day) days.add(`${year}-${month}-${String(date.day).padStart(2, '0')}`)
        return ' '.repeat(match[0].length)
      })
    }
    for (const match of rest.matchAll(PROSE_NUMBER)) numbers.push({ value: Number(match[0].replace(/,/g, '')), key: 'text', currency: null, unit: null })
  }
  const walk = (value, key = '', parent = null) => {
    if (value === null || value === undefined) return
    if (typeof value === 'number') { if (Number.isFinite(value)) numbers.push({ value, key, currency: text(parent?.currency).toUpperCase() || null, unit: text(parent?.unit).toLowerCase() || null }); return }
    if (typeof value === 'string') {
      strings.push(fold(value))
      addDates(value)
      if (/^-?[\d,]+(?:\.\d+)?$/.test(value.trim())) numbers.push({ value: Number(value.replace(/,/g, '')), key, currency: text(parent?.currency).toUpperCase() || null, unit: null })
      else if (PROSE_KEYS.has(key)) addProse(value)
      return
    }
    if (typeof value === 'boolean') return
    if (Array.isArray(value)) { for (const item of value) walk(item, key, parent); return }
    if (typeof value === 'object') for (const [name, entry] of Object.entries(value)) walk(entry, name, value)
  }
  for (const result of array(results)) walk(result)
  return { haystack: `\n${strings.join('\n')}\n`, numbers, days, months }
}

const inText = (haystack, needle) => {
  const value = fold(needle)
  if (!value) return false
  if (CJK.test(value)) return haystack.includes(value)
  return new RegExp(`(^|[^a-z0-9])${escape(value)}($|[^a-z0-9])`, 'u').test(haystack)
}

// Names the workspace knows, as the asking user's facts hold them: suppliers,
// customers, items and SKUs. Longest first, so "Acme Components Ltd" is read
// before "Acme Components".
export function aiGroundingNames(facts) {
  const names = new Set()
  const add = (value) => { const name = text(value); if (name.length >= 3 && /[\p{L}]/u.test(name)) names.add(name) }
  for (const row of array(facts?.suppliers)) { add(row.name); add(row.code) }
  for (const row of [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)]) { add(row.itemName); add(row.sku) }
  for (const row of array(facts?.salesOrders)) add(row.customer)
  for (const row of array(facts?.purchaseOrders?.index)) add(row.supplier)
  return [...names].sort((a, b) => b.length - a.length)
}

// A name of one Latin word is matched as written ("Bolt", not "bolt"); a
// longer or Chinese name in any case.
function nameMatch(name) {
  if (CJK.test(name)) return new RegExp(escape(name), 'gu')
  const oneWord = !/\s/.test(name)
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, oneWord ? 'gu' : 'giu')
}

function numberKindFits(source, kind, currencies) {
  // A number in a document's own words measures what the passage says.
  if (source.key === 'text') return true
  // An amount comes from a money field (amount, total, difference…), in the
  // currency written when the result names one.
  if (kind === 'money') return MONEY_KEY.test(source.key) && (!currencies || !source.currency || currencies.includes(source.currency))
  if (kind === 'percent') return PERCENT_KEY.test(source.key) || source.unit === 'percent'
  if (kind === 'days') return DAYS_KEY.test(source.key) || source.unit === 'days'
  return true
}

// Checks one answer. `answer` is { title, answer, records }; `results` the
// tool results of this answer (the calls that succeeded); `refs` the records
// they returned; `question` the user's question; `facts` the asking user's
// facts (for the names); `today` the day the model was given. Returns
// { ok, problems: [{ kind, value }], counts: { kind: n }, checked: { kind: n } }.
export function checkAiModelFirstGrounding({ answer, results = [], refs = [], question = '', facts = null, today = null }) {
  const problems = []
  const checked = { record: 0, name: 0, date: 0, number: 0, citation: 0 }
  const fail = (kind, value) => { if (!problems.some((row) => row.kind === kind && row.value === value)) problems.push({ kind, value }) }
  const title = text(answer?.title)
  const body = text(answer?.answer)
  if (!body) fail('format', 'answer')
  const sources = aiGroundingSources(results)
  const asked = fold(question)
  const given = aiGroundingSources([question])
  if (today) { sources.days.add(today); sources.months.add(today.slice(0, 7)) }
  let rest = `${title}\n${body}`.normalize('NFKC').replace(/^\s*(?:\d{1,2}[.)]|[-*•])\s+/gm, ' ')
  const blank = (match) => ' '.repeat(match.length)

  // Record numbers: as a tool wrote them, or as the end of one ("PO-020" for
  // LOCAL-DEMO-PO-020).
  rest = rest.replace(RECORD, (token) => {
    if (NOT_RECORD.test(token)) return token
    checked.record += 1
    const value = fold(token)
    const found = inText(sources.haystack, value) || new RegExp(`-${escape(value)}($|[^a-z0-9])`, 'u').test(sources.haystack) || inText(asked, value)
    if (!found) fail('record', token)
    return blank(token)
  })
  // Names the workspace knows.
  for (const name of aiGroundingNames(facts)) {
    rest = rest.replace(nameMatch(name), (found) => {
      checked.name += 1
      if (!inText(sources.haystack, name) && !inText(asked, name)) fail('name', found)
      return blank(found)
    })
  }
  // Dates: the same day (and year, when written) as a date in the results.
  const dayKnown = ({ year, month, day }) => {
    const pad = (value) => String(value).padStart(2, '0')
    const pool = day ? [...sources.days, ...given.days] : [...sources.months, ...given.months]
    const tail = day ? `-${pad(month)}-${pad(day)}` : `-${pad(month)}`
    return pool.some((value) => (year && !value.startsWith('????') ? value === `${year}${tail}` : value.endsWith(tail)))
  }
  for (const { pattern, read } of DATE_PATTERNS) {
    rest = rest.replace(pattern, (...match) => {
      const date = read(match)
      if (!date.month || date.month > 12 || (date.day !== null && (date.day < 1 || date.day > 31))) return match[0]
      checked.date += 1
      if (!dayKnown(date)) fail('date', match[0])
      return blank(match[0])
    })
  }
  rest = rest.replace(SLASH_DAY, (whole, month, day) => {
    if (+month > 12 || +day > 31 || !dayKnown({ year: null, month: +month, day: +day })) return whole
    checked.date += 1
    return blank(whole)
  })
  // Numbers, with what they measure.
  const givenNumbers = [...String(question ?? '').normalize('NFKC').matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, '')))
  for (const match of rest.matchAll(NUMBER)) {
    const { cur, num, scale, suffix } = match.groups
    // A number run into letters is part of a word (3PL, 2FA), not a figure.
    const after = rest[match.index + match[0].indexOf(num) + num.length] || ''
    if (!scale && /[A-Za-z]/.test(after)) continue
    const digits = num.replace(/[,−]/g, (c) => (c === '−' ? '-' : ''))
    const written = Math.abs(Number(digits))
    if (!Number.isFinite(written)) continue
    const decimals = (digits.split('.')[1] || '').length
    const factor = SCALES[scale] || 1
    const value = written * factor
    const tolerance = 0.5 * 10 ** -decimals * factor + 1e-9
    const unit = text(suffix).toLowerCase()
    const currencies = currencyCodes(cur) || currencyCodes(unit)
    const kind = currencies ? 'money' : /%|％|percent|per cent|百分点/.test(unit) ? 'percent' : /day|天|日/.test(unit) ? 'days' : 'plain'
    checked.number += 1
    const near = (candidate) => Math.abs(Math.abs(candidate) - value) <= tolerance
    const grounded = sources.numbers.some((source) => numberKindFits(source, kind, currencies) && (near(source.value) || (kind === 'percent' && near(source.value * 100))))
      || givenNumbers.some(near)
      || (kind === 'plain' && !decimals && factor === 1 && value >= 1900 && value <= 2100 && [...sources.months].some((month) => month.startsWith(String(value))))
    if (!grounded) fail('number', match[0].trim())
  }
  // Cited records: each one a tool returned.
  for (const record of array(answer?.records)) {
    checked.citation += 1
    if (!citedRef(record, refs)) fail('citation', `${text(record?.type)}:${text(record?.id)}`)
  }
  // Wording that reads as if the assistant acted, with the list the server's
  // validator and the evaluation use, so the model can be told the phrase.
  for (const value of [title, body]) {
    for (const pattern of AI_ANSWER_ACTION_CLAIMS) {
      const found = value.match(pattern)
      if (found) fail('action_claim', found[0])
    }
  }
  const counts = {}
  for (const row of problems) counts[row.kind] = (counts[row.kind] || 0) + 1
  return { ok: problems.length === 0, problems, counts, checked }
}

// The record a citation names, among those the tools returned: by type and
// id or label, or by id or label alone when only one record has it (the model
// wrote "sku" for an item). null when no tool returned it.
function citedRef(record, refs) {
  const id = fold(record?.id)
  if (!id) return null
  const same = (row) => fold(row.id) === id || fold(row.label) === id
  const typed = array(refs).find((row) => row.type === text(record?.type) && same(row))
  if (typed) return typed
  const any = array(refs).filter(same)
  return any.length === 1 ? any[0] : null
}

// The records an answer cited, as the tools returned them (type, id, label),
// once each; citations of records no tool returned are left out.
export function aiModelFirstCitedRefs(records, refs) {
  const out = []
  for (const record of array(records)) {
    const ref = citedRef(record, refs)
    if (ref && !out.some((row) => row.type === ref.type && row.id === ref.id)) out.push(ref)
  }
  return out
}
