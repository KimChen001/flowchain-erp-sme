function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value = '') { return String(value ?? '').trim() }
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function clone(value) { return JSON.parse(JSON.stringify(value ?? null)) }
function unique(values = []) { return [...new Set(values.filter(Boolean))] }

export const INVOICE_MATCHING_BASELINE = Object.freeze({
  inspectedFiles: [
    'src/domain/procurement/invoice-matching.ts',
    'server/domain/procurement-read-model.mjs',
    'server/domain/today-cockpit-read-model.mjs',
    'src/domain/relationships/resolver.ts',
  ],
  boundary: 'Invoice matching review can generate evidence, finance notes, and exception drafts only. No invoice approval, payment, posting, PO/GRN/inventory mutation.',
})

export const INVOICE_MATCH_STATUSES = Object.freeze(['draft', 'evidence_ready', 'variance_review', 'matched_for_review', 'exception_review', 'note_saved'])
export const INVOICE_VARIANCE_TYPES = Object.freeze(['none', 'price_variance', 'quantity_variance', 'tax_variance', 'freight_variance', 'supplier_mismatch', 'missing_grn', 'missing_po', 'invoice_before_receipt', 'duplicate_invoice'])

export const INVOICE_FORBIDDEN_SIDE_EFFECTS = Object.freeze({
  approvesInvoice: false,
  paysInvoice: false,
  postsInvoice: false,
  mutatesPo: false,
  mutatesGrn: false,
  postsInventory: false,
  mutatesInventoryBalance: false,
  sendsExternalEmail: false,
})

export function normalizeInvoiceMatchStatus(status = '') {
  const raw = text(status || 'draft')
  if (!INVOICE_MATCH_STATUSES.includes(raw)) throw new Error(`Invalid invoice match status: ${raw}`)
  return raw
}

export function normalizeInvoiceVarianceType(type = '') {
  const raw = text(type || 'none')
  if (!INVOICE_VARIANCE_TYPES.includes(raw)) throw new Error(`Invalid invoice variance type: ${raw}`)
  return raw
}

export function resolveThreeWayMatchEvidence(input = {}) {
  const invoice = input.invoice || {}
  const po = input.po || {}
  const grn = input.grn || {}
  const invoiceAmount = number(invoice.amount ?? invoice.total ?? invoice.invoiceAmount)
  const poAmount = number(po.amount ?? po.totalAmount ?? po.poAmount)
  const invoiceQty = number(invoice.quantity ?? asArray(invoice.lines).reduce((sum, line) => sum + number(line.quantity), 0))
  const receivedQty = number(grn.acceptedQty ?? grn.passed ?? grn.receivedQuantity ?? asArray(grn.lines).reduce((sum, line) => sum + number(line.acceptedQty ?? line.receivedQty), 0))
  const variances = []
  if (!text(po.po || po.id || po.poId)) variances.push(v('missing_po', 'high', 'Invoice has no linked PO evidence.'))
  if (!text(grn.grn || grn.id || grn.grnId)) variances.push(v('missing_grn', 'high', 'Invoice has no linked GRN evidence.'))
  if (poAmount && invoiceAmount && Math.abs(invoiceAmount - poAmount) > number(input.amountTolerance, 1)) variances.push(v('price_variance', 'high', `Invoice amount ${invoiceAmount} differs from PO amount ${poAmount}.`))
  if (receivedQty && invoiceQty && Math.abs(invoiceQty - receivedQty) > number(input.quantityTolerance, 0)) variances.push(v('quantity_variance', 'high', `Invoice quantity ${invoiceQty} differs from received quantity ${receivedQty}.`))
  if (invoice.invoiceDate && grn.arrived && new Date(invoice.invoiceDate) < new Date(grn.arrived)) variances.push(v('invoice_before_receipt', 'medium', 'Invoice date is before receipt date.'))
  return {
    invoiceId: text(invoice.invoiceNumber || invoice.id || invoice.invoiceId),
    linkedPo: text(invoice.relatedPo || po.po || po.id || po.poId),
    linkedGrn: text(invoice.relatedGrn || grn.grn || grn.id || grn.grnId),
    supplier: text(invoice.supplier || po.supplier || grn.supplier),
    status: variances.length ? 'variance_review' : 'matched_for_review',
    variances,
    evidence: [
      { type: 'invoice', id: text(invoice.invoiceNumber || invoice.id), summary: `Invoice amount ${invoiceAmount}` },
      ...(text(po.po || po.id) ? [{ type: 'po', id: text(po.po || po.id), summary: `PO amount ${poAmount}` }] : []),
      ...(text(grn.grn || grn.id) ? [{ type: 'grn', id: text(grn.grn || grn.id), summary: `Received quantity ${receivedQty}` }] : []),
    ],
    dataLimitations: unique(variances.filter((item) => item.type.startsWith('missing')).map((item) => item.type)),
    sideEffects: { ...INVOICE_FORBIDDEN_SIDE_EFFECTS },
  }
}

function v(type, severity, summary) { return { type: normalizeInvoiceVarianceType(type), severity, summary } }

export function buildInvoiceMatchReviewDraft(input = {}) {
  const evidence = input.evidence || resolveThreeWayMatchEvidence(input)
  return {
    id: input.id || `INV-MATCH-DRAFT-${evidence.invoiceId || 'UNKNOWN'}`,
    type: 'invoiceMatchReviewDraft',
    invoiceId: evidence.invoiceId,
    linkedPo: evidence.linkedPo,
    linkedGrn: evidence.linkedGrn,
    supplier: evidence.supplier,
    status: evidence.status,
    variances: evidence.variances,
    evidence: evidence.evidence,
    dataLimitations: evidence.dataLimitations,
    reviewStatus: 'review_required',
    recommendedActions: ['save_finance_note_after_confirmation', 'preview_invoice_exception_case', 'request_receiving_review'],
    auditPreview: [{ action: 'invoice_match_review_draft_generated', summary: 'Review-first only. No invoice approval, payment, or posting.' }],
    boundary: { draftOnly: true, requiresReview: true, noApproval: true, noPayment: true, noPosting: true },
    sideEffects: { ...INVOICE_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function saveFinanceCollaborationNote(input = {}) {
  const errors = []
  if (input.confirm !== true && input.explicitUserConfirmation !== true) errors.push('missing_confirmation')
  if (!text(input.invoiceId || input.draft?.invoiceId)) errors.push('missing_invoice_id')
  if (!text(input.note || input.body)) errors.push('missing_note')
  if (errors.length) return { ok: false, errors, sideEffects: { ...INVOICE_FORBIDDEN_SIDE_EFFECTS } }
  return {
    ok: true,
    note: {
      id: input.id || `FIN-NOTE-${text(input.invoiceId || input.draft?.invoiceId)}`,
      type: 'financeCollaborationNote',
      invoiceId: text(input.invoiceId || input.draft?.invoiceId),
      linkedPo: text(input.linkedPo || input.draft?.linkedPo),
      linkedGrn: text(input.linkedGrn || input.draft?.linkedGrn),
      body: text(input.note || input.body),
      confirmedBy: text(input.actor || 'current_user'),
      confirmedAt: input.confirmedAt || new Date().toISOString(),
      reviewStatus: 'user_confirmed_internal_note',
    },
    sideEffects: { ...INVOICE_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildInvoiceExceptionCaseDraft(input = {}) {
  const draft = input.draft || buildInvoiceMatchReviewDraft(input)
  return {
    id: input.id || `CASE-DRAFT-${draft.invoiceId || 'INVOICE'}`,
    type: 'exceptionCaseDraft',
    caseType: 'invoice_matching',
    linkedRecords: [
      { type: 'invoice', id: draft.invoiceId },
      { type: 'po', id: draft.linkedPo },
      { type: 'grn', id: draft.linkedGrn },
    ].filter((item) => item.id),
    evidenceItems: draft.evidence,
    dataLimitations: draft.dataLimitations,
    summary: draft.variances.map((item) => item.type).join(', ') || 'Invoice matched for review.',
    autoCreateCase: false,
    mutationAllowed: false,
    sideEffects: { ...INVOICE_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildInvoiceMatchingRiskSummary(input = {}) {
  const evidence = input.evidence || resolveThreeWayMatchEvidence(input)
  return {
    id: `INV-RISK-${evidence.invoiceId || 'UNKNOWN'}`,
    category: 'invoice_mismatch',
    priority: evidence.variances.some((item) => item.severity === 'high') ? 'high' : evidence.variances.length ? 'medium' : 'low',
    title: evidence.variances.length ? `${evidence.invoiceId} requires invoice matching review` : `${evidence.invoiceId} matched for review`,
    conclusion: evidence.variances.map((item) => item.summary).join(' ') || 'No material variance detected.',
    linkedRecords: [
      { type: 'invoice', id: evidence.invoiceId },
      { type: 'po', id: evidence.linkedPo },
      { type: 'grn', id: evidence.linkedGrn },
    ].filter((item) => item.id),
    evidence: evidence.evidence,
    dataLimitations: evidence.dataLimitations,
    recommendedNextAction: 'Review invoice evidence and save finance collaboration note after confirmation.',
    mutationAllowed: false,
    sideEffects: { ...INVOICE_FORBIDDEN_SIDE_EFFECTS },
  }
}
