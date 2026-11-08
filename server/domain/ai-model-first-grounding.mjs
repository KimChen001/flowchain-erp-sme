import { aiAnswerActionClaims, aiAnswerRecordStates } from './ai-answer-claims.mjs'

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
// The conversation so far (the earlier questions and answers) counts as given
// for record numbers and known names only: they name what was discussed, so
// "I did not mean to choose LDM-001 for you" passes. A figure or a date from an
// earlier turn must be read again.
//
// What it cannot see: rankings ("the most urgent"), "all" or "none" claims,
// numbers written as words (three, 三), a shortened name ("Acme" for Acme
// Components), and reasoning between correct numbers. The prompt asks for the
// basis of a ranking; the evaluation measures the rest (§7).

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).normalize('NFKC').toLowerCase()
// Text whose figures are read. NFKC turns a Chinese comma into ",", which ran
// two figures into one: "$2,500，100 个是 $1,250" read as $2,500,100
// (2026-11-07). A space after it keeps them apart.
const figuresText = (value) => String(value ?? '').replace(/，/g, ', ').normalize('NFKC')
const CJK = /[㐀-鿿]/u
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const AI_GROUNDING_KINDS = Object.freeze(['record', 'name', 'date', 'number', 'citation', 'action_claim', 'limit_claim', 'format'])

// Wording that blames a permission or a system limit for what the assistant
// does not do itself. Where it can propose (it opens a filled-in form for the
// user to submit), that is not why: the user confirms every change by design.
const LIMIT_CLAIMS = [
  /没有[^。，！？,.!?]{0,8}权限|无权|权限不足|权限(?:只能|仅能|有限|不够)|系统(?:设定|设置)?的?限制|系统不允许|不被允许|(?:无法|不能)(?:直接|帮你|帮您|为你|为您)?(?:创建|新建|建立)/,
  /\b(?:cannot|can't|am unable to|unable to)\s+(?:directly\s+)?(?:create|make)\b/i,
  /\b(?:do not|don't|cannot|can't)\s+have\s+(?:the\s+)?permission\b|\bno permission\b|\bmy permissions? (?:only|are limited)\b|\bnot (?:allowed|permitted) to\b|\bsystem (?:limit|limits|restriction|restrictions)\b/i,
]

// Record numbers: letters, then hyphenated parts ending in digits.
const RECORD = /(?<![\w-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+[A-Za-z0-9]*(?![\w-])/g
const NOT_RECORD = /^tier-\d$/i

// The record numbers in a text as this check reads them, NFKC-normalised.
export function aiGroundingRecordNumbers(value) {
  return [...String(value ?? '').normalize('NFKC').matchAll(RECORD)].map((match) => match[0]).filter((token) => !NOT_RECORD.test(token))
}
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
// A month and day written 10/28 or 11-07 is a date only when the tool results
// hold one; otherwise its parts are checked as numbers ("4/5 deliveries",
// "3-5 days"). On 2026-11-03 the reorder answer wrote order-by days as 11-07
// and 12-27, and each was read as the numbers 07 and 27, so a correct answer
// fell back to the rules.
const SLASH_DAY = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g
const DASH_DAY = /(?<![\w./-])(\d{1,2})-(\d{1,2})(?![\w/-]|\.\d)/g
const CURRENCY_WORDS = [
  [/^(?:US\$|\$|USD|美元)$/i, ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD']], [/^(?:€|EUR|欧元)$/i, ['EUR']], [/^(?:£|GBP|英镑)$/i, ['GBP']],
  [/^(?:¥|￥|CNY|RMB|元|人民币)$/i, ['CNY', 'JPY']], [/^(?:JPY|日元)$/i, ['JPY']], [/^(?:CAD)$/i, ['CAD']], [/^(?:AUD)$/i, ['AUD']],
]
const NUMBER = /(?<cur>US\$|\$|€|£|¥|￥|\b(?:USD|EUR|GBP|CNY|RMB|JPY|CAD|AUD)\b)?\s?(?<![\w.])(?<num>[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d.,]\d)(?!(?:st|nd|rd|th)\b)(?<scale>[kK](?![a-zA-Z])|[mM](?![a-zA-Z])|bn\b|万|亿|千)?\s?(?<suffix>%|％|percent\b|per cent\b|个百分点|USD\b|EUR\b|GBP\b|CNY\b|美元|欧元|英镑|人民币|元|days?\b|天|日)?/g
const SCALES = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, bn: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 }
const MONEY_KEY = /amount|value|total|spend|committed|difference|variance|price|cost|balance|outstanding|budget|result/i
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
// A count a passage writes as a word ("within three business days",
// 三个工作日), which an answer writes as 3. From two to twenty only: "one" and
// 一 mean much else in prose, and a compound ("three-way match") is no count.
const PROSE_WORDS = Object.freeze({ two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 })
const PROSE_WORD = new RegExp(`\\b(${Object.keys(PROSE_WORDS).join('|')})\\b(?!-)`, 'gi')
// What a count beside a list counts: up to two words, then the noun (6 FOODS_3
// items, 3 late purchase orders), or a Chinese measure word (6 个, 3 张).
// An item of a numbered list, quoted or not, with its number.
const LIST_ITEM = /^\s*(?:>\s*)*(\d{1,2})[.)]\s+/gm
// Payment terms, read as a term: Net 30, 2/10 net 30, 月结 30 天.
const PAYMENT_TERMS = /(?:\b\d{1,2}\/\d{1,2}\s+)?\bnet\s?\d{1,3}\b|月结\s*\d{1,3}\s*天/giu
// What marks a figure as rounded, before or after it.
const APPROX_BEFORE = /(?:\babout|\baround|\broughly|\bapproximately|\bapprox\.?|~|≈|约|大约|大概|近)\s*$/i
const APPROX_AFTER = /^\s*(?:左右|上下)/
// What points at a step of a numbered list: "step 2", "steps 1 and 2", 第 2 步, 步骤 3.
const STEP_BEFORE = /(?:\bsteps?|步骤|第)[^.\n。！？!?]{0,16}$/i
const COUNT_NOUN =/^\s*(?:(?:[\p{L}\p{N}_-]+\s+){0,2}(?:items?|skus?|products?|orders?|requests?|suppliers?|customers?|lines?|records?)(?![\p{L}])|(?:个|项|张|家|种|笔|条|款))/iu
const ZH_DIGITS = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })
const ZH_COUNT = /([二两三四五六七八九]?十[一二三四五六七八九]?|[二两三四五六七八九])\s*(?=个|天|日|周|次|件|家|笔|名|项|条|份|小时|工作日|月|年)/g
const zhCount = (value) => {
  if (!value.includes('十')) return ZH_DIGITS[value]
  const [tens, ones] = value.split('十')
  return (tens ? ZH_DIGITS[tens] : 1) * 10 + (ones ? ZH_DIGITS[ones] : 0)
}

// Everything the tool results of this answer hold: their strings (one text to
// search), their numbers with the key and currency they came with, and their
// dates and months. A date written in a passage without its year is kept as
// ????-MM-DD, which matches the same day in any year.
export function aiGroundingSources(results = []) {
  const strings = []
  const numbers = []
  const days = new Set()
  const months = new Set()
  const names = new Set()
  const addDates = (value) => {
    for (const match of value.matchAll(/(?<!\d)(\d{4})-(\d{2})(?:-(\d{2}))?(?!\d)/g)) {
      months.add(`${match[1]}-${match[2]}`)
      if (match[3]) days.add(`${match[1]}-${match[2]}-${match[3]}`)
    }
  }
  const addProse = (value) => {
    let rest = figuresText(value)
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
    for (const match of rest.matchAll(PROSE_WORD)) numbers.push({ value: PROSE_WORDS[match[1].toLowerCase()], key: 'text', currency: null, unit: null })
    for (const match of rest.matchAll(ZH_COUNT)) numbers.push({ value: zhCount(match[1]), key: 'text', currency: null, unit: null })
  }
  const walk = (value, key = '', parent = null) => {
    if (value === null || value === undefined) return
    if (typeof value === 'number') { if (Number.isFinite(value)) numbers.push({ value, key, currency: text(parent?.currency).toUpperCase() || null, unit: text(parent?.unit).toLowerCase() || null }); return }
    if (typeof value === 'string') {
      strings.push(fold(value))
      addDates(value)
      // A name with a number in it (Customer 14096 (United Kingdom)): its
      // number is part of the name, not a figure (2026-11-07: a top-customers
      // answer had every customer's number flagged).
      // So is the part before a bracket, which a Chinese answer may follow
      // with its own words (Customer 16684（英国）).
      if (NAME_KEYS.has(key) && /\p{L}/u.test(value) && /\d/.test(value) && value.trim().length >= 3) {
        names.add(value.trim())
        const head = value.split(/\s*[(（]/)[0].trim()
        if (head !== value.trim() && /\p{L}/u.test(head) && /\d/.test(head) && head.length >= 3) names.add(head)
      }
      if (/^-?[\d,]+(?:\.\d+)?$/.test(value.trim())) numbers.push({ value: Number(value.replace(/,/g, '')), key, currency: text(parent?.currency).toUpperCase() || null, unit: null })
      else if (PROSE_KEYS.has(key)) addProse(value)
      // A plan's lines as the solver writes them ("FOODS_3_090 390, ..."):
      // each figure is a quantity (2026-11-06: an answer quoting the plan
      // without a budget, 81 units, was flagged though the tool gave it).
      // Digits inside a SKU are not read.
      else if (key === 'lines') for (const match of value.matchAll(PROSE_NUMBER)) numbers.push({ value: Number(match[0].replace(/,/g, '')), key: 'quantity', currency: null, unit: null })
      return
    }
    if (typeof value === 'boolean') return
    if (Array.isArray(value)) { addCounts(value, parent); for (const item of value) walk(item, key, parent); return }
    if (typeof value === 'object') for (const [name, entry] of Object.entries(value)) walk(entry, name, value)
  }
  // The counts a list of rows holds without writing them: how many rows share
  // a value (3 of the late orders are Northstar's) or have a flag set (10 of
  // the 12 raised to the minimum order). 2026-11-07: "FOODS_3 items (6)" was
  // flagged though the reorder list had 6 rows from that supplier. Only from a
  // whole list: rows cut at the limit (more > 0) would count short. The list's
  // own size is its total field.
  const addCounts = (rows, parent) => {
    const objects = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    if (objects.length < 2 || Number(parent?.more) > 0) return
    const groups = new Map()
    for (const row of objects) {
      for (const [name, entry] of Object.entries(row)) {
        const value = typeof entry === 'boolean' ? String(entry) : typeof entry === 'string' ? fold(entry) : typeof entry?.name === 'string' ? fold(entry.name) : ''
        if (!value) continue
        const group = `${name}\u0000${value}`
        groups.set(group, (groups.get(group) || 0) + 1)
      }
    }
    for (const count of new Set(groups.values())) numbers.push({ value: count, key: 'count', currency: null, unit: null })
  }
  for (const result of array(results)) walk(result)
  return { haystack: `\n${strings.join('\n')}\n`, numbers, days, months, names: [...names] }
}

const NAME_KEYS = new Set(['customer', 'customerName', 'itemName', 'name', 'supplier', 'supplierName'])

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
// `limitClaims`: the assistant could propose this answer's action, so a
// permission or system-limit excuse fails the check.
export function checkAiModelFirstGrounding({ answer, results = [], refs = [], question = '', conversation = '', facts = null, today = null, limitClaims = false }) {
  const problems = []
  const checked = { record: 0, name: 0, date: 0, number: 0, citation: 0 }
  const fail = (kind, value) => { if (!problems.some((row) => row.kind === kind && row.value === value)) problems.push({ kind, value }) }
  const title = text(answer?.title)
  const body = text(answer?.answer)
  if (!body) fail('format', 'answer')
  const sources = aiGroundingSources(results)
  const asked = fold(question)
  // Record numbers and names may also come from the conversation so far.
  const named = fold(`${question}\n${conversation}`)
  const given = aiGroundingSources([question])
  if (today) { sources.days.add(today); sources.months.add(today.slice(0, 7)) }
  // The highest item number of the answer's own numbered lists, quoted ones
  // (a drafted message) included: "steps 1 and 2" points into them.
  const listItems = Math.max(0, ...[...figuresText(body).matchAll(LIST_ITEM)].map((match) => Number(match[1])))
  // List marks go, also inside a quoted draft ("> 3. The reason for the delay").
  let rest = figuresText(`${title}\n${body}`).replace(/^\s*(?:>\s*)*(?:\d{1,2}[.)]|[-*•])\s+/gm, ' ')
    // Payment terms are a term, not a figure: "Net 30", "2/10 net 30", 月结 30 天.
    .replace(PAYMENT_TERMS, (match) => ' '.repeat(match.length))
  const blank = (match) => ' '.repeat(match.length)
  // Where each grounded record and name sits, for a count written beside the
  // list it counts ("FOODS_3 items (6): FOODS_3_064, …"). An item's name and
  // its SKU are one item.
  const listed = []
  const offsetOf = (args) => args.find((value) => typeof value === 'number')
  const entities = new Map()
  for (const row of [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)]) {
    if (!text(row?.sku)) continue
    entities.set(fold(row.sku), `item:${fold(row.sku)}`)
    if (text(row.itemName)) entities.set(fold(row.itemName), `item:${fold(row.sku)}`)
  }

  // Record numbers: as a tool wrote them, or as the end of one ("PO-020" for
  // LOCAL-DEMO-PO-020).
  rest = rest.replace(RECORD, (token, ...args) => {
    if (NOT_RECORD.test(token)) return token
    checked.record += 1
    const value = fold(token)
    // The question may write it without the hyphen ("LDM001").
    const squeezed = (value) => value.replace(/[-\s]/g, '')
    const found = inText(sources.haystack, value) || new RegExp(`-${escape(value)}($|[^a-z0-9])`, 'u').test(sources.haystack) || inText(named, value) || inText(squeezed(named), squeezed(value))
    if (!found) fail('record', token)
    else listed.push({ at: offsetOf(args), key: entities.get(value) || `record:${value}` })
    return blank(token)
  })
  // Names the workspace knows.
  for (const name of [...new Set([...aiGroundingNames(facts), ...sources.names])].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(nameMatch(name), (found, ...args) => {
      checked.name += 1
      if (!inText(sources.haystack, name) && !inText(named, name)) fail('name', found)
      else listed.push({ at: offsetOf(args), key: entities.get(fold(name)) || `name:${fold(name)}` })
      return blank(found)
    })
  }
  // A whole number in brackets, or before what it counts (6 items, 6 个),
  // that equals the records and names its own line lists.
  const listCount = (at, length) => {
    const after = rest.slice(at + length, at + length + 40)
    if (!(rest[at - 1] === '(' && /^\s*\)/.test(after)) && !COUNT_NOUN.test(after)) return null
    const start = rest.lastIndexOf('\n', at) + 1
    const end = rest.indexOf('\n', at) === -1 ? rest.length : rest.indexOf('\n', at)
    return new Set(listed.filter((row) => row.at >= start && row.at < end).map((row) => row.key)).size
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
  for (const pattern of [SLASH_DAY, DASH_DAY]) {
    rest = rest.replace(pattern, (whole, month, day) => {
      if (+month > 12 || +day > 31 || !dayKnown({ year: null, month: +month, day: +day })) return whole
      checked.date += 1
      return blank(whole)
    })
  }
  // Numbers, with what they measure.
  const givenNumbers = [...figuresText(question).matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, '')))
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
    // A figure the answer marks as rounded ("about $7,300", 约 7,300 美元,
    // 7,300 美元左右) may be off by half the place of its last non-zero
    // digit; any other by half its last digit.
    const at = match.index + match[0].indexOf(num)
    const approximate = APPROX_BEFORE.test(rest.slice(Math.max(0, match.index - 16), match.index)) || APPROX_AFTER.test(rest.slice(match.index + match[0].length, match.index + match[0].length + 6))
    const zeros = !decimals && approximate ? (digits.replace(/^-/, '').match(/0+$/) || [''])[0].length : 0
    const tolerance = (zeros ? 0.5 * 10 ** zeros : 0.5 * 10 ** -decimals) * factor + 1e-9
    const unit = text(suffix).toLowerCase()
    const currencies = currencyCodes(cur) || currencyCodes(unit)
    const kind = currencies ? 'money' : /%|％|percent|per cent|百分点/.test(unit) ? 'percent' : /day|天|日/.test(unit) ? 'days' : 'plain'
    checked.number += 1
    const near = (candidate) => Math.abs(Math.abs(candidate) - value) <= tolerance
    const grounded = sources.numbers.some((source) => numberKindFits(source, kind, currencies) && (near(source.value) || (kind === 'percent' && near(source.value * 100))))
      || givenNumbers.some(near)
      || (kind === 'plain' && !decimals && factor === 1 && value >= 1900 && value <= 2100 && [...sources.months].some((month) => month.startsWith(String(value))))
      || (kind === 'plain' && !decimals && factor === 1 && value >= 2 && listCount(at, num.length) === value)
      // A step of the answer's own numbered list ("steps 1 and 2", 第 2 步).
      || (kind === 'plain' && !decimals && factor === 1 && value >= 1 && value <= listItems && (STEP_BEFORE.test(rest.slice(Math.max(0, at - 24), at)) || /^\s*步/.test(rest.slice(at + num.length, at + num.length + 3))))
    if (!grounded) fail('number', match[0].trim())
  }
  // Cited records: each one a tool returned.
  for (const record of array(answer?.records)) {
    checked.citation += 1
    // A record a tool named without its own ref (a SKU in a list of SKUs at
    // risk) is grounded too; only records with a ref get a link.
    if (!citedRef(record, refs) && !inText(sources.haystack, text(record?.id))) fail('citation', `${text(record?.type)}:${text(record?.id)}`)
  }
  if (limitClaims) {
    for (const value of [title, body]) {
      for (const pattern of LIMIT_CLAIMS) {
        const found = value.match(pattern)
        if (found) fail('limit_claim', found[0])
      }
    }
  }
  // Wording that reads as if the assistant acted, with the list the server's
  // validator and the evaluation use, so the model can be told the phrase. A
  // state word about a record a tool returned in that state is its status.
  const states = recordStates(results)
  for (const value of [title, body]) {
    for (const found of aiAnswerActionClaims(value, states)) fail('action_claim', found)
  }
  const counts = {}
  for (const row of problems) counts[row.kind] = (counts[row.kind] || 0) + 1
  return { ok: problems.length === 0, problems, counts, checked }
}

// The records the tools returned with a status (status, postingStatus,
// matchStatus), by their id and label.
function recordStates(results) {
  const records = []
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (!value || typeof value !== 'object') return
    if (value.ref?.type && value.ref?.id) {
      const states = Object.entries(value).filter(([key, entry]) => /status$/i.test(key) && typeof entry === 'string').map(([, entry]) => entry)
      if (states.length) records.push({ type: value.ref.type, numbers: [value.ref.id, value.ref.label], states })
    }
    for (const entry of Object.values(value)) walk(entry)
  }
  walk(results)
  return aiAnswerRecordStates(records)
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
