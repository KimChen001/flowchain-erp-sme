import { buildRuntimeInventoryAllocation, isInventoryRiskSku } from './runtime-inventory-allocation-read-model.mjs'
import { buildBusinessOverview } from './business-overview.mjs'
import { isCommittedPurchaseOrder, isOpenPurchaseOrder, purchaseOrderBusinessDate, reportCalendarDay } from './open-purchase-order.mjs'
import { purchaseOrderReportLine } from './open-purchase-orders-report.mjs'
import { RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES } from './procurement-status-authority.mjs'
import { buildDashboardFacts, buildDashboardVisuals } from './report-dashboard-visuals.mjs'
import { reportCurrencyCode } from './report-currency.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay, tenantCalendarDay } from './tenant-calendar-day.mjs'

const array = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
// One business date per document type, shared with the open purchase orders
// report: purchase and sales orders use the order date, invoices the invoice
// date, each falling back to the creation date. Never the last update. Order
// and invoice dates are calendar days; the creation date is an instant and
// counts on its day in the workspace timezone.
const salesOrderDate = (row, timeZone) => reportCalendarDay(row.orderDate) || instantCalendarDay(row.createdAt, timeZone)
const invoiceDate = (row, timeZone) => reportCalendarDay(row.invoiceDate) || instantCalendarDay(row.createdAt, timeZone)
// A document amount that was never recorded is unknown, not zero. So is a quantity.
const amountOf = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const quantityOf = amountOf
const round4 = value => Math.round(value * 10000) / 10000
const knownTotal = rows => rows.some(row => row.amount === null) ? null : round4(rows.reduce((total, row) => total + row.amount, 0))
const inactiveSalesStatuses = ['draft', 'cancelled', 'canceled']

// A quantity total over lines that share one unit, with that unit. Lines in
// different units are never added: the total is null and the unit 'mixed'.
// requireUnit leaves lines without a recorded unit untotalled, as the open
// purchase orders report does.
function oneUnitTotal(lines, key, { requireUnit = false } = {}) {
  const units = [...new Set(lines.map(line => line.unit))]
  if (units.length > 1) return { total: null, unit: 'mixed' }
  if (!lines.length || (requireUnit && !units[0]) || lines.some(line => line[key] === null)) return { total: null, unit: units[0] || '' }
  return { total: round4(lines.reduce((total, line) => total + line[key], 0)), unit: units[0] || '' }
}

// The lines of a sales order, each on its own SKU and unit. The order-level
// quantities add lines in different units (10 pcs and 50 ft read as 60), so
// demand is never read from them. An order read without lines falls back to
// its order-level fields. A quantity that was not recorded stays null.
export function salesOrderLines(order) {
  const lines = array(order?.lines)
  const rows = lines.length
    ? lines.map(line => ({ sku: text(line.sku || line.itemId), unit: text(line.unit || line.unitSnapshot), ordered: quantityOf(line.orderedQuantity ?? line.orderedQty ?? line.quantity), fulfilled: quantityOf(line.fulfilledQuantity ?? line.fulfilledQty ?? line.shippedQty) }))
    : [{ sku: text(order?.sku || order?.itemId), unit: text(order?.unit), ordered: quantityOf(order?.orderedQty ?? order?.quantity), fulfilled: quantityOf(order?.fulfilledQty ?? order?.shippedQty) }]
  return rows.map(row => ({ ...row, open: row.ordered === null || row.fulfilled === null ? null : Math.max(0, round4(row.ordered - row.fulfilled)) }))
}

// Open demand of active sales order lines: a total only while every line with
// demand left is in one unit (lines without a recorded unit count as one
// group), else null with the reason. Never added across units.
function salesDemandTotal(demandLines) {
  const open = demandLines.filter(line => line.active && line.open !== 0)
  if (open.some(line => line.open === null)) return { total: null, unit: null, limitation: 'sales_demand_quantity_missing' }
  const { total, unit } = oneUnitTotal(open, 'open')
  if (unit === 'mixed') return { total: null, unit: null, limitation: 'sales_demand_units_mixed' }
  return { total: total ?? 0, unit: unit || null, limitation: null }
}
// Spend totals count committed documents only. A purchase order is committed
// once approved (see isCommittedPurchaseOrder). A supplier invoice is committed
// once submitted: the statuses that hold receipt lines against double
// invoicing, so drafts, rejections and cancellations are left out. A sales
// order counts unless it is a draft or cancelled.
const committedInvoiceStatuses = new Set(RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES)
const committed = {
  purchase_orders: row => isCommittedPurchaseOrder(row),
  supplier_invoices: row => committedInvoiceStatuses.has(row.status.toLowerCase()),
  sales_orders: row => !inactiveSalesStatuses.includes(row.status),
}
const currencyNames = { CNY: '人民币', USD: '美元', EUR: '欧元' }
const currencyCode = reportCurrencyCode
const currencyLabel = code => code ? (currencyNames[code] ? `${currencyNames[code]}（${code}）` : code) : '全部币种'
const unknownCurrencyLabel = '币种缺失或无效'

const metricDefinitions = {
  sales_order_count: ['销售订单数量', 'sales_orders', 'number', '当前范围内真实销售订单记录数。', '/app/sales/orders'],
  open_sales_demand: ['未履约销售需求', 'sales_orders', 'number', 'Ordered less fulfilled quantity on confirmed sales order lines, before inventory reservations. Shown only while every line with demand left uses the same unit.', '/app/sales/orders'],
  purchase_order_amount: ['采购订单金额', 'purchase_orders', 'currency', '已承诺采购订单（已批准、已下达、部分收货或全部收货）的金额合计，不含草稿、待审批、驳回和取消的订单；有订单缺少金额时不显示合计。', '/app/procurement/orders'],
  open_po_count: ['开放 PO', 'purchase_orders', 'number', '已承诺（已批准、已下达或部分收货）且仍有待收数量的采购订单数。', '/app/procurement/orders'],
  inventory_on_hand: ['在手库存', 'inventory_balances', 'number', 'Inventory Runtime 已记录的在手数量。', '/app/inventory'],
  inventory_risk_sku: ['库存风险 SKU', 'inventory_balances', 'number', '按统一 availability 口径存在 shortage 的 SKU 数。', '/app/inventory?risk=high'],
  invoice_amount: ['供应商发票金额', 'supplier_invoices', 'currency', '已提交供应商发票（已提交、匹配中、有差异、已匹配、已批准或暂挂）的金额合计，不含草稿、驳回和取消的发票；有发票缺少金额时不显示合计。', '/app/finance/invoices'],
  supplier_count: ['供应商数量', 'suppliers', 'number', '当前供应商主数据记录数。', '/app/master-data/suppliers'],
  overdue_open_po_count: ['Overdue open POs', 'purchase_orders', 'number', 'Open purchase orders whose expected date is before today in the workspace timezone.', '/app/reports/procurement?status=open'],
  on_time_receipt_rate: ['On-time receipts', 'receipts', 'percentage', "Share of receipts in range that arrived on or before the purchase order's expected date. Receipts without an expected date are left out.", '/app/procurement/receiving'],
  active_supplier_count: ['Suppliers with committed orders', 'purchase_orders', 'number', 'Suppliers with at least one committed purchase order in range.', '/app/master-data/suppliers'],
  invoice_match_rate: ['Invoices matched', 'supplier_invoices', 'percentage', 'Share of submitted supplier invoices whose three-way match passed.', '/app/finance/three-way-match'],
  invoices_awaiting_match: ['Invoices awaiting match', 'supplier_invoices', 'number', 'Submitted supplier invoices without a three-way match result yet.', '/app/finance/three-way-match'],
  invoices_with_exception: ['Match exceptions', 'supplier_invoices', 'number', 'Submitted supplier invoices whose three-way match found an exception.', '/app/finance/three-way-match'],
  sales_order_amount: ['Sales order amount', 'sales_orders', 'currency', 'Total of sales orders in the current range, without drafts and cancellations. No total is shown across currencies.', '/app/sales/orders'],
  order_fulfillment_rate: ['Orders shipped in full', 'sales_orders', 'percentage', 'Share of confirmed sales orders whose every line has shipped its ordered quantity.', '/app/sales/orders'],
  out_of_stock_sku: ['Out-of-stock SKUs', 'inventory_balances', 'number', 'SKUs with no available stock under the shared availability calculation.', '/app/inventory?risk=high'],
  negative_atp_sku: ['SKUs short against demand', 'inventory_balances', 'number', 'SKUs whose available-to-promise quantity is below zero.', '/app/inventory?risk=high'],
}

const dashboardMetrics = {
  overview: ['purchase_order_amount', 'open_po_count', 'inventory_risk_sku', 'sales_order_count'],
  procurement: ['purchase_order_amount', 'open_po_count', 'overdue_open_po_count', 'on_time_receipt_rate'],
  sales: ['sales_order_count', 'open_sales_demand', 'sales_order_amount', 'order_fulfillment_rate'],
  inventory: ['inventory_on_hand', 'inventory_risk_sku', 'out_of_stock_sku', 'negative_atp_sku'],
  finance: ['invoice_amount', 'invoice_match_rate', 'invoices_awaiting_match', 'invoices_with_exception'],
  suppliers: ['supplier_count', 'purchase_order_amount', 'active_supplier_count', 'on_time_receipt_rate'],
}

// Detail rows per subject. An order's quantity is its lines' total only while
// they share one unit (unit 'mixed' and no quantity otherwise, as on the open
// purchase orders report); a sales order names a SKU only when it has one line.
function runtimeRows(context, inventory, timeZone) {
  const purchaseQuantity = row => {
    const { total, unit } = oneUnitTotal(array(row.lines).map(line => purchaseOrderReportLine(line, row)), 'ordered', { requireUnit: true })
    return { quantity: total, unit }
  }
  const salesQuantity = row => {
    const lines = salesOrderLines(row)
    const ordered = oneUnitTotal(lines, 'ordered')
    return { sku: lines.length === 1 ? lines[0].sku : '', quantity: ordered.total, unit: ordered.unit, fulfilled: oneUnitTotal(lines, 'fulfilled').total }
  }
  return {
    purchase_orders: array(context.purchaseOrders).map(row => ({ id: text(row.id || row.po), date: purchaseOrderBusinessDate(row, timeZone), supplier: text(row.supplierSnapshot?.supplierName || row.supplierName || row.supplierId), amount: amountOf(row.totalAmount ?? row.amount), ...purchaseQuantity(row), status: text(row.status), isOpen: isOpenPurchaseOrder(row), currency: currencyCode(row.currency || row.lines?.[0]?.currency) })),
    sales_orders: array(context.salesOrders).map(row => ({ id: text(row.salesOrderId || row.id), date: salesOrderDate(row, timeZone), customer: text(row.customerName || row.customerId), ...salesQuantity(row), status: text(inactiveSalesStatuses.includes(row.workflowStatus) ? row.workflowStatus : row.status || row.statusLabel), amount: amountOf(row.totalAmount ?? row.amount), currency: currencyCode(row.currency) })),
    inventory_balances: inventory.availability.map(row => ({ id: row.sku, sku: row.sku, quantity: row.onHand, reserved: row.reserved, available: row.available, shortage: row.shortage, availableToPromise: row.availableToPromise, stockStatus: row.stockStatus, status: row.riskLevel })),
    supplier_invoices: array(context.supplierInvoices).map(row => ({ id: text(row.id || row.invoiceNumber), date: invoiceDate(row, timeZone),supplier: text(row.supplierName || row.supplierId), amount: amountOf(row.totalAmount ?? row.amount), status: text(row.status), currency: currencyCode(row.currency) })),
    suppliers: array(context.suppliers).map(row => ({ id: text(row.id || row.supplierCode), supplier: text(row.supplierName || row.name), status: text(row.status) })),
  }
}

// "open" is not a stored purchase order status, so an exact match returned no
// rows. For purchase orders, which carry isOpen, it means the shared open
// definition. Every other status, and every other subject, still matches exactly.
function statusMatches(row, status) {
  if (status === 'open' && Object.hasOwn(row, 'isOpen')) return row.isOpen === true
  return row.status === status
}

// A filter narrows only the subjects that carry its field: a supplier filter
// leaves sales orders and inventory alone, a customer filter leaves purchase
// orders alone. Status values belong to one subject, so a status filter (set
// from the purchase order status chart, for example) applies only to the
// dashboard's primary subject. A dated subject's record without a business
// date is outside every date range.
const subjectFilters = {
  purchase_orders: ['from', 'to', 'supplier', 'currency'], sales_orders: ['from', 'to', 'customer', 'currency'],
  supplier_invoices: ['from', 'to', 'supplier', 'currency'], inventory_balances: [], suppliers: ['supplier'],
  receipts: ['from', 'to', 'supplier', 'currency'],
}
const applicableFilters = (subject, primaryKey) => [...subjectFilters[subject], ...(subject === primaryKey ? ['status'] : [])]

function filtered(rows, query, filters) {
  const applies = key => query[key] && filters.includes(key)
  return rows.filter(row => (!applies('from') || (row.date && row.date >= query.from)) && (!applies('to') || (row.date && row.date <= query.to)) && (!applies('supplier') || row.supplier === query.supplier) && (!applies('customer') || row.customer === query.customer) && (!applies('currency') || row.currency === query.currency) && (!applies('status') || statusMatches(row, query.status)))
}

function value(id, all, inventory, facts) {
  if (id === 'sales_order_count') return all.sales_orders.length
  if (id === 'open_sales_demand') return facts.salesDemandTotal.total
  if (id === 'open_po_count') return all.purchase_orders.filter(row => row.isOpen).length
  if (id === 'inventory_on_hand') {
    if (inventory.units?.length > 1) return null
    if (!inventory.availability.length) return 0
    if (inventory.availability.some(row => row.onHand === null)) return null
    return inventory.availability.reduce((total, row) => total + row.onHand, 0)
  }
  if (id === 'inventory_risk_sku') return inventory.availability.filter(isInventoryRiskSku).length
  if (id === 'supplier_count') return all.suppliers.length
  if (id === 'overdue_open_po_count') return facts.overdueOpenPurchaseOrders
  if (id === 'on_time_receipt_rate') return facts.onTimeReceiptRate
  if (id === 'active_supplier_count') return facts.activeSuppliers
  if (id === 'invoice_match_rate') return facts.invoiceMatchRate
  if (id === 'invoices_awaiting_match') return facts.invoicesAwaitingMatch
  if (id === 'invoices_with_exception') return facts.invoicesWithException
  if (id === 'order_fulfillment_rate') return facts.orderFulfillmentRate
  if (id === 'out_of_stock_sku') return inventory.availability.filter(row => row.stockStatus === 'out_of_stock').length
  if (id === 'negative_atp_sku') return inventory.availability.filter(row => row.availableToPromise !== null && row.availableToPromise < 0).length
  return 0
}

// The monthly series behind a KPI's sparkline: committed amounts while they
// total in one currency, or counts. Undated records are left out, and a series
// needs two months to show a direction.
const trendSubjects = { purchase_order_amount: 'purchase_orders', invoice_amount: 'supplier_invoices', sales_order_amount: 'sales_orders', sales_order_count: 'sales_orders' }
function metricTrend(id, all, money) {
  const subject = trendSubjects[id]
  const counting = id === 'sales_order_count'
  if (!subject || (!counting && money?.total === null)) return null
  const months = new Map()
  for (const row of counting ? all[subject] : all[subject].filter(committed[subject])) {
    if (!row.date) continue
    const period = row.date.slice(0, 7)
    months.set(period, Math.round(((months.get(period) || 0) + (counting ? 1 : row.amount)) * 10000) / 10000)
  }
  const trend = [...months].sort(([a], [b]) => a.localeCompare(b)).map(([period, value]) => ({ period, value }))
  return trend.length > 1 ? trend : null
}

// Money is grouped by currency and never added across currencies. A missing
// or invalid currency code is a group of its own and blocks the total, because
// nothing says which currency those amounts are in. Each money metric calls
// this with its own rows, so a metric is never labelled with the currency of
// a different subject.
function currencySummary(rows, query) {
  const groups = new Map()
  for (const row of rows) groups.set(row.currency, [...(groups.get(row.currency) || []), row])
  const known = [...groups.keys()].filter(Boolean).sort()
  const unknown = groups.has('')
  const status = query.currency ? 'filtered_currency' : !rows.length ? 'no_currency_data' : known.length > 1 ? 'multi_currency_unconverted' : unknown ? 'currency_unknown' : 'single_currency'
  const code = query.currency || (status === 'single_currency' ? known[0] : null)
  const codes = query.currency ? [query.currency] : [...known, ...(unknown ? [''] : [])]
  return {
    currencyCode: code,
    currencyLabel: status === 'multi_currency_unconverted' ? '多币种，未折算' : status === 'no_currency_data' ? '无币种数据' : status === 'currency_unknown' ? unknownCurrencyLabel : currencyLabel(code),
    currencies: query.currency ? [query.currency] : known,
    currencyAggregationStatus: status,
    currencyAmounts: codes.map(group => ({ currencyCode: group || null, currencyLabel: group ? currencyLabel(group) : unknownCurrencyLabel, amount: knownTotal(groups.get(group) || []), recordCount: (groups.get(group) || []).length })),
    total: ['single_currency', 'filtered_currency', 'no_currency_data'].includes(status) ? knownTotal(rows) : null,
    limitations: [...(status === 'multi_currency_unconverted' ? ['multi_currency_unconverted'] : []), ...(unknown ? ['currency_missing_or_invalid'] : []), ...(rows.some(row => row.amount === null) ? ['amount_missing'] : [])],
  }
}

// A figure over records the reader cannot read, or an amount the reader
// cannot see, is restricted: no value, never 0.
const RESTRICTED_FIGURE_SUBJECTS = { on_time_receipt_rate: ['purchase_orders', 'receipts'], active_supplier_count: ['purchase_orders'], overdue_open_po_count: ['purchase_orders'], invoice_match_rate: ['supplier_invoices'], invoices_awaiting_match: ['supplier_invoices'], invoices_with_exception: ['supplier_invoices'], order_fulfillment_rate: ['sales_orders'] }
function restrictedMetric(base, reason) {
  const currency = base.unit === 'currency' ? { currencyAmounts: (base.currencyAmounts || []).map(group => ({ ...group, amount: null })) } : {}
  return { ...base, ...currency, value: null, currentValue: null, dataStatus: 'restricted', limitations: [reason], comparisonLabel: 'Restricted', trend: null }
}

function metric(id, all, inventory, query, primaryKey, facts, restriction = {}) {
  const built = unrestrictedMetric(id, all, inventory, query, primaryKey, facts)
  const subjects = [built.subject, ...(RESTRICTED_FIGURE_SUBJECTS[id] || [])]
  if (subjects.some(subject => restriction.subjects?.has(subject))) return restrictedMetric(built, 'subject_restricted')
  if (built.unit === 'currency' && restriction.amounts?.[built.subject]) return restrictedMetric(built, 'amount_restricted')
  return built
}

function unrestrictedMetric(id, all, inventory, query, primaryKey, facts) {
  const [label, subject, unit, description, drilldownPath] = metricDefinitions[id]
  const money = unit === 'currency' ? currencySummary(all[subject].filter(committed[subject]), query) : null
  const currentValue = money ? money.total : value(id, all, inventory, facts)
  const unconverted = money?.currencyAggregationStatus === 'multi_currency_unconverted'
  const demand = id === 'open_sales_demand' ? facts.salesDemandTotal : null
  const incomplete = money ? currentValue === null : ['inventory_on_hand', 'open_sales_demand'].includes(id) && currentValue === null
  // A rate with nothing to divide by has no records, not a rate of zero.
  const dataStatus = incomplete ? 'incomplete' : id === 'inventory_on_hand' && !inventory.availability.length ? 'empty' : unit === 'percentage' && currentValue === null ? 'no_records' : 'complete'
  const limitations = money ? money.limitations : demand ? (demand.limitation ? [demand.limitation] : []) : id === 'inventory_on_hand' && inventory.units?.length > 1 ? ['inventory_units_mixed'] : incomplete ? ['inventory_on_hand_incomplete'] : []
  const currency = money ? { currencyCode: money.currencyCode, currencyLabel: money.currencyLabel, currencies: money.currencies, currencyAggregationStatus: money.currencyAggregationStatus, currencyAmounts: money.currencyAmounts } : {}
  return { id, label, subject, unit, format: unit, aggregation: description, numerator: description, denominator: null, dateField: 'date', applicableFilters: applicableFilters(subject, primaryKey), drilldownPath, emptyValue: 0, version: '3.0.0-runtime', description, value: currentValue, currentValue, dataStatus, limitations, ...currency, ...(demand ? { quantityUnit: demand.unit } : {}), comparisonValue: null, comparisonDelta: null, comparisonRate: null, comparisonDirection: 'flat', comparisonLabel: unconverted ? '多币种，未折算' : incomplete ? '数据不足' : '未比较', comparisonUnit: unit, calculationLabel: description, trend: metricTrend(id, all, money), generatedAt: new Date().toISOString() }
}

// options.now and options.timeZone set the workspace's "today" for overdue
// counts; the route passes the tenant timezone.
// options.allocationContext, when the context was scoped to a reader, is the
// unscoped context: each SKU's reserved and available quantity counts every
// sales order, whether or not the reader can read sales orders.
export function buildRuntimeGovernedReport(context, input = {}, options = {}) {
  const restriction = { subjects: new Set(array(context.restrictedSubjects)), amounts: context.restrictedAmounts || {} }
  const inventory = buildRuntimeInventoryAllocation(options.allocationContext && !restriction.subjects.has('inventory_balances') ? options.allocationContext : context)
  inventory.units = [...new Set(array(context.inventoryItems).map(row => text(row.unit)).filter(Boolean))]
  if (inventory.units.length > 1) inventory.dataLimitations.push('inventory_units_mixed')
  const query = { subject: dashboardMetrics[input.subject] ? input.subject : 'overview', from: text(input.filters?.from || ''), to: text(input.filters?.to || ''), supplier: text(input.filters?.supplier || ''), customer: text(input.filters?.customer || ''), currency: currencyCode(input.filters?.currency), status: text(input.filters?.status || ''), limit: Math.max(1, Math.min(200, number(input.limit || 50))) }
  const timeZone = options.timeZone || DEFAULT_TENANT_TIMEZONE
  const source = runtimeRows(context, inventory, timeZone)
  const primaryKey = query.subject === 'sales' ? 'sales_orders' : query.subject === 'inventory' ? 'inventory_balances' : query.subject === 'finance' ? 'supplier_invoices' : query.subject === 'suppliers' ? 'suppliers' : 'purchase_orders'
  const all = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, filtered(value, query, applicableFilters(key, primaryKey))]))
  const metricIds = array(input.measures).filter(id => metricDefinitions[id]).length ? input.measures.filter(id => metricDefinitions[id]) : dashboardMetrics[query.subject]
  const currencySubject = query.subject === 'sales' ? 'sales_orders' : query.subject === 'finance' ? 'supplier_invoices' : ['overview', 'procurement', 'suppliers'].includes(query.subject) ? 'purchase_orders' : null
  const unscopedMoney = currencySummary(currencySubject ? all[currencySubject].filter(committed[currencySubject]) : [], query)
  const scopeMoney = currencySubject && restriction.amounts[currencySubject] ? { ...unscopedMoney, total: null, currencyAmounts: unscopedMoney.currencyAmounts.map(group => ({ ...group, amount: null })), limitations: ['amount_restricted'] } : unscopedMoney
  const aggregationStatus = scopeMoney.currencyAggregationStatus
  const details = all[primaryKey].slice(0, query.limit)
  // Receipts follow their purchase order's filters other than the date range.
  const purchaseOrderIdsAnyDate = new Set(filtered(source.purchase_orders, { ...query, from: '', to: '' }, applicableFilters('purchase_orders', primaryKey)).map(row => row.id))
  const today = tenantCalendarDay(options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date(), timeZone)
  // Sales demand per order line in scope, on the line's own SKU and unit.
  const salesInScope = new Map(all.sales_orders.map(row => [row.id, row]))
  const salesDemand = array(context.salesOrders).flatMap(order => {
    const row = salesInScope.get(text(order.salesOrderId || order.id))
    return row ? salesOrderLines(order).map(line => ({ ...line, orderId: row.id, active: !inactiveSalesStatuses.includes(row.status) })) : []
  })
  const facts = { ...buildDashboardFacts({ context, all, query, purchaseOrderIdsAnyDate, today, timeZone, salesDemand }), salesDemandTotal: salesDemandTotal(salesDemand) }
  const visuals = buildDashboardVisuals({ subject: query.subject, context, all, query, purchaseOrderIdsAnyDate, restrictedAmounts: restriction.amounts, today, timeZone, salesDemand })
  const columns = [...new Set(details.flatMap(row => Object.keys(row)))].map(key => ({ key, label: ({ id: '业务编号', date: '业务日期', supplier: '供应商', customer: '客户', amount: '金额', quantity: '数量', unit: '单位', fulfilled: '已履约', status: '状态', currency: '币种', sku: 'SKU', available: '可用量', shortage: '缺口', availableToPromise: 'ATP', stockStatus: '库存状态', isOpen: '未结' })[key] || key, type: ['amount'].includes(key) ? 'currency' : key === 'isOpen' ? 'boolean' : ['quantity', 'fulfilled', 'available', 'shortage', 'availableToPromise'].includes(key) ? 'number' : key === 'date' ? 'date' : key === 'id' ? 'business_link' : 'text', subject: primaryKey }))
  const kpis = metricIds.map(id => metric(id, all, inventory, query, primaryKey, facts, restriction))
  const moneyLimitations = ['multi_currency_unconverted', 'currency_missing_or_invalid', 'amount_missing', 'amount_restricted', 'subject_restricted']
  const limitations = [...new Set([...array(context.dataLimitations), ...inventory.dataLimitations, ...(inventory.availability.length && inventory.availability.some(row => row.onHand === null) ? ['inventory_on_hand_incomplete'] : []), ...scopeMoney.limitations, ...kpis.flatMap(item => item.limitations.filter(code => moneyLimitations.includes(code)))])]
  const distinct = values => [...new Set(values.map(text).filter(Boolean))]
  const dataScope = { label: '当前工作区 runtime 数据', company: '—', currencyCode: scopeMoney.currencyCode, currencyLabel: scopeMoney.currencyLabel, currencies: scopeMoney.currencies, currencyAggregationStatus: aggregationStatus, currencyAmounts: scopeMoney.currencyAmounts, fxConverted: false, from: query.from || '—', to: query.to || '—', activeFilterCount: ['from', 'to', 'supplier', 'customer', 'currency', 'status'].filter(key => query[key]).length, sourceLabel: 'BusinessReadContext', completenessLabel: details.length ? `已读取 ${details.length} 条真实记录` : '当前范围无真实业务记录', filterOptions: { companies: [], suppliers: distinct(array(context.suppliers).map(row => row.supplierName || row.name)), customers: distinct(array(context.customers).map(row => row.name || row.customerName)), warehouses: distinct(array(context.warehouses).map(row => row.name || row.warehouseName)), categories: distinct(array(context.items).map(row => row.category || row.categoryName)), currencies: distinct([...source.purchase_orders, ...source.sales_orders, ...source.supplier_invoices].map(row => row.currency)) } }
  const overview = query.subject === 'overview' ? buildBusinessOverview(all, { salesDemand }) : null
  // Subjects the read context could not load in full; totals over them may be low.
  const truncatedSubjects = array(context.truncatedSubjects).filter(entry => text(entry?.subject) && Number.isFinite(Number(entry?.limit))).map(entry => ({ subject: text(entry.subject), limit: Number(entry.limit) }))
  return { query, generatedAt: new Date().toISOString(), dataScope, truncatedSubjects, restrictedSubjects: [...restriction.subjects], restrictedAmounts: Object.keys(restriction.amounts).filter(key => restriction.amounts[key]), kpis, charts: overview ? [...overview.charts, ...visuals] : visuals, attention: overview?.attention || [], totalRecords: all[primaryKey].length, rankings: [], details, columnDefinitions: columns, warnings: limitations, limitations, drilldowns: metricIds.map(id => ({ metricId: id, path: metricDefinitions[id][4] })), exportRows: all[primaryKey], metricDefinitions: kpis }
}

export function getRuntimeReportCatalog() {
  const subjects = {
    purchase_orders: ['采购订单', '/app/procurement/orders'], sales_orders: ['销售订单', '/app/sales/orders'],
    inventory_balances: ['库存余额', '/app/inventory'], supplier_invoices: ['供应商发票', '/app/finance/invoices'],
    suppliers: ['供应商', '/app/master-data/suppliers'], purchase_requests: ['采购申请', '/app/procurement/requests'],
    rfqs: ['询报价', '/app/procurement/rfq'], receiving: ['收货', '/app/procurement/receiving'],
  }
  const fieldDefinitions = [
    { key: 'id', label: '业务编号', type: 'business_link' }, { key: 'date', label: '业务日期', type: 'date' },
    { key: 'supplier', label: '供应商', type: 'business_link' }, { key: 'customer', label: '客户', type: 'business_link' },
    { key: 'sku', label: 'SKU', type: 'business_link' }, { key: 'amount', label: '金额', type: 'currency' },
    { key: 'quantity', label: '数量', type: 'number' }, { key: 'status', label: '状态', type: 'enum' },
  ]
  const fields = Object.fromEntries(Object.keys(subjects).map(id => [id, fieldDefinitions]))
  return { subjects: Object.entries(subjects).map(([id, [label, detailRoute]]) => ({ id, label, detailRoute, fields: fieldDefinitions.map(field => field.key) })), fields, metrics: Object.keys(metricDefinitions).map(id => ({ id, label: metricDefinitions[id][0], subject: metricDefinitions[id][1], unit: metricDefinitions[id][2] })), templates: dashboardMetrics }
}
