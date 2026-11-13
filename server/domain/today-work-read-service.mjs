import { contractsEnabled } from './contract-policy.mjs'
import { readContractWork } from './contract-read-service.mjs'
import { firstRunSetupOptions, readFirstRunSetupCounts } from './first-run-setup.mjs'
import { overdueReceivableWhere } from './operational-finance-o2c-read-service.mjs'
import { createReorderListReadService, stockTruncatedSubjects } from './reorder-list-read-service.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { procurementDocumentNumber } from '../../shared/document-numbering.mjs'

// The records Today needs beyond the business read context, each read as its
// own page reads it and only for a reader who may open that page:
//
//   reorder           the reorder list (createReorderListReadService), with
//                     stock and incoming from the allocation model over the
//                     reader's warehouses, as GET /api/inventory/reorder-list;
//                     inventory.balance.read. A reader of only some
//                     warehouses gets every item as not checked, as there.
//   open orders       every purchase order through listForReport, as the open
//                     purchase orders report and the assistant read them;
//                     procurement.purchase_order.read.
//   invoices          customer invoices approved and not issued, and the most
//                     recently changed ones; finance.customer_invoice.read.
//   receivables       overdue by the finance landing's rule
//                     (overdueReceivableWhere) at the start of the workspace
//                     day, so a receivable due today is not overdue;
//                     finance.receivable.read.
//   contracts         with the contracts capability on and
//                     contracts.contract.read: active contracts whose notice
//                     deadline or end date is inside their reminder window,
//                     or whose end date passed with no renewal activated
//                     (readContractWork), the reader's own as owner, or every
//                     one for a reader with contracts.contract.manage.
//   setup counts      items, suppliers, customers, items with stock on hand,
//                     active users and pending invitations, for the first-day
//                     checklist.
//   bill payments     the payable status of each approved supplier invoice in
//                     the business read context, so Recent documents shows a
//                     paid invoice as Paid, as the supplier invoice list does
//                     (billPaymentStatus); with finance.supplier_invoice.read,
//                     the permission that lists the invoice at all.
//
// Amounts need finance.amounts.read and customer names
// finance.partner_snapshot.read, as on the finance pages; a hidden value is
// null. A source that cannot be read is left out and named in limitations,
// so the page says what it could not check instead of failing.

const FINANCE_LIMIT = 100
const decimal = (value) => (value === null || value === undefined ? null : String(value))
const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null)

export async function databaseClient(ctx) {
  if (ctx.homeOverviewPrisma) return ctx.homeOverviewPrisma
  if (ctx.inventoryPrisma) return ctx.inventoryPrisma
  const env = ctx.env || process.env
  return env.DATABASE_URL ? getPrismaClient(env) : null
}

function customerInvoiceRow(row, access) {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    customerName: access.partner ? row.customerNameSnapshot ?? null : null,
    invoiceDate: iso(row.invoiceDate),
    totalAmount: access.amounts ? decimal(row.totalAmount) : null,
    currency: row.currency,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

const CUSTOMER_INVOICE_SELECT = { id: true, invoiceNumber: true, customerNameSnapshot: true, invoiceDate: true, totalAmount: true, currency: true, status: true, createdAt: true, updatedAt: true }

export async function readTodayWorkSources(ctx, { access, rawContext, now, today, timeZone }) {
  const tenantId = ctx.identity?.tenantId
  const home = access.home || {}
  const limitations = []
  const sources = {}
  const attempt = async (name, read) => {
    try { return await read() } catch { limitations.push(`today_source_unavailable:${name}`); return null }
  }
  const truncated = (rows, subject) => {
    if (rows.length <= FINANCE_LIMIT) return rows
    limitations.push(`truncated:${subject}`)
    return rows.slice(0, FINANCE_LIMIT)
  }

  // Stock in the reader's warehouses against every open order's demand, as
  // the inventory pages and the reorder list compute it.
  const allocation = access.collections.inventoryItems ? buildRuntimeInventoryAllocation(rawContext) : null
  sources.allocationRows = allocation?.availability || []

  const procurementRuntime = ctx.repositories?.procurementRuntime
  if (access.collections.purchaseOrders && typeof procurementRuntime?.listForReport === 'function') {
    const rows = await attempt('purchase_orders', () => procurementRuntime.listForReport({ tenantId }))
    if (rows) sources.reportPurchaseOrders = rows
  }

  const prisma = await attempt('database', () => databaseClient(ctx))
  if (!prisma || !tenantId) {
    limitations.push('today_database_sources_unavailable')
    return { sources, setup: null, setupOptions: {}, limitations }
  }

  const reads = []
  if (allocation) {
    reads.push(attempt('reorder_list', () => createReorderListReadService({ prisma }).read({
      tenantId,
      warehouseIds: access.warehouseIds ?? null,
      today,
      timeZone,
      allocationRows: allocation.availability,
      showPurchaseOrders: Boolean(access.collections.purchaseOrders),
      truncatedSubjects: stockTruncatedSubjects(rawContext.truncatedSubjects),
    })).then((reorder) => { sources.reorder = reorder }))
  }
  if (home.customerInvoices) {
    reads.push(attempt('customer_invoices', async () => {
      const [awaitingIssue, recent] = await Promise.all([
        prisma.customerInvoice.findMany({ where: { tenantId, status: 'approved' }, select: CUSTOMER_INVOICE_SELECT, orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], take: FINANCE_LIMIT + 1 }),
        prisma.customerInvoice.findMany({ where: { tenantId }, select: CUSTOMER_INVOICE_SELECT, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: FINANCE_LIMIT }),
      ])
      sources.customerInvoices = truncated(awaitingIssue, 'customer_invoices').map((row) => customerInvoiceRow(row, access))
      sources.recentCustomerInvoices = recent.map((row) => customerInvoiceRow(row, access))
    }))
  }
  if (home.receivables) {
    reads.push(attempt('receivables', async () => {
      const rows = await prisma.receivableObligation.findMany({
        where: { tenantId, ...overdueReceivableWhere(new Date(`${today}T00:00:00.000Z`)) },
        include: { customerInvoice: { select: { id: true, invoiceNumber: true, customerNameSnapshot: true } } },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: FINANCE_LIMIT + 1,
      })
      sources.receivables = truncated(rows, 'receivables').map((row) => ({
        id: row.id,
        obligationNumber: row.obligationNumber,
        customerInvoiceId: row.customerInvoiceId,
        customerInvoiceNumber: row.customerInvoice?.invoiceNumber ?? null,
        customerName: access.partner ? row.customerInvoice?.customerNameSnapshot ?? null : null,
        dueDate: iso(row.dueDate),
        outstandingAmount: access.amounts ? decimal(row.outstandingAmount) : null,
        // The read asked for money still owed; without the amount permission
        // the amount is hidden, not zero.
        amountHidden: !access.amounts,
        currency: row.currency,
        status: row.status,
        disputeStatus: row.disputeStatus ?? null,
      }))
    }))
  }
  const contracts = home.contracts || {}
  if (contractsEnabled(ctx.env || process.env) && contracts.read && (contracts.manage || contracts.userId)) {
    reads.push(attempt('contracts', async () => {
      const work = await readContractWork(prisma, { tenantId, today, ownerId: contracts.manage ? null : contracts.userId })
      sources.contracts = work.contracts
      if (work.truncated) limitations.push('truncated:contracts')
    }))
  }
  // Only for display: when it cannot be read, an approved invoice reads
  // "Approved" as before, and nothing is said about it.
  const approvedBills = access.collections.supplierInvoices
    ? [...new Set((rawContext?.supplierInvoices || []).filter((row) => row?.status === 'approved' && row.id).map((row) => String(row.id)))]
    : []
  if (approvedBills.length) {
    reads.push((async () => {
      try {
        const rows = await prisma.payableObligation.findMany({ where: { tenantId, supplierInvoiceId: { in: approvedBills } }, select: { supplierInvoiceId: true, status: true } })
        sources.billPayableStatuses = Object.fromEntries(rows.map((row) => [row.supplierInvoiceId, row.status]))
      } catch { /* shown as approved */ }
    })())
  }
  // Invoices the three-way match held: their blocking differences, the match
  // lines, the order each bills and this supplier's order prices for the same
  // SKUs, for the step Today drafts for each (invoice-exception-draft.mjs).
  // Prices only for a reader who may see amounts.
  const heldBills = access.collections.supplierInvoices
    ? [...new Set((rawContext?.supplierInvoices || []).filter((row) => row?.status === 'exception' && row.id).map((row) => String(row.id)))].slice(0, FINANCE_LIMIT)
    : []
  if (heldBills.length) {
    reads.push(attempt('invoice_exceptions', async () => {
      const [invoices, exceptions] = await Promise.all([
        prisma.supplierInvoice.findMany({ where: { tenantId, id: { in: heldBills } }, select: { id: true, invoiceNumber: true, supplierId: true, supplierName: true, relatedPoId: true, currency: true } }),
        prisma.financeMatchException.findMany({
          where: { tenantId, supplierInvoiceId: { in: heldBills }, status: { in: ['open', 'rejected'] } },
          select: { id: true, matchLineId: true, supplierInvoiceId: true, exceptionType: true, status: true, expectedValue: true, actualValue: true, varianceValue: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ])
      const lineIds = [...new Set(exceptions.map((row) => row.matchLineId).filter(Boolean))]
      const orderIds = [...new Set(invoices.map((row) => row.relatedPoId).filter(Boolean))]
      const supplierIds = [...new Set(invoices.map((row) => row.supplierId).filter(Boolean))]
      const [lines, orders] = await Promise.all([
        lineIds.length ? prisma.threeWayMatchLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, sku: true, unit: true, orderedQuantity: true, receivedQuantity: true, previouslyInvoicedQuantity: true, invoiceQuantity: true, poUnitPrice: true, invoiceUnitPrice: true } }) : [],
        orderIds.length ? prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, number: true, metadata: true } }) : [],
      ])
      const skus = [...new Set(lines.map((row) => row.sku).filter(Boolean))]
      const orderLines = access.amounts && skus.length && supplierIds.length
        ? await prisma.purchaseOrderLine.findMany({
          where: { sku: { in: skus }, purchaseOrder: { tenantId, supplierId: { in: supplierIds } } },
          select: { sku: true, unitPrice: true, purchaseOrder: { select: { id: true, number: true, metadata: true, supplierId: true } } },
          take: 2000,
        })
        : []
      const numberOf = (order) => (order ? procurementDocumentNumber(order) : null)
      const ordersById = new Map(orders.map((order) => [order.id, order]))
      const hidden = (value) => (access.amounts ? decimal(value) : null)
      sources.invoiceExceptions = {
        amountsVisible: Boolean(access.amounts),
        invoices: invoices.map((row) => ({ id: row.id, invoiceNumber: row.invoiceNumber || row.id, supplierId: row.supplierId, supplierName: row.supplierName, orderId: row.relatedPoId, orderNumber: numberOf(ordersById.get(row.relatedPoId)) || row.relatedPoId || null, currency: row.currency })),
        exceptions: exceptions.map((row) => ({ ...row, expectedValue: row.exceptionType === 'quantity' ? decimal(row.expectedValue) : hidden(row.expectedValue), actualValue: row.exceptionType === 'quantity' ? decimal(row.actualValue) : hidden(row.actualValue), varianceValue: row.exceptionType === 'quantity' ? decimal(row.varianceValue) : hidden(row.varianceValue) })),
        lines: Object.fromEntries(lines.map((row) => [row.id, { sku: row.sku, unit: row.unit, orderedQuantity: decimal(row.orderedQuantity), receivedQuantity: decimal(row.receivedQuantity), previouslyInvoicedQuantity: decimal(row.previouslyInvoicedQuantity), invoiceQuantity: decimal(row.invoiceQuantity), poUnitPrice: hidden(row.poUnitPrice), invoiceUnitPrice: hidden(row.invoiceUnitPrice) }])),
        orderPrices: orderLines.map((row) => ({ sku: row.sku, unitPrice: decimal(row.unitPrice), orderId: row.purchaseOrder?.id || null, orderNumber: numberOf(row.purchaseOrder), supplierId: row.purchaseOrder?.supplierId || null })),
      }
    }))
  }
  // The same counts and options the assistant's setup_status reads (first-run-setup.mjs).
  let setup = null
  reads.push(attempt('setup_counts', async () => {
    setup = await readFirstRunSetupCounts(prisma, { tenantId, now })
  }))
  await Promise.all(reads)

  return { sources, setup, setupOptions: firstRunSetupOptions(access, ctx.env || process.env), limitations }
}

// The kinds of work the reader's role cannot open, so the page can say they
// are not listed rather than suggest there is none. Contracts count only
// while the contracts capability is on.
export function todayHiddenWork(access, env = process.env) {
  const home = access.home || {}
  return [
    ...(access.collections.purchaseOrders ? [] : ['purchasing']),
    ...(access.collections.inventoryItems ? [] : ['inventory']),
    ...(access.collections.supplierInvoices ? [] : ['bills']),
    ...(access.collections.salesOrders ? [] : ['sales_orders']),
    ...(home.customerInvoices ? [] : ['customer_invoices']),
    ...(home.receivables ? [] : ['receivables']),
    ...(contractsEnabled(env) && !home.contracts?.read ? ['contracts'] : []),
  ]
}

