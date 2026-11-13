import assert from 'node:assert/strict'
import test from 'node:test'
import { createDbSalesOrderReadRepository, SALES_ORDER_STATUS_CODES } from '../repositories/db-sales-order-read-repository.mjs'
import { createSalesOrderReadService, createSalesOrderWorkbenchService } from './sales-order-workbench-service.mjs'
import { createOutboundWorkbenchReadService } from './outbound-workbench-read-service.mjs'
import { outboundOrderStatuses } from './outbound-transaction-policy.mjs'

const env = { DATABASE_URL: 'postgresql://flowchain:test@127.0.0.1:5432/flowchain_test' }

const row = {
  id: 'SO-DB-1',
  tenantId: 'tenant-a',
  orderNumber: 'SO-DB-1',
  customerId: 'CUS-1',
  customerName: 'Database Customer',
  workflowStatus: 'confirmed',
  reservationStatus: 'partially_reserved',
  fulfillmentStatus: 'not_fulfilled',
  promisedDate: new Date('2030-01-20T00:00:00Z'),
  currency: 'CNY',
  lines: [{
    id: 'SOL-1',
    itemId: 'ITEM-1',
    sku: 'SKU-1',
    itemName: 'Database Item',
    orderedQuantity: 35,
    reservedQuantity: 8,
    fulfilledQuantity: 0,
    unit: 'pcs',
    amount: '245.50',
  }],
}

// The part of Prisma's filter language the sales reads use, over rows held in
// memory, so a test sees which orders a filter selects.
function matches(record, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return [condition].flat().every((part) => matches(record, part))
    if (key === 'OR') return condition.some((part) => matches(record, part))
    if (key === 'NOT') return ![condition].flat().some((part) => matches(record, part))
    const value = record[key]
    if (key === 'lines') {
      const lines = value || []
      if ('some' in condition) return lines.some((line) => matches(line, condition.some))
      if ('none' in condition) return !lines.some((line) => matches(line, condition.none))
      return lines.every((line) => matches(line, condition.every))
    }
    if (key === 'salesOrder') return matches(value, condition.is ?? condition)
    if (condition === null || typeof condition !== 'object' || condition instanceof Date) return value === condition
    const insensitive = condition.mode === 'insensitive'
    const same = (a, b) => (insensitive ? String(a).toLowerCase() === String(b).toLowerCase() : a === b)
    if ('equals' in condition && !same(value, condition.equals)) return false
    if ('not' in condition && same(value, condition.not)) return false
    if ('in' in condition && !condition.in.includes(value)) return false
    if ('notIn' in condition && condition.notIn.includes(value)) return false
    if ('contains' in condition && !String(value ?? '').toLowerCase().includes(String(condition.contains).toLowerCase())) return false
    return true
  })
}
function ordered(rows, orderBy = []) {
  return [...rows].sort((a, b) => {
    for (const rule of [orderBy].flat()) {
      const [[field, direction]] = Object.entries(rule)
      const left = a[field] instanceof Date ? a[field].getTime() : a[field]
      const right = b[field] instanceof Date ? b[field].getTime() : b[field]
      if (left === right) continue
      return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1)
    }
    return 0
  })
}
function fakePrisma(orders, extra = {}) {
  const lines = orders.flatMap((order) => order.lines.map((line) => ({ ...line, salesOrderId: order.id, salesOrder: order })))
  const calls = []
  return {
    calls,
    salesOrder: {
      async findMany(args = {}) {
        calls.push(['salesOrder.findMany', args])
        let rows = ordered(orders.filter((order) => matches(order, args.where)), args.orderBy)
        if (args.distinct) rows = rows.filter((order, index) => rows.findIndex((other) => args.distinct.every((field) => other[field] === order[field])) === index)
        rows = rows.slice(args.skip || 0, args.take === undefined ? undefined : (args.skip || 0) + args.take)
        return args.select ? rows.map((order) => Object.fromEntries(Object.keys(args.select).map((field) => [field, order[field]]))) : rows
      },
      async findFirst(args = {}) {
        calls.push(['salesOrder.findFirst', args])
        return ordered(orders.filter((order) => matches(order, args.where)), args.orderBy)[0] || null
      },
      async count(args = {}) {
        calls.push(['salesOrder.count', args])
        return orders.filter((order) => matches(order, args.where)).length
      },
    },
    salesOrderLine: {
      async aggregate(args = {}) {
        calls.push(['salesOrderLine.aggregate', args])
        const selected = lines.filter((line) => matches(line, args.where))
        return { _sum: Object.fromEntries(Object.keys(args._sum).map((field) => [field, selected.length ? selected.reduce((sum, line) => sum + Number(line[field]), 0) : null])) }
      },
    },
    ...extra,
  }
}

// An order whose statuses are the ones the outbound policy keeps from its
// lines, as every reserve, ship and cancel command writes them.
function order(index, { workflowStatus = 'confirmed', lines: quantities = [[4, 0, 0]], customerName = `Customer ${index % 7}`, currency = 'USD' } = {}) {
  const lines = quantities.map(([orderedQuantity, reservedQuantity, fulfilledQuantity], line) => ({
    id: `SO-${index}-L${line + 1}`, itemId: `ITEM-${line + 1}`, sku: `SKU-${line + 1}`, itemName: `Item ${line + 1}`,
    orderedQuantity, reservedQuantity, fulfilledQuantity, unit: 'pcs', amount: '1.00',
  }))
  return {
    id: `SO-ID-${String(index).padStart(4, '0')}`, tenantId: 'tenant-a', orderNumber: `SO-202611-${String(index).padStart(4, '0')}`,
    customerName, currency, workflowStatus, ...outboundOrderStatuses(lines), promisedDate: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)), lines,
  }
}

// Every combination the lines and workflow allow: unreserved, partly or fully
// reserved, partly or fully shipped, cancelled, on hold, drafts and an order
// without lines.
const LINE_SHAPES = [[[4, 0, 0]], [[4, 2, 0]], [[4, 4, 0]], [[4, 0, 2]], [[4, 2, 2]], [[4, 0, 4]], [[4, 0, 4], [3, 0, 0]], [[4, 4, 0], [3, 0, 0]], [[4, 0, 4], [3, 3, 0]], []]
const WORKFLOWS = ['draft', 'confirmed', 'on_hold', 'cancelled']
const everyShape = () => WORKFLOWS.flatMap((workflowStatus, w) => LINE_SHAPES.map((lines, l) => order(w * 100 + l, { workflowStatus, lines })))

test('PostgreSQL sales demand repository is tenant scoped and derives risk from authoritative order lines', async () => {
  const prisma = fakePrisma([row])
  const repository = createDbSalesOrderReadRepository({ env, prisma })

  const orders = await repository.listOrders({ tenantId: 'tenant-a' })
  assert.equal(prisma.calls[0][1].where.tenantId, 'tenant-a')
  assert.equal(orders[0].salesOrderId, 'SO-DB-1')
  assert.equal(orders[0].currency, 'CNY')
  assert.equal(orders[0].totalAmount, 245.5)
  assert.equal(orders[0].shortageQty, 27)
  assert.equal(orders[0].deliveryRiskLevel, 'high')
  assert.equal(orders[0].linkedPurchaseOrders.length, 0)
  assert.equal(orders[0].dataLimitations.includes('purchase_supply_not_joined'), true)

  const summary = await repository.getSummary({ tenantId: 'tenant-a' })
  assert.deepEqual(summary, {
    totalOrders: 1,
    riskOrderCount: 1,
    highRiskOrderCount: 1,
    shortageQty: 27,
    reservedQty: 8,
    affectedCustomerCount: 1,
  })
})

test('PostgreSQL sales demand repository never manufactures rows for an empty workspace', async () => {
  const repository = createDbSalesOrderReadRepository({ env, prisma: fakePrisma([]) })
  assert.deepEqual(await repository.listOrders({ tenantId: 'tenant-empty' }), [])
  assert.equal((await repository.getSummary({ tenantId: 'tenant-empty' })).totalOrders, 0)
  assert.equal((await repository.getSummary({ tenantId: 'tenant-empty' })).shortageQty, 0)
})

test('an order total is shown only when every line has an amount', async () => {
  const repository = createDbSalesOrderReadRepository({ env, prisma: fakePrisma([{ ...row, lines: [row.lines[0], { ...row.lines[0], id: 'SOL-2', amount: null }] }]) })
  const [first] = await repository.listOrders({ tenantId: 'tenant-a' })
  assert.equal(first.totalAmount, null)
  assert.deepEqual(first.lines.map((line) => line.amount), [245.5, null])
})

// The audit found "Sales orders 500 total, 500 shown" on a workspace with
// 3,548 orders: the list read the newest 500 and called that the total.
test('the order list counts every order and pages past the newest 500', async () => {
  const orders = Array.from({ length: 620 }, (_, index) => order(index + 1))
  const repository = createDbSalesOrderReadRepository({ env, prisma: fakePrisma(orders) })
  const scope = { tenantId: 'tenant-a' }

  assert.equal((await repository.listOrders(scope)).length, 500)
  assert.equal(await repository.countOrders(scope), 620)
  assert.equal((await repository.getSummary(scope)).totalOrders, 620)
  // Newest first; the second page of 15 starts at the 16th newest.
  const second = await repository.listOrders({ ...scope, offset: 15, limit: 15 })
  assert.deepEqual(second.map((entry) => entry.orderNumber), Array.from({ length: 15 }, (_, index) => `SO-202611-${String(605 - index).padStart(4, '0')}`))
  // The oldest order is on the last page and opens by its id or its number.
  const last = await repository.listOrders({ ...scope, offset: 615, limit: 15 })
  assert.deepEqual(last.map((entry) => entry.orderNumber), ['SO-202611-0005', 'SO-202611-0004', 'SO-202611-0003', 'SO-202611-0002', 'SO-202611-0001'])
  assert.equal((await repository.getOrder('SO-ID-0001', scope))?.orderNumber, 'SO-202611-0001')
  assert.equal((await repository.getOrder('so-202611-0001', scope))?.salesOrderId, 'SO-ID-0001')
  assert.equal(await repository.getOrder('SO-404', scope), null)
  // Search, by number, reaches it too.
  assert.equal(await repository.countOrders({ ...scope, q: 'SO-202611-0001' }), 1)
})

// Each figure on the Delivery risk page opens a list; the list must hold the
// very orders the figure counts, so both use one filter. The filter reads the
// stored statuses; mapOrder works the risk out from the lines. They agree on
// every shape an order can take.
test('the risk, shortage, reserved and status filters select exactly the orders mapOrder classifies', async () => {
  const orders = everyShape()
  const repository = createDbSalesOrderReadRepository({ env, prisma: fakePrisma(orders) })
  const scope = { tenantId: 'tenant-a' }
  const all = await repository.listOrders(scope)
  assert.equal(all.length, orders.length)
  const ids = (list) => list.map((entry) => entry.salesOrderId).sort()
  const expected = (keep) => ids(all.filter(keep))

  for (const risk of ['blocked', 'high', 'low']) {
    assert.deepEqual(ids(await repository.listOrders({ ...scope, risk })), expected((entry) => entry.deliveryRiskLevel === risk), risk)
  }
  assert.deepEqual(ids(await repository.listOrders({ ...scope, risk: 'true' })), expected((entry) => entry.deliveryRiskLevel !== 'low'))
  for (const status of SALES_ORDER_STATUS_CODES) {
    assert.deepEqual(ids(await repository.listOrders({ ...scope, orderStatus: status })), expected((entry) => entry.status === status), status)
  }
  // Every order has one of the listed statuses.
  assert.equal(all.every((entry) => SALES_ORDER_STATUS_CODES.includes(entry.status)), true)
  // An unknown value selects nothing rather than everything.
  assert.deepEqual(await repository.listOrders({ ...scope, risk: 'medium' }), [])
  assert.deepEqual(await repository.listOrders({ ...scope, orderStatus: 'shipped' }), [])

  // A cancelled order will not be delivered: it is short of nothing.
  assert.equal(all.filter((entry) => entry.workflowStatus === 'cancelled').every((entry) => entry.shortageQty === 0), true)

  const summary = await repository.getSummary(scope)
  assert.equal(summary.totalOrders, all.length)
  assert.equal(summary.riskOrderCount, all.filter((entry) => entry.deliveryRiskLevel !== 'low').length)
  assert.equal(summary.highRiskOrderCount, summary.riskOrderCount)
  assert.equal(summary.shortageQty, all.reduce((sum, entry) => sum + entry.shortageQty, 0))
  assert.equal(summary.reservedQty, all.reduce((sum, entry) => sum + entry.reservedQty, 0))
  assert.equal(summary.affectedCustomerCount, new Set(all.filter((entry) => entry.deliveryRiskLevel !== 'low').map((entry) => entry.customerName)).size)
  // sort=risk lists the orders on hold first.
  const queue = await repository.listOrders({ ...scope, risk: 'true', sort: 'risk' })
  const firstOther = queue.findIndex((entry) => entry.deliveryRiskLevel !== 'blocked')
  assert.ok(firstOther > 0 && queue.slice(firstOther).every((entry) => entry.deliveryRiskLevel === 'high'))
})

// The sales order list behind those figures (GET /api/sales/orders).
const TENANT = 'tenant-a'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const permissions = ['sales_order.read', 'sales_order.revise', 'sales_order.submit', 'sales_order.cancel', 'shipment.read', 'shipment.prepare']
const user = {
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [{ warehouseId: 'WH-1', accessLevel: 'operate' }],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'sales', name: 'Sales', status: 'active', permissions: permissions.map((permissionCode) => ({ permissionCode })) } }],
}
const users = { user: { findFirst: async () => user } }

test('the sales order list opens the orders each Delivery risk figure counts, and lists the currencies orders use', async () => {
  const orders = [...everyShape(), order(900, { currency: 'GBP' }), order(901, { currency: 'gbp' })]
  const repository = createDbSalesOrderReadRepository({ env, prisma: fakePrisma(orders) })
  const all = await repository.listOrders({ tenantId: TENANT })
  const service = createSalesOrderReadService({ prisma: fakePrisma(orders, users) })
  const listed = async (query) => (await service.listOrders({ pageSize: 100, ...query }, { identity })).orders.map((entry) => entry.id).sort()
  const expected = (keep) => all.filter(keep).map((entry) => entry.salesOrderId).sort()

  assert.deepEqual(await listed({ risk: 'true' }), expected((entry) => entry.deliveryRiskLevel !== 'low'))
  assert.deepEqual(await listed({ risk: 'blocked' }), expected((entry) => entry.deliveryRiskLevel === 'blocked'))
  assert.deepEqual(await listed({ shortage: 'true' }), expected((entry) => entry.shortageQty > 0))
  assert.deepEqual(await listed({ reserved: 'true' }), expected((entry) => entry.reservedQty > 0))
  // Combined with the other filters, not instead of them.
  assert.deepEqual(await listed({ risk: 'true', workflowStatus: 'draft' }), expected((entry) => entry.deliveryRiskLevel !== 'low' && entry.workflowStatus === 'draft'))
  const page = await service.listOrders({ risk: 'true', pageSize: 5 }, { identity })
  assert.equal(page.total, all.filter((entry) => entry.deliveryRiskLevel !== 'low').length)
  assert.deepEqual(page.currencies, ['GBP', 'USD'])
})

test('a fully shipped order offers no hold or reserve, and cannot be put on hold', async () => {
  const shipped = { ...order(1, { lines: [[4, 0, 4], [3, 0, 3]] }), version: 3, reservations: [], shipments: [] }
  assert.equal(shipped.fulfillmentStatus, 'fully_fulfilled')
  const balances = [{ id: 'BAL-1', tenantId: TENANT, itemId: 'ITEM-1', sku: 'SKU-1', warehouseId: 'WH-1', location: 'A-01', locationKey: 'a-01', onHandQuantity: 10, reservedQuantity: 0, availableQuantity: 10 }]
  const empty = { findMany: async () => [] }
  const prisma = {
    ...users,
    salesOrder: { findFirst: async () => shipped },
    inventoryBalance: { findMany: async () => balances },
    auditLog: empty, inventoryReservationEvent: empty, inventoryMovement: empty,
  }
  const enabled = { enabled: true }
  const service = createOutboundWorkbenchReadService({ prisma, capabilities: { lifecycle: enabled, reservation: enabled, shipmentDraft: enabled, shipmentPosting: enabled, shipmentReversal: enabled } })
  const workbench = await service.orderWorkbench(shipped.id, { identity })
  assert.equal(workbench.availableActions.canHold, false)
  assert.equal(workbench.availableActions.canReserve, false)
  assert.equal(workbench.availableActions.canCreateShipment, false)
  assert.equal(workbench.availableActions.primaryAction, null)
  // The audit link names the order by its number.
  assert.deepEqual(workbench.smartLinks.find((link) => link.targetRouteId === 'settings:audit').filter, { entityType: 'SalesOrder', entityId: shipped.id, entityLabel: shipped.orderNumber })

  // The same order with a line still to ship can be held and reserved.
  const open = { ...order(2, { lines: [[4, 0, 4], [3, 0, 0]] }), version: 1, reservations: [], shipments: [] }
  const openWorkbench = await createOutboundWorkbenchReadService({ prisma: { ...prisma, salesOrder: { findFirst: async () => open } }, capabilities: { lifecycle: enabled, reservation: enabled, shipmentDraft: enabled } }).orderWorkbench(open.id, { identity })
  assert.equal(openWorkbench.availableActions.canHold, true)
  assert.equal(openWorkbench.availableActions.canReserve, true)

  // The hold command refuses it as well.
  const writes = []
  const commands = createSalesOrderWorkbenchService({
    prisma: {
      ...users,
      businessCommandExecution: { findUnique: async () => null },
      $transaction: async (work) => work({
        businessCommandExecution: { findUnique: async () => null, create: async ({ data }) => { writes.push('execution'); return data } },
        salesOrder: { findFirst: async () => shipped, update: async () => { writes.push('order'); return shipped } },
      }),
    },
  })
  await assert.rejects(
    commands.holdOrder(shipped.id, { expectedOrderVersion: shipped.version, idempotencyKey: 'hold-shipped' }, { identity }),
    (error) => error.code === 'SALES_ORDER_INVALID_STATE',
  )
  assert.deepEqual(writes, ['execution'])
})
