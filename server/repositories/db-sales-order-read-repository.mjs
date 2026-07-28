import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'

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

function mapOrder(row = {}) {
  const lines = Array.isArray(row.lines) ? row.lines : []
  const orderedQty = sum(lines, 'orderedQuantity')
  const reservedQty = sum(lines, 'reservedQuantity')
  const fulfilledQty = sum(lines, 'fulfilledQuantity')
  const shortageQty = Math.max(0, orderedQty - reservedQty - fulfilledQty)
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
  const tenantIdFor = (filters = {}) => text(filters.tenantId || env.FLOWCHAIN_DEFAULT_TENANT_ID, 'tenant-flowchain-sme')

  async function listOrders(filters = {}) {
    const db = await client()
    const where = { tenantId: tenantIdFor(filters) }
    const search = text(filters.q || filters.search)
    if (search) where.OR = [
      { id: { contains: search, mode: 'insensitive' } },
      { orderNumber: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
    ]
    if (text(filters.status)) where.workflowStatus = text(filters.status)
    const rows = await db.salesOrder.findMany({
      where,
      include: { lines: { orderBy: { id: 'asc' } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: Math.min(500, Math.max(1, Number(filters.limit || 500))),
    })
    return rows.map(mapOrder)
      .filter((order) => !text(filters.sku) || order.lines.some((line) => line.sku === text(filters.sku) || line.itemId === text(filters.sku)))
      .filter((order) => !text(filters.risk) || (filters.risk === 'true' ? order.deliveryRiskLevel !== 'low' : order.deliveryRiskLevel === filters.risk))
  }

  return {
    mode: 'database',
    adapter: 'db-sales-order-read-v1',
    listOrders,
    async getOrder(id, filters = {}) {
      const orders = await listOrders(filters)
      const key = text(id).toLowerCase()
      return orders.find((order) => [order.id, order.salesOrderId, order.orderNumber].some((value) => text(value).toLowerCase() === key)) || null
    },
    async getSummary(filters = {}) {
      return summarizeSalesOrders(await listOrders(filters))
    },
  }
}
