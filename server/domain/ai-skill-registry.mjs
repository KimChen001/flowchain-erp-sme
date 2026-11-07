import { can } from '../auth/authorization-service.mjs'

// What the asking user may read, for the assistant's facts and tools: each
// source with the permission that shows it in the product, and the amount
// field groups. A source the actor cannot read is left out of the facts and
// reported as a hidden_by_permission limitation, never counted as zero.
// Purchase requests and RFQs use the purchase order read code as a proxy; the
// catalog has no separate read code for them.
export const AI_SKILL_SOURCES = Object.freeze({
  purchase_orders: Object.freeze({ permission: 'procurement.purchase_order.read', area: 'purchasing' }),
  purchase_requests: Object.freeze({ permission: 'procurement.purchase_order.read', area: 'purchasing' }),
  rfqs: Object.freeze({ permission: 'procurement.purchase_order.read', area: 'sourcing' }),
  inventory: Object.freeze({ permission: 'inventory.balance.read', area: 'inventory' }),
  supplier_invoices: Object.freeze({ permission: 'finance.supplier_invoice.read', area: 'finance' }),
  receipts: Object.freeze({ permission: 'receiving.read', area: 'receiving' }),
})

export const AI_SKILL_DRAFT_PERMISSION = 'procurement.purchase_order.revise'

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
  // Supplier names on invoices need the partner snapshot permission, as the
  // finance screens and the business query show them.
  const partner = Boolean(actor?.permissionCodes?.has?.('finance.partner_snapshot.read'))
  return { sources, amounts, partner, canDraft: allowed(actor, AI_SKILL_DRAFT_PERMISSION) }
}
