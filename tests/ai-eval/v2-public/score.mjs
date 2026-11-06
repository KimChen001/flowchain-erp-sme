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
//   language    the text is in the language asked in;
//   clean       status 200, no error, and no figure the check flagged.

const CJK = /[㐀-鿿]/g
const LATIN = /[A-Za-z]/g

export function numbersIn(value) {
  const text = String(value ?? '').replace(/(\d),(?=\d{3}\b)/g, '$1')
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite)
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
  for (const { label, value, tolerance = 0 } of expect.numbers || []) {
    const near = numbers.find((number) => Math.abs(number - value) <= tolerance + 1e-9)
    add(`number: ${label}`, near !== undefined, `expected ${value} ±${tolerance}${near !== undefined ? `, found ${near}` : ''}`)
  }
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
  add('no flagged figure', !(answer.flags || []).length, (answer.flags || []).join(' | '))
  return { pass: checks.every((check) => check.ok), checks }
}
