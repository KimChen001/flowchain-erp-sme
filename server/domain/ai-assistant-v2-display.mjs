// How assistant v2 writes dates, amounts, quantities and record numbers in its
// prose: as the app shows them in the workspace's locale and timezone, so the
// text reads like the cards beside it ("Nov 4, 2026", "$2,500.00",
// "7,000 pcs", LOCAL-DEMO-PO-014), and Chinese answers use full-width
// punctuation (2026-11-05 review of a live run).
//
// Three uses:
//   - aiV2DisplayStrings adds a display string beside each date, amount and
//     large quantity of a tool result the model reads (dueDateText,
//     amountText, remainingText), which the prompt tells it to copy. The
//     stored result keeps its values; only what the model reads changes.
//   - aiV2TextTidier rewrites what the model still writes its own way, piece
//     by piece as the text streams: ISO dates, "5,000 USD", "7000 pcs", a
//     shortened record number that one record of the answer ends with, and
//     ASCII punctuation in Chinese. A piece is cut at a word break (the
//     loop's lastBreak), so each rewrite sees its whole value.
//   - aiV2UserTypedDate says whether a date the check could not find is one
//     the user typed ("Nov 20"), which is no invention.
// Language never changes the formats: numbers, amounts and dates keep the
// workspace locale whatever the answer's language, as the cards do.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HAN = /[㐀-鿿豈-﫿]/u
// Han characters and the full-width punctuation around them.
const CJK = /[㐀-鿿豈-﫿　-〿！-｠]/u

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

function realDay(value) {
  const match = text(value).match(ISO_DAY)
  if (!match) return null
  const time = Date.UTC(+match[1], +match[2] - 1, +match[3])
  return new Date(time).toISOString().slice(0, 10) === match[0] ? new Date(time) : null
}

// The workspace's formats, as the panel's formatters write them
// (formatCalendarDay, formatLocaleAmount with at most two decimals).
// unitLabel(unit, quantity): a stored unit code in the answer's language and
// number ("box" -> "boxes", 箱), as the rules assistant words it
// (aiSkillUnitLabel); by default the code as stored.
export function aiV2Formats({ locale = 'en-US', timezone = 'America/New_York', unitLabel = null } = {}) {
  let tag = text(locale) || 'en-US'
  try { new Intl.NumberFormat(tag) } catch { tag = 'en-US' }
  let zone = text(timezone) || 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }) } catch { zone = 'UTC' }
  const numberFormat = new Intl.NumberFormat(tag, { maximumFractionDigits: 4 })
  // A date-only value is that calendar day; a timestamp is the day it falls on
  // in the workspace's timezone.
  const day = (value) => {
    const raw = text(value)
    const date = realDay(raw)
    if (date) return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
    if (ISO_TIME.test(raw)) {
      const instant = new Date(raw)
      if (Number.isFinite(instant.getTime())) return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: zone }).format(instant)
    }
    return null
  }
  // `digits`: the decimals to keep, for a figure the model wrote its own
  // way ("7,300 USD" stays $7,300, never $7,300.00: a rounded figure gets no
  // false cents); by default the currency's own.
  const money = (amount, currency, digits) => {
    const code = text(currency).toUpperCase()
    if (!isNumber(amount) || !/^[A-Z]{3}$/.test(code)) return null
    const fraction = Number.isInteger(digits) ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : { maximumFractionDigits: 2 }
    try {
      return new Intl.NumberFormat(tag, { style: 'currency', currency: code, ...fraction }).format(amount)
    } catch {
      return `${new Intl.NumberFormat('en-US', fraction).format(amount)} ${code}`
    }
  }
  // A month and day with no year ("Nov 6"): no year is made up for it.
  const monthDay = (month, dayOfMonth) => {
    const time = Date.UTC(2000, Number(month) - 1, Number(dayOfMonth))
    const date = new Date(time)
    if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(dayOfMonth)) return null
    return new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)
  }
  const number = (value) => numberFormat.format(value)
  // `language` words an English line of a Chinese answer in English.
  const unitText = (unit, value, language) => (typeof unitLabel === 'function' && text(unit) ? text(unitLabel(text(unit), value, language)) : '') || text(unit)
  const quantity = (value, unit) => (text(unit) ? `${number(value)} ${unitText(unit, value)}` : number(value))
  return { locale: tag, timezone: zone, day, monthDay, money, number, quantity, unitText }
}

// The keys that hold an amount or a quantity in the data tools' results (as
// the table builder reads them, ai-assistant-v2-ui-tools.mjs).
const MONEY_KEYS = new Set(['amount', 'outstandingAmount', 'paidAmount', 'originalAmount', 'totalValue', 'difference', 'variance', 'unitPrice', 'referencePrice', 'spend', 'committed'])
const QUANTITY_KEYS = new Set([
  'ordered', 'received', 'remaining', 'onHand', 'reserved', 'available', 'openSalesDemand', 'incomingOnPurchaseOrders', 'availableToPromise', 'shortage',
  'safetyStock', 'reorderPoint', 'incoming', 'demand', 'endAvailable', 'quantity', 'rejected', 'stillToReceive', 'withoutTheseLines', 'additionalShortfall',
  'position', 'shortfall', 'minimumOrderQuantity', 'requestQuantity', 'orderedQuantity', 'needs', 'notShippedOrReserved', 'open',
])
const SKIP_KEYS = new Set(['ref', 'asOf', 'source'])
const currencyOf = (value) => (/^[A-Z]{3}$/.test(text(value)) ? text(value) : null)

// The result with a display string beside each value whose shown form differs
// from the raw one: every day and amount, and a quantity of 1,000 or more,
// with decimals, or whose unit reads otherwise in the answer ("300 boxes",
// "300 箱"; a small quantity in pcs reads the same). The keys end in Text;
// nothing else changes.
export function aiV2DisplayStrings(result, formats) {
  const walk = (value, scope) => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, scope))
    if (!isObject(value)) return value
    const unit = [value.unit, value.item?.unit].find((entry) => typeof entry === 'string' && entry.trim() && entry.length <= 20) || scope.unit
    const ownCurrency = currencyOf(value.currency)
    const currency = ownCurrency || scope.currency
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SKIP_KEYS.has(key) ? entry : walk(entry, { unit, currency, parent: key })
      if (SKIP_KEYS.has(key) || /(?:Text|Label)$/.test(key) || `${key}Text` in value) continue
      let shown = null
      if (typeof entry === 'string' && (ISO_DAY.test(entry) || ISO_TIME.test(entry))) shown = formats.day(entry)
      else if (isNumber(entry)) {
        if (MONEY_KEYS.has(key) && currency) shown = formats.money(entry, currency)
        // { value, currency } (an estimated price) is an amount; the value of a
        // suggested quantity is a quantity in the row's unit.
        else if (key === 'value' && ownCurrency) shown = formats.money(entry, ownCurrency)
        else if ((QUANTITY_KEYS.has(key) || (key === 'value' && scope.parent === 'suggestedQuantity')) && unit && (Math.abs(entry) >= 1000 || !Number.isInteger(entry) || formats.unitText(unit, entry) !== unit)) shown = formats.quantity(entry, unit)
      }
      if (shown) out[`${key}Text`] = shown
    }
    return out
  }
  return walk(result, { unit: null, currency: isObject(result) ? currencyOf(result.currency) : null, parent: '' })
}

// The words a text may write for a currency, by its code.
const CURRENCY_WORDS = Object.freeze({ USD: 'USD', EUR: 'EUR', GBP: 'GBP', CNY: 'CNY', RMB: 'CNY', JPY: 'JPY', CAD: 'CAD', AUD: 'AUD', 美元: 'USD', 欧元: 'EUR', 英镑: 'GBP', 人民币: 'CNY' })
const CODE_WORDS = 'USD|EUR|GBP|CNY|RMB|JPY|CAD|AUD|美元|欧元|英镑|人民币'
const AMOUNT = String.raw`[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`
// "5,000 USD", "$79,692.50 USD", "19,120 美元": a figure with its currency
// after it; "USD 5,000" with it before. A figure with a scale (5k, 1.9万) or
// a percent is left as written.
const AMOUNT_THEN_CODE = new RegExp(String.raw`(?<![\w.,$€£¥￥])(?:(US\$|\$|€|£|¥|￥)\s?)?(${AMOUNT})(?![\d,.]?\d)\s?(${CODE_WORDS})(?![A-Za-z])`, 'gu')
const CODE_THEN_AMOUNT = new RegExp(String.raw`(?<![A-Za-z])(USD|EUR|GBP|CNY|RMB|JPY|CAD|AUD)\s?(${AMOUNT})(?![\d,.]?\d)(?![kKmM万亿千%％]|\s?(?:${CODE_WORDS}))`, 'gu')
const ISO_IN_TEXT = /(?<![\w-])(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)(?![\w-])/g
const SHORT_RECORD = /(?<![\w-])([A-Za-z]{1,6}-\d+)(?![\w-])/g
const UNIT_WORDS = ['pcs', 'pc', 'units', 'unit', 'ea', 'kg', 'g', 'lb', 'lbs', 'm', 'ft', 'box', 'boxes', 'roll', 'rolls', 'case', 'cases', 'set', 'sets', 'pack', 'packs', 'pair', 'pairs', 'l', 'ml', '件', '个', '箱', '卷', '台', '套', '只', '片', '米', '包']

const amountOf = (value) => Number(value.replace(/,/g, '').replace('−', '-'))
const decimalsOf = (value) => (String(value).split('.')[1] || '').length
// A day written the Chinese way, alone or as a range whose second day may
// leave out the year: 2026年7月1日至9月30日, 2026 年 8 月 8 日到 2026 年 11 月 5 日.
const ZH_DATE = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号](?:\s*(至|到|~|～|-|–|—)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号])?/g
// A date written half the Chinese way and half the app's way, the month as
// a number with 月 and the year after a comma (2026-11-08 on DeepSeek:
// "10 月 1, 2026" for Oct 1, 2026): written in the workspace's format.
const HYBRID_ZH_DATE = /(?<![\d.])(\d{1,2})\s*月\s*(\d{1,2})\s*[,，]\s*(\d{4})(?!\d)/g
const ZH_MONTH_DAY = /(?<!\d\s*年\s*)(?<![\d.])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号](?:\s*(至|到|~|～|-|–|—)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号])?/g
const isoDay = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

// Where the text places a display ("the table above", 上表只列出了…), in
// words that do not (2026-11-05: the table now sits below the text).
const POSITIONS = [
  [/\b(the|this|that)\s+(table|list|chart|form|cards?)\s+(?:above|below)\b/gi, '$1 $2'],
  [/\b([Tt])he\s+(?:above|below)\s+(table|list|chart|form|cards?)\b/g, '$1he $2'],
  [/\b(shown|listed|displayed)\s+(?:above|below)\b/gi, '$1'],
  [/[上下]([表图])(?=[中里])/g, '$1'],
  [/[上下]([表图])(?=只|列|共|按|显示|展示|给出|的|所)/g, '$1中'],
  [/(见|如|在|从|看)[上下]([表图])(?![格达现情])/g, '$1$2中'],
  [/(?:上面|下面|上方|下方)的?(表格|列表|图表|卡片|表单|按钮)/g, '$1'],
  [/(?:上面|下面|上方|下方)(列出|列了)/g, '$1'],
]

// Status, severity, priority and signal codes in words, [English, Chinese].
// The statuses use the assistant's own words (po_status in ai-skill-copy.mjs,
// LABELS.purchase_request below), so the prose matches the tables of the same
// answer, and with the app's pages (src/i18n/statusLabels.ts: 已批准, 已下达,
// 已驳回, 已取消; the owner's terminology of 2026-11-05).
const CODE_LABELS = Object.freeze({
  risk: ['Risk', '风险'], warning: ['Warning', '警告'], info: ['Info', '提示'],
  matched: ['Matched', '已匹配'], variance_approved: ['Variance approved', '差异已批准'], variance: ['Variance', '有差异'], exception: ['Exception', '异常'], mismatch: ['Mismatch', '不一致'], not_matched: ['Not matched', '未匹配'],
  pending: ['Pending', '待处理'], pending_approval: ['Pending approval', '待审批'], submitted: ['Submitted', '已提交'], draft: ['Draft', '草稿'],
  approved: ['Approved', '已批准'], rejected: ['Rejected', '已驳回'], cancelled: ['Cancelled', '已取消'], canceled: ['Cancelled', '已取消'],
  issued: ['Issued', '已下达'], partially_received: ['Partially received', '部分收货'], fully_received: ['Fully received', '全部收货'], received: ['Received', '已收货'],
  closed: ['Closed', '已关闭'], posted: ['Posted', '已过账'], unposted: ['Not posted', '未过账'], overdue: ['Overdue', '已逾期'], disputed: ['Disputed', '有争议'],
  below_safety_stock: ['Below safety stock', '低于安全库存'], below_reorder_point: ['Below reorder point', '低于再订货点'], out_of_stock: ['Out of stock', '缺货'], shortage_risk: ['Shortage risk', '短缺风险'],
})
function codesInWords(value, index) {
  const known = (code) => CODE_LABELS[code] || LABELS.type[code] || LABELS.priority[code]
  // Inside an English sentence the label reads as a word ("status: approved",
  // "partially received"), an acronym kept (RFQ); Chinese labels as they are.
  const inline = (code) => {
    const label = known(code)?.[index]
    if (!label) return null
    return index === 0 && /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label
  }
  return value
    // A code written as one (partially_received, po_overdue), anywhere.
    .replace(/(?<![\w-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w-])/g, (whole, code) => inline(code) ?? whole)
    // A code in quotes ('marks it as "risk"').
    .replace(/(["“‘「])([a-z][a-z_]*)(["”’」])/g, (whole, open, code, close) => (known(code) ? `${open}${known(code)[index]}${close}` : whole))
    // A code after "status" ("match status: variance", 状态：approved).
    .replace(/\b((?:match |posting |dispute )?status(?:\s+is|\s*[:：])\s*)([a-z][a-z_]*)\b/gi, (whole, lead, code) => (known(code) ? `${lead}${inline(code)}` : whole))
    .replace(/(状态\s*(?:[:：]|为|是)\s*)([a-z][a-z_]*)/g, (whole, lead, code) => (known(code) ? `${lead}${known(code)[index]}` : whole))
}

// A space between Chinese and a number, as the app writes it ("涉及 5 家",
// "逾期 4 天"); a date's own parts (11月20日, 2026年) stay together.
function zhSpacing(piece, before) {
  let out = ''
  let prev = before.slice(-1)
  for (const char of piece) {
    if ((HAN.test(prev) && /\d/.test(char) && !/[年月日号]/.test(prev)) || (/\d/.test(prev) && HAN.test(char) && !/[年月日号]/.test(char))) out += ' '
    out += char
    prev = char
  }
  return out
}

// Where a ', : ; ! ?' goes full-width in Chinese: after a Han character or
// full-width punctuation, or before a Han character, never between digits.
const ZH_PUNCT = Object.freeze({ ',': '，', ':': '：', ';': '；', '!': '！', '?': '？' })

// A tidier for one answer's text. `records()` gives the labels of the records
// this answer's tools returned (they grow as results come in), `units()` the
// units they hold. tidy(piece, before, after) rewrites one piece of a text
// part, `before` being the part's text already rewritten and sent and `after`
// the model's text after the piece so far (to know the line it ends in).
export function aiV2TextTidier({ language = 'en-US', formats = aiV2Formats(), records = () => [], units = () => [], maxLength = Infinity } = {}) {
  const zh = language === 'zh-CN'
  // One stretch of a single line, in the rules of `lineZh`.
  const tidyLine = (piece, before, lineZh) => {
    let out = piece
    // Dates the app would show its own way, the Chinese way of writing them
    // too (2026年7月1日至9月30日): the workspace's date format holds in
    // either language.
    out = out.replace(ISO_IN_TEXT, (whole, value) => formats.day(value) || whole)
    out = out.replace(ZH_DATE, (whole, year, month, day, joint, year2, month2, day2) => {
      const first = formats.day(isoDay(year, month, day))
      if (!first) return whole
      if (!joint) return first
      const second = formats.day(isoDay(year2 || year, month2, day2))
      return second ? `${first} ${/[至到]/.test(joint) ? joint : '–'} ${second}` : whole
    })
    out = out.replace(HYBRID_ZH_DATE, (whole, month, day, year) => formats.day(isoDay(year, month, day)) || whole)
    // One with no year (11 月 6 日, 11月6日至8日) as a month and day.
    out = out.replace(ZH_MONTH_DAY, (whole, month, day, joint, month2, day2) => {
      const first = formats.monthDay(month, day)
      if (!first) return whole
      if (!joint) return first
      const second = formats.monthDay(month2 || month, day2)
      return second ? `${first} ${/[至到]/.test(joint) ? joint : '–'} ${second}` : whole
    })
    // Amounts with a currency code or word, as the cards write them.
    out = out.replace(AMOUNT_THEN_CODE, (whole, symbol, figure, word) => formats.money(amountOf(figure), CURRENCY_WORDS[word.toUpperCase()] || CURRENCY_WORDS[word], decimalsOf(figure)) || whole)
    out = out.replace(CODE_THEN_AMOUNT, (whole, word, figure) => formats.money(amountOf(figure), CURRENCY_WORDS[word.toUpperCase()], decimalsOf(figure)) || whole)
    // A large whole quantity with its unit, grouped as the cards group it.
    const stored = [...new Set(array(units()).map(text).filter((unit) => unit && unit.length <= 20))]
    const unitWords = [...new Set([...UNIT_WORDS, ...stored])].sort((a, b) => b.length - a.length).map(escape)
    out = out.replace(new RegExp(String.raw`(?<![\w.]|\d,)(\d{4,})(?=\s?(?:${unitWords.join('|')})(?![A-Za-z]))`, 'gu'), (whole) => formats.number(Number(whole)))
    // A stored unit after its quantity, in the answer's language and number
    // ("300 box" -> "300 boxes", "50 pcs" -> "50 件"); a Chinese unit word
    // runs into the Chinese after it ("50 件温度传感器"), also when the
    // Chinese comes in the next piece.
    if (stored.length) {
      const unitPattern = new RegExp(String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(${stored.sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z])([ \t](?=[㐀-鿿]|$))?`, 'gu')
      out = out.replace(unitPattern, (whole, figure, unit, gap) => {
        const label = formats.unitText(unit, amountOf(figure), lineZh ? language : 'en-US')
        return `${figure} ${label}${gap && !HAN.test(label) ? gap : ''}`
      })
    }
    // A shortened record number that exactly one record of the answer ends with.
    const labels = [...new Set(array(records()).map(text).filter(Boolean))]
    if (labels.length) {
      const full = new Set(labels.map((label) => label.toUpperCase()))
      out = out.replace(SHORT_RECORD, (token) => {
        const upper = token.toUpperCase()
        if (full.has(upper)) return token
        const matches = labels.filter((label) => label.toUpperCase().endsWith(`-${upper}`))
        return matches.length === 1 ? matches[0] : token
      })
    }
    // A table, chart or form is placed by the panel, not where the text
    // says: no "the table above", 上表 (2026-11-05).
    for (const [pattern, replacement] of POSITIONS) out = out.replace(pattern, replacement)
    // A status, severity or signal code quoted, after "status", or written
    // as a code (partially_received), in words of the answer's language.
    out = codesInWords(out, lineZh ? 1 : 0)
    if (lineZh) out = zhSpacing(zhPunctuation(out, before), before)
    return out
  }
  // A Chinese answer may hold English: a drafted message ("> " lines) or a
  // line with no Chinese in it keeps English punctuation and units
  // (2026-11-05: "30 件are still outstanding （20 of 50 received）").
  const tidy = (piece, before = '', after = '') => {
    const whole = String(piece ?? '')
    if (!whole) return whole
    if (!zh) return tidyLine(whole, before, false)
    const segments = whole.split(/(?<=\n)/)
    let done = ''
    for (const [index, segment] of segments.entries()) {
      const prior = before + done
      const line = `${prior.slice(prior.lastIndexOf('\n') + 1)}${segment}${index === segments.length - 1 ? String(after).split('\n')[0] : ''}`
      const english = /^\s*>/.test(line) || (!HAN.test(line) && (line.match(/[A-Za-z]{2,}/g) || []).length >= 3)
      done += tidyLine(segment, prior, !english)
    }
    return done
  }
  // A single line (a follow-up question): tidied whole, and left as written
  // when the tidied form would not fit.
  const line = (value) => {
    const tidied = tidy(value, '')
    return tidied.length <= maxLength ? tidied : value
  }
  return { tidy, line }
}

// ASCII punctuation in Chinese text, full-width (，：；！？（）). Parentheses go
// full-width in a Chinese answer except a link's; a closing one follows its
// opening one. A colon or comma between digits (10:30, 1,000) stays.
function zhPunctuation(piece, before) {
  if (!/[,:;!?()]/.test(piece)) return piece
  let out = ''
  // The last character written before this one that is not a space.
  const prevOf = () => {
    for (const source of [out, before]) for (let at = source.length - 1; at >= 0; at -= 1) if (source[at] !== ' ' && source[at] !== '\t') return source[at]
    return ''
  }
  // The opening parenthesis a closing one ends, within its paragraph.
  const openParen = () => {
    const all = before + out
    let depth = 0
    for (let at = all.length - 1; at >= 0; at -= 1) {
      const char = all[at]
      if (char === ')' || char === '）') depth += 1
      else if (char === '(' || char === '（') {
        if (!depth) return char
        depth -= 1
      } else if (char === '\n' && all[at - 1] === '\n') return ''
    }
    return ''
  }
  for (let at = 0; at < piece.length; at += 1) {
    const char = piece[at]
    if (!ZH_PUNCT[char] && char !== '(' && char !== ')') { out += char; continue }
    const last = out ? out[out.length - 1] : before.slice(-1)
    if (ZH_PUNCT[char]) {
      const next = piece.slice(at + 1).match(/^[ \t]*(.)/u)?.[1] || ''
      const digits = /\d/.test(last) && /\d/.test(piece[at + 1] || '')
      const nearHan = CJK.test(prevOf()) || HAN.test(next)
      // An image's "![": the mark stays, so the image is still dropped.
      if (!digits && nearHan && !(char === '!' && piece[at + 1] === '[')) {
        out = out.replace(/[ \t]+$/, '') + ZH_PUNCT[char]
        while (piece[at + 1] === ' ' || piece[at + 1] === '\t') at += 1
        continue
      }
    } else if (char === '(') {
      if (last !== ']') {
        out = out.replace(/[ \t]+$/, '') + '（'
        while (piece[at + 1] === ' ' || piece[at + 1] === '\t') at += 1
        continue
      }
    } else if (char === ')') {
      // A numbered list's "1)" keeps its mark.
      const listMark = /(?:^|\n)[ \t]*\d{1,3}$/.test(before + out)
      if (!listMark && openParen() !== '(') {
        out = out.replace(/[ \t]+$/, '') + '）'
        continue
      }
    }
    out += char
  }
  return out
}

// The month-day keys of the dates a text writes (11-20), in the forms people
// type: 2026-11-20, Nov 20, 20 November, 11/20, 11月20日.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const DAY_FORMS = [
  [/(?<!\d)\d{4}-(\d{1,2})-(\d{1,2})(?!\d)/g, (m) => [+m[1], +m[2]]],
  [new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'), (m) => [MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]]],
  [new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'gi'), (m) => [MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]]],
  [/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g, (m) => [+m[1], +m[2]]],
  [/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, (m) => [+m[1], +m[2]]],
  [/(?<![\w./-])(\d{1,2})-(\d{1,2})(?![\w/-])/g, (m) => [+m[1], +m[2]]],
]
function dayKeys(value) {
  const keys = new Set()
  const source = text(value).normalize('NFKC')
  for (const [pattern, read] of DAY_FORMS) {
    for (const match of source.matchAll(pattern)) {
      const [month, day] = read(match)
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) keys.add(`${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    }
  }
  return keys
}

// Whether a date the check flagged is one the user typed in this conversation.
export function aiV2UserTypedDate(value, userText) {
  const typed = dayKeys(userText)
  if (!typed.size) return false
  return [...dayKeys(value)].some((key) => typed.has(key))
}

// The words of a status, a signal type or a priority the results give as a
// code, in the answer's language, for the model to write: what it read before
// was the code alone (a purchase request "has status: submitted"; 2026-11-05).
const LABELS = Object.freeze({
  purchase_request: {
    draft: ['Draft', '草稿'], submitted: ['Waiting for approval', '待审批'], approved: ['Approved', '已批准'], rejected: ['Rejected', '已驳回'],
    cancelled: ['Cancelled', '已取消'], converted: ['Converted to an order', '已转为订单'], closed: ['Closed', '已关闭'],
  },
  type: {
    po_overdue: ['Overdue purchase order', '逾期采购订单'], po_due_7d: ['Due within 7 days', '7 天内到期'], po_partially_received: ['Partially received', '部分收货'],
    stock_shortage: ['Short against demand', '无法满足需求'], stock_below_safety: ['Below safety stock', '低于安全库存'], stock_below_reorder: ['At or below reorder point', '达到再订货点'],
    invoice_variance: ['Supplier invoice difference', '采购发票差异'], pr_awaiting_approval: ['Purchase request waiting for approval', '采购申请待审批'],
    rfq_ready_to_award: ['RFQ ready to award', '询价单可授标'], grn_rejected_qty: ['Rejected on receipt', '收货拒收'], grn_received_unposted: ['Receipt not posted', '收货单未过账'],
    supplier_exposure: ['Supplier with several problems', '有多项问题的供应商'],
  },
  priority: { urgent: ['Urgent', '紧急'], high: ['High', '高'], medium: ['Medium', '中'], normal: ['Normal', '普通'], low: ['Low', '低'] },
})

// The result with a label beside the codes above: statusLabel on a purchase
// request, typeLabel on a signal row, priorityLabel on a request.
export function aiV2CodeLabels(result, language) {
  const index = language === 'zh-CN' ? 1 : 0
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (!isObject(value)) return value
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === 'ref' ? entry : walk(entry)
      if (typeof entry !== 'string' || `${key}Label` in value) continue
      const table = key === 'status' && value.ref?.type === 'purchase_request' ? LABELS.purchase_request : key === 'type' || key === 'priority' ? LABELS[key] : null
      if (table?.[entry]) out[`${key}Label`] = table[entry][index]
    }
    return out
  }
  return walk(result)
}

export const AI_V2_HAN = HAN
