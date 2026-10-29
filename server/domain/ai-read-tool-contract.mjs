// The contract of the model-first assistant's read tools
// (docs/ai-model-first-design.md §3–§4, approved by the owner on 2026-10-28).
//
// A tool has a name, an English description for the model, a JSON schema for
// its arguments (no unknown fields), a check of whether the asking user may
// use it, and a run function over that user's facts (ai-skill-readers.mjs),
// which are already masked to what the user may read. It returns plain JSON:
// at most a capped number of rows, the total and how many more there are, and
// a ref ({ type, id, label }) for every record it names, so the grounding
// check and the record links can use them. A tool never writes, never calls a
// model and never reads outside the user's facts.

export const AI_TOOL_LIMITS = Object.freeze({ rows: 20, maxRows: 50, text: 200, items: 10 })

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])

// `available(facts, context)` says whether the asking user may use the tool;
// `run(args, { facts, context })` reads and returns plain JSON.
export function defineAiTool({ name, description, parameters = {}, required = [], available = () => true, run }) {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) throw new Error(`Invalid tool name ${name}`)
  return Object.freeze({
    name,
    description,
    schema: Object.freeze({ type: 'object', properties: parameters, required, additionalProperties: false }),
    available,
    run,
  })
}

// The arguments the model sent, checked against the tool's schema: only the
// schema's fields, of their types, within their limits. Returns
// { ok: true, args } or { ok: false, errors }.
export function validateAiToolArgs(schema, input) {
  const args = input === null || input === undefined ? {} : input
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, errors: ['arguments must be an object'] }
  const errors = []
  for (const key of Object.keys(args)) if (!schema.properties[key]) errors.push(`unknown argument ${key}`)
  for (const key of schema.required) if (args[key] === undefined || args[key] === null || args[key] === '') errors.push(`missing argument ${key}`)
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    const problem = checkValue(value, rule)
    if (problem) errors.push(`${key} ${problem}`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, args }
}

function checkValue(value, rule) {
  if (rule.enum && !rule.enum.includes(value)) return `must be one of ${rule.enum.join(', ')}`
  if (rule.type === 'string') {
    if (typeof value !== 'string') return 'must be a string'
    if (value.length > (rule.maxLength ?? AI_TOOL_LIMITS.text)) return 'is too long'
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return 'has the wrong format'
  }
  if (rule.type === 'integer' || rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))) return `must be ${rule.type === 'integer' ? 'a whole number' : 'a number'}`
    if (rule.minimum !== undefined && value < rule.minimum) return `must be at least ${rule.minimum}`
    if (rule.maximum !== undefined && value > rule.maximum) return `must be at most ${rule.maximum}`
  }
  if (rule.type === 'boolean' && typeof value !== 'boolean') return 'must be true or false'
  if (rule.type === 'array') {
    if (!Array.isArray(value)) return 'must be a list'
    if (value.length > (rule.maxItems ?? AI_TOOL_LIMITS.items)) return 'has too many items'
    for (const item of value) {
      const problem = checkValue(item, rule.items || {})
      if (problem) return `item ${problem}`
    }
  }
  return null
}

// A capped list: the first `limit` rows (AI_TOOL_LIMITS.rows by default), the
// total and how many were left out.
export function aiToolList(rows, limit) {
  const all = array(rows)
  const size = Math.min(AI_TOOL_LIMITS.maxRows, Math.max(1, Number(limit) || AI_TOOL_LIMITS.rows))
  return { rows: all.slice(0, size), total: all.length, more: Math.max(0, all.length - size) }
}

// The record a row names: its type, id and label, for links and grounding.
export const aiToolRef = (type, id, label) => ({ type, id: text(id), label: text(label) || text(id) })

const fold = (value) => text(value).toLowerCase().replace(/\s+/g, ' ')

// A supplier the model named, among the suppliers the user may read: by id or
// code, then by name, then by a name containing the words. Returns
// { supplier } or { error, candidates } (at most 5 names).
export function aiToolSupplier(facts, query) {
  const suppliers = array(facts?.suppliers)
  const wanted = fold(query)
  if (!wanted) return { error: 'supplier_missing' }
  const exact = suppliers.find((row) => [row.id, row.code].some((value) => fold(value) === wanted)) || suppliers.find((row) => fold(row.name) === wanted)
  if (exact) return { supplier: exact }
  const partial = suppliers.filter((row) => fold(row.name).includes(wanted))
  if (partial.length === 1) return { supplier: partial[0] }
  return { error: partial.length ? 'supplier_ambiguous' : 'supplier_not_found', candidates: partial.slice(0, 5).map((row) => row.name) }
}

// A purchase order the model named, by id or order number, or by the number's
// end ("PO-020" for ACME-PO-020) when only one order ends that way.
export function aiToolPurchaseOrder(facts, query) {
  const index = array(facts?.purchaseOrders?.index)
  const wanted = fold(query)
  if (!wanted) return null
  const exact = index.find((row) => fold(row.id) === wanted || fold(row.orderNumber) === wanted)
  if (exact) return exact
  const ending = index.filter((row) => fold(row.orderNumber).endsWith(`-${wanted}`) || fold(row.orderNumber).endsWith(wanted))
  return ending.length === 1 ? ending[0] : null
}
