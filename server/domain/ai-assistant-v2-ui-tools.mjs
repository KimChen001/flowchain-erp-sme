import { CHART_KINDS, CHOICE_PROMPTS, RECORD_EMPHASES, refSchema, safeParsePartProps } from '../../shared/assistant-protocol.mjs'
import { PURCHASE_SUGGESTION_SOURCES, suggestNeedByDate } from '../../shared/purchase-suggestion.mjs'
import { AI_READ_TOOL_COLUMNS } from './ai-read-tool-runner.mjs'
import { aiSkillVisibility } from './ai-skill-registry.mjs'

// The UI tools of assistant v2 (docs/ai-assistant-v2-design.md §3.6, §4, §4.1,
// §5.2). The model never writes a figure: it names a data tool result of this
// answer (its tool_use id) and the columns, refs or keys to show, and the
// server builds the part's props from that result's rows. A column must be one
// the data tool declares (AI_READ_TOOL_COLUMNS), a ref must be in the result,
// and the props must pass the stream protocol, or the model gets an error in
// English to correct its call.
//
// build(input, ctx) with ctx = { results: Map<toolUseId, { tool, output }>,
// facts, actor, language, threadId, messageId, partId, userNamedSkus } returns
// { component, props, refs } or { error: { code, message } }. `output` is the
// data tool's result as the model read it.

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

const sourceParam = { type: 'string', minLength: 1, maxLength: 120, description: 'The tool_use id of a data tool call in this answer whose result is shown.' }
// A ref as the result gives it; the label is the result's, so the model's is not used.
const refParam = { type: 'object', properties: { type: { type: 'string', minLength: 1, maxLength: 40 }, id: { type: 'string', minLength: 1, maxLength: 120 }, label: { type: 'string', maxLength: 200 } }, required: ['type', 'id'], additionalProperties: false }
const titleParam = { type: 'string', minLength: 1, maxLength: 120, description: 'A short heading in the answer\'s language.' }
const listParam = { type: 'string', minLength: 1, maxLength: 64, description: 'Which list of the result when it has several (for example months or suppliers of spend_analysis). By default the first list that has every column.' }

// The data tool result a UI tool names: one of this answer's, from a data tool.
function sourceOf(ctx, id) {
  const entry = ctx?.results instanceof Map ? ctx.results.get(id) : undefined
  if (!entry) return fail('source_missing', `No tool result has the id ${id} in this answer. Call a data tool first and pass its tool_use id as source.`)
  if (!AI_READ_TOOL_COLUMNS[entry.tool]) return fail('source_not_data', `${id} is a ${entry.tool} call; source must be a data tool result.`)
  if (!isObject(entry.output) || entry.output.error) return fail('source_failed', `The ${entry.tool} call ${id} returned no result to show.`)
  return { tool: entry.tool, output: entry.output }
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
})
const QUANTITY_COLUMNS = new Set([
  'ordered', 'received', 'remaining', 'onHand', 'reserved', 'available', 'openSalesDemand', 'incomingOnPurchaseOrders', 'availableToPromise', 'shortage',
  'safetyStock', 'reorderPoint', 'incoming', 'demand', 'endAvailable', 'quantity', 'rejected', 'stillToReceive', 'withoutTheseLines', 'additionalShortfall',
  'position', 'shortfall', 'minimumOrderQuantity', 'requestQuantity', 'orderedQuantity', 'averageDailyDemand', 'suggestedQuantity.value',
])
const STATUS_COLUMNS = new Set(['status', 'postingStatus', 'matchStatus', 'state', 'disputeStatus', 'severity', 'whenKind', 'suggestedQuantity.source'])
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
const keyIn = (keys, name) => keys.find((key) => key === name || aiUiColumnCode(key) === name || snakeCase(key) === name)
const describeColumns = (tool) => declaredOf(tool).map(([path, keys]) => `${path || 'result'}: ${keys.join(', ')}`).join('; ')

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
// checks again, so a tool offered by mistake still refuses.
const defineUiTool = ({ name, description, inputSchema, available = () => true, build }) => Object.freeze({
  name,
  kind: 'ui',
  description,
  inputSchema: Object.freeze(inputSchema),
  available,
  build(input, ctx) {
    const problem = invalidInput(inputSchema, input)
    return problem ? fail('invalid_input', `${problem}.`) : build(input, ctx)
  },
})

const compare = (left, right) => (numberOf(left) !== null && numberOf(right) !== null ? numberOf(left) - numberOf(right) : String(left).localeCompare(String(right), 'en', { numeric: true }))

const showTable = defineUiTool({
  name: 'show_table',
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
    const keys = [...new Set(input.columns.map((name) => keyIn(table.keys, name)))]
    const columns = []
    const cells = shown.map(() => ({}))
    for (const key of keys) {
      const kind = columnKind(tool, key, shown.map((row) => valueAt(row, key)), output)
      const code = aiUiColumnCode(key)
      for (const [index, row] of shown.entries()) {
        const cell = cellOf(kind, row, key, output)
        if (cell === undefined) return fail('currency_missing', `${key} in ${input.source} has an amount without a currency; it cannot be shown.`)
        cells[index][code] = cell
      }
      const isRefColumn = kind === 'text' && cells.some((row) => refOf(row[code]))
      columns.push({ code, kind: isRefColumn ? 'ref' : kind })
    }
    // A list cut by the data tool says how many it had in all.
    const total = Math.max(rows.length, table.path === 'rows' && Number.isInteger(output.total) ? output.total : 0)
    const props = { ...(input.title ? { title: input.title } : {}), source: input.source, columns, rows: cells, total, more: total > shown.length }
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
function cardFigures(tool, row, output) {
  const figures = []
  for (const key of CARD_FIGURES) {
    const value = numberOf(at(row, key))
    if (value === null || figures.length === 2) continue
    const unit = NUMERIC_KINDS[columnKind(tool, key, [value], output)]
    if (!unit) continue
    const currency = unit === 'money' ? currencyBeside(row, key, output) : null
    if (unit === 'money' && !currency) continue
    const unitLabel = unit === 'quantity' ? [row.unit, row.item?.unit].find((entry) => typeof entry === 'string' && entry && entry.length <= 20) : undefined
    figures.push({ code: aiUiColumnCode(key), value, unit, ...(currency ? { currency } : {}), ...(unitLabel ? { unitLabel } : {}) })
  }
  return figures
}

function cardOf(tool, { ref, row }, output) {
  const title = CARD_TITLES.map((key) => at(row, key)).find((value) => typeof value === 'string' && value.trim() && value !== ref.label)
  const status = CARD_STATUSES.map((key) => row[key]).find(isCode)
  const date = cardDate(row)
  const figures = cardFigures(tool, row, output)
  return { ref, ...(title ? { title: title.slice(0, MAX_TEXT) } : {}), ...(status ? { status: { code: status } } : {}), ...(date ? { date } : {}), ...(figures.length ? { figures } : {}) }
}

const showRecords = defineUiTool({
  name: 'show_records',
  description: 'Show 1 to 6 records of a data tool result as cards: code, label, status, how late or how soon, and one or two of its figures, all from the result. Name each record by the type and id of a ref in that result.',
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
    const cards = found.picked.map((holder) => cardOf(source.tool, holder, source.output))
    return part('records', { source: input.source, ...(input.emphasis ? { emphasis: input.emphasis } : {}), cards }, cards.map((card) => card.ref))
  },
})

const showChart = defineUiTool({
  name: 'show_chart',
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
    const props = { source: input.source, kind: input.kind, ...(input.title ? { title: input.title } : {}), x, series, unit, ...(currency ? { currency } : {}) }
    return part('chart', props, rows.map((row) => refOf(row.ref)))
  },
})

const showKpis = defineUiTool({
  name: 'show_kpis',
  description: 'Show 2 to 6 workspace figures as tiles from a workspace_summary result, by its keys (for example purchaseOrders.overdue). A figure the user may not read shows as not available for their role.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { ...sourceParam, description: 'The tool_use id of a workspace_summary call in this answer.' },
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
    return part('kpis', { source: input.source, tiles }, [])
  },
})

const PROMPT_TYPES = Object.freeze({ pick_item: 'item', pick_supplier: 'supplier' })

const offerChoices = defineUiTool({
  name: 'offer_choices',
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
    return part('choices', { source: input.source, promptCode: input.promptCode, options }, options)
  },
})

// The suggestion engine's codes (shared/purchase-suggestion.mjs and the data
// tool) in the form's terms. A row with no suggested quantity (covered, not
// needed, or no stock position) leaves the quantity to the user, as an item
// added from the search does.
const QUANTITY_SOURCE = Object.freeze({
  [PURCHASE_SUGGESTION_SOURCES.reorderGap]: 'reorder_gap',
  [PURCHASE_SUGGESTION_SOURCES.raisedToMoq]: 'reorder_gap_raised_to_moq',
  [PURCHASE_SUGGESTION_SOURCES.userTyped]: 'user_named',
})
const SUPPLIER_SOURCE = Object.freeze({ preferred_supplier: 'preferred', only_approved_supplier: 'only_approved' })
const canDraft = (actor) => aiSkillVisibility(actor).canDraft
const MAX_FORM_LINES = 8

function suggestedQuantity(row) {
  const { value, source } = isObject(row.suggestedQuantity) ? row.suggestedQuantity : {}
  if (!isNumber(value) || value <= 0 || !QUANTITY_SOURCE[source]) return { value: null, source: 'user_named' }
  return { value, source: QUANTITY_SOURCE[source], ...(source === PURCHASE_SUGGESTION_SOURCES.raisedToMoq ? { minimum: value } : {}) }
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

// One form row. The model's quantity, supplier and date count only for an
// item the user named; otherwise every value is the server's.
function formRow(row, output, { named, line }) {
  const price = referencePrice(row, output)
  const suppliers = approvedSuppliers(row, output, price)
  const chosen = isObject(row.supplier) && !output.suppliersHidden ? row.supplier : null
  let supplier = chosen && SUPPLIER_SOURCE[chosen.source] ? { id: chosen.id, name: chosen.name, source: SUPPLIER_SOURCE[chosen.source] } : null
  let estimatedUnitPrice = price
  let lead = row.needByDate?.leadTimeDays ?? null
  let shortWeekOf = isDay(row.needByDate?.warning?.weekOf) ? row.needByDate.warning.weekOf : null
  let leadDate = row.needByDate?.source === PURCHASE_SUGGESTION_SOURCES.leadTime && isDay(row.needByDate.value) ? row.needByDate.value : null
  if (named && line?.supplier) {
    const picked = matchSupplier(suppliers, line.supplier)
    if (!picked) return fail('supplier_not_listed', `${line.supplier} is not among the approved suppliers the result lists for ${row.item.sku} (${suppliers.map((entry) => entry.name).join(', ') || 'none'}). Leave supplier out; the user can choose in the form.`)
    supplier = { id: picked.id, name: picked.name, source: 'user_named' }
    if (!chosen || picked.id !== chosen.id) {
      // That supplier's own price and lead time; the need-by date follows its
      // lead time as the form does when the user changes the supplier.
      estimatedUnitPrice = picked.unitPrice !== null && picked.unitPrice !== undefined ? { value: picked.unitPrice, currency: picked.currency, source: 'reference_price' } : { value: null, currency: null, source: price.source === 'masked' ? 'masked' : 'missing' }
      const moved = suggestNeedByDate({ today: output.today, leadTimeDays: picked.leadTimeDays ?? null, firstShortWeek: shortWeekOf })
      lead = moved.leadTimeDays
      leadDate = moved.source === PURCHASE_SUGGESTION_SOURCES.leadTime ? moved.value : null
      shortWeekOf = moved.warning?.weekOf ?? null
    }
  }
  const needByDate = named && line?.needByDate
    ? { value: line.needByDate, source: 'user_named', leadTimeDays: lead, shortWeekOf }
    : leadDate
      ? { value: leadDate, source: 'lead_time', leadTimeDays: lead, shortWeekOf }
      : { value: output.today, source: 'today', leadTimeDays: null, shortWeekOf }
  const cover = isObject(row.covered) ? refOf(array(row.covered.by)[0]?.ref) : null
  return {
    item: { id: text(row.item.id) || row.ref.id, sku: row.item.sku, name: text(row.item.name), unit: row.item.unit ?? null },
    onHand: row.onHand ?? null,
    safetyStock: row.safetyStock ?? null,
    reorderPoint: row.reorderPoint ?? null,
    suggestedQuantity: named && isNumber(line?.quantity) ? { value: line.quantity, source: 'user_named' } : suggestedQuantity(row),
    supplier,
    suppliers,
    needByDate,
    estimatedUnitPrice,
    warehouse: row.warehouseId ? { id: row.warehouseId, label: row.warehouseId } : null,
    covered: cover ? { ref: cover } : null,
    // Ticked only for an item the user named and nothing already covers.
    checked: named && !row.covered,
  }
}

const suggestPurchaseRequest = defineUiTool({
  name: 'suggest_purchase_request',
  description: 'Show the in-chat purchase request form from a suggest_purchase_lines result (source). from user_named: the items the user named, listed in lines; from suggestions: the suggested items (all, or those listed in lines). Quantity, supplier and need-by date in a line are used only when the user typed them for an item they named; otherwise the server fills every value. Only items the user named are ticked; the user ticks the rest and creates the draft with their own click.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { ...sourceParam, description: 'The tool_use id of a suggest_purchase_lines call in this answer.' },
      from: { type: 'string', enum: ['user_named', 'suggestions'] },
      lines: {
        type: 'array',
        minItems: 0,
        maxItems: MAX_FORM_LINES,
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string', minLength: 1, maxLength: 120 },
            quantity: { type: 'number', exclusiveMinimum: 0, description: 'Only a quantity the user typed.' },
            supplier: { type: 'string', minLength: 1, maxLength: 200, description: 'Only a supplier the user named: its name or id.' },
            needByDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', minLength: 10, maxLength: 10, description: 'Only a date the user gave, YYYY-MM-DD.' },
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
    if (source.tool !== 'suggest_purchase_lines') return fail('wrong_source', `suggest_purchase_request takes a suggest_purchase_lines result; ${input.source} is ${source.tool}.`)
    const { output } = source
    const lines = array(input.lines)
    if (input.from === 'user_named' && !lines.length) return fail('invalid_input', 'from user_named needs the named items in lines.')
    if (lines.some((line) => !missing(line.needByDate) && !isDay(line.needByDate))) return fail('invalid_input', 'needByDate must be a real day.')
    const rows = array(output.rows)
    const bySku = new Map(rows.map((row) => [fold(row.item?.sku), row]))
    const unknown = lines.filter((line) => !bySku.has(fold(line.sku))).map((line) => line.sku)
    if (unknown.length) return fail('foreign_sku', `${unknown.join(', ')} is not in the result of ${input.source} (${rows.map((row) => row.item.sku).join(', ') || 'no rows'}). Call suggest_purchase_lines with those SKUs first.`)
    const linesBySku = new Map(lines.map((line) => [fold(line.sku), line]))
    const chosen = lines.length ? [...new Set(lines.map((line) => bySku.get(fold(line.sku))))] : rows
    // An item that is not active cannot be requested; the answer says why.
    const requestable = chosen.filter((row) => row.suggestedQuantity?.source !== PURCHASE_SUGGESTION_SOURCES.itemInactive)
    if (!requestable.length) return fail('nothing_to_request', `No item in ${input.source} can be requested (inactive or none). Say so instead of showing the form.`)
    if (requestable.length > MAX_FORM_LINES) return fail('too_many_lines', `The form takes up to ${MAX_FORM_LINES} items; list the SKUs to show in lines.`)
    const userNamed = new Set(array(ctx.userNamedSkus).map(fold))
    const named = []
    const suggested = []
    for (const row of requestable) {
      const isNamed = userNamed.has(fold(row.item.sku))
      const built = formRow(row, output, { named: isNamed, line: linesBySku.get(fold(row.item.sku)) })
      if (built.error) return built
      if (isNamed) named.push(built)
      else suggested.push(built)
    }
    const props = { formId: `${ctx.threadId}:${ctx.messageId}:${ctx.partId}`, source: input.source, suggested, lines: named, canCreate: true }
    const refs = requestable.flatMap((row) => [refOf(row.ref), ...array(row.covered?.by).map((entry) => refOf(entry.ref))])
    return part('pr_form', props, refs)
  },
})

const FOLLOWUP_LENGTH = 90

const suggestFollowups = defineUiTool({
  name: 'suggest_followups',
  description: `Offer 1 to 3 short follow-up questions the user might ask next, in the answer's language, each at most ${FOLLOWUP_LENGTH} characters. Questions only: never a claim that something was done.`,
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

export const AI_ASSISTANT_V2_UI_TOOLS = Object.freeze([showTable, showRecords, showChart, showKpis, offerChoices, suggestPurchaseRequest, suggestFollowups])

// The UI tools the model is offered for this user (design §4.1: the request
// form is not offered to a user who may not create requests).
export function aiUiToolsFor(actor) {
  return AI_ASSISTANT_V2_UI_TOOLS.filter((entry) => entry.available(actor))
}
