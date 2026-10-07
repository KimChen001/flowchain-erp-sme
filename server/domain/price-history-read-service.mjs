import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { requireTenantId } from '../repositories/repository-read-scope.mjs'
import {
  PRICE_HISTORY_AVERAGE_LIMIT,
  PRICE_HISTORY_MAX_KEYS,
  PRICE_HISTORY_STATUSES,
  maskPriceHistory,
  parsePriceHistoryKey,
  priceHistoryForKey,
} from '../../shared/price-history.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay } from './tenant-calendar-day.mjs'

// Reads the price history of items from the workspace's own purchase orders
// for the forms where a person enters or reviews a price (the purchase request
// form, the PO lines, the supplied items of a supplier, RFQ quotations).
// Rules in shared/price-history.mjs.
//
// One query answers every key: the latest 3 lines of each item, unit and
// currency, scoped to the reader's workspace. Every other unit and currency an
// item was bought in has its own latest line in the result, so "in EUR, not
// compared" needs no second query. Each row also carries the full count of
// the item's lines without a unit in its currency, which the 3-line cut would
// otherwise truncate.
//
// A key may name a supplier (a supplier's page): that item is then read for
// that supplier's POs only, in the same query. Each (item, supplier) pair is
// its own scope, '' meaning any supplier, and every row carries the scope it
// was read for, so one item read for any supplier and for one supplier never
// mixes. A supplierId query parameter names the supplier for every key that
// does not name one.
//
// A PO page leaves its own PO out. An issued PO (or one received) sees only
// POs dated before it, so a later purchase is never shown as "earlier"; a PO
// not issued yet sees the latest history. Reading needs procurement.purchase_order.read;
// prices need procurement.prices.read, else they come back null.

export class PriceHistoryError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'PriceHistoryError'
    this.code = code
    this.status = status
  }
}

const text = (value) => String(value ?? '').trim()

const LINES_SQL = `
WITH bound AS (
  SELECT COALESCE(self."issuedAt", self."createdAt") AS "before"
  FROM "PurchaseOrder" AS self
  WHERE $5::text IS NOT NULL
    AND self.id = $5::text
    AND self."tenantId" = $1
    AND self.status = ANY($3::text[])
),
scope AS (
  SELECT DISTINCT pair."itemId", pair."supplierId"
  FROM unnest($2::text[], $6::text[]) AS pair("itemId", "supplierId")
),
counted AS (
  SELECT
    scope."supplierId" AS "scopeSupplierId",
    line.id AS "lineId",
    po.id AS "purchaseOrderId",
    po.metadata->>'orderNumber' AS "orderNumber",
    po."supplierId" AS "supplierId",
    po."supplierName" AS "supplierName",
    line."itemId" AS "itemId",
    line.unit AS unit,
    po.currency AS currency,
    line."unitPrice"::text AS "unitPrice",
    line."orderedQuantity"::text AS "orderedQuantity",
    po."issuedAt" AS "issuedAt",
    po."createdAt" AS "createdAt",
    po.status AS status,
    po."receivingBaseStatus" AS "receivingBaseStatus",
    (COUNT(*) FILTER (WHERE btrim(COALESCE(line.unit, '')) = '') OVER (
      PARTITION BY scope."supplierId", line."itemId", upper(btrim(po.currency))
    ))::int AS "unitNotRecordedCount",
    ROW_NUMBER() OVER (
      PARTITION BY scope."supplierId", line."itemId", lower(btrim(line.unit)), upper(btrim(po.currency))
      ORDER BY COALESCE(po."issuedAt", po."createdAt") DESC, po.id ASC, line.id ASC
    ) AS position
  FROM scope
  JOIN "PurchaseOrderLine" AS line ON line."itemId" = scope."itemId"
  JOIN "PurchaseOrder" AS po ON po.id = line."purchaseOrderId"
  WHERE po."tenantId" = $1
    AND (scope."supplierId" = '' OR po."supplierId" = scope."supplierId")
    AND line."unitPrice" IS NOT NULL
    AND po.status = ANY($3::text[])
    AND ($5::text IS NULL OR po.id <> $5::text)
    AND NOT EXISTS (SELECT 1 FROM bound WHERE COALESCE(po."issuedAt", po."createdAt") >= bound."before")
)
SELECT "scopeSupplierId", "lineId", "purchaseOrderId", "orderNumber", "supplierId", "supplierName", "itemId", unit, currency, "unitPrice", "orderedQuantity", "issuedAt", "createdAt", status, "receivingBaseStatus", "unitNotRecordedCount"
FROM counted
WHERE position <= $4::int
ORDER BY "scopeSupplierId" ASC, "itemId" ASC, "purchaseOrderId" ASC, "lineId" ASC`

// The latest lines per item, unit and currency for these items in one
// workspace, for any supplier (`itemIds`) or per (item, supplier) scope
// (`scopes`, supplierId '' for any supplier). A PO page leaves its own PO
// out, so it is not its own history, and an issued PO sees only POs dated
// before it.
export async function readPriceHistoryLines(prisma, { tenantId, itemIds = [], scopes = [], excludePurchaseOrderId = null }) {
  const scopedTenantId = requireTenantId({ tenantId })
  const pairs = [...itemIds.map((itemId) => ({ itemId, supplierId: '' })), ...scopes]
    .map((pair) => ({ itemId: text(pair.itemId), supplierId: text(pair.supplierId) }))
    .filter((pair, index, list) => pair.itemId && list.findIndex((other) => other.itemId === pair.itemId && other.supplierId === pair.supplierId) === index)
  if (!pairs.length) return []
  return prisma.$queryRawUnsafe(
    LINES_SQL,
    scopedTenantId,
    pairs.map((pair) => pair.itemId),
    [...PRICE_HISTORY_STATUSES],
    PRICE_HISTORY_AVERAGE_LIMIT,
    text(excludePurchaseOrderId) || null,
    pairs.map((pair) => pair.supplierId),
  )
}

// The keys asked for; a supplierId given apart applies to every key that
// does not name a supplier itself.
export function parsePriceHistoryKeys(values, { supplierId = null } = {}) {
  const keys = (Array.isArray(values) ? values : [values]).filter((value) => text(value))
  if (!keys.length) throw new PriceHistoryError('PRICE_HISTORY_KEY_REQUIRED', 'Name at least one item as key=itemId|unit|currency.', 422)
  if (keys.length > PRICE_HISTORY_MAX_KEYS) throw new PriceHistoryError('PRICE_HISTORY_TOO_MANY_KEYS', `Ask for at most ${PRICE_HISTORY_MAX_KEYS} items at a time.`, 422)
  return keys.map((value) => {
    const key = parsePriceHistoryKey(value)
    if (!key.itemId || !key.currency) throw new PriceHistoryError('PRICE_HISTORY_KEY_INVALID', 'Each key needs an item and a currency: itemId|unit|currency.', 422)
    return key.supplierId || !text(supplierId) ? key : { ...key, supplierId: text(supplierId) }
  })
}

export function createPriceHistoryReadService({ prisma, env = process.env, resolveActor = resolveProvisionedActor } = {}) {
  const db = async () => prisma || getPrismaClient(env)
  return {
    async read(keyValues, context, { excludePurchaseOrderId = null, supplierId = null } = {}) {
      const keys = parsePriceHistoryKeys(keyValues, { supplierId })
      const client = await db()
      const actor = await resolveActor(client, context?.identity || context)
      assertAuthorized({ actor, permission: 'procurement.purchase_order.read', tenantId: actor.tenantId })
      const prices = can({ actor, permission: 'procurement.prices.read', tenantId: actor.tenantId })
      const itemIds = [...new Set(keys.map((key) => key.itemId))]
      const scopes = keys.map((key) => ({ itemId: key.itemId, supplierId: key.supplierId }))
      const [lines, items, tenant] = await Promise.all([
        readPriceHistoryLines(client, { tenantId: actor.tenantId, scopes, excludePurchaseOrderId }),
        client.item.findMany({ where: { tenantId: actor.tenantId, id: { in: itemIds } }, select: { id: true, unit: true } }),
        client.tenant.findUnique({ where: { id: actor.tenantId }, select: { timezone: true } }),
      ])
      const timeZone = text(tenant?.timezone) || DEFAULT_TENANT_TIMEZONE
      const dayOf = (instant) => instantCalendarDay(instant, timeZone)
      const itemUnits = new Map(items.map((item) => [item.id, text(item.unit)]))
      const histories = keys.map((key) => {
        const history = priceHistoryForKey(lines, key, { dayOf, itemUnit: itemUnits.get(key.itemId) || '' })
        return prices ? history : maskPriceHistory(history)
      })
      return {
        histories,
        timeZone,
        priceLabel: 'purchase_order_price',
        ...(prices ? {} : { restrictedFields: ['unitPrice'] }),
      }
    },
  }
}
