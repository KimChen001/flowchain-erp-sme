import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay } from './tenant-calendar-day.mjs'

// The reorder list: the items to order, ranked by the day each one's stock
// position is expected to reach its recorded reorder point, so a buyer orders
// on time. Rules only, from recorded data; nothing is ordered here. A person
// opens a prefilled purchase request from a row and submits it.
//
//   stock position   on hand - reserved + incoming, for one item in its stock
//                    unit, over every warehouse. Transfers are not considered.
//                    The recorded reorder point is one figure for the whole
//                    item, so a reader who sees only some warehouses gets the
//                    items listed as not checked, never a part of the stock
//                    (with incoming for every warehouse) set against it.
//   incoming         the remaining quantity of committed purchase order lines
//                    in the item's stock unit (the allocation model's
//                    incomingLines). A line due after the order-by day is left
//                    out, and the day computed again until it stops moving.
//   reorder point    the item's recorded reorder point only. Missing or 0 is
//                    "not recorded", and the item is not checked.
//   stock unit       the unit recorded on the item. Without one the item is
//                    not checked: quantities in different units are never added.
//   daily demand     shipped quantity in the stock unit on posted shipments over
//                    the 90 workspace days before today, divided by 90, only
//                    when there were at least 8 shipment days.
//   order-by day     today + floor((position - reorder point) / daily demand)
//                    days, never before today; at or below the reorder point it
//                    is today ("order now"). Without daily demand an item is
//                    listed only when it is at or below its reorder point.
//
// Rows rank by order-by day, then SKU. No scores, and quantities are never
// added across items.

export const DEMAND_WINDOW_DAYS = 90
export const MIN_SHIPMENT_DAYS = 8

const rows = (value) => (Array.isArray(value) ? value : [])
const text = (value) => String(value ?? '').trim()
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const quantity = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
// Quantities are stored with four decimals; sums and comparisons run on whole
// ten-thousandths so 0.1 + 0.2 is 0.3.
const SCALE = 10000
const toUnits = (value) => Math.round(value * SCALE)
const fromUnits = (units) => units / SCALE
const sameUnit = (a, b) => a.toLowerCase() === b.toLowerCase()
const metadataOf = (item) => (isObject(item?.metadata) ? item.metadata : {})

// The reorder point someone recorded on the item: the column, then the legacy
// metadata value. Missing, 0 or negative is not a reorder point (the item form
// saves 0 for an empty field). Never a default from safety stock.
export function recordedReorderPoint(item) {
  const value = quantity(item?.reorderPoint ?? metadataOf(item).reorderPoint)
  return value !== null && value > 0 ? value : null
}

// The unit the item's stock is kept in, as recorded; '' when none is.
export function itemStockUnit(item) {
  const meta = metadataOf(item)
  return text(item?.unit || meta.baseUom || meta.uom)
}

const isActiveItem = (item) => text(item?.status || 'active') === 'active' && metadataOf(item).inventoryItem !== false

// Daily demand from posted shipment lines: { itemId, unit, quantity, postedAt }.
// A line in another unit than the stock unit is never added. Without a stock
// unit, lines in more than one unit are never added to each other either:
// there is then no daily demand.
export function dailyDemand({ lines = [], stockUnit = '', today, timeZone = DEFAULT_TENANT_TIMEZONE }) {
  const windowStart = addCalendarDays(today, -DEMAND_WINDOW_DAYS)
  const windowEnd = addCalendarDays(today, -1)
  const inWindow = []
  for (const line of rows(lines)) {
    const day = instantCalendarDay(line.postedAt, timeZone)
    const shipped = quantity(line.quantity)
    if (!day || day < windowStart || day > windowEnd || shipped === null || shipped <= 0) continue
    inWindow.push({ day, shipped, unit: text(line.unit) })
  }
  const lineUnits = new Map()
  for (const line of inWindow) if (line.unit && !lineUnits.has(line.unit.toLowerCase())) lineUnits.set(line.unit.toLowerCase(), line.unit)
  const unitsMixed = !stockUnit && lineUnits.size > 1
  const days = new Set()
  const otherUnits = new Map()
  let shippedUnits = 0
  let unitNotRecorded = 0
  for (const line of inWindow) {
    if (line.unit && stockUnit && !sameUnit(line.unit, stockUnit)) {
      otherUnits.set(line.unit, (otherUnits.get(line.unit) || 0) + 1)
      continue
    }
    if (!line.unit) unitNotRecorded += 1
    if (unitsMixed) continue
    shippedUnits += toUnits(line.shipped)
    days.add(line.day)
  }
  const enough = days.size >= MIN_SHIPMENT_DAYS && shippedUnits > 0
  return {
    windowStart,
    windowEnd,
    windowDays: DEMAND_WINDOW_DAYS,
    shipmentDays: days.size,
    shippedQuantity: fromUnits(shippedUnits),
    // Shown to four decimals; the order-by day uses the exact shipped total.
    averageDailyDemand: enough ? Math.round((shippedUnits / DEMAND_WINDOW_DAYS)) / SCALE : null,
    shippedUnits: enough ? shippedUnits : null,
    otherUnits: [...otherUnits.entries()].map(([unit, lineCount]) => ({ unit, lineCount })),
    // Lines that record no unit, counted in the stock unit.
    unitNotRecorded,
    // Without a stock unit: the units the lines are in, none of them added.
    unitsMixed: unitsMixed ? [...lineUnits.values()] : [],
  }
}

// The order-by day for a position and reorder point (whole ten-thousandths).
// floor((position - reorder point) / (shipped / 90)) is computed as
// floor((position - reorder point) * 90 / shipped), so no rounded rate moves it.
export function orderByDay({ positionUnits, reorderPointUnits, shippedUnits, today }) {
  if (positionUnits <= reorderPointUnits) return { orderByDate: today, orderNow: true, daysUntilOrderBy: 0 }
  if (!shippedUnits) return null
  const days = Math.floor(((positionUnits - reorderPointUnits) * DEMAND_WINDOW_DAYS) / shippedUnits)
  return { orderByDate: addCalendarDays(today, days), orderNow: false, daysUntilOrderBy: days }
}

// The preferred source of an item: the active, approved item-supplier link
// marked preferred, else the one for the item's preferred supplier, with an
// active supplier. Lead time and minimum order quantity only when recorded on
// the link (mapItemSupplierRecord turns a missing value into 0 or 1).
export function preferredSupplierFor(item, links = [], suppliersById = new Map(), { moqUnit = null } = {}) {
  const usable = rows(links).filter((row) => {
    const payload = isObject(row?.payload) ? row.payload : {}
    return text(payload.itemId) === text(item.id) && payload.active !== false && payload.approved !== false
  })
  const link = usable.find((row) => Boolean(row.payload.preferred))
    || (text(item.preferredSupplierId) ? usable.find((row) => text(row.payload.supplierId) === text(item.preferredSupplierId)) : undefined)
  if (!link) return null
  const supplier = suppliersById.get(text(link.payload.supplierId))
  if (!supplier || text(supplier.status || 'active') !== 'active') return null
  const recorded = (key) => {
    const value = quantity(link.payload[key])
    return value === null || value < 0 ? null : value
  }
  return {
    id: text(supplier.id),
    code: text(supplier.code),
    name: text(supplier.name || supplier.id),
    leadTimeDays: recorded('leadTimeDays'),
    minimumOrderQuantity: recorded('minimumOrderQuantity') || null,
    // The minimum order quantity is in the unit the item is bought in.
    moqUnit: text(moqUnit) || null,
  }
}

const purchaseUnitOf = (item, stockUnit) => text(metadataOf(item).purchaseUnit) || stockUnit

// One item's row, or { notJudged } / null (not listed). stockUnit is recorded.
function judgeItem({ item, allocation, demand, reorderPoint, stockUnit, today, showPurchaseOrders, supplier }) {
  const base = { itemId: text(item.id), sku: text(item.sku), itemName: text(item.name || item.sku) }
  const onHand = quantity(allocation?.onHand)
  const reserved = quantity(allocation?.reserved)
  const lines = rows(allocation?.incomingLines)
  if (!allocation || onHand === null || reserved === null || lines.some((line) => quantity(line.remaining) === null)) {
    return { notJudged: { ...base, reason: 'stock_incomplete' } }
  }
  const poRef = (line) => (showPurchaseOrders ? text(line.orderNumber || line.purchaseOrderId) || null : null)
  const reorderPointUnits = toUnits(reorderPoint)
  const stockUnits = toUnits(onHand) - toUnits(reserved)
  let counted = lines
  let result
  for (;;) {
    const positionUnits = stockUnits + counted.reduce((sum, line) => sum + toUnits(Number(line.remaining)), 0)
    result = orderByDay({ positionUnits, reorderPointUnits, shippedUnits: demand.shippedUnits, today })
    if (!result) return { aboveReorderPointWithoutHistory: true }
    result.positionUnits = positionUnits
    if (demand.shippedUnits === null) break
    // The order-by day can only move earlier as lines drop out, so this ends
    // within as many rounds as there are lines.
    const kept = counted.filter((line) => !line.dueDay || line.dueDay <= result.orderByDate)
    if (kept.length === counted.length) break
    counted = kept
  }
  const countedIds = new Set(counted.map((line) => line.lineId))
  const flags = [
    ...rows(allocation.incomingExcluded).map((line) => ({ code: 'po_line_other_unit', orderNumber: poRef(line), unit: text(line.unit) })),
    ...lines.filter((line) => !countedIds.has(line.lineId)).map((line) => ({ code: 'po_line_due_after_order_by', orderNumber: poRef(line), dueDay: line.dueDay })),
    ...counted.filter((line) => !line.dueDay).map((line) => ({ code: 'po_line_no_due_day', orderNumber: poRef(line) })),
    ...(rows(allocation.dataLimitations).some((code) => String(code).startsWith('po_line_unit_not_recorded:')) ? [{ code: 'po_line_unit_not_recorded' }] : []),
    ...(demand.shippedUnits === null && lines.length ? [{ code: 'all_incoming_counted' }] : []),
    ...demand.otherUnits.map((entry) => ({ code: 'shipment_other_unit', unit: entry.unit, count: entry.lineCount })),
    ...(demand.unitNotRecorded ? [{ code: 'shipment_unit_not_recorded', count: demand.unitNotRecorded }] : []),
  ]
  const position = fromUnits(result.positionUnits)
  const shortfall = fromUnits(Math.max(0, reorderPointUnits - result.positionUnits))
  // The purchase request line is in the item's purchase unit; the shortfall is
  // in its stock unit. When they differ (or either is unknown) the person
  // enters the quantity.
  const purchaseUnit = purchaseUnitOf(item, stockUnit)
  const purchaseUnitDiffers = !sameUnit(purchaseUnit, stockUnit)
  if (purchaseUnitDiffers) flags.push({ code: 'purchase_unit_differs', unit: purchaseUnit })
  // A request below the supplier's minimum order would be refused or rounded
  // up by the supplier, so the request asks for at least the minimum. The
  // shortfall itself is shown as computed.
  const minimum = Number(supplier?.minimumOrderQuantity) > 0 ? Number(supplier.minimumOrderQuantity) : 0
  const requestQuantity = shortfall > 0 && !purchaseUnitDiffers ? Math.max(shortfall, minimum) : null
  return {
    row: {
      ...base,
      unit: stockUnit,
      orderByDate: result.orderByDate,
      orderNow: result.orderNow,
      daysUntilOrderBy: result.daysUntilOrderBy,
      onHand,
      reserved,
      incoming: fromUnits(counted.reduce((sum, line) => sum + toUnits(Number(line.remaining)), 0)),
      incomingLines: lines.map((line) => ({ orderNumber: poRef(line), remaining: Number(line.remaining), dueDay: line.dueDay || null, counted: countedIds.has(line.lineId) })),
      position,
      reorderPoint,
      shortfall,
      demand: {
        averageDailyDemand: demand.averageDailyDemand,
        shipmentDays: demand.shipmentDays,
        shippedQuantity: demand.shippedQuantity,
        windowDays: demand.windowDays,
        windowStart: demand.windowStart,
        windowEnd: demand.windowEnd,
        enough: demand.shippedUnits !== null,
      },
      supplier,
      flags,
      purchaseRequest: {
        itemId: base.itemId,
        supplierId: supplier?.id || null,
        // Only a shortfall in the unit the request line will use; otherwise
        // the form opens with the quantity empty for the person to enter.
        quantity: requestQuantity,
        raisedToMinimum: requestQuantity !== null && minimum > shortfall,
      },
    },
  }
}

// How many items without a reorder point the response names, for links.
export const NO_REORDER_POINT_LISTED = 50

// allocationRows: the runtime allocation model's availability rows, over every
// warehouse. items: Item rows as stored (id, sku, name, unit, reorderPoint,
// metadata, preferredSupplierId, status). shipmentLines: { itemId, unit,
// quantity, postedAt } of posted shipments. supplierLinks: item-supplier
// records as stored ({ id, payload }). scope.warehouseIds: null for a reader
// of every warehouse, else the reader's; scope.totalWarehouses: how many the
// workspace has.
export function buildReorderList({ allocationRows = [], items = [], shipmentLines = [], supplierLinks = [], suppliers = [], today, timeZone = DEFAULT_TENANT_TIMEZONE, scope = {}, showPurchaseOrders = true } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(today))) throw new Error('A workspace calendar day is required.')
  const warehouseIds = Array.isArray(scope.warehouseIds) ? scope.warehouseIds : null
  const allocationBySku = new Map()
  for (const row of rows(allocationRows)) {
    if (text(row.sku)) allocationBySku.set(text(row.sku), row)
  }
  const suppliersById = new Map(rows(suppliers).map((row) => [text(row.id), row]))
  const linesByItem = new Map()
  for (const line of rows(shipmentLines)) {
    const key = text(line.itemId)
    if (!linesByItem.has(key)) linesByItem.set(key, [])
    linesByItem.get(key).push(line)
  }

  const listed = []
  const notJudged = []
  const noReorderPointItems = []
  let noReorderPoint = 0
  let aboveReorderPointWithoutHistory = 0
  for (const item of rows(items).filter(isActiveItem)) {
    const base = { itemId: text(item.id), sku: text(item.sku), itemName: text(item.name || item.sku) }
    const reorderPoint = recordedReorderPoint(item)
    if (reorderPoint === null) {
      noReorderPoint += 1
      noReorderPointItems.push(base)
      continue
    }
    // The reorder point covers every warehouse; a part of them is never set against it.
    if (warehouseIds) { notJudged.push({ ...base, reason: 'warehouse_scope' }); continue }
    const stockUnit = itemStockUnit(item)
    if (!stockUnit) { notJudged.push({ ...base, reason: 'stock_unit_not_recorded' }); continue }
    const allocation = allocationBySku.get(text(item.sku))
    const demand = dailyDemand({ lines: linesByItem.get(text(item.id)), stockUnit, today, timeZone })
    const supplier = preferredSupplierFor(item, supplierLinks, suppliersById, { moqUnit: purchaseUnitOf(item, stockUnit) })
    const judged = judgeItem({ item, allocation, demand, reorderPoint, stockUnit, today, showPurchaseOrders, supplier })
    if (judged.row) listed.push(judged.row)
    else if (judged.notJudged) notJudged.push(judged.notJudged)
    else if (judged.aboveReorderPointWithoutHistory) aboveReorderPointWithoutHistory += 1
  }
  const bySku = (a, b) => a.sku.localeCompare(b.sku, 'en')
  listed.sort((a, b) => (a.orderByDate < b.orderByDate ? -1 : a.orderByDate > b.orderByDate ? 1 : bySku(a, b)))
  notJudged.sort(bySku)
  noReorderPointItems.sort(bySku)

  const supplierOptions = new Map()
  for (const row of listed) if (row.supplier) supplierOptions.set(row.supplier.id, { id: row.supplier.id, code: row.supplier.code, name: row.supplier.name })
  const totalWarehouseCount = Number.isInteger(scope.totalWarehouses) ? scope.totalWarehouses : null
  return {
    today,
    timeZone,
    scope: warehouseIds
      ? { kind: 'reader_warehouses', warehouseCount: warehouseIds.length, totalWarehouseCount }
      : { kind: 'all_warehouses', warehouseCount: null, totalWarehouseCount },
    rule: { windowDays: DEMAND_WINDOW_DAYS, minShipmentDays: MIN_SHIPMENT_DAYS },
    rows: listed,
    notJudged,
    // The items to set a reorder point on, each to link to its record: the
    // first NO_REORDER_POINT_LISTED by SKU.
    noReorderPoint: { count: noReorderPoint, href: '/app/master-data/items', items: noReorderPointItems.slice(0, NO_REORDER_POINT_LISTED) },
    summary: {
      listed: listed.length,
      orderNow: listed.filter((row) => row.orderNow).length,
      notJudged: notJudged.length,
      noReorderPoint,
      aboveReorderPointWithoutHistory,
    },
    suppliers: [...supplierOptions.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')),
  }
}
