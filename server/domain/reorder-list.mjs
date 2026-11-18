import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { OPEN_PURCHASE_REQUEST_STATUSES, inventoryPosition, orderUpToLevel, requestLineCountsFor, suggestPurchaseQuantity } from '../../shared/purchase-suggestion.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay } from './tenant-calendar-day.mjs'

// The reorder list: the items to order, ranked by the day each one's stock
// position is expected to reach its recorded reorder point, so a buyer orders
// on time. Rules only, from recorded data; nothing is ordered here. A person
// opens a prefilled purchase request from a row and submits it.
//
//   stock position   the inventory position of shared/purchase-suggestion.mjs,
//                    for one item in its stock unit, over every warehouse:
//                    on hand - reserved + incoming + pending purchase orders
//                    (draft or pending approval) + open purchase requests
//                    (draft, submitted or approved) - backorders (open sales
//                    demand no reservation covers). Transfers are not
//                    considered. The assistant's suggestions use the same
//                    position and quantity rule (design audit C2).
//                    The recorded reorder point is one figure for the whole
//                    item, so a reader who sees only some warehouses gets the
//                    items listed as not checked, never a part of the stock
//                    (with incoming for every warehouse) set against it.
//   incoming         the remaining quantity of every committed purchase order
//                    line in the item's stock unit (the allocation model's
//                    incomingLines), whatever its due day: the inventory
//                    position of a reorder point policy. A line past its due
//                    day still counts and is flagged late, for the buyer to
//                    confirm with the supplier; so is one with no due day.
//   reorder point    the item's recorded reorder point only. Missing or 0 is
//                    "not recorded", and the item is not checked.
//   stock unit       the unit recorded on the item. Without one the item is
//                    not checked: quantities in different units are never added.
//   daily demand     shipped quantity in the stock unit on posted shipments over
//                    the 90 workspace days before today, divided by 90, only
//                    when there were at least 8 shipment days.
//   order-by day     today + floor((position - reorder point) / daily demand)
//                    days, never before today; at or below the reorder point it
//                    is today. Without daily demand an item is listed only when
//                    it is at or below its reorder point.
//   order-up-to      the (s, S) rule's level (design audit C3): the item's
//                    recorded order-up-to level, else assumed to be the reorder
//                    point plus 7 days of average daily demand, else the
//                    reorder point; marked recorded or assumed.
//   order now        an order is due today (at or below the reorder point, or
//                    an order-by day of today) and the shared rule has a
//                    quantity for it: the level less the position, rounded up
//                    to the item's lot size and raised to the supplier's
//                    minimum. Ordering it lifts the position to the level, so
//                    the row leaves "order now" (V-A-01), and a row due today
//                    always has a quantity (W-02). Due today with nothing to
//                    order (a recorded level already reached) is due tomorrow.
//   lead time, MOQ   the preferred supplier link's, else the item's own when
//                    one is recorded there (more than 0), marked as the item's
//                    (design audit L3-08).
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

// An item the reorder list considers: active, and kept in stock.
export const isActiveItem = (item) => text(item?.status || 'active') === 'active' && metadataOf(item).inventoryItem !== false

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

// Shipped quantity per workspace day (days: the window's days, oldest
// first), from posted shipment
// lines ({ unit, quantity, postedAt }), added as the reorder list's daily
// demand adds it: a line in another unit than the stock unit is counted apart
// and never added, and without a stock unit, lines in more than one unit are
// not added to each other at all (unitsMixed lists their units).
export function shippedByWorkspaceDay({ lines = [], stockUnit = '', days = [], timeZone = DEFAULT_TENANT_TIMEZONE }) {
  const byDay = new Map(days.map((day) => [day, 0]))
  const inWindow = lines.filter((line) => byDay.has(instantCalendarDay(line.postedAt, timeZone)))
  const lineUnits = [...new Map(inWindow.filter((line) => text(line.unit)).map((line) => [text(line.unit).toLowerCase(), text(line.unit)])).values()]
  const unitsMixed = !text(stockUnit) && lineUnits.length > 1 ? lineUnits : []
  let otherUnitLines = 0
  for (const line of inWindow) {
    if (text(line.unit) && text(stockUnit) && !sameUnit(text(line.unit), text(stockUnit))) { otherUnitLines += 1; continue }
    if (unitsMixed.length) continue
    const day = instantCalendarDay(line.postedAt, timeZone)
    byDay.set(day, Math.round((byDay.get(day) + Number(line.quantity)) * SCALE) / SCALE)
  }
  return { byDay, otherUnitLines, unitsMixed }
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

// The (s, S) sizing of one item with a recorded reorder point, shared by the
// reorder list and the assistant's suggest_purchase_lines so both give the
// same level, quantity and due day for the same records (design audit C3).
// demand as dailyDemand gives it (null: none read); position and stock as
// inventoryPosition gives them; minimum the supplier's, in the stock unit.
// dated: orderByDay's answer (null: above the point with no demand to date
// it by); level: orderUpToLevel's; sized: suggestPurchaseQuantity's.
export function reorderSizing({ item, reorderPoint, demand, position, stock, minimum, today }) {
  const dated = orderByDay({ positionUnits: toUnits(position), reorderPointUnits: toUnits(reorderPoint), shippedUnits: demand?.shippedUnits ?? null, today })
  const level = orderUpToLevel({ reorderPoint, recorded: quantity(item?.orderUpToLevel), averageDailyDemand: demand?.averageDailyDemand ?? null })
  const lotSize = quantity(item?.lotSize) > 0 ? quantity(item.lotSize) : null
  const dueToday = Boolean(dated) && !dated.orderNow && dated.daysUntilOrderBy === 0
  const sized = suggestPurchaseQuantity({ reorderPoint, orderUpTo: level.level, lotSize, position, stock, dueToday, minimum })
  return { dated, level, lotSize, sized }
}

// The preferred source of an item: the active, approved item-supplier link
// marked preferred, else the one for the item's preferred supplier, with an
// active supplier. Lead time and minimum order quantity only when recorded on
// the link (mapItemSupplierRecord turns a missing value into 0 or 1).
// The lead time and minimum order recorded on the item itself (the item
// form), or null: 0 and empty are not recorded (an empty number used to be
// saved as 0, and a lead time of 0 would size a reorder point on a week).
export function itemPlanningValues(item) {
  const meta = metadataOf(item)
  const recorded = (...values) => {
    for (const value of values) {
      const number = quantity(value)
      if (number !== null && number > 0) return number
    }
    return null
  }
  return {
    leadTimeDays: recorded(meta.purchaseLeadTimeDays, meta.leadTimeDays, meta.leadTime),
    minimumOrderQuantity: recorded(meta.minimumOrderQuantity, meta.moq),
  }
}

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
  // The link's values first; the item's own when the link records none.
  const own = itemPlanningValues(item)
  const leadTime = recorded('leadTimeDays')
  const moq = recorded('minimumOrderQuantity') || null
  return {
    id: text(supplier.id),
    code: text(supplier.code),
    name: text(supplier.name || supplier.id),
    leadTimeDays: leadTime ?? own.leadTimeDays,
    leadTimeFrom: leadTime !== null ? 'supplier' : own.leadTimeDays !== null ? 'item' : null,
    minimumOrderQuantity: moq ?? own.minimumOrderQuantity,
    moqFrom: moq !== null ? 'supplier' : own.minimumOrderQuantity !== null ? 'item' : null,
    // The minimum order quantity is in the unit the item is bought in.
    moqUnit: text(moqUnit) || null,
  }
}

const purchaseUnitOf = (item, stockUnit) => text(metadataOf(item).purchaseUnit) || stockUnit

// The supplier's minimum order that a purchase request for this item asks for
// at least, or 0. It counts only when the item is bought in its stock unit,
// since the minimum is in the unit the item is bought in. One rule for the
// reorder list and the assistant's order suggestions (ai-skill-readers.mjs).
export function requestMinimumOf(item, supplier, stockUnit) {
  if (!boughtInStockUnit(item, stockUnit)) return 0
  if (Number(supplier?.minimumOrderQuantity) > 0) return Number(supplier.minimumOrderQuantity)
  return Number(itemPlanningValues(item).minimumOrderQuantity) || 0
}

// The open purchase requests of an item in its stock unit: their quantity,
// the requests (number and status, for a reader who may see them) and how
// many lines are in another unit, never added. lines: { itemId, sku,
// quantity, unit, request: { id, number, status } }.
export function openRequestsFor(lines, { itemId, sku, unit }, { showDocuments = true } = {}) {
  let quantityUnits = 0
  let otherUnitLines = 0
  const documents = new Map()
  for (const line of rows(lines)) {
    if (!OPEN_PURCHASE_REQUEST_STATUSES.includes(text(line.request?.status))) continue
    const same = (text(itemId) && text(line.itemId) === text(itemId)) || (text(sku) && text(line.sku) === text(sku))
    if (!same) continue
    if (!requestLineCountsFor(line, { itemId, sku, unit })) { otherUnitLines += 1; continue }
    quantityUnits += toUnits(Number(quantity(line.quantity) || 0))
    const id = text(line.request?.id)
    if (showDocuments && id && !documents.has(id)) documents.set(id, { number: text(line.request.number) || id, status: text(line.request.status) })
  }
  return { quantity: fromUnits(quantityUnits), documents: [...documents.values()], otherUnitLines }
}

// Whether the item is bought in its stock unit, so a supplier's minimum order
// and reference price are per stock unit (the assistant's cost figures use it).
export const boughtInStockUnit = (item, stockUnit) => Boolean(text(stockUnit)) && sameUnit(purchaseUnitOf(item, stockUnit), stockUnit)

// One item's row, or { notJudged } / null (not listed). stockUnit is recorded.
function judgeItem({ item, allocation, demand, reorderPoint, stockUnit, today, showPurchaseOrders, supplier, requests }) {
  const base = { itemId: text(item.id), sku: text(item.sku), itemName: text(item.name || item.sku) }
  const onHand = quantity(allocation?.onHand)
  const reserved = quantity(allocation?.reserved)
  const lines = rows(allocation?.incomingLines)
  // Backorders: open sales demand no reservation covers yet (0 when the row
  // says nothing of demand); pending: draft and pending-approval orders.
  const backorders = allocation?.unreservedSalesDemand === undefined ? 0 : quantity(allocation.unreservedSalesDemand)
  const pending = allocation?.pendingPurchaseQty === undefined ? 0 : quantity(allocation.pendingPurchaseQty)
  if (!allocation || onHand === null || reserved === null || backorders === null || pending === null || lines.some((line) => quantity(line.remaining) === null)) {
    return { notJudged: { ...base, reason: 'stock_incomplete' } }
  }
  const poRef = (line) => (showPurchaseOrders ? text(line.orderNumber || line.purchaseOrderId) || null : null)
  const reorderPointUnits = toUnits(reorderPoint)
  const incomingUnits = lines.reduce((sum, line) => sum + toUnits(Number(line.remaining)), 0)
  const parts = inventoryPosition({ onHand, reserved, incoming: fromUnits(incomingUnits), pendingOrders: pending, openRequests: requests.quantity, backorders })
  const positionUnits = toUnits(parts.position)
  const { dated, level, lotSize, sized } = reorderSizing({ item, reorderPoint, demand, position: parts.position, stock: parts.stock, minimum: requestMinimumOf(item, supplier, stockUnit), today })
  if (!dated) return { aboveReorderPointWithoutHistory: true }
  const ordering = sized.quantity.value !== null
  // At the reorder point with too little history to assume a level above it:
  // the level is the point, nothing to order, nothing to date it by. Not
  // listed, counted with the items above the point without history.
  if (!ordering && dated.orderNow && level.source === 'reorder_point') return { aboveReorderPointWithoutHistory: true }
  // Due today, nothing to order: due tomorrow, so "today" always has a quantity.
  const result = ordering
    ? { orderByDate: today, orderNow: true, daysUntilOrderBy: 0 }
    : dated.daysUntilOrderBy === 0
      ? { orderByDate: addCalendarDays(today, 1), orderNow: false, daysUntilOrderBy: 1 }
      : { ...dated, orderNow: false }
  const late = (line) => Boolean(line.dueDay) && line.dueDay < today
  const flags = [
    ...rows(allocation.incomingExcluded).map((line) => ({ code: 'po_line_other_unit', orderNumber: poRef(line), unit: text(line.unit) })),
    ...lines.filter(late).map((line) => ({ code: 'po_line_late', orderNumber: poRef(line), dueDay: line.dueDay })),
    ...lines.filter((line) => !line.dueDay).map((line) => ({ code: 'po_line_no_due_day', orderNumber: poRef(line) })),
    ...(rows(allocation.dataLimitations).some((code) => String(code).startsWith('po_line_unit_not_recorded:')) ? [{ code: 'po_line_unit_not_recorded' }] : []),
    ...(requests.otherUnitLines ? [{ code: 'request_line_other_unit', count: requests.otherUnitLines }] : []),
    ...demand.otherUnits.map((entry) => ({ code: 'shipment_other_unit', unit: entry.unit, count: entry.lineCount })),
    ...(demand.unitNotRecorded ? [{ code: 'shipment_unit_not_recorded', count: demand.unitNotRecorded }] : []),
  ]
  const position = fromUnits(positionUnits)
  const shortfall = fromUnits(Math.max(0, reorderPointUnits - positionUnits))
  // The purchase request line is in the item's stock unit, but the supplier's
  // minimum order is in the purchase unit and no conversion is recorded. When
  // the two units differ (or either is unknown) the person enters the quantity.
  const purchaseUnit = purchaseUnitOf(item, stockUnit)
  const purchaseUnitDiffers = !sameUnit(purchaseUnit, stockUnit)
  if (purchaseUnitDiffers) flags.push({ code: 'purchase_unit_differs', unit: purchaseUnit })
  // The request asks for the shared rule's quantity, as the assistant
  // suggests it: up to the order-up-to level, in whole lots, at least the
  // supplier's minimum. The shortfall to the reorder point is shown as
  // computed.
  const requestQuantity = ordering && !purchaseUnitDiffers ? sized.quantity.value : null
  return {
    row: {
      ...base,
      unit: stockUnit,
      orderByDate: result.orderByDate,
      orderNow: result.orderNow,
      daysUntilOrderBy: result.daysUntilOrderBy,
      onHand,
      reserved,
      incoming: fromUnits(incomingUnits),
      incomingLines: lines.map((line) => ({ orderNumber: poRef(line), remaining: Number(line.remaining), dueDay: line.dueDay || null, late: late(line) })),
      // On order but not committed, and asked for: draft or pending-approval
      // purchase orders and open purchase requests, in the position.
      requested: fromUnits(toUnits(pending) + toUnits(requests.quantity)),
      pendingOrders: pending,
      pendingLines: rows(allocation.pendingLines).map((line) => ({ orderNumber: poRef(line), status: text(line.status) || null, remaining: Number(line.remaining) })),
      openRequests: requests.quantity,
      requests: requests.documents,
      // Open sales demand no reservation covers yet, out of the position.
      backorders,
      position,
      reorderPoint,
      // The level the request orders up to, and where it comes from: the
      // item's (recorded) or the app's default (assumed: reorder point plus a
      // week of demand), or the reorder point without demand to assume from.
      orderUpTo: { level: level.level, source: level.source, reviewDays: 7 },
      lotSize,
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
      // The lead time the row is planned with: the supplier link's, else the
      // item's own (design audit L3-08).
      leadTimeDays: supplier?.leadTimeDays ?? itemPlanningValues(item).leadTimeDays,
      leadTimeFrom: supplier?.leadTimeFrom ?? (itemPlanningValues(item).leadTimeDays !== null ? 'item' : null),
      flags,
      purchaseRequest: {
        itemId: base.itemId,
        supplierId: supplier?.id || null,
        // Only a shortfall in the unit the request line will use; otherwise
        // the form opens with the quantity empty for the person to enter.
        quantity: requestQuantity,
        raisedToMinimum: requestQuantity !== null && sized.quantity.source === 'raised_to_moq',
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
// purchaseRequestLines: lines of open purchase requests ({ itemId, sku,
// quantity, unit, request: { id, number, status } }); their quantity is in the
// position, their numbers shown only with showPurchaseRequests.
export function buildReorderList({ allocationRows = [], items = [], shipmentLines = [], supplierLinks = [], suppliers = [], purchaseRequestLines = [], today, timeZone = DEFAULT_TENANT_TIMEZONE, scope = {}, showPurchaseOrders = true, showPurchaseRequests = showPurchaseOrders } = {}) {
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
      // The unit and lead time a suggested reorder point is sized with
      // (design audit L3-09: these items had no suggestion at all).
      const stockUnit = itemStockUnit(item)
      const supplier = stockUnit ? preferredSupplierFor(item, supplierLinks, suppliersById, { moqUnit: purchaseUnitOf(item, stockUnit) }) : null
      noReorderPointItems.push({ ...base, unit: stockUnit || null, leadTimeDays: supplier?.leadTimeDays ?? itemPlanningValues(item).leadTimeDays })
      continue
    }
    // The reorder point covers every warehouse; a part of them is never set against it.
    if (warehouseIds) { notJudged.push({ ...base, reason: 'warehouse_scope' }); continue }
    const stockUnit = itemStockUnit(item)
    if (!stockUnit) { notJudged.push({ ...base, reason: 'stock_unit_not_recorded' }); continue }
    const allocation = allocationBySku.get(text(item.sku))
    const demand = dailyDemand({ lines: linesByItem.get(text(item.id)), stockUnit, today, timeZone })
    const supplier = preferredSupplierFor(item, supplierLinks, suppliersById, { moqUnit: purchaseUnitOf(item, stockUnit) })
    const requests = openRequestsFor(purchaseRequestLines, { itemId: item.id, sku: item.sku, unit: stockUnit }, { showDocuments: showPurchaseRequests })
    const judged = judgeItem({ item, allocation, demand, reorderPoint, stockUnit, today, showPurchaseOrders, supplier, requests })
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
