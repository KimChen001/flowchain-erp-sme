// Seeds a local workspace from public demand data (scripts/public-data-
// instance.mjs): one supplier and one customer per set, the items with their
// [assumed] thresholds and supplier terms, and the [public data] demand as
// customer orders shipped in full on their day, through the outbound posting
// commands, so the reorder list, the read tools and the assistant read it as
// they read any workspace's history. Local development only; research and
// evaluation, not business data.
//
// Day i of a set's window (0-based, of n days) becomes the day i - n before
// the seed day, so the last day of the window is yesterday and the reorder
// list's 90-day demand window holds exactly the public window. Stock starts
// with one opening stock entry the day before the window: the [assumed] on
// hand plus everything the window ships, so stock never goes below zero and
// ends at the assumed on hand. Nothing is on order.
//
// Identifiers start with PUB-. The workspace must not have the walkthrough
// demo items: seed it in a fresh database (see tests/ai-eval/v2-public).
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { createInventoryOperationsCommandService } from '../server/domain/inventory-operations-command-service.mjs'
import { saveItemSupplier } from '../server/domain/master-data-commands.mjs'
import { HISTORY_PERMISSIONS, scenarioActor, scenarioCalendar, shipHistoryOrder } from './setup-local-scenario.mjs'
import { PUBLIC_DATA_ASSUMPTIONS } from './public-data-instance.mjs'

// shipHistoryOrder ships from this warehouse, at A-01.
const WAREHOUSE = 'LOCAL-DEMO-WH-001'
const OPENING_KEY = 'public-data:opening-stock'
const money = (value) => Math.round(value * 100) / 100
const slug = (value) => String(value).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase()

export async function seedPublicDataScenario(prisma, env = process.env, { instances = [], asOf } = {}) {
  assertLocalDevelopment(env, 'public data scenario')
  if (!instances.length) throw new Error('Pass at least one public data instance.')
  const tenantId = String(env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local').trim()
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error('Provision the workspace before seeding public data.')
  for (const instance of instances) {
    if (instance.currency !== tenant.currency) throw new Error(`Public data set ${instance.set} is in ${instance.currency}; workspace ${tenantId} uses ${tenant.currency}.`)
  }
  if (new Set(instances.map((instance) => instance.days)).size !== 1) throw new Error('Every public data set needs the same number of days.')
  if (await prisma.item.findFirst({ where: { tenantId, id: { startsWith: 'PUB-' } } })) throw new Error('This workspace already has public data; seed a fresh database.')
  if (await prisma.item.findFirst({ where: { tenantId } })) throw new Error('This workspace already has items; seed public data into an empty workspace.')

  const timeZone = tenant.timezone || 'America/New_York'
  const calendar = scenarioCalendar(asOf ?? env.FLOWCHAIN_SCENARIO_AS_OF ?? new Date(), timeZone)
  const { day, at } = calendar
  const days = instances[0].days
  const metadata = { publicData: true, scenarioAsOf: calendar.seedDay }
  const historyEnv = { ...env, FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true', FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true' }
  const shipper = await scenarioActor(prisma, tenantId, HISTORY_PERMISSIONS, 'opening stock and shipments')

  const sets = instances.map((instance, index) => {
    const n = index + 1
    return {
      instance,
      supplier: { id: `PUB-SUP-${n}`, code: `PUB-SUP-${n}`, name: `${instance.label} supplier [assumed]` },
      customer: { id: `PUB-CUS-${n}`, code: `PUB-CUS-${n}`, name: `${instance.label} customers [public data]` },
      items: instance.items.map((item) => ({ ...item, id: `PUB-ITEM-${slug(item.sku)}`, balanceId: `PUB-BAL-${slug(item.sku)}` })),
    }
  })
  const orders = []

  // 1. Master data, stock records and the window's orders, as written rows.
  await prisma.$transaction(async (tx) => {
    await tx.warehouse.upsert({ where: { id: WAREHOUSE }, create: { id: WAREHOUSE, tenantId, code: 'PUB-WH', name: 'Public data warehouse', metadata }, update: {} })
    const users = await tx.user.findMany({ where: { tenantId, status: 'active' }, select: { id: true } })
    for (const user of users) {
      await tx.userWarehouseScope.upsert({
        where: { tenantId_userId_warehouseId: { tenantId, userId: user.id, warehouseId: WAREHOUSE } },
        create: { id: `PUB-SCOPE-${user.id}`, tenantId, userId: user.id, warehouseId: WAREHOUSE, accessLevel: 'operate' },
        update: { accessLevel: 'operate' },
      })
    }
    for (const code of ['A-01', 'QC-01']) {
      const id = `PUB-LOC-${code.replace('-', '')}`
      await tx.warehouseLocation.upsert({ where: { id }, create: { id, tenantId, warehouseId: WAREHOUSE, code, locationKey: code.toLowerCase(), name: `Public data location ${code}` }, update: {} })
    }
    for (const { instance, supplier, customer, items } of sets) {
      await tx.supplier.create({ data: { id: supplier.id, tenantId, code: supplier.code, name: supplier.name, category: instance.label, riskLevel: 'low', metadata: { ...metadata, defaultCurrency: instance.currency } } })
      await tx.runtimeRecord.create({ data: { id: customer.id, tenantId, namespace: 'master-data.customers', recordKey: customer.code, payload: { id: customer.id, code: customer.code, name: customer.name, status: 'active', currency: instance.currency, ...metadata } } })
      for (const item of items) {
        const thresholds = { safetyStock: item.safetyStock, reorderPoint: item.reorderPoint }
        await tx.item.create({ data: { id: item.id, tenantId, sku: item.sku, name: item.name, category: item.category, unit: item.unit, preferredSupplierId: supplier.id, ...thresholds, metadata: { ...metadata, defaultWarehouseId: WAREHOUSE, ...thresholds } } })
        await tx.inventoryBalance.create({
          data: {
            id: item.balanceId, tenantId, itemId: item.id, sku: item.sku, warehouseId: WAREHOUSE, warehouseKey: WAREHOUSE, location: 'A-01', locationKey: 'a-01',
            onHandQuantity: 0, availableQuantity: 0, reservedQuantity: 0, unit: item.unit, status: 'active', metadata, itemName: item.name, ...thresholds, riskLevel: 'normal',
          },
        })
      }
      // One order a day with every item that sold that day.
      for (let index = 0; index < days; index += 1) {
        const offset = index - days
        const lines = items.filter((item) => item.daily[index] > 0).map((item) => ({ item, quantity: item.daily[index] }))
        if (!lines.length) continue
        const id = `PUB-SO-${supplier.id.slice(-1)}-${String(index + 1).padStart(3, '0')}`
        await tx.salesOrder.create({
          data: {
            id, tenantId, orderNumber: id, customerId: customer.id, customerName: customer.name, workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled',
            promisedDate: day(offset), currency: instance.currency, metadata, createdAt: at(offset, '09:00'),
          },
        })
        const orderLines = []
        for (const [lineIndex, { item, quantity }] of lines.entries()) {
          const lineId = `${id}-L${String(lineIndex + 1).padStart(2, '0')}`
          await tx.salesOrderLine.create({ data: { id: lineId, salesOrderId: id, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: quantity, unit: item.unit, unitPrice: item.price, amount: money(quantity * item.price), metadata } })
          orderLines.push({ id: lineId, quantity })
        }
        orders.push({ id, offset, shippedAt: '15:00', lines: orderLines })
      }
    }
  }, { timeout: 180000 })

  // 2. Opening stock the day before the window, through the adjustment commands.
  const stock = createInventoryOperationsCommandService({ prisma, env: historyEnv, now: () => at(-days - 1, '07:30') })
  const lines = sets.flatMap(({ items }) => items.map((item) => ({ inventoryBalanceId: item.balanceId, adjustmentQuantity: String(item.onHand + item.units) })))
  let adjustment = (await stock.createAdjustment({ idempotencyKey: `${OPENING_KEY}:create`, reasonCode: 'opening_balance', notes: 'Opening stock for the public data window [assumed].', lines }, { identity: shipper })).adjustment
  adjustment = (await stock.readyAdjustment(adjustment.id, { idempotencyKey: `${OPENING_KEY}:ready`, expectedAdjustmentVersion: adjustment.version }, { identity: shipper })).adjustment
  await stock.postAdjustment(adjustment.id, { idempotencyKey: `${OPENING_KEY}:post`, expectedAdjustmentVersion: adjustment.version }, { identity: shipper })

  // 3. Every order shipped in full on its day, in date order.
  let shipped = 0
  for (const order of orders.sort((a, b) => a.offset - b.offset || a.id.localeCompare(b.id))) {
    if (await shipHistoryOrder(prisma, order, { tenantId, calendar, identity: shipper, env: historyEnv })) shipped += 1
  }

  // 4. The supplier terms [assumed], through the item supplier command.
  for (const { instance, supplier, items } of sets) {
    for (const item of items) {
      await saveItemSupplier(prisma, item.id, null, { supplierId: supplier.id, preferred: true, leadTimeDays: PUBLIC_DATA_ASSUMPTIONS.leadTimeDays, minimumOrderQuantity: item.minimumOrderQuantity, referencePrice: item.price, currency: instance.currency }, shipper.userId, { tenantId })
    }
  }
  return { seedDay: calendar.seedDay, sets: sets.map(({ instance, items }) => ({ set: instance.set, items: items.length })), orders: orders.length, shipped }
}
