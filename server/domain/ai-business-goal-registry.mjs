const definitions = [
  ['supplier_payables_due', 'getSupplierPaymentSummary', 'finance.payable.read', 'payment'],
  ['supplier_payables_overdue', 'getSupplierPaymentSummary', 'finance.payable.read', 'payment'],
  ['supplier_payment_blocks', 'getSupplierPaymentBlocks', 'finance.payable.read', 'payment'],
  ['supplier_payment_readiness', 'getSupplierPaymentSummary', 'finance.payable.read', 'payment'],
  ['supplier_operational_followups', 'getSupplierOperationalFollowups', 'procurement.purchase_order.read', 'followups'],
  ['supplier_priority', 'getSupplierPriorityList', 'procurement.purchase_order.read', 'priority'],
  ['supplier_comparison', 'compareSupplierActionRisk', 'procurement.purchase_order.read', 'comparison'],
  ['supplier_invoice_exceptions', 'getSupplierInvoiceExceptions', 'finance.supplier_invoice.read', 'invoice'],
  ['supplier_receiving_exceptions', 'getSupplierOperationalFollowups', 'receiving.read', 'receiving'],
  ['supplier_overdue_purchase_orders', 'getSupplierOperationalFollowups', 'procurement.purchase_order.read', 'procurement'],
  ['supplier_rfq_followups', 'getSupplierOperationalFollowups', 'procurement.purchase_order.read', 'rfq'],
  ['supplier_missing_evidence', 'getSupplierActionSummary', 'procurement.purchase_order.read', 'dataQuality'],
  ['supplier_bank_reconciliation_exceptions', 'getSupplierBankReconciliationExceptions', 'finance.bank_reconciliation.read', 'reconciliation'],
  ['inventory_risks', 'getSupplierOperationalFollowups', 'inventory.balance.read', 'inventory'],
  ['procurement_exceptions', 'getSupplierOperationalFollowups', 'procurement.purchase_order.read', 'procurement'],
  ['data_quality_limitations', 'getSupplierActionSummary', 'procurement.purchase_order.read', 'dataQuality'],
]

export const businessGoalRegistry = Object.freeze(Object.fromEntries(definitions.map(([goal, tool, requiredPermission, section]) => [goal, Object.freeze({
  goal,
  tool,
  section,
  mode: 'read',
  writesBusinessData: false,
  requiresUserReview: false,
  requiredPermission,
  sensitivityGroups: section === 'payment' || section === 'invoice' || section === 'reconciliation' ? ['finance_amounts', 'finance_partner_snapshot'] : ['finance_partner_snapshot'],
})])))

export function goalDefinition(goal) {
  return businessGoalRegistry[goal] || null
}

export function goalsInStableOrder(goals = []) {
  const requested = new Set(goals)
  return definitions.map(([goal]) => goal).filter((goal) => requested.has(goal))
}

export function assertReadOnlyGoalRegistry() {
  for (const definition of Object.values(businessGoalRegistry)) {
    if (definition.mode !== 'read' || definition.writesBusinessData || definition.requiresUserReview) throw new Error(`Unsafe goal registry entry: ${definition.goal}`)
  }
  return true
}
