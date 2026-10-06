import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { localDemoSupplier } from './setup-local-demo.mjs'
import { PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS } from '../server/domain/procurement-status-authority.mjs'
import { createReceivingPostingCommandService } from '../server/domain/receiving-posting-command-service.mjs'
import { applyPromisedDateChanges, recordOriginalPromises } from '../server/domain/purchase-order-promise-dates.mjs'
import { resolveProvisionedActor } from '../server/domain/pilot-identity.mjs'
import { authorize } from '../server/auth/authorization-service.mjs'
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
export const LOCAL_SCENARIO_VERSION = 6
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
  inventoryBalances: 2,
  salesOrders: 1,
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

// The workspace user who posts the walkthrough receipts: the first active user,
// by email, whose roles grant receiving.post. pilot:setup provisions the roles.
async function receivingActor(prisma, tenantId) {
  const users = await prisma.user.findMany({ where: { tenantId, status: 'active' }, orderBy: { email: 'asc' } })
  for (const user of users) {
    const identity = { authenticated: true, tenantId, userId: user.id, role: user.role, name: user.name, source: 'local_walkthrough_scenario' }
    try {
      const actor = await resolveProvisionedActor(prisma, identity)
      if (authorize({ actor, permission: 'receiving.post', tenantId }).allowed) return identity
    } catch {
      // A user without a complete role assignment cannot post; try the next one.
    }
  }
  throw new Error('No active workspace user may post receipts. Run pilot:setup before pilot:setup:scenario.')
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
  const receiver = await receivingActor(prisma, tenantId)
  const metadata = { localDemo: true, localDemoScenarioVersion: LOCAL_SCENARIO_VERSION, scenarioAsOf: calendar.seedDay }

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

    // Opening stock before the walkthrough receipts, which posting adds to.
    // Quantities are created once and then belong to inventory; the planning
    // thresholds keep LDM-001 short after its 20 received pieces.
    for (const [id, sku, onHandQuantity, safetyStock, reorderPoint, riskLevel] of [
      ['LOCAL-DEMO-BAL-001', 'LDM-001', 8, 30, 40, 'shortage'],
      ['LOCAL-DEMO-BAL-002', 'LDM-002', 60, 15, 15, 'normal'],
    ]) {
      await tx.inventoryBalance.upsert({
        where: { id },
        create: {
          id, tenantId, itemId: items[sku].id, sku, itemName: items[sku].name, warehouseId: WAREHOUSE,
          warehouseKey: WAREHOUSE, location: 'A-01', locationKey: 'a-01',
          onHandQuantity, availableQuantity: onHandQuantity, reservedQuantity: 0,
          safetyStock, reorderPoint, unit: 'pcs', status: 'active',
          riskLevel, metadata,
        },
        update: { itemName: items[sku].name, safetyStock, reorderPoint, riskLevel, metadata },
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
      // An order issued to the supplier keeps its first promised date, as the
      // issue command records it. Recorded once; a later seed leaves it alone.
      if (sent) {
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

    if (await put('salesOrder', 'LOCAL-DEMO-SO-001', { tenantId, orderNumber: 'LOCAL-DEMO-SO-001', customerId: 'LOCAL-DEMO-CUS-001', customerName, workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', promisedDate: day(5), currency: 'USD', metadata, createdAt: at(-4, '11:00') })) {
      await put('salesOrderLine', 'LOCAL-DEMO-SOL-001', { salesOrderId: 'LOCAL-DEMO-SO-001', itemId: items['LDM-001'].id, sku: 'LDM-001', itemName: items['LDM-001'].name, orderedQuantity: 35, unit: 'pcs', unitPrice: 180, amount: 6300, metadata })
    }
    const unposted = await tx.receivingDocument.findMany({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-GRN-' }, postingStatus: 'unposted' }, select: { id: true, arrivedAt: true } })
    return unposted.sort((a, b) => a.arrivedAt - b.arrivedAt || a.id.localeCompare(b.id))
  }, { timeout: 60000 })

  // 2. Post each unposted receipt, oldest first, as of its arrival. Accepted
  // quantities go to stock and to the purchase order; rejected quantities stay
  // on the receipt. A posted receipt is never posted again.
  for (const receipt of unpostedReceipts) {
    const service = createReceivingPostingCommandService({ prisma, env, now: () => receipt.arrivedAt })
    await service.postReceiving({ receivingDocumentId: receipt.id, idempotencyKey: `local-walkthrough-scenario:post:${receipt.id}`, expectedVersion: 0 }, { identity: receiver })
  }

  // 3. Supplier invoices for the posted receipts, in committed statuses.
  await prisma.$transaction(async tx => {
    const put = putWith(tx)
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
  return { ...LOCAL_SCENARIO_COUNTS, postedReceipts: unpostedReceipts.length, asOf: calendar.seedDay, timeZone }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  assertLocalDevelopment(process.env, 'pilot:setup:scenario')
  const asOf = process.argv.slice(2).find((value) => value.startsWith('--as-of='))?.slice('--as-of='.length)
  const prisma = await getPrismaClient(process.env)
  try {
    const counts = await seedLocalScenario(prisma, process.env, asOf ? { asOf } : {})
    console.log(`Local walkthrough scenario v${LOCAL_SCENARIO_VERSION} ready: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`)
  } finally {
    await disconnectPrismaClient()
  }
}
