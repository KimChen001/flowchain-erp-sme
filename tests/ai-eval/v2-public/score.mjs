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
  return problems
}

export function answerLanguage(text) {
  const cjk = (String(text).match(CJK) || []).length
  const latin = (String(text).match(LATIN) || []).length
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

export const LENGTH_BUDGET = Object.freeze({ brief: 350, other: 900 })
const WIDE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g
// The text's length in English-letter terms: a Chinese character counts twice.
export const answerLength = (text) => { const value = String(text || ''); return value.length + (value.match(WIDE) || []).length }

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
  for (const entry of expect.matches || []) add(`says: ${entry.label}`, patternOf(entry).test(flat(answer)), entry.pattern)
  for (const entry of expect.notMatches || []) {
    const found = String(answer.text || '').match(patternOf(entry))
    add(`not: ${entry.label}`, !found, found ? `"${found[0].slice(0, 60)}"` : '')
  }
  const numbers = numbersIn(flat(answer))
  for (const { label, value, anyOf, tolerance = 0 } of expect.numbers || []) {
    const wanted = anyOf || [value]
    const near = numbers.find((number) => wanted.some((target) => Math.abs(number - target) <= tolerance + 1e-9))
    add(`number: ${label}`, near !== undefined, `expected ${wanted.join(' or ')} ±${tolerance}${near !== undefined ? `, found ${near}` : ''}`)
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
    for (const { sku, quantity } of expect.quantities.filter((row) => row.quantity > 0)) {
      const inRow = rows.some((row) => JSON.stringify(row).includes(sku) && numbersIn(JSON.stringify(row)).includes(quantity))
      const inText = text.split(/\n|(?<=[.;。；])/).some((line) => line.includes(sku) && numbersIn(line).includes(quantity))
      add(`quantity: ${sku}`, inRow || inText, `expected ${quantity}`)
    }
  }
  // The item on the form at the expected quantity, or (orSaidEarlier) at the
  // quantity an earlier answer gave it, when the user agrees to that answer
  // (2026-11-12: "ok, order it" after a recommendation of the solver's 91
  // cakestands made a form at 91, where the case knew only the reorder list's 60).
  if (expect.form) {
    const form = (answer.ui || []).find((part) => part.component === 'pr_form')
    const row = formRows(answer).find((entry) => entry.item?.sku === expect.form.sku)
    const value = Number(row?.suggestedQuantity?.value ?? row?.quantity)
    const said = Boolean(expect.form.orSaidEarlier && row) && answers.slice(0, -1).some((earlier) => String(earlier?.text || '').split(/\n|(?<=[.;。；])/).some((line) => line.includes(expect.form.sku) && numbersIn(line).includes(value)))
    add('form', Boolean(row) && (value === expect.form.quantity || said), !form ? 'no form' : !row ? `${expect.form.sku} not on the form` : `${expect.form.sku} at ${value}${said ? ', as said earlier' : ''}`)
  }
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
