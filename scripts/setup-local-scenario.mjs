import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { localDemoSupplier } from './setup-local-demo.mjs'
import { PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS } from '../server/domain/procurement-status-authority.mjs'
import { isCommittedPurchaseOrder } from '../server/domain/open-purchase-order.mjs'
import { createReceivingPostingCommandService } from '../server/domain/receiving-posting-command-service.mjs'
import { applyPromisedDateChanges, recordOriginalPromises } from '../server/domain/purchase-order-promise-dates.mjs'
import { resolveProvisionedActor } from '../server/domain/pilot-identity.mjs'
import { authorize } from '../server/auth/authorization-service.mjs'
import { contractsEnabled } from '../server/domain/contract-policy.mjs'
import { createOutboundPostingCommandService } from '../server/domain/outbound-posting-command-service.mjs'
import { createInventoryOperationsCommandService } from '../server/domain/inventory-operations-command-service.mjs'
import { listItemSupplierRecords, saveItemSupplier } from '../server/domain/master-data-commands.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// The US walkthrough scenario. Every date is an offset from the seed day in the
// tenant's timezone, so overdue orders, receipt timeliness and invoice aging
// have something to show. The same seed day always produces the same rows;
// pass { asOf: 'YYYY-MM-DD' } (or --as-of) to pin it. Identifiers keep the
// LOCAL-DEMO- prefix that the local-status endpoint counts.
//
// Receipts are posted through the receiving posting command service, dated at
// their arrival, so purchase order received quantities, receipt status and
// inventory movements agree. Posted receipts are inventory history: once they
// exist the scenario keeps its first seed day and refuses a different one.
// No payables, payments or journal entries are created.
//
// Since version 8 the workspace also has 12 weeks of customer orders, each
// shipped in full on its order day, so the reorder list has demand to work
// from (see the shipment history below). Its stock starts with one opening stock
// entry, posted through the inventory adjustment commands on the day the
// workspace went live; the orders are reserved, drafted and posted through the
// outbound commands as of their shipping time, in date order with the
// receipts, so stock never goes below zero. On-hand quantities at the seed day
// are the same as before: the opening stock is version 7's opening stock plus
// everything the history ships.
export const LOCAL_SCENARIO_VERSION = 8
const WAREHOUSE = 'LOCAL-DEMO-WH-001'
const BUYERS = ['Kim', 'Dana Whitfield']
const RECEIVER = 'Luis Ortega'
const customerName = 'Redwood Retail'
const SALES_TAX_RATE = 0.0825

const items = Object.freeze({
  'LDM-001': { id: 'LOCAL-DEMO-ITEM-001', name: 'Flow Controller', unit: 'pcs' },
  'LDM-002': { id: 'LOCAL-DEMO-ITEM-002', name: 'Temperature Sensor', unit: 'pcs' },
  'LDM-003': { id: 'LOCAL-DEMO-ITEM-003', name: 'Shipping Carton', unit: 'box' },
  'LDM-004': { id: 'LOCAL-DEMO-ITEM-004', name: 'Stainless Steel Fastener', unit: 'pcs' },
  'LDM-005': { id: 'LOCAL-DEMO-ITEM-005', name: 'Shielded Control Cable', unit: 'ft' },
  'LDM-006': { id: 'LOCAL-DEMO-ITEM-006', name: 'Product Label Roll', unit: 'roll' },
})

// Six suppliers with transactions, all from the shared LOCAL-DEMO master data.
const ACME = 'LOCAL-DEMO-SUP-001'
const SUMMIT = 'LOCAL-DEMO-SUP-002'
const ATLAS = 'LOCAL-DEMO-SUP-003'
const NORTHSTAR = 'LOCAL-DEMO-SUP-005'
const EVERGREEN = 'LOCAL-DEMO-SUP-006'
const PRECISION = 'LOCAL-DEMO-SUP-007'

// Purchase orders. created and promised are day offsets from the seed day.
// promised is the date the supplier first promised; revised is [new promised
// day, day the supplier revised it, reason], recorded as a promise revision
// after issue, as the revise command would.
// Receipts: [receipt number, arrival day, local arrival time, accepted, rejected, rejection reason].
// Invoice: [invoice number, invoice day, unit price billed, entered sales tax, status], due 30 days later
// (Net 30). Every status is a committed one; only INV-001 carries a variance.
const S = PURCHASE_ORDER_STATUS
const purchaseOrders = [
  { n: 1, supplier: ACME, sku: 'LDM-001', qty: 50, price: 100, status: S.PARTIALLY_RECEIVED, created: -21, promised: -4, priority: 'medium', request: true,
    receipts: [[1, -6, '10:20', 20, 0]], invoice: [1, -5, 110, 181.5, 'exception'] },
  { n: 2, supplier: ACME, sku: 'LDM-002', qty: 40, price: 100, status: S.ISSUED, created: -10, promised: 4, priority: 'high', request: true },
  { n: 3, supplier: SUMMIT, sku: 'LDM-003', qty: 400, price: 12.5, status: S.FULLY_RECEIVED, created: -150, promised: -136,
    receipts: [[2, -136, '09:10', 400, 0]], invoice: [2, -135, 12.5, 0, 'approved'] },
  { n: 4, supplier: ATLAS, sku: 'LDM-004', qty: 5000, price: 0.4, status: S.FULLY_RECEIVED, created: -120, promised: -106,
    receipts: [[3, -103, '14:45', 5000, 0]], invoice: [3, -102, 0.4, 0, 'approved'] },
  { n: 5, supplier: NORTHSTAR, sku: 'LDM-002', qty: 60, price: 64, status: S.FULLY_RECEIVED, created: -95, promised: -80,
    receipts: [[4, -82, '11:05', 60, 0]], invoice: [4, -80, 64, 0, 'approved'] },
  { n: 6, supplier: EVERGREEN, sku: 'LDM-006', qty: 120, price: 18, status: S.FULLY_RECEIVED, created: -70, promised: -55,
    receipts: [[5, -51, '13:30', 110, 10, 'Damaged roll cores'], [6, -44, '10:00', 10, 0]], invoice: [5, -44, 18, 0, 'matched'] },
  { n: 7, supplier: PRECISION, sku: 'LDM-004', qty: 8000, price: 0.38, status: S.FULLY_RECEIVED, created: -60, promised: -45,
    receipts: [[7, -45, '08:40', 8000, 0]], invoice: [6, -43, 0.38, 0, 'approved'] },
  { n: 8, supplier: ACME, sku: 'LDM-005', qty: 2000, price: 1.85, status: S.FULLY_RECEIVED, created: -40, promised: -25,
    receipts: [[8, -25, '15:15', 2000, 0]], invoice: [7, -24, 1.85, 0, 'matched'] },
  { n: 9, supplier: NORTHSTAR, sku: 'LDM-005', qty: 1500, price: 1.8, status: S.FULLY_RECEIVED, created: -35, promised: -20,
    receipts: [[9, -22, '09:50', 1500, 0]], invoice: [8, -20, 1.8, 0, 'submitted'] },
  { n: 10, supplier: SUMMIT, sku: 'LDM-003', qty: 250, price: 12.75, status: S.FULLY_RECEIVED, created: -30, promised: -16,
    receipts: [[10, -14, '16:10', 250, 0]], invoice: [9, -13, 12.75, 0, 'submitted'] },
  { n: 11, supplier: EVERGREEN, sku: 'LDM-003', qty: 600, price: 12.2, status: S.PARTIALLY_RECEIVED, created: -25, promised: -8, priority: 'high',
    receipts: [[11, -8, '11:40', 300, 0]], invoice: [10, -7, 12.2, 0, 'submitted'] },
  { n: 12, supplier: PRECISION, sku: 'LDM-004', qty: 10000, price: 0.39, status: S.PARTIALLY_RECEIVED, created: -18, promised: -3, priority: 'high',
    receipts: [[12, -2, '14:05', 4000, 500, 'Wrong thread pitch']] },
  { n: 13, supplier: ATLAS, sku: 'LDM-004', qty: 6000, price: 0.41, status: S.PARTIALLY_RECEIVED, created: -14, promised: 3,
    receipts: [[13, -1, '10:35', 2500, 0]] },
  { n: 14, supplier: NORTHSTAR, sku: 'LDM-002', qty: 80, price: 63.5, status: S.PARTIALLY_RECEIVED, created: -20, promised: -6, priority: 'high',
    receipts: [[14, -10, '13:00', 30, 5, 'Missing calibration labels']], invoice: [11, -9, 63.5, 0, 'submitted'] },
  { n: 15, supplier: ACME, sku: 'LDM-001', qty: 40, price: 98, status: S.ISSUED, created: -16, promised: -2, priority: 'high' },
  { n: 16, supplier: SUMMIT, sku: 'LDM-006', qty: 80, price: 17.5, status: S.ISSUED, created: -12, promised: -7 },
  { n: 17, supplier: ATLAS, sku: 'LDM-004', qty: 4000, price: 0.4, status: S.ISSUED, created: -6, promised: 8 },
  { n: 18, supplier: NORTHSTAR, sku: 'LDM-005', qty: 1200, price: 1.82, status: S.ISSUED, created: -9, promised: 1 },
  { n: 19, supplier: EVERGREEN, sku: 'LDM-003', qty: 300, price: 12.4, status: S.ISSUED, created: -5, promised: 12 },
  { n: 20, supplier: PRECISION, sku: 'LDM-004', qty: 7000, price: 0.38, status: S.ISSUED, created: -30, promised: -15, priority: 'high' },
  { n: 21, supplier: ACME, sku: 'LDM-002', qty: 25, price: 100, status: S.APPROVED, created: -3, promised: 14 },
  { n: 22, supplier: SUMMIT, sku: 'LDM-003', qty: 200, price: 12.5, status: S.APPROVED, created: -2, promised: 10 },
  { n: 23, supplier: NORTHSTAR, sku: 'LDM-005', qty: 900, price: 1.85, status: S.APPROVED, created: -8, promised: -1, priority: 'high' },
  { n: 24, supplier: ACME, sku: 'LDM-001', qty: 120, price: 100, status: S.PENDING_APPROVAL, created: -2, promised: 21, priority: 'high' },
  { n: 25, supplier: EVERGREEN, sku: 'LDM-006', qty: 150, price: 18.25, status: S.PENDING_APPROVAL, created: -1, promised: 18 },
  { n: 26, supplier: PRECISION, sku: 'LDM-004', qty: 20000, price: 0.37, status: S.PENDING_APPROVAL, created: -4, promised: 25 },
  { n: 27, supplier: ATLAS, sku: 'LDM-004', qty: 3000, price: 0.4, status: S.DRAFT, created: -1, promised: 20 },
  { n: 28, supplier: NORTHSTAR, sku: 'LDM-002', qty: 50, price: 64, status: S.DRAFT, created: 0, promised: 28 },
  { n: 29, supplier: SUMMIT, sku: 'LDM-006', qty: 60, price: 17.75, status: S.DRAFT, created: -3, promised: 15 },
  { n: 30, supplier: ACME, sku: 'LDM-005', qty: 1000, price: 1.95, status: S.CANCELLED, created: -45, promised: -30, sent: true, cancellationReason: 'Replaced by a lower-priced order' },
  { n: 31, supplier: EVERGREEN, sku: 'LDM-003', qty: 500, price: 12.9, status: S.CANCELLED, created: -28, promised: -12, sent: true, cancellationReason: 'Supplier could not meet the delivery date' },
  { n: 32, supplier: ATLAS, sku: 'LDM-004', qty: 2500, price: 0.44, status: S.CANCELLED, created: -10, promised: 5, cancellationReason: 'Duplicate order' },
  // Northstar's recent deliveries. Two slipped and were re-promised, then arrived
  // on the new date: late against the original promise, on time against the
  // current date, so its scorecard shows the gap.
  { n: 33, supplier: NORTHSTAR, sku: 'LDM-005', qty: 1000, price: 1.8, status: S.FULLY_RECEIVED, created: -60, promised: -45,
    revised: [-40, -47, 'Supplier moved the ship date after a raw material delay'], receipts: [[15, -41, '10:15', 1000, 0]] },
  { n: 34, supplier: NORTHSTAR, sku: 'LDM-005', qty: 500, price: 1.8, status: S.FULLY_RECEIVED, created: -50, promised: -34,
    revised: [-30, -36, 'Carrier capacity shortage delayed the pickup'], receipts: [[16, -30, '13:20', 500, 0]] },
  { n: 35, supplier: NORTHSTAR, sku: 'LDM-005', qty: 800, price: 1.82, status: S.FULLY_RECEIVED, created: -28, promised: -14,
    receipts: [[17, -14, '09:40', 800, 0]] },
]

// Contracts (docs/contracts-module-design.md, K1), seeded only while the
// contracts capability is on (the walkthrough turns it on; the trial does
// not). Dates are day offsets from the seed day, like the orders, so the
// walkthrough always shows one ending soon, one with notice due and one in
// force: Acme's purchase agreement ends in 45 days (inside its 60-day
// reminder), Horizon's service agreement renews automatically with 30 days'
// notice and ends in 50, so notice is due in 20, and Northstar's quality
// agreement runs into next year. Each is created once, active, with its
// audit rows; a contract already there is never changed by a re-seed. No
// values or files: those are entered by people.
const HORIZON = 'LOCAL-DEMO-SUP-004'
const contracts = [
  { n: 1, supplier: ACME, type: 'purchase_agreement', title: 'Electronic components supply agreement', reference: 'ACME-SA-2025-118',
    signed: -322, start: -320, end: 45, renewal: 'by_agreement', noticeDays: 0, paymentTermsId: 'NET30' },
  { n: 2, supplier: HORIZON, type: 'service_agreement', title: 'Freight and warehousing services agreement', reference: 'HL-SVC-0457',
    signed: -318, start: -315, end: 50, renewal: 'automatic', noticeDays: 30, paymentTermsId: 'NET30' },
  { n: 3, supplier: NORTHSTAR, type: 'quality_agreement', title: 'Supplier quality agreement', reference: 'NSE-QA-2026',
    signed: -68, start: -65, end: 300, renewal: 'by_agreement', noticeDays: 0, paymentTermsId: null },
]

// The shipment history. Every weekday of the 12 whole weeks before the seed
// day (offsets -84 to -1, so each weekday occurs 12 times whatever the seed
// day is, and a reorder list read up to six days after seeding still sees all
// of it) one customer orders: Redwood Retail on Mondays and Thursdays,
// Bluebird Distribution on Tuesdays and Fridays, Metro Service Group on
// Wednesdays. Each order is shipped in full the same afternoon.
//
// Each item has its own demand shape: the weekdays it can be ordered, the
// chance it is on such an order, the mean quantity and the spread of the
// log-normal noise, with demand growing about 20% over the 12 weeks.
//   LDM-002  smooth: on almost every order, little spread (about 10 a day)
//   LDM-001  regular: on most orders, some spread
//   LDM-004  lumpy: on some of Bluebird's orders, in very uneven quantities
//   LDM-006  intermittent: on about one Redwood order in three, in steady quantities
// The draws come from one fixed random seed, in week, weekday and item order,
// so every seed day gets the same orders on its own dates.
const HISTORY_WEEKS = 12
const HISTORY_RANDOM_SEED = 20261103
const REDWOOD = 'LOCAL-DEMO-CUS-001'
const BLUEBIRD = 'LOCAL-DEMO-CUS-002'
const METRO = 'LOCAL-DEMO-CUS-003'
const customerNames = { [REDWOOD]: customerName, [BLUEBIRD]: 'Bluebird Distribution', [METRO]: 'Metro Service Group' }
// [weekday (0 is Sunday), customer, ordered at, shipped at]
const customerOrderDays = [
  [1, REDWOOD, '09:40', '15:30'],
  [2, BLUEBIRD, '08:50', '14:00'],
  [3, METRO, '10:15', '16:00'],
  [4, REDWOOD, '09:40', '15:30'],
  [5, BLUEBIRD, '08:50', '14:00'],
]
// [SKU, weekdays, chance on an order, mean quantity, log-normal spread]
const demandShapes = [
  ['LDM-001', [1, 3, 4, 5], 0.85, 10, 0.3],
  ['LDM-002', [1, 2, 3, 4, 5], 0.95, 16, 0.15],
  ['LDM-003', [1, 2, 4], 0.7, 40, 0.3],
  ['LDM-004', [2, 5], 0.65, 1100, 0.9],
  ['LDM-005', [2, 3, 5], 0.75, 280, 0.55],
  ['LDM-006', [1, 4], 0.42, 22, 0.12],
]
// Cartons ship by 5 boxes, fasteners by 100 pieces, cable by 25 feet, labels by 2 rolls.
const orderMultiples = { 'LDM-003': 5, 'LDM-004': 100, 'LDM-005': 25, 'LDM-006': 2 }
const salesPrices = { 'LDM-001': 180, 'LDM-002': 115, 'LDM-003': 21, 'LDM-004': 0.85, 'LDM-005': 3.4, 'LDM-006': 29 }

// Opening stock, counted the day the workspace went live, before the oldest
// purchase order: version 7's opening stock plus what the history ships.
const OPENING_DAY = -160
const OPENING_ADJUSTMENT = 'LOCAL-DEMO-ADJ-OPENING'
const openingBeforeHistory = { 'LDM-001': 8, 'LDM-002': 60 }

// The preferred source of each item, with the terms a buyer recorded on the
// item-supplier link: lead time in days, minimum order quantity in the stock
// unit and reference price. Saved once through the item supplier command; a
// link already there is never changed.
const supplierTerms = [
  ['LDM-001', ACME, 14, 25, 100],
  ['LDM-002', ACME, 14, 20, 100],
  ['LDM-003', SUMMIT, 12, 100, 12.5],
  ['LDM-004', ATLAS, 14, 2000, 0.4],
  ['LDM-005', ACME, 10, 500, 1.85],
  ['LDM-006', SUMMIT, 10, 50, 17.5],
]

// A small seeded generator (mulberry32): the same seed gives the same numbers
// on every machine.
function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

// The history's orders, without dates: { week, weekday, customerId, orderedAt,
// shippedAt, lines: [{ sku, quantity }] }. Three draws per item that can be
// on the order, whether it is used or not, so one item never shifts another's
// numbers.
function scenarioShipmentHistory() {
  const random = seededRandom(HISTORY_RANDOM_SEED)
  const orders = []
  for (let week = 0; week < HISTORY_WEEKS; week += 1) {
    const growth = 0.9 + (0.2 * week) / (HISTORY_WEEKS - 1)
    for (const [weekday, customerId, orderedAt, shippedAt] of customerOrderDays) {
      const lines = []
      for (const [sku, weekdays, chance, mean, spread] of demandShapes) {
        if (!weekdays.includes(weekday)) continue
        const included = random() < chance
        const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
        const multiple = orderMultiples[sku] || 1
        const quantity = Math.max(multiple, Math.round((mean * growth * Math.exp(spread * normal - (spread * spread) / 2)) / multiple) * multiple)
        if (included) lines.push({ sku, quantity })
      }
      if (!lines.length) throw new Error(`The shipment history drew an empty order in week ${week}; change its random seed.`)
      orders.push({ week, weekday, customerId, orderedAt, shippedAt, lines })
    }
  }
  return orders
}

// The history's orders on the seed day's calendar, oldest first, numbered from
// LOCAL-DEMO-SO-101 with one shipment each.
function scenarioSalesHistory(calendar) {
  const first = -7 * HISTORY_WEEKS
  const firstWeekday = calendar.day(first).getUTCDay()
  return scenarioShipmentHistory()
    .map((order) => ({ ...order, offset: first + 7 * order.week + ((order.weekday - firstWeekday + 7) % 7) }))
    .sort((a, b) => a.offset - b.offset || a.shippedAt.localeCompare(b.shippedAt))
    .map((order, index) => {
      const number = 101 + index
      return { ...order, id: `LOCAL-DEMO-SO-${number}`, shipmentNumber: `LOCAL-DEMO-SHP-${number}`, lines: order.lines.map((line, lineIndex) => ({ ...line, id: `LOCAL-DEMO-SOL-${number}-${lineIndex + 1}` })) }
    })
}

const historyOrderCount = HISTORY_WEEKS * customerOrderDays.length

// Opening stock per SKU: what the walkthrough held before the history, plus
// everything the history ships.
function scenarioOpeningStock() {
  const opening = Object.fromEntries(Object.keys(items).map((sku) => [sku, openingBeforeHistory[sku] || 0]))
  for (const order of scenarioShipmentHistory()) for (const line of order.lines) opening[line.sku] += line.quantity
  return opening
}

const pad = (value) => String(value).padStart(3, '0')
const money = (value) => Math.round(value * 100) / 100
const sentStatuses = new Set([S.ISSUED, S.PARTIALLY_RECEIVED, S.FULLY_RECEIVED])

export const LOCAL_SCENARIO_COUNTS = Object.freeze({
  purchaseRequests: 1,
  rfqs: 1,
  supplierQuotations: 2,
  purchaseOrders: purchaseOrders.length,
  receivingDocuments: purchaseOrders.reduce((sum, po) => sum + (po.receipts?.length || 0), 0),
  supplierInvoices: purchaseOrders.filter((po) => po.invoice).length,
  inventoryBalances: Object.keys(items).length,
  salesOrders: 1 + historyOrderCount,
  shipments: historyOrderCount,
  itemSupplierLinks: supplierTerms.length,
  suppliersWithTransactions: new Set(purchaseOrders.map((po) => po.supplier)).size,
})

// Calendar arithmetic in the tenant's timezone. A date-only value (a promised
// date, a due date) is stored at 12:00 UTC of that calendar day, which reads as
// the same day in every US timezone and in the report code that slices ISO
// dates. A timestamp (an arrival) is the local wall-clock time converted to UTC.
function localCalendarDay(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function parseAsOf(value, timeZone) {
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

const INVOICE_MATCH_STATUS = Object.freeze({ submitted: 'pending', matched: 'matched', approved: 'matched', exception: 'variance' })

// The seed day. Before any receipt is posted it is the requested day (or today);
// afterwards it is the day stored on the posted receipts, because their
// inventory movements are dated history that a re-seed cannot move.
async function scenarioSeedDay(prisma, tenantId, requested, timeZone) {
  const posted = await prisma.receivingDocument.findFirst({
    where: { tenantId, id: { startsWith: 'LOCAL-DEMO-GRN-' }, postingStatus: { not: 'unposted' } },
    select: { metadata: true },
  })
  const anchored = posted?.metadata?.scenarioAsOf
  const hasRequest = requested !== undefined && requested !== null && requested !== ''
  if (!anchored) return parseAsOf(hasRequest ? requested : new Date(), timeZone)
  if (hasRequest && parseAsOf(requested, timeZone) !== anchored) {
    throw new Error(`The walkthrough scenario was seeded for ${anchored} and its receipts are posted to inventory, so it cannot be re-dated to ${parseAsOf(requested, timeZone)}. Seed a fresh database to use another day.`)
  }
  return anchored
}

// The workspace user who posts the walkthrough's documents: the first active
// user, by email, whose roles grant every permission given. pilot:setup
// provisions the roles.
async function scenarioActor(prisma, tenantId, permissions, documents) {
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
  throw new Error(`No active workspace user may post ${documents}. Run pilot:setup before pilot:setup:scenario.`)
}

const HISTORY_PERMISSIONS = ['inventory.adjustment.create', 'inventory.adjustment.approve', 'inventory.adjustment.post', 'shipment.prepare', 'shipment.post']

// Opening stock, once, through the inventory adjustment commands as of the
// day the workspace went live, onto the items' empty stock records at A-01.
// Resumes a run that stopped between the steps.
async function postOpeningStock(prisma, { tenantId, calendar, identity, env }) {
  const service = createInventoryOperationsCommandService({ prisma, env, now: () => calendar.at(OPENING_DAY, '07:30') })
  const key = (step) => `local-walkthrough-scenario:opening-stock:${step}`
  let adjustment = await prisma.inventoryAdjustmentDocument.findFirst({ where: { tenantId, adjustmentNumber: OPENING_ADJUSTMENT } })
  if (!adjustment) {
    const lines = Object.entries(scenarioOpeningStock()).map(([sku, quantity], index) => ({ inventoryBalanceId: `LOCAL-DEMO-BAL-${pad(index + 1)}`, adjustmentQuantity: String(quantity) }))
    const created = await service.createAdjustment({ idempotencyKey: key('create'), adjustmentNumber: OPENING_ADJUSTMENT, reasonCode: 'opening_balance', notes: 'Stock counted when the workspace went live.', lines }, { identity })
    adjustment = created.adjustment
  }
  if (adjustment.workflowStatus === 'draft') adjustment = (await service.readyAdjustment(adjustment.id, { idempotencyKey: key('ready'), expectedAdjustmentVersion: adjustment.version }, { identity })).adjustment
  if (adjustment.postingStatus === 'unposted') await service.postAdjustment(adjustment.id, { idempotencyKey: key('post'), expectedAdjustmentVersion: adjustment.version }, { identity })
}

// One history order, shipped in full from A-01 as of its shipping time:
// reserve, draft the shipment, post it. Each step is skipped once it is done.
async function shipHistoryOrder(prisma, order, { tenantId, calendar, identity, env }) {
  const posted = await prisma.shipmentDocument.findFirst({ where: { tenantId, shipmentNumber: order.shipmentNumber } })
  if (posted?.postingStatus === 'posted') return false
  const service = createOutboundPostingCommandService({ prisma, env, now: () => calendar.at(order.offset, order.shippedAt) })
  const key = (step) => `local-walkthrough-scenario:${step}:${order.id}`
  let salesOrder = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { reservations: true } })
  if (!salesOrder.reservations.length) {
    await service.reserveSalesOrderInventory({
      idempotencyKey: key('reserve'), salesOrderId: order.id, expectedOrderVersion: salesOrder.version,
      allocations: order.lines.map((line) => ({ salesOrderLineId: line.id, warehouseId: WAREHOUSE, location: 'A-01', quantity: String(line.quantity) })),
    }, { identity })
    salesOrder = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id }, include: { reservations: true } })
  }
  let shipment = posted
  if (!shipment) {
    const reservationOf = new Map(salesOrder.reservations.map((row) => [row.salesOrderLineId, row]))
    await service.createShipmentDraft({
      idempotencyKey: key('draft'), salesOrderId: order.id, shipmentNumber: order.shipmentNumber, expectedOrderVersion: salesOrder.version,
      lines: order.lines.map((line) => ({ salesOrderLineId: line.id, allocations: [{ reservationId: reservationOf.get(line.id).id, quantity: String(line.quantity) }] })),
    }, { identity })
    shipment = await prisma.shipmentDocument.findFirstOrThrow({ where: { tenantId, shipmentNumber: order.shipmentNumber } })
  }
  await service.postShipment({ idempotencyKey: key('post'), shipmentId: shipment.id, expectedShipmentVersion: shipment.version }, { identity })
  return true
}

// The preferred-source terms, through the item supplier command. An item that
// already has a link to the supplier keeps it as it is.
async function saveSupplierTerms(prisma, { tenantId, actorId }) {
  let saved = 0
  for (const [sku, supplierId, leadTimeDays, minimumOrderQuantity, referencePrice] of supplierTerms) {
    if ((await listItemSupplierRecords(prisma, tenantId, { itemId: items[sku].id, supplierId })).length) continue
    await saveItemSupplier(prisma, items[sku].id, null, { supplierId, preferred: true, leadTimeDays, minimumOrderQuantity, referencePrice, currency: 'USD' }, actorId, { tenantId })
    saved += 1
  }
  return saved
}

export async function seedLocalScenario(prisma, env = process.env, options = {}) {
  assertLocalDevelopment(env, 'pilot:setup:scenario')
  const tenantId = String(env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local').trim()
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error('Run pilot:setup before pilot:setup:scenario.')
  if (tenant.currency !== 'USD') throw new Error(`The walkthrough scenario is USD business data; workspace ${tenantId} uses ${tenant.currency}.`)
  if (!await prisma.item.findUnique({ where: { id: 'LOCAL-DEMO-ITEM-001' } })) throw new Error('Run pilot:setup:demo before pilot:setup:scenario.')
  const timeZone = tenant.timezone || 'America/New_York'
  const calendar = scenarioCalendar(await scenarioSeedDay(prisma, tenantId, options.asOf ?? env.FLOWCHAIN_SCENARIO_AS_OF, timeZone), timeZone)
  const { day, isoDay, at } = calendar
  const receiver = await scenarioActor(prisma, tenantId, ['receiving.post'], 'receipts')
  const metadata = { localDemo: true, localDemoScenarioVersion: LOCAL_SCENARIO_VERSION, scenarioAsOf: calendar.seedDay }
  // The shipment history needs the opening stock entry first, and opening
  // stock goes only onto stock records with no history. A workspace seeded
  // before version 8 has posted receipts and no opening stock entry, so it
  // keeps its stock as it is and gets no shipment history; seed a fresh
  // database (walkthrough:local -- --reset) to have one.
  const withHistory = Boolean(await prisma.inventoryAdjustmentDocument.findFirst({ where: { tenantId, adjustmentNumber: OPENING_ADJUSTMENT }, select: { id: true } }))
    || !await prisma.receivingDocument.findFirst({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-GRN-' }, postingStatus: { not: 'unposted' } }, select: { id: true } })
  const salesHistory = withHistory ? scenarioSalesHistory(calendar) : []
  const historyEnv = { ...env, FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true', FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true' }
  const shipper = withHistory ? await scenarioActor(prisma, tenantId, HISTORY_PERMISSIONS, 'opening stock and shipments') : null

  // Upsert one scenario row. A row whose version has moved was changed by a
  // business command (a posting, or a change during a walkthrough), so it is
  // left exactly as it is.
  const putWith = (tx) => async (model, id, data) => {
    const existing = await tx[model].findUnique({ where: { id } })
    if (!existing) {
      await tx[model].create({ data: { id, ...data } })
      return true
    }
    if (existing.tenantId && existing.tenantId !== tenantId) throw new Error(`Refusing to overwrite ${model} ${id} in another workspace.`)
    if (Number(existing.version || 0) > 0) return false
    const { tenantId: _tenantId, ...update } = data
    await tx[model].update({ where: { id }, data: update })
    return true
  }

  // 1. Everything up to receipt: purchase orders at their pre-receipt status
  // with nothing received, unposted receipts, opening stock and the rest.
  const unpostedReceipts = await prisma.$transaction(async tx => {
    const put = putWith(tx)
    await put('purchaseRequest', 'LOCAL-DEMO-PR-001', { tenantId, status: PURCHASE_REQUEST_STATUS.SUBMITTED, requester: 'Kim', priority: 'high', requiredDate: day(14), amount: 5000, currency: 'USD', source: 'local_demo_scenario', metadata, createdAt: at(-23, '09:15') })
    await put('purchaseRequestLine', 'LOCAL-DEMO-PRL-001', { purchaseRequestId: 'LOCAL-DEMO-PR-001', itemId: items['LDM-001'].id, sku: 'LDM-001', itemName: items['LDM-001'].name, quantity: 50, unit: 'pcs', unitPrice: 100, amount: 5000, metadata })

    // The RFQ awarded from the purchase request. Quotation revisions are
    // immutable in the database, so they keep the dates of their first seed.
    const rfqLineMetadata = { ...metadata, requiredDate: isoDay(14), deliveryLocation: WAREHOUSE }
    await put('rfq', 'LOCAL-DEMO-RFQ-AWARD-001', {
      tenantId, title: 'Flow Controller RFQ', category: 'Electronic components', status: 'collecting_quotes', supplierCount: 2, respondedSupplierCount: 2,
      dueDate: day(2), sourceRequestId: 'LOCAL-DEMO-PR-001', currency: 'USD', metadata, createdAt: at(-7, '10:00'),
    })
    await put('rfqLine', 'LOCAL-DEMO-RFQL-AWARD-001', { tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', itemId: items['LDM-001'].id, sku: 'LDM-001', itemName: items['LDM-001'].name, quantity: 50, unit: 'pcs', metadata: rfqLineMetadata })
    for (const [suffix, supplierId, amount, unitPrice, submitted, delivery, paymentTerms] of [
      ['001', ACME, 4900, 98, -4, 14, 'NET30'],
      ['002', SUMMIT, 4875, 97.5, -3, 16, 'NET45'],
    ]) {
      const supplierName = localDemoSupplier(supplierId).name
      const quotationId = `LOCAL-DEMO-AWARD-QUOTE-${suffix}`
      const quotationLineId = `LOCAL-DEMO-AWARD-QUOTEL-${suffix}`
      const revisionId = `LOCAL-DEMO-AWARD-REV-${suffix}`
      const submittedAt = at(submitted, '08:30')
      await tx.rfqSupplierParticipation.upsert({
        where: { tenantId_rfqId_supplierId: { tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', supplierId } },
        create: { id: `LOCAL-DEMO-RFQSP-AWARD-${suffix}`, tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', supplierId, status: 'response_recorded', invitedAt: at(-7, '10:30'), respondedAt: submittedAt, metadata },
        update: { status: 'response_recorded', invitedAt: at(-7, '10:30'), respondedAt: submittedAt, metadata },
      })
      await put('supplierQuotation', quotationId, { tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', supplierId, supplierName, status: 'submitted', quotedAmount: amount, currency: 'USD', submittedAt, metadata })
      await put('supplierQuotationLine', quotationLineId, { supplierQuotationId: quotationId, itemId: items['LDM-001'].id, sku: 'LDM-001', itemName: items['LDM-001'].name, quantity: 50, unit: 'pcs', unitPrice, amount, metadata })
      if (!await tx.supplierQuotationRevision.findUnique({ where: { id: revisionId } })) {
        await tx.supplierQuotationRevision.create({
          data: {
            id: revisionId, tenantId, quotationId, revisionNumber: 1, status: 'submitted', currency: 'USD', quotedAmount: amount,
            submittedAt, validUntil: day(30), deliveryDate: day(delivery), paymentTerms, source: 'local_demo_scenario', metadata,
            lines: { create: [{ id: `${revisionId}-LINE-001`, rfqLineId: 'LOCAL-DEMO-RFQL-AWARD-001', sourceQuotationLineId: quotationLineId, itemId: items['LDM-001'].id, skuSnapshot: 'LDM-001', itemNameSnapshot: items['LDM-001'].name, quantity: 50, unit: 'pcs', unitPrice, amount, deliveryDate: day(delivery), metadata }] },
          },
        })
      }
    }

    // One stock record per item at A-01, which opening stock and the
    // walkthrough receipts add to, with the item's own safety stock and
    // reorder point, so the record and the item agree. Created once, empty,
    // for the opening stock entry (before version 8 LDM-001 and LDM-002 held
    // their opening stock directly and the others were created by their first
    // receipt); quantities then belong to inventory. The thresholds keep
    // LDM-001 short after its 20 received pieces.
    for (const [index, sku] of Object.keys(items).entries()) {
      const id = `LOCAL-DEMO-BAL-${pad(index + 1)}`
      const item = await tx.item.findUniqueOrThrow({ where: { id: items[sku].id }, select: { safetyStock: true, reorderPoint: true } })
      const thresholds = { itemName: items[sku].name, safetyStock: item.safetyStock, reorderPoint: item.reorderPoint, riskLevel: sku === 'LDM-001' ? 'shortage' : 'normal' }
      const existing = await tx.inventoryBalance.findUnique({ where: { tenantId_sku_warehouseKey_locationKey: { tenantId, sku, warehouseKey: WAREHOUSE, locationKey: 'a-01' } }, select: { id: true } })
      if (existing) {
        await tx.inventoryBalance.update({ where: { id: existing.id }, data: { ...thresholds, ...(existing.id === id ? { metadata } : {}) } })
        continue
      }
      const onHandQuantity = withHistory ? 0 : openingBeforeHistory[sku] || 0
      await tx.inventoryBalance.create({
        data: {
          id, tenantId, itemId: items[sku].id, sku, warehouseId: WAREHOUSE, warehouseKey: WAREHOUSE, location: 'A-01', locationKey: 'a-01',
          onHandQuantity, availableQuantity: onHandQuantity, reservedQuantity: 0, unit: items[sku].unit, status: 'active', metadata, ...thresholds,
        },
      })
    }

    for (const po of purchaseOrders) {
      const id = `LOCAL-DEMO-PO-${pad(po.n)}`
      const lineId = `${id}-LINE-001`
      const item = items[po.sku]
      const supplierName = localDemoSupplier(po.supplier).name
      const amount = money(po.qty * po.price)
      const receipts = po.receipts || []
      const promisedDate = isoDay(po.promised)
      // An order with receipts is seeded as issued with nothing received;
      // posting its receipts moves it to partially or fully received.
      const status = receipts.length ? S.ISSUED : po.status
      // A sent order records when it was issued, as the Issue action does: at
      // 11:00 on its order day. Written once; a later seed keeps the recorded
      // date, which the database refuses to change.
      const sent = sentStatuses.has(po.status) || po.sent
      const recordedIssuedAt = (await tx.purchaseOrder.findUnique({ where: { id }, select: { issuedAt: true } }))?.issuedAt || null
      const issuedAt = recordedIssuedAt || (sent ? at(po.created, '11:00') : null)
      const poMetadata = {
        ...metadata,
        targetWarehouseId: WAREHOUSE,
        transmissionStatus: sent ? 'sent' : 'not_sent',
        ...(issuedAt ? { issuedAt: new Date(issuedAt).toISOString() } : {}),
        ...(po.cancellationReason ? { cancellationReason: po.cancellationReason } : {}),
      }
      if (await put('purchaseOrder', id, {
        tenantId, status, supplierId: po.supplier, supplierName, sourceRequestId: po.request ? 'LOCAL-DEMO-PR-001' : null,
        expectedDate: day(po.promised), amount, currency: 'USD', owner: BUYERS[po.n % BUYERS.length], priority: po.priority || 'medium', metadata: poMetadata,
        createdAt: at(po.created, '09:30'), receivingBaseStatus: null, issuedAt,
      })) {
        await put('purchaseOrderLine', lineId, {
          purchaseOrderId: id, itemId: item.id, sku: po.sku, itemName: item.name, orderedQuantity: po.qty, receivedQuantity: 0, unit: item.unit, unitPrice: po.price, amount,
          metadata: { ...metadata, targetWarehouseId: WAREHOUSE, requestedDate: promisedDate, promisedDate },
        })
      }
      // A committed order keeps its first promised date, as the approve and
      // issue commands record it; so does a cancelled order that was sent first.
      // Recorded once; a later seed leaves it alone.
      if (isCommittedPurchaseOrder({ status: po.status }) || po.sent) {
        await recordOriginalPromises(tx, { purchaseOrder: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } }) })
      }
      // A revised promise goes through the same helper as the revise command:
      // the original stays, the line moves, and a revision and audit row are
      // written. A later seed finds the line already on the new date and skips it.
      if (po.revised) {
        const [revisedDay, revisedOn, reason] = po.revised
        const ids = [`LOCAL-DEMO-POREV-${pad(po.n)}`, `LOCAL-DEMO-POREV-${pad(po.n)}-AUDIT`]
        await applyPromisedDateChanges(tx, {
          tenantId, purchaseOrder: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } }),
          changes: [{ purchaseOrderLineId: lineId, promisedDate: isoDay(revisedDay) }], reason, actorId: receiver.userId,
          source: 'local_walkthrough_scenario', at: at(revisedOn, '10:00'), idFactory: () => ids.shift(),
        })
      }

      let cumulative = 0
      for (const [number, arrived, time, accepted, rejected, rejectionReason] of receipts) {
        const grnId = `LOCAL-DEMO-GRN-${pad(number)}`
        cumulative += accepted
        const arrivedAt = at(arrived, time)
        if (await put('receivingDocument', grnId, {
          tenantId, documentNumber: grnId, poId: id, supplierId: po.supplier, supplierName, status: cumulative >= po.qty ? 'received' : 'partial',
          workflowStatus: 'received', postingStatus: 'unposted', warehouseId: WAREHOUSE, receiver: RECEIVER, currency: 'USD', arrivedAt, metadata, createdAt: arrivedAt,
        })) {
          await put('receivingLine', `LOCAL-DEMO-GRNL-${pad(number)}`, {
            receivingDocumentId: grnId, purchaseOrderLineId: lineId, itemId: item.id, sku: po.sku, itemName: item.name, acceptedQty: accepted, rejectedQty: rejected,
            unit: item.unit, warehouseId: WAREHOUSE, location: 'A-01', locationKey: 'a-01', metadata: { ...metadata, ...(rejected ? { rejectionReason } : {}) },
          })
        }
      }
    }

    // The history's orders, confirmed, as an order is before its stock is
    // reserved; shipping them below moves them on. Each records the random
    // seed its quantities were drawn from.
    for (const order of salesHistory) {
      if (await put('salesOrder', order.id, { tenantId, orderNumber: order.id, customerId: order.customerId, customerName: customerNames[order.customerId], workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', promisedDate: day(order.offset), currency: 'USD', metadata: { ...metadata, historyRandomSeed: HISTORY_RANDOM_SEED }, createdAt: at(order.offset, order.orderedAt) })) {
        for (const line of order.lines) {
          const item = items[line.sku]
          await put('salesOrderLine', line.id, { salesOrderId: order.id, itemId: item.id, sku: line.sku, itemName: item.name, orderedQuantity: line.quantity, unit: item.unit, unitPrice: salesPrices[line.sku], amount: money(line.quantity * salesPrices[line.sku]), metadata })
        }
      }
    }
    const unposted = await tx.receivingDocument.findMany({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-GRN-' }, postingStatus: 'unposted' }, select: { id: true, arrivedAt: true } })
    return unposted.sort((a, b) => a.arrivedAt - b.arrivedAt || a.id.localeCompare(b.id))
  }, { timeout: 60000 })

  // 2. Opening stock, then each unposted receipt and each history shipment in
  // date order: receipts as of their arrival, shipments as of their shipping
  // time. Accepted quantities go to stock and to the purchase order; rejected
  // quantities stay on the receipt. A posted receipt or shipment is never
  // posted again.
  if (withHistory) await postOpeningStock(prisma, { tenantId, calendar, identity: shipper, env: historyEnv })
  const timeline = [
    ...unpostedReceipts.map((receipt) => ({ at: receipt.arrivedAt, receipt })),
    ...salesHistory.map((order) => ({ at: at(order.offset, order.shippedAt), order })),
  ].sort((a, b) => a.at - b.at)
  let postedShipments = 0
  for (const event of timeline) {
    if (event.order) {
      if (await shipHistoryOrder(prisma, event.order, { tenantId, calendar, identity: shipper, env: historyEnv })) postedShipments += 1
      continue
    }
    const service = createReceivingPostingCommandService({ prisma, env, now: () => event.receipt.arrivedAt })
    await service.postReceiving({ receivingDocumentId: event.receipt.id, idempotencyKey: `local-walkthrough-scenario:post:${event.receipt.id}`, expectedVersion: 0 }, { identity: receiver })
  }

  // 3. The open sales order, written after the history so it is the most
  // recently changed order, at the top of the sales order list. Supplier
  // invoices for the posted receipts, in committed statuses.
  await prisma.$transaction(async tx => {
    const put = putWith(tx)
    if (await put('salesOrder', 'LOCAL-DEMO-SO-001', { tenantId, orderNumber: 'LOCAL-DEMO-SO-001', customerId: 'LOCAL-DEMO-CUS-001', customerName, workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', promisedDate: day(5), currency: 'USD', metadata, createdAt: at(-4, '11:00') })) {
      await put('salesOrderLine', 'LOCAL-DEMO-SOL-001', { salesOrderId: 'LOCAL-DEMO-SO-001', itemId: items['LDM-001'].id, sku: 'LDM-001', itemName: items['LDM-001'].name, orderedQuantity: 35, unit: 'pcs', unitPrice: 180, amount: 6300, metadata })
    }
    for (const po of purchaseOrders.filter((row) => row.invoice)) {
      const id = `LOCAL-DEMO-PO-${pad(po.n)}`
      const item = items[po.sku]
      const supplierName = localDemoSupplier(po.supplier).name
      const [number, invoiced, billedPrice, tax = 0, status] = po.invoice
      const invoiceId = `LOCAL-DEMO-INV-${pad(number)}`
      // Each invoice line bills one receipt's accepted quantity. The variance is
      // what a three-way match run computes: the tax-exclusive line amount less
      // the same quantity at the purchase order price.
      const lines = po.receipts.map(([receiptNumber, , , accepted], index) => {
        const lineAmount = money(accepted * billedPrice)
        const lineTax = index === 0 ? tax : 0
        return { grnId: `LOCAL-DEMO-GRN-${pad(receiptNumber)}`, grnLineId: `LOCAL-DEMO-GRNL-${pad(receiptNumber)}`, accepted, lineAmount, lineTax, variance: money(lineAmount - accepted * po.price) }
      })
      const subtotal = money(lines.reduce((sum, line) => sum + line.lineAmount, 0))
      const enteredTax = money(lines.reduce((sum, line) => sum + line.lineTax, 0))
      const variance = money(lines.reduce((sum, line) => sum + line.variance, 0))
      const invoiceMetadata = { ...metadata, paymentTerms: 'NET30', ...(variance ? { varianceType: 'price_variance' } : {}) }
      const written = await put('supplierInvoice', invoiceId, {
        tenantId, invoiceNumber: invoiceId, supplierId: po.supplier, supplierName, relatedPoId: id, relatedGrnId: lines[0].grnId,
        invoiceDate: day(invoiced), dueDate: day(invoiced + 30), subtotalAmount: subtotal, enteredTaxAmount: enteredTax, totalAmount: money(subtotal + enteredTax), amount: money(subtotal + enteredTax),
        currency: 'USD', status, matchStatus: INVOICE_MATCH_STATUS[status], varianceAmount: variance, submittedAt: at(invoiced, '15:00'),
        approvedAt: status === 'approved' ? at(invoiced + 3, '11:00') : null, metadata: invoiceMetadata, createdAt: at(invoiced, '15:00'),
      })
      if (!written) continue
      for (const [index, line] of lines.entries()) {
        await put('supplierInvoiceLine', index === 0 ? `LOCAL-DEMO-INVL-${pad(number)}` : `LOCAL-DEMO-INVL-${pad(number)}-${index + 1}`, {
          supplierInvoiceId: invoiceId, lineNumber: index + 1, purchaseOrderLineId: `${id}-LINE-001`, receivingLineId: line.grnLineId, itemId: item.id, sku: po.sku, itemName: item.name,
          quantity: line.accepted, unit: item.unit, unitPrice: billedPrice, lineAmount: line.lineAmount, enteredTaxAmount: line.lineTax, amount: money(line.lineAmount + line.lineTax),
          metadata: { ...metadata, ...(line.lineTax ? { taxRate: SALES_TAX_RATE } : {}), ...(line.variance ? { varianceType: 'price_variance', varianceAmount: line.variance } : {}) },
        })
      }
    }
  }, { timeout: 60000 })
  // 4. Contracts, when the contracts capability is on.
  const seededContracts = contractsEnabled(env) ? await seedLocalContracts(prisma, { tenantId, calendar, actorId: receiver.userId, metadata }) : null
  // 5. The preferred sources' lead times, minimum order quantities and prices.
  await saveSupplierTerms(prisma, { tenantId, actorId: receiver.userId })
  return {
    ...LOCAL_SCENARIO_COUNTS,
    ...(withHistory ? {} : { salesOrders: 1, shipments: 0 }),
    ...(seededContracts === null ? {} : { contracts: seededContracts }),
    postedReceipts: unpostedReceipts.length,
    postedShipments,
    shipmentHistory: withHistory ? 'kept' : 'not_added',
    asOf: calendar.seedDay,
    timeZone,
  }
}

// The walkthrough's contracts, as the contract commands would leave them
// after a create and an activate: version 2, the owner the supplier's
// business owner, and an audit row for each step. Returns how many there are.
export async function seedLocalContracts(prisma, { tenantId, calendar, actorId, metadata = {} }) {
  const { isoDay, at } = calendar
  const day = (offset) => new Date(`${isoDay(offset)}T00:00:00.000Z`)
  await prisma.$transaction(async (tx) => {
    for (const contract of contracts) {
      const id = `LOCAL-DEMO-CT-${pad(contract.n)}`
      if (await tx.contract.findUnique({ where: { id } })) continue
      // Numbers follow the CT- plus eight hexadecimal characters rule; DE for demo.
      const number = `CT-DE${String(contract.n).padStart(6, '0')}`
      if (await tx.contract.findFirst({ where: { tenantId, number } })) throw new Error(`Refusing to reuse contract number ${number}.`)
      const supplier = await tx.supplier.findUnique({ where: { id: contract.supplier }, select: { businessOwnerId: true } })
      const owner = supplier?.businessOwnerId ? await tx.user.findFirst({ where: { id: supplier.businessOwnerId, tenantId, status: 'active' }, select: { id: true } }) : null
      const recordedAt = at(contract.signed, '09:00')
      const activatedAt = at(contract.signed, '09:05')
      const fields = {
        title: contract.title, externalReference: contract.reference, type: contract.type, supplierId: contract.supplier, ownerId: owner?.id ?? null,
        startDate: isoDay(contract.start), endDate: isoDay(contract.end), signedOn: isoDay(contract.signed), renewal: contract.renewal,
        noticeDays: contract.noticeDays, reminderDays: 60, paymentTermsId: contract.paymentTermsId, currency: null, totalValue: null, notes: null,
      }
      await tx.contract.create({
        data: {
          id, tenantId, number, counterpartyType: 'supplier', status: 'active', ...fields,
          startDate: day(contract.start), endDate: day(contract.end), signedOn: day(contract.signed),
          version: 2, createdById: actorId, updatedById: actorId, activatedById: actorId, activatedAt, createdAt: recordedAt,
        },
      })
      const audit = (suffix, action, summary, createdAt, details) => tx.auditLog.create({
        data: { id: `${id}-AUDIT-${suffix}`, tenantId, actorId, source: 'local_walkthrough_scenario', module: 'contracts', entityType: 'Contract', entityId: id, action, summary, createdAt, metadata: { ...metadata, number, ...details } },
      })
      await audit('CREATED', 'contract_created', `Created contract ${number}.`, recordedAt, { version: 1, after: { ...fields, signedOn: null } })
      await audit('ACTIVATED', 'contract_activated', `Activated contract ${number}.`, activatedAt, { version: 2, signedOn: fields.signedOn, startDate: fields.startDate })
    }
  }, { timeout: 60000 })
  return prisma.contract.count({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-CT-' } } })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  assertLocalDevelopment(process.env, 'pilot:setup:scenario')
  const asOf = process.argv.slice(2).find((value) => value.startsWith('--as-of='))?.slice('--as-of='.length)
  const prisma = await getPrismaClient(process.env)
  try {
    const counts = await seedLocalScenario(prisma, process.env, asOf ? { asOf } : {})
    console.log(`Local walkthrough scenario v${LOCAL_SCENARIO_VERSION} ready: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`)
    if (counts.shipmentHistory === 'not_added') console.log('This workspace was seeded before version 8 and keeps its stock as it is, without the shipment history. Seed a fresh database (npm run walkthrough:local -- --reset) to have 90 days of demand.')
  } finally {
    await disconnectPrismaClient()
  }
}
