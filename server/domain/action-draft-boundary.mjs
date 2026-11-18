// The text draft types the app may report as copied or opened in the mail
// app (POST /api/action-drafts/used).
export const supportedActionDraftTypes = Object.freeze([
  {
    type: 'purchase_request_draft',
    label: 'Purchase Request Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'inventory'],
    requiredPayloadFields: ['itemIdOrSku', 'quantity'],
    futureConfirmation: 'create_purchase_request',
  },
  {
    type: 'rfq_draft',
    label: 'RFQ Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'procurement'],
    requiredPayloadFields: ['itemIdOrSku', 'quantity'],
    futureConfirmation: 'create_rfq',
  },
  {
    type: 'po_followup_draft',
    label: 'PO Follow-up Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'procurement'],
    requiredPayloadFields: ['poId', 'message'],
    futureConfirmation: 'send_or_record_po_followup',
  },
  {
    type: 'inventory_exception_closure_draft',
    label: 'Inventory Exception Closure Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'inventory'],
    requiredPayloadFields: ['exceptionId', 'resolution'],
    futureConfirmation: 'close_inventory_exception',
  },
  {
    type: 'supplier_followup_draft',
    label: 'Supplier Follow-up Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'srm'],
    requiredPayloadFields: ['supplierIdOrName', 'message'],
    futureConfirmation: 'send_or_record_supplier_followup',
  },
])
