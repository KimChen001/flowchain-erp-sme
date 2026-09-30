import { can } from '../auth/authorization-service.mjs'
import { AI_SKILL_COPY } from './ai-skill-copy.mjs'

// The workspace skills behind /api/ai-runtime/respond. Each skill is read-only
// and deterministic: run() reads through the same report definitions the
// reports use and returns codes, ids and numbers; present() turns that result
// into the answer text in the user's language. No skill writes business data
// or calls a model. The same entries describe future model tools
// (toToolDescriptors), filtered by what the signed-in user may read.

// A source a skill reads, and the permission that shows it in the product. A
// source the actor cannot read is left out of the answer and reported as a
// hidden_by_permission limitation, never counted as zero. Purchase requests and
// RFQs use the purchase order read code as a proxy, as the business query
// goals do; the catalog has no separate read code for them.
export const AI_SKILL_SOURCES = Object.freeze({
  purchase_orders: Object.freeze({ permission: 'procurement.purchase_order.read', area: 'purchasing' }),
  purchase_requests: Object.freeze({ permission: 'procurement.purchase_order.read', area: 'purchasing' }),
  rfqs: Object.freeze({ permission: 'procurement.purchase_order.read', area: 'sourcing' }),
  inventory: Object.freeze({ permission: 'inventory.balance.read', area: 'inventory' }),
  supplier_invoices: Object.freeze({ permission: 'finance.supplier_invoice.read', area: 'finance' }),
  receipts: Object.freeze({ permission: 'receiving.read', area: 'receiving' }),
})

// Amount field groups: purchase order amounts need procurement prices,
// invoice amounts need finance amounts (FIELD_GROUP_PERMISSION).
export const AI_SKILL_FIELD_GROUPS = Object.freeze({
  purchase_order_amounts: 'procurement_prices',
  invoice_amounts: 'finance_amounts',
})

export const AI_SKILL_DRAFT_PERMISSION = 'procurement.purchase_order.revise'

const allSources = Object.keys(AI_SKILL_SOURCES)
const anyReadPermission = [...new Set(Object.values(AI_SKILL_SOURCES).map((source) => source.permission))]
const noInput = Object.freeze({ type: 'object', additionalProperties: false, properties: {}, required: [] })
const focusInput = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    focusEntityType: { type: ['string', 'null'], enum: ['purchase_order', 'item', 'supplier', 'purchase_request', 'rfq', 'supplier_invoice', 'receiving_doc', null] },
    focusEntityId: { type: ['string', 'null'] },
  },
  required: ['focusEntityType', 'focusEntityId'],
})
const evidenceOutput = Object.freeze({ items: 'evidence[]', counts: 'object', limitations: 'limitation[]', checked: 'source[]' })

const definitions = [
  { id: 'today_priorities', version: '1', requiredAnyPermission: anyReadPermission, sources: allSources, fieldGroups: ['purchase_order_amounts', 'invoice_amounts'], inputSchema: focusInput, outputSchema: evidenceOutput },
  { id: 'highest_risk_items', version: '1', requiredAnyPermission: anyReadPermission, sources: allSources, fieldGroups: ['purchase_order_amounts', 'invoice_amounts'], inputSchema: noInput, outputSchema: evidenceOutput },
  { id: 'records_needing_data', version: '1', requiredAnyPermission: anyReadPermission, sources: ['purchase_orders', 'purchase_requests', 'inventory', 'supplier_invoices', 'receipts'], fieldGroups: [], inputSchema: focusInput, outputSchema: evidenceOutput },
  { id: 'prepare_action_draft', version: '1', requiredAnyPermission: anyReadPermission, sources: allSources, fieldGroups: ['purchase_order_amounts', 'invoice_amounts'], inputSchema: focusInput, outputSchema: { ...evidenceOutput, reviewCards: 'review_card[]' } },
  { id: 'workspace_metrics', version: '1', requiredAnyPermission: anyReadPermission, sources: ['purchase_orders', 'inventory', 'supplier_invoices'], fieldGroups: ['purchase_order_amounts', 'invoice_amounts'], inputSchema: noInput, outputSchema: { metrics: 'report_metrics', limitations: 'limitation[]', checked: 'source[]' } },
  // Needs only sign-in: it reads no business data.
  { id: 'capability_overview', version: '1', requiredAnyPermission: [], sources: [], fieldGroups: [], inputSchema: noInput, outputSchema: { skills: 'skill[]' } },
]

// run and present are attached by the skill modules; see attachAiSkillHandlers.
const handlers = new Map()

export const AI_SKILL_REGISTRY = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  title: Object.freeze({ ...AI_SKILL_COPY[`skill.${definition.id}.title`] }),
  description: Object.freeze({ ...AI_SKILL_COPY[`skill.${definition.id}.description`] }),
  mode: 'read',
  writesBusinessData: false,
  get run() { return handlers.get(definition.id)?.run },
  get present() { return handlers.get(definition.id)?.present },
})))

export const AI_SKILL_IDS = Object.freeze(AI_SKILL_REGISTRY.map((entry) => entry.id))

export function attachAiSkillHandlers(id, { run, present }) {
  if (!AI_SKILL_IDS.includes(id)) throw Object.assign(new Error(`Unknown AI skill: ${id}`), { code: 'AI_SKILL_UNKNOWN' })
  handlers.set(id, { run, present })
}

export function aiSkillById(id) {
  return AI_SKILL_REGISTRY.find((entry) => entry.id === id) || null
}

function allowed(actor, permission) {
  return Boolean(actor?.tenantId) && can({ actor, permission, tenantId: actor.tenantId })
}

// Which sources and amount groups the actor may see. Computed once per answer.
export function aiSkillVisibility(actor) {
  const sources = Object.fromEntries(Object.entries(AI_SKILL_SOURCES).map(([id, source]) => [id, allowed(actor, source.permission)]))
  const amounts = {
    purchase_order_amounts: Boolean(actor?.permissionCodes?.has?.('procurement.prices.read')) && sources.purchase_orders,
    invoice_amounts: Boolean(actor?.permissionCodes?.has?.('finance.amounts.read')) && sources.supplier_invoices,
  }
  return { sources, amounts, canDraft: allowed(actor, AI_SKILL_DRAFT_PERMISSION) }
}

// The skills this actor may use. A skill that reads business data needs at
// least one of its read permissions; its hidden sources become limitations.
export function toolsFor(actor) {
  return AI_SKILL_REGISTRY.filter((entry) => !entry.requiredAnyPermission.length || entry.requiredAnyPermission.some((permission) => allowed(actor, permission)))
}

// Descriptors for a future tool-calling model, in the field names of the
// existing AI tool registry. Only the actor's own skills are described.
export function toToolDescriptors(actor) {
  return toolsFor(actor).map((entry) => ({
    name: entry.id,
    version: entry.version,
    module: 'workspace',
    mode: entry.mode,
    description: entry.description.en,
    requiredPermission: entry.requiredAnyPermission[0] || null,
    requiredAnyPermission: [...entry.requiredAnyPermission],
    sensitivityGroups: entry.fieldGroups.map((group) => AI_SKILL_FIELD_GROUPS[group]),
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    requiresUserReview: entry.id === 'prepare_action_draft',
    writesBusinessData: false,
    audit: { recordInvocation: true, action: 'ai_skill_answered' },
  }))
}
