import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { buildBusinessOverview } from './business-overview.mjs'

const array = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
const date = row => text(row.updatedAt || row.createdAt || row.date).slice(0, 10)
const sum = (rows, key) => rows.reduce((total, row) => total + number(row[key]), 0)
const ISO_CURRENCY_CODE = /^[A-Z]{3}$/
const supportedCurrencyCodes = new Set(Intl.supportedValuesOf?.('currency') || ['CNY', 'USD', 'EUR'])
const currencyNames = { CNY: '人民币', USD: '美元', EUR: '欧元' }
const currencyCode = value => {
  const code = text(value).toUpperCase()
  return ISO_CURRENCY_CODE.test(code) && supportedCurrencyCodes.has(code) ? code : ''
}
const currencyLabel = code => code ? (currencyNames[code] ? `${currencyNames[code]}（${code}）` : code) : '全部币种'

const metricDefinitions = {
  sales_order_count: ['销售订单数量', 'sales_orders', 'number', '当前范围内真实销售订单记录数。', '/app/sales/orders'],
  open_sales_demand: ['未履约销售需求', 'sales_orders', 'number', '订单数量扣除已履约数量，不扣减库存预留。', '/app/sales/orders'],
  purchase_order_amount: ['采购订单金额', 'purchase_orders', 'currency', '当前范围内真实采购订单金额合计。', '/app/procurement/orders'],
  open_po_count: ['开放 PO', 'purchase_orders', 'number', '未关闭且未取消的真实采购订单数。', '/app/procurement/orders'],
  inventory_on_hand: ['在手库存', 'inventory_balances', 'number', 'Inventory Runtime 已记录的在手数量。', '/app/inventory'],
  inventory_risk_sku: ['库存风险 SKU', 'inventory_balances', 'number', '按统一 availability 口径存在 shortage 的 SKU 数。', '/app/inventory?risk=high'],
  invoice_amount: ['供应商发票金额', 'supplier_invoices', 'currency', '当前已接通发票记录金额合计。', '/app/finance/invoices'],
  supplier_count: ['供应商数量', 'suppliers', 'number', '当前供应商主数据记录数。', '/app/master-data/suppliers'],
}

const dashboardMetrics = {
  overview: ['purchase_order_amount', 'open_po_count', 'inventory_risk_sku', 'sales_order_count'],
  procurement: ['purchase_order_amount', 'open_po_count'],
  sales: ['sales_order_count', 'open_sales_demand'],
  inventory: ['inventory_on_hand', 'inventory_risk_sku'],
  finance: ['invoice_amount'],
  suppliers: ['supplier_count', 'purchase_order_amount'],
}

function runtimeRows(context, inventory) {
  return {
    purchase_orders: array(context.purchaseOrders).map(row => ({ id: text(row.id || row.po), date: date(row), supplier: text(row.supplierSnapshot?.supplierName || row.supplierName || row.supplierId), amount: number(row.totalAmount ?? row.amount), quantity: array(row.lines).reduce((total, line) => total + number(line.quantity ?? line.orderedQty), 0), status: text(row.status), currency: currencyCode(row.currency || row.lines?.[0]?.currency || 'CNY') })),
    sales_orders: array(context.salesOrders).map(row => ({ id: text(row.salesOrderId || row.id), date: date(row), customer: text(row.customerName || row.customerId), sku: text(row.sku || row.itemId), quantity: number(row.orderedQty), fulfilled: number(row.fulfilledQty), status: text(['draft', 'cancelled', 'canceled'].includes(row.workflowStatus) ? row.workflowStatus : row.status || row.statusLabel), amount: number(row.totalAmount ?? row.amount), currency: currencyCode(row.currency || 'CNY') })),
    inventory_balances: inventory.availability.map(row => ({ id: row.sku, sku: row.sku, quantity: row.onHand, reserved: row.reserved, available: row.available, shortage: row.shortage, availableToPromise: row.availableToPromise, status: row.riskLevel })),
    supplier_invoices: array(context.supplierInvoices).map(row => ({ id: text(row.id || row.invoiceNumber), date: date(row), supplier: text(row.supplierName || row.supplierId), amount: number(row.totalAmount ?? row.amount), status: text(row.status), currency: currencyCode(row.currency || 'CNY') })),
    suppliers: array(context.suppliers).map(row => ({ id: text(row.id || row.supplierCode), supplier: text(row.supplierName || row.name), status: text(row.status) })),
  }
}

function filtered(rows, query, applyCurrency = true) {
  return rows.filter(row => (!query.from || !row.date || row.date >= query.from) && (!query.to || !row.date || row.date <= query.to) && (!query.supplier || row.supplier === query.supplier) && (!query.customer || row.customer === query.customer) && (!applyCurrency || !query.currency || !Object.hasOwn(row, 'currency') || row.currency === query.currency) && (!query.status || row.status === query.status))
}

function value(id, all, inventory) {
  if (id === 'sales_order_count') return all.sales_orders.length
  if (id === 'open_sales_demand') return all.sales_orders.filter(row => !['draft', 'cancelled', 'canceled'].includes(row.status)).reduce((total, row) => total + Math.max(0, row.quantity - row.fulfilled), 0)
  if (id === 'purchase_order_amount') return sum(all.purchase_orders, 'amount')
  if (id === 'open_po_count') return all.purchase_orders.filter(row => !['closed', 'cancelled', 'canceled', 'completed', 'fully_received', 'rejected'].includes(row.status)).length
  if (id === 'inventory_on_hand') {
    if (inventory.units?.length > 1) return null
    if (!inventory.availability.length) return 0
    if (inventory.availability.some(row => row.onHand === null)) return null
    return inventory.availability.reduce((total, row) => total + row.onHand, 0)
  }
  if (id === 'inventory_risk_sku') return inventory.availability.filter(row => row.shortage !== null && row.shortage > 0).length
  if (id === 'invoice_amount') return sum(all.supplier_invoices, 'amount')
  if (id === 'supplier_count') return all.suppliers.length
  return 0
}

function metric(id, all, inventory, aggregationStatus) {
  const [label, subject, unit, description, drilldownPath] = metricDefinitions[id]
  const unconverted = unit === 'currency' && aggregationStatus === 'multi_currency_unconverted'
  const currentValue = unconverted ? null : value(id, all, inventory)
  const incomplete = unconverted || (id === 'inventory_on_hand' && currentValue === null)
  const dataStatus = incomplete ? 'incomplete' : id === 'inventory_on_hand' && !inventory.availability.length ? 'empty' : 'complete'
  const limitations = unconverted ? ['multi_currency_unconverted'] : id === 'inventory_on_hand' && inventory.units?.length > 1 ? ['inventory_units_mixed'] : incomplete ? ['inventory_on_hand_incomplete'] : []
  return { id, label, subject, unit, format: unit, aggregation: description, numerator: description, denominator: null, dateField: 'date', applicableFilters: ['from', 'to', 'supplier', 'customer', 'currency'], drilldownPath, emptyValue: 0, version: '3.0.0-runtime', description, value: currentValue, currentValue, dataStatus, limitations, comparisonValue: null, comparisonDelta: null, comparisonRate: null, comparisonDirection: 'flat', comparisonLabel: unconverted ? '多币种，未折算' : incomplete ? '数据不足' : '未比较', comparisonUnit: unit, calculationLabel: description, generatedAt: new Date().toISOString() }
}

export function buildRuntimeGovernedReport(context, input = {}) {
  const inventory = buildRuntimeInventoryAllocation(context)
  inventory.units = [...new Set(array(context.inventoryItems).map(row => text(row.unit)).filter(Boolean))]
  if (inventory.units.length > 1) inventory.dataLimitations.push('inventory_units_mixed')
  const query = { subject: dashboardMetrics[input.subject] ? input.subject : 'overview', from: text(input.filters?.from || ''), to: text(input.filters?.to || ''), supplier: text(input.filters?.supplier || ''), customer: text(input.filters?.customer || ''), currency: currencyCode(input.filters?.currency), status: text(input.filters?.status || ''), limit: Math.max(1, Math.min(200, number(input.limit || 50))) }
  const source = runtimeRows(context, inventory)
  const all = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, filtered(value, query)]))
  const metricIds = array(input.measures).filter(id => metricDefinitions[id]).length ? input.measures.filter(id => metricDefinitions[id]) : dashboardMetrics[query.subject]
  const primaryKey = query.subject === 'sales' ? 'sales_orders' : query.subject === 'inventory' ? 'inventory_balances' : query.subject === 'finance' ? 'supplier_invoices' : query.subject === 'suppliers' ? 'suppliers' : 'purchase_orders'
  const currencySubject = query.subject === 'sales' ? 'sales_orders' : query.subject === 'finance' ? 'supplier_invoices' : ['overview', 'procurement', 'suppliers'].includes(query.subject) ? 'purchase_orders' : null
  const currencyRows = currencySubject ? filtered(source[currencySubject], query, false).filter(row => row.currency) : []
  const detectedCurrencies = [...new Set(currencyRows.map(row => row.currency))].sort()
  const currencies = query.currency ? [query.currency] : detectedCurrencies
  const aggregationStatus = query.currency ? 'filtered_currency' : detectedCurrencies.length === 0 ? 'no_currency_data' : detectedCurrencies.length === 1 ? 'single_currency' : 'multi_currency_unconverted'
  const selectedCurrencyCode = query.currency || (detectedCurrencies.length === 1 ? detectedCurrencies[0] : null)
  const selectedCurrencyLabel = aggregationStatus === 'multi_currency_unconverted' ? '多币种，未折算' : aggregationStatus === 'no_currency_data' ? '无币种数据' : currencyLabel(selectedCurrencyCode)
  const currencyAmounts = currencies.map(code => ({ currencyCode: code, currencyLabel: currencyLabel(code), amount: sum(currencyRows.filter(row => row.currency === code), 'amount') }))
  const details = all[primaryKey].slice(0, query.limit)
  const chartData = details.flatMap(row => {
    const rawValue = row.amount ?? row.quantity
    if (query.subject === 'inventory' && (rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue)))) return []
    return [{ name: `${text(row.id)}${aggregationStatus === 'multi_currency_unconverted' && row.currency ? `（${row.currency}）` : ''}`, value: rawValue === null || rawValue === undefined ? 1 : Number(rawValue) }]
  })
  const charts = [{ id: `${query.subject}_runtime_records`, title: '当前范围真实记录', type: 'bar', data: chartData, categoryKey: 'name', valueKey: 'value', valueFormat: 'number', unit: 'number', legend: false, tooltip: true, colors: ['#2563eb'], drilldownPath: query.subject === 'sales' ? '/app/sales/orders' : query.subject === 'inventory' ? '/app/inventory' : query.subject === 'finance' ? '/app/finance/invoices' : query.subject === 'suppliers' ? '/app/master-data/suppliers' : '/app/procurement/orders', crossFilter: null, emptyState: '当前筛选范围暂无真实 runtime 记录。' }]
  const columns = [...new Set(details.flatMap(row => Object.keys(row)))].map(key => ({ key, label: ({ id: '业务编号', date: '业务日期', supplier: '供应商', customer: '客户', amount: '金额', quantity: '数量', status: '状态', currency: '币种', sku: 'SKU', available: '可用量', shortage: '缺口', availableToPromise: 'ATP' })[key] || key, type: ['amount'].includes(key) ? 'currency' : ['quantity', 'available', 'shortage', 'availableToPromise'].includes(key) ? 'number' : key === 'date' ? 'date' : key === 'id' ? 'business_link' : 'text', subject: primaryKey }))
  const limitations = [...new Set([...array(context.dataLimitations), ...inventory.dataLimitations, ...(inventory.availability.length && inventory.availability.some(row => row.onHand === null) ? ['inventory_on_hand_incomplete'] : []), ...(aggregationStatus === 'multi_currency_unconverted' ? ['multi_currency_unconverted'] : [])])]
  const distinct = values => [...new Set(values.map(text).filter(Boolean))]
  const dataScope = { label: '当前工作区 runtime 数据', company: '—', currencyCode: selectedCurrencyCode, currencyLabel: selectedCurrencyLabel, currencies, currencyAggregationStatus: aggregationStatus, currencyAmounts, fxConverted: false, from: query.from || '—', to: query.to || '—', activeFilterCount: ['from', 'to', 'supplier', 'customer', 'currency', 'status'].filter(key => query[key]).length, sourceLabel: 'BusinessReadContext', completenessLabel: details.length ? `已读取 ${details.length} 条真实记录` : '当前范围无真实业务记录', filterOptions: { companies: [], suppliers: distinct(array(context.suppliers).map(row => row.supplierName || row.name)), customers: distinct(array(context.customers).map(row => row.name || row.customerName)), warehouses: distinct(array(context.warehouses).map(row => row.name || row.warehouseName)), categories: distinct(array(context.items).map(row => row.category || row.categoryName)), currencies: distinct([...source.purchase_orders, ...source.sales_orders, ...source.supplier_invoices].map(row => row.currency)) } }
  const overview = query.subject === 'overview' ? buildBusinessOverview(all) : null
  return { query, generatedAt: new Date().toISOString(), dataScope, kpis: metricIds.map(id => metric(id, all, inventory, aggregationStatus)), charts: overview?.charts || charts, attention: overview?.attention || [], totalRecords: all[primaryKey].length, rankings: [], details, columnDefinitions: columns, warnings: limitations, limitations, drilldowns: metricIds.map(id => ({ metricId: id, path: metricDefinitions[id][4] })), exportRows: all[primaryKey], metricDefinitions: metricIds.map(id => metric(id, all, inventory, aggregationStatus)) }
}

export function getRuntimeReportCatalog() {
  const subjects = {
    purchase_orders: ['采购订单', '/app/procurement/orders'], sales_orders: ['销售订单', '/app/sales/orders'],
    inventory_balances: ['库存余额', '/app/inventory'], supplier_invoices: ['供应商发票', '/app/finance/invoices'],
    suppliers: ['供应商', '/app/master-data/suppliers'], purchase_requests: ['采购申请', '/app/procurement/requests'],
    rfqs: ['询报价', '/app/procurement/rfqs'], receiving: ['收货', '/app/procurement/receiving'],
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
