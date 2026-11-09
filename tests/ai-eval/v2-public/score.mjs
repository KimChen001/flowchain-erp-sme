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
//
// A number may list anyOf: values, any one of which passes.

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

export function scoreAnswer(answer, expect = {}, { language = 'en-US' } = {}) {
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
  add('clean', answer.status === 200 && !(answer.errors || []).length, `status ${answer.status}${answer.errors?.length ? `, errors ${answer.errors.join(',')}` : ''}`)
  add('language', !answer.text || answerLanguage(answer.text) === language, answer.text ? answerLanguage(answer.text) : 'no text')
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
  if (expect.form) {
    const form = (answer.ui || []).find((part) => part.component === 'pr_form')
    const lines = JSON.stringify(form?.props || {})
    add('form', Boolean(form) && lines.includes(expect.form.sku) && numbersIn(lines).includes(expect.form.quantity), form ? 'form shown' : 'no form')
  }
  if (expect.tidy !== false) {
    const problems = tidyProblems(answer.text, answer.textParts)
    add('tidy', !problems.length, problems.join('; '))
  }
  add('no flagged figure', !(answer.flags || []).length, (answer.flags || []).join(' | '))
  return { pass: checks.every((check) => check.ok), checks }
}
