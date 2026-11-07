import { CHART_KINDS, CHOICE_PROMPTS, NEW_SUPPLIER_LINK, RECORD_ACTION_TYPES, RECORD_EMPHASES, SETUP_FORM_ROWS, SETUP_STEP_IDS, refSchema, safeParsePartProps } from '../../shared/assistant-protocol.mjs'
import { RECORD_ACTION_RULES, recordActionsNow } from '../../shared/assistant-record-actions.mjs'
import { PURCHASE_SUGGESTION_SOURCES, suggestNeedByDate } from '../../shared/purchase-suggestion.mjs'
import { can } from '../auth/authorization-service.mjs'
import { mapPurchaseRequest } from '../repositories/db-procurement-read-repository.mjs'
import { PURCHASE_REQUEST_PERMISSIONS } from '../services/procurement-request-command-service.mjs'
import { PURCHASE_ORDER_COMMANDS } from './procurement-db-command-service.mjs'
import { PROCUREMENT_PATH_POLICY, PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS, RFQ_STATUS, recommendProcurementPath } from './procurement-workflow.mjs'
import { AI_READ_TOOL_COLUMNS } from './ai-read-tool-runner.mjs'
import { aiSkillVisibility } from './ai-skill-registry.mjs'
import { aiSkillUnitLabel } from './ai-skill-copy.mjs'
import { findPaymentTerm } from './standard-payment-terms.mjs'

// The UI tools of assistant v2 (docs/ai-assistant-v2-design.md §3.6, §4, §4.1,
// §5.2). The model never writes a figure: it names a data tool result of this
// answer (its source) and the columns, refs or keys to show, and the server
// builds the part's props from that result's rows. A column must be one the
// data tool declares (AI_READ_TOOL_COLUMNS), a ref must be in the result, and
// the props must pass the stream protocol, or the model gets an error in
// English to correct its call.
//
// A source is the handle the loop puts on each data result the model reads
// ("list_purchase_orders#1": the tool and its count in this answer). Models
// on chat completions providers name a call by its tool, not by the call id
// (measured 2026-11-02 on Sonnet 5.5 and GPT-5.5), so the tool's name alone
// (its latest result; "functions." in front is ignored) and the tool_use id
// are taken too.
//
// build(input, ctx) with ctx = { results: Map<toolUseId, { tool, output }>,
// facts, actor, language, threadId, messageId, partId, userNamedSkus,
// userText, prisma, tenantId, workspaceCurrency } returns (or resolves to)
// { component, props, refs } or { error: { code, message } }. `output` is the
// data tool's result as the model read it. The display tools (display: true)
// are the ones the loop withdraws after repeated failures.
//
// One UI tool takes values from the user rather than from a result: the setup
// card (suggest_setup_records) shows the suppliers and items the user typed or
// pasted. Each value must be in the user's own words of this conversation
// (userText); the server reads the workspace's records for duplicates and
// marks what is wrong with each row, and nothing is created until the user
// clicks Create in the card. The request form takes the same check for the
// price, currency and lead time of a supplier the user named that the item
// has not approved yet, which the form adds when the user clicks Create.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
// A number as recorded: several services return decimals as strings ("4.2000").
const numberOf = (value) => (isNumber(value) ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null)
// A calendar day, or a timestamp on one; 2026-02-30 is not a day.
function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return false
  const time = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10)
}
const isCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
const currencyCode = (value) => (typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null)
const at = (value, path) => (path ? path.split('.').reduce((entry, key) => (entry === null || entry === undefined ? undefined : entry[key]), value) : value)
const missing = (value) => value === null || value === undefined
// A dated signal ({ kind, days, date }, as supplier_risks returns it) reads as its day.
const isWhen = (value) => isObject(value) && typeof value.kind === 'string' && 'date' in value && !('ref' in value)
const valueAt = (row, key) => {
  const value = at(row, key)
  return isWhen(value) ? value.date ?? null : value
}
const fail = (code, message) => ({ error: { code, message } })
const MAX_TEXT = 200
const TABLE_ROWS = 20
const CHART_POINTS = 60

// The input schemas the model sees double as the first check of its input.
// Only the keywords used below are understood.
function invalidInput(schema, value, path = 'input') {
  if (schema.type === 'object') {
    if (!isObject(value)) return `${path} must be an object`
    for (const key of Object.keys(value)) if (!schema.properties[key]) return `${path} has an unknown field ${key}`
    for (const key of schema.required || []) if (value[key] === undefined || value[key] === null) return `${path}.${key} is required`
    for (const [key, rule] of Object.entries(schema.properties)) {
      if (value[key] === undefined || value[key] === null) continue
      const problem = invalidInput(rule, value[key], `${path}.${key}`)
      if (problem) return problem
    }
    return null
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be a list`
    if (value.length < (schema.minItems ?? 0) || value.length > schema.maxItems) return `${path} takes ${schema.minItems ?? 0} to ${schema.maxItems} entries`
    for (const [index, entry] of value.entries()) {
      const problem = invalidInput(schema.items, entry, `${path}[${index}]`)
      if (problem) return problem
    }
    return null
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`
    if (value.length < (schema.minLength ?? 0) || value.length > schema.maxLength) return `${path} must be ${schema.minLength ?? 0} to ${schema.maxLength} characters`
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has the wrong format`
    return null
  }
  if (!isNumber(value) || (schema.type === 'integer' && !Number.isInteger(value))) return `${path} must be ${schema.type === 'integer' ? 'a whole number' : 'a number'}`
  if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return `${path} must be between ${schema.minimum} and ${schema.maximum}`
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${path} must be above ${schema.exclusiveMinimum}`
  return null
}

const sourceParam = { type: 'string', minLength: 1, maxLength: 120, description: 'The source of a data tool result of this answer, exactly as the result gives it, for example list_purchase_orders#1.' }
// A ref as the result gives it; the label is the result's, so the model's is not used.
const refParam = { type: 'object', properties: { type: { type: 'string', minLength: 1, maxLength: 40 }, id: { type: 'string', minLength: 1, maxLength: 120 }, label: { type: 'string', maxLength: 200 } }, required: ['type', 'id'], additionalProperties: false }
const titleParam = { type: 'string', minLength: 1, maxLength: 120, description: 'A short heading in the answer\'s language.' }
const listParam = { type: 'string', minLength: 1, maxLength: 64, description: 'Which list of the result when it has several (for example months or suppliers of spend_analysis). By default the first list that has every column.' }

// Each data result of this answer by its handle, in the order the results
// came: the nth result of a tool is "<tool>#n".
export function aiUiSourceHandles(results) {
  const handles = new Map()
  const counts = new Map()
  for (const [id, entry] of results instanceof Map ? results : []) {
    if (!AI_READ_TOOL_COLUMNS[entry?.tool]) continue
    counts.set(entry.tool, (counts.get(entry.tool) || 0) + 1)
    handles.set(id, `${entry.tool}#${counts.get(entry.tool)}`)
  }
  return handles
}

// The data tool result a UI tool names: one of this answer's, by its handle,
// its tool_use id or its tool's name (the latest result of that tool). The
// part's source is the call it resolved to (its tool_use id), which also
// stands for it in a form's suggestion trail; a handle is numbered per answer.
function sourceOf(ctx, reference) {
  const results = ctx?.results instanceof Map ? ctx.results : new Map()
  const handles = aiUiSourceHandles(results)
  const name = text(reference).replace(/^functions\./, '')
  let id = results.has(reference) ? reference : [...handles].find(([, handle]) => handle === name)?.[0]
  if (id === undefined) id = [...results].filter(([, entry]) => entry?.tool === name).at(-1)?.[0]
  const entry = id === undefined ? undefined : results.get(id)
  if (!entry) {
    const known = [...handles.values()]
    return fail('source_missing', known.length
      ? `No data result of this answer is called ${reference}. Pass source exactly as a result gives it: ${known.join(', ')}.`
      : 'No data tool has returned a result in this answer yet. Call a data tool first, then pass the source its result gives.')
  }
  const label = handles.get(id) || reference
  if (!AI_READ_TOOL_COLUMNS[entry.tool]) return fail('source_not_data', `${reference} is a ${entry.tool} call; source must be a data tool result.`)
  if (!isObject(entry.output) || entry.output.error) return fail('source_failed', `The ${entry.tool} result ${label} has nothing to show.`)
  return { id, tool: entry.tool, output: entry.output }
}

// A column's code in the parts: the client's existing label where one fits,
// otherwise the result key in snake case ("inFull.percent" -> in_full_percent).
const CODE_ALIASES = Object.freeze({
  orderNumber: 'order', overdueDays: 'days_overdue', remaining: 'remaining_quantity', itemName: 'item', request: 'purchase_request',
  incomingOnPurchaseOrders: 'incoming', availableToPromise: 'atp', withoutTheseLines: 'atp_without_late', sharePercent: 'share', spendClass: 'abc_class',
  'onTime.percent': 'on_time_rate', 'item.sku': 'sku', 'item.name': 'item', 'item.unit': 'unit', 'suggestedQuantity.value': 'suggested_quantity',
  'suggestedQuantity.source': 'suggested_quantity_source', 'supplier.name': 'supplier', 'needByDate.value': 'need_by_date', 'estimatedUnitPrice.value': 'unit_price',
  'estimatedUnitPrice.currency': 'currency', '1_30': 'days_1_30', '31_60': 'days_31_60', '61_90': 'days_61_90', '90_plus': 'days_90_plus',
  'purchaseOrders.open': 'open_purchase_orders', 'purchaseOrders.overdue': 'overdue_purchase_orders', 'purchaseOrders.waitingForApproval': 'pending_approvals',
  'details.sku': 'sku', 'details.remaining': 'remaining_quantity', 'details.unit': 'unit', 'details.available': 'available', 'details.demand': 'demand',
  'details.shortage': 'shortage', 'details.incoming': 'incoming', 'details.safety': 'safety_stock', 'details.reorder': 'reorder_point', 'details.pendingRequests': 'open_requests',
  'details.covered': 'covered', 'details.variance': 'variance', 'details.currency': 'currency', 'details.rejected': 'rejected', 'details.quantity': 'quantity',
  'details.priority': 'priority', 'details.requiredDate': 'required_date', 'details.responses': 'quotes', 'details.title': 'title', 'details.count': 'count', referencePrice: 'unit_price', leadTimeDays: 'lead_time_days',
})

const snakeCase = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\./g, '_').toLowerCase()

export function aiUiColumnCode(key) {
  return CODE_ALIASES[key] || snakeCase(key)
}

// Amounts, with the currency beside them in the row or, failing that, on the
// result: the keys that name an amount in every tool (get_purchase_order's
// order and supplier_risks rows carry them too), and the keys that are
// amounts in one tool only. Spend counted in orders (no permission to see
// prices) is a count.
const MONEY_KEYS = new Set(['amount', 'outstandingAmount', 'paidAmount', 'originalAmount', 'totalValue', 'difference', 'variance', 'unitPrice'])
const MONEY_COLUMNS = Object.freeze({
  spend_analysis: ['value'],
  list_receivables: ['current', '1_30', '31_60', '61_90', '90_plus', 'total'],
  suggest_purchase_lines: ['estimatedUnitPrice.value'],
  optimize_order_plan: ['spend', 'holdingCost', 'shortageCost', 'expectedCost', 'costAboveOptimal', 'orderValue', 'minimumOrderValue', 'overBudgetAmount'],
  attention_list: ['details.variance'],
  item_suppliers: ['referencePrice'],
})
const QUANTITY_COLUMNS = new Set([
  'ordered', 'received', 'remaining', 'onHand', 'reserved', 'available', 'openSalesDemand', 'incomingOnPurchaseOrders', 'availableToPromise', 'shortage',
  'safetyStock', 'reorderPoint', 'incoming', 'demand', 'endAvailable', 'quantity', 'rejected', 'stillToReceive', 'withoutTheseLines', 'additionalShortfall',
  'position', 'shortfall', 'minimumOrderQuantity', 'requestQuantity', 'orderedQuantity', 'averageDailyDemand', 'suggestedQuantity.value',
  'expectedDemand', 'optimalQuantity', 'reorderListQuantity', 'planQuantity', 'openRequests',
  'details.remaining', 'details.available', 'details.demand', 'details.shortage', 'details.incoming', 'details.safety', 'details.reorder', 'details.covered', 'details.rejected', 'details.quantity',
])
// A signal or record type (po_overdue, purchase_order) and a priority (high)
// are codes too: the panel words them, never showing the code (2026-11-05).
const STATUS_COLUMNS = new Set(['status', 'postingStatus', 'matchStatus', 'state', 'disputeStatus', 'severity', 'whenKind', 'suggestedQuantity.source', 'type', 'priority', 'details.priority', 'plan', 'reason'])
// Codes that name a kind of thing rather than a state (an order plan, why an
// item gets its quantity): worded, never coloured.
const NEUTRAL_CODE_COLUMNS = new Set(['type', 'plan', 'reason'])
const PRIORITY_TONES = Object.freeze({ urgent: 'danger', high: 'warning', medium: 'info', normal: 'neutral', low: 'neutral' })
// Closed records are late no more: their days overdue are not shown.
const CLOSED_STATES = new Set(['cancelled', 'canceled', 'closed', 'fully_received', 'received', 'completed', 'rejected'])
const NUMERIC_KINDS = Object.freeze({ number: 'count', quantity: 'quantity', money: 'money', percent: 'percent', days: 'days' })

const isMoneyColumn = (tool, key, output) => (MONEY_KEYS.has(key) || Boolean(MONEY_COLUMNS[tool]?.includes(key))) && !(tool === 'spend_analysis' && output.amounts === false)
const currencyBeside = (row, key, output) => currencyCode(at(row, key.includes('.') ? key.replace(/[^.]+$/, 'currency') : 'currency')) || currencyCode(output.currency)

function columnKind(tool, key, values, output) {
  if (isMoneyColumn(tool, key, output)) return 'money'
  if (/percent$/i.test(key)) return 'percent'
  if (key === 'days' || key === 'daysUntilOrderBy' || /Days$/.test(key)) return 'days'
  if (QUANTITY_COLUMNS.has(key)) return 'quantity'
  if (STATUS_COLUMNS.has(key)) return 'status'
  const present = values.filter((value) => !missing(value))
  if (!present.length) return 'text'
  if (present.every((value) => typeof value === 'boolean')) return 'status'
  if (present.every(isDay)) return 'date'
  if (present.every(isNumber)) return 'number'
  return 'text'
}

const refOf = (value) => {
  const parsed = isObject(value) ? refSchema.safeParse({ type: value.type, id: value.id, label: value.label }) : { success: false }
  return parsed.success ? parsed.data : null
}

// One table cell from a row value, as recorded: a missing or role-hidden value
// is null, an amount keeps its own currency, a record's code becomes its ref.
// undefined: an amount whose currency is not known, which is never shown bare.
const NUMBER_KINDS = new Set(['number', 'quantity', 'percent', 'days'])
function cellOf(kind, row, key, output) {
  const value = valueAt(row, key)
  if (kind === 'money') {
    const amount = numberOf(value)
    const currency = currencyBeside(row, key, output)
    if (!currency) return amount === null ? null : undefined
    return { amount, currency }
  }
  if (missing(value)) return null
  if (NUMBER_KINDS.has(kind) && numberOf(value) !== null) return numberOf(value)
  if (typeof value === 'boolean') return { code: value ? 'yes' : 'no', tone: 'neutral' }
  if (Array.isArray(value)) return value.every((entry) => typeof entry === 'string' || isNumber(entry)) ? value.join(', ').slice(0, MAX_TEXT) : null
  if (isObject(value)) return refOf(value) || (typeof value.name === 'string' ? value.name.slice(0, MAX_TEXT) : null)
  if (kind === 'status' && isCode(value) && NEUTRAL_CODE_COLUMNS.has(key)) return { code: value, tone: 'neutral' }
  if (kind === 'status' && isCode(value) && (key === 'priority' || key === 'details.priority')) return { code: value, ...(PRIORITY_TONES[value] ? { tone: PRIORITY_TONES[value] } : {}) }
  if (kind === 'status' && isCode(value)) return { code: value }
  if (kind === 'date') return value.slice(0, 10)
  if (typeof value === 'string') {
    const ref = refOf(row.ref)
    return ref && value === ref.label ? ref : value.slice(0, MAX_TEXT)
  }
  return value
}

const declaredOf = (tool) => Object.entries(AI_READ_TOOL_COLUMNS[tool])
// The model may name a column by its result key, its part code or the key in snake case.
// The model reads a display string and a label beside some values
// (dueDateText, statusLabel): naming one means the value's own column
// (2026-11-05: show_table failed twice on amountText and statusLabel).
const baseName = (name) => name.replace(/(?:Text|Label|_text|_label)$/, '')
const keyIn = (keys, name) => {
  const match = (wanted) => keys.find((key) => key === wanted || aiUiColumnCode(key) === wanted || snakeCase(key) === wanted)
  return match(name) || (baseName(name) !== name && baseName(name) ? match(baseName(name)) : undefined)
}
const describeColumns = (tool) => declaredOf(tool).map(([path, keys]) => `${path || 'result'}: ${keys.join(', ')}`).join('; ')

// The columns show_table takes from a data tool's result, by list, as the
// model reads them beside the result: the table's first call no longer
// guesses a column (2026-11-04: show_table failed with unknown_column on its
// first try in most answers, and the retry cost a round). Null for a tool
// that declares none.
export function aiUiTableColumns(tool) {
  if (!AI_READ_TOOL_COLUMNS[tool]) return null
  return Object.fromEntries(declaredOf(tool).map(([path, keys]) => [path || 'result', keys.map(aiUiColumnCode)]))
}

// The list of the result the columns come from, and their keys there. A list
// the result does not hold (spend_analysis for one supplier has items only)
// is never read as empty: the lists it holds are tried first, and the model is
// told which they are.
function resolveColumns(tool, names, list, output) {
  const declared = declaredOf(tool)
  if (list !== undefined && list !== null && !declared.some(([path]) => path === list)) return fail('unknown_list', `${tool} has no list ${list}. Its columns: ${describeColumns(tool)}.`)
  const held = (path) => !path || Array.isArray(at(output, path))
  const candidates = list ? declared.filter(([path]) => path === list) : declared
  let absent = null
  for (const [path, keys] of [...candidates.filter(([path]) => held(path)), ...candidates.filter(([path]) => !held(path))]) {
    const found = names.map((name) => keyIn(keys, name))
    if (!found.every(Boolean)) continue
    if (held(path)) return { path, keys: [...new Set(found)] }
    absent ??= path
  }
  if (absent) {
    const lists = declared.map(([path]) => path).filter((path) => path && held(path))
    return fail('list_missing', `This ${tool} result has no list ${absent}${lists.length ? `; it holds ${lists.join(', ')}. Pass list to name one` : ''}.`)
  }
  const unknown = names.filter((name) => !candidates.some(([, keys]) => keyIn(keys, name)))
  return fail('unknown_column', unknown.length
    ? `${tool} has no column ${unknown.join(', ')}. Its columns: ${describeColumns(tool)}.`
    : `The columns ${names.join(', ')} are not all in one list of ${tool}. Its columns: ${describeColumns(tool)}.`)
}

const rowsAt = (output, path) => (path ? array(at(output, path)).filter(isObject) : [output])

// Every object in a result that names a record, by its ref, first one kept.
function refHolders(output) {
  const holders = new Map()
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (!isObject(value)) return
    const ref = refOf(value.ref)
    if (ref && !holders.has(`${ref.type}:${ref.id}`)) holders.set(`${ref.type}:${ref.id}`, { ref, row: value })
    for (const [key, entry] of Object.entries(value)) if (key !== 'ref') walk(entry)
  }
  walk(output)
  return holders
}

function pickRefs(source, wanted, sourceId) {
  const holders = refHolders(source.output)
  const picked = []
  for (const ref of wanted) {
    const holder = holders.get(`${ref.type}:${ref.id}`)
    if (!holder) return fail('foreign_ref', `${ref.type} ${ref.id} is not in the result of ${sourceId}. Use refs from that result.`)
    if (!picked.includes(holder)) picked.push(holder)
  }
  return { picked }
}

function uniqueRefs(refs) {
  const seen = new Set()
  return refs.filter((ref) => ref && !seen.has(`${ref.type}:${ref.id}`) && seen.add(`${ref.type}:${ref.id}`)).slice(0, 60)
}

// The part as the stream sends it, once the protocol accepts its props.
function part(component, props, refs) {
  const parsed = safeParsePartProps(component, props)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    return fail('invalid_props', `The ${component} part could not be built from this source (${issue.path.join('.') || 'props'}: ${issue.message}).`)
  }
  return { component, props: parsed.data, refs: uniqueRefs(refs) }
}

// available(actor): whether the tool is offered to this user at all; build
// checks again, so a tool offered by mistake still refuses. display: the tool
// shows a result as a table, cards, a chart, tiles or choices.
const defineUiTool = ({ name, description, inputSchema, available = () => true, display = false, build }) => Object.freeze({
  name,
  kind: 'ui',
  description,
  inputSchema: Object.freeze(inputSchema),
  available,
  display,
  build(input, ctx) {
    const problem = invalidInput(inputSchema, input)
    return problem ? fail('invalid_input', `${problem}.`) : build(input, ctx)
  },
})

const compare = (left, right) => (numberOf(left) !== null && numberOf(right) !== null ? numberOf(left) - numberOf(right) : String(left).localeCompare(String(right), 'en', { numeric: true }))

const showTable = defineUiTool({
  name: 'show_table',
  display: true,
  description: 'Show rows of a data tool result as a table. Name the result (source) and 1 to 8 of its columns, as the result\'s keys; the server fills every cell from the result. Optional title, sort and limit (20 rows by default).',
  inputSchema: {
    type: 'object',
    properties: {
      source: sourceParam,
      columns: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Column keys of the source rows.' },
      list: listParam,
      title: titleParam,
      sort: { type: 'object', properties: { column: { type: 'string', minLength: 1, maxLength: 64 }, direction: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'], additionalProperties: false, description: 'Sort by one column; the result\'s order by default.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many rows, 20 by default.' },
    },
    required: ['source', 'columns'],
    additionalProperties: false,
  },
  build(input, ctx) {
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    const { tool, output } = source
    const table = resolveColumns(tool, input.sort ? [...input.columns, input.sort.column] : input.columns, input.list, output)
    if (table.error) return table
    let rows = rowsAt(output, table.path)
    if (input.sort) {
      const key = keyIn(table.keys, input.sort.column)
      const direction = input.sort.direction === 'desc' ? -1 : 1
      // Missing values go last whichever way the column sorts.
      rows = [...rows].sort((left, right) => {
        const [a, b] = [valueAt(left, key), valueAt(right, key)]
        return missing(a) || missing(b) ? Number(missing(a)) - Number(missing(b)) : compare(a, b) * direction
      })
    }
    const shown = rows.slice(0, input.limit ?? TABLE_ROWS)
    let keys = [...new Set(input.columns.map((name) => keyIn(table.keys, name)))]
    // A table of records leads with the record: when the model left its
    // column out (2026-11-04: an overdue list without its order numbers), the
    // list's first column, the one that names the record, comes first.
    const listKeys = declaredOf(tool).find(([path]) => (path || '') === (table.path || ''))?.[1] || []
    const namesRecord = (key) => shown.some((row) => {
      if (!isObject(row?.ref)) return false
      const value = valueAt(row, key)
      return isObject(value) ? value.id === row.ref.id : [row.ref.label, row.ref.id].includes(value)
    })
    if (listKeys[0] && !keys.includes(listKeys[0]) && !keys.some(namesRecord) && namesRecord(listKeys[0])) keys = [listKeys[0], ...keys].slice(0, 8)
    const columns = []
    const cells = shown.map(() => ({}))
    for (const key of keys) {
      const kind = columnKind(tool, key, shown.map((row) => valueAt(row, key)), output)
      const code = aiUiColumnCode(key)
      for (const [index, row] of shown.entries()) {
        let cell = cellOf(kind, row, key, output)
        if (cell === undefined) return fail('currency_missing', `${key} in ${input.source} has an amount without a currency; it cannot be shown.`)
        // Days overdue only on a record that is late: none on time, none on a
        // cancelled or received one (2026-11-05: "0 days" on every row).
        if (key === 'overdueDays' && (!(numberOf(cell) > 0) || row.open === false || CLOSED_STATES.has(text(row.status)))) cell = null
        cells[index][code] = cell
      }
      const isRefColumn = kind === 'text' && cells.some((row) => refOf(row[code]))
      columns.push({ code, kind: isRefColumn ? 'ref' : kind })
    }
    // A quantity carries its unit in its own cell ("7,000 pcs"): the row's
    // unit goes beside the cells as unit (moq_unit for a minimum order
    // quantity), worded in the answer's language ("300 boxes", "300 箱";
    // unit_one for a quantity of 1), and a column of units alone is not shown.
    if (columns.some((column) => column.kind === 'quantity')) {
      const worded = (cell, code, unit) => {
        const many = aiSkillUnitLabel(unit, ctx?.language, 2)
        const one = aiSkillUnitLabel(unit, ctx?.language, 1)
        cell[code] = many
        if (one !== many) cell[`${code}_one`] = one
      }
      for (const [index, row] of shown.entries()) {
        const unit = [row.unit, row.item?.unit, row.details?.unit].find((entry) => typeof entry === 'string' && entry.trim() && entry.length <= 20)
        if (unit) worded(cells[index], 'unit', unit.trim())
        if (typeof row.moqUnit === 'string' && row.moqUnit.trim() && row.moqUnit.length <= 20) worded(cells[index], 'moq_unit', row.moqUnit.trim())
      }
      for (const code of ['unit', 'moq_unit']) {
        const at = columns.findIndex((column) => column.code === code && column.kind === 'text')
        if (at >= 0 && columns.length > 1) columns.splice(at, 1)
      }
    }
    // A list cut by the data tool says how many it had in all.
    const total = Math.max(rows.length, table.path === 'rows' && Number.isInteger(output.total) ? output.total : 0)
    const props = { ...(input.title ? { title: input.title } : {}), source: source.id, columns, rows: cells, total, more: total > shown.length }
    return part('table', props, [...shown.map((row) => refOf(row.ref)), ...cells.flatMap((row) => Object.values(row).map(refOf))])
  },
})

// A record's date as the cards say it: days overdue, due or waiting, or the day.
const CARD_DATES = ['dueDate', 'promisedDate', 'requiredDate', 'due', 'date', 'needByDate.value', 'orderByDate', 'invoiceDate', 'arrived', 'endDate', 'when.date']
const WHEN_KINDS = Object.freeze({ overdue: 'overdue', due: 'due', waiting: 'waiting', open: 'waiting' })
function cardDate(row) {
  if (isNumber(row.overdueDays) && row.overdueDays > 0) return { kind: 'overdue', days: Math.round(row.overdueDays) }
  // attention_list flattens the signal's when; supplier_risks keeps it whole.
  const [whenKind, days] = isWhen(row.when) ? [row.when.kind, row.when.days] : [row.whenKind, row.days]
  if (WHEN_KINDS[whenKind] && Number.isInteger(days) && days >= 0) return { kind: WHEN_KINDS[whenKind], days }
  const day = CARD_DATES.map((key) => at(row, key)).find(isDay)
  return day ? { kind: 'on', value: day.slice(0, 10) } : undefined
}

const CARD_TITLES = ['title', 'itemName', 'name', 'label', 'item.name', 'customer', 'customerName', 'supplier']
const CARD_STATUSES = ['status', 'postingStatus', 'matchStatus', 'state']
const CARD_FIGURES = [
  'remaining', 'shortage', 'available', 'onHand', 'suggestedQuantity.value', 'quantity', 'requestQuantity', 'shortfall', 'rejected', 'stillToReceive',
  'additionalShortfall', 'amount', 'outstandingAmount', 'totalValue', 'difference', 'variance', 'unitPrice', 'quotes', 'lineCount', 'orders', 'deliveries',
]

// Up to two of the record's own figures, each with its unit; an amount only
// with its currency, a quantity with the record's unit.
function cardFigures(tool, row, output, language) {
  const figures = []
  for (const key of CARD_FIGURES) {
    const value = numberOf(at(row, key))
    if (value === null || figures.length === 2) continue
    const unit = NUMERIC_KINDS[columnKind(tool, key, [value], output)]
    if (!unit) continue
    const currency = unit === 'money' ? currencyBeside(row, key, output) : null
    if (unit === 'money' && !currency) continue
    const stored = unit === 'quantity' ? [row.unit, row.item?.unit].find((entry) => typeof entry === 'string' && entry && entry.length <= 20) : undefined
    // The unit in the answer's language and number: "300 boxes", "300 箱".
    const unitLabel = stored ? aiSkillUnitLabel(stored, language, value).slice(0, 20) : undefined
    figures.push({ code: aiUiColumnCode(key), value, unit, ...(currency ? { currency } : {}), ...(unitLabel ? { unitLabel } : {}) })
  }
  return figures
}

function cardOf(tool, { ref, row }, output, language) {
  const title = CARD_TITLES.map((key) => at(row, key)).find((value) => typeof value === 'string' && value.trim() && value !== ref.label)
  const status = CARD_STATUSES.map((key) => row[key]).find(isCode)
  const date = cardDate(row)
  const figures = cardFigures(tool, row, output, language)
  return { ref, ...(title ? { title: title.slice(0, MAX_TEXT) } : {}), ...(status ? { status: { code: status } } : {}), ...(date ? { date } : {}), ...(figures.length ? { figures } : {}) }
}

const showRecords = defineUiTool({
  name: 'show_records',
  display: true,
  description: 'Show 1 to 3 records of a data tool result as cards (for 4 or more use show_table): code, label, status, how late or how soon, and one or two of its figures, all from the result. Name each record by the type and id of a ref in that result.',
  inputSchema: {
    type: 'object',
    properties: {
      source: sourceParam,
      refs: { type: 'array', minItems: 1, maxItems: 6, items: refParam, description: 'Refs from the source result.' },
      emphasis: { type: 'string', enum: [...RECORD_EMPHASES], description: 'overdue, pending or info.' },
    },
    required: ['source', 'refs'],
    additionalProperties: false,
  },
  build(input, ctx) {
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    const found = pickRefs(source, input.refs, input.source)
    if (found.error) return found
    const cards = found.picked.map((holder) => cardOf(source.tool, holder, source.output, ctx?.language))
    return part('records', { source: source.id, ...(input.emphasis ? { emphasis: input.emphasis } : {}), cards }, cards.map((card) => card.ref))
  },
})

const showChart = defineUiTool({
  name: 'show_chart',
  display: true,
  description: 'Chart one list of a data tool result: x is the column along the axis and series are 1 to 4 number columns in one unit; amounts must all be in one currency. Use it for a trend or a comparison the user asked to see.',
  inputSchema: {
    type: 'object',
    properties: {
      source: sourceParam,
      kind: { type: 'string', enum: [...CHART_KINDS] },
      x: { type: 'string', minLength: 1, maxLength: 64, description: 'The column along the axis.' },
      series: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Number columns, all in one unit.' },
      list: listParam,
      title: titleParam,
    },
    required: ['source', 'kind', 'x', 'series'],
    additionalProperties: false,
  },
  build(input, ctx) {
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    const { tool, output } = source
    const resolved = resolveColumns(tool, [input.x, ...input.series], input.list, output)
    if (resolved.error) return resolved
    const xKey = keyIn(resolved.keys, input.x)
    const seriesKeys = [...new Set(input.series.map((name) => keyIn(resolved.keys, name)))].filter((key) => key !== xKey)
    if (!seriesKeys.length) return fail('invalid_input', 'series needs a column other than x.')
    const rows = rowsAt(output, resolved.path)
    if (!rows.length) return fail('no_rows', `${input.source} has no rows to chart.`)
    if (rows.length > CHART_POINTS) return fail('too_many_points', `A chart takes up to ${CHART_POINTS} points; ${input.source} has ${rows.length}. Use show_table.`)
    const units = new Set()
    for (const key of seriesKeys) {
      const unit = NUMERIC_KINDS[columnKind(tool, key, rows.map((row) => numberOf(at(row, key)) ?? at(row, key)), output)]
      if (!unit) return fail('not_numeric', `${key} is not a number column.`)
      units.add(unit)
    }
    if (units.size > 1) return fail('mixed_units', `The series ${seriesKeys.join(', ')} are in different units (${[...units].join(', ')}); chart one unit at a time.`)
    const [unit] = units
    const currencies = new Set()
    const series = []
    for (const key of seriesKeys) {
      const values = []
      for (const row of rows) {
        const raw = at(row, key)
        if (missing(raw)) { values.push(null); continue }
        const value = numberOf(raw)
        if (value === null) return fail('not_numeric', `${key} has a value that is not a number.`)
        if (unit === 'money') {
          const currency = currencyBeside(row, key, output)
          if (!currency) return fail('currency_missing', `${key} has an amount without a currency.`)
          currencies.add(currency)
        }
        values.push(value)
      }
      series.push({ code: aiUiColumnCode(key), values })
    }
    if (currencies.size > 1) return fail('mixed_currencies', `The amounts are in ${[...currencies].sort().join(' and ')}; a chart shows one currency. Ask the data tool for one currency, or use show_table.`)
    const currency = unit === 'money' ? [...currencies][0] || currencyCode(output.currency) : null
    if (unit === 'money' && !currency) return fail('currency_missing', `${input.source} does not say the currency of its amounts.`)
    const x = { code: aiUiColumnCode(xKey), values: rows.map((row) => { const value = valueAt(row, xKey); return isDay(value) ? value.slice(0, 10) : missing(value) ? '' : String(value).slice(0, 60) }) }
    const props = { source: source.id, kind: input.kind, ...(input.title ? { title: input.title } : {}), x, series, unit, ...(currency ? { currency } : {}) }
    return part('chart', props, rows.map((row) => refOf(row.ref)))
  },
})

const showKpis = defineUiTool({
  name: 'show_kpis',
  display: true,
  description: 'Show 2 to 6 workspace figures as tiles from a workspace_summary result, by its keys (for example purchaseOrders.overdue). A figure the user may not read shows as not available for their role.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { ...sourceParam, description: 'The source of a workspace_summary result of this answer, for example workspace_summary#1.' },
      keys: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Keys of the workspace_summary result.' },
    },
    required: ['source', 'keys'],
    additionalProperties: false,
  },
  build(input, ctx) {
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    if (source.tool !== 'workspace_summary') return fail('wrong_source', `show_kpis takes a workspace_summary result; ${input.source} is ${source.tool}.`)
    const resolved = resolveColumns(source.tool, input.keys, undefined, source.output)
    if (resolved.error) return resolved
    if (resolved.keys.length < 2) return fail('invalid_input', 'keys takes 2 to 6 different keys.')
    // The summary leaves out (null) what the role may not read: no value goes with it.
    const tiles = resolved.keys.map((key) => {
      const value = at(source.output, key)
      return isNumber(value) ? { code: aiUiColumnCode(key), value, unit: 'count' } : { code: aiUiColumnCode(key), value: null, unit: 'count', hidden: true }
    })
    return part('kpis', { source: source.id, tiles }, [])
  },
})

const PROMPT_TYPES = Object.freeze({ pick_item: 'item', pick_supplier: 'supplier' })

const offerChoices = defineUiTool({
  name: 'offer_choices',
  display: true,
  description: 'When the question could mean several records, offer 2 to 6 of them from a data tool result as buttons; the user\'s pick comes back as the next turn. promptCode: pick_item (items), pick_supplier (suppliers) or pick_record.',
  inputSchema: {
    type: 'object',
    properties: {
      source: sourceParam,
      refs: { type: 'array', minItems: 2, maxItems: 6, items: refParam, description: 'Refs from the source result.' },
      promptCode: { type: 'string', enum: [...CHOICE_PROMPTS] },
    },
    required: ['source', 'refs', 'promptCode'],
    additionalProperties: false,
  },
  build(input, ctx) {
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    const found = pickRefs(source, input.refs, input.source)
    if (found.error) return found
    const options = found.picked.map((holder) => holder.ref)
    const type = PROMPT_TYPES[input.promptCode]
    if (type && options.some((ref) => ref.type !== type)) return fail('wrong_ref_type', `${input.promptCode} offers ${type} records only.`)
    return part('choices', { source: source.id, promptCode: input.promptCode, options }, options)
  },
})

// The suggestion engine's codes (shared/purchase-suggestion.mjs and the data
// tool) in the form's terms. A row with no suggested quantity (covered, not
// needed, or no stock position) leaves the quantity to the user, as an item
// added from the search does.
const QUANTITY_SOURCE = Object.freeze({
  [PURCHASE_SUGGESTION_SOURCES.reorderGap]: 'reorder_gap',
  [PURCHASE_SUGGESTION_SOURCES.raisedToMoq]: 'reorder_gap_raised_to_moq',
  [PURCHASE_SUGGESTION_SOURCES.coverDays]: 'cover_days',
  [PURCHASE_SUGGESTION_SOURCES.coverDaysRaisedToMoq]: 'cover_days_raised_to_moq',
  [PURCHASE_SUGGESTION_SOURCES.userTyped]: 'user_named',
})
const SUPPLIER_SOURCE = Object.freeze({ preferred_supplier: 'preferred', only_approved_supplier: 'only_approved' })
const canDraft = (actor) => aiSkillVisibility(actor).canDraft
const MAX_FORM_LINES = 8

function suggestedQuantity(row) {
  const { value, source } = isObject(row.suggestedQuantity) ? row.suggestedQuantity : {}
  if (!isNumber(value) || value <= 0 || !QUANTITY_SOURCE[source]) return { value: null, source: 'none' }
  const raised = source === PURCHASE_SUGGESTION_SOURCES.raisedToMoq || source === PURCHASE_SUGGESTION_SOURCES.coverDaysRaisedToMoq
  const days = Number.isInteger(row.cover?.days) && row.cover.days > 0 ? row.cover.days : null
  return { value, source: QUANTITY_SOURCE[source], ...(raised ? { minimum: value } : {}), ...(days && QUANTITY_SOURCE[source].startsWith('cover_days') ? { coverDays: days } : {}) }
}

// A reference price as the form takes it: never a model value, and never an
// amount without its currency. Masked for the role, missing, or with no
// currency recorded, it has no value, so the form sends the user to the full
// form rather than assume a currency.
function priceOf(value, currency, output) {
  if (output.pricesHidden) return { value: null, currency: null, source: 'masked' }
  const amount = numberOf(value)
  return amount !== null && amount >= 0 && currencyCode(currency) ? { value: amount, currency, source: 'reference_price' } : { value: null, currency: null, source: 'missing' }
}

const referencePrice = (row, output) => (isObject(row.estimatedUnitPrice) ? priceOf(row.estimatedUnitPrice.value, row.estimatedUnitPrice.currency, output) : priceOf(null, null, output))

// The item's approved suppliers as the result lists them, each with its own
// lead time and price, so a user who picks another one gets that supplier's
// figures. A result without that list gives the chosen supplier only, or the
// ones a person chooses from.
function approvedSuppliers(row, output, price) {
  if (output.suppliersHidden) return []
  if (Array.isArray(row.approvedSuppliers) && row.approvedSuppliers.length) {
    return row.approvedSuppliers.map((entry) => {
      const own = priceOf(entry.unitPrice, entry.currency, output)
      return { id: entry.id, name: entry.name, preferred: Boolean(entry.preferred), leadTimeDays: Number.isInteger(entry.leadTimeDays) && entry.leadTimeDays >= 0 ? entry.leadTimeDays : null, unitPrice: own.value, currency: own.currency }
    })
  }
  const chosen = isObject(row.supplier) ? row.supplier : null
  if (chosen) {
    return [{ id: chosen.id, name: chosen.name, preferred: chosen.source === 'preferred_supplier', leadTimeDays: row.needByDate?.leadTimeDays ?? null, unitPrice: price.value, currency: price.currency }]
  }
  return array(row.supplierChoices).map((choice) => ({ id: choice.id, name: choice.name, preferred: false }))
}

const matchSupplier = (suppliers, wanted) => suppliers.find((supplier) => fold(supplier.id) === fold(wanted) || fold(supplier.name) === fold(wanted))

// The workspace's suppliers as stored: id, code, name, whether active, and
// the currency it records (null when none).
function storedSupplier(row) {
  const meta = isObject(row.metadata) ? row.metadata : {}
  return { id: text(row.id), code: text(row.code), name: text(row.name), active: fold(row.status || 'active') === 'active', currency: currencyCode(text(meta.defaultCurrency || meta.currency).toUpperCase()) }
}

// Every supplier of the user's workspace (master data is readable by every
// signed-in role), or null when they cannot be read.
async function workspaceSuppliers({ prisma, tenantId } = {}) {
  if (typeof prisma?.supplier?.findMany !== 'function' || !tenantId) return null
  try {
    return array(await prisma.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true, status: true, metadata: true }, take: 5000 })).map(storedSupplier)
  } catch {
    return null
  }
}

// A supplier the user named, among the workspace's: by id, code or name, else
// the one active supplier whose name holds the words the user wrote
// ("Northstar" for Northstar Electronics); several such are left to the user.
function findWorkspaceSupplier(records, wanted) {
  const key = said(wanted)
  const exact = records.filter((row) => [row.id, row.code, row.name].some((value) => value && said(value) === key))
  if (exact.length) return { found: exact.find((row) => row.active) || exact[0] }
  if (key.length < 3) return {}
  const partial = records.filter((row) => row.active && row.name && ` ${said(row.name)} `.includes(` ${key} `))
  return partial.length === 1 ? { found: partial[0] } : partial.length ? { several: partial.slice(0, 5) } : {}
}

// The price, currency and lead time the user typed for a supplier the form
// adds to the item: each must be in the user's own words.
function typedTerms(line, words) {
  const untyped = []
  if (isNumber(line.unitPrice) && !words.number(line.unitPrice)) untyped.push(`unitPrice ${line.unitPrice}`)
  if (isNumber(line.leadTimeDays) && !words.number(line.leadTimeDays)) untyped.push(`leadTimeDays ${line.leadTimeDays}`)
  const currency = missing(line.currency) ? null : text(line.currency).toUpperCase()
  if (currency && (!KNOWN_CURRENCIES.has(currency) || !words.currency(currency))) untyped.push(`currency "${line.currency}"`)
  if (untyped.length) return fail('not_typed', `Not in the user's words: ${untyped.join(', ')}. Pass a price, currency or lead time only as the user wrote it, or leave it out; the user can enter it in the form.`)
  return { unitPrice: isNumber(line.unitPrice) ? line.unitPrice : null, leadTimeDays: Number.isInteger(line.leadTimeDays) ? line.leadTimeDays : null, currency }
}

// A supplier the user named that the result does not list as approved for
// the item. One of the workspace's active suppliers comes back as one more
// option with link "new" when the user may add approved suppliers to items:
// the form adds it when the user clicks Create. Otherwise the model is told
// why it cannot be used. An approved supplier named by its code or a shorter
// name is that supplier.
function unlistedSupplier(row, approved, line, scope) {
  const sku = row.item.sku
  const listed = approved.map((entry) => entry.name).join(', ') || 'none'
  const unknown = (why) => fail('supplier_not_listed', `${line.supplier} is not among the approved suppliers the result lists for ${sku} (${listed})${why}. Leave supplier out; the user can choose in the form.`)
  if (!scope.records) return unknown('')
  const { found, several } = findWorkspaceSupplier(scope.records, line.supplier)
  if (several) return fail('supplier_unclear', `${line.supplier} could be any of ${several.map((entry) => entry.name).join(', ')}. Ask the user which one they mean, or pass its full name.`)
  if (!found) return unknown(', nor a supplier of this workspace')
  if (!found.active) return unknown(`; ${found.name} is inactive in this workspace`)
  const known = approved.find((entry) => entry.id === found.id)
  if (known) return { picked: known }
  const name = (found.name || found.code || found.id).slice(0, 200)
  if (!scope.mayLink) return fail('supplier_not_approved', `${name} is a supplier of this workspace but not an approved supplier of ${sku} (approved: ${listed}), and this user's role cannot add one. Say that a colleague with master data access can add ${name} as an approved supplier of ${sku}, then leave supplier out to show the form with the approved suppliers, or show no form.`)
  const terms = typedTerms(line, scope.words)
  if (terms.error) return terms
  return { picked: { id: found.id, name, preferred: false, leadTimeDays: terms.leadTimeDays, unitPrice: terms.unitPrice, currency: terms.currency || found.currency || scope.workspaceCurrency || null, link: NEW_SUPPLIER_LINK } }
}

// One form row. The model's quantity, supplier and date count only for an
// item the user named; otherwise every value is the server's. scope: what a
// supplier the item has not approved is checked against (unlistedSupplier).
function formRow(row, output, { named, line, scope }) {
  const price = referencePrice(row, output)
  const suppliers = approvedSuppliers(row, output, price)
  const chosen = isObject(row.supplier) && !output.suppliersHidden ? row.supplier : null
  let supplier = chosen && SUPPLIER_SOURCE[chosen.source] ? { id: chosen.id, name: chosen.name, source: SUPPLIER_SOURCE[chosen.source] } : null
  let estimatedUnitPrice = price
  let lead = row.needByDate?.leadTimeDays ?? null
  let shortWeekOf = isDay(row.needByDate?.warning?.weekOf) ? row.needByDate.warning.weekOf : null
  let leadDate = row.needByDate?.source === PURCHASE_SUGGESTION_SOURCES.leadTime && isDay(row.needByDate.value) ? row.needByDate.value : null
  if (named && line?.supplier) {
    let picked = matchSupplier(suppliers, line.supplier)
    if (!picked) {
      const unlisted = unlistedSupplier(row, suppliers, line, scope)
      if (unlisted.error) return unlisted
      picked = unlisted.picked
      if (picked.link) suppliers.push(picked)
    }
    supplier = { id: picked.id, name: picked.name, source: 'user_named', ...(picked.link ? { link: picked.link } : {}) }
    if (!chosen || picked.id !== chosen.id) {
      // That supplier's own price and lead time; the need-by date follows its
      // lead time as the form does when the user changes the supplier. A
      // supplier the form adds has no reference price yet: the user enters
      // the price in the form (any price they typed is on its option).
      estimatedUnitPrice = !picked.link && picked.unitPrice !== null && picked.unitPrice !== undefined ? { value: picked.unitPrice, currency: picked.currency, source: 'reference_price' } : { value: null, currency: null, source: price.source === 'masked' && !picked.link ? 'masked' : 'missing' }
      // A supplier with no lead time recorded keeps the item's need-by date
      // from its preferred supplier's lead time, never today (2026-11-05:
      // "from Northstar instead" set today while the answer said Nov 22).
      const moved = suggestNeedByDate({ today: output.today, leadTimeDays: picked.leadTimeDays ?? null, firstShortWeek: shortWeekOf })
      if (moved.source === PURCHASE_SUGGESTION_SOURCES.leadTime) {
        lead = moved.leadTimeDays
        leadDate = moved.value
        shortWeekOf = moved.warning?.weekOf ?? null
      }
    }
  }
  const needByDate = named && line?.needByDate
    ? { value: line.needByDate, source: 'user_named', leadTimeDays: lead, shortWeekOf }
    : leadDate
      ? { value: leadDate, source: 'lead_time', leadTimeDays: lead, shortWeekOf }
      : { value: output.today, source: 'today', leadTimeDays: null, shortWeekOf }
  const cover = isObject(row.covered) ? refOf(array(row.covered.by)[0]?.ref) : null
  // A quantity of the conversation's latest optimize_order_plan decision is
  // the server's, like any suggestion. That plan already counted the open
  // orders and requests, so they do not mark its line as covered.
  const fromPlan = isNumber(line?.quantity) && line.quantity > 0 && scope.orderPlan?.get(fold(row.item.sku)) === line.quantity
  return {
    item: { id: text(row.item.id) || row.ref.id, sku: row.item.sku, name: text(row.item.name), unit: row.item.unit ?? null },
    onHand: row.onHand ?? null,
    safetyStock: row.safetyStock ?? null,
    reorderPoint: row.reorderPoint ?? null,
    suggestedQuantity: fromPlan ? { value: line.quantity, source: 'order_plan' } : named && isNumber(line?.quantity) ? { value: line.quantity, source: 'user_named' } : suggestedQuantity(row),
    supplier,
    suppliers,
    needByDate,
    estimatedUnitPrice,
    warehouse: row.warehouseId ? { id: row.warehouseId, label: row.warehouseId } : null,
    covered: cover && !fromPlan ? { ref: cover } : null,
    // Ticked only for an item the user named and nothing already covers.
    checked: named && (fromPlan || !row.covered),
  }
}

const suggestPurchaseRequest = defineUiTool({
  name: 'suggest_purchase_request',
  description: 'Show the in-chat purchase request form from a suggest_purchase_lines result (source). from user_named: the items the user named in this question, listed in lines. from agreed: the items the user agreed to, named or proposed earlier in this conversation, listed in lines, or no lines for every item of the latest form. from suggestions: the suggested items (all, or those listed in lines), for the user to choose. Quantity, supplier and need-by date in a line are used only for an item the user named or agreed to, and only when the user gave or changed them; otherwise the server fills every value. A line may also carry an item\'s quantity from the latest optimize_order_plan decision, which the form shows as the best plan\'s. Named and agreed items are ticked (unless open orders already cover them); the user ticks the rest and creates the draft with their own click. A supplier the user named that is not yet an approved supplier of the item, but is an active supplier of the workspace, goes on the line when the user may add approved suppliers: when the user clicks Create, the form adds it as an approved supplier of the item, then creates the request. Pass unitPrice, currency and leadTimeDays only for such a supplier and only as the user typed them; the user can also enter them in the form.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { ...sourceParam, description: 'The source of a suggest_purchase_lines result of this answer, for example suggest_purchase_lines#1.' },
      from: { type: 'string', enum: ['user_named', 'agreed', 'suggestions'] },
      lines: {
        type: 'array',
        minItems: 0,
        maxItems: MAX_FORM_LINES,
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string', minLength: 1, maxLength: 120 },
            quantity: { type: 'number', exclusiveMinimum: 0, description: 'Only a quantity the user typed or changed, or the item\'s quantity in the latest optimize_order_plan decision.' },
            supplier: { type: 'string', minLength: 1, maxLength: 200, description: 'Only a supplier the user named: its name, code or id.' },
            needByDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', minLength: 10, maxLength: 10, description: 'Only a date the user gave, YYYY-MM-DD.' },
            unitPrice: { type: 'number', minimum: 0, maximum: 1000000000, description: 'Only a unit price the user typed for a supplier that is not yet approved for the item.' },
            currency: { type: 'string', pattern: '^[A-Za-z]{3}$', minLength: 3, maxLength: 3, description: 'Only a currency the user gave with that price (code or sign), as a 3-letter code.' },
            leadTimeDays: { type: 'integer', minimum: 0, maximum: 3650, description: 'Only a lead time in days the user typed for that supplier.' },
          },
          required: ['sku'],
          additionalProperties: false,
        },
      },
    },
    required: ['source', 'from'],
    additionalProperties: false,
  },
  available: (actor) => canDraft(actor),
  build(input, ctx) {
    // Nothing is offered to someone who could not create the request.
    if (!canDraft(ctx?.actor)) return fail('not_allowed', 'The user may not create purchase requests; explain and link to the record instead.')
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    if (source.tool !== 'suggest_purchase_lines') return fail('wrong_source', `suggest_purchase_request takes a suggest_purchase_lines result; ${input.source} is ${source.tool}. Call suggest_purchase_lines for the items first, then suggest_purchase_request with its result as source. No form is shown until then.`)
    const { output } = source
    const lines = array(input.lines)
    if (input.from === 'user_named' && !lines.length) return fail('invalid_input', 'from user_named needs the named items in lines.')
    // from agreed (decision V2-4 as revised on 2026-11-04): the items the
    // user said yes to. Each listed one was named in this conversation or
    // offered on an earlier form; no lines means every item of the latest form.
    let agreed = null
    if (input.from === 'agreed') {
      const asked = lines.length ? lines.map((line) => line.sku) : array(ctx.lastFormSkus)
      if (!asked.length) return fail('nothing_agreed', 'No earlier form in this conversation to agree to. Pass from user_named with the SKUs the user named, or from suggestions.')
      const strangers = lines.filter((line) => !(typeof ctx.agreeable === 'function' && ctx.agreeable(line.sku))).map((line) => line.sku)
      if (strangers.length) return fail('not_agreed', `${strangers.join(', ')} was neither named in this conversation nor offered on an earlier form. Pass from suggestions to leave it unticked, or ask the user.`)
      agreed = new Set(asked.map(fold))
    }
    if (lines.some((line) => !missing(line.needByDate) && !isDay(line.needByDate))) return fail('invalid_input', 'needByDate must be a real day.')
    const rows = array(output.rows)
    const bySku = new Map(rows.map((row) => [fold(row.item?.sku), row]))
    const unknown = lines.filter((line) => !bySku.has(fold(line.sku))).map((line) => line.sku)
    if (unknown.length) return fail('foreign_sku', `${unknown.join(', ')} is not in the result of ${input.source} (${rows.map((row) => row.item.sku).join(', ') || 'no rows'}). Call suggest_purchase_lines with those SKUs first.`)
    const linesBySku = new Map(lines.map((line) => [fold(line.sku), line]))
    const chosen = lines.length ? [...new Set(lines.map((line) => bySku.get(fold(line.sku))))] : agreed ? rows.filter((row) => agreed.has(fold(row.item?.sku))) : rows
    if (agreed && !lines.length && !chosen.length) return fail('foreign_sku', `The latest form's items (${[...agreed].join(', ')}) are not in the result of ${input.source}. Call suggest_purchase_lines with those SKUs first.`)
    // An item that is not active cannot be requested; the answer says why.
    const requestable = chosen.filter((row) => row.suggestedQuantity?.source !== PURCHASE_SUGGESTION_SOURCES.itemInactive)
    if (!requestable.length) return fail('nothing_to_request', `No item in ${input.source} can be requested (inactive or none). Say so instead of showing the form.`)
    if (requestable.length > MAX_FORM_LINES) return fail('too_many_lines', `The form takes up to ${MAX_FORM_LINES} items; list the SKUs to show in lines.`)
    const userNamed = new Set(array(ctx.userNamedSkus).map(fold))
    // An item the user described in their own words ("我需要 50 个温度传感器")
    // that the model resolved and listed from user_named is the user's too
    // (2026-11-05: the line stayed unticked while the answer asked to check
    // it): when the user typed its quantity in this question, or when it is
    // the one line and the question names no SKU at all. A quantity the user
    // did not type is the server's suggestion, not "you asked for this".
    const question = String(ctx.question ?? '').normalize('NFKC')
    const typedNumbers = new Set([...question.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, ''))))
    const namesNoSku = !/[A-Za-z]+[A-Za-z0-9]*-\d/.test(question)
    const resolved = (line) => {
      if (input.from !== 'user_named' || !line) return null
      const quantityTyped = isNumber(line.quantity) && typedNumbers.has(line.quantity)
      if (quantityTyped) return line
      return lines.length === 1 && namesNoSku && question.trim() ? { ...line, quantity: undefined } : null
    }
    const entries = requestable.map((row) => {
      const line = linesBySku.get(fold(row.item.sku))
      if (agreed) return { row, isNamed: agreed.has(fold(row.item.sku)), line }
      if (userNamed.has(fold(row.item.sku))) return { row, isNamed: true, line }
      const described = resolved(line)
      return { row, isNamed: Boolean(described), line: described || line }
    })
    // Adding an approved supplier to an item is what the item supplier route
    // allows (master-data.routes.mjs WRITE_RULES); a role that cannot see
    // suppliers in the assistant is not offered it.
    const mayLink = canLinkItemSuppliers(ctx.actor) && !output.suppliersHidden
    const workspaceCurrency = currencyCode(text(ctx.workspaceCurrency).toUpperCase())
    const finish = (records) => {
      const scope = { records, mayLink, words: userWords(ctx.userText), workspaceCurrency, orderPlan: ctx.orderPlan instanceof Map ? ctx.orderPlan : null }
      const named = []
      const suggested = []
      for (const { row, isNamed, line } of entries) {
        const built = formRow(row, output, { named: isNamed, line, scope })
        if (built.error) return built
        if (isNamed) named.push(built)
        else suggested.push(built)
      }
      const props = {
        formId: `${ctx.threadId}:${ctx.messageId}:${ctx.partId}`, source: source.id, suggested, lines: named, canCreate: true,
        canLinkSuppliers: mayLink, ...(mayLink && workspaceCurrency ? { workspaceCurrency } : {}),
      }
      const added = [...named, ...suggested].filter((row) => row.supplier?.link).map((row) => refOf({ type: 'supplier', id: row.supplier.id, label: row.supplier.name.slice(0, 120) }))
      const refs = [...requestable.flatMap((row) => [refOf(row.ref), ...array(row.covered?.by).map((entry) => refOf(entry.ref))]), ...added]
      return part('pr_form', props, refs)
    }
    // The workspace's suppliers are read only when the user named one that the
    // result does not list as approved for its item.
    const unlisted = !output.suppliersHidden && entries.some(({ row, isNamed, line }) => isNamed && line?.supplier && !matchSupplier(approvedSuppliers(row, output, referencePrice(row, output)), line.supplier))
    return unlisted ? workspaceSuppliers(ctx).then(finish) : finish(null)
  },
})

// ---------------------------------------------------------------- setup

// A page of the app as the parts route to it: /app/master-data/import?type=items
// is the route master-data:import with { type: 'items' } (src/app/routeRegistry.tsx).
function routeOfHref(href) {
  const match = text(href).match(/^\/app\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)(?:\?([^#]*))?$/)
  if (!match) return null
  const query = Object.fromEntries(new URLSearchParams(match[2] || ''))
  return { moduleId: match[1].split('/').join(':'), ...(Object.keys(query).length ? { query } : {}) }
}

const showSetupSteps = defineUiTool({
  name: 'show_setup_steps',
  display: true,
  description: 'Show the setup checklist of a setup_status result: the steps in order, which are done, and for each open step the user may do, a link to its page (the import page, for many rows at once, when import is on). Use it when you explain how to set up the workspace.',
  inputSchema: {
    type: 'object',
    properties: { source: { ...sourceParam, description: 'The source of a setup_status result of this answer, for example setup_status#1.' } },
    required: ['source'],
    additionalProperties: false,
  },
  build(input, ctx) {
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    if (source.tool !== 'setup_status') return fail('wrong_source', `show_setup_steps takes a setup_status result; ${input.source} is ${source.tool}.`)
    const { output } = source
    const steps = array(output.steps).filter((step) => SETUP_STEP_IDS.includes(step?.id)).map((step) => {
      // A link only where the user can act: an open step they may do.
      const route = step.done || step.blocked ? null : routeOfHref(step.href)
      return { id: step.id, done: Boolean(step.done), count: Number.isInteger(step.count) && step.count >= 0 ? step.count : 0, ...(step.blocked ? { blocked: step.blocked } : {}), ...(route ? { route } : {}) }
    })
    const gaps = isObject(output.gaps) ? { checked: output.gaps.checked, unit: output.gaps.unit, preferredSupplier: output.gaps.preferredSupplier, thresholds: output.gaps.thresholds } : null
    return part('setup_steps', { source: source.id, steps, done: output.done, total: output.total, ...(gaps ? { gaps } : {}) }, [])
  },
})

const allowedTo = (actor, permission) => Boolean(actor?.tenantId) && can({ actor, permission, tenantId: actor.tenantId })
// The permissions of the Suppliers and Items pages' writes, and of an item's
// supplier links, which share the item's (master-data.routes.mjs WRITE_RULES).
const canAddSuppliers = (actor) => allowedTo(actor, 'master_data.supplier.manage')
const canAddItems = (actor) => allowedTo(actor, 'master_data.item.manage')
const canLinkItemSuppliers = (actor) => allowedTo(actor, 'master_data.item.manage')

// The user's words as values are found in them: NFKC, case and spacing folded.
const said = (value) => text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
const CURRENCY_SIGNS = Object.freeze([[/US\$|\$/, ['USD']], [/€/, ['EUR']], [/£/, ['GBP']], [/¥|￥/, ['CNY', 'JPY']], [/元|人民币|RMB/i, ['CNY']], [/円/, ['JPY']]])
const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf('currency'))
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Whether a value the model passed is in what the user wrote: a text as
// written (any case or spacing), a number written with or without thousands
// separators (its sign aside: a negative one is the row's problem), a
// currency by its code or its sign.
function userWords(userText) {
  const words = said(userText)
  const numbers = new Set([...String(userText ?? '').normalize('NFKC').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, ''))).filter(Number.isFinite))
  return {
    text: (value) => Boolean(said(value)) && words.includes(said(value)),
    number: (value) => numbers.has(Math.abs(value)),
    currency: (value) => words.includes(value.toLowerCase()) || CURRENCY_SIGNS.some(([sign, codes]) => codes.includes(value.toUpperCase()) && sign.test(String(userText ?? ''))),
  }
}

const SUPPLIER_FIELDS = Object.freeze({ name: 200, code: 64, contact: 200, email: 200, phone: 60, paymentTerms: 60 })
const ITEM_TEXT_FIELDS = Object.freeze({ sku: 64, name: 200, unit: 20, category: 100, preferredSupplier: 200 })
const ITEM_NUMBER_FIELDS = Object.freeze({ safetyStock: 'safety_stock', reorderPoint: 'reorder_point', referencePrice: 'reference_price', leadTimeDays: 'lead_time_days' })
const SUPPLIER_CODE = /^SUP-(\d+)$/i

// The values of a row the user did not write, as "suppliers[0].email".
function untypedValues(rows, kind, fields, words) {
  const found = []
  for (const [index, row] of rows.entries()) {
    for (const field of Object.keys(fields)) if (row[field] !== undefined && !words.text(row[field])) found.push(`${kind}[${index}].${field} "${text(row[field]).slice(0, 40)}"`)
    if (kind === 'items') {
      for (const field of Object.keys(ITEM_NUMBER_FIELDS)) if (isNumber(row[field]) && !words.number(row[field])) found.push(`items[${index}].${field} ${row[field]}`)
      if (row.currency !== undefined && !words.currency(row.currency)) found.push(`items[${index}].currency "${row.currency}"`)
    }
  }
  return found
}

const given = (row, field, max) => (row[field] === undefined || !text(row[field]) ? { value: null, source: 'not_given' } : { value: text(row[field]).slice(0, max), source: 'user_typed' })
const givenNumber = (row, field) => (isNumber(row[field]) ? { value: row[field], source: 'user_typed' } : { value: null, source: 'not_given' })
const problem = (field, code, blocking = true, ref = null) => ({ field, code, blocking, ...(ref ? { ref } : {}) })
const supplierRef = (row) => refOf({ type: 'supplier', id: row.id, label: (row.name || row.code || row.id).slice(0, 120) })
const itemRef = (row) => refOf({ type: 'item', id: row.id, label: row.sku.slice(0, 120) })

// The workspace's records the card is checked against, every read in the
// user's workspace: its suppliers (for duplicates, preferred suppliers and the
// next free code), the items with a SKU or name of the card, and its payment terms.
async function setupRecords(ctx, items) {
  const { prisma, tenantId } = ctx
  const skus = items.map((row) => text(row.sku)).filter(Boolean)
  const names = items.map((row) => text(row.name)).filter(Boolean)
  const [suppliers, stored, terms] = await Promise.all([
    prisma.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true, status: true, metadata: true }, take: 5000 }),
    items.length ? prisma.item.findMany({ where: { tenantId, OR: [{ sku: { in: skus, mode: 'insensitive' } }, { name: { in: names, mode: 'insensitive' } }] }, select: { id: true, sku: true, name: true } }) : [],
    prisma.paymentTerm.findMany({ where: { tenantId }, select: { code: true, name: true }, orderBy: [{ code: 'asc' }] }),
  ])
  return {
    suppliers: array(suppliers).map(storedSupplier),
    items: array(stored).map((row) => ({ id: text(row.id), sku: text(row.sku), name: text(row.name) })),
    terms: array(terms).map((row) => ({ code: text(row.code), name: text(row.name) })).filter((row) => row.code),
  }
}

// The next free supplier code: past every SUP-number in the workspace and in
// the card, so a code the card makes up never collides with one there.
function codeSeedOf(existing, typed) {
  const numbers = [...existing, ...typed].map((code) => text(code).match(SUPPLIER_CODE)?.[1]).filter(Boolean)
  const width = Math.min(6, Math.max(3, ...numbers.map((digits) => digits.length)))
  return { prefix: 'SUP-', next: Math.max(0, ...numbers.map(Number)) + 1, width }
}

function supplierRows(input, records) {
  const rows = []
  for (const [index, row] of input.entries()) {
    const problems = []
    const name = given(row, 'name', SUPPLIER_FIELDS.name)
    const code = row.code !== undefined && text(row.code) ? given(row, 'code', SUPPLIER_FIELDS.code) : { value: null, source: 'generated' }
    const email = given(row, 'email', SUPPLIER_FIELDS.email)
    if (!name.value) problems.push(problem('name', 'required'))
    else {
      const existing = records.suppliers.find((entry) => fold(entry.name) === fold(name.value))
      if (existing) problems.push(problem('name', 'duplicate_existing', true, supplierRef(existing)))
      else if (rows.some((other) => fold(other.name.value) === fold(name.value))) problems.push(problem('name', 'duplicate_in_card'))
    }
    if (code.value) {
      const existing = records.suppliers.find((entry) => entry.code && fold(entry.code) === fold(code.value))
      if (existing) problems.push(problem('code', 'duplicate_existing', true, supplierRef(existing)))
      else if (rows.some((other) => other.code.value && fold(other.code.value) === fold(code.value))) problems.push(problem('code', 'duplicate_in_card'))
    }
    if (email.value && !EMAIL.test(email.value)) problems.push(problem('email', 'email_invalid'))
    let paymentTerms = { value: null, label: null, typed: null, source: 'not_given' }
    if (row.paymentTerms !== undefined && text(row.paymentTerms)) {
      // Only one of the workspace's terms, by code or name ("Net 30" is NET30).
      const term = findPaymentTerm(records.terms, row.paymentTerms)
      paymentTerms = { value: term?.code ?? null, label: term ? term.name || term.code : null, typed: text(row.paymentTerms).slice(0, 60), source: 'user_typed' }
      // Not one of them: the user picks one in the card or leaves it empty.
      if (!term) problems.push(problem('payment_terms', 'payment_terms_unknown', false))
    }
    rows.push({ key: `s${index + 1}`, name, code, contact: given(row, 'contact', SUPPLIER_FIELDS.contact), email, phone: given(row, 'phone', SUPPLIER_FIELDS.phone), paymentTerms, problems })
  }
  return rows
}

function itemRows(input, records, cardSuppliers, workspaceCurrency) {
  const rows = []
  for (const [index, row] of input.entries()) {
    const problems = []
    const sku = given(row, 'sku', ITEM_TEXT_FIELDS.sku)
    const name = given(row, 'name', ITEM_TEXT_FIELDS.name)
    const unit = given(row, 'unit', ITEM_TEXT_FIELDS.unit)
    if (!sku.value) problems.push(problem('sku', 'required'))
    else if (sku.value.length > 64 || /\s/.test(sku.value)) problems.push(problem('sku', 'invalid'))
    else {
      const existing = records.items.find((entry) => fold(entry.sku) === fold(sku.value))
      if (existing) problems.push(problem('sku', 'duplicate_existing', true, itemRef(existing)))
      else if (rows.some((other) => fold(other.sku.value) === fold(sku.value))) problems.push(problem('sku', 'duplicate_in_card'))
    }
    if (!name.value) problems.push(problem('name', 'required'))
    else {
      // Two items may share a name (sizes, colours): a warning, not a block.
      const existing = records.items.find((entry) => fold(entry.name) === fold(name.value))
      if (existing) problems.push(problem('name', 'duplicate_existing', false, itemRef(existing)))
      else if (rows.some((other) => fold(other.name.value) === fold(name.value))) problems.push(problem('name', 'duplicate_in_card', false))
    }
    // A unit is asked for, never assumed: the Items page would store pcs.
    if (!unit.value) problems.push(problem('unit', 'required'))
    const numbers = Object.fromEntries(Object.keys(ITEM_NUMBER_FIELDS).map((field) => [field, givenNumber(row, field)]))
    for (const [field, code] of Object.entries(ITEM_NUMBER_FIELDS)) {
      const value = numbers[field].value
      if (value === null) continue
      if (value < 0) problems.push(problem(code, 'negative'))
      else if (field === 'leadTimeDays' && !Number.isInteger(value)) problems.push(problem(code, 'whole_number'))
    }
    // The preferred supplier: one of this card's rows, else an existing one.
    let preferredSupplier = { supplierId: null, rowKey: null, name: null, typed: null, source: 'not_given' }
    let supplierCurrency = null
    if (row.preferredSupplier !== undefined && text(row.preferredSupplier)) {
      const wanted = fold(row.preferredSupplier)
      const typed = text(row.preferredSupplier).slice(0, 200)
      // A card row that repeats an existing supplier is not the one meant.
      const card = cardSuppliers.find((entry) => !entry.problems.some((found) => found.code === 'duplicate_existing') && (fold(entry.name.value) === wanted || (entry.code.value && fold(entry.code.value) === wanted)))
      const existing = card ? null : records.suppliers.find((entry) => fold(entry.name) === wanted || (entry.code && fold(entry.code) === wanted) || fold(entry.id) === wanted)
      if (card) {
        preferredSupplier = { supplierId: null, rowKey: card.key, name: card.name.value, typed, source: 'user_typed' }
        supplierCurrency = workspaceCurrency
      } else if (existing && existing.active) {
        preferredSupplier = { supplierId: existing.id, rowKey: null, name: existing.name || existing.code, typed, source: 'user_typed' }
        supplierCurrency = existing.currency || workspaceCurrency
      } else {
        preferredSupplier = { supplierId: null, rowKey: null, name: null, typed, source: 'user_typed' }
        problems.push(existing ? problem('preferred_supplier', 'supplier_inactive', true, supplierRef(existing)) : problem('preferred_supplier', 'supplier_unknown'))
      }
    }
    const hasSupplier = row.preferredSupplier !== undefined && text(row.preferredSupplier)
    // A price and a lead time belong to the item's link with its supplier.
    if (!hasSupplier && (numbers.referencePrice.value !== null || numbers.leadTimeDays.value !== null)) problems.push(problem(numbers.referencePrice.value !== null ? 'reference_price' : 'lead_time_days', 'needs_supplier'))
    let currency = supplierCurrency ? { value: supplierCurrency, source: 'default' } : { value: null, source: 'not_given' }
    if (row.currency !== undefined && text(row.currency)) {
      const typed = text(row.currency).toUpperCase()
      if (KNOWN_CURRENCIES.has(typed)) currency = { value: typed, source: 'user_typed' }
      else problems.push(problem('currency', 'currency_invalid'))
    }
    rows.push({
      key: `i${index + 1}`, sku, name, unit, category: given(row, 'category', ITEM_TEXT_FIELDS.category),
      safetyStock: numbers.safetyStock, reorderPoint: numbers.reorderPoint, referencePrice: numbers.referencePrice, leadTimeDays: numbers.leadTimeDays,
      currency, preferredSupplier, problems,
    })
  }
  return rows
}

const setupText = (max, description) => ({ type: 'string', minLength: 1, maxLength: max, description })
const suggestSetupRecords = defineUiTool({
  name: 'suggest_setup_records',
  description: `Show the setup card: new suppliers and/or new items the user described or pasted, for them to review, edit and create with their own click. Pass only values the user typed, as they wrote them, and leave out any field they did not give; the server checks every value against the user's words, and refuses a value that is not there. Up to ${SETUP_FORM_ROWS} rows in all. The server marks duplicates of existing records, missing units, unknown payment terms or suppliers and other problems on each row; the user fixes them in the card. A supplier with no code gets the next free code. An item's preferredSupplier is an existing supplier or one in the same card, by name or code; its referencePrice and leadTimeDays are that supplier's.`,
  inputSchema: {
    type: 'object',
    properties: {
      suppliers: {
        type: 'array', minItems: 0, maxItems: SETUP_FORM_ROWS,
        items: {
          type: 'object',
          properties: {
            name: setupText(SUPPLIER_FIELDS.name), code: setupText(SUPPLIER_FIELDS.code, 'Only a code the user gave.'), contact: setupText(SUPPLIER_FIELDS.contact, 'Contact person.'),
            email: setupText(SUPPLIER_FIELDS.email), phone: setupText(SUPPLIER_FIELDS.phone), paymentTerms: setupText(SUPPLIER_FIELDS.paymentTerms, 'As the user wrote it, for example Net 30.'),
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      items: {
        type: 'array', minItems: 0, maxItems: SETUP_FORM_ROWS,
        items: {
          type: 'object',
          properties: {
            sku: setupText(ITEM_TEXT_FIELDS.sku), name: setupText(ITEM_TEXT_FIELDS.name), unit: setupText(ITEM_TEXT_FIELDS.unit, 'Unit of measure, for example pcs or box.'), category: setupText(ITEM_TEXT_FIELDS.category),
            safetyStock: { type: 'number' }, reorderPoint: { type: 'number' },
            preferredSupplier: setupText(ITEM_TEXT_FIELDS.preferredSupplier, 'Name or code of an existing supplier or of one in this card.'),
            referencePrice: { type: 'number', description: 'Unit price from the preferred supplier.' },
            currency: { type: 'string', minLength: 1, maxLength: 3, description: 'Only a currency the user gave (code or sign), as a 3-letter code.' },
            leadTimeDays: { type: 'number', description: 'Lead time in days from the preferred supplier.' },
          },
          required: ['sku', 'name'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  // Offered to someone who may add suppliers or items, as the request form is
  // offered only to someone who may create requests.
  available: (actor) => canAddSuppliers(actor) || canAddItems(actor),
  async build(input, ctx) {
    const actor = ctx?.actor
    const suppliersIn = array(input.suppliers)
    const itemsIn = array(input.items)
    const mayAddSuppliers = canAddSuppliers(actor)
    const mayAddItems = canAddItems(actor)
    if (!mayAddSuppliers && !mayAddItems) return fail('not_allowed', 'The user may not add suppliers or items; say so and that someone with master data access can.')
    if (!suppliersIn.length && !itemsIn.length) return fail('invalid_input', 'Pass at least one supplier or item.')
    if (suppliersIn.length + itemsIn.length > SETUP_FORM_ROWS) return fail('too_many_rows', `The card takes up to ${SETUP_FORM_ROWS} rows in all; pass the first ${SETUP_FORM_ROWS} and point the user to the import page for the rest.`)
    if (suppliersIn.length && !mayAddSuppliers) return fail('not_allowed', 'The user may not add suppliers; leave suppliers out and say that someone with supplier access can add them.')
    if (itemsIn.length && !mayAddItems) return fail('not_allowed', 'The user may not add items; leave items out and say that someone with item access can add them.')
    const words = userWords(ctx.userText)
    const untyped = [...untypedValues(suppliersIn, 'suppliers', SUPPLIER_FIELDS, words), ...untypedValues(itemsIn, 'items', ITEM_TEXT_FIELDS, words)]
    if (untyped.length) return fail('not_typed', `Not in the user's words: ${untyped.slice(0, 5).join(', ')}${untyped.length > 5 ? ` and ${untyped.length - 5} more` : ''}. Pass values only as the user wrote them, and leave out a field they did not give.`)
    if (!ctx.prisma || !ctx.tenantId) return fail('setup_unavailable', 'The workspace records cannot be read just now; answer in prose and point to the import page.')
    let records
    try {
      records = await setupRecords(ctx, itemsIn)
    } catch {
      return fail('setup_unavailable', 'The workspace records cannot be read just now; answer in prose and point to the import page.')
    }
    const workspaceCurrency = currencyCode(text(ctx.workspaceCurrency).toUpperCase()) || 'USD'
    const suppliers = supplierRows(suppliersIn, records)
    const items = itemRows(itemsIn, records, suppliers, workspaceCurrency)
    const named = new Set(items.map((row) => row.preferredSupplier.supplierId).filter(Boolean))
    // The suppliers an item may be linked to: those the card names first, then by name.
    const supplierOptions = records.suppliers.filter((row) => row.active && row.name)
      .sort((a, b) => Number(named.has(b.id)) - Number(named.has(a.id)) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((row) => ({ id: row.id, name: row.name.slice(0, 200), currency: row.currency }))
    const props = {
      formId: `${ctx.threadId}:${ctx.messageId}:${ctx.partId}`,
      suppliers,
      items,
      codeSeed: codeSeedOf(records.suppliers.map((row) => row.code), suppliers.map((row) => row.code.value)),
      paymentTerms: records.terms.slice(0, 30).map((term) => ({ code: term.code.slice(0, 64), label: (term.name || term.code).slice(0, 120) })),
      supplierOptions,
      workspaceCurrency,
      canCreateSuppliers: mayAddSuppliers,
      canCreateItems: mayAddItems,
    }
    const refs = [...suppliers, ...items].flatMap((row) => row.problems.map((entry) => entry.ref)).filter(Boolean)
    return part('setup_form', props, refs)
  },
})

// ---------------------------------------------------------------- record actions

// The record card (offer_record_actions): the steps on a purchase request or
// purchase order this user may take now, each done with the user's own click
// in the card (and a second, confirming click for anything past submitting a
// draft) through the procurement routes, with the user's session. The
// assistant never takes a step (owner decision of 2026-11-04: approving and
// turning a request into an order may happen in the chat, but a person always
// presses the button). The steps' permissions are the routes' own
// (PURCHASE_REQUEST_PERMISSIONS, PURCHASE_ORDER_COMMANDS) and the status each
// starts from is the commands' (RECORD_ACTION_RULES, which a test pins to
// them); only its requester submits a request. The card is built from the
// record as stored in the user's workspace, never from the model's words.
const RECORD_STEP_PERMISSIONS = Object.freeze({
  purchase_request: Object.freeze({
    submit: PURCHASE_REQUEST_PERMISSIONS.submit,
    approve: PURCHASE_REQUEST_PERMISSIONS.approve,
    reject: PURCHASE_REQUEST_PERMISSIONS.reject,
    create_rfq: PURCHASE_REQUEST_PERMISSIONS.createRfq,
    create_po: PURCHASE_REQUEST_PERMISSIONS.createPurchaseOrders,
  }),
  purchase_order: Object.freeze({
    approve: PURCHASE_ORDER_COMMANDS.approve.permission,
    issue: PURCHASE_ORDER_COMMANDS.issue.permission,
  }),
})
const RECORD_LINES_SHOWN = 3
const mayTakeRecordSteps = (actor) => Object.values(RECORD_STEP_PERMISSIONS).some((steps) => Object.values(steps).some((permission) => allowedTo(actor, permission)))
const actorUserId = (actor) => text(actor?.user?.id || actor?.userId)
// A stored decimal (Prisma's Decimal, a string or a number) as a number, or null.
const decimalOf = (value) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(typeof value === 'object' ? String(value) : value)
  return Number.isFinite(number) ? number : null
}
const metaOf = (row) => (isObject(row?.metadata) ? row.metadata : {})

// The record as stored in the user's workspace, with its lines; for an
// approved request also whether a purchase order or an open RFQ already
// comes from it (the routes then refuse another, assertNoActiveDownstream).
async function storedActionRecord({ prisma, tenantId }, ref) {
  const include = { lines: { orderBy: { id: 'asc' } } }
  if (ref.type === 'purchase_order') {
    const row = await prisma.purchaseOrder.findFirst({ where: { id: ref.id, tenantId }, include })
    return row ? { row, downstream: false } : null
  }
  const row = await prisma.purchaseRequest.findFirst({ where: { id: ref.id, tenantId }, include })
  if (!row) return null
  if (row.status !== PURCHASE_REQUEST_STATUS.APPROVED) return { row, downstream: false }
  const [order, rfq] = await Promise.all([
    prisma.purchaseOrder.findFirst({ where: { tenantId, sourceRequestId: row.id, status: { not: PURCHASE_ORDER_STATUS.CANCELLED } }, select: { id: true } }),
    prisma.rfq.findFirst({ where: { tenantId, sourceRequestId: row.id, status: { notIn: [RFQ_STATUS.CANCELLED, RFQ_STATUS.CLOSED] } }, select: { id: true } }),
  ])
  return { row, downstream: Boolean(order || rfq) }
}

// The path the recommendation route gives the request once approved
// (recommendProcurementPath with the route's policy), with its reasons as
// codes. The amount threshold is left out for a role that cannot see amounts.
function recordPath(row, amountsVisible) {
  const { recommendation, policySnapshot: snapshot } = recommendProcurementPath({ ...mapPurchaseRequest(row), status: PURCHASE_REQUEST_STATUS.APPROVED }, PROCUREMENT_PATH_POLICY, {}, {})
  const reasons = [
    !snapshot.supplierSelected && 'supplier_not_selected',
    !snapshot.validPriceAvailable && 'price_missing',
    snapshot.rfqRequiredByPolicy && amountsVisible && 'amount_over_rfq_threshold',
    (snapshot.newSupplier || snapshot.newItem || snapshot.highRiskSupplier) && 'new_or_high_risk',
  ].filter(Boolean)
  return { recommendation: recommendation === 'rfq' ? 'rfq' : 'direct_po', reasons: recommendation === 'rfq' ? reasons : ['direct_po_ok'] }
}

// Who can take the step this user cannot, for the model to say.
const RECORD_STEP_WHO = Object.freeze({
  submit: 'its requester, with a role that may create purchase requests (a buyer or manager)',
  approve: 'a manager or administrator whose role may approve',
  reject: 'a manager or administrator whose role may approve',
  create_rfq: 'a buyer or manager whose role may create purchase orders',
  create_po: 'a buyer or manager whose role may create purchase orders',
  issue: 'a buyer or manager whose role may create purchase orders',
})

// Why the card offers nothing, worded for the model: the record's status and
// who can take its next step, or that it has none.
function nothingToOffer(type, status, label, { steps, downstream, poBlocked }) {
  const waiting = Object.entries(RECORD_ACTION_RULES[type]).filter(([, from]) => from === status).map(([step]) => step)
  const kind = type === 'purchase_request' ? 'purchase request' : 'purchase order'
  if (!waiting.length) return fail('nothing_to_offer', `${label} is ${status.replace(/_/g, ' ')}; no step of this ${kind} can be taken in the chat. Give its status and link it; do not show a card.`)
  if (downstream) return fail('nothing_to_offer', `A purchase order or an open RFQ already comes from ${label}. Say so and link the request; do not show a card.`)
  if (poBlocked && waiting.every((step) => step === 'create_po' || step === 'create_rfq') && steps.includes('create_po')) return fail('nothing_to_offer', `Every line of ${label} needs a supplier, a currency and a delivery warehouse before a purchase order can be created. Say that the user completes the request on its page first; link it.`)
  const who = [...new Set(waiting.filter((step) => step !== 'create_rfq').map((step) => RECORD_STEP_WHO[step]))].join(', or ')
  return fail('not_allowed', `${label} is ${status.replace(/_/g, ' ')}. This user cannot take its next step; it is for ${who}. Say who can, naming ${label} so its link shows; do not show a card.`)
}

const offerRecordActions = defineUiTool({
  name: 'offer_record_actions',
  description: 'Show a card for one purchase request or purchase order from a data tool result of this answer (source and its ref), with the steps this user may take on it now: submit a draft request for approval (its requester), approve or reject a submitted request, turn an approved request into a purchase order or request quotes (RFQ) for it, approve a purchase order or mark it issued. The user takes each step with their own click and a confirm in the card; nothing happens until they do. The server reads the record as stored and offers only what the user\'s role and the record\'s status allow; when there is nothing the user may do, the tool says who can.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { ...sourceParam, description: 'The source of a data tool result of this answer that holds the record, for example list_purchase_requests#1.' },
      ref: { ...refParam, description: 'The ref of the purchase request or purchase order in that result.' },
    },
    required: ['source', 'ref'],
    additionalProperties: false,
  },
  // Offered to a role that may take at least one of the steps.
  available: (actor) => mayTakeRecordSteps(actor),
  async build(input, ctx) {
    const actor = ctx?.actor
    if (!mayTakeRecordSteps(actor)) return fail('not_allowed', 'This user\'s role can take no step on purchase requests or purchase orders. Say that a buyer submits and orders requests and a manager approves them, and link the record; do not show a card.')
    if (!RECORD_ACTION_TYPES.includes(input.ref.type)) return fail('wrong_ref_type', `offer_record_actions takes a purchase_request or purchase_order ref; ${input.ref.type} is neither.`)
    const source = sourceOf(ctx, input.source)
    if (source.error) return source
    const found = pickRefs(source, [input.ref], input.source)
    if (found.error) return found
    const [{ ref }] = found.picked
    if (!ctx.prisma || !ctx.tenantId) return fail('record_unavailable', `${ref.label} cannot be read just now; link it and say the user can act on its page.`)
    let stored
    try {
      stored = await storedActionRecord(ctx, ref)
    } catch {
      return fail('record_unavailable', `${ref.label} cannot be read just now; link it and say the user can act on its page.`)
    }
    if (!stored) return fail('record_unavailable', `${ref.label} is not a record of this workspace the user can act on. Say so; do not show a card.`)
    const { row, downstream } = stored
    const type = ref.type
    const status = fold(row.status)
    if (!isCode(status)) return fail('record_unavailable', `${ref.label} has no status the card can read; link it instead.`)
    const amountsVisible = Boolean(aiSkillVisibility(actor).amounts.purchase_order_amounts)
    const requester = type === 'purchase_request' && text(row.requester) === actorUserId(actor)
    // Every step the user's role permits here, whatever the status: the card
    // offers again from these after each click.
    const steps = Object.entries(RECORD_STEP_PERMISSIONS[type])
      .filter(([step, permission]) => allowedTo(actor, permission) && (step !== 'submit' || requester) && !(downstream && (step === 'create_po' || step === 'create_rfq')))
      .map(([step]) => step)
    const lines = array(row.lines)
    const sourcing = type === 'purchase_request' && steps.some((step) => step === 'create_po' || step === 'create_rfq')
    const path = sourcing ? recordPath(row, amountsVisible) : null
    // What createPurchaseOrdersFromPurchaseRequest refuses (DIRECT_PO_NOT_ALLOWED).
    const poBlocked = sourcing && (!lines.length || lines.some((line) => ['supplierId', 'currency', 'targetWarehouseId'].some((field) => !text(metaOf(line)[field])))) ? 'lines_incomplete' : null
    const actions = recordActionsNow({ type, status, allowed: steps, path, poBlocked })
    if (!actions.length) return nothingToOffer(type, status, ref.label, { steps: Object.keys(RECORD_STEP_PERMISSIONS[type]).filter((step) => allowedTo(actor, RECORD_STEP_PERMISSIONS[type][step])), downstream, poBlocked })
    const suppliers = [...new Set([text(row.supplierName), ...lines.map((line) => text(metaOf(line).supplierSnapshot?.supplierName))].filter(Boolean))].slice(0, 3).map((name) => name.slice(0, 200))
    const amount = decimalOf(row.amount)
    const currency = currencyCode(text(row.currency).toUpperCase())
    const version = type === 'purchase_order' ? Number(row.version ?? 0) : Number(metaOf(row).version ?? 0)
    const record = {
      ref,
      type,
      status,
      version: Number.isInteger(version) && version >= 0 ? version : 0,
      suppliers,
      lines: lines.slice(0, RECORD_LINES_SHOWN).map((line) => ({
        sku: text(line.sku).slice(0, 120) || null,
        name: text(line.itemName).slice(0, 200),
        quantity: decimalOf(type === 'purchase_order' ? line.orderedQuantity : line.quantity),
        unit: text(line.unit).slice(0, 20) || null,
      })),
      lineCount: lines.length,
      ...(amountsVisible && amount !== null && currency ? { amount: { amount, currency } } : {}),
    }
    const props = {
      cardId: `${ctx.threadId}:${ctx.messageId}:${ctx.partId}`,
      source: source.id,
      record,
      allowed: steps,
      actions,
      ...(path ? { path } : {}),
      ...(poBlocked ? { poBlocked } : {}),
    }
    return part('record_actions', props, [ref])
  },
})

const FOLLOWUP_LENGTH = 90

const suggestFollowups = defineUiTool({
  name: 'suggest_followups',
  description: `Offer 1 to 3 short next steps the user might ask or tell you next, about their own records (an action before a question about a concept), in the answer's language, each at most ${FOLLOWUP_LENGTH} characters. A chip is sent as the user's message the moment it is clicked, so each is a complete request that makes sense as it is, never the start of a sentence for the user to finish ("Here are my suppliers:"). Only when the answer has a clear next step, and not when it asks the user something. Never a claim that something was done.`,
  inputSchema: {
    type: 'object',
    properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 400 } } },
    required: ['questions'],
    additionalProperties: false,
  },
  build(input) {
    const questions = [...new Set(input.questions.map((question) => question.replace(/\s+/g, ' ').trim()))]
    if (questions.some((question) => !question)) return fail('invalid_input', 'A question is empty.')
    const long = questions.find((question) => question.length > FOLLOWUP_LENGTH)
    if (long) return fail('too_long', `Each question is at most ${FOLLOWUP_LENGTH} characters; "${long.slice(0, 40)}..." has ${long.length}.`)
    return part('followups', { questions }, [])
  },
})

export const AI_ASSISTANT_V2_UI_TOOLS = Object.freeze([showTable, showRecords, showChart, showKpis, offerChoices, suggestPurchaseRequest, showSetupSteps, suggestSetupRecords, offerRecordActions, suggestFollowups])

// The UI tools the model is offered for this user (design §4.1: the request
// form is not offered to a user who may not create requests, nor the setup
// card to one who may add neither suppliers nor items).
export function aiUiToolsFor(actor) {
  return AI_ASSISTANT_V2_UI_TOOLS.filter((entry) => entry.available(actor))
}
