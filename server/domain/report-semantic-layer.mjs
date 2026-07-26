const SUBJECTS = Object.freeze({
  purchase_orders: { label: '采购订单', defaultDateField: 'date', detailRoute: '/app/procurement/orders', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  purchase_requests: { label: '采购申请', defaultDateField: 'date', detailRoute: '/app/procurement/requests', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  rfqs: { label: '询报价', defaultDateField: 'date', detailRoute: '/app/procurement/rfq', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  receiving: { label: '收货', defaultDateField: 'date', detailRoute: '/app/procurement/receiving', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  supplier_invoices: { label: '供应商发票', defaultDateField: 'date', detailRoute: '/app/finance/invoices', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  three_way_matches: { label: '三单匹配', defaultDateField: 'date', detailRoute: '/app/finance/three-way-match', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  reconciliation: { label: '供应商对账', defaultDateField: 'date', detailRoute: '/app/finance/reconciliation', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  settlement: { label: '结算', defaultDateField: 'date', detailRoute: '/app/finance/settlement', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  sales_orders: { label: '销售订单', defaultDateField: 'date', detailRoute: '/app/sales/orders', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  deliveries: { label: '发货', defaultDateField: 'date', detailRoute: '/app/sales/deliveries', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  receipts: { label: '签收', defaultDateField: 'date', detailRoute: '/app/sales/receipts', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  inventory_balances: { label: '库存余额', defaultDateField: 'date', detailRoute: '/app/inventory', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  inventory_movements: { label: '库存流水', defaultDateField: 'date', detailRoute: '/app/inventory/movements', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
  suppliers: { label: '供应商', defaultDateField: 'date', detailRoute: '/app/master-data/suppliers', permissions: ['viewer', 'analyst', 'manager', 'admin'] },
})

const FIELD_BASE = [
  ['id', '业务编号', 'business_link', true, true, false], ['date', '业务日期', 'date', true, true, true],
  ['company', '公司', 'text', true, true, true], ['supplier', '供应商', 'business_link', true, true, true],
  ['customer', '客户', 'business_link', true, true, true], ['warehouse', '仓库', 'text', true, true, true],
  ['category', '品类', 'text', true, true, true], ['currency', '币种', 'enum', true, true, true],
  ['amount', '金额', 'currency', true, false, false], ['quantity', '数量', 'number', true, false, false],
  ['status', '状态', 'enum', true, true, true], ['owner', '负责人', 'text', true, true, true],
]

const FIELD_PRESENTATION = Object.freeze({
  id: { label: '业务编号', type: 'business_link' }, date: { label: '业务日期', type: 'date' }, company: { label: '公司', type: 'text' },
  supplier: { label: '供应商', type: 'business_link' }, customer: { label: '客户', type: 'business_link' }, warehouse: { label: '仓库', type: 'text' },
  category: { label: '品类', type: 'text' }, currency: { label: '币种', type: 'enum' }, amount: { label: '金额', type: 'currency' },
  quantity: { label: '数量', type: 'number' }, status: { label: '状态', type: 'enum' }, owner: { label: '负责人', type: 'text' },
  sku: { label: 'SKU', type: 'business_link' }, po: { label: '采购订单', type: 'business_link' }, grn: { label: '收货单', type: 'business_link' },
  dueDate: { label: '到期日期', type: 'date' }, overdueDays: { label: '逾期天数', type: 'days' }, variance: { label: '差异金额', type: 'currency' },
  matchStatus: { label: '匹配状态', type: 'enum' }, approvalStatus: { label: '审批状态', type: 'enum' }, recommendedAction: { label: '建议动作', type: 'text' },
  safetyStock: { label: '安全库存', type: 'number' }, monthlyDemand: { label: '月需求', type: 'number' }, unitCost: { label: '单位成本', type: 'currency' },
  onTimeRate: { label: '准时交付率', type: 'percentage' }, qualityRate: { label: '质量合格率', type: 'percentage' }, risk: { label: '风险等级', type: 'enum' },
})

const ENUM_PRESENTATION = Object.freeze({
  delivered: '已交付', partial: '部分交付', open: '进行中', completed: '已完成', pending: '待处理', paid: '已结算',
  matched: '已匹配', variance: '存在差异', blocked: '阻断', approved: '已审批', review: '待复核', normal: '正常', risk: '风险',
})

function localizedValue(key, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (['status', 'matchStatus', 'approvalStatus', 'risk'].includes(key)) return ENUM_PRESENTATION[String(value)] || value
  return value
}

function columnDefinitions(rows = [], subject = '') {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => FIELD_PRESENTATION[key])
  return keys.map((key) => ({ key, ...FIELD_PRESENTATION[key], subject, valueMap: ['status', 'matchStatus', 'approvalStatus', 'risk'].includes(key) ? ENUM_PRESENTATION : undefined }))
}

export const reportFieldCatalog = Object.freeze(Object.fromEntries(
  Object.keys(SUBJECTS).map((subject) => [
    subject,
    FIELD_BASE.map(([key, label, type, sortable, filterable, groupable]) => ({
      key, label, type, subject, description: `${SUBJECTS[subject].label}${label}`, source: subject,
      sortable, filterable, groupable, exportable: true, sensitive: false, requiredPermission: 'reports:view',
      format: type === 'date' ? 'YYYY-MM-DD' : type === 'currency' ? 'currency' : 'default', enumOptions: [],
      origin: 'system', customFieldId: null, enabledForReporting: true,
      ...(type === 'business_link' ? { entityType: key === 'supplier' ? 'supplier' : key === 'customer' ? 'customer' : subject, route: SUBJECTS[subject].detailRoute } : {}),
    })),
  ]),
))

function metric(id, label, subject, unit, aggregation, description, drilldownPath, extra = {}) {
  return { id, label, description, subject, unit, format: unit, aggregation, numerator: extra.numerator || aggregation, denominator: extra.denominator || null, dateField: 'date', applicableFilters: ['from', 'to', 'company', 'warehouse', 'supplier', 'customer', 'category', 'currency'], drilldownPath, emptyValue: 0, version: '2.0.0' }
}

export const reportMetricCatalog = Object.freeze([
  metric('sales_order_amount', '销售订单金额', 'sales_orders', 'currency', 'sum(amount)', '筛选范围内销售订单含税金额合计。', '/app/sales/orders'),
  metric('sales_order_count', '销售订单数量', 'sales_orders', 'number', 'count(id)', '筛选范围内销售订单数。', '/app/sales/orders'),
  metric('unshipped_amount', '未发货金额', 'sales_orders', 'currency', 'sum(amount where status != delivered)', '未完成发货的销售订单金额。', '/app/sales/orders?status=unshipped'),
  metric('delivery_completion_rate', '发货完成率', 'deliveries', 'percentage', 'delivered / ordered', '已完成发货订单数占应发货订单数。', '/app/sales/deliveries', { numerator: 'delivered orders', denominator: 'orders due for delivery' }),
  metric('on_time_delivery_rate', '准时交付率', 'deliveries', 'percentage', 'on_time / due', '按承诺日期完成交付的订单占比。', '/app/sales/deliveries?timeliness=on-time', { numerator: 'on-time deliveries', denominator: 'deliveries due' }),
  metric('purchase_order_amount', '采购订单金额', 'purchase_orders', 'currency', 'sum(amount)', '筛选范围内采购订单金额合计。', '/app/procurement/orders'),
  metric('open_po_count', '开放 PO', 'purchase_orders', 'number', 'count(open)', '未关闭、未取消采购订单数。', '/app/procurement/orders?status=open'),
  metric('overdue_po_amount', '逾期 PO 金额', 'purchase_orders', 'currency', 'sum(overdue amount)', '承诺日期早于范围结束且未完成的采购订单金额。', '/app/procurement/orders?overdue=true'),
  metric('rfq_response_rate', 'RFQ 响应率', 'rfqs', 'percentage', 'quoted / invited', '已报价供应商数占邀请供应商数。', '/app/procurement/rfq', { numerator: 'quoted suppliers', denominator: 'invited suppliers' }),
  metric('supplier_otif', '供应商 OTIF', 'receiving', 'percentage', 'on_time_in_full / due', '按承诺日期足量收货的订单占比。', '/app/reports/suppliers', { numerator: 'on-time in-full receipts', denominator: 'receipts due' }),
  metric('inventory_value', '库存金额', 'inventory_balances', 'currency', 'sum(quantity * unitCost)', '库存数量乘受控单位成本的合计。', '/app/inventory'),
  metric('inventory_turnover', '库存周转率', 'inventory_movements', 'number', 'annualized outbound / average inventory', '年化出库成本除以平均库存金额；无成本数据时为空。', '/app/inventory/movements'),
  metric('inventory_coverage_days', '库存覆盖天数', 'inventory_balances', 'days', 'quantity / demand * 30', '当前库存按月需求折算的覆盖天数。', '/app/inventory'),
  metric('inventory_risk_sku', '库存风险 SKU', 'inventory_balances', 'number', 'count(quantity < safetyStock)', '低于安全库存或缺货的 SKU 数。', '/app/inventory?risk=below-safety'),
  metric('invoice_amount', '发票总额', 'supplier_invoices', 'currency', 'sum(total)', '供应商发票含税金额合计。', '/app/finance/invoices'),
  metric('overdue_payable', '逾期应付', 'supplier_invoices', 'currency', 'sum(overdue unpaid)', '已到期且未结清发票金额。', '/app/finance/invoices?overdue=true'),
  metric('three_way_match_rate', '三单匹配率', 'three_way_matches', 'percentage', 'matched_without_block / in_scope', '无阻断差异的已匹配发票数占进入匹配范围的发票数。', '/app/finance/three-way-match', { numerator: 'matched invoices without blocking variance', denominator: 'in-scope invoices' }),
  metric('invoice_variance_amount', '差异金额', 'supplier_invoices', 'currency', 'sum(abs(variance))', '发票与采购/收货证据差异绝对值合计。', '/app/finance/invoices?variance=true'),
  metric('supplier_purchase_amount', '供应商采购金额', 'purchase_orders', 'currency', 'sum(amount)', '按供应商归集的采购订单金额。', '/app/reports/suppliers'),
  metric('supplier_risk_count', '风险供应商数量', 'suppliers', 'number', 'count(risk)', '风险等级为中或高的供应商数。', '/app/master-data/suppliers?risk=true'),
])

function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function isoDate(value, fallback = '2026-07-11') {
  const raw = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const match = raw.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/)
  if (match) return `${match[1] || '2026'}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
  return fallback
}
function normalizeQuery(input = {}) {
  const filters = input.filters || input
  return {
    subject: input.subject || 'overview', from: filters.from || input.dateRange?.from || '2026-01-01', to: filters.to || input.dateRange?.to || '2026-07-11',
    company: filters.company || '', warehouse: filters.warehouse || '', supplier: filters.supplier || '', customer: filters.customer || '', category: filters.category || '', currency: filters.currency || 'CNY',
    dimensions: Array.isArray(input.dimensions) ? input.dimensions : [], measures: Array.isArray(input.measures) ? input.measures : [], sort: input.sort || null, limit: Math.min(200, Math.max(1, number(input.limit, 50))),
    comparison: ['none', 'previous_period', 'year_over_year'].includes(input.comparison || filters.comparison) ? (input.comparison || filters.comparison) : 'previous_period',
    topN: [5, 8].includes(number(input.topN || filters.topN)) ? number(input.topN || filters.topN) : 8,
    matchStatus: filters.matchStatus || '', aging: filters.aging || '', status: filters.status || '', risk: filters.risk || '', varianceType: filters.varianceType || '',
  }
}
function keep(row, query) {
  if (row.date && (row.date < query.from || row.date > query.to)) return false
  for (const key of ['company', 'warehouse', 'supplier', 'customer', 'category', 'currency']) {
    if (query[key] && row[key] && String(row[key]) !== String(query[key])) return false
  }
  if (query.matchStatus && row.matchStatus && row.matchStatus !== query.matchStatus) return false
  if (query.status && row.status && String(row.status) !== String(query.status)) return false
  if (query.risk && row.safetyStock !== undefined) {
    const belowSafety = number(row.quantity) < number(row.safetyStock)
    if (['below-safety', '低于安全库存', '风险'].includes(query.risk) ? !belowSafety : belowSafety) return false
  }
  return true
}
function sum(rows, key) { return rows.reduce((total, row) => total + number(row[key]), 0) }
function rate(numerator, denominator) { return denominator ? numerator / denominator * 100 : 0 }
function month(date) { return String(date || '').slice(0, 7) }
function group(rows, key, valueKey = 'amount') {
  const result = new Map()
  rows.forEach((row) => { const label = row[key] || '未分类'; result.set(label, (result.get(label) || 0) + number(row[valueKey], 1)) })
  return [...result.entries()].map(([name, value]) => ({ name, value }))
}
function mergeByKey(primary = [], secondary = [], key) {
  const seen = new Set(primary.map((row) => String(row[key] || '')).filter(Boolean))
  return [...primary, ...secondary.filter((row) => !seen.has(String(row[key] || '')))]
}
function sourceRows(data = {}) {
  const purchaseOrders = (data.purchaseOrders || []).map((row) => ({ id: row.po || row.id, date: isoDate(row.created || row.createdAt, ''), supplier: row.supplier || row.supplierName, amount: number(row.amount || row.totalAmount), quantity: number(row.items || row.totalOrderedQty), status: row.status, owner: row.owner, currency: row.currency || row.lines?.[0]?.currency || '', company: row.company || '', category: row.category || '', sku: row.sourceSku || '' }))
  const purchaseRequests = (data.purchaseRequests || []).map((row) => ({ id: row.pr || row.id, date: isoDate(row.created || row.requiredDate, ''), supplier: row.supplier, amount: number(row.amount), quantity: number(row.quantity), status: row.status, owner: row.buyer || row.requester, currency: row.currency || '', company: row.company || '', category: row.category || '', sku: row.sourceSku }))
  const rfqs = (data.rfqs || []).map((row) => ({ id: row.id, date: isoDate(row.createdAt || row.due, ''), supplier: row.bestSupplier, amount: number(row.bestPrice) * number(row.quantity), quantity: number(row.quantity), status: row.status, currency: row.currency || '', company: row.company || '', category: row.category, invited: number(row.suppliers || row.invitedSuppliers?.length), quoted: number(row.quoted) }))
  const receiving = (data.receivingDocs || []).map((row) => ({ id: row.grn || row.id, date: isoDate(row.arrived || row.createdAt, ''), supplier: row.supplier, warehouse: row.warehouse, amount: number(row.amount), quantity: number(row.items), status: row.status, currency: row.currency || '', company: row.company || '', accepted: number(row.passed), rejected: number(row.failed) }))
  const invoices = (data.supplierInvoices || []).map((row) => ({ id: row.invoiceNumber || row.id, date: isoDate(row.invoiceDate || row.createdAt, ''), dueDate: isoDate(row.dueDate, ''), supplier: row.supplier || row.supplierName || row.supplierCode, amount: number(row.total || row.amount), variance: number(row.varianceAmount), varianceType: row.varianceType || '', status: row.status || '', currency: row.currency || '', company: row.company || '', po: row.relatedPo, grn: row.relatedGrn, matchStatus: row.matchStatus || '', approvalStatus: row.approvalStatus || '', owner: row.owner || '', recommendedAction: row.recommendedAction || '' })).map((row) => ({ ...row, overdueDays: row.dueDate ? Math.max(0, Math.floor((new Date() - new Date(row.dueDate)) / 86400000)) : 0 }))
  const products = data.products || data.items || []
  const balances = (data.inventoryBalances || []).map((row) => ({ id: row.id || `${row.warehouse}/${row.bin}/${row.sku}`, date: isoDate(row.asOfDate || row.updatedAt, ''), sku: row.sku, warehouse: row.warehouse, quantity: number(row.quantity || row.onHandQuantity), safetyStock: number(row.safetyStock), unitCost: number(row.unitCost), amount: number(row.quantity || row.onHandQuantity) * number(row.unitCost), status: row.status, currency: row.currency || '', company: row.company || '', category: row.category || '' }))
  const suppliers = (data.suppliers || []).map((row) => ({ id: row.code || row.id || row.name, date: isoDate(row.updatedAt, ''), supplier: row.name || row.supplierName, category: row.category, status: row.status, risk: row.risk || row.riskStatus, onTimeRate: number(row.onTimeRate), qualityRate: number(row.qualityRate), currency: row.currency || '', company: row.company || '' }))
  const sales = (data.salesOrders || []).map((row) => ({ id: row.orderNo || row.id, date: isoDate(row.orderDate || row.createdAt, ''), amount: number(row.amount || row.totalAmount), quantity: number(row.quantity || row.totalQuantity), customer: row.customer || row.customerName, category: row.category || '', currency: row.currency || '', company: row.company || '', status: row.status || '', onTime: Boolean(row.onTime) }))
  return { purchase_orders: purchaseOrders, purchase_requests: purchaseRequests, rfqs, receiving, supplier_invoices: invoices, three_way_matches: invoices, reconciliation: data.supplierReconciliations || [], settlement: data.settlements || [], sales_orders: sales, deliveries: data.deliveries || [], receipts: data.receipts || [], inventory_balances: balances, inventory_movements: data.inventoryMovements || [], suppliers, products }
}

const DASHBOARD_METRICS = Object.freeze({
  overview: ['sales_order_amount', 'purchase_order_amount', 'inventory_value', 'overdue_payable', 'on_time_delivery_rate', 'three_way_match_rate', 'inventory_risk_sku', 'open_po_count'],
  procurement: ['purchase_order_amount', 'open_po_count', 'overdue_po_amount', 'rfq_response_rate'],
  sales: ['sales_order_amount', 'unshipped_amount', 'delivery_completion_rate', 'on_time_delivery_rate'],
  inventory: ['inventory_value', 'inventory_turnover', 'inventory_coverage_days', 'inventory_risk_sku'],
  finance: ['invoice_amount', 'overdue_payable', 'three_way_match_rate', 'invoice_variance_amount'],
  suppliers: ['supplier_purchase_amount', 'rfq_response_rate', 'supplier_otif', 'supplier_risk_count'],
})

function calculate(metricId, rows, query) {
  const po = rows.purchase_orders; const sales = rows.sales_orders; const invoices = rows.supplier_invoices; const balances = rows.inventory_balances; const rfqs = rows.rfqs; const receiving = rows.receiving; const suppliers = rows.suppliers
  const today = query.to
  const calculations = {
    sales_order_amount: () => sum(sales, 'amount'), sales_order_count: () => sales.length,
    unshipped_amount: () => sum(sales.filter((row) => row.status !== 'delivered'), 'amount'),
    delivery_completion_rate: () => rate(sales.filter((row) => row.status === 'delivered').length, sales.length),
    on_time_delivery_rate: () => rate(sales.filter((row) => row.onTime).length, sales.length),
    purchase_order_amount: () => sum(po, 'amount'), open_po_count: () => po.filter((row) => !/完成|取消|closed|cancelled/i.test(row.status || '')).length,
    overdue_po_amount: () => sum(po.filter((row) => row.date < today && !/完成|取消|closed|cancelled/i.test(row.status || '')), 'amount'),
    rfq_response_rate: () => rate(sum(rfqs, 'quoted'), sum(rfqs, 'invited')),
    supplier_otif: () => rate(receiving.filter((row) => row.rejected === 0).length, receiving.length),
    inventory_value: () => sum(balances, 'amount'), inventory_turnover: () => 0,
    inventory_coverage_days: () => { const applicable = balances.filter((row) => row.monthlyDemand > 0); return applicable.length ? applicable.reduce((total, row) => total + number(row.quantity) / number(row.monthlyDemand) * 30, 0) / applicable.length : 0 },
    inventory_risk_sku: () => balances.filter((row) => row.quantity < row.safetyStock).length,
    invoice_amount: () => sum(invoices, 'amount'), overdue_payable: () => sum(invoices.filter((row) => row.dueDate < today && !/paid|已结算/i.test(row.status || '')), 'amount'),
    three_way_match_rate: () => rate(invoices.filter((row) => number(row.variance) === 0).length, invoices.length),
    invoice_variance_amount: () => invoices.reduce((total, row) => total + Math.abs(number(row.variance)), 0),
    supplier_purchase_amount: () => sum(po, 'amount'), supplier_risk_count: () => suppliers.filter((row) => /中|高|medium|high/i.test(row.risk || '')).length,
  }
  return number(calculations[metricId]?.(), 0)
}

function trend(rows, key = 'amount') {
  const grouped = new Map()
  rows.forEach((row) => { const label = month(row.date); grouped.set(label, (grouped.get(label) || 0) + number(row[key])) })
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, value]) => ({ period, value }))
}

function previousQuery(query) {
  const from = new Date(`${query.from}T00:00:00Z`); const to = new Date(`${query.to}T00:00:00Z`)
  if (query.comparison === 'year_over_year') {
    from.setUTCFullYear(from.getUTCFullYear() - 1); to.setUTCFullYear(to.getUTCFullYear() - 1)
  } else {
    const span = Math.max(1, Math.round((to - from) / 86400000) + 1)
    from.setUTCDate(from.getUTCDate() - span); to.setUTCDate(to.getUTCDate() - span)
  }
  return { ...query, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

function top(rows, key, limit = 8, valueKey = 'amount') { return group(rows, key, valueKey).sort((a, b) => b.value - a.value).slice(0, limit) }
function statusDistribution(rows, key = 'status') { return group(rows, key).map((row) => ({ ...row, name: localizedValue(key, row.name), filterValue: row.name })) }
function chart(id, title, type, data, drilldownPath, extra = {}) {
  return { id, title, type, data, categoryKey: 'name', valueKey: 'value', valueFormat: extra.valueFormat || 'number', unit: extra.unit || 'number', legend: extra.legend !== false, tooltip: true, colors: extra.colors || ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444'], drilldownPath, crossFilter: extra.crossFilter || null, emptyState: '当前筛选范围暂无可展示数据。', ...extra }
}

function dashboardCharts(dashboard, filtered, query) {
  const po = filtered.purchase_orders; const sales = filtered.sales_orders; const invoices = filtered.supplier_invoices; const balances = filtered.inventory_balances; const receiving = filtered.receiving; const suppliers = filtered.suppliers
  if (dashboard === 'finance') return [
    chart('finance_invoice_trend', '发票金额趋势', 'area', trend(invoices), '/app/finance/invoices', { unit: 'currency', valueFormat: 'currency', crossFilter: 'period' }),
    chart('finance_match_status', '匹配状态分布', 'donut', statusDistribution(invoices, 'matchStatus'), '/app/finance/invoices', { crossFilter: 'matchStatus' }),
    chart('finance_ap_aging', '应付账龄分布', 'stacked_bar', [{ name: '应付账龄', 未到期: sum(invoices.filter((row) => !row.overdueDays), 'amount'), '0–30 天': sum(invoices.filter((row) => row.overdueDays > 0 && row.overdueDays <= 30), 'amount'), '31–60 天': sum(invoices.filter((row) => row.overdueDays > 30 && row.overdueDays <= 60), 'amount'), '61–90 天': sum(invoices.filter((row) => row.overdueDays > 60 && row.overdueDays <= 90), 'amount'), '90 天以上': sum(invoices.filter((row) => row.overdueDays > 90), 'amount') }], '/app/finance/invoices', { unit: 'currency', valueFormat: 'currency', stack: true, seriesKeys: ['未到期', '0–30 天', '31–60 天', '61–90 天', '90 天以上'], crossFilter: 'aging' }),
    chart('finance_variance_types', '差异类型分布', 'donut', group(invoices.filter((row) => row.varianceType), 'varianceType', 'variance'), '/app/finance/invoices?variance=true', { unit: 'currency', valueFormat: 'currency', crossFilter: 'varianceType' }),
    chart('finance_supplier_payable', `供应商应付金额 Top ${query.topN}`, 'horizontal_bar', top(invoices, 'supplier', query.topN), '/app/finance/invoices', { unit: 'currency', valueFormat: 'currency', crossFilter: 'supplier', orientation: 'horizontal' }),
  ]
  if (dashboard === 'procurement') return [
    chart('procurement_spend_trend', '采购金额趋势', 'area', trend(po), '/app/procurement/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'period' }),
    chart('procurement_supplier_top', `供应商采购金额 Top ${query.topN}`, 'horizontal_bar', top(po, 'supplier', query.topN), '/app/procurement/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'supplier' }),
    chart('procurement_category_share', '品类支出占比', 'donut', group(po, 'category'), '/app/procurement/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'category' }),
    chart('procurement_po_status', '采购订单状态分布', 'stacked_bar', statusDistribution(po), '/app/procurement/orders', { crossFilter: 'status' }),
    chart('procurement_overdue_trend', '逾期采购订单趋势', 'line', trend(po.filter((row) => row.date < query.to)), '/app/procurement/orders?overdue=true', { unit: 'currency', valueFormat: 'currency', crossFilter: 'period' }),
    chart('procurement_otif', '供应商 OTIF 排名', 'horizontal_bar', top(receiving, 'supplier', query.topN, 'accepted'), '/app/reports/suppliers', { unit: 'percentage', crossFilter: 'supplier' }),
  ]
  if (dashboard === 'sales') return [
    chart('sales_amount_trend', '销售金额趋势', 'area', trend(sales), '/app/sales/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'period' }),
    chart('sales_customer_top', `客户销售金额 Top ${query.topN}`, 'horizontal_bar', top(sales, 'customer', query.topN), '/app/sales/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'customer' }),
    chart('sales_fulfillment', '订单履约状态', 'donut', statusDistribution(sales), '/app/sales/orders', { crossFilter: 'status' }),
    chart('sales_ontime', '准时交付趋势', 'line', trend(sales.map((row) => ({ ...row, amount: row.onTime ? 100 : 0 }))), '/app/sales/deliveries', { unit: 'percentage', crossFilter: 'period' }),
    chart('sales_unshipped', '未发货与部分发货', 'stacked_bar', [{ name: '履约状态', 未发货: sales.filter((row) => row.status === 'open').length, 部分发货: sales.filter((row) => row.status === 'partial').length }], '/app/sales/orders', { stack: true, seriesKeys: ['未发货', '部分发货'], crossFilter: 'status' }),
    chart('sales_returns', '销售退货趋势', 'line', [], '/app/sales/returns', { unit: 'currency', valueFormat: 'currency', crossFilter: 'period' }),
  ]
  if (dashboard === 'inventory') return [
    chart('inventory_value_trend', '库存金额趋势', 'area', trend(balances), '/app/inventory/stock', { unit: 'currency', valueFormat: 'currency', crossFilter: 'period' }),
    chart('inventory_risk', '库存风险分布', 'donut', [{ name: '低于安全库存', value: balances.filter((row) => row.quantity < row.safetyStock).length }, { name: '正常', value: balances.filter((row) => row.quantity >= row.safetyStock).length }], '/app/inventory/stock', { crossFilter: 'risk' }),
    chart('inventory_aging', '库龄分布', 'stacked_bar', [], '/app/inventory/stock', { stack: true, seriesKeys: ['0–30 天', '31–60 天', '61–90 天', '90 天以上'], crossFilter: 'aging' }),
    chart('inventory_warehouse', '仓库库存金额', 'horizontal_bar', top(balances, 'warehouse', query.topN), '/app/inventory/stock', { unit: 'currency', valueFormat: 'currency', crossFilter: 'warehouse' }),
    chart('inventory_in_out', '入库与出库趋势', 'line', trend(filtered.inventory_movements, 'quantity'), '/app/inventory/movements', { crossFilter: 'period' }),
    chart('inventory_category', '品类库存金额', 'bar', group(balances, 'category'), '/app/inventory/stock', { unit: 'currency', valueFormat: 'currency', crossFilter: 'category' }),
  ]
  if (dashboard === 'suppliers') return [
    chart('supplier_purchase_top', `供应商采购金额 Top ${query.topN}`, 'horizontal_bar', top(po, 'supplier', query.topN), '/app/procurement/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'supplier' }),
    chart('supplier_risk', '供应商风险等级分布', 'donut', statusDistribution(suppliers, 'risk'), '/app/master-data/suppliers', { crossFilter: 'risk' }),
    chart('supplier_otif', 'OTIF 排名', 'horizontal_bar', top(suppliers, 'supplier', query.topN, 'onTimeRate'), '/app/master-data/suppliers', { unit: 'percentage', crossFilter: 'supplier' }),
    chart('supplier_quality', '质量合格率排名', 'horizontal_bar', top(suppliers, 'supplier', query.topN, 'qualityRate'), '/app/master-data/suppliers', { unit: 'percentage', crossFilter: 'supplier' }),
    chart('supplier_invoice_variance', '发票差异率', 'bar', top(invoices, 'supplier', query.topN, 'variance'), '/app/finance/invoices?variance=true', { unit: 'currency', valueFormat: 'currency', crossFilter: 'supplier' }),
    chart('supplier_receiving_exception', '收货异常趋势', 'line', trend(receiving, 'rejected'), '/app/procurement/receiving', { crossFilter: 'period' }),
  ]
  return [
    { ...chart('sales_purchase_trend', '销售与采购金额趋势', 'line', [], '/app/procurement/orders', { unit: 'currency', valueFormat: 'currency' }), series: [{ key: 'sales', label: '销售金额', data: trend(sales) }, { key: 'purchase', label: '采购金额', data: trend(po) }] },
    chart('ap_aging', '应付账龄', 'stacked_bar', [{ name: '应付账龄', 未到期: sum(invoices.filter((row) => !row.overdueDays), 'amount'), '0–30 天': sum(invoices.filter((row) => row.overdueDays > 0 && row.overdueDays <= 30), 'amount'), '31–60 天': sum(invoices.filter((row) => row.overdueDays > 30), 'amount') }], '/app/finance/invoices', { unit: 'currency', valueFormat: 'currency', stack: true, seriesKeys: ['未到期', '0–30 天', '31–60 天'] }),
    chart('overview_inventory_risk', '库存风险分布', 'donut', [{ name: '风险', value: balances.filter((row) => row.quantity < row.safetyStock).length }, { name: '正常', value: balances.filter((row) => row.quantity >= row.safetyStock).length }], '/app/inventory/stock', { crossFilter: 'risk' }),
    chart('overview_supplier_top', '供应商采购金额 Top 5', 'horizontal_bar', top(po, 'supplier', 5), '/app/procurement/orders', { unit: 'currency', valueFormat: 'currency', crossFilter: 'supplier' }),
  ]
}

export function buildGovernedReport(data = {}, input = {}) {
  const query = normalizeQuery(input)
  const all = sourceRows(data)
  const filtered = Object.fromEntries(Object.entries(all).map(([subject, rows]) => [subject, rows.filter((row) => keep(row, query))]))
  const dashboard = DASHBOARD_METRICS[query.subject] ? query.subject : 'overview'
  const metricIds = query.measures.length ? query.measures.filter((id) => reportMetricCatalog.some((metricItem) => metricItem.id === id)) : DASHBOARD_METRICS[dashboard]
  const comparisonQuery = previousQuery(query)
  const comparisonRows = Object.fromEntries(Object.entries(all).map(([subject, rows]) => [subject, rows.filter((row) => keep(row, comparisonQuery))]))
  const kpis = metricIds.map((id) => {
    const definition = reportMetricCatalog.find((item) => item.id === id)
    const currentValue = calculate(id, filtered, query); const comparisonValue = query.comparison === 'none' ? null : calculate(id, comparisonRows, comparisonQuery)
    const comparisonDelta = comparisonValue === null ? null : currentValue - comparisonValue
    const comparisonRate = comparisonValue ? comparisonDelta / Math.abs(comparisonValue) * 100 : null
    return { ...definition, value: currentValue, currentValue, comparisonValue, comparisonDelta, comparisonRate, comparisonDirection: comparisonDelta === null || comparisonDelta === 0 ? 'flat' : comparisonDelta > 0 ? 'up' : 'down', comparisonLabel: query.comparison === 'year_over_year' ? '较上年同期' : query.comparison === 'previous_period' ? '较上期' : '未比较', comparisonUnit: definition.unit === 'percentage' ? 'percentage_points' : definition.unit, calculationLabel: definition.description, generatedAt: new Date().toISOString() }
  })
  const primary = dashboard === 'sales' ? filtered.sales_orders : dashboard === 'inventory' ? filtered.inventory_balances : dashboard === 'finance' ? filtered.supplier_invoices : dashboard === 'suppliers' ? filtered.purchase_orders : filtered.purchase_orders
  const charts = dashboardCharts(dashboard, filtered, query)
  const details = primary.slice(0, query.limit)
  const warnings = []
  if (dashboard === 'inventory' && kpis.some((item) => item.id === 'inventory_turnover' && item.value === 0)) warnings.push('当前库存数据缺少完整出库成本，库存周转率暂不计算。')
  if (['overview', 'inventory'].includes(dashboard) && calculate('inventory_value', filtered, query) === 0) warnings.push('当前库存余额缺少受控单位成本，库存金额不使用估算值补齐。')
  if (dashboard === 'finance' && filtered.supplier_invoices.length === 0) warnings.push('当前筛选范围没有已导入供应商发票。')
  return {
    query, generatedAt: new Date().toISOString(), dataScope: { label: '当前工作区受治理数据', company: query.company || '全部公司', currency: query.currency, from: query.from, to: query.to, activeFilterCount: ['company', 'warehouse', 'supplier', 'customer', 'category'].filter((key) => query[key]).length, sourceLabel: '当前工作区业务记录', completenessLabel: details.length ? `已读取 ${details.length} 条范围内记录` : '当前范围无业务记录' },
    kpis, charts, rankings: charts.filter((chart) => /排名|Top/.test(chart.title)), details: details.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, localizedValue(key, value)]))), columnDefinitions: columnDefinitions(details, dashboard), warnings,
    limitations: warnings, drilldowns: kpis.map((item) => ({ metricId: item.id, path: item.drilldownPath })),
    exportRows: details, metricDefinitions: kpis.map(({ value, generatedAt, ...definition }) => definition),
  }
}

export function getReportCatalog() {
  return { subjects: Object.entries(SUBJECTS).map(([id, value]) => ({ id, ...value, fields: reportFieldCatalog[id].map((field) => field.key) })), fields: reportFieldCatalog, metrics: reportMetricCatalog, templates: DASHBOARD_METRICS }
}

export { SUBJECTS as reportSubjectCatalog, normalizeQuery as normalizeReportQuery }
