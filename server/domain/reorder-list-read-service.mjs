import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { findManyWithinLimit, requireTenantId } from '../repositories/repository-read-scope.mjs'
import { listItemSupplierRecords } from './master-data-commands.mjs'
import { DEMAND_WINDOW_DAYS, buildReorderList } from './reorder-list.mjs'

// Reads what the reorder list needs from the workspace's records, scoped to
// its tenant: items as stored (the recorded reorder point, never the balance
// row's, which falls back to safety stock), posted shipments of the demand
// window, item-supplier links as stored and suppliers. Stock and incoming come
// in as the runtime allocation model's rows over every warehouse.
//
// A reader who sees only some of the workspace's warehouses gets every item
// with a reorder point listed as not checked: the reorder point is one figure
// for the whole item, and incoming purchase orders name no warehouse, so no
// part of the stock is set against it. Nothing else is read for that reader.

const ITEM_LIMIT = 2000
const SHIPMENT_LINE_LIMIT = 20000

export function createReorderListReadService({ prisma }) {
  return {
    async read({ tenantId, warehouseIds = null, today, timeZone, allocationRows = [], showPurchaseOrders = true, truncatedSubjects = [] }) {
      const scopedTenantId = requireTenantId({ tenantId })
      const truncated = new Map(truncatedSubjects.map((entry) => [entry.subject, entry]))
      const onTruncated = (entry) => truncated.set(entry.subject, entry)
      const warehouses = await prisma.warehouse.findMany({ where: { tenantId: scopedTenantId }, select: { id: true } })
      // A reader whose scope holds every warehouse of the workspace reads all of them.
      const scopeIds = Array.isArray(warehouseIds) && !(warehouses.length && warehouses.every((row) => warehouseIds.includes(row.id))) ? warehouseIds : null
      // Posting instants a day either side of the window; the rules keep the
      // ones on a window day in the workspace timezone.
      const from = new Date(`${addCalendarDays(today, -DEMAND_WINDOW_DAYS - 1)}T00:00:00Z`)
      const to = new Date(`${addCalendarDays(today, 1)}T12:00:00Z`)
      const [items, shipmentRows, supplierLinks, suppliers] = await Promise.all([
        findManyWithinLimit(prisma.item, {
          where: { tenantId: scopedTenantId },
          select: { id: true, sku: true, name: true, unit: true, reorderPoint: true, metadata: true, preferredSupplierId: true, status: true },
          orderBy: [{ sku: 'asc' }],
        }, { limit: ITEM_LIMIT, subject: 'items', onTruncated }),
        // A reversed shipment is no longer posted, so it drops out.
        scopeIds ? [] : findManyWithinLimit(prisma.shipmentLine, {
          where: { shipment: { tenantId: scopedTenantId, postingStatus: 'posted', postedAt: { gte: from, lt: to } } },
          select: { id: true, itemId: true, unit: true, postedQuantity: true, shipment: { select: { postedAt: true } } },
          orderBy: [{ id: 'asc' }],
        }, { limit: SHIPMENT_LINE_LIMIT, subject: 'shipment_lines', onTruncated }),
        scopeIds ? [] : listItemSupplierRecords(prisma, scopedTenantId),
        scopeIds ? [] : prisma.supplier.findMany({ where: { tenantId: scopedTenantId }, select: { id: true, code: true, name: true, status: true } }),
      ])
      const shipmentLines = shipmentRows.map((line) => ({
        itemId: line.itemId,
        unit: line.unit,
        postedAt: line.shipment?.postedAt?.toISOString?.() || null,
        quantity: Number(line.postedQuantity),
      }))
      const list = buildReorderList({
        allocationRows: scopeIds ? [] : allocationRows,
        items,
        shipmentLines,
        supplierLinks,
        suppliers,
        today,
        timeZone,
        scope: { warehouseIds: scopeIds, totalWarehouses: warehouses.length },
        showPurchaseOrders,
      })
      return {
        ...list,
        dataLimitations: ['transfers_not_considered', ...[...truncated.values()].map((entry) => `truncated:${entry.subject}`)],
        truncatedSubjects: [...truncated.values()],
      }
    },
  }
}
