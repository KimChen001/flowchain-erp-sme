import { readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { isOpenPurchaseOrder } from './open-purchase-order.mjs'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { buildRuntimeInventoryAllocation, isInventoryRiskSku } from './runtime-inventory-allocation-read-model.mjs'
import { RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES } from './procurement-status-authority.mjs'
import { classifyBusinessRecord } from './ai-business-record-validity.mjs'
import { aiSkillVisibility } from './ai-skill-registry.mjs'

// The facts every workspace skill reads, through the same definitions the
// reports use, so an answer can never disagree with a report:
//   - open, overdue and incomplete purchase orders: the open purchase orders
//     report (buildOpenPurchaseOrdersReport over the same rows its route reads);
//   - committed PO spend and committed supplier invoices, per currency: the
//     governed report KPIs (isCommittedPurchaseOrder and
//     RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES, never added across currencies);
//   - inventory: the runtime allocation model (per-line demand, in-transit
//     remainder, stock status) and its at-risk definition.
// The result holds codes, ids and numbers only; the presenter writes the text.
// Every read carries the actor's tenant. A source the actor may not read is
// left out and reported as hidden_by_permission, never as zero.

const array = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const amount = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const RAW_LIMIT = 500
const committedInvoiceStatuses = new Set(RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES)
const SUBJECT_SOURCE = { purchase_orders: 'purchase_orders', purchase_requests: 'purchase_requests', rfqs: 'rfqs', receipts: 'receipts', supplier_invoices: 'supplier_invoices', inventory_balances: 'inventory', items: 'inventory' }

// Money as the report KPI states it: per currency, with its aggregation status
// and money limitations. The report's display labels are not carried over.
function kpiMoney(kpi) {
  if (!kpi) return null
  return {
    status: kpi.currencyAggregationStatus,
    total: kpi.currentValue ?? null,
    amounts: array(kpi.currencyAmounts).map((row) => ({ currency: row.currencyCode || null, amount: row.amount ?? null, recordCount: row.recordCount })),
    limitations: array(kpi.limitations),
  }
}

async function boundedRaw(delegate, args, subject, limitations) {
  if (typeof delegate?.findMany !== 'function') return null
  const rows = await delegate.findMany({ ...args, take: RAW_LIMIT + 1 })
  if (rows.length > RAW_LIMIT) limitations.push({ code: 'truncated', source: subject, limit: RAW_LIMIT })
  return rows.slice(0, RAW_LIMIT)
}

// Raw Item and InventoryBalance columns for the data completeness check: the
// read repositories default missing units and thresholds, which would hide
// exactly what the check looks for.
async function rawRecordColumns(prisma, tenantId, visible, limitations) {
  if (!prisma || !visible.inventory) return { items: null, balances: null }
  const [items, balances] = await Promise.all([
    boundedRaw(prisma.item, { where: { tenantId }, select: { id: true, sku: true, name: true, unit: true, preferredSupplierId: true, safetyStock: true, reorderPoint: true }, orderBy: [{ id: 'asc' }] }, 'items', limitations),
    boundedRaw(prisma.inventoryBalance, { where: { tenantId }, select: { id: true, sku: true, itemId: true, availableQuantity: true, safetyStock: true, reorderPoint: true }, orderBy: [{ id: 'asc' }] }, 'inventory', limitations),
  ])
  return { items, balances }
}

// RFQ responses and awards from their own tables: the RFQ row's response
// counters are not kept in step with participations.
async function rfqEvidence(prisma, tenantId, rfqs) {
  const ids = rfqs.map((rfq) => text(rfq.id)).filter(Boolean)
  if (!prisma || !ids.length || typeof prisma.rfqSupplierParticipation?.findMany !== 'function') return null
  const [participations, awards] = await Promise.all([
    prisma.rfqSupplierParticipation.findMany({ where: { tenantId, rfqId: { in: ids } }, select: { rfqId: true, status: true } }),
    prisma.rfqAwardDecision.findMany({ where: { tenantId, rfqId: { in: ids } }, select: { rfqId: true } }),
  ])
  return {
    responses: new Map(ids.map((id) => [id, participations.filter((row) => row.rfqId === id && row.status === 'response_recorded').length])),
    awarded: new Set(awards.map((row) => row.rfqId)),
  }
}

function recordsNeedingData({ reportRows, openReport, business, raw, visible, tenantId }) {
  const records = []
  const checked = {}
  const add = (entityType, entityId, label, source, missing) => { if (missing.length) records.push({ entityType, entityId, label: label || entityId, source, missing: [...new Set(missing)] }) }
  if (visible.inventory) {
    const items = raw.items ?? array(business.items).map((row) => ({ id: row.id, sku: row.sku, name: row.name, unit: row.unit ?? null, preferredSupplierId: row.preferredSupplierId || null, safetyStock: row.safetyStock ?? null, reorderPoint: row.reorderPoint ?? null }))
    const balances = raw.balances ?? array(business.inventoryItems).map((row) => ({ id: row.id, sku: row.sku, itemId: row.itemId, availableQuantity: row.availableQuantity ?? null, safetyStock: row.safetyStock ?? null, reorderPoint: row.reorderPoint ?? null }))
    const positive = (value) => amount(value) !== null && amount(value) > 0
    checked.items = items.length
    for (const item of items) {
      const skuBalances = balances.filter((row) => text(row.sku) === text(item.sku) || text(row.itemId) === text(item.id))
      // As the runtime stock status reads it: the item threshold, else a balance's.
      const hasThreshold = positive(item.safetyStock) || positive(item.reorderPoint) || skuBalances.some((row) => positive(row.safetyStock) || positive(row.reorderPoint))
      add('item', text(item.id), text(item.sku), 'items', [
        ...(!text(item.unit) ? ['unit'] : []),
        ...(!text(item.preferredSupplierId) ? ['preferred_supplier'] : []),
        ...(!hasThreshold ? ['stock_threshold'] : []),
      ])
    }
    checked.inventory = balances.length
    for (const balance of balances) if (amount(balance.availableQuantity) === null) add('item', text(balance.itemId || balance.sku), text(balance.sku), 'inventory', ['available_quantity'])
  }
  if (visible.purchase_orders) {
    // The open purchase orders report's dataIncomplete rule.
    const sourceById = new Map(reportRows.map((po) => [text(po.id), po]))
    checked.purchase_orders = openReport.summary.open
    for (const row of array(openReport.exportRows).filter((entry) => entry.dataIncomplete)) {
      const lines = array(sourceById.get(row.id)?.lines)
      add('purchase_order', row.id, row.orderNumber, 'purchase_orders', [
        ...(!lines.length ? ['lines'] : []),
        ...(row.ordered === null || row.received === null ? ['line_quantity'] : []),
        ...(row.isOpen && (!row.dueDate || lines.some((line) => !text(line.promisedDate))) ? ['promised_date'] : []),
        ...(!text(row.currency) ? ['currency'] : []),
      ])
    }
    const requests = array(business.purchaseRequests).filter((row) => ['draft', 'submitted', 'approved'].includes(text(row.status)))
    checked.purchase_requests = requests.length
    for (const request of requests) add('purchase_request', text(request.id), text(request.id), 'purchase_requests', [...(!text(request.requiredDate) ? ['required_date'] : []), ...(!array(request.lines).length ? ['lines'] : [])])
  }
  const classified = (entityType, rows, source, type, label) => {
    checked[source] = rows.length
    for (const row of rows) {
      const result = classifyBusinessRecord(type, { tenantId, ...row })
      const missing = result.state === 'incomplete' ? result.missingFields.map((field) => ({ supplierId: 'supplier', amount: 'amount', invoiceNumber: 'name', poId: 'purchase_order', status: 'status' })[field] || 'name') : []
      if (type === 'supplier_invoice' && !text(row.currency)) missing.push('currency')
      add(entityType, text(row.id), label(row), source, missing)
    }
  }
  if (visible.supplier_invoices) classified('supplier_invoice', array(business.supplierInvoices), 'supplier_invoices', 'supplier_invoice', (row) => text(row.invoiceNumber || row.id))
  if (visible.receipts) classified('receiving_doc', array(business.receipts), 'receipts', 'receiving_document', (row) => text(row.documentNumber || row.id))
  return { records, checked }
}

export async function readAiSkillFacts(skillContext) {
  const { actor, tenantId, tenant, now, today, prisma, routeContext = {} } = skillContext
  const visibility = aiSkillVisibility(actor)
  const visible = visibility.sources
  const limitations = []
  const hidden = Object.entries(visible).filter(([, allowed]) => !allowed).map(([source]) => source)
  if (hidden.length) limitations.push({ code: 'hidden_by_permission', sources: hidden })
  if (visible.purchase_orders && !visibility.amounts.purchase_order_amounts) limitations.push({ code: 'amounts_hidden', what: 'purchase_orders' })
  if (visible.supplier_invoices && !visibility.amounts.invoice_amounts) limitations.push({ code: 'amounts_hidden', what: 'supplier_invoices' })

  // The same reads the report routes make, scoped to the actor's tenant.
  const readCtx = { ...routeContext, identity: { ...routeContext.identity, tenantId } }
  const business = routeContext.aiSkillBusinessContext || await readBusinessContext(readCtx)
  for (const entry of array(business.truncatedSubjects)) {
    const source = SUBJECT_SOURCE[entry.subject]
    if (source && visible[source]) limitations.push({ code: 'truncated', source, limit: entry.limit })
  }
  const procurementRuntime = routeContext.repositories?.procurementRuntime
  const reportRows = visible.purchase_orders
    ? (typeof procurementRuntime?.listForReport === 'function' ? await procurementRuntime.listForReport({ tenantId }) : array(business.purchaseOrders))
    : []
  const raw = await rawRecordColumns(prisma, tenantId, visible, limitations)

  const facts = {
    tenantId, locale: tenant.locale, currency: tenant.currency, timezone: tenant.timezone,
    generatedAt: now.toISOString(), today, visibility, limitations, hidden,
    checked: Object.entries(visible).filter(([, allowed]) => allowed).map(([source]) => source),
    purchaseOrders: null, inventory: null, invoices: null, purchaseRequests: null, rfqs: null, receipts: null,
  }

  const overview = buildRuntimeGovernedReport(business, { subject: 'overview' })
  const kpi = (report, id) => array(report.kpis).find((row) => row.id === id)
  // Overdue days count to the tenant's calendar day, as in the report itself.
  const openReport = buildOpenPurchaseOrdersReport(reportRows, { export: 'true' }, now, { timeZone: tenant.timezone })
  facts.asOf = openReport.asOf
  // The report and the assistant share one day; say so if they ever differ.
  if (visible.purchase_orders && openReport.asOf !== today) limitations.push({ code: 'report_day', date: openReport.asOf })

  if (visible.purchase_orders) {
    const lineById = new Map(reportRows.map((po) => [text(po.id), array(po.lines)[0] || null]))
    facts.purchaseOrders = {
      open: openReport.summary.open,
      overdue: openReport.summary.overdue,
      incomplete: openReport.summary.incomplete,
      committedSpend: visibility.amounts.purchase_order_amounts ? kpiMoney(kpi(overview, 'purchase_order_amount')) : null,
      rows: array(openReport.exportRows).map((row) => ({
        id: row.id, orderNumber: row.orderNumber, supplierId: row.supplierId, supplier: row.supplier, status: row.status,
        dueDate: row.dueDate, overdueDays: row.overdueDays, ordered: row.ordered, received: row.received, remaining: row.remaining, unit: row.unit,
        amount: visibility.amounts.purchase_order_amounts ? row.amount : null, currency: row.currency, dataIncomplete: row.dataIncomplete,
        sku: text(lineById.get(row.id)?.sku) || null, itemId: text(lineById.get(row.id)?.itemId) || null,
      })),
    }
  }

  if (visible.inventory) {
    const allocation = buildRuntimeInventoryAllocation(business)
    const rows = allocation.availability.map((row) => ({
      sku: row.sku, itemId: row.itemId, itemName: row.itemName, onHand: row.onHand, available: row.available,
      openSalesDemand: row.openSalesDemand, incomingApprovedPo: row.incomingApprovedPo, shortage: row.shortage,
      availableToPromise: row.availableToPromise, safetyStock: row.safetyStock, reorderPoint: row.reorderPoint,
      stockStatus: row.stockStatus, riskLevel: row.riskLevel, purchaseOrderIds: row.purchaseOrderIds, salesOrderIds: row.salesOrderIds,
    }))
    facts.inventory = {
      rows,
      atRisk: rows.filter(isInventoryRiskSku).map((row) => row.sku).sort(),
      atRiskCount: kpi(overview, 'inventory_risk_sku')?.currentValue ?? rows.filter(isInventoryRiskSku).length,
    }
  }

  if (visible.supplier_invoices) {
    const finance = buildRuntimeGovernedReport(business, { subject: 'finance' })
    const committed = array(business.supplierInvoices).filter((row) => committedInvoiceStatuses.has(text(row.status).toLowerCase()))
    facts.invoices = {
      committed: visibility.amounts.invoice_amounts ? kpiMoney(kpi(finance, 'invoice_amount')) : null,
      committedCount: committed.length,
      variances: committed
        .filter((row) => (amount(row.varianceAmount) ?? 0) !== 0 || text(row.matchStatus) === 'variance')
        .map((row) => ({ id: text(row.id), invoiceNumber: text(row.invoiceNumber || row.id), supplierId: text(row.supplierId), supplier: text(row.supplierName || row.supplierId), poId: text(row.poId || row.relatedPo) || null, status: text(row.status), matchStatus: text(row.matchStatus) || null, variance: visibility.amounts.invoice_amounts ? amount(row.varianceAmount) : null, currency: text(row.currency) || null })),
    }
  }

  if (visible.purchase_requests) {
    facts.purchaseRequests = {
      awaitingApproval: array(business.purchaseRequests).filter((row) => text(row.status) === 'submitted').map((row) => {
        const line = array(row.lines)[0] || {}
        return { id: text(row.id), priority: text(row.priority) || null, requiredDate: text(row.requiredDate).slice(0, 10) || null, sku: text(line.sku) || null, quantity: amount(line.quantity), unit: text(line.unit) || null }
      }),
    }
  }

  if (visible.rfqs) {
    const open = array(business.rfqs).filter((row) => ['open', 'collecting_quotes'].includes(text(row.status)))
    const evidence = await rfqEvidence(prisma, tenantId, open)
    facts.rfqs = {
      // Without the participation tables the row counters are the only source.
      readyToAward: open.map((row) => ({ id: text(row.id), title: text(row.title) || text(row.id), responses: evidence ? evidence.responses.get(text(row.id)) || 0 : amount(row.quoted) ?? 0, awarded: evidence ? evidence.awarded.has(text(row.id)) : Boolean(text(row.bestSupplier)) }))
        .filter((row) => row.responses > 0 && !row.awarded),
    }
  }

  if (visible.receipts) {
    const openPoIds = new Set(reportRows.filter(isOpenPurchaseOrder).map((po) => text(po.id)))
    const receipts = array(business.receipts).map((row) => ({
      id: text(row.id), documentNumber: text(row.documentNumber || row.id), poId: text(row.poId) || null, supplier: text(row.supplierName || row.supplierId),
      postingStatus: text(row.postingStatus) || null, arrivedDay: text(row.arrivedAt).slice(0, 10) || null,
      rejected: array(row.lines).reduce((sum, line) => sum + (amount(line.rejectedQty) ?? 0), 0),
      unit: [...new Set(array(row.lines).map((line) => text(line.unit)).filter(Boolean))].join('/') || null,
      poOpen: openPoIds.has(text(row.poId)),
    }))
    facts.receipts = {
      // A rejection is still actionable while its purchase order is open.
      rejected: receipts.filter((row) => row.rejected > 0 && row.poOpen),
      unposted: receipts.filter((row) => row.postingStatus === 'unposted'),
    }
  }

  const { records, checked } = recordsNeedingData({ reportRows, openReport, business, raw, visible, tenantId })
  facts.records = records
  facts.recordsChecked = checked
  return facts
}
