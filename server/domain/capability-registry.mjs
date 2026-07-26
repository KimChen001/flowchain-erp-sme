const capability = (id, maturity, readReady, writeReady, reason, options = {}) => ({
  id,
  enabled: options.requiresExplicitEnable ? false : maturity === 'stable' || maturity === 'beta',
  maturity,
  readReady,
  writeReady,
  reason,
  ...options,
})

export const capabilityRegistry = [
  capability('overview', 'stable', true, false, 'Authoritative runtime overview'),
  capability('master-data', 'stable', true, true, 'Runtime item, supplier, and customer masters'),
  capability('procurement', 'stable', true, true, 'Canonical PR and draft PO workflow'),
  capability('sales', 'stable', true, true, 'Durable sales order runtime'),
  capability('inventory', 'stable', true, true, 'Durable inventory balances and movements'),
  capability('inventory-balance-adjustment', 'stable', true, true, 'Existing authoritative inventory adjustment behavior'),
  capability('receiving-posting', 'beta', false, true, 'Database-only transactional receiving posting', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING' }),
  capability('receiving-reversal', 'beta', false, true, 'Database-only transactional receiving reversal', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING' }),
  capability('sales-order-lifecycle', 'beta', true, true, 'Database-only authoritative sales order lifecycle', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING' }),
  capability('sales-reservation', 'beta', true, true, 'Database-only sales inventory reservation', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING' }),
  capability('sales-shipment-draft', 'beta', true, true, 'Database-only sales shipment allocation', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING' }),
  capability('sales-shipment-posting', 'beta', true, true, 'Database-only sales shipment posting', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING' }),
  capability('sales-shipment-reversal', 'beta', true, true, 'Database-only sales shipment reversal', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING' }),
  capability('stock-transfer', 'beta', true, true, 'Database-only authoritative stock transfer operations', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS' }),
  capability('cycle-count', 'beta', true, true, 'Database-only authoritative cycle count operations', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS' }),
  capability('inventory-adjustment-document', 'beta', true, true, 'Database-only governed inventory adjustment documents', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS' }),
  capability('quarantine-inventory', 'beta', true, false, 'Database-only quarantine inventory read foundation', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE' }),
  capability('return-request', 'beta', true, true, 'Database-only governed return request lifecycle', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE' }),
  capability('return-authorization', 'beta', true, true, 'Database-only governed return authorization lifecycle', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE' }),
  capability('return-posting', 'beta', true, true, 'Database-only supplier return dispatch, customer quarantine receipt, controlled quarantine release, and safe reversal', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE' }),
  capability('supplier-invoice', 'beta', true, true, 'Database-only governed supplier invoice lifecycle', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('three-way-match', 'beta', true, true, 'Database-only PO, receiving, and supplier invoice matching', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('payable-obligation', 'beta', true, true, 'Database-only approved payable obligation without payment execution', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('supplier-credit-memo', 'beta', true, true, 'Database-only supplier credit memo from posted supplier return evidence', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('customer-invoice', 'beta', true, true, 'Database-only governed customer invoice lifecycle from posted shipment evidence', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('receivable-obligation', 'beta', true, true, 'Database-only receivable obligation and aging without collection execution', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('customer-credit-note', 'beta', true, true, 'Database-only customer credit note from posted return receipt evidence', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('internal-settlement', 'beta', true, true, 'Database-only internal receipt and disbursement allocation without bank execution', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT' }),
  capability('settlement-workflow', 'beta', true, true, 'Database-only governed settlement approval workflow and evidence', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW' }),
  capability('mobile-operations', 'beta', true, true, 'Database-only mobile task, PO approval, and receiving facades', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS' }),
  capability('mobile-sync', 'beta', true, true, 'Database-only signed cross-module synchronization feed', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_MOBILE_SYNC' }),
  capability('cashbook', 'beta', true, true, 'Database-only internal cashbook facts without bank statement import or general ledger', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT' }),
  capability('bank-statement-reconciliation', 'beta', true, true, 'Database-only durable bank statement import and controlled external evidence reconciliation', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_BANK_RECONCILIATION' }),
  capability('finance', 'beta', true, true, 'Database-only operational P2P and O2C finance without payment, collection, refund, FX, tax filing, or general-ledger execution', { databaseOnly: true, requiresExplicitEnable: true, environmentFlag: 'FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE' }),
  capability('reports', 'stable', true, false, 'Authoritative runtime analytics'),
  capability('settings', 'beta', true, true, 'Local/UAT workspace settings'),
  capability('imports', 'beta', true, true, 'Supplier, item, customer, and inventory imports are connected'),
  capability('forecast', 'unavailable', false, false, 'Forecast and MRP planning are unavailable until PostgreSQL authoritative models exist'),
  capability('exception-cases', 'preview', true, false, 'Internal exception workflow preview'),
  capability('collaboration-drafts', 'preview', true, false, 'Internal draft-only workflow'),
  capability('review-actions', 'preview', true, false, 'Human review workflow preview'),
  capability('audit-history', 'preview', true, false, 'Internal audit exploration'),
  capability('pilot-readiness', 'preview', true, false, 'Internal readiness assessment'),
]

export const capabilityFor = id => capabilityRegistry.find(entry => entry.id === id)

export function capabilityForEnvironment(id, env = process.env) {
  const entry = capabilityFor(id)
  if (!entry) return undefined
  if (!entry.requiresExplicitEnable) return { ...entry }
  const explicit = String(env[entry.environmentFlag] || '').trim().toLowerCase() === 'true'
  return { ...entry, enabled: entry.maturity !== 'unavailable' && explicit }
}

export function capabilityRegistryForEnvironment(env = process.env) {
  return capabilityRegistry.map((entry) => capabilityForEnvironment(entry.id, env))
}
