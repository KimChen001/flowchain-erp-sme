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
export const UI_COMPONENTS = Object.freeze(['table', 'records', 'chart', 'kpis', 'choices', 'pr_form', 'followups', 'citations', 'setup_steps', 'setup_form'])
export const ANSWER_LANGUAGES = Object.freeze(['en-US', 'zh-CN'])
export const PROGRESS_STEPS = Object.freeze(['reading', 'writing', 'checking'])
export const TOOL_STATES = Object.freeze(['running', 'done', 'error'])
export const FLAG_KINDS = Object.freeze(['number', 'date', 'name', 'record'])
export const REPLACE_CODES = Object.freeze(['unbacked_action_claim', 'foreign_record', 'hidden_value'])
// too_long_for_rules: assistant v2 handed a question back to the rules (over
// the cap, or the provider down) that is longer than the rules can read.
export const NOTICE_CODES = Object.freeze(['over_cap', 'over_cap_during_answer', 'cost_ceiling', 'unavailable', 'rate_limited', 'injection_refused', 'cancelled', 'refused', 'too_long_for_rules'])
// The longest question each path reads, in characters: assistant v2 takes
// rows pasted from a spreadsheet; the rules and the model-first loop do not.
export const QUESTION_LIMITS = Object.freeze({ rules: 1200, assistantV2: 8000 })
export const RECORD_EMPHASES = Object.freeze(['overdue', 'pending', 'info'])
export const CHART_KINDS = Object.freeze(['line', 'bar', 'stacked_bar'])
export const VALUE_UNITS = Object.freeze(['count', 'quantity', 'money', 'percent', 'days'])
export const CHOICE_PROMPTS = Object.freeze(['pick_item', 'pick_supplier', 'pick_record'])
export const RELATIVE_DATE_KINDS = Object.freeze(['overdue', 'due', 'waiting', 'on'])
export const STATUS_TONES = Object.freeze(['danger', 'warning', 'success', 'info', 'neutral'])
// Where a suggested quantity came from (shared quantity engine, V2-5).
export const QUANTITY_SOURCES = Object.freeze(['user_named', 'reorder_gap', 'reorder_gap_raised_to_moq', 'cover_days', 'cover_days_raised_to_moq', 'none'])
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

// A supplier the line may use. link "new": an active supplier of the
// workspace that is not yet an approved supplier of the item; the form adds
// it as one (approved, not preferred) when the user clicks Create. Its lead
// time and price are then the ones the user typed, or null.
export const NEW_SUPPLIER_LINK = 'new'
const supplierLink = z.literal(NEW_SUPPLIER_LINK)
const approvedSupplier = z.object({
  id, name: label, preferred: z.boolean(),
  leadTimeDays: z.number().int().nonnegative().nullable().optional(),
  // The supplier's master-data reference price; null when missing or hidden for the role.
  unitPrice: amount.nonnegative().nullable().optional(),
  currency: currency.nullable().optional(),
  link: supplierLink.optional(),
})

// One line of the in-chat purchase request form (§4.1). Every value comes
// from the server with the code of where it came from.
export const prFormRowSchema = z.object({
  item: z.object({ id, sku: z.string().min(1).max(120), name: z.string().max(200), unit: z.string().max(20).nullable().optional() }),
  onHand: amount.nullable().optional(),
  safetyStock: amount.nullable().optional(),
  reorderPoint: amount.nullable().optional(),
  suggestedQuantity: z.object({ value: amount.positive().nullable(), source: z.enum(QUANTITY_SOURCES), minimum: amount.positive().nullable().optional(), coverDays: z.number().int().positive().optional() }),
  supplier: z.object({ id, name: label, source: z.enum(SUPPLIER_SOURCES), link: supplierLink.optional() }).nullable(),
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
  // The user may add approved suppliers to items (master_data.item.manage):
  // the form then offers the workspace's other active suppliers, and the
  // currency a new supplier's price defaults to when it records none.
  canLinkSuppliers: z.boolean().optional(),
  workspaceCurrency: currency.optional(),
})

// The first-day checklist, as Today shows it (server/domain/today-work.mjs):
// each step done by a real count, and the page that does it while the user
// may (the import page for bulk data when import is on).
export const SETUP_STEP_IDS = Object.freeze(['items', 'suppliers', 'customers', 'opening_stock', 'teammates'])
export const SETUP_STEP_BLOCKS = Object.freeze(['permission', 'unavailable'])
const setupStepsProps = z.object({
  source: id.optional(),
  steps: z.array(z.object({ id: z.enum(SETUP_STEP_IDS), done: z.boolean(), count: z.number().int().nonnegative(), blocked: z.enum(SETUP_STEP_BLOCKS).optional(), route: route.optional() })).min(1).max(SETUP_STEP_IDS.length),
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  // Items still missing what the reorder suggestions need; absent when the
  // role cannot read inventory.
  gaps: z.object({ checked: z.number().int().nonnegative(), unit: z.number().int().nonnegative(), preferredSupplier: z.number().int().nonnegative(), thresholds: z.number().int().nonnegative() }).optional(),
})

// The in-chat setup card (suggest_setup_records): new suppliers and items the
// user typed or pasted, each value with where it came from, and what the
// server found wrong with each row. Nothing is created until the user clicks.
//   user_typed  the value is in the user's own words
//   not_given   the user did not give it
//   generated   a supplier code the card makes up from codeSeed
//   default     the price currency: the supplier's, else the workspace's
export const SETUP_VALUE_SOURCES = Object.freeze(['user_typed', 'not_given', 'generated', 'default'])
export const SETUP_PROBLEMS = Object.freeze([
  'required', 'duplicate_existing', 'duplicate_in_card', 'invalid', 'negative', 'whole_number', 'email_invalid',
  'payment_terms_unknown', 'supplier_unknown', 'supplier_inactive', 'needs_supplier', 'currency_invalid', 'not_allowed',
])
export const SETUP_FORM_ROWS = 25
const setupSource = z.enum(SETUP_VALUE_SOURCES)
const setupText = (max) => z.object({ value: z.string().max(max).nullable(), source: setupSource })
const setupNumber = z.object({ value: amount.nullable(), source: setupSource })
// blocking: the row cannot be created as it is; otherwise a warning (an item
// named like one that exists). ref: the existing record it collides with.
const setupProblem = z.object({ field: code, code: z.enum(SETUP_PROBLEMS), blocking: z.boolean(), ref: refSchema.optional() })
const supplierKey = z.string().regex(/^s\d{1,2}$/)
export const setupSupplierRowSchema = z.object({
  key: supplierKey,
  name: setupText(200),
  code: setupText(64),
  contact: setupText(200),
  email: setupText(200),
  phone: setupText(60),
  // value: the workspace payment term's code; typed: what the user wrote.
  paymentTerms: z.object({ value: z.string().max(64).nullable(), label: z.string().max(120).nullable(), typed: z.string().max(60).nullable(), source: setupSource }),
  problems: z.array(setupProblem).max(20),
})
export const setupItemRowSchema = z.object({
  key: z.string().regex(/^i\d{1,2}$/),
  sku: setupText(64),
  name: setupText(200),
  unit: setupText(20),
  category: setupText(100),
  safetyStock: setupNumber,
  reorderPoint: setupNumber,
  referencePrice: setupNumber,
  leadTimeDays: setupNumber,
  currency: z.object({ value: currency.nullable(), source: setupSource }),
  // An existing supplier (supplierId) or a supplier row of this card (rowKey).
  preferredSupplier: z.object({ supplierId: id.nullable(), rowKey: supplierKey.nullable(), name: z.string().max(200).nullable(), typed: z.string().max(200).nullable(), source: setupSource })
    .refine((value) => !(value.supplierId && value.rowKey), { message: 'one supplier at most', path: ['rowKey'] }),
  problems: z.array(setupProblem).max(20),
})
const setupFormProps = z.object({
  formId: z.string().min(1).max(160),
  suppliers: z.array(setupSupplierRowSchema).max(SETUP_FORM_ROWS),
  items: z.array(setupItemRowSchema).max(SETUP_FORM_ROWS),
  // The next free supplier code: prefix and number, which the card pads to width.
  codeSeed: z.object({ prefix: z.string().regex(/^[A-Z]{1,8}-$/), next: z.number().int().positive(), width: z.number().int().min(1).max(6) }),
  paymentTerms: z.array(z.object({ code: z.string().min(1).max(64), label: z.string().min(1).max(120) })).max(30),
  // Existing active suppliers an item may name as its preferred one.
  supplierOptions: z.array(z.object({ id, name: label, currency: currency.nullable().optional() })).max(50),
  workspaceCurrency: currency,
  canCreateSuppliers: z.boolean(),
  canCreateItems: z.boolean(),
}).refine((props) => props.suppliers.length + props.items.length >= 1 && props.suppliers.length + props.items.length <= SETUP_FORM_ROWS, { message: `1 to ${SETUP_FORM_ROWS} rows`, path: ['items'] })

export const partPropsSchemas = Object.freeze({
  table: tableProps,
  records: recordsProps,
  chart: chartProps,
  kpis: kpisProps,
  choices: choicesProps,
  pr_form: prFormProps,
  followups: followupsProps,
  citations: citationsProps,
  setup_steps: setupStepsProps,
  setup_form: setupFormProps,
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
  // The check of a completed text part: the spans it could not match, and the
  // records of this answer's results the text names (the panel chips those).
  z.object({ ...envelope, type: z.literal('flag'), partId, spans: z.array(z.object({ text: z.string().min(1).max(200), kind: z.enum(FLAG_KINDS), reason: code })).max(50), refs: z.array(refSchema).max(60).optional() }),
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
