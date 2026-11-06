import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addCalendarDays } from '../shared/purchase-request-prefill.mjs'
import { createPrismaClient } from '../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../server/repositories/adapter-registry.mjs'
import { readBusinessContext } from '../server/services/runtime-business-read-service.mjs'
import { buildRuntimeInventoryAllocation } from '../server/domain/runtime-inventory-allocation-read-model.mjs'
import { createReorderListReadService } from '../server/domain/reorder-list-read-service.mjs'
import { DEMAND_WINDOW_DAYS, MIN_SHIPMENT_DAYS, isActiveItem, itemStockUnit, preferredSupplierFor, recordedReorderPoint, shippedByWorkspaceDay } from '../server/domain/reorder-list.mjs'
import { listItemSupplierRecords } from '../server/domain/master-data-commands.mjs'
import { suggestReorderPoint } from '../server/domain/reorder-point-suggestion.mjs'
import { isCommittedPurchaseOrder } from '../server/domain/open-purchase-order.mjs'
import { DEFAULT_TENANT_TIMEZONE, tenantCalendarDay } from '../server/domain/tenant-calendar-day.mjs'

// The inputs a replenishment optimizer needs, as JSON, for one workspace's
// active stock items: on hand, reserved and the open purchase order quantity
// (the reorder list's committed purchase order lines), the recorded reorder
// point and safety stock, the preferred supplier's recorded lead time,
// minimum order quantity and reference price, the last purchase order price,
// and the quantity shipped on each of the 90 days the reorder list's demand
// covers, with the reorder list's own row for comparison, and the suggested
// reorder point the reorder list shows beside the recorded one.
//
// It only reads. Everything is read in one read-only transaction, through the
// same read services as the reorder list, so one export is one consistent
// picture and a write would be refused by the database.
//
//   node scripts/export-replenishment-inputs.mjs [--out=<file>] [--as-of=YYYY-MM-DD]
//   node scripts/export-replenishment-inputs.mjs --walkthrough-dir=<folder> [--pg-port=55433]
//
// The workspace is FLOWCHAIN_DEFAULT_TENANT_ID in the database at
// DATABASE_URL. --walkthrough-dir reads a local walkthrough instead (see
// scripts/walkthrough-local.mjs): its database URL from the folder's
// secrets.json and the port, and its workspace. --as-of reads demand as of
// another workspace day (default today); stock and open orders are always as
// they are now. Without --out the JSON goes to stdout.

// The daily series lives with the reorder list's rules (reorder-list.mjs),
// where the assistant's order plan tool reads it too.
export { shippedByWorkspaceDay }

export const REPLENISHMENT_INPUTS_SCHEMA = 'flowchain.replenishment-inputs.v1'

const text = (value) => String(value ?? '').trim()
const number = (value) => (value === null || value === undefined || value === '' ? null : Number(value))
const round = (value) => Math.round(value * 10000) / 10000

// The last purchase order price for an item: the most recent committed order
// line by order date (cancelled, draft and pending orders are not prices
// agreed with a supplier), optionally from one supplier only.
function lastPurchasePrice(lines, supplierId = null) {
  const line = lines.find((row) => !supplierId || row.purchaseOrder.supplierId === supplierId)
  if (!line) return null
  return {
    unitPrice: number(line.unitPrice),
    currency: line.purchaseOrder.currency,
    unit: line.unit,
    purchaseOrder: line.purchaseOrder.metadata?.orderNumber || line.purchaseOrder.id,
    supplierId: line.purchaseOrder.supplierId,
    supplierName: line.purchaseOrder.supplierName,
    orderedAt: line.purchaseOrder.createdAt.toISOString(),
    status: line.purchaseOrder.status,
  }
}

// A calendar day that exists, in YYYY-MM-DD format.
export function isCalendarDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function readReplenishmentInputs(prisma, { tenantId, asOf = null, env = process.env, now = new Date() } = {}) {
  if (asOf && !isCalendarDay(asOf)) throw new Error(`The as-of day must be a calendar day in YYYY-MM-DD format, not "${asOf}".`)
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, currency: true, timezone: true } })
    if (!tenant) throw new Error(`Workspace ${tenantId} was not found.`)
    const timeZone = tenant.timezone || DEFAULT_TENANT_TIMEZONE
    const today = asOf || tenantCalendarDay(now, timeZone)
    const windowStart = addCalendarDays(today, -DEMAND_WINDOW_DAYS)
    const days = Array.from({ length: DEMAND_WINDOW_DAYS }, (_, index) => addCalendarDays(windowStart, index))

    const context = await readBusinessContext({ repositories: createDatabaseRepositoryRegistry({ env, prisma: tx }), identity: { tenantId } })
    const availability = buildRuntimeInventoryAllocation(context).availability
    const reorderList = await createReorderListReadService({ prisma: tx }).read({
      tenantId, today, timeZone, allocationRows: availability,
      // As the reorder list route does: the context's reads the list depends
      // on (stock, sales orders, purchase orders) report their truncation.
      truncatedSubjects: (context.truncatedSubjects || []).filter((entry) => ['inventory_items', 'sales_orders', 'purchase_orders'].includes(entry?.subject)),
    })
    const [items, suppliers, links, shipmentLines, purchaseLines] = await Promise.all([
      tx.item.findMany({ where: { tenantId }, orderBy: { sku: 'asc' }, select: { id: true, sku: true, name: true, unit: true, status: true, metadata: true, reorderPoint: true, safetyStock: true, preferredSupplierId: true } }),
      tx.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true, status: true } }),
      listItemSupplierRecords(tx, tenantId),
      // The reorder list's shipment read: posted shipments, a day either side
      // of the window, kept by their workspace day.
      tx.shipmentLine.findMany({
        where: { shipment: { tenantId, postingStatus: 'posted', postedAt: { gte: new Date(`${addCalendarDays(today, -DEMAND_WINDOW_DAYS - 1)}T00:00:00Z`), lt: new Date(`${addCalendarDays(today, 1)}T12:00:00Z`) } } },
        select: { itemId: true, unit: true, postedQuantity: true, shipment: { select: { postedAt: true } } },
      }),
      tx.purchaseOrderLine.findMany({
        where: { purchaseOrder: { tenantId } },
        select: { id: true, itemId: true, unit: true, unitPrice: true, purchaseOrder: { select: { id: true, status: true, supplierId: true, supplierName: true, currency: true, createdAt: true, metadata: true } } },
        orderBy: [{ purchaseOrder: { createdAt: 'desc' } }, { id: 'asc' }],
      }),
    ])
    // A local walkthrough records the day it was seeded and the random seed
    // of its shipment history (scripts/setup-local-scenario.mjs).
    const [seededReceipt, historyOrder] = await Promise.all([
      tx.receivingDocument.findFirst({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-GRN-' } }, select: { metadata: true } }),
      tx.salesOrder.findFirst({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-SO-1' } }, select: { metadata: true } }),
    ])
    const purchaseLineById = new Map(purchaseLines.map((row) => [row.id, row]))
    const suppliersById = new Map(suppliers.map((row) => [row.id, row]))
    const availabilityBySku = new Map(availability.map((row) => [row.sku, row]))
    const reorderRowBySku = new Map(reorderList.rows.map((row) => [row.sku, row]))
    const notJudgedBySku = new Map(reorderList.notJudged.map((row) => [row.sku, row.reason]))

    const exported = []
    for (const item of items.filter(isActiveItem)) {
      const unit = itemStockUnit(item)
      const stock = availabilityBySku.get(item.sku)
      const itemShipmentLines = shipmentLines.filter((row) => row.itemId === item.id).map((row) => ({ unit: row.unit, quantity: Number(row.postedQuantity), postedAt: row.shipment.postedAt }))
      const { byDay: shippedByDay, otherUnitLines, unitsMixed } = shippedByWorkspaceDay({
        lines: itemShipmentLines,
        stockUnit: unit,
        days,
        timeZone,
      })
      const supplier = preferredSupplierFor(item, links, suppliersById)
      const suggestion = suggestReorderPoint({ lines: itemShipmentLines, stockUnit: unit, leadTimeDays: supplier?.leadTimeDays ?? null, today, timeZone })
      const link = supplier ? links.find((row) => row.payload?.itemId === item.id && row.payload?.supplierId === supplier.id) : null
      const committedLines = purchaseLines.filter((row) => row.itemId === item.id && isCommittedPurchaseOrder(row.purchaseOrder))
      const reorderRow = reorderRowBySku.get(item.sku)
      const incomingLines = stock?.incomingLines || []
      const shipped = days.map((day) => shippedByDay.get(day))
      const shippedWeekdays = days.filter((day) => ![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())).map((day) => shippedByDay.get(day))
      const nonZero = shipped.filter((value) => value > 0)
      const nonZeroMean = nonZero.length ? nonZero.reduce((sum, value) => sum + value, 0) / nonZero.length : null
      exported.push({
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        unit: unit || null,
        onHand: stock?.onHand ?? null,
        reserved: stock?.reserved ?? null,
        available: stock?.available ?? null,
        openPurchaseOrderQuantity: stock ? round(incomingLines.reduce((sum, line) => sum + Number(line.remaining), 0)) : null,
        // Each committed line with what is still to receive, the day it is
        // due and whether that day has passed, its price, and whether the
        // reorder list counts it in the stock position: every open line, late
        // or not (null when the list has no row for the item).
        openPurchaseOrderLines: incomingLines.map((line, index) => {
          const recorded = purchaseLineById.get(line.lineId)
          return {
            purchaseOrder: line.orderNumber || line.purchaseOrderId,
            supplierName: recorded?.purchaseOrder.supplierName || null,
            status: recorded?.purchaseOrder.status || null,
            remaining: Number(line.remaining),
            dueDay: line.dueDay || null,
            late: Boolean(line.dueDay) && line.dueDay < today,
            unitPrice: number(recorded?.unitPrice),
            currency: recorded?.purchaseOrder.currency || null,
            // The reorder list lists the same lines in the same order.
            countedInPosition: reorderRow?.incomingLines[index] ? true : null,
          }
        }),
        // As recorded on the item; null when none is (the reorder list does not check the item then).
        reorderPoint: recordedReorderPoint(item),
        safetyStock: number(item.safetyStock) || null,
        // The suggested reorder point (server/domain/reorder-point-suggestion.mjs):
        // the rank-th smallest of the windowCount circular sums of coverDays
        // (lead time + reviewDays) consecutive days of dailyShipped, rounded up
        // to a whole unit; null with a reason when there is none. Every
        // active item gets one, listed on the reorder list or not.
        suggestedReorderPoint: suggestion.suggestedReorderPoint,
        reorderPointSuggestion: {
          coverDays: suggestion.coverDays,
          leadTimeDays: suggestion.leadTimeDays,
          reviewDays: suggestion.reviewDays,
          windowCount: suggestion.windowCount,
          rank: suggestion.rank,
          inStockTarget: suggestion.inStockTarget,
          reason: suggestion.reason,
        },
        preferredSupplier: supplier ? {
          id: supplier.id,
          code: supplier.code,
          name: supplier.name,
          leadTimeDays: supplier.leadTimeDays,
          minimumOrderQuantity: supplier.minimumOrderQuantity,
          referencePrice: number(link?.payload?.referencePrice),
          currency: text(link?.payload?.currency) || null,
        } : null,
        lastPurchasePrice: lastPurchasePrice(committedLines),
        lastPurchasePriceFromPreferredSupplier: supplier ? lastPurchasePrice(committedLines, supplier.id) : null,
        demand: {
          shippedQuantity: round(shipped.reduce((sum, value) => sum + value, 0)),
          shipmentDays: nonZero.length,
          otherUnitLines,
          // Without a stock unit: the units the lines are in, none of them added.
          unitsMixed,
          // The reorder list's average: shipped / 90, only with at least 8 shipment days.
          averageDailyDemand: reorderRow?.demand.averageDailyDemand ?? null,
          // Demand shape over the window's weekdays: average interval between
          // shipment days, and the squared coefficient of variation of the
          // quantities on the days something shipped.
          weekdays: shippedWeekdays.length,
          averageIntervalWeekdays: nonZero.length ? round(shippedWeekdays.length / shippedWeekdays.filter((value) => value > 0).length) : null,
          squaredVariation: nonZero.length > 1 ? round(nonZero.reduce((sum, value) => sum + (value - nonZeroMean) ** 2, 0) / nonZero.length / nonZeroMean ** 2) : null,
        },
        dailyShipped: days.map((day) => ({ day, quantity: shippedByDay.get(day) })),
        // What the deployed reorder list (buildReorderList) says today. qRule
        // is the quantity its purchase request asks for: the shortfall below
        // the reorder point, raised to the supplier's minimum order; 0 when
        // the item is above its reorder point; null when it is not checked or
        // the person enters the quantity.
        reorderList: reorderRow
          ? {
              listed: true, orderByDate: reorderRow.orderByDate, orderNow: reorderRow.orderNow, daysUntilOrderBy: reorderRow.daysUntilOrderBy,
              position: reorderRow.position, shortfall: reorderRow.shortfall,
              qRule: reorderRow.shortfall > 0 ? reorderRow.purchaseRequest.quantity : 0,
              raisedToMinimum: reorderRow.purchaseRequest.raisedToMinimum,
              flags: reorderRow.flags.map((flag) => flag.code),
            }
          : { listed: false, qRule: null, reason: notJudgedBySku.get(item.sku) || (recordedReorderPoint(item) === null ? 'no_reorder_point' : 'above_reorder_point_without_history') },
      })
    }
    return {
      schema: REPLENISHMENT_INPUTS_SCHEMA,
      generatedAt: now.toISOString(),
      workspace: { tenantId: tenant.id, name: tenant.name, currency: tenant.currency, timeZone },
      today,
      scenario: seededReceipt?.metadata?.scenarioAsOf
        ? { seedDay: seededReceipt.metadata.scenarioAsOf, version: historyOrder?.metadata?.localDemoScenarioVersion ?? seededReceipt.metadata.localDemoScenarioVersion ?? null, historyRandomSeed: historyOrder?.metadata?.historyRandomSeed ?? null }
        : null,
      demandWindow: { firstDay: windowStart, lastDay: addCalendarDays(today, -1), days: DEMAND_WINDOW_DAYS, minShipmentDays: MIN_SHIPMENT_DAYS },
      notes: [
        'Quantities are in each item\'s stock unit. Open purchase order quantity is the unreceived remainder of committed lines (approved, issued, partially received) in that unit.',
        'The reorder list\'s stock position is on hand - reserved + every open purchase order line, whatever its due day. A line past its due day is marked late and still counts.',
        'Minimum order quantity and lead time are what the item-supplier link records; null means not recorded.',
        'Last purchase price is the most recent committed purchase order line by order date, in the order\'s currency.',
        'Transfers are not considered; stock is summed over every warehouse.',
      ],
      dataLimitations: reorderList.dataLimitations,
      items: exported,
    }
  }, { timeout: 120000 })
}

// The walkthrough's database URL and workspace, from its data folder.
function walkthroughEnv(directory, port) {
  const secrets = JSON.parse(readFileSync(join(directory, 'secrets.json'), 'utf8'))
  const user = 'flowchain_walkthrough'
  return {
    DATABASE_URL: `postgresql://${user}:${encodeURIComponent(secrets.password)}@127.0.0.1:${port}/flowchain_walkthrough?schema=public`,
    FLOWCHAIN_DEFAULT_TENANT_ID: 'tenant-flowchain-walkthrough',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const option = (name) => process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  const directory = option('walkthrough-dir')
  const env = directory
    ? { ...process.env, ...walkthroughEnv(resolve(directory), Number(option('pg-port') || process.env.FLOWCHAIN_WALKTHROUGH_PG_PORT || 55433)) }
    : process.env
  if (!text(env.DATABASE_URL)) throw new Error('Set DATABASE_URL, or pass --walkthrough-dir=<folder>.')
  const asOf = option('as-of')
  if (asOf && !isCalendarDay(asOf)) throw new Error(`--as-of must be a calendar day in YYYY-MM-DD format, not "${asOf}".`)
  const prisma = await createPrismaClient(env)
  try {
    const inputs = await readReplenishmentInputs(prisma, { tenantId: text(env.FLOWCHAIN_DEFAULT_TENANT_ID) || 'tenant-flowchain-local', asOf: asOf || null, env })
    const json = `${JSON.stringify(inputs, null, 2)}\n`
    const out = option('out')
    if (out) {
      writeFileSync(resolve(out), json)
      console.error(`Replenishment inputs for ${inputs.items.length} items, as of ${inputs.today}, written to ${resolve(out)}`)
    } else {
      process.stdout.write(json)
    }
  } finally {
    await prisma.$disconnect()
  }
}
