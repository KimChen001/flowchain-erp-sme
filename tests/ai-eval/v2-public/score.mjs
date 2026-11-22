// Scoring one answer of the v2 public evaluation. Pure functions, so they are
// unit-tested without a server (server/domain/public-data-eval.test.mjs).
//
// An answer is { status, text, ui: [{ component, props }], flags, errors,
// notices }. What it is checked for:
//   numbers     each expected figure appears in the text or a display, within
//               its tolerance (amounts written with $, £, commas or a unit
//               count as their number);
//   skus        at least skuShare of the SKUs are named;
//   quantities  each positive quantity of the optimal order appears next to
//               its SKU in a display row, or in the text;
//   form        a purchase request form holds the SKU at the quantity;
//   listed      (2026-11-22) at least atLeast of the rows (items due, with
//               the reorder list's quantity) named with that quantity, and
//               none of them with another (see itemsAtQuantity);
//   formAt      every ticked form line is one of the rows' items at its
//               quantity, and one line or more is ticked;
//   wholeList   the answer points to the whole list: a table that links its
//               page (listRoute), or words that send the user there beside a
//               table;
//   firstTurn   the checks for the first answer of a conversation, reported
//               as "turn 1: …";
//   mentions    each group has one of its words in the text or a display
//               (an item by its SKU or its name, a supplier by its name);
//   dates       each date appears, written as 2026-11-04, Nov 4, 4 November,
//               04/11/2026 or 11 月 4 日;
//   refuses     the answer declines (nothing is changed from the chat);
//   language    the text is in the language asked in;
//   tidy        no raw decimals (three places or more) in the text, no
//               half-Chinese dates (10 月 1, 2026), no opening narration
//               ("Let me check…", "让我查一下");
//   clean       status 200, no error, and no figure the check flagged.
//   Conversations, cards and links (2026-11-11):
//   ui          cards it shows (has) or leaves out (hasNot);
//   formLines   a form row of the SKU, at the quantity, ticked or not;
//   formNoneChecked  no form row ticked (the user named no item);
//   formRules   the ticked rows keep to the user's and the suppliers' limits
//               (2026-11-11): within a budget at each item's price, none
//               below its minimum order, only the items allowed (onlySkus)
//               and none left out (notSkus);
//   refs        records it links, by type and label (named in the text or
//               on a card);
//   matches / notMatches  wording it must have, or must not (in the text);
//   and when the text says it filled in a form: that form is shown;
//   languages   each turn's language, for a switch the user asked for;
//   calls       the tools it must call (2026-11-12): the solver for an order
//               under a budget, the cost tool for one item's order size, so
//               the model's own arithmetic fails the case;
//   and always: the chips in the answer's language, and no English sentence
//   (eight words or more) in a Chinese answer.
//
// A number may list anyOf: values, any one of which passes.
//
// concise (2026-11-12, the owner: "一次性对话出来就是太多了"): the text within
// LENGTH_BUDGET, brief for a lookup (expect.brief), other for the rest, where
// a Chinese character counts twice. It is soft: it is reported with each
// answer and in the summary, and does not fail the case, so the pass rate
// stays comparable across length changes.

const CJK = /[㐀-鿿]/g
const LATIN = /[A-Za-z]/g

// Every number in a text: thousands commas dropped; "7.9 万" and "£75.6k"
// read as 79,000 and 75,600 as well as their written figure.
export function numbersIn(value) {
  const text = String(value ?? '').replace(/(\d),(?=\d{3}\b)/g, '$1')
  const numbers = []
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?(\s*万|k\b)?/g)) {
    const number = Number(match[0].replace(/\s*万$|k$/, ''))
    if (!Number.isFinite(number)) continue
    numbers.push(number)
    if (match[1]) numbers.push(Math.round(number * (match[1].trim() === '万' ? 10000 : 1000) * 100) / 100)
  }
  return numbers
}

// Small counts written as words: "Four posted receipts", 两张订单. Once figures
// were matched in the answer's words only, not-invoiced-en's right answer
// ("Four posted receipts have no supplier invoice") failed on its 4
// (2026-11-15). Up to twenty in English ("one of" is not a count); a Chinese
// numeral before a measure word.
const EN_COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const ZH_COUNTS = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })
export function countWordsIn(value) {
  const text = String(value ?? '')
  const english = [...text.matchAll(new RegExp(String.raw`\b(${EN_COUNTS.join('|')})\b(?!\s+of\b)`, 'gi'))].map((match) => EN_COUNTS.indexOf(match[1].toLowerCase()))
  const chinese = [...text.matchAll(/(?<![一二两三四五六七八九十百千万\d])([一二两三四五六七八九十])(?=\s*(?:张|个|家|件|笔|条|项|次|天|位|份|批|单|种))/g)].map((match) => ZH_COUNTS[match[1]])
  return [...english, ...chinese]
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// The ways an answer may write a date (YYYY-MM-DD).
export function dateForms(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  const dd = String(day).padStart(2, '0')
  const mm = String(month).padStart(2, '0')
  const name = MONTHS[month - 1]
  return [
    new RegExp(`${year}-${mm}-${dd}`),
    new RegExp(`\\b${name}[a-z]*\\.?\\s+${day}(?:st|nd|rd|th)?\\b`, 'i'),
    new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+${name}[a-z]*\\b`, 'i'),
    new RegExp(`\\b${dd}/${mm}/${year}\\b`),
    new RegExp(`(?<!\\d)${month}\\s*月\\s*${day}\\s*日`),
  ]
}

const REFUSAL = /\b(?:can(?:no|')t|cannot|unable|not able|don't have|do not have|isn't something|not something|won't)\b|无法|不能|没有权限|不支持|做不到/i
const RAW_DECIMAL = /(?<![\d.])\d+\.\d{3,}(?![\d.])/
const HALF_CHINESE_DATE = /\d{1,2}\s*月\s*\d{1,2}\s*,\s*\d{4}/
const NARRATION = /^(?:let me|let's|i'll|i will|i'm going to|i am going to|first,? (?:let me|i'll)|now,? let me|okay,? let me|让我|我来|我先|好的，我来|我将)/i

// A text part written after a table or card that says the answer again: at
// least 200 characters, with half of its 6-character runs (spaces and
// punctuation left out) or 60% of its words and figures (each Chinese
// character a word) already in the earlier parts. A short closing line is
// not a repeat.
export function repeatedPart(parts = []) {
  const runs = (value) => {
    const plain = String(value).replace(/[\s\p{P}*#>|-]+/gu, '')
    return new Set(Array.from({ length: Math.max(0, plain.length - 5) }, (_, index) => plain.slice(index, index + 6)))
  }
  const words = (value) => new Set(String(value).toLowerCase().match(/[a-z]{3,}|\d+(?:\.\d+)?|[一-鿿]/g) || [])
  const share = (later, earlier) => (later.size ? [...later].filter((entry) => earlier.has(entry)).length / later.size : 0)
  for (let index = 1; index < parts.length; index += 1) {
    const part = String(parts[index]).trim()
    if (part.length < 200) continue
    const before = parts.slice(0, index).join('\n')
    if (share(runs(part), runs(before)) >= 0.5 || share(words(part), words(before)) >= 0.6) return part.slice(0, 40)
  }
  return null
}

export function tidyProblems(text, parts = []) {
  const problems = []
  const repeated = repeatedPart(parts)
  if (repeated) problems.push(`repeats an earlier paragraph ("${repeated}…")`)
  const raw = String(text || '').match(RAW_DECIMAL)
  if (raw) problems.push(`raw decimal ${raw[0]}`)
  const date = String(text || '').match(HALF_CHINESE_DATE)
  if (date) problems.push(`date written as ${date[0]}`)
  const opening = String(text || '').trim().split('\n')[0].replace(/^[#*>\s-]+/, '')
  if (NARRATION.test(opening)) problems.push(`opens with "${opening.slice(0, 40)}"`)
  // Markup the model put before its words (2026-11-14: "<?xml version="1.0"?>").
  const declaration = String(text || '').match(/^\s*(<\?[A-Za-z][\w.-]*\b[^>]*\?>)/)
  if (declaration) problems.push(`opens with ${declaration[1].slice(0, 40)}`)
  return problems
}

// Record numbers, SKUs and Title Case names ("Acme Home Goods", "White
// Hanging Heart T-Light Holder", "PO-202610-0022") are names, not the
// answer's language (2026-11-13: a Chinese answer naming each order's item
// and supplier in English was scored as English).
const NAMES = /\b[A-Z0-9][\w.&'’-]*(?:\s+(?:[A-Z0-9][\w.&'’-]*|of|and|the|for|with|in|on|de))*/g
export function answerLanguage(text) {
  const value = String(text)
  const cjk = (value.match(CJK) || []).length
  if (!cjk) return 'en-US'
  const latin = (value.replace(NAMES, ' ').match(LATIN) || []).length
  // About two Latin letters a word against one character a word.
  return cjk * 2 >= latin ? 'zh-CN' : 'en-US'
}

const flat = (answer) => `${answer.text || ''}\n${JSON.stringify(answer.ui || [])}`

// The rows of every table or card in the answer, as plain objects.
function displayRows(answer) {
  const rows = []
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const keys = Object.keys(value)
      if (keys.some((key) => /sku|item/i.test(key))) rows.push(value)
      for (const key of keys) walk(value[key])
    }
  }
  walk((answer.ui || []).map((part) => part.props))
  return rows
}

// A run of eight or more English words in a Chinese answer is a sentence in
// the wrong language; record names are shorter.
const ENGLISH_RUN = /(?:[A-Za-z][A-Za-z'’&.,-]*\s+){7,}[A-Za-z][A-Za-z'’&.-]*/
export const englishRun = (text) => (String(text || '').replace(/`[^`]*`/g, ' ').match(ENGLISH_RUN) || [null])[0]
const hasCjk = (value) => /[㐀-鿿]/.test(String(value))
const formRows = (answer) => (answer.ui || []).filter((part) => part.component === 'pr_form').flatMap((part) => [...(part.props?.lines || []), ...(part.props?.suggested || [])])
const patternOf = ({ pattern, flags = 'i' }) => new RegExp(pattern, flags)
const FORM_CLAIM = /\bI(?:'ve| have)\s+(?:just\s+|also\s+)?(?:filled in|filled out|put together|prepared|drafted|set up)\b[^.\n]{0,60}\bform\b|(?:填好|填了|已填写?)[^。\n]{0,20}(?:申请单|表单)/i

// Sentences: a figure counts beside its SKU anywhere in the same sentence, a
// clause after ； or ; included (2026-11-12: "22423 …，缺口 20 件；但最小起订量为
// 60 件，所以建议按 60 件下单。" missed its 60). A full stop inside a figure
// (£12.75) does not end one.
const SENTENCE = /\n|(?<=[。！？])|(?<=[.!?])\s+/
export const LENGTH_BUDGET = Object.freeze({ brief: 350, other: 900 })
const WIDE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g
// The text's length in English-letter terms: a Chinese character counts twice.
export const answerLength = (text) => { const value = String(text || ''); return value.length + (value.match(WIDE) || []).length }

// Which items an answer names at their quantity (listed, 2026-11-22 and the
// #446 review). In the text, each figure belongs to the SKU written before it
// in its sentence ("23309 (431 short, order 570)"), or to the next one when
// it reads "570 of 23309", after record numbers, dates, amounts, percentages
// and the items' names are set aside. An item counts when the figures that
// belong to it hold its quantity, or a table row of it shows its quantity in
// the reorder list's column (request_quantity, suggested_quantity), and none
// gives it another: a figure after an order word (order, recommend,
// suggest, buy, plan; 建议, 下单, 订, 补) that is not its quantity, its
// quantity set against another ("617 vs 149", "instead of", 而不是), or a
// row or form line of it at another quantity (the solver's optimal_quantity,
// plan_quantity or quantity columns).
const RECORD_TEXT = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3,}\b/g
const MONTH_WORD = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?'
const DATE_TEXT = new RegExp([`\\b\\d{1,2}\\s+${MONTH_WORD}(?:,?\\s+\\d{4})?`, `\\b${MONTH_WORD}\\s+\\d{1,2}(?:,?\\s+\\d{4})?`, '\\b\\d{4}-\\d{2}-\\d{2}\\b', '\\d{4}\\s*年\\s*\\d{1,2}\\s*月(?:\\s*\\d{1,2}\\s*日)?', '\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日', '\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b'].join('|'), 'gi')
const AMOUNT_TEXT = /[£$€¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%/g
const SKU_TEXT = /(?<![\w-])\d{5}[A-Z]{0,2}(?![\w-])/g
const ORDER_BEFORE = /(?:\b(?:order(?:ing)?(?!\s*-?\s*(?:up|by)\b)|recommend(?:ed|s)?|suggest(?:ed|s)?|buy(?:ing)?|plan(?:ned|s)?)\b|建议|下单|(?<!采购)订(?!单)|补(?!货清单))[^\d\n]{0,16}$/i
const AGAINST = /(\d[\d,]*)\s*(?:pcs|units|件|个)?\s*(?:vs\.?|versus|instead of|rather than|对比|而不是)\s*(\d[\d,]*)/gi
const LIST_COLUMNS = new Set(['request_quantity', 'suggested_quantity'])
const OTHER_COLUMNS = new Set(['quantity', 'optimal_quantity', 'plan_quantity', 'planned_quantity', 'order_quantity'])
const blankOut = (text, pattern) => text.replace(pattern, (match) => ' '.repeat(match.length))
function itemsAtQuantity(answer, rows) {
  const wanted = new Map(rows.map((row) => [row.sku, row.quantity]))
  const found = new Map(rows.map((row) => [row.sku, { at: false, other: false }]))
  const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = rows.map((row) => row.name).filter((name) => typeof name === 'string' && name.trim().length >= 3)
  for (const sentence of String(answer.text || '').split(SENTENCE)) {
    let text = [RECORD_TEXT, DATE_TEXT, AMOUNT_TEXT].reduce(blankOut, sentence)
    for (const name of names) text = blankOut(text, new RegExp(escape(name), 'gi'))
    const anchors = [...text.matchAll(SKU_TEXT)].map((match) => ({ sku: match[0], start: match.index, end: match.index + match[0].length }))
    if (!anchors.length) continue
    text = blankOut(text, SKU_TEXT)
    // The SKU written before the figure, or the next one for "570 of 23309"
    // and a figure before any SKU.
    const owner = (start, end) => {
      const before = anchors.filter((anchor) => anchor.end <= start).at(-1)
      const after = anchors.find((anchor) => anchor.start >= end)
      if (after && (!before || /^\s*(?:pcs|units|件|个)?\s*(?:of|for|×|x)\s*$/i.test(text.slice(end, after.start)))) return after.sku
      return (before || after).sku
    }
    for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const sku = owner(match.index, match.index + match[0].length)
      if (!wanted.has(sku)) continue
      const value = Number(match[0].replace(/,/g, ''))
      if (value === wanted.get(sku)) found.get(sku).at = true
      else if (ORDER_BEFORE.test(text.slice(Math.max(0, match.index - 24), match.index))) found.get(sku).other = true
    }
    for (const match of text.matchAll(AGAINST)) {
      const [left, right] = [match[1], match[2]].map((value) => Number(value.replace(/,/g, '')))
      const sku = owner(match.index, match.index + match[0].length)
      if (wanted.has(sku) && left !== right && [left, right].includes(wanted.get(sku))) found.get(sku).other = true
    }
  }
  for (const part of answer.ui || []) {
    const lines = part.component === 'pr_form' ? [...(part.props?.lines || []), ...(part.props?.suggested || [])].map((line) => ({ sku: line.item?.sku, values: [Number(line.suggestedQuantity?.value ?? line.quantity)], list: [] }))
      : part.component === 'table' ? (part.props?.rows || []).map((row) => ({ sku: Object.values(row).map((cell) => (cell && typeof cell === 'object' ? cell.label : cell)).find((value) => wanted.has(String(value))), values: Object.entries(row).filter(([code]) => OTHER_COLUMNS.has(code)).map(([, cell]) => Number(cell)), list: Object.entries(row).filter(([code]) => LIST_COLUMNS.has(code)).map(([, cell]) => Number(cell)) }))
        : []
    for (const line of lines) {
      if (!wanted.has(line.sku)) continue
      if (line.list.includes(wanted.get(line.sku))) found.get(line.sku).at = true
      if ([...line.values, ...line.list].some((value) => Number.isFinite(value) && value !== wanted.get(line.sku))) found.get(line.sku).other = true
    }
  }
  return rows.filter((row) => found.get(row.sku).at && !found.get(row.sku).other)
}

export function scoreAnswer(answer, expect = {}, { language = 'en-US', answers = [answer] } = {}) {
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
  add('clean', answer.status === 200 && !(answer.errors || []).length, `status ${answer.status}${answer.errors?.length ? `, errors ${answer.errors.join(',')}` : ''}`)
  add('language', !answer.text || answerLanguage(answer.text) === language, answer.text ? answerLanguage(answer.text) : 'no text')
  // English only for record names in a Chinese answer, and the chips in the
  // answer's language.
  if (language === 'zh-CN' && answer.text) {
    const run = englishRun(answer.text)
    add('no English prose', !run, run ? `"${run.slice(0, 60)}"` : '')
  }
  const chips = (answer.ui || []).filter((part) => part.component === 'followups').flatMap((part) => part.props?.questions || [])
  if (chips.length) {
    const wrong = chips.filter((chip) => (language === 'zh-CN' ? !hasCjk(chip) : hasCjk(chip)))
    add('chips language', !wrong.length, wrong.join(' | '))
  }
  // Each turn in its language, when the case says so (a switch the user asked for).
  for (const [index, wanted] of (expect.languages || []).entries()) {
    const text = answers[index]?.text
    if (wanted) add(`turn ${index + 1} language`, !text || answerLanguage(text) === wanted, text ? answerLanguage(text) : 'no text')
  }
  // The cards shown, or left out.
  const components = (answer.ui || []).map((part) => part.component)
  for (const component of expect.ui?.has || []) add(`shows ${component}`, components.includes(component), components.join(', ') || 'no cards')
  for (const component of expect.ui?.hasNot || []) add(`no ${component}`, !components.includes(component), components.join(', ') || 'no cards')
  // The form's lines: the SKU, its quantity and whether it is ticked.
  for (const { sku, quantity, checked } of expect.formLines || []) {
    const row = formRows(answer).find((entry) => entry.item?.sku === sku)
    const ok = Boolean(row) && (quantity === undefined || row.suggestedQuantity?.value === quantity) && (checked === undefined || row.checked === checked)
    add(`form line: ${sku}`, ok, row ? `quantity ${row.suggestedQuantity?.value}, ${row.checked ? 'ticked' : 'not ticked'}` : 'not in a form')
  }
  if (expect.formNoneChecked) {
    const ticked = formRows(answer).filter((row) => row.checked).map((row) => row.item?.sku)
    add('no line ticked', !ticked.length, ticked.join(', '))
  }
  if (expect.formRules) {
    const { budget, prices = {}, minimums = {}, onlySkus, notSkus } = expect.formRules
    const ticked = formRows(answer).filter((row) => row.checked).map((row) => ({ sku: row.item?.sku, quantity: Number(row.suggestedQuantity?.value) || 0 }))
    if (budget !== undefined) {
      const spend = Math.round(ticked.reduce((total, row) => total + row.quantity * (prices[row.sku] ?? Infinity), 0) * 100) / 100
      add('form within budget', spend <= budget + 1e-9, `${spend} of ${budget}${ticked.length ? `: ${ticked.map((row) => `${row.sku} x${row.quantity}`).join(', ')}` : ', nothing ticked'}`)
    }
    const below = ticked.filter((row) => minimums[row.sku] && row.quantity < minimums[row.sku])
    add('form at or above minimums', !below.length, below.map((row) => `${row.sku} ${row.quantity} < ${minimums[row.sku]}`).join(', '))
    if (onlySkus) {
      const other = ticked.filter((row) => !onlySkus.includes(row.sku)).map((row) => row.sku)
      add('form only allowed items', !other.length, other.join(', '))
    }
    if (notSkus) {
      const kept = ticked.filter((row) => notSkus.includes(row.sku)).map((row) => row.sku)
      add('form leaves out', !kept.length, kept.join(', '))
    }
  }
  // A form the text says it filled in is shown, on this answer or an earlier
  // turn's (2026-11-11: "I've filled in a purchase request form … with both
  // lines ticked" with no form).
  if (FORM_CLAIM.test(answer.text || '')) {
    const shown = components.includes('pr_form') || answers.slice(0, -1).some((earlier) => (earlier?.ui || []).some((part) => part.component === 'pr_form'))
    add('form it speaks of is shown', shown, shown ? '' : `"${(answer.text.match(FORM_CLAIM) || [''])[0].slice(0, 60)}"`)
  }
  // The records it links (named in its text, or on its cards).
  for (const { type, label } of expect.refs || []) {
    const found = (answer.refs || []).some((ref) => ref.type === type && (!label || String(ref.label || '').toLowerCase().includes(String(label).toLowerCase())))
    add(`links ${type}${label ? ` ${label}` : ''}`, found, (answer.refs || []).map((ref) => `${ref.type}:${ref.label}`).join(', ') || 'no links')
  }
  // Wording the answer must have, and must not.
  // textOnly: the answer's words, not its cards (a card's JSON holds a 0 or a
  // "no" in any row, #421 review).
  for (const entry of expect.matches || []) add(`says: ${entry.label}`, patternOf(entry).test(entry.textOnly ? String(answer.text || '') : flat(answer)), entry.pattern)
  for (const entry of expect.notMatches || []) {
    const found = String(answer.text || '').match(patternOf(entry))
    add(`not: ${entry.label}`, !found, found ? `"${found[0].slice(0, 60)}"` : '')
  }
  // Figures are matched in the answer's words only: a card's props hold every
  // column of every row (design audit 2026-11-15, L5-16: a lead time of 14
  // was "found" in any supplier table). A figure a table must show is a
  // `quantities` check, on the row that names its SKU.
  const numbers = [...numbersIn(answer.text || ''), ...countWordsIn(answer.text)]
  for (const { label, value, anyOf, tolerance = 0, inWords } of expect.numbers || []) {
    // A count the answer may say in words ("none has a difference"), checked
    // on its text only, with the count still checked (#421 review).
    if (inWords) {
      const said = String(answer.text || '').match(patternOf({ pattern: inWords }))
      add(`number: ${label}`, Boolean(said), said ? `said "${said[0].slice(0, 60)}"` : `expected ${value}, in figures or words`)
      continue
    }
    const wanted = anyOf || [value]
    const near = numbers.find((number) => wanted.some((target) => Math.abs(number - target) <= tolerance + 1e-9))
    add(`number: ${label}`, near !== undefined, `expected ${wanted.join(' or ')} ±${tolerance}${near !== undefined ? `, found ${near}` : ''}`)
  }
  // Figures the answer must not give: what a role may not see (L5-18).
  for (const { label, value, tolerance = 0 } of expect.numbersAbsent || []) {
    const near = numbersIn(flat(answer)).find((number) => Math.abs(number - value) <= tolerance + 1e-9)
    add(`no number: ${label}`, near === undefined, near === undefined ? '' : `found ${near}`)
  }
  if (expect.mentions) {
    const text = flat(answer).toLowerCase()
    for (const { label, any } of expect.mentions) add(`mention: ${label}`, any.some((word) => text.includes(String(word).toLowerCase())), any.join(' | '))
  }
  for (const { label, date } of expect.dates || []) {
    const text = flat(answer)
    add(`date: ${label}`, dateForms(date).some((form) => form.test(text)), `expected ${date}`)
  }
  if (expect.refuses) add('refuses', REFUSAL.test(answer.text || ''), answer.text ? 'no refusal in the text' : 'no text')
  if (expect.skus) {
    const text = flat(answer)
    const named = expect.skus.filter((sku) => text.includes(sku))
    add('skus', named.length >= Math.ceil(expect.skus.length * (expect.skuShare ?? 1)), `${named.length}/${expect.skus.length} named`)
  }
  if (expect.quantities) {
    const rows = displayRows(answer)
    const text = answer.text || ''
    // An item is named by its SKU or, when the case gives it, its name (a
    // table of orders shows item names).
    for (const { sku, name, quantity } of expect.quantities.filter((row) => row.quantity > 0)) {
      const names = [sku, name].filter(Boolean)
      const inRow = rows.some((row) => names.some((value) => JSON.stringify(row).includes(value)) && numbersIn(JSON.stringify(row)).includes(quantity))
      const inText = text.split(SENTENCE).some((line) => names.some((value) => line.includes(value)) && numbersIn(line).includes(quantity))
      add(`quantity: ${sku}`, inRow || inText, `expected ${quantity}`)
    }
  }
  if (expect.listed) {
    const named = itemsAtQuantity(answer, expect.listed.rows)
    add('lists items at their quantity', named.length >= expect.listed.atLeast, `${named.length} of ${expect.listed.rows.length}, ${expect.listed.atLeast} wanted${named.length ? `: ${named.slice(0, 8).map((row) => row.sku).join(', ')}` : ''}`)
  }
  if (expect.formAt) {
    const wanted = new Map(expect.formAt.rows.map((row) => [row.sku, row.quantity]))
    const ticked = formRows(answer).filter((row) => row.checked).map((row) => ({ sku: row.item?.sku, value: Number(row.suggestedQuantity?.value ?? row.quantity) }))
    const wrong = ticked.filter((row) => !wanted.has(row.sku) || row.value !== wanted.get(row.sku))
    const form = (answer.ui || []).some((part) => part.component === 'pr_form')
    add('form at their quantities', ticked.length > 0 && !wrong.length, !form ? 'no form' : !ticked.length ? 'no line ticked' : wrong.length ? wrong.map((row) => (wanted.has(row.sku) ? `${row.sku} at ${row.value}, not ${wanted.get(row.sku)}` : `${row.sku} is not due`)).join(', ') : `${ticked.length} ticked, each at its quantity`)
  }
  if (expect.wholeList) {
    const tables = (answer.ui || []).filter((part) => part.component === 'table')
    const linked = tables.some((part) => part.props?.listRoute?.moduleId === expect.wholeList.route)
    const words = patternOf({ pattern: expect.wholeList.words }).test(String(answer.text || ''))
    add('points to the whole list', linked || (words && tables.length > 0), linked ? 'a table links it' : words ? (tables.length ? 'words beside a table' : 'words, no table') : 'no link or words')
  }
  if (expect.firstTurn && answers.length > 1) {
    for (const check of scoreAnswer(answers[0], expect.firstTurn, { language, answers: [answers[0]] }).checks) checks.push({ ...check, name: `turn 1: ${check.name}` })
  }
  // The item on the form at the expected quantity, or (orSaidEarlier) at the
  // quantity an earlier answer gave it, when the user agrees to that answer
  // (2026-11-12: "ok, order it" after a recommendation of the solver's 91
  // cakestands made a form at 91, where the case knew only the reorder list's 60).
  if (expect.form) {
    const form = (answer.ui || []).find((part) => part.component === 'pr_form')
    const row = formRows(answer).find((entry) => entry.item?.sku === expect.form.sku)
    const value = Number(row?.suggestedQuantity?.value ?? row?.quantity)
    const said = Boolean(expect.form.orSaidEarlier && row) && answers.slice(0, -1).some((earlier) => String(earlier?.text || '').split(SENTENCE).some((line) => line.includes(expect.form.sku) && numbersIn(line).includes(value)))
    add('form', Boolean(row) && (value === expect.form.quantity || said), !form ? 'no form' : !row ? `${expect.form.sku} not on the form` : `${expect.form.sku} at ${value}${said ? ', as said earlier' : ''}`)
  }
  // A call counts when it ran: run.mjs keeps failed calls apart (toolErrors).
  for (const tool of expect.calls || []) add(`calls ${tool}`, (answer.tools || []).includes(tool), [(answer.tools || []).join(', ') || 'no tools', (answer.toolErrors || []).length ? `failed: ${answer.toolErrors.join(', ')}` : ''].filter(Boolean).join('; '))
  if (expect.tidy !== false) {
    const problems = tidyProblems(answer.text, answer.textParts)
    add('tidy', !problems.length, problems.join('; '))
  }
  add('no flagged figure', !(answer.flags || []).length, (answer.flags || []).join(' | '))
  if (expect.length !== false) {
    const limit = expect.brief ? LENGTH_BUDGET.brief : LENGTH_BUDGET.other
    const length = answerLength(answer.text)
    checks.push({ name: 'concise', ok: length <= limit, detail: `${length} of ${limit}${expect.brief ? ' (lookup)' : ''}`, soft: true })
  }
  return { pass: checks.every((check) => check.ok || check.soft), checks }
}
