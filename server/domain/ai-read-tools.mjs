import { AI_TOOL_LIMITS, aiToolList, aiToolPurchaseOrder, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { runLateOrderImpact } from './ai-skill-late-order-impact.mjs'
import { runSpendAnalysis } from './ai-skill-spend-analysis.mjs'
import { aiSkillPrepareComparison, runSupplierComparison } from './ai-skill-supplier-comparison.mjs'

// The read tools of the model-first assistant (docs/ai-model-first-design.md
// §4). Each reads the asking user's facts (readAiSkillFacts), which hold only
// what the user may read: a source the user cannot read is null, so its tools
// are not offered, and amounts the user may not see are null. The analyses
// reuse the skills' own calculations (spend, supplier performance, the effect
// of a late order), so a tool gives the same figures as the skill answer and
// the dashboards. Rows are ranked by date, most overdue or soonest first
// (owner decision of 2026-10-03), never by a score. Contact details are never
// returned.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const round1 = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 10)
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows, description: `How many rows to return, ${AI_TOOL_LIMITS.rows} by default.` }
const PERIODS = ['all', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year']
const periodParam = { type: 'string', enum: PERIODS, description: 'The period, counted from the workspace day. all by default.' }
const periodOf = (value) => (value && value !== 'all' ? { kind: value } : null)
const byDue = (a, b) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99') || text(a.orderNumber).localeCompare(text(b.orderNumber))
const supplierError = (found) => ({ error: found.error, candidates: found.candidates || [] })

const orderRow = (row) => ({
  orderNumber: row.orderNumber, supplier: row.supplier, status: row.status, dueDate: row.dueDate || null,
  overdueDays: row.overdueDays || 0, ordered: row.ordered ?? null, received: row.received ?? null, remaining: row.remaining ?? null, unit: row.unit || null,
  amount: row.amount ?? null, currency: row.currency || null, open: Boolean(row.isOpen), skus: array(row.skus),
  ref: aiToolRef('purchase_order', row.id, row.orderNumber),
})
const orderNumberOf = (facts, id) => array(facts.purchaseOrders?.index).find((row) => row.id === id)?.orderNumber || null
const salesOrderNumberOf = (facts, id) => array(facts.salesOrders).find((row) => row.id === id)?.number || null

const listPurchaseOrders = defineAiTool({
  name: 'list_purchase_orders',
  description: 'Purchase orders the user may read, with supplier, status, promised date, days overdue, quantities still to receive and amount. Filter by status, supplier or SKU. Most overdue first, then by promised date.',
  parameters: {
    status: { type: 'string', enum: ['open', 'overdue', 'pending_approval', 'all'], description: 'open (default): not closed or fully received; overdue: open and past the promised date; pending_approval; all.' },
    supplier: { type: 'string', description: 'A supplier name, code or id.' },
    sku: { type: 'string', description: 'Only orders with a line for this SKU.' },
    limit: limitParam,
  },
  available: (facts) => Boolean(facts.purchaseOrders),
  run(args, { facts }) {
    const status = args.status || 'open'
    let rows = status === 'pending_approval' ? array(facts.purchaseOrders.pendingApproval) : array(facts.purchaseOrders.index)
    if (status === 'open') rows = rows.filter((row) => row.isOpen)
    if (status === 'overdue') rows = rows.filter((row) => row.isOpen && (row.overdueDays || 0) > 0)
    if (args.supplier) {
      const found = aiToolSupplier(facts, args.supplier)
      if (!found.supplier) return supplierError(found)
      rows = rows.filter((row) => row.supplierId === found.supplier.id)
    }
    if (args.sku) rows = rows.filter((row) => array(row.skus).some((sku) => fold(sku) === fold(args.sku)))
    rows = [...rows].sort((a, b) => (b.overdueDays || 0) - (a.overdueDays || 0) || byDue(a, b))
    return {
      asOf: facts.asOf,
      workspace: { open: facts.purchaseOrders.open, overdue: facts.purchaseOrders.overdue, committedSpend: facts.purchaseOrders.committedSpend ?? null },
      ...aiToolList(rows.map(orderRow), args.limit),
    }
  },
})

const getPurchaseOrder = defineAiTool({
  name: 'get_purchase_order',
  description: 'One purchase order by its number: status, supplier, each open line with ordered, received and remaining quantity and its current and original promised dates, and the receipts and invoice differences recorded against it.',
  parameters: { order: { type: 'string', description: 'The order number, for example PO-020.' } },
  required: ['order'],
  available: (facts) => Boolean(facts.purchaseOrders),
  run(args, { facts }) {
    const row = aiToolPurchaseOrder(facts, args.order)
    if (!row) return { error: 'not_found' }
    const receipts = [...array(facts.receipts?.rejected), ...array(facts.receipts?.unposted)].filter((entry) => entry.poId === row.id)
    const seen = new Set()
    return {
      asOf: facts.asOf,
      order: { ...orderRow(row), createdDate: row.createdDate || null },
      openLines: array(row.openLines).map((line) => ({ sku: line.sku, itemName: line.itemName, ordered: line.ordered, received: line.received, remaining: line.remaining, unit: line.unit, promisedDate: line.promisedDate, originalPromisedDate: line.originalPromisedDate })),
      receipts: receipts.filter((entry) => !seen.has(entry.id) && seen.add(entry.id)).map((entry) => ({ documentNumber: entry.documentNumber, arrived: entry.arrivedDay, postingStatus: entry.postingStatus, rejected: entry.rejected, unit: entry.unit, ref: aiToolRef('receiving_doc', entry.id, entry.documentNumber) })),
      invoiceDifferences: array(facts.invoices?.variances).filter((entry) => entry.poId === row.id).map((entry) => ({ invoiceNumber: entry.invoiceNumber, matchStatus: entry.matchStatus, variance: entry.variance, currency: entry.currency, ref: aiToolRef('supplier_invoice', entry.id, entry.invoiceNumber) })),
    }
  },
})

const stockPosition = defineAiTool({
  name: 'stock_position',
  description: 'Stock per SKU in the inventory page\'s terms: on hand, reserved, available, open sales demand, incoming on approved purchase orders, available to promise (available plus incoming less unreserved demand), safety stock, reorder point and status. One SKU, the SKUs at risk, or all.',
  parameters: {
    sku: { type: 'string', description: 'One SKU.' },
    only: { type: 'string', enum: ['all', 'at_risk'], description: 'at_risk: short against open sales orders or below safety stock or the reorder point. all by default.' },
    limit: limitParam,
  },
  available: (facts) => Boolean(facts.inventory),
  run(args, { facts }) {
    let rows = array(facts.inventory.rows)
    if (args.sku) {
      rows = rows.filter((row) => fold(row.sku) === fold(args.sku))
      if (!rows.length) return array(facts.inventory.masterOnly).some((row) => fold(row.sku) === fold(args.sku)) ? { asOf: facts.asOf, sku: args.sku, noStockOrOrders: true } : { error: 'not_found' }
    }
    if (args.only === 'at_risk') rows = rows.filter((row) => array(facts.inventory.atRisk).includes(row.sku))
    rows = [...rows].sort((a, b) => text(a.sku).localeCompare(text(b.sku)))
    return {
      asOf: facts.asOf,
      atRiskCount: facts.inventory.atRiskCount,
      ...aiToolList(rows.map((row) => ({
        sku: row.sku, itemName: row.itemName, unit: row.unit, onHand: row.onHand, reserved: row.reserved, available: row.available,
        openSalesDemand: row.openSalesDemand, incomingOnPurchaseOrders: row.incomingApprovedPo, availableToPromise: row.availableToPromise,
        shortage: row.shortage, safetyStock: row.safetyStock, reorderPoint: row.reorderPoint, status: row.stockStatus,
        purchaseOrders: array(row.purchaseOrderIds).map((id) => orderNumberOf(facts, id)).filter(Boolean),
        salesOrders: array(row.salesOrderIds).map((id) => salesOrderNumberOf(facts, id)).filter(Boolean),
        orderMinimum: row.orderMinimum ? { quantity: row.orderMinimum.quantity ?? null } : null,
        ref: aiToolRef('item', row.itemId || row.sku, row.sku),
      })), args.limit),
    }
  },
})

const listSalesOrders = defineAiTool({
  name: 'list_sales_orders',
  description: 'Open sales orders that still need stock: customer, the day promised to the customer, and per SKU the quantity not yet shipped or reserved. Soonest promised first.',
  parameters: {
    customer: { type: 'string', description: 'Part of a customer name.' },
    sku: { type: 'string', description: 'Only orders that need this SKU.' },
    limit: limitParam,
  },
  available: (facts) => Array.isArray(facts.salesOrders),
  run(args, { facts }) {
    let rows = array(facts.salesOrders)
    if (args.customer) rows = rows.filter((row) => fold(row.customer).includes(fold(args.customer)))
    if (args.sku) rows = rows.filter((row) => array(row.lines).some((line) => fold(line.sku) === fold(args.sku)))
    rows = [...rows].sort((a, b) => (a.promisedDate || '9999').localeCompare(b.promisedDate || '9999') || text(a.number).localeCompare(text(b.number)))
    return {
      asOf: facts.asOf,
      note: 'Only open sales orders with demand not yet shipped or reserved.',
      ...aiToolList(rows.map((row) => ({ orderNumber: row.number, customer: row.customer, promisedDate: row.promisedDate, lines: array(row.lines).map((line) => ({ sku: line.sku, notShippedOrReserved: line.open })), ref: aiToolRef('sales_order', row.id, row.number) })), args.limit),
    }
  },
})

const listReceipts = defineAiTool({
  name: 'list_receipts',
  description: 'Goods receipts: those with rejected quantities on open purchase orders, those not yet posted to stock, or those that arrived in the last 7 days.',
  parameters: { kind: { type: 'string', enum: ['rejected', 'unposted', 'recent'], description: 'rejected by default.' }, limit: limitParam },
  available: (facts) => Boolean(facts.receipts),
  run(args, { facts }) {
    const kind = args.kind || 'rejected'
    const rows = [...array(facts.receipts[kind])].sort((a, b) => text(a.arrivedDay).localeCompare(text(b.arrivedDay)))
    return {
      asOf: facts.asOf,
      counts: { rejected: array(facts.receipts.rejected).length, unposted: array(facts.receipts.unposted).length, recent: array(facts.receipts.recent).length },
      ...aiToolList(rows.map((row) => ({ documentNumber: row.documentNumber, supplier: row.supplier, arrived: row.arrivedDay, purchaseOrder: orderNumberOf(facts, row.poId), postingStatus: row.postingStatus ?? null, rejected: row.rejected ?? null, unit: row.unit ?? null, ref: aiToolRef('receiving_doc', row.id, row.documentNumber) })), args.limit),
    }
  },
})

const listSupplierInvoices = defineAiTool({
  name: 'list_supplier_invoices',
  description: 'Supplier invoices: the committed total and how many are matched, in exception or pending three-way match; the invoices with a price or quantity difference; or those dated in the last 7 days.',
  parameters: { kind: { type: 'string', enum: ['summary', 'differences', 'recent'], description: 'summary by default.' }, limit: limitParam },
  available: (facts) => Boolean(facts.invoices),
  run(args, { facts }) {
    const kind = args.kind || 'summary'
    const summary = { committedTotal: facts.invoices.committed ?? null, committedCount: facts.invoices.committedCount, match: facts.invoices.matchCounts, differences: array(facts.invoices.variances).length }
    if (kind === 'summary') return { asOf: facts.asOf, summary }
    const rows = kind === 'differences' ? array(facts.invoices.variances) : array(facts.invoices.recent)
    return {
      asOf: facts.asOf,
      summary,
      ...aiToolList([...rows].sort((a, b) => text(a.invoiceDate).localeCompare(text(b.invoiceDate))).map((row) => ({
        invoiceNumber: row.invoiceNumber, supplier: row.supplier ?? null, invoiceDate: row.invoiceDate, purchaseOrder: row.poId ? orderNumberOf(facts, row.poId) : null,
        matchStatus: row.matchStatus ?? null, difference: row.variance ?? null, currency: row.currency ?? null, ref: aiToolRef('supplier_invoice', row.id, row.invoiceNumber),
      })), args.limit),
    }
  },
})

const listPurchaseRequests = defineAiTool({
  name: 'list_purchase_requests',
  description: 'Purchase requests waiting for approval: SKU, quantity, unit, priority and required date. Soonest required first.',
  parameters: { limit: limitParam },
  available: (facts) => Boolean(facts.purchaseRequests),
  run(args, { facts }) {
    const rows = [...array(facts.purchaseRequests.awaitingApproval)].sort((a, b) => (a.requiredDate || '9999').localeCompare(b.requiredDate || '9999'))
    return { asOf: facts.asOf, ...aiToolList(rows.map((row) => ({ request: row.id, skus: row.skus, quantity: row.quantity, unit: row.unit, priority: row.priority, requiredDate: row.requiredDate, ref: aiToolRef('purchase_request', row.id, row.id) })), args.limit) }
  },
})

const listRfqs = defineAiTool({
  name: 'list_rfqs',
  description: 'Open requests for quotation without an award: title, suppliers invited, quotes received, the quote due date, and whether it is ready to award (at least one quote).',
  parameters: { limit: limitParam },
  available: (facts) => Boolean(facts.rfqs),
  run(args, { facts }) {
    const ready = new Set(array(facts.rfqs.readyToAward).map((row) => row.id))
    const rows = [...array(facts.rfqs.open)].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
    return { asOf: facts.asOf, ...aiToolList(rows.map((row) => ({ rfq: row.id, title: row.title, invited: row.invited ?? null, quotes: row.responses, due: row.due, readyToAward: ready.has(row.id), ref: aiToolRef('rfq', row.id, row.title) })), args.limit) }
  },
})

const listSuppliers = defineAiTool({
  name: 'list_suppliers',
  description: 'Suppliers the user may read, with their code and tier (1 strategic, 2 core, 3 transactional, or none). Use it to find a supplier\'s exact name.',
  parameters: { name: { type: 'string', description: 'Part of a supplier name.' }, tier: { type: 'integer', minimum: 1, maximum: 3 }, limit: limitParam },
  available: (facts) => Array.isArray(facts.suppliers),
  run(args, { facts }) {
    let rows = array(facts.suppliers)
    if (args.name) rows = rows.filter((row) => fold(row.name).includes(fold(args.name)) || fold(row.code) === fold(args.name))
    if (args.tier) rows = rows.filter((row) => row.tier === args.tier)
    rows = [...rows].sort((a, b) => text(a.name).localeCompare(text(b.name)))
    return aiToolList(rows.map((row) => ({ name: row.name, code: row.code, tier: row.tier, ref: aiToolRef('supplier', row.id, row.name) })), args.limit)
  },
})

const spendAnalysis = defineAiTool({
  name: 'spend_analysis',
  description: 'Committed purchase spend, as the procurement dashboard counts it: by supplier with each one\'s share and ABC class, by item for one supplier, or by month. Amounts are never added across currencies; without permission to see prices it gives order counts.',
  parameters: {
    view: { type: 'string', enum: ['suppliers', 'trend'], description: 'suppliers (default), or trend for spend by month.' },
    period: periodParam,
    supplier: { type: 'string', description: 'One supplier: its spend by item.' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'A currency code such as USD.' },
  },
  available: (facts) => Boolean(facts.purchaseOrders) && typeof facts.procurementReport === 'function',
  run(args, { facts }) {
    let suppliers = []
    if (args.supplier) {
      const found = aiToolSupplier(facts, args.supplier)
      if (!found.supplier) return supplierError(found)
      suppliers = [found.supplier]
    }
    const result = runSpendAnalysis(facts, { route: { signals: { spend: { mode: args.view === 'trend' ? 'trend' : 'suppliers', period: periodOf(args.period), currency: args.currency || null } }, entities: { suppliers } } })
    if (result.hidden) return { error: 'not_allowed' }
    const spendRow = (row) => ({ name: row.name, amount: row.value, sharePercent: round1(row.share), rank: row.rank ?? null, spendClass: row.spendClass ?? null, ...(row.record ? { ref: aiToolRef('supplier', row.record.id, row.record.name) } : {}) })
    return {
      asOf: facts.asOf,
      period: result.period || 'all dates',
      currency: result.currency || null,
      amounts: result.amounts,
      ...(result.amounts ? {} : { countsInsteadOfAmounts: result.countReason || true }),
      total: result.total,
      supplierCount: result.supplierCount,
      otherCurrencies: array(result.others),
      ...(result.mode === 'trend' ? { months: array(result.months), undatedOrders: result.undated, peakMonth: result.peak || null } : {}),
      ...(result.mode === 'supplier' ? { supplier: result.supplier.name, supplierTotal: result.supplier.row ? spendRow(result.supplier.row) : null, items: array(result.supplier.items).map((row) => ({ name: row.name, amount: row.value })), itemCount: result.supplier.itemCount } : {}),
      ...(result.mode === 'suppliers' ? { suppliers: array(result.suppliers).map(spendRow), more: result.more, classASuppliers: result.classA } : {}),
    }
  },
})

const supplierPerformance = defineAiTool({
  name: 'supplier_performance',
  description: 'Delivery performance from the supplier scorecard: on-time, in-full and on-time-in-full rates with their counts, rejection rate, average delay and overdue orders, judged against the original promised date. A rate needs at least 5 deliveries in the period. Name up to 5 suppliers to compare them, or none for the best or worst.',
  parameters: {
    suppliers: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Supplier names or codes.' },
    order: { type: 'string', enum: ['best', 'worst'], description: 'Without suppliers: best (default) or worst on time first.' },
    period: periodParam,
  },
  available: (facts) => typeof facts.supplierScorecard === 'function',
  async run(args, { facts }) {
    const named = []
    for (const query of array(args.suppliers)) {
      const found = aiToolSupplier(facts, query)
      if (!found.supplier) return supplierError(found)
      named.push(found.supplier)
    }
    const route = await aiSkillPrepareComparison({ skillId: 'supplier_comparison', signals: { compare: { mode: args.order === 'worst' ? 'worst' : 'best', period: periodOf(args.period) } }, entities: { suppliers: named } }, facts)
    const result = runSupplierComparison(facts, { route })
    if (result.unavailable) return { error: 'scorecard_unavailable' }
    if (result.hidden) return { error: 'not_allowed' }
    const rate = (metric) => (metric && metric.rate !== null && metric.rate !== undefined ? { percent: round1(metric.rate), count: metric.count ?? null, of: metric.of ?? null } : null)
    return {
      period: result.period,
      minimumDeliveriesForARate: 5,
      suppliers: array(result.suppliers).map((row) => ({
        name: row.name, deliveries: row.deliveries, onTime: rate(row.onTime), inFull: rate(row.inFull), onTimeInFull: rate(row.otif), rejection: rate(row.rejection),
        averageDelayDays: row.delay?.value ?? null, lateDeliveries: row.delay?.lateCount ?? null, overdueOrders: row.overdue,
        spend: row.spend ? { amount: row.spend.amount, sharePercent: round1(row.spend.share) } : null, ref: aiToolRef('supplier', row.id, row.name),
      })),
      currency: result.currency,
      ...(result.few ? { tooFewDeliveries: result.few } : {}),
      ...(result.more ? { more: result.more } : {}),
    }
  },
})

const lateOrderImpact = defineAiTool({
  name: 'late_order_impact',
  description: 'What late purchase orders put at risk, in the inventory page\'s terms: per SKU, available to promise with and without the late lines, how much more the open sales orders would fall short, and those sales orders with their customers and promised days. Name orders to judge each on its own; with none, the overdue orders are judged together. No arrival dates are guessed.',
  parameters: { orders: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Purchase order numbers.' } },
  available: (facts) => Boolean(facts.purchaseOrders) && Boolean(facts.inventory),
  run(args, { facts }) {
    const named = []
    for (const query of array(args.orders)) {
      const row = aiToolPurchaseOrder(facts, query)
      if (!row) return { error: 'not_found', order: query }
      named.push(row)
    }
    const result = runLateOrderImpact(facts, { route: named.length ? { entities: { purchaseOrders: named } } : null })
    if (result.hidden) return { error: 'not_allowed' }
    return {
      asOf: facts.asOf,
      judged: result.mode === 'named' ? 'each named order on its own' : 'the overdue orders together',
      orders: array(result.pos).map((po) => ({ orderNumber: po.orderNumber, overdueDays: po.overdueDays || 0, ref: aiToolRef('purchase_order', po.id, po.orderNumber) })),
      skus: array(result.groups).map((group) => ({
        sku: group.sku, unit: group.unit, stillToReceive: group.remaining, known: group.known,
        availableToPromise: group.known ? group.atp : null, withoutTheseLines: group.known ? group.without : null, additionalShortfall: group.known ? group.added : null,
        countedAsIncoming: group.known ? group.counted : null,
        salesOrdersWaiting: result.salesVisible ? array(group.orders).map((order) => ({ orderNumber: order.number, customer: order.customer, promisedDate: order.promisedDate, needs: order.open, ref: aiToolRef('sales_order', order.id, order.number) })) : null,
      })),
      salesOrdersVisible: Boolean(result.salesVisible),
      ...(result.more ? { moreSkus: result.more } : {}),
    }
  },
})

const workspaceSummary = defineAiTool({
  name: 'workspace_summary',
  description: 'Counts across the workspace as the reports show them: open and overdue purchase orders and committed spend, orders waiting for approval, SKUs at risk, supplier invoice matching, open RFQs, receipts with rejections or not posted, and records missing data. What the user may not read is left out.',
  available: () => true,
  run(_args, { facts }) {
    return {
      asOf: facts.asOf,
      currency: facts.currency,
      purchaseOrders: facts.purchaseOrders ? { open: facts.purchaseOrders.open, overdue: facts.purchaseOrders.overdue, committedSpend: facts.purchaseOrders.committedSpend ?? null, waitingForApproval: array(facts.purchaseOrders.pendingApproval).length } : null,
      purchaseRequestsWaitingForApproval: facts.purchaseRequests ? array(facts.purchaseRequests.awaitingApproval).length : null,
      inventory: facts.inventory ? { skus: array(facts.inventory.rows).length, atRisk: facts.inventory.atRiskCount, atRiskSkus: array(facts.inventory.atRisk) } : null,
      supplierInvoices: facts.invoices ? { committedTotal: facts.invoices.committed ?? null, committedCount: facts.invoices.committedCount, match: facts.invoices.matchCounts } : null,
      rfqs: facts.rfqs ? { open: array(facts.rfqs.open).length, readyToAward: array(facts.rfqs.readyToAward).length } : null,
      receipts: facts.receipts ? { rejected: array(facts.receipts.rejected).length, unposted: array(facts.receipts.unposted).length } : null,
      recordsMissingData: array(facts.records).length,
      notReadable: array(facts.hidden),
    }
  },
})

const OPERATIONS = ['sum', 'difference', 'ratio', 'percent', 'percent_change', 'average', 'days_between', 'add_days']
const ISO_DAY = '^\\d{4}-\\d{2}-\\d{2}$'
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / 86400000
const calculate = defineAiTool({
  name: 'calculate',
  description: 'Arithmetic done by the server, for every figure the answer derives instead of reading: sum or average of values; difference (first minus second); ratio (first divided by second); percent (first as a percent of second); percent_change (from first to second); days_between two dates; add_days to a date. The answer may state a derived figure only if it came from here.',
  parameters: {
    operation: { type: 'string', enum: OPERATIONS },
    values: { type: 'array', items: { type: 'number' }, maxItems: 50, description: 'The numbers, from tool results.' },
    dates: { type: 'array', items: { type: 'string', pattern: ISO_DAY }, maxItems: 2, description: 'YYYY-MM-DD dates for days_between and add_days.' },
  },
  required: ['operation'],
  available: () => true,
  run(args) {
    const values = array(args.values)
    const dates = array(args.dates)
    const need = (count) => (values.length < count ? { error: 'invalid_arguments', details: [`${args.operation} needs ${count} value(s)`] } : null)
    const round = (value) => Math.round(value * 10000) / 10000
    switch (args.operation) {
      case 'sum': return need(1) || { result: round(values.reduce((total, value) => total + value, 0)) }
      case 'average': return need(1) || { result: round(values.reduce((total, value) => total + value, 0) / values.length) }
      case 'difference': return need(2) || { result: round(values[0] - values[1]) }
      case 'ratio': return need(2) || (values[1] === 0 ? { error: 'division_by_zero' } : { result: round(values[0] / values[1]) })
      case 'percent': return need(2) || (values[1] === 0 ? { error: 'division_by_zero' } : { result: round((values[0] / values[1]) * 100), unit: 'percent' })
      case 'percent_change': return need(2) || (values[0] === 0 ? { error: 'division_by_zero' } : { result: round(((values[1] - values[0]) / Math.abs(values[0])) * 100), unit: 'percent' })
      case 'days_between': return dates.length < 2 ? { error: 'invalid_arguments', details: ['days_between needs two dates'] } : { result: dayNumber(dates[1]) - dayNumber(dates[0]), unit: 'days' }
      case 'add_days': {
        if (dates.length < 1 || values.length < 1 || !Number.isInteger(values[0])) return { error: 'invalid_arguments', details: ['add_days needs a date and a whole number of days'] }
        return { result: new Date((dayNumber(dates[0]) + values[0]) * 86400000).toISOString().slice(0, 10) }
      }
      default: return { error: 'invalid_arguments' }
    }
  },
})

export const AI_READ_TOOLS = Object.freeze([
  workspaceSummary, listPurchaseOrders, getPurchaseOrder, stockPosition, listSalesOrders, listReceipts, listSupplierInvoices,
  listPurchaseRequests, listRfqs, listSuppliers, spendAnalysis, supplierPerformance, lateOrderImpact, calculate,
])
