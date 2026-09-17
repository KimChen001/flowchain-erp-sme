const text = value => String(value ?? '').trim()
const numeric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const day = value => {
  const candidate = text(value).slice(0, 10)
  const parsed = new Date(`${candidate}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : ''
}
const closed = new Set(['closed', 'cancelled', 'canceled', 'completed', 'fully_received', 'rejected'])
const round = value => Math.round(value * 10000) / 10000
const sumKnown = values => values.length && values.every(value => value !== null) ? round(values.reduce((a, b) => a + b, 0)) : null
const daysLate = (due, today) => due && Number.isFinite(Date.parse(due)) ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(due)) / 86400000)) : null

export function buildOpenPurchaseOrdersReport(purchaseOrders = [], filters = {}, now = new Date()) {
  if (['from', 'to'].some(key => filters[key] && (!day(filters[key]) || text(filters[key]).length !== 10)) || (filters.from && filters.to && filters.from > filters.to)) {
    throw Object.assign(new Error('Enter a valid date range in YYYY-MM-DD format.'), { status: 422, code: 'REPORT_DATE_RANGE_INVALID' })
  }
  const asOf = now.toISOString().slice(0, 10)
  const source = purchaseOrders.map(po => {
    const lines = (po.lines || []).map(line => {
      const ordered = numeric(line.orderedQuantity ?? line.quantity)
      const received = numeric(line.receivedQuantity)
      return { ordered, received, remaining: ordered === null || received === null ? null : round(Math.max(0, ordered - received)), unit: text(line.unit || line.unitSnapshot), due: day(line.promisedDate || line.metadata?.promisedDate || po.expectedDate) }
    })
    const openLines = lines.filter(line => line.remaining === null || line.remaining > 0)
    const isOpen = !closed.has(text(po.status)) && (!lines.length || openLines.length > 0)
    const units = [...new Set(lines.map(line => line.unit))]
    const sameUnit = units.length === 1 && Boolean(units[0])
    const dates = openLines.map(line => line.due).filter(Boolean).sort()
    const dueDate = dates[0] || (!lines.length ? day(po.expectedDate) : '')
    const overdueDays = isOpen ? daysLate(dueDate, asOf) : 0
    const dataIncomplete = !lines.length || lines.some(line => line.ordered === null || line.received === null) || (isOpen && (!dueDate || openLines.some(line => !line.due)))
    return {
      id: text(po.id), orderNumber: text(po.orderNumber || po.id), supplier: text(po.supplierSnapshot?.supplierName || po.supplierName || po.supplierId),
      supplierId: text(po.supplierId), createdDate: day(po.createdAt), dueDate, overdueDays, owner: text(po.owner),
      ordered: sameUnit ? sumKnown(lines.map(line => line.ordered)) : null,
      received: sameUnit ? sumKnown(lines.map(line => line.received)) : null,
      remaining: sameUnit ? sumKnown(lines.map(line => line.remaining)) : null,
      unit: sameUnit ? units[0] : units.length > 1 ? 'mixed' : '',
      amount: numeric(po.totalAmount ?? po.amount), currency: text(po.currency), status: text(po.status), isOpen, dataIncomplete,
    }
  })
  const query = { from: day(filters.from), to: day(filters.to), supplier: text(filters.supplier), currency: text(filters.currency), search: text(filters.search), scope: ['all', 'overdue', 'incomplete'].includes(filters.scope) ? filters.scope : filters.overdue === 'true' ? 'overdue' : 'open', sort: text(filters.sort) || 'overdueDays', direction: filters.direction === 'asc' ? 'asc' : 'desc' }
  const rows = source.filter(row =>
    (query.scope === 'all' || row.isOpen) && (query.scope !== 'overdue' || row.overdueDays > 0) && (query.scope !== 'incomplete' || row.dataIncomplete) &&
    (!query.from || row.createdDate >= query.from) && (!query.to || Boolean(row.createdDate) && row.createdDate <= query.to) &&
    (!query.supplier || row.supplier === query.supplier) && (!query.currency || row.currency === query.currency) &&
    (!query.search || [row.orderNumber, row.supplier, row.owner].some(value => value.toLowerCase().includes(query.search.toLowerCase())))
  )
  const sortKey = ['orderNumber', 'supplier', 'createdDate', 'dueDate', 'overdueDays', 'remaining', 'owner', 'status'].includes(query.sort) ? query.sort : 'overdueDays'
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey]
    if (av === null || av === '') return bv === null || bv === '' ? a.id.localeCompare(b.id) : 1
    if (bv === null || bv === '') return -1
    const comparison = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return comparison * (query.direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id)
  })
  const pageSize = [15, 25, 50, 100].includes(Number(filters.pageSize)) ? Number(filters.pageSize) : 25
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pages, Math.max(1, Math.floor(Number(filters.page) || 1)))
  const currencies = [...new Set(rows.map(row => row.currency))].sort()
  const totals = currencies.map(currency => ({ currency, amount: sumKnown(rows.filter(row => row.currency === currency).map(row => row.amount)) }))
  const supplierCounts = new Map()
  for (const row of rows.filter(row => row.isOpen && row.overdueDays > 0)) supplierCounts.set(row.supplier, (supplierCounts.get(row.supplier) || 0) + 1)
  return {
    overdueSuppliers: [...supplierCounts].map(([supplier, count]) => ({ supplier, count })).sort((a, b) => b.count - a.count || a.supplier.localeCompare(b.supplier)).slice(0, 5),
    asOf, generatedAt: now.toISOString(), query, total, page, pageSize, pages,
    summary: { open: rows.filter(row => row.isOpen).length, overdue: rows.filter(row => row.isOpen && row.overdueDays > 0).length, incomplete: rows.filter(row => row.dataIncomplete).length, totals },
    suppliers: [...new Set(source.map(row => row.supplier).filter(Boolean))].sort(), currencies: [...new Set(source.map(row => row.currency).filter(Boolean))].sort(),
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    ...(filters.export === 'true' ? { exportRows: rows } : {}),
  }
}
