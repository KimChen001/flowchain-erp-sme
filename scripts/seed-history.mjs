// Helpers for seeding dated history into a local workspace through the same
// commands a person's actions go through: the seed calendar, an actor allowed
// to post, and shipping one confirmed sales order in full as of its day.
// Used by the public data seed (scripts/public-data/seed.mjs), the public data
// evaluation seed (scripts/setup-public-data-scenario.mjs) and the test
// fixture (tests/fixtures/sample-workspace).
import { resolveProvisionedActor } from '../server/domain/pilot-identity.mjs'
import { authorize } from '../server/auth/authorization-service.mjs'
import { createOutboundPostingCommandService } from '../server/domain/outbound-posting-command-service.mjs'

// Calendar arithmetic in the tenant's timezone. A date-only value (a promised
// date, a due date) is stored at 12:00 UTC of that calendar day, which reads as
// the same day in every timezone the app is used in and in the report code
// that slices ISO dates. A timestamp is the local wall-clock time in UTC.
export function localCalendarDay(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function parseAsOf(value, timeZone) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('The scenario as-of date is not a valid date.')
    return localCalendarDay(value, timeZone)
  }
  const text = String(value ?? '').trim()
  const parsed = new Date(`${text}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`The scenario as-of date must be a calendar date in YYYY-MM-DD format, not "${text}".`)
  }
  return text
}

function timeZoneOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant).map((part) => [part.type, part.value]))
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant.getTime()
}

// Day offsets from the seed day: day(0) is the seed day, day(-1) yesterday.
export function scenarioCalendar(asOf, timeZone) {
  const seedDay = parseAsOf(asOf, timeZone)
  const [year, month, dayOfMonth] = seedDay.split('-').map(Number)
  const dayOf = (offset) => new Date(Date.UTC(year, month - 1, dayOfMonth + offset, 12))
  return {
    seedDay,
    day: dayOf,
    isoDay: (offset) => dayOf(offset).toISOString().slice(0, 10),
    at(offset, time) {
      const [hour, minute] = time.split(':').map(Number)
      const date = dayOf(offset)
      const wallClock = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute)
      const guess = new Date(wallClock - timeZoneOffsetMs(new Date(wallClock), timeZone))
      return new Date(wallClock - timeZoneOffsetMs(guess, timeZone))
    },
  }
}

// The first active user (by email) whose roles allow every permission.
export async function scenarioActor(prisma, tenantId, permissions, documents) {
  const users = await prisma.user.findMany({ where: { tenantId, status: 'active' }, orderBy: { email: 'asc' } })
  for (const user of users) {
    const identity = { authenticated: true, tenantId, userId: user.id, role: user.role, name: user.name, source: 'local_walkthrough_scenario' }
    try {
      const actor = await resolveProvisionedActor(prisma, identity)
      if (permissions.every((permission) => authorize({ actor, permission, tenantId }).allowed)) return identity
    } catch {
      // A user without a complete role assignment cannot post; try the next one.
    }
  }
  throw new Error(`No active workspace user may post ${documents}. Run pilot:setup first.`)
}

export const HISTORY_PERMISSIONS = ['inventory.adjustment.create', 'inventory.adjustment.approve', 'inventory.adjustment.post', 'shipment.prepare', 'shipment.post']

// Ships one confirmed sales order in full as of its day: reserve, draft and
// post through the outbound commands. order = { id, offset, shippedAt,
// lines: [{ id, quantity }] }. Resumes a run that stopped between the steps;
// returns false when the order was already shipped or is not confirmed.
export async function shipHistoryOrder(prisma, order, { tenantId, calendar, identity, env, warehouseId = 'LOCAL-DEMO-WH-001', location = 'A-01', keyPrefix = 'local-walkthrough-scenario' }) {
  // The order's one shipment, found by the order (the server numbers it).
  const posted = await prisma.shipmentDocument.findFirst({ where: { tenantId, salesOrderId: order.id }, orderBy: { createdAt: 'asc' } })
  if (posted && (posted.postingStatus !== 'unposted' || posted.workflowStatus === 'cancelled')) return false
  const service = createOutboundPostingCommandService({ prisma, env, now: () => calendar.at(order.offset, order.shippedAt) })
  const key = (step) => `${keyPrefix}:${step}:${order.id}`
  let salesOrder = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { reservations: true } })
  if (salesOrder.workflowStatus !== 'confirmed') return false
  const reservedInFull = (line) => salesOrder.reservations.some((row) => row.salesOrderLineId === line.id && Number(row.reservedQuantity) === line.quantity && Number(row.consumedQuantity) === 0 && Number(row.releasedQuantity) === 0)
  if (salesOrder.reservations.length && !order.lines.every(reservedInFull)) return false
  if (!salesOrder.reservations.length) {
    await service.reserveSalesOrderInventory({
      idempotencyKey: key('reserve'), salesOrderId: order.id, expectedOrderVersion: salesOrder.version,
      allocations: order.lines.map((line) => ({ salesOrderLineId: line.id, warehouseId, location, quantity: String(line.quantity) })),
    }, { identity })
    salesOrder = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { reservations: true } })
  }
  let shipment = posted
  if (!shipment) {
    const reservationOf = new Map(salesOrder.reservations.map((row) => [row.salesOrderLineId, row]))
    const created = await service.createShipmentDraft({
      idempotencyKey: key('draft'), salesOrderId: order.id, expectedOrderVersion: salesOrder.version,
      lines: order.lines.map((line) => ({ salesOrderLineId: line.id, allocations: [{ reservationId: reservationOf.get(line.id).id, quantity: String(line.quantity) }] })),
    }, { identity })
    shipment = await prisma.shipmentDocument.findUniqueOrThrow({ where: { id: created.shipment.id } })
  }
  await service.postShipment({ idempotencyKey: key('post'), shipmentId: shipment.id, expectedShipmentVersion: shipment.version }, { identity })
  return true
}
