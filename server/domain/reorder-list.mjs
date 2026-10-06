import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay } from './tenant-calendar-day.mjs'

// The reorder list: the items to order, ranked by the day each one's stock
// position is expected to reach its recorded reorder point, so a buyer orders
// on time. Rules only, from recorded data; nothing is ordered here. A person
// opens a prefilled purchase request from a row and submits it.
//
//   stock position   on hand - reserved + incoming, for one item in its stock
//                    unit, over the reader's warehouses (all of them for a
//                    workspace-wide reader). Transfers are not considered.
//   incoming         the remaining quantity of committed purchase order lines
//                    in the item's stock unit (the allocation model's
//                    incomingLines). A line due after the order-by day is left
//                    out, and the day computed again until it stops moving.
//   reorder point    the item's recorded reorder point only. Missing or 0 is
//                    "not recorded", and the item is not judged.
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
export function dailyDemand({ lines = [], stockUnit = '', today, timeZone = DEFAULT_TENANT_TIMEZONE }) {
  const windowStart = addCalendarDays(today, -DEMAND_WINDOW_DAYS)
  const windowEnd = addCalendarDays(today, -1)
  const days = new Set()
  const otherUnits = new Map()
  let shippedUnits = 0
  let unitNotRecorded = 0
  for (const line of rows(lines)) {
    const day = instantCalendarDay(line.postedAt, timeZone)
    const shipped = quantity(line.quantity)
    if (!day || day < windowStart || day > windowEnd || shipped === null || shipped <= 0) continue
    const unit = text(line.unit)
    if (unit && stockUnit && !sameUnit(unit, stockUnit)) {
      otherUnits.set(unit, (otherUnits.get(unit) || 0) + 1)
      continue
    }
    if (!unit || !stockUnit) unitNotRecorded += 1
    shippedUnits += toUnits(shipped)
    days.add(day)
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
    unitNotRecorded,
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
export function preferredSupplierFor(item, links = [], suppliersById = new Map()) {
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
  }
}

// One item's row, or { notJudged } / null (not listed).
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
    ...(stockUnit ? [] : [{ code: 'stock_unit_not_recorded' }]),
  ]
  const position = fromUnits(result.positionUnits)
  const shortfall = fromUnits(Math.max(0, reorderPointUnits - result.positionUnits))
  // The purchase request line is in the item's purchase unit; the shortfall is
  // in its stock unit. When they differ (or either is unknown) the person
  // enters the quantity.
  const purchaseUnit = text(metadataOf(item).purchaseUnit) || stockUnit
  const purchaseUnitDiffers = Boolean(stockUnit) && !sameUnit(purchaseUnit, stockUnit)
  if (purchaseUnitDiffers) flags.push({ code: 'purchase_unit_differs', unit: purchaseUnit })
  return {
    row: {
      ...base,
      unit: stockUnit || null,
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
        // Only a shortfall in the unit the request line will use.
        quantity: shortfall > 0 && stockUnit && !purchaseUnitDiffers ? shortfall : null,
      },
    },
  }
}

// allocationRows: the runtime allocation model's availability rows.
// items: Item rows as stored (id, sku, name, unit, reorderPoint, metadata,
// preferredSupplierId, status). shipmentLines: { itemId, unit, quantity,
// postedAt } of posted shipments, quantities already limited to the reader's
// warehouses. supplierLinks: item-supplier records as stored ({ id, payload }).
// scope.warehouseIds: null for every warehouse, else the reader's.
export function buildReorderList({ allocationRows = [], items = [], shipmentLines = [], supplierLinks = [], suppliers = [], today, timeZone = DEFAULT_TENANT_TIMEZONE, scope = {}, showPurchaseOrders = true } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(today))) throw new Error('A workspace calendar day is required.')
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
  let noReorderPoint = 0
  let aboveReorderPointWithoutHistory = 0
  for (const item of rows(items).filter(isActiveItem)) {
    const reorderPoint = recordedReorderPoint(item)
    if (reorderPoint === null) { noReorderPoint += 1; continue }
    const stockUnit = itemStockUnit(item)
    const allocation = allocationBySku.get(text(item.sku))
    const demand = dailyDemand({ lines: linesByItem.get(text(item.id)), stockUnit, today, timeZone })
    const supplier = preferredSupplierFor(item, supplierLinks, suppliersById)
    const judged = judgeItem({ item, allocation, demand, reorderPoint, stockUnit, today, showPurchaseOrders, supplier })
    if (judged.row) listed.push(judged.row)
    else if (judged.notJudged) notJudged.push(judged.notJudged)
    else if (judged.aboveReorderPointWithoutHistory) aboveReorderPointWithoutHistory += 1
  }
  const bySku = (a, b) => a.sku.localeCompare(b.sku, 'en')
  listed.sort((a, b) => (a.orderByDate < b.orderByDate ? -1 : a.orderByDate > b.orderByDate ? 1 : bySku(a, b)))
  notJudged.sort(bySku)

  const supplierOptions = new Map()
  for (const row of listed) if (row.supplier) supplierOptions.set(row.supplier.id, { id: row.supplier.id, code: row.supplier.code, name: row.supplier.name })
  const warehouseIds = Array.isArray(scope.warehouseIds) ? scope.warehouseIds : null
  return {
    today,
    timeZone,
    scope: warehouseIds ? { kind: 'reader_warehouses', warehouseCount: warehouseIds.length } : { kind: 'all_warehouses', warehouseCount: null },
    rule: { windowDays: DEMAND_WINDOW_DAYS, minShipmentDays: MIN_SHIPMENT_DAYS },
    rows: listed,
    notJudged,
    noReorderPoint: { count: noReorderPoint, href: '/app/master-data/items' },
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
