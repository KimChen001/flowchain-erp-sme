function asArray(value) {
  return Array.isArray(value) ? value : []
}

function text(value = '') {
  return String(value ?? '').trim()
}

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))]
}

export const RECEIVING_INVENTORY_BASELINE = Object.freeze({
  inspectedFiles: [
    'server/routes/receiving.routes.mjs',
    'server/routes/inventory-movements.routes.mjs',
    'server/domain/receiving.mjs',
    'server/domain/inventory-read.mjs',
    'server/domain/procurement-transaction-core.mjs',
    'server/domain/exception-case-draft-builder.mjs',
    'server/domain/user-confirmed-business-action.mjs',
    'src/modules/receiving/ReceivingPostingWorkbench.tsx',
    'src/modules/inventory/Page.tsx',
    'src/domain/relationships/resolver.ts',
  ],
  chosenBoundary: 'Receiving and inventory ledger hardening uses draft/review runtime records only. Legacy posted receiving and inventory application routes remain out of scope for AI-assisted execution.',
  representations: {
    receivablePo: 'purchase order with issued/partial status and open quantity',
    poDraft: 'poDraft from procurement transaction core; explicitly not a receiving source',
    grnDraft: 'review-first GRN draft with source PO and no posting',
    inventoryMovementDraft: 'ledger impact preview only; no stock balance mutation',
    receivingException: 'deterministic exception signal and exception-case draft only',
  },
})

export const RECEIVING_FORBIDDEN_SIDE_EFFECTS = Object.freeze({
  postsReceiving: false,
  postsInventory: false,
  updatesStockBalance: false,
  closesPo: false,
  updatesPo: false,
  approvesInvoice: false,
  paysInvoice: false,
  postsInvoice: false,
  issuesPo: false,
})

const RECEIVABLE_STATUSES = ['已发出', '部分到货', 'issued', 'partially_received', 'ready_for_receiving']
const DRAFT_STATUSES = ['草稿', '待审批', '已驳回', 'draft', 'pending_review', 'review_required', 'approval_required', 'approved_not_issued', 'ready_for_manual_issue', 'created']
const CLOSED_STATUSES = ['已完成', '已收货', '已关闭', 'closed', 'fully_received', 'completed']
const CANCELLED_STATUSES = ['已取消', 'cancelled', 'rejected']

export function evaluateReceivingSource(po = {}, context = {}) {
  const id = text(po.po || po.poId || po.id)
  const status = text(po.status)
  const lines = asArray(po.lines)
  const ordered = number(po.totalOrderedQty ?? po.items ?? po.quantity ?? po.recommendedQty ?? lines.reduce((sum, line) => sum + number(line.quantityOrdered ?? line.quantity ?? line.orderedQty), 0))
  const received = number(po.totalReceivedQty ?? po.received ?? lines.reduce((sum, line) => sum + number(line.quantityReceived ?? line.receivedQty), 0))
  const openQuantity = Math.max(0, ordered - received)
  const sourceType = text(po.type || po.documentType || context.sourceType || (DRAFT_STATUSES.includes(status) ? 'poDraft' : 'purchaseOrder'))
  const linkedItems = lines.length ? lines.map((line) => ({
    sku: text(line.sku || line.itemSku || po.sourceSku),
    itemName: text(line.itemName || line.name || po.sourceName),
    orderedQuantity: number(line.quantityOrdered ?? line.quantity ?? line.orderedQty),
    receivedQuantity: number(line.quantityReceived ?? line.receivedQty),
    unit: text(line.unit || po.unit),
  })) : [{
    sku: text(po.sourceSku || po.sku),
    itemName: text(po.sourceName || po.itemName),
    orderedQuantity: ordered,
    receivedQuantity: received,
    unit: text(po.unit),
  }]
  const limitations = []
  if (!id) limitations.push('missing_po_id')
  if (!ordered) limitations.push('missing_ordered_quantity')
  if (!linkedItems.some((item) => item.sku)) limitations.push('missing_sku')
  if (!id) return result(false, 'missing_po', 'Missing or unknown PO cannot be used as receiving source.', limitations, openQuantity, linkedItems, po)
  if (sourceType === 'poDraft' || DRAFT_STATUSES.includes(status)) return result(false, sourceType, 'PO Draft is not eligible for receiving.', limitations, openQuantity, linkedItems, po)
  if (CANCELLED_STATUSES.includes(status)) return result(false, 'cancelled_po', 'Cancelled PO is not eligible for receiving.', limitations, openQuantity, linkedItems, po)
  if (CLOSED_STATUSES.includes(status) || (ordered > 0 && openQuantity <= 0)) return result(false, 'closed_po', 'Closed or fully received PO is not eligible for new receiving except review.', limitations, openQuantity, linkedItems, po)
  if (!RECEIVABLE_STATUSES.includes(status)) return result(false, 'status_not_receivable', `PO status "${status || 'unknown'}" is not explicitly eligible for receiving.`, [...limitations, 'status_not_explicitly_receivable'], openQuantity, linkedItems, po)
  return result(true, received > 0 ? 'partially_received_po' : 'issued_po', received > 0 ? 'Partially received PO is eligible for remaining open quantity.' : 'Issued PO is eligible for receiving.', limitations, openQuantity, linkedItems, po)
}

function result(eligible, sourceType, reason, dataLimitations, openQuantity, linkedItems, po) {
  return {
    eligible,
    sourceType,
    reason,
    dataLimitations: unique(dataLimitations),
    openQuantity,
    linkedItems,
    supplier: text(po.supplier || po.supplierName),
    poId: text(po.po || po.poId || po.id),
    status: text(po.status),
    sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildGrnDraft(input = {}) {
  const source = input.sourceEligibility || evaluateReceivingSource(input.po || input.sourcePo || {})
  if (!source.eligible) return { ok: false, blocked: true, reason: source.reason, sourceEligibility: source, sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS } }
  const receivedQuantity = number(input.receivedQuantity ?? source.openQuantity)
  const warehouse = text(input.warehouse || input.warehouseId)
  const location = text(input.location || input.bin)
  const qualityStatus = text(input.qualityStatus)
  const missingFields = unique([
    ...(!warehouse ? ['warehouse'] : []),
    ...(!location ? ['location'] : []),
    ...(!qualityStatus ? ['qualityStatus'] : []),
    ...(receivedQuantity > 0 ? [] : ['receivedQuantity']),
  ])
  const draft = {
    id: input.id || `GRN-DRAFT-${source.poId || Date.now()}`,
    type: 'grnDraft',
    sourcePoId: source.poId,
    sourcePoStatus: source.status,
    supplier: source.supplier,
    itemLines: source.linkedItems.map((item) => ({ ...item, proposedReceivedQuantity: receivedQuantity || item.orderedQuantity - item.receivedQuantity })),
    expectedQuantity: source.linkedItems.reduce((sum, item) => sum + number(item.orderedQuantity), 0),
    proposedReceivedQuantity: receivedQuantity,
    openQuantity: source.openQuantity,
    warehouse,
    location,
    receivedDate: text(input.receivedDate) || new Date().toISOString().slice(0, 10),
    qualityStatus,
    receivingNotes: text(input.receivingNotes || input.notes),
    missingFields,
    linkedRecords: [{ type: 'po', id: source.poId }, ...source.linkedItems.map((item) => ({ type: 'sku', id: item.sku })).filter((item) => item.id)],
    evidence: [{ type: 'purchase_order', id: source.poId, summary: source.reason }],
    dataLimitations: source.dataLimitations,
    reviewStatus: 'review_required',
    auditPreview: [
      { action: 'grn_draft_generated', summary: 'Draft Only. Requires Review. Does not post receiving. Does not update inventory balance.' },
    ],
    boundary: { draftOnly: true, requiresReview: true, doesNotPostReceiving: true, doesNotUpdateInventoryBalance: true },
    sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS },
  }
  return { ok: true, draft, sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS } }
}

export function confirmReceivingRecord(input = {}) {
  const draft = input.draft || input.grnDraft || {}
  const source = input.sourceEligibility || evaluateReceivingSource(input.po || { po: draft.sourcePoId, status: draft.sourcePoStatus, items: draft.expectedQuantity, received: 0 })
  const errors = []
  if (input.confirm !== true && input.explicitUserConfirmation !== true) errors.push('missing_confirmation')
  if (!source.eligible) errors.push('source_po_not_eligible')
  if (!asArray(draft.itemLines).length) errors.push('missing_item_lines')
  if (!(number(draft.proposedReceivedQuantity) > 0)) errors.push('missing_received_quantity')
  if (!text(draft.warehouse) || !text(draft.location)) errors.push('missing_warehouse_or_location')
  if (errors.length) return { ok: false, errors, sourceEligibility: source, sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS } }
  const status = draft.missingFields?.length ? 'exception_review' : text(input.status || 'received_pending_inventory_review')
  return {
    ok: true,
    record: {
      id: input.id || `GRN-REVIEW-${draft.sourcePoId}`,
      type: 'receivingRecord',
      status,
      sourcePoId: draft.sourcePoId,
      itemLines: clone(draft.itemLines),
      warehouse: draft.warehouse,
      location: draft.location,
      receivedQuantity: draft.proposedReceivedQuantity,
      qualityStatus: draft.qualityStatus,
      provenance: {
        reviewedGrnDraftId: draft.id,
        confirmedBy: text(input.actor || 'current_user'),
        confirmedAt: input.confirmedAt || new Date().toISOString(),
        noInventoryPosting: true,
      },
      auditPreview: [{ action: 'receiving_record_created_after_review', summary: 'Receiving record created without inventory posting or PO close/update.' }],
    },
    sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function detectReceivingExceptions(input = {}) {
  const draft = input.draft || input.grnDraft || input.receivingRecord || {}
  const existingGrns = asArray(input.existingGrns)
  const expected = number(draft.openQuantity || draft.expectedQuantity)
  const received = number(draft.proposedReceivedQuantity || draft.receivedQuantity)
  const items = []
  if (expected > 0 && received < expected) items.push(exception('under_receipt', 'medium', draft, `Received ${received} below expected/open ${expected}.`))
  if (expected > 0 && received > expected) items.push(exception('over_receipt', 'high', draft, `Received ${received} above expected/open ${expected}.`))
  if (!text(draft.warehouse) || !text(draft.location)) items.push(exception('missing_warehouse_location', 'high', draft, 'Warehouse or location is missing.'))
  if (!text(draft.qualityStatus)) items.push(exception('missing_quality_status', 'medium', draft, 'Quality status is missing.'))
  if (/hold|隔离|冻结|待检|quality/i.test(text(draft.qualityStatus))) items.push(exception('quality_hold', 'high', draft, 'Receiving is under quality hold.'))
  if (input.expectedDate && draft.receivedDate && new Date(draft.receivedDate) > new Date(input.expectedDate)) items.push(exception('late_receipt', 'medium', draft, 'Receiving date is later than expected date.'))
  if (existingGrns.some((grn) => text(grn.po || grn.sourcePoId) === text(draft.sourcePoId))) items.push(exception('duplicate_receiving_risk', 'medium', draft, 'Existing GRN found for the same PO/source.'))
  return {
    exceptions: items,
    deterministic: true,
    recommendedActions: ['Preview Receiving Exception Case', 'Preview Inventory Movement Draft', 'Explain Inventory Impact'],
    sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS },
  }
}

function exception(type, severity, draft, summary) {
  return {
    exceptionType: type,
    severity,
    evidence: [{ type: 'grn_draft', id: draft.id, summary }],
    linkedRecords: [{ type: 'po', id: draft.sourcePoId }, ...asArray(draft.itemLines).map((line) => ({ type: 'sku', id: line.sku })).filter((item) => item.id)],
    dataLimitations: asArray(draft.missingFields),
    recommendedReviewFirstActions: ['create_exception_case_draft', 'review_receiving_fields'],
  }
}

export function buildReceivingExceptionCaseDraft(input = {}) {
  const detected = input.detected || detectReceivingExceptions(input)
  return {
    id: input.id || `CASE-DRAFT-${input.draft?.id || input.grnDraft?.id || 'RECEIVING'}`,
    type: 'exceptionCaseDraft',
    caseType: 'receiving_exception',
    reviewStatus: 'draft_only_requires_review',
    linkedRecords: unique(detected.exceptions.flatMap((item) => item.linkedRecords.map((record) => `${record.type}:${record.id}`))).map((key) => {
      const [type, id] = key.split(':')
      return { type, id }
    }),
    evidenceItems: detected.exceptions.flatMap((item) => item.evidence),
    dataLimitations: unique(detected.exceptions.flatMap((item) => item.dataLimitations)),
    summary: detected.exceptions.map((item) => item.exceptionType).join(', ') || 'No receiving exception detected.',
    mutationAllowed: false,
    autoCreateCase: false,
    sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildInventoryMovementDraft(input = {}) {
  const grn = input.grn || input.receivingRecord || input.grnDraft || {}
  const line = asArray(grn.itemLines)[0] || {}
  const movementType = /hold|隔离|冻结|待检|quality/i.test(text(grn.qualityStatus)) ? 'hold' : text(input.movementType || 'receipt')
  const quantity = number(input.quantity ?? grn.receivedQuantity ?? grn.proposedReceivedQuantity ?? line.proposedReceivedQuantity)
  const balance = input.currentBalance || {}
  const preview = previewInventoryBalanceImpact({ currentBalance: balance, movementType, quantity, qualityStatus: grn.qualityStatus })
  return {
    id: input.id || `IM-DRAFT-${text(grn.id || grn.sourcePoId || 'GRN')}`,
    type: 'inventoryMovementDraft',
    sourceGrnId: text(grn.id),
    sourcePoId: text(grn.sourcePoId),
    sku: text(line.sku || input.sku),
    warehouse: text(grn.warehouse || input.warehouse),
    location: text(grn.location || input.location),
    movementType,
    quantity,
    unit: text(line.unit || input.unit),
    expectedBalanceImpact: preview,
    currentBalance: clone(balance || {}),
    resultingBalancePreview: preview.projectedBalance,
    evidence: [{ type: 'receiving_record', id: grn.id, summary: 'Inventory movement draft generated from receiving review.' }],
    dataLimitations: unique([...asArray(grn.missingFields), ...preview.dataLimitations]),
    reviewStatus: 'review_required',
    auditPreview: [{ action: 'inventory_movement_draft_generated', summary: 'Draft Only. Requires Review. Does not post inventory. Does not change stock balance.' }],
    boundary: { draftOnly: true, requiresReview: true, doesNotPostInventory: true, doesNotChangeStockBalance: true },
    sideEffects: { ...RECEIVING_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function previewInventoryBalanceImpact(input = {}) {
  const current = input.currentBalance || {}
  const currentAvailable = number(current.available ?? current.availableQuantity, NaN)
  const currentOnHand = number(current.onHand ?? current.currentStock ?? current.quantity, NaN)
  const quantity = number(input.quantity)
  const movementType = text(input.movementType || 'receipt')
  const qualityHold = movementType === 'hold' || /hold|隔离|冻结|待检|quality/i.test(text(input.qualityStatus))
  const hasBalance = Number.isFinite(currentAvailable) && Number.isFinite(currentOnHand)
  const onHandImpact = movementType === 'adjustment' ? quantity : quantity
  const availableImpact = qualityHold ? 0 : movementType === 'release' ? quantity : quantity
  const projected = {
    available: hasBalance ? currentAvailable + availableImpact : null,
    onHand: hasBalance ? currentOnHand + onHandImpact : null,
    held: number(current.held, 0) + (qualityHold ? quantity : 0),
  }
  const warnings = []
  if (projected.available !== null && projected.available < 0) warnings.push('negative_projected_available')
  return {
    currentBalance: hasBalance ? { available: currentAvailable, onHand: currentOnHand, held: number(current.held, 0) } : null,
    quantityImpact: quantity,
    projectedBalance: projected,
    availableImpact,
    onHandImpact,
    confidence: hasBalance ? 'high' : 'low',
    dataLimitations: hasBalance ? [] : ['missing_current_balance'],
    warnings,
    previewOnly: true,
    mutatesInventory: false,
  }
}
