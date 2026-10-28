import { capabilityForEnvironment } from './capability-registry.mjs'
import { contractsEnabled } from './contract-policy.mjs'
import { readContractWork } from './contract-read-service.mjs'
import { CUSTOMER_NAMESPACE } from './master-data-commands.mjs'
import { overdueReceivableWhere } from './operational-finance-o2c-read-service.mjs'
import { createReorderListReadService } from './reorder-list-read-service.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

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
//
// Amounts need finance.amounts.read and customer names
// finance.partner_snapshot.read, as on the finance pages; a hidden value is
// null. A source that cannot be read is left out and named in limitations,
// so the page says what it could not check instead of failing.

const FINANCE_LIMIT = 100
const decimal = (value) => (value === null || value === undefined ? null : String(value))
const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null)

async function databaseClient(ctx) {
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
      truncatedSubjects: (rawContext.truncatedSubjects || []).filter((entry) => ['inventory_items', 'sales_orders', 'purchase_orders'].includes(entry?.subject)),
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
  let setup = null
  reads.push(attempt('setup_counts', async () => {
    const [items, suppliers, customers, stockedItems, activeUsers, pendingInvitations] = await Promise.all([
      prisma.item.count({ where: { tenantId } }),
      prisma.supplier.count({ where: { tenantId } }),
      prisma.runtimeRecord.count({ where: { tenantId, namespace: CUSTOMER_NAMESPACE } }),
      prisma.inventoryBalance.count({ where: { tenantId, onHandQuantity: { gt: 0 } } }),
      prisma.user.count({ where: { tenantId, status: 'active' } }),
      prisma.workspaceInvitation.count({ where: { tenantId, status: 'pending', expiresAt: { gt: now } } }),
    ])
    setup = { items, suppliers, customers, stockedItems, activeUsers, pendingInvitations }
  }))
  await Promise.all(reads)

  return {
    sources,
    setup,
    setupOptions: {
      permissions: home.setup || {},
      importEnabled: Boolean(capabilityForEnvironment('data-import', ctx.env || process.env)?.enabled),
      adjustmentsEnabled: Boolean(capabilityForEnvironment('inventory-adjustment-document', ctx.env || process.env)?.enabled),
    },
    limitations,
  }
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

