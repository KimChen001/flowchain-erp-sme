import { escapeLikePattern } from '../persistence/like-pattern.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'
import { findManyWithinLimit, requireTenantId } from './repository-read-scope.mjs'

const text = (value, fallback = '') => String(value ?? '').trim() || fallback
const number = (value) => {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value?.toNumber === 'function') return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const isoDate = (value) => {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString().slice(0, 10)
}
const sum = (lines, key) => lines.reduce((total, line) => total + number(line[key]), 0)
// An amount that was never recorded is unknown, not zero.
const amount = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
// The order total, only when every line has an amount; null otherwise, so a
// report says the amount is missing instead of counting it as 0.
const totalAmount = (lines) => {
  const amounts = lines.map((line) => amount(line.amount))
  return amounts.length && amounts.every((value) => value !== null) ? Math.round(amounts.reduce((total, value) => total + value, 0) * 10000) / 10000 : null
}

const STATUS_LABELS = Object.freeze({
  draft: '草稿',
  confirmed: '已确认',
  on_hold: '已暂停',
  cancelled: '已取消',
  fulfilled: '已完成',
  partially_fulfilled: '部分履约',
  ready_to_ship: '可发货',
  partially_allocated: '部分分配',
  shortage_risk: '缺货风险',
})

function statusFor(row, orderedQty, reservedQty, fulfilledQty, shortageQty) {
  if (row.workflowStatus === 'cancelled') return 'cancelled'
  if (row.fulfillmentStatus === 'fulfilled' || (orderedQty > 0 && fulfilledQty >= orderedQty)) return 'fulfilled'
  if (fulfilledQty > 0) return 'partially_fulfilled'
  if (shortageQty > 0) return 'shortage_risk'
  if (orderedQty > 0 && reservedQty >= orderedQty) return 'ready_to_ship'
  if (reservedQty > 0) return 'partially_allocated'
  return text(row.workflowStatus, 'confirmed')
}

function riskFor(row, status, shortageQty) {
  if (status === 'cancelled' || status === 'fulfilled') return 'low'
  if (row.workflowStatus === 'on_hold') return 'blocked'
  if (shortageQty > 0) return 'high'
  return 'low'
}

const OPEN_DEMAND_EXCLUDED_STATUSES = ['draft', 'cancelled', 'canceled']

// The same rule on an order as listOrders returns it.
export const orderHasOpenDemand = (order) => !OPEN_DEMAND_EXCLUDED_STATUSES.includes(text(order?.workflowStatus)) && text(order?.fulfillmentStatus) !== 'fully_fulfilled'

// The orders behind each delivery figure, as database filters, so a count and
// the list it opens are the same orders. The outbound policy keeps an order's
// reservation and fulfillment statuses from its lines (outboundOrderStatuses
// in server/domain/outbound-transaction-policy.mjs): "fully_reserved" means
// every line is reserved or shipped in full, "fully_fulfilled" every line is
// shipped. An order is short of stock when it is neither, which is what
// mapOrder works out from the line quantities.
const HAS_LINES = Object.freeze({ lines: { some: {} } })
const NOT_CANCELLED = Object.freeze({ workflowStatus: { not: 'cancelled' } })
const NOT_SHIPPED_IN_FULL = Object.freeze({ fulfillmentStatus: { not: 'fully_fulfilled' } })
export const SALES_ORDER_DEMAND_FILTERS = Object.freeze({
  // On hold and not shipped in full: risk "blocked".
  blocked: { workflowStatus: 'on_hold', ...NOT_SHIPPED_IN_FULL },
  // Open, not on hold, with a line not yet reserved or shipped: risk "high".
  high: { workflowStatus: { notIn: ['cancelled', 'on_hold'] }, ...NOT_SHIPPED_IN_FULL, reservationStatus: { not: 'fully_reserved' }, ...HAS_LINES },
  // Every order still short of stock, on hold or not (shortageQty > 0).
  shortage: { ...NOT_CANCELLED, ...NOT_SHIPPED_IN_FULL, reservationStatus: { not: 'fully_reserved' }, ...HAS_LINES },
  // Stock reserved on at least one line (reservedQty > 0).
  reserved: { reservationStatus: { not: 'not_reserved' } },
})
// No order: an unknown filter value matches nothing rather than everything.
const NO_ORDER = Object.freeze({ id: { in: [] } })

// risk: "true" (blocked or high, as the risk queue counts), "blocked",
// "high" or "low".
export function salesOrderRiskWhere(risk) {
  const value = text(risk)
  if (!value) return null
  const atRisk = { OR: [SALES_ORDER_DEMAND_FILTERS.blocked, SALES_ORDER_DEMAND_FILTERS.high] }
  if (value === 'true') return atRisk
  if (value === 'blocked' || value === 'high') return SALES_ORDER_DEMAND_FILTERS[value]
  if (value === 'low') return { NOT: atRisk }
  return NO_ORDER
}

// The status mapOrder gives an order (statusFor), as a filter.
const ORDER_STATUS_FILTERS = Object.freeze({
  cancelled: { workflowStatus: 'cancelled' },
  fulfilled: { ...NOT_CANCELLED, fulfillmentStatus: 'fully_fulfilled', ...HAS_LINES },
  partially_fulfilled: { ...NOT_CANCELLED, fulfillmentStatus: 'partially_fulfilled' },
  shortage_risk: { ...NOT_CANCELLED, fulfillmentStatus: 'not_fulfilled', reservationStatus: { not: 'fully_reserved' }, ...HAS_LINES },
  ready_to_ship: { ...NOT_CANCELLED, fulfillmentStatus: 'not_fulfilled', reservationStatus: 'fully_reserved', ...HAS_LINES },
  // Only an order without lines keeps its workflow status as its status.
  draft: { workflowStatus: 'draft', lines: { none: {} } },
  confirmed: { workflowStatus: 'confirmed', lines: { none: {} } },
  on_hold: { workflowStatus: 'on_hold', lines: { none: {} } },
})
export const SALES_ORDER_STATUS_CODES = Object.freeze(Object.keys(ORDER_STATUS_FILTERS))

function mapOrder(row = {}) {
  const lines = Array.isArray(row.lines) ? row.lines : []
  const orderedQty = sum(lines, 'orderedQuantity')
  const reservedQty = sum(lines, 'reservedQuantity')
  const fulfilledQty = sum(lines, 'fulfilledQuantity')
  // A cancelled order will not be delivered, so it is short of nothing.
  const shortageQty = row.workflowStatus === 'cancelled' ? 0 : Math.max(0, orderedQty - reservedQty - fulfilledQty)
  const status = statusFor(row, orderedQty, reservedQty, fulfilledQty, shortageQty)
  const deliveryRiskLevel = riskFor(row, status, shortageQty)
  const firstLine = lines[0] || {}
  const salesOrderId = text(row.id || row.orderNumber)
  const sku = text(firstLine.sku || firstLine.itemId)
  const multipleLines = lines.length > 1
  const deliveryRiskReason = deliveryRiskLevel === 'blocked'
    ? '订单已暂停，需要复核交付条件和后续处理。'
    : deliveryRiskLevel === 'high'
      ? '订单数量尚未被库存预留或履约记录覆盖，存在交付缺口。'
      : '当前 PostgreSQL 订单、预留和履约记录未显示交付缺口。'
  const dataLimitations = [
    'inventory_availability_not_joined',
    ...(shortageQty > 0 ? ['purchase_supply_not_joined'] : []),
    ...(multipleLines ? ['risk_summary_aggregates_multiple_lines'] : []),
  ]

  return {
    id: salesOrderId,
    salesOrderId,
    orderNumber: text(row.orderNumber, salesOrderId),
    customerId: text(row.customerId),
    customerName: text(row.customerName, '未命名客户'),
    currency: text(row.currency),
    totalAmount: totalAmount(lines),
    customerTier: '常规客户',
    itemId: text(firstLine.itemId),
    sku,
    itemName: multipleLines ? `${text(firstLine.itemName, sku)} 等 ${lines.length} 个物料` : text(firstLine.itemName, sku),
    orderedQty,
    reservedQty,
    fulfilledQty,
    shortageQty,
    promisedDate: isoDate(row.promisedDate),
    workflowStatus: text(row.workflowStatus),
    reservationStatus: text(row.reservationStatus),
    fulfillmentStatus: text(row.fulfillmentStatus),
    status,
    statusLabel: STATUS_LABELS[status] || text(status, '待确认'),
    priority: deliveryRiskLevel === 'blocked' || deliveryRiskLevel === 'high' ? '高' : '低',
    deliveryRiskLevel,
    deliveryRiskLabel: deliveryRiskLevel === 'blocked' ? '已阻塞' : deliveryRiskLevel === 'high' ? '高风险' : '正常',
    deliveryRiskReason,
    linkedInventory: null,
    linkedPurchaseOrders: [],
    linkedSuppliers: [],
    linkedReceivingDocs: [],
    linkedExceptionCases: [],
    evidence: [
      { type: 'sales_order', id: salesOrderId, label: text(row.orderNumber, salesOrderId), summary: deliveryRiskReason, status: STATUS_LABELS[status] || status, route: `/api/sales-demand/orders/${encodeURIComponent(salesOrderId)}` },
      ...(sku ? [{ type: 'item', id: text(firstLine.itemId || sku), label: text(firstLine.itemName, sku), summary: `SKU ${sku}`, status: '', route: `/api/master-data/items/${encodeURIComponent(text(firstLine.itemId || sku))}` }] : []),
    ],
    dataLimitations,
    lines: lines.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      sku: line.sku,
      itemName: line.itemName,
      orderedQuantity: number(line.orderedQuantity),
      reservedQuantity: number(line.reservedQuantity),
      fulfilledQuantity: number(line.fulfilledQuantity),
      unit: line.unit,
      amount: amount(line.amount),
    })),
    createdAt: row.createdAt?.toISOString?.() || row.createdAt || null,
    updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt || null,
  }
}

export function summarizeSalesOrders(orders = []) {
  const risky = orders.filter((order) => order.deliveryRiskLevel !== 'low')
  return {
    totalOrders: orders.length,
    riskOrderCount: risky.length,
    highRiskOrderCount: orders.filter((order) => ['blocked', 'high'].includes(order.deliveryRiskLevel)).length,
    shortageQty: orders.reduce((total, order) => total + number(order.shortageQty), 0),
    reservedQty: orders.reduce((total, order) => total + number(order.reservedQty), 0),
    affectedCustomerCount: new Set(risky.map((order) => order.customerName).filter(Boolean)).size,
  }
}

export function createDbSalesOrderReadRepository({ env = process.env, prisma } = {}) {
  const client = async () => {
    validateDatabasePersistenceConfig(env)
    return prisma || getPrismaClient(env)
  }

  // The orders the filters select, every filter applied in the database so a
  // count, a page and the summary agree: q (order id, number or customer),
  // status (workflow status), sku (any line), risk (salesOrderRiskWhere) and
  // orderStatus (the status mapOrder gives, SALES_ORDER_STATUS_CODES).
  function orderWhere(filters = {}) {
    const tenantId = requireTenantId(filters)
    const and = []
    // Escaped, so "%" or "_" is searched for as itself and does not match every order.
    const search = escapeLikePattern(text(filters.q || filters.search))
    if (search) and.push({ OR: [
      { id: { contains: search, mode: 'insensitive' } },
      { orderNumber: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
    ] })
    if (text(filters.status)) and.push({ workflowStatus: text(filters.status) })
    const sku = text(filters.sku)
    if (sku) and.push({ lines: { some: { OR: [{ sku }, { itemId: sku }] } } })
    const risk = salesOrderRiskWhere(filters.risk)
    if (risk) and.push(risk)
    const orderStatus = text(filters.orderStatus)
    if (orderStatus) and.push(ORDER_STATUS_FILTERS[orderStatus] || NO_ORDER)
    return and.length ? { tenantId, AND: and } : { tenantId }
  }
  const narrowed = (where, extra) => ({ tenantId: where.tenantId, AND: [...(where.AND || []), extra] })

  // Up to 500 orders, most recently updated first, from `offset`. sort=risk
  // puts orders on hold first: in the risk queue the workflow status is
  // on_hold, draft or confirmed, so descending order lists on_hold first.
  async function listOrders(filters = {}) {
    const where = orderWhere(filters)
    const db = await client()
    const offset = Math.max(0, Math.floor(Number(filters.offset) || 0))
    const rows = await findManyWithinLimit(db.salesOrder, {
      where,
      include: { lines: { orderBy: { id: 'asc' } } },
      orderBy: filters.sort === 'risk' ? [{ workflowStatus: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }] : [{ updatedAt: 'desc' }, { id: 'asc' }],
      ...(offset ? { skip: offset } : {}),
    }, { limit: Math.min(500, Math.max(1, Number(filters.limit || 500))), subject: 'sales_orders', onTruncated: filters.onTruncated })
    return rows.map(mapOrder)
  }

  // How many orders the filters select, however many a list returns.
  async function countOrders(filters = {}) {
    const where = orderWhere(filters)
    const db = await client()
    return db.salesOrder.count({ where })
  }

  // The delivery figures over every order the filters select, not only the
  // orders a list returns: counts and line sums in the database.
  async function getSummary(filters = {}) {
    const where = orderWhere(filters)
    const db = await client()
    const atRisk = narrowed(where, salesOrderRiskWhere('true'))
    const [totalOrders, riskOrderCount, short, reserved, customers] = await Promise.all([
      db.salesOrder.count({ where }),
      db.salesOrder.count({ where: atRisk }),
      // Each short order is short by ordered - reserved - shipped over its lines.
      db.salesOrderLine.aggregate({ where: { salesOrder: { is: narrowed(where, SALES_ORDER_DEMAND_FILTERS.shortage) } }, _sum: { orderedQuantity: true, reservedQuantity: true, fulfilledQuantity: true } }),
      db.salesOrderLine.aggregate({ where: { salesOrder: { is: where } }, _sum: { reservedQuantity: true } }),
      db.salesOrder.findMany({ where: atRisk, distinct: ['customerName'], select: { customerName: true } }),
    ])
    return {
      totalOrders,
      riskOrderCount,
      highRiskOrderCount: riskOrderCount,
      shortageQty: Math.max(0, number(short?._sum?.orderedQuantity) - number(short?._sum?.reservedQuantity) - number(short?._sum?.fulfilledQuantity)),
      reservedQty: number(reserved?._sum?.reservedQuantity),
      affectedCustomerCount: new Set((customers || []).map((row) => text(row.customerName)).filter(Boolean)).size,
    }
  }

  // Orders that may still need stock: neither draft nor cancelled, and not
  // fully fulfilled (orderHasOpenDemand, below). The business read context
  // compares it with the orders it read, so a list that reads only the most
  // recent orders knows whether an older one could still hold open demand.
  async function countOrdersWithOpenDemand(filters = {}) {
    const db = await client()
    return db.salesOrder.count({ where: { tenantId: requireTenantId(filters), workflowStatus: { notIn: OPEN_DEMAND_EXCLUDED_STATUSES }, fulfillmentStatus: { not: 'fully_fulfilled' } } })
  }

  // Report figures over every order of the workspace, however many listOrders
  // returns (it reads the latest 500 with their lines). The database groups
  // the orders by business day in the workspace timezone (the creation day,
  // as the report reads an order without an order date), currency, customer,
  // the status the report shows (statusFor, with a draft or cancelled order
  // kept as such) and its shipping progress, and totals each group's orders
  // and amounts. An order's amount is its lines' total only while every line
  // has one, as mapOrder reads it; orders without an amount are a group of
  // their own, so a total is never made from part of them. Only the reports
  // read this.
  async function summarizeOrdersForReport(filters = {}) {
    const tenantId = requireTenantId(filters)
    const timeZone = text(filters.timeZone, 'UTC')
    const db = await client()
    const rows = await db.$queryRaw`
      WITH lines AS (
        SELECT l."salesOrderId" AS id,
          count(*) AS line_count,
          count(l.amount) AS amount_count,
          sum(l.amount) AS amount,
          sum(l."orderedQuantity") AS ordered,
          sum(l."reservedQuantity") AS reserved,
          sum(l."fulfilledQuantity") AS fulfilled,
          bool_or(l."fulfilledQuantity" > 0) AS shipped,
          bool_and(l."orderedQuantity" > 0 AND l."fulfilledQuantity" >= l."orderedQuantity") AS shipped_in_full
        FROM "SalesOrderLine" l
        JOIN "SalesOrder" o ON o.id = l."salesOrderId"
        WHERE o."tenantId" = ${tenantId}
        GROUP BY l."salesOrderId"
      ), orders AS (
        SELECT
          to_char((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
          o.currency,
          o."customerName" AS customer,
          CASE
            WHEN o."workflowStatus" IN ('draft', 'cancelled', 'canceled') THEN o."workflowStatus"
            WHEN o."fulfillmentStatus" = 'fulfilled' OR (COALESCE(ls.ordered, 0) > 0 AND COALESCE(ls.fulfilled, 0) >= ls.ordered) THEN 'fulfilled'
            WHEN COALESCE(ls.fulfilled, 0) > 0 THEN 'partially_fulfilled'
            WHEN COALESCE(ls.ordered, 0) - COALESCE(ls.reserved, 0) - COALESCE(ls.fulfilled, 0) > 0 THEN 'shortage_risk'
            WHEN COALESCE(ls.ordered, 0) > 0 AND COALESCE(ls.reserved, 0) >= ls.ordered THEN 'ready_to_ship'
            WHEN COALESCE(ls.reserved, 0) > 0 THEN 'partially_allocated'
            ELSE COALESCE(NULLIF(trim(o."workflowStatus"), ''), 'confirmed')
          END AS status,
          CASE WHEN ls.line_count > 0 AND ls.amount_count = ls.line_count THEN ls.amount END AS amount,
          COALESCE(ls.reserved, 0) > 0 AS reserved,
          COALESCE(ls.shipped, false) AS shipped,
          COALESCE(ls.line_count, 0) > 0 AND COALESCE(ls.shipped_in_full, false) AS shipped_in_full
        FROM "SalesOrder" o
        LEFT JOIN lines ls ON ls.id = o.id
        WHERE o."tenantId" = ${tenantId}
      )
      SELECT day, currency, customer, status, reserved, shipped, shipped_in_full,
        amount IS NULL AS amount_missing,
        count(*)::int AS orders,
        sum(amount)::text AS amount
      FROM orders
      GROUP BY day, currency, customer, status, reserved, shipped, shipped_in_full, amount IS NULL`
    return (rows || []).map((row) => ({
      date: text(row.day),
      currency: text(row.currency),
      // The name the order list gives an order without a recorded customer.
      customer: text(row.customer, '未命名客户'),
      status: text(row.status),
      count: Number(row.orders) || 0,
      amount: row.amount_missing ? null : Math.round(Number(row.amount) * 10000) / 10000,
      reserved: Boolean(row.reserved),
      shipped: Boolean(row.shipped),
      shippedInFull: Boolean(row.shipped_in_full),
    })).filter((row) => row.count > 0)
  }

  return {
    mode: 'database',
    adapter: 'db-sales-order-read-v1',
    listOrders,
    countOrders,
    countOrdersWithOpenDemand,
    summarizeOrdersForReport,
    // One order by its id or its number, however old it is.
    async getOrder(id, filters = {}) {
      const tenantId = requireTenantId(filters)
      const key = text(id)
      if (!key) return null
      const db = await client()
      const row = await db.salesOrder.findFirst({
        where: { tenantId, OR: [{ id: { equals: key, mode: 'insensitive' } }, { orderNumber: { equals: key, mode: 'insensitive' } }] },
        include: { lines: { orderBy: { id: 'asc' } } },
        orderBy: { id: 'asc' },
      })
      return row ? mapOrder(row) : null
    },
    getSummary,
  }
}
