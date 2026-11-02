// The assistant v2 stream protocol (docs/ai-assistant-v2-design.md §3.7, §4,
// §5.2): one NDJSON line per event, each {v:2, seq, type}. The server writes
// these lines, the panel reads them and the eval checks them, so the shapes
// live here once. The old 'progress' and 'answer' lines keep their fields
// (step and sources; status and body), so the existing parser in
// src/modules/ai-assistant/aiRuntimeGateway.ts reads a v2 stream unchanged.
//
// UI part props are built by the server from tool rows; the model never
// writes a figure. Business names are shown as recorded; every other label
// is a code the client words through i18n.
import { z } from 'zod'

export const PROTOCOL_VERSION = 2
export const PART_SCHEMA_VERSION = 1

export const STREAM_EVENT_TYPES = Object.freeze(['start', 'progress', 'tool', 'text_delta', 'ui', 'flag', 'replace', 'notice', 'error', 'answer'])
export const UI_COMPONENTS = Object.freeze(['table', 'records', 'chart', 'kpis', 'choices', 'pr_form', 'followups', 'citations'])
export const ANSWER_LANGUAGES = Object.freeze(['en-US', 'zh-CN'])
export const PROGRESS_STEPS = Object.freeze(['reading', 'writing', 'checking'])
export const TOOL_STATES = Object.freeze(['running', 'done', 'error'])
export const FLAG_KINDS = Object.freeze(['number', 'date', 'name', 'record'])
export const REPLACE_CODES = Object.freeze(['unbacked_action_claim', 'foreign_record', 'hidden_value'])
export const NOTICE_CODES = Object.freeze(['over_cap', 'over_cap_during_answer', 'cost_ceiling', 'unavailable', 'rate_limited', 'injection_refused', 'cancelled', 'refused'])
export const RECORD_EMPHASES = Object.freeze(['overdue', 'pending', 'info'])
export const CHART_KINDS = Object.freeze(['line', 'bar', 'stacked_bar'])
export const VALUE_UNITS = Object.freeze(['count', 'quantity', 'money', 'percent', 'days'])
export const CHOICE_PROMPTS = Object.freeze(['pick_item', 'pick_supplier', 'pick_record'])
export const RELATIVE_DATE_KINDS = Object.freeze(['overdue', 'due', 'waiting', 'on'])
export const STATUS_TONES = Object.freeze(['danger', 'warning', 'success', 'info', 'neutral'])
// Where a suggested quantity came from (shared quantity engine, V2-5).
export const QUANTITY_SOURCES = Object.freeze(['user_named', 'reorder_gap', 'reorder_gap_raised_to_moq'])
export const SUPPLIER_SOURCES = Object.freeze(['preferred', 'only_approved', 'user_named'])
export const NEED_BY_SOURCES = Object.freeze(['lead_time', 'user_named', 'today'])
export const PRICE_SOURCES = Object.freeze(['reference_price', 'masked', 'missing'])

const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const id = z.string().min(1).max(120)
const label = z.string().min(1).max(200)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const currency = z.string().regex(/^[A-Z]{3}$/)
const amount = z.number().finite()
// A route inside the app (a module list or a report), never a URL.
const route = z.object({ moduleId: z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/).max(80), query: z.record(z.string(), z.string().max(200)).optional() })

// A record the answer may name: its type, id and the code people read.
export const refSchema = z.object({ type: z.string().regex(/^[a-z][a-z_]{1,39}$/), id, label: z.string().min(1).max(120) })

const status = z.object({ code, tone: z.enum(STATUS_TONES).optional() })
const money = z.object({ amount: amount.nullable(), currency })
// A table cell: text or a number as recorded, a record, an amount in its own
// currency, or null for a value that is missing or hidden for the role.
const cell = z.union([z.string().max(200), amount, z.null(), refSchema, money, status])

const tableProps = z.object({
  title: z.string().max(120).optional(),
  source: id.optional(),
  columns: z.array(z.object({ code, kind: z.enum(['text', 'number', 'quantity', 'money', 'percent', 'days', 'date', 'status', 'ref']) })).min(1).max(8),
  rows: z.array(z.record(z.string(), cell)).max(50),
  total: z.number().int().nonnegative(),
  more: z.boolean(),
  listRoute: route.optional(),
}).refine((props) => props.total >= props.rows.length, { message: 'total is below the rows shown', path: ['total'] })

const figure = z.object({ code, value: amount.nullable(), unit: z.enum(VALUE_UNITS), currency: currency.optional(), unitLabel: z.string().max(20).optional() })

const recordsProps = z.object({
  source: id.optional(),
  emphasis: z.enum(RECORD_EMPHASES).optional(),
  cards: z.array(z.object({
    ref: refSchema,
    title: z.string().max(200).optional(),
    status: status.optional(),
    date: z.object({ kind: z.enum(RELATIVE_DATE_KINDS), days: z.number().int().nonnegative().optional(), value: day.optional() }).optional(),
    figures: z.array(figure).max(2).optional(),
  })).min(1).max(6),
})

// One currency per chart: series never carry their own, so amounts in two
// currencies cannot share an axis.
const chartProps = z.object({
  source: id.optional(),
  kind: z.enum(CHART_KINDS),
  title: z.string().max(120).optional(),
  x: z.object({ code, values: z.array(z.string().max(60)).min(1).max(60) }),
  series: z.array(z.object({ code, name: z.string().max(120).optional(), values: z.array(amount.nullable()) })).min(1).max(4),
  unit: z.enum(VALUE_UNITS),
  currency: currency.optional(),
  reportRoute: route.optional(),
}).superRefine((props, ctx) => {
  if (props.unit === 'money' && !props.currency) ctx.addIssue({ code: 'custom', message: 'a money chart names its currency', path: ['currency'] })
  if (props.unit !== 'money' && props.currency) ctx.addIssue({ code: 'custom', message: 'only a money chart has a currency', path: ['currency'] })
  props.series.forEach((series, index) => {
    if (series.values.length !== props.x.values.length) ctx.addIssue({ code: 'custom', message: 'one value per x value', path: ['series', index, 'values'] })
  })
})

// A tile hidden for the role carries no value, so a builder slip cannot put it on screen.
const kpisProps = z.object({
  source: id.optional(),
  tiles: z.array(z.object({ code, value: amount.nullable(), unit: z.enum(VALUE_UNITS), currency: currency.optional(), hidden: z.boolean().optional(), route: route.optional() })
    .refine((tile) => !tile.hidden || tile.value === null, { message: 'a hidden tile has no value', path: ['value'] })).min(2).max(6),
})

const choicesProps = z.object({ source: id.optional(), promptCode: z.enum(CHOICE_PROMPTS), options: z.array(refSchema).min(2).max(6) })

const followupsProps = z.object({ questions: z.array(z.string().min(1).max(90)).min(1).max(3) })

const citationsProps = z.object({
  source: id.optional(),
  passages: z.array(z.object({ id, title: z.string().max(200), excerpt: z.string().max(1200), documentId: id.optional() })).min(1).max(5),
})

const approvedSupplier = z.object({
  id, name: label, preferred: z.boolean(),
  leadTimeDays: z.number().int().nonnegative().nullable().optional(),
  // The supplier's master-data reference price; null when missing or hidden for the role.
  unitPrice: amount.nonnegative().nullable().optional(),
  currency: currency.nullable().optional(),
})

// One line of the in-chat purchase request form (§4.1). Every value comes
// from the server with the code of where it came from.
export const prFormRowSchema = z.object({
  item: z.object({ id, sku: z.string().min(1).max(120), name: z.string().max(200), unit: z.string().max(20).nullable().optional() }),
  onHand: amount.nullable().optional(),
  safetyStock: amount.nullable().optional(),
  reorderPoint: amount.nullable().optional(),
  suggestedQuantity: z.object({ value: amount.positive().nullable(), source: z.enum(QUANTITY_SOURCES), minimum: amount.positive().nullable().optional() }),
  supplier: z.object({ id, name: label, source: z.enum(SUPPLIER_SOURCES) }).nullable(),
  suppliers: z.array(approvedSupplier).max(20).optional(),
  needByDate: z.object({ value: day, source: z.enum(NEED_BY_SOURCES), leadTimeDays: z.number().int().nonnegative().nullable().optional(), shortWeekOf: day.nullable().optional() }),
  orderByDate: day.nullable().optional(),
  // A masked or missing price has no value, and a reference price has one, so a
  // price hidden for the role never reaches the browser.
  estimatedUnitPrice: z.object({ value: amount.nonnegative().nullable(), currency: currency.nullable(), source: z.enum(PRICE_SOURCES) })
    .refine((price) => (price.source === 'reference_price') === (price.value !== null), { message: 'only a reference price has a value', path: ['value'] }),
  warehouse: z.object({ id, label }).nullable().optional(),
  // An open request or order already covers the item.
  covered: z.object({ ref: refSchema }).nullable(),
  checked: z.boolean(),
})

const prFormProps = z.object({
  formId: z.string().min(1).max(160),
  source: id.optional(),
  suggested: z.array(prFormRowSchema).max(8),
  lines: z.array(prFormRowSchema).max(8),
  canCreate: z.boolean(),
  departmentId: id.optional(),
})

export const partPropsSchemas = Object.freeze({
  table: tableProps,
  records: recordsProps,
  chart: chartProps,
  kpis: kpisProps,
  choices: choicesProps,
  pr_form: prFormProps,
  followups: followupsProps,
  citations: citationsProps,
})

const envelope = { v: z.literal(PROTOCOL_VERSION), seq: z.number().int().nonnegative() }
const partId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)

const uiEvents = UI_COMPONENTS.map((component) => z.object({
  ...envelope,
  type: z.literal('ui'),
  partId,
  component: z.literal(component),
  schemaVersion: z.literal(PART_SCHEMA_VERSION),
  props: partPropsSchemas[component],
  refs: z.array(refSchema).max(60),
}))

// The final body is the AiResponseV2 the panel already renders, plus the
// order of the parts streamed before it.
const answerBody = z.looseObject({
  parts: z.array(z.object({ id: partId, type: z.enum(['text', 'ui']), component: z.enum(UI_COMPONENTS).optional() })).optional(),
})

export const streamEventSchema = z.union([
  z.object({ ...envelope, type: z.literal('start'), threadId: id, messageId: id, model: z.string().min(1).max(80), language: z.enum(ANSWER_LANGUAGES) }),
  z.object({ ...envelope, type: z.literal('progress'), step: z.enum(PROGRESS_STEPS), sources: z.array(code).max(20).optional() }),
  z.object({ ...envelope, type: z.literal('tool'), id, name: code, state: z.enum(TOOL_STATES), rows: z.number().int().nonnegative().optional() }),
  z.object({ ...envelope, type: z.literal('text_delta'), partId, text: z.string().max(4000) }),
  ...uiEvents,
  z.object({ ...envelope, type: z.literal('flag'), partId, spans: z.array(z.object({ text: z.string().min(1).max(200), kind: z.enum(FLAG_KINDS), reason: code })).max(50) }),
  z.object({ ...envelope, type: z.literal('replace'), partId, text: z.string().max(4000), code: z.enum(REPLACE_CODES) }),
  z.object({ ...envelope, type: z.literal('notice'), code: z.enum(NOTICE_CODES) }),
  z.object({ ...envelope, type: z.literal('error'), code, retryable: z.boolean() }),
  z.object({ ...envelope, type: z.literal('answer'), status: z.number().int().min(100).max(599), body: answerBody }),
])

export function parseStreamEvent(value) {
  return streamEventSchema.parse(value)
}

export function safeParseStreamEvent(value) {
  return streamEventSchema.safeParse(value)
}

// One NDJSON line; a line that is not JSON fails like a malformed event.
export function safeParseStreamLine(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return { success: false, error: new z.ZodError([{ code: 'custom', message: 'not JSON', path: [], input: line }]) }
  }
  return safeParseStreamEvent(value)
}

export function isUiComponent(component) {
  return UI_COMPONENTS.includes(component)
}

export function parsePartProps(component, props) {
  if (!isUiComponent(component)) throw new Error(`Unknown UI component: ${component}`)
  return partPropsSchemas[component].parse(props)
}

export function safeParsePartProps(component, props) {
  if (!isUiComponent(component)) return { success: false, error: new z.ZodError([{ code: 'custom', message: 'unknown component', path: ['component'], input: component }]) }
  return partPropsSchemas[component].safeParse(props)
}
