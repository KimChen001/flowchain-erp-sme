import { can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { createBankReconciliationService } from './bank-reconciliation-service.mjs'
import { partitionBusinessRecords, resultStateForValidity, validitySummary } from './ai-business-record-validity.mjs'

export const SUPPLIER_ACTION_PRIORITY_VERSION = 'supplier-action-priority-v1'

export const PAYMENT_BLOCK_REASONS = Object.freeze([
  'invoice_disputed',
  'payment_hold',
  'missing_invoice',
  'missing_receiving_evidence',
  'three_way_match_difference',
  'supplier_mismatch',
  'currency_mismatch',
  'settlement_not_posted',
  'bank_reconciliation_exception',
  'data_incomplete',
])

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []
const decimal = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const serial = (value) => value?.toISOString?.() || value || null
const date = (value) => { const parsed = value instanceof Date ? value : new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed }
const unique = (items) => [...new Set(items.filter(Boolean))]
const permission = (actor, code) => Boolean(actor?.permissionCodes?.has(code))

function sourceState(available, visible, partition, count) {
  if (!available) return 'unavailable'
  if (!visible) return 'hidden'
  return resultStateForValidity(partition.recordValiditySummary, count)
}

function inWindow(value, window) {
  const candidate = date(value)
  if (!candidate) return false
  if (window?.type === 'overdue') return window.endAt ? candidate <= new Date(window.endAt) : false
  if (window?.startAt && candidate < new Date(window.startAt)) return false
  if (window?.endAt && candidate > new Date(window.endAt)) return false
  return true
}

function isOverdue(value, now) {
  const due = date(value)
  return Boolean(due && due < now)
}

function evidence(type, id, label, status, route) {
  if (!id) return null
  return { type, entityType: type, id, entityId: id, label, entityLabel: label, status, route }
}

function supplierKey(row) {
  return text(row?.supplierId || row?.id)
}

function payableSupplierId(row) {
  return text(row?.supplierId || row?.supplierInvoice?.supplierId)
}

function blockReasonsForPayable(payable, records) {
  const reasons = new Set()
  const invoice = payable.supplierInvoice || records.invoices.find((row) => row.id === payable.supplierInvoiceId)
  if (!invoice) reasons.add('missing_invoice')
  const payableStatus = text(payable.status).toLowerCase()
  const invoiceStatus = text(invoice?.status).toLowerCase()
  const matchStatus = text(invoice?.matchStatus).toLowerCase()
  if (payableStatus === 'held' || payable.heldAt || invoice?.heldAt) reasons.add('payment_hold')
  if (/disput|争议/.test(`${invoiceStatus} ${matchStatus}`)) reasons.add('invoice_disputed')
  if (/exception|mismatch|variance|差异/.test(matchStatus) || decimal(invoice?.varianceAmount) !== null && decimal(invoice?.varianceAmount) !== 0) reasons.add('three_way_match_difference')
  if (invoice && text(invoice.supplierId) && payableSupplierId(payable) && text(invoice.supplierId) !== payableSupplierId(payable)) reasons.add('supplier_mismatch')
  if (invoice && text(invoice.currency) && text(payable.currency) && text(invoice.currency) !== text(payable.currency)) reasons.add('currency_mismatch')
  if (invoice?.relatedGrnId && !records.receiving.some((row) => row.id === invoice.relatedGrnId || row.documentNumber === invoice.relatedGrnId)) reasons.add('missing_receiving_evidence')
  const allocations = records.settlements.flatMap((row) => array(row.allocations).map((allocation) => ({ settlement: row, allocation }))).filter(({ allocation }) => allocation.payableObligationId === payable.id)
  if (allocations.some(({ settlement }) => !['posted', 'reversed'].includes(text(settlement.postingStatus).toLowerCase()))) reasons.add('settlement_not_posted')
  if (records.bankExceptions.some((row) => ['open', 'acknowledged'].includes(text(row.status).toLowerCase()) && text(row.severity).toLowerCase() === 'blocking' && (!row.supplierId || text(row.supplierId) === payableSupplierId(payable)))) reasons.add('bank_reconciliation_exception')
  if (!date(payable.dueDate) || decimal(payable.outstandingAmount) === null || !payableSupplierId(payable)) reasons.add('data_incomplete')
  return PAYMENT_BLOCK_REASONS.filter((reason) => reasons.has(reason))
}

function priorityFor(summary, internalAmountImpact = 0) {
  const reasons = []
  let score = 0
  const overdueDays = summary.payment.maxOverdueDays
  if (overdueDays > 0) { const points = Math.min(30, overdueDays * 2); score += points; reasons.push({ code: 'payment_overdue', points, evidence: `${overdueDays} days` }) }
  if (summary.payment.blockedCount > 0) { const points = Math.min(30, 15 + summary.payment.blockedCount * 5); score += points; reasons.push({ code: 'payment_blocked', points, evidence: summary.payment.blockedCount }) }
  if (summary.procurement.overduePoCount > 0) { const points = Math.min(25, summary.procurement.overduePoCount * 10); score += points; reasons.push({ code: 'purchase_order_overdue', points, evidence: summary.procurement.overduePoCount }) }
  if (summary.receiving.exceptionCount > 0) { const points = Math.min(20, summary.receiving.exceptionCount * 10); score += points; reasons.push({ code: 'receiving_exception', points, evidence: summary.receiving.exceptionCount }) }
  if (summary.invoice.mismatchCount + summary.invoice.disputedCount > 0) { const points = Math.min(20, (summary.invoice.mismatchCount + summary.invoice.disputedCount) * 8); score += points; reasons.push({ code: 'invoice_exception', points, evidence: summary.invoice.mismatchCount + summary.invoice.disputedCount }) }
  if (summary.reconciliation.blockingExceptionCount > 0) { score += 25; reasons.push({ code: 'bank_reconciliation_exception', points: 25, evidence: summary.reconciliation.blockingExceptionCount }) }
  if (summary.dataQuality.incompleteRecordCount > 0) { const points = Math.min(12, summary.dataQuality.incompleteRecordCount * 3); score += points; reasons.push({ code: 'data_incomplete', points, evidence: summary.dataQuality.incompleteRecordCount }) }
  if (internalAmountImpact > 0) { const points = Math.min(10, Math.max(1, Math.floor(Math.log10(internalAmountImpact + 1) * 2))); score += points; reasons.push({ code: 'authorized_amount_impact', points, evidence: 'backend_only' }) }
  score = Math.min(100, score)
  const level = score >= 70 ? 'critical' : score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low'
  return { level, score, reasons, algorithmVersion: SUPPLIER_ACTION_PRIORITY_VERSION }
}

function emptySourceState(state) {
  return { state, recordValiditySummary: validitySummary({ unavailable: state === 'unavailable', hiddenCount: state === 'hidden' ? 1 : 0 }) }
}

export function buildSupplierActionSummaries({ records = {}, actor, sourceAvailability = {}, timeWindow, now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now)
  const available = {
    suppliers: sourceAvailability.suppliers !== false,
    payables: sourceAvailability.payables !== false,
    invoices: sourceAvailability.invoices !== false,
    settlements: sourceAvailability.settlements !== false,
    purchaseOrders: sourceAvailability.purchaseOrders !== false,
    receiving: sourceAvailability.receiving !== false,
    rfqs: sourceAvailability.rfqs !== false,
    bankReconciliation: sourceAvailability.bankReconciliation !== false,
  }
  const visible = {
    payables: permission(actor, 'finance.payable.read'),
    invoices: permission(actor, 'finance.supplier_invoice.read'),
    settlements: permission(actor, 'finance.settlement.read'),
    cashbook: permission(actor, 'finance.cashbook.read'),
    purchaseOrders: permission(actor, 'procurement.purchase_order.read'),
    receiving: permission(actor, 'receiving.read'),
    bankReconciliation: permission(actor, 'finance.bank_reconciliation.read'),
    amounts: permission(actor, 'finance.amounts.read'),
    partner: permission(actor, 'finance.partner_snapshot.read'),
  }
  const partitions = {
    suppliers: partitionBusinessRecords('supplier', records.suppliers, { available: available.suppliers }),
    payables: partitionBusinessRecords('payable_obligation', records.payables, { available: available.payables, visible: visible.payables }),
    invoices: partitionBusinessRecords('supplier_invoice', records.invoices, { available: available.invoices, visible: visible.invoices }),
    settlements: partitionBusinessRecords('settlement_document', records.settlements, { available: available.settlements, visible: visible.settlements }),
    purchaseOrders: partitionBusinessRecords('purchase_order', records.purchaseOrders, { available: available.purchaseOrders, visible: visible.purchaseOrders }),
    receiving: partitionBusinessRecords('receiving_document', records.receiving, { available: available.receiving, visible: visible.receiving }),
  }
  const safeRecords = {
    invoices: partitions.invoices.validRecords,
    settlements: partitions.settlements.validRecords,
    receiving: partitions.receiving.validRecords,
    bankExceptions: visible.bankReconciliation && available.bankReconciliation ? array(records.bankExceptions).filter((row) => row?.safeDto === true || row?.projection === 'bank_ai_context_safe_v1') : [],
  }

  const summaries = partitions.suppliers.validRecords.map((supplier) => {
    const id = supplierKey(supplier)
    const payables = partitions.payables.validRecords.filter((row) => payableSupplierId(row) === id)
    const invoices = partitions.invoices.validRecords.filter((row) => text(row.supplierId) === id)
    const purchaseOrders = partitions.purchaseOrders.validRecords.filter((row) => text(row.supplierId) === id)
    const receiving = partitions.receiving.validRecords.filter((row) => text(row.supplierId) === id || purchaseOrders.some((po) => text(row.poId) === text(po.id)))
    const rfqs = available.rfqs && visible.purchaseOrders ? array(records.rfqs).filter((row) => text(row.supplierId) === id || array(row.invitedSupplierIds).map(text).includes(id)) : []
    const bankExceptions = safeRecords.bankExceptions.filter((row) => !row.supplierId || text(row.supplierId) === id)
    const activePayables = payables.filter((row) => !['settled', 'cancelled', 'voided'].includes(text(row.status).toLowerCase()) && decimal(row.outstandingAmount) > 0)
    const scopedPayables = timeWindow?.type && timeWindow.type !== 'all' ? activePayables.filter((row) => inWindow(row.dueDate, timeWindow)) : activePayables
    const blocks = activePayables.flatMap((payable) => blockReasonsForPayable(payable, safeRecords).map((reason) => ({ payableId: payable.id, reason, supplierId: id })))
    const blockedIds = new Set(blocks.map((row) => row.payableId))
    const ready = scopedPayables.filter((row) => !blockedIds.has(row.id))
    const overdue = activePayables.filter((row) => isOverdue(row.dueDate, current))
    const maxOverdueDays = overdue.reduce((max, row) => Math.max(max, Math.floor((current.getTime() - date(row.dueDate).getTime()) / 86_400_000)), 0)
    const dueAmount = scopedPayables.reduce((sum, row) => sum + (decimal(row.outstandingAmount) || 0), 0)
    const overdueAmount = overdue.reduce((sum, row) => sum + (decimal(row.outstandingAmount) || 0), 0)
    const openInvoices = invoices.filter((row) => !['paid', 'cancelled', 'voided'].includes(text(row.status).toLowerCase()))
    const mismatchInvoices = invoices.filter((row) => /exception|mismatch|variance|差异/.test(text(row.matchStatus).toLowerCase()) || decimal(row.varianceAmount) !== null && decimal(row.varianceAmount) !== 0)
    const disputedInvoices = invoices.filter((row) => /disput|争议/.test(`${text(row.status)} ${text(row.matchStatus)}`.toLowerCase()))
    const missingEvidenceInvoices = invoices.filter((row) => !row.relatedPoId || row.relatedGrnId && !receiving.some((item) => item.id === row.relatedGrnId || item.documentNumber === row.relatedGrnId))
    const openPos = purchaseOrders.filter((row) => !['closed', 'completed', 'cancelled', 'voided'].includes(text(row.status).toLowerCase()))
    const overduePos = openPos.filter((row) => isOverdue(row.expectedDate, current))
    const unreceivedPos = openPos.filter((row) => {
      const ordered = array(row.lines).reduce((sum, line) => sum + (decimal(line.orderedQuantity) || 0), 0)
      const receivedQty = array(row.lines).reduce((sum, line) => sum + (decimal(line.receivedQuantity) || 0), 0)
      return ordered > receivedQty
    })
    const receivingExceptions = receiving.filter((row) => /exception|reject|异常|拒收/.test(text(row.status).toLowerCase()) || array(row.lines).some((line) => (decimal(line.rejectedQty) || 0) > 0))
    const rejectedQuantity = receivingExceptions.flatMap((row) => array(row.lines)).reduce((sum, line) => sum + (decimal(line.rejectedQty) || 0), 0)
    const pendingReceivingEvidence = receiving.filter((row) => ['draft', 'receiving', 'unposted'].includes(text(row.workflowStatus || row.postingStatus).toLowerCase()) && array(row.attachments).length === 0)
    const awaitingRfqs = rfqs.filter((row) => !['awarded', 'closed', 'cancelled'].includes(text(row.status).toLowerCase()) && Number(row.respondedSupplierCount ?? row.quoted ?? 0) < Number(row.supplierCount ?? row.suppliers ?? 0))
    const expiredRfqs = rfqs.filter((row) => isOverdue(row.dueDate || row.due, current) && !['awarded', 'closed', 'cancelled'].includes(text(row.status).toLowerCase()))
    const incompleteRecordCount = Object.values(partitions).reduce((sum, item) => sum + item.incompleteRecords.filter(({ record }) => [record.supplierId, record.supplierInvoice?.supplierId].map(text).includes(id)).length, 0)
    const limitations = []
    for (const [key, state] of Object.entries(available)) if (!state) limitations.push(`${key}_unavailable`)
    if (!visible.amounts) limitations.push('amounts_hidden')
    if (!visible.partner) limitations.push('partner_snapshot_hidden')
    const result = {
      supplier: { id, code: text(supplier.code) || null, name: visible.partner ? text(supplier.name) : null, displayName: visible.partner ? text(supplier.name) : '受限供应商', fieldVisibility: { partner: visible.partner } },
      payment: {
        state: sourceState(available.payables, visible.payables, partitions.payables, scopedPayables.length),
        dueCount: available.payables && visible.payables ? scopedPayables.length : null,
        dueAmount: available.payables && visible.payables && visible.amounts ? dueAmount : null,
        overdueCount: available.payables && visible.payables ? overdue.length : null,
        overdueAmount: available.payables && visible.payables && visible.amounts ? overdueAmount : null,
        readyCount: available.payables && visible.payables ? ready.length : null,
        blockedCount: available.payables && visible.payables ? new Set(blocks.map((row) => row.payableId)).size : null,
        blocks: available.payables && visible.payables ? blocks : [],
        maxOverdueDays,
        recordValiditySummary: partitions.payables.recordValiditySummary,
      },
      invoice: {
        state: sourceState(available.invoices, visible.invoices, partitions.invoices, openInvoices.length),
        openCount: available.invoices && visible.invoices ? openInvoices.length : null,
        mismatchCount: available.invoices && visible.invoices ? mismatchInvoices.length : null,
        disputedCount: available.invoices && visible.invoices ? disputedInvoices.length : null,
        missingEvidenceCount: available.invoices && visible.invoices ? missingEvidenceInvoices.length : null,
        recordValiditySummary: partitions.invoices.recordValiditySummary,
      },
      procurement: {
        state: sourceState(available.purchaseOrders, visible.purchaseOrders, partitions.purchaseOrders, openPos.length),
        openPoCount: available.purchaseOrders && visible.purchaseOrders ? openPos.length : null,
        overduePoCount: available.purchaseOrders && visible.purchaseOrders ? overduePos.length : null,
        overduePoIds: available.purchaseOrders && visible.purchaseOrders ? overduePos.map((row) => row.id).sort() : [],
        unreceivedPoCount: available.purchaseOrders && visible.purchaseOrders ? unreceivedPos.length : null,
        recordValiditySummary: partitions.purchaseOrders.recordValiditySummary,
      },
      receiving: {
        state: sourceState(available.receiving, visible.receiving, partitions.receiving, receivingExceptions.length),
        exceptionCount: available.receiving && visible.receiving ? receivingExceptions.length : null,
        rejectedQuantity: available.receiving && visible.receiving ? rejectedQuantity : null,
        pendingEvidenceCount: available.receiving && visible.receiving ? pendingReceivingEvidence.length : null,
        recordValiditySummary: partitions.receiving.recordValiditySummary,
      },
      rfq: {
        state: !available.rfqs ? 'unavailable' : !visible.purchaseOrders ? 'hidden' : awaitingRfqs.length + expiredRfqs.length ? 'confirmed' : 'confirmed_zero',
        awaitingResponseCount: available.rfqs && visible.purchaseOrders ? awaitingRfqs.length : null,
        expiredCount: available.rfqs && visible.purchaseOrders ? expiredRfqs.length : null,
      },
      reconciliation: {
        state: !available.bankReconciliation ? 'unavailable' : !visible.bankReconciliation ? 'hidden' : bankExceptions.length ? 'confirmed' : 'confirmed_zero',
        unreconciledPaymentCount: available.bankReconciliation && visible.bankReconciliation ? bankExceptions.filter((row) => /unreconciled|not_reconciled/.test(text(row.exceptionType))).length : null,
        blockingExceptionCount: available.bankReconciliation && visible.bankReconciliation ? bankExceptions.filter((row) => ['open', 'acknowledged'].includes(text(row.status).toLowerCase()) && text(row.severity).toLowerCase() === 'blocking').length : null,
      },
      dataQuality: { incompleteRecordCount, limitations },
      priority: null,
      recommendedActions: unique([
        blocks.length ? 'review_payment_blocks' : null,
        overduePos.length ? 'follow_up_overdue_purchase_orders' : null,
        receivingExceptions.length ? 'review_receiving_exceptions' : null,
        mismatchInvoices.length ? 'review_invoice_exceptions' : null,
        bankExceptions.length ? 'review_bank_reconciliation_exceptions' : null,
      ]),
      evidence: unique([
        ...scopedPayables.map((row) => evidence('payable_obligation', row.id, row.obligationNumber || row.id, row.status, '/finance?view=payables')),
        ...overduePos.map((row) => evidence('purchase_order', row.id, row.id, row.status, '/procurement?view=purchase-orders')),
        ...mismatchInvoices.map((row) => evidence('supplier_invoice', row.id, row.invoiceNumber || row.id, row.status, '/finance?view=invoices')),
        ...receivingExceptions.map((row) => evidence('receiving_doc', row.id, row.documentNumber || row.id, row.status, '/receiving')),
      ].filter(Boolean).map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)),
      sourceStatus: { available, visible },
    }
    result.priority = priorityFor(result, dueAmount)
    delete result.payment.maxOverdueDays
    return result
  })

  summaries.sort((left, right) => right.priority.score - left.priority.score || left.supplier.id.localeCompare(right.supplier.id))
  return {
    items: summaries,
    recordValiditySummary: validitySummary({
      validCount: partitions.suppliers.recordValiditySummary.validCount,
      incompleteCount: Object.values(partitions).reduce((sum, item) => sum + item.recordValiditySummary.incompleteCount, 0),
      invalidCount: Object.values(partitions).reduce((sum, item) => sum + item.recordValiditySummary.invalidCount, 0),
      hiddenCount: Object.values(partitions).reduce((sum, item) => sum + item.recordValiditySummary.hiddenCount, 0),
      unavailable: Object.values(partitions).some((item) => item.recordValiditySummary.unavailable),
    }),
    fieldVisibility: { amounts: visible.amounts, partner: visible.partner },
    sourceStatus: { available, visible },
  }
}

async function loadIf(allowed, loader) {
  if (!allowed) return []
  return loader()
}

export function createSupplierActionSummaryReadService({ prisma, env = process.env, now = () => new Date(), bankService } = {}) {
  if (!prisma) throw new Error('prisma is required')
  return {
    async read({ timeWindow } = {}, context = {}) {
      const actor = context.actor || await resolveProvisionedActor(prisma, context.identity || context, { allowMissingTestActor: true })
      const tenantId = actor.tenantId
      const allowed = (code) => can({ actor, permission: code, tenantId })
      const [suppliers, payables, invoices, settlements, purchaseOrders, receiving, rfqs] = await Promise.all([
        prisma.supplier.findMany({ where: { tenantId }, orderBy: [{ id: 'asc' }] }),
        loadIf(allowed('finance.payable.read'), () => prisma.payableObligation.findMany({ where: { tenantId }, include: { supplierInvoice: { include: { matchRuns: { include: { exceptions: true } } } } }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })),
        loadIf(allowed('finance.supplier_invoice.read'), () => prisma.supplierInvoice.findMany({ where: { tenantId }, include: { matchRuns: { include: { exceptions: true } } }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('finance.settlement.read'), () => prisma.settlementDocument.findMany({ where: { tenantId }, include: { allocations: true }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('procurement.purchase_order.read'), () => prisma.purchaseOrder.findMany({ where: { tenantId }, include: { lines: true }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('receiving.read'), () => prisma.receivingDocument.findMany({ where: { tenantId }, include: { lines: true, attachments: true }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('procurement.purchase_order.read'), () => prisma.rfq.findMany({ where: { tenantId }, include: { lines: true }, orderBy: [{ id: 'asc' }] })),
      ])
      let bankExceptions = []
      let bankAvailable = true
      if (allowed('finance.bank_reconciliation.read')) {
        try {
          const safeService = bankService || createBankReconciliationService({ prisma, env })
          const response = await safeService.listExceptions(context)
          bankExceptions = array(response.items).map((row) => ({ ...row, safeDto: true }))
        } catch (error) {
          if (['BANK_RECONCILIATION_CAPABILITY_NOT_AVAILABLE', 'AUTHORIZATION_CAPABILITY_DISABLED'].includes(error?.code)) bankAvailable = false
          else throw error
        }
      }
      return buildSupplierActionSummaries({
        records: { suppliers, payables, invoices, settlements, purchaseOrders, receiving, rfqs, bankExceptions },
        actor,
        sourceAvailability: { bankReconciliation: bankAvailable },
        timeWindow,
        now: now(),
      })
    },
  }
}
