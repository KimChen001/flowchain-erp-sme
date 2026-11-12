// The figures the UCI walkthrough workspace's question set expects, worked out
// from the seed's own plan (scripts/public-data/plan.mjs, built from the local
// extract and the seed day), with the formulas written out here. Nothing is
// read from the assistant's tools or the running server, so a tool that
// computes wrongly fails its case.
//
// Plan shape (buildPublicDataPlan): days, seedDay, items [{ key, sku, name,
// price, supplierKey, daily, meanDaily, safetyStock, reorderPoint,
// minimumOrderQuantity }], suppliers [{ key, name, tier }], customers [{ key,
// name }], salesOrders [{ index, customerKey, lines: [{ itemKey, quantity,
// unitPrice }] }], purchasing { closing: { itemKey: onHand }, orders: [{
// created, promised, supplierKey, status, scene, lines: [{ itemKey, quantity
// }], receipts: [{ index, lines: [{ itemKey, quantity }] }] }] }. Day index i
// is the seed day plus (i - days); the last day of the data is the day before
// the seed day.
const DAY_MS = 86400000
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0)

export const UCI_HOLDING_RATE = 0.25
export const SCORECARD_PERIOD_DAYS = 90
// The recorded demand window of the assistant's stock tools.
export const DEMAND_WINDOW_DAYS = 90

// today: the workspace's date when the questions are asked (YYYY-MM-DD). The
// seed day by default; a server running a day before or after its seed day
// moves only the figures that count from today (late orders, the last 90
// days of deliveries).
export function uciFacts(plan, { today = plan.seedDay } = {}) {
  const seed = Date.parse(`${plan.seedDay}T00:00:00Z`)
  const dateOf = (index) => new Date(seed + (index - plan.days) * DAY_MS).toISOString().slice(0, 10)
  const todayIndex = plan.days + Math.round((Date.parse(`${today}T00:00:00Z`) - seed) / DAY_MS)
  const items = new Map(plan.items.map((item) => [item.key, item]))
  const bySku = new Map(plan.items.map((item) => [item.sku, item]))
  const suppliers = new Map(plan.suppliers.map((supplier) => [supplier.key, supplier]))
  const customers = new Map(plan.customers.map((customer) => [customer.key, customer]))
  const orders = plan.purchasing.orders
  const received = (order, key) => sum(order.receipts, (receipt) => sum(receipt.lines.filter((line) => line.itemKey === key), (line) => line.quantity))
  const ordered = (order, key) => sum(order.lines.filter((line) => line.itemKey === key), (line) => line.quantity)
  const outstanding = (order) => sum(order.lines, (line) => line.quantity - received(order, line.itemKey))
  // Open: issued and not fully received. An order waiting for approval is
  // not with the supplier yet.
  const open = orders.filter((order) => order.status === 'issued' && outstanding(order) > 0)
  const onOrder = (key) => sum(open, (order) => ordered(order, key) - received(order, key))

  const item = (sku) => {
    const row = bySku.get(sku)
    if (!row) throw new Error(`The plan has no item ${sku}.`)
    const onHand = plan.purchasing.closing[row.key]
    const incoming = onOrder(row.key)
    return {
      sku: row.sku,
      name: row.name,
      price: row.price,
      supplier: suppliers.get(row.supplierKey)?.name,
      onHand,
      onOrder: incoming,
      position: onHand + incoming,
      safetyStock: row.safetyStock,
      reorderPoint: row.reorderPoint,
      minimumOrderQuantity: row.minimumOrderQuantity,
      // Shipped a day over the 90 days before today, as the tools read it
      // (the seed's thresholds use the 90 days before the seed day: the same
      // window when the questions are asked on the seed day). 2026-11-11, a
      // day after the seed day: 6.6 a day for 22423, not the seed's 7.24.
      averageDailyDemand: recentDemand(row),
      daysOfStock: onHand / recentDemand(row),
    }
  }
  // Days after the data's last day shipped nothing.
  const recentDemand = (row) => {
    let shipped = 0
    for (let back = 1; back <= DEMAND_WINDOW_DAYS; back += 1) {
      const index = todayIndex - back
      if (index >= 0 && index < plan.days) shipped += Number(row.daily?.[index]) || 0
    }
    return row.daily ? shipped / DEMAND_WINDOW_DAYS : row.meanDaily
  }

  // Late: issued, promised before today, not fully received.
  const late = open.filter((order) => order.promised < todayIndex).map((order) => ({
    supplier: suppliers.get(order.supplierKey)?.name,
    promised: dateOf(order.promised),
    lines: order.lines.map((line) => ({ sku: items.get(line.itemKey).sku, ordered: line.quantity, received: received(order, line.itemKey), outstanding: line.quantity - received(order, line.itemKey) })),
  }))

  // Reorder: an item whose position (on hand + on order) is at or below its
  // reorder point gets the larger of its shortfall and its minimum order.
  const reorder = plan.items
    .map((row) => ({ row, position: plan.purchasing.closing[row.key] + onOrder(row.key) }))
    .filter(({ row, position }) => position <= row.reorderPoint)
    .map(({ row, position }) => ({ sku: row.sku, shortfall: row.reorderPoint - position, quantity: Math.max(row.reorderPoint - position, row.minimumOrderQuantity) }))
  const belowSafetyStock = plan.items.filter((row) => plan.purchasing.closing[row.key] < row.safetyStock).map((row) => row.sku)

  // Sales by calendar month (YYYY-MM): every line shipped in full on its
  // order's day, at its own price; line amounts in pence as the invoices hold
  // them.
  const lineAmount = (line) => round(line.quantity * line.unitPrice)
  const inMonth = (month) => plan.salesOrders.filter((order) => dateOf(order.index).startsWith(month))
  const month = (value) => {
    const rows = inMonth(value)
    const byItem = new Map()
    const byCustomer = new Map()
    for (const order of rows) {
      for (const line of order.lines) {
        const entry = byItem.get(line.itemKey) || { sku: items.get(line.itemKey).sku, units: 0, revenue: 0 }
        entry.units += line.quantity
        entry.revenue += lineAmount(line)
        byItem.set(line.itemKey, entry)
        const customer = byCustomer.get(order.customerKey) || { id: order.customerKey, name: customers.get(order.customerKey)?.name, revenue: 0, items: new Map() }
        customer.revenue += lineAmount(line)
        customer.items.set(line.itemKey, (customer.items.get(line.itemKey) || 0) + line.quantity)
        byCustomer.set(order.customerKey, customer)
      }
    }
    const itemRows = [...byItem.values()].map((row) => ({ ...row, revenue: round(row.revenue) }))
    const customerRows = [...byCustomer.values()].map((row) => {
      const [topKey, topUnits] = [...row.items].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]
      return { id: row.id, name: row.name, revenue: round(row.revenue), topItem: { sku: items.get(topKey).sku, units: topUnits } }
    })
    return {
      orders: rows.length,
      units: sum(itemRows, (row) => row.units),
      revenue: round(sum(itemRows, (row) => row.revenue)),
      unitsOf: (sku) => byItem.get(bySku.get(sku)?.key)?.units || 0,
      byUnits: [...itemRows].sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku)),
      byRevenue: [...itemRows].sort((a, b) => b.revenue - a.revenue || a.sku.localeCompare(b.sku)),
      customers: customerRows.sort((a, b) => b.revenue - a.revenue || String(a.id).localeCompare(String(b.id))),
    }
  }

  // Receivables: each shipment's invoice is due 30 days later and was paid
  // on its due date when that was before the seed day; the rest are open.
  const unpaid = plan.salesOrders.filter((order) => order.index + 30 >= plan.days)
  const owedBy = new Map()
  for (const order of unpaid) owedBy.set(order.customerKey, (owedBy.get(order.customerKey) || 0) + sum(order.lines, lineAmount))
  const receivables = {
    invoices: unpaid.length,
    total: round(sum(unpaid, (order) => sum(order.lines, lineAmount))),
    largest: [...owedBy].map(([id, amount]) => ({ id, name: customers.get(id)?.name, amount: round(amount) })).sort((a, b) => b.amount - a.amount || String(a.id).localeCompare(String(b.id)))[0],
  }

  // Stock at the purchase price (the public selling price, assumed), and a
  // year of holding it at 25%.
  const stockValue = round(sum(plan.items, (row) => plan.purchasing.closing[row.key] * row.price))
  const inventory = { value: stockValue, holdingPerYear: round(stockValue * UCI_HOLDING_RATE) }

  // On-time deliveries (the supplier scorecard's rule): a delivery is an
  // issued order's lines with one promised date in the last 90 days up to
  // today; it is on time when every line's first receipt is on or before
  // that date, late when one came after or nothing came and the date has
  // passed, and not judged yet when nothing came and the date is today or
  // later.
  const onTime = (supplierName) => {
    const supplier = plan.suppliers.find((row) => row.name === supplierName)
    const from = todayIndex - (SCORECARD_PERIOD_DAYS - 1)
    let judged = 0
    let kept = 0
    for (const order of orders) {
      if (order.supplierKey !== supplier.key || order.status !== 'issued') continue
      if (order.promised < from || order.promised > todayIndex) continue
      const firstReceipt = order.receipts.length ? Math.min(...order.receipts.map((receipt) => receipt.index)) : null
      if (firstReceipt === null && order.promised >= todayIndex) continue
      judged += 1
      if (firstReceipt !== null && firstReceipt <= order.promised) kept += 1
    }
    return { judged, onTime: kept, percent: judged ? round((100 * kept) / judged, 1) : null }
  }

  const suppliedBy = (supplierName) => {
    const supplier = plan.suppliers.find((row) => row.name === supplierName)
    return plan.items.filter((row) => row.supplierKey === supplier.key).map((row) => row.sku)
  }
  const lastReceipt = (sku) => {
    const key = bySku.get(sku).key
    let latest = null
    for (const order of orders) for (const receipt of order.receipts) {
      const quantity = sum(receipt.lines.filter((line) => line.itemKey === key), (line) => line.quantity)
      if (quantity > 0 && (!latest || receipt.index > latest.index)) latest = { index: receipt.index, quantity }
    }
    return latest && { date: dateOf(latest.index), quantity: latest.quantity }
  }
  const waitingForApproval = orders.filter((order) => order.status === 'pending_approval').map((order) => ({
    supplier: suppliers.get(order.supplierKey)?.name,
    lines: order.lines.map((line) => ({ sku: items.get(line.itemKey).sku, quantity: line.quantity, amount: round(line.quantity * items.get(line.itemKey).price) })),
  }))

  return {
    today,
    seedDay: plan.seedDay,
    item,
    late,
    reorder,
    belowSafetyStock,
    month,
    receivables,
    inventory,
    onTime,
    suppliedBy,
    lastReceipt,
    waitingForApproval,
    supplierCount: plan.suppliers.length,
    // Every item's SKU in the plan's order, and its unit price and minimum
    // order by SKU, for the constraint cases' form checks (an object lists
    // integer-like keys such as 16014 first, so pick from skus).
    skus: plan.items.map((row) => row.sku),
    prices: Object.fromEntries(plan.items.map((row) => [row.sku, row.price])),
    minimums: Object.fromEntries(plan.items.map((row) => [row.sku, row.minimumOrderQuantity])),
    scene: plan.scene,
    holdingRate: UCI_HOLDING_RATE,
  }
}

// The textbook figures for one item (yearly demand from the 90-day average,
// holding cost a unit a year at 25% of the price): the economic order
// quantity at a cost per order (never below the minimum order), and the cost
// per order at which two order sizes cost the same a year.
export function uciEconomics(row, holdingRate = UCI_HOLDING_RATE) {
  const annual = row.averageDailyDemand * 365
  const holding = row.price * holdingRate
  return {
    annual,
    holding,
    eoq: (costPerOrder) => Math.max(row.minimumOrderQuantity, Math.round(Math.sqrt((2 * annual * costPerOrder) / holding))),
    breakEven: (smaller, larger) => (holding * smaller * larger) / (2 * annual),
  }
}
