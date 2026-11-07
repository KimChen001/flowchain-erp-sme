import { QUESTION_LIMITS, SETUP_FORM_ROWS } from '../../shared/assistant-protocol.mjs'
import { AI_TOOL_LIMITS, aiToolList, aiToolPurchaseOrder, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { aiStockProjection } from './ai-read-tools.mjs'
import { runHighestRisk } from './ai-skill-highest-risk.mjs'
import { runTodayPriorities } from './ai-skill-today-priorities.mjs'
import { AI_SKILL_SIGNAL_TYPES, buildAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'
import { readFirstRunSetup } from './first-run-setup.mjs'
import { createRfqSupplierComparisonService } from './rfq-supplier-comparison-service.mjs'
import { listItemSupplierRecords, mapItemSupplierRecord } from './master-data-commands.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { maskReferencePrice, masterDataReadAccessFor } from './master-data-read-access.mjs'
import { DEMAND_WINDOW_DAYS, boughtInStockUnit, dailyDemand, isActiveItem, itemStockUnit, recordedReorderPoint, requestMinimumOf, shippedByWorkspaceDay } from './reorder-list.mjs'
import { scopedBusiness } from './ai-read-service-tools.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { REPLENISHMENT_SOLVER_DEFAULTS, ReplenishmentInputError, logReplenishmentCall, planReplenishment } from './replenishment-solver.mjs'
import { addCalendarDays, planPurchaseRequestPrefill } from '../../shared/purchase-request-prefill.mjs'
import { OPEN_PURCHASE_REQUEST_STATUSES, PURCHASE_SUGGESTION_SOURCES, openRequestQuantity, requestLineCountsFor, suggestNeedByDate, suggestPurchaseQuantity } from '../../shared/purchase-suggestion.mjs'

// The data tools only assistant v2 is offered (docs/ai-assistant-v2-design.md
// §5.1): the attention list, the records missing data, the purchase request
// lines it suggests, the purchase requests in any open status, and the
// first-day setup checklist (setup_status, counts only). They read
// the asking user's facts like the other read tools, and the suggestions also
// read the items' approved suppliers in the user's workspace. They need the
// facts read with { openPurchaseRequests: true } (ai-skill-readers.mjs), so a
// draft request counts as cover; the suggestions refuse facts read without
// them for a user who may read requests. Rows are ranked by date, never by a
// score, and contact details are never returned.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows, description: `How many rows to return, ${AI_TOOL_LIMITS.rows} by default.` }
const stockRow = (facts, sku) => array(facts.inventory?.rows).find((row) => fold(row.sku) === fold(sku)) || null
const openRequestsRead = (facts) => Array.isArray(facts.purchaseRequests?.open)

// The shared quantity rule over a stock row (shared/purchase-suggestion.mjs):
// open purchase requests in any open status count as cover.
const openRequestsOf = (facts, row) => openRequestQuantity(facts.purchaseRequests?.open, { sku: row.sku, itemId: row.itemId, unit: row.unit })
const quantityOf = (facts, row, minimum = 0) => suggestPurchaseQuantity({
  reorderPoint: row.reorderPoint, safetyStock: row.safetyStock, openDemand: row.openSalesDemand, available: row.available, incoming: row.incomingApprovedPo, openRequests: openRequestsOf(facts, row), minimum,
})

// A record the question narrows the attention list to: a purchase order by
// its number, an item by its SKU, or a supplier the user may read.
function attentionFocus(facts, query) {
  const po = facts.purchaseOrders ? aiToolPurchaseOrder(facts, query) : null
  if (po) return { entityType: 'purchase_order', entityId: po.id, label: po.orderNumber }
  const item = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((row) => fold(row.sku) === fold(query))
  if (item) return { entityType: 'item', entityId: item.itemId || item.sku, label: item.sku }
  const found = Array.isArray(facts.suppliers) ? aiToolSupplier(facts, query) : {}
  return found.supplier ? { entityType: 'supplier', entityId: found.supplier.id, label: found.supplier.name } : null
}

// The figures a signal carries that an answer may state; ids and lists of
// ids stay out. A free-text value (an RFQ title) is cut to the text limit.
const ATTENTION_DETAILS = ['sku', 'remaining', 'unit', 'available', 'demand', 'shortage', 'incoming', 'safety', 'reorder', 'pendingRequests', 'covered', 'variance', 'currency', 'rejected', 'quantity', 'priority', 'requiredDate', 'responses', 'title', 'count', 'notSent']
const ATTENTION_TYPES = [...AI_SKILL_SIGNAL_TYPES, 'supplier_exposure']

// The skills' engines count only submitted requests as cover. With the open
// requests read, an item's request cover is worked out as
// suggest_purchase_lines works it out, so the two tools never disagree about
// a draft; the engines, and so the skills and their answers, stay as they are.
function requestCoverOf(facts, item) {
  if (item.entityType !== 'item' || !openRequestsRead(facts)) return {}
  const row = array(facts.inventory?.rows).find((entry) => entry.itemId === item.entityId || entry.sku === item.label)
  return row ? { pendingRequests: openRequestsOf(facts, row), covered: quantityOf(facts, row).covered } : {}
}

function attentionRow(facts, item, rank) {
  const data = isObject(item.data) ? { ...item.data, ...requestCoverOf(facts, item) } : {}
  const details = Object.fromEntries(ATTENTION_DETAILS
    .filter((key) => data[key] !== undefined && (data[key] === null || typeof data[key] !== 'object'))
    .map((key) => [key, typeof data[key] === 'string' ? data[key].slice(0, AI_TOOL_LIMITS.text) : data[key]]))
  return {
    rank, type: item.type, also: [...new Set(array(item.also))], ...(item.type === 'supplier_exposure' ? { problemTypes: array(data.types) } : {}),
    severity: item.severity, label: item.label, whenKind: item.when?.kind || 'undated', days: item.when?.days ?? null, date: item.when?.date ?? null,
    supplier: item.supplier || null, details,
    ref: aiToolRef(item.entityType, item.entityId, item.label),
  }
}

const attentionList = defineAiTool({
  name: 'attention_list',
  description: 'What needs attention, ranked by date and never by a score. kind today (default): today\'s priorities, the longest overdue first, then what falls due within 7 days, then the oldest open problems, then stock below its levels. kind problems: the open problems (late purchase orders, stock below its levels, supplier invoice differences, rejected receipts, and suppliers with several of them), the oldest date first. Narrow it to one record with focus (a purchase order number, a SKU or a supplier) or to some signal types with types. Each row gives the date that places it. On a stock row, pendingRequests and covered count the open purchase requests in any status, drafts included.',
  parameters: {
    kind: { type: 'string', enum: ['today', 'problems'], description: 'today by default.' },
    focus: { type: 'string', description: 'A purchase order number, a SKU, or a supplier name or code.' },
    types: { type: 'array', items: { type: 'string', enum: ATTENTION_TYPES }, maxItems: ATTENTION_TYPES.length, description: 'Only these signal types.' },
    limit: { type: 'integer', minimum: 1, maximum: 10, description: '5 by default.' },
  },
  available: (facts) => Boolean(facts.purchaseOrders || facts.inventory || facts.invoices || facts.purchaseRequests || facts.rfqs || facts.receipts),
  assistantV2Only: true,
  run(args, { facts }) {
    const kind = args.kind || 'today'
    const focus = args.focus ? attentionFocus(facts, args.focus) : null
    if (args.focus && !focus) return { error: 'not_found' }
    // The skills' own engines, every item kept: the type filter applies
    // before the limit, so the total counts what matches.
    const result = kind === 'problems' ? runHighestRisk(facts, { focus, top: Infinity }) : runTodayPriorities(facts, { focus, top: Infinity })
    const types = array(args.types).length ? new Set(args.types) : null
    const items = types ? result.items.filter((item) => types.has(item.type) || array(item.also).some((type) => types.has(type))) : result.items
    const limit = args.limit || 5
    return {
      asOf: facts.asOf,
      kind,
      ...(focus ? { focus: { label: focus.label, ref: aiToolRef(focus.entityType, focus.entityId, focus.label) } } : {}),
      rows: items.slice(0, limit).map((item, index) => attentionRow(facts, item, index + 1)),
      total: items.length,
      more: Math.max(0, items.length - limit),
    }
  },
})

const MISSING_DATA_SOURCES = ['items', 'inventory', 'purchase_orders', 'purchase_requests', 'supplier_invoices', 'receipts']
// The readers report a field the user may not see (an invoice amount or
// supplier hidden from their role) as not missing, since they cannot tell
// (recordsNeedingData in ai-skill-readers.mjs); this list is theirs.
const recordsMissingData = defineAiTool({
  name: 'records_missing_data',
  description: 'The records whose missing data keeps them out of answers and reports: items without a unit, preferred supplier or stock threshold, stock without an available quantity, purchase orders without lines, quantities, promised dates or currency, purchase requests without a required date or lines, supplier invoices and receipts without required fields. Each with the fields it lacks. Fields hidden from the user are never reported missing.',
  parameters: {
    source: { type: 'string', enum: MISSING_DATA_SOURCES, description: 'Only records from this source.' },
    limit: limitParam,
  },
  available: (facts) => Object.keys(facts.recordsChecked || {}).length > 0,
  assistantV2Only: true,
  run(args, { facts }) {
    const records = array(facts.records).filter((record) => !args.source || record.source === args.source)
    return {
      asOf: facts.asOf,
      checked: { ...facts.recordsChecked },
      ...aiToolList(records.map((record) => ({ type: record.entityType, label: record.label, source: record.source, missing: [...record.missing], ref: aiToolRef(record.entityType, record.entityId, record.label) })), args.limit),
    }
  },
})

const listOpenPurchaseRequests = defineAiTool({
  name: 'list_purchase_requests',
  description: 'Open purchase requests: drafts, those submitted for approval and those approved but not yet ordered, with status, priority, required date and each line\'s SKU, quantity and unit. Filter by status or SKU. Soonest required first.',
  parameters: {
    status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'all'], description: 'all open requests by default.' },
    sku: { type: 'string', description: 'Only requests with a line for this SKU.' },
    limit: limitParam,
  },
  available: openRequestsRead,
  assistantV2Only: true,
  run(args, { facts }) {
    const status = args.status || 'all'
    let rows = facts.purchaseRequests.open.filter((row) => status === 'all' || row.status === status)
    if (args.sku) rows = rows.filter((row) => row.lines.some((line) => fold(line.sku) === fold(args.sku)))
    rows = [...rows].sort((a, b) => (a.requiredDate || '9999').localeCompare(b.requiredDate || '9999') || a.id.localeCompare(b.id))
    return {
      asOf: facts.asOf,
      ...aiToolList(rows.map((row) => {
        const lines = row.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, unit: line.unit }))
        const [only] = lines.length === 1 ? lines : []
        return {
          request: row.number || row.id, status: row.status, priority: row.priority, requiredDate: row.requiredDate,
          skus: [...new Set(lines.map((line) => line.sku).filter(Boolean))], lineCount: lines.length, quantity: only?.quantity ?? null, unit: only?.unit ?? null, lines,
          ref: aiToolRef('purchase_request', row.id, row.number || row.id),
        }
      }), args.limit),
    }
  },
})

// An item's approved purchasing sources, by the rule of the item supplier
// read the purchase request form uses (approvedSuppliersForItem in
// db-master-data-repository.mjs): its active, approved supplier links, plus
// its preferred supplier when no link records it, each while the supplier is
// active, the preferred first. Ids, names and the link's figures only.
function approvedSourcesOf(item, records, suppliersById) {
  const meta = isObject(item.metadata) ? item.metadata : {}
  const relationships = records.map((record) => mapItemSupplierRecord(record))
  const sources = relationships.filter((row) => row.active && row.approved)
  if (text(item.preferredSupplierId) && !relationships.some((row) => row.supplierId === item.preferredSupplierId)) {
    const legacyPrice = meta.referencePrice ?? meta.purchasePrice ?? null
    sources.push({ supplierId: item.preferredSupplierId, preferred: true, referencePrice: legacyPrice === null || legacyPrice === '' ? null : Number(legacyPrice), currency: text(meta.purchaseCurrency), leadTimeDays: null, minimumOrderQuantity: null })
  }
  const isPreferred = (source, supplier) => Boolean(source.preferred) || supplier.id === item.preferredSupplierId
  return sources
    .map((source) => ({ source, supplier: suppliersById.get(source.supplierId) }))
    .filter(({ supplier }) => supplier && fold(supplier.status || 'active') === 'active')
    .sort((a, b) => Number(isPreferred(b.source, b.supplier)) - Number(isPreferred(a.source, a.supplier)))
    .map(({ source, supplier }) => {
      const supplierMeta = isObject(supplier.metadata) ? supplier.metadata : {}
      return {
        id: text(supplier.id), name: text(supplier.name || supplier.id), preferred: isPreferred(source, supplier),
        referencePrice: source.referencePrice === null || source.referencePrice === undefined ? null : String(source.referencePrice),
        currency: text(source.currency || supplierMeta.defaultCurrency || supplierMeta.currency) || null,
        leadTimeDays: source.leadTimeDays ?? null, minimumOrderQuantity: source.minimumOrderQuantity ?? null,
      }
    })
}

// The items as stored, by id: their status, purchase unit and default
// warehouse. One read in the user's workspace.
async function storedItems({ prisma, tenantId }, itemIds) {
  if (!itemIds.length) return new Map()
  const items = await prisma.item.findMany({ where: { tenantId, id: { in: itemIds } }, select: { id: true, sku: true, name: true, unit: true, preferredSupplierId: true, metadata: true, status: true, reorderPoint: true } })
  return new Map(array(items).map((row) => [text(row.id), row]))
}

// The approved sources of the items returned, by item id, every read in the
// user's workspace. Only the rows returned are read (the named SKUs or up to
// the limit), so each item's links are read by its own key. Reference prices
// are masked as the master data routes mask them.
async function itemSources(context, items) {
  const { prisma, tenantId } = context
  const [links, suppliers] = await Promise.all([
    Promise.all(items.map((item) => listItemSupplierRecords(prisma, tenantId, { itemId: text(item.id) }))),
    items.length ? prisma.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true, status: true, metadata: true } }) : [],
  ])
  const access = masterDataReadAccessFor(context.actor)
  const suppliersById = new Map(array(suppliers).map((row) => [text(row.id), row]))
  const byItem = new Map(items.map((item, index) => [text(item.id), approvedSourcesOf(item, array(links[index]), suppliersById).map((row) => maskReferencePrice(row, access))]))
  return { byItem, prices: access.prices }
}

const STOCK_SIGNALS = new Set(['stock_shortage', 'stock_below_safety', 'stock_below_reorder'])
const SUPPLIER_SOURCE = Object.freeze({ 'item_supplier:preferred': 'preferred_supplier', 'item_supplier:only_approved': 'only_approved_supplier' })
const MAX_SUGGESTED = 8
const PROJECTION_WEEKS = 12
const COVER_DAYS_MAX = 180
const COVER_CANDIDATES = 40

// Recorded daily demand by item id, for coverDays (2026-11-04: "order what
// we need for the next 2 weeks" got "the system has no way to size an order
// to the next two weeks"). The reorder list's own rule (dailyDemand): posted
// shipments of its 90-day window, in the item's stock unit. Read only for a
// reader of every warehouse, as the reorder list reads it, so a part of the
// workspace's shipments is never set against a whole item.
async function recordedDemand(context, facts, items) {
  const { prisma, tenantId } = context
  const access = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
  if (Array.isArray(access?.warehouseIds)) {
    const warehouses = array(await prisma.warehouse.findMany({ where: { tenantId }, select: { id: true } }))
    if (!(warehouses.length && warehouses.every((row) => access.warehouseIds.includes(row.id)))) return { scoped: true, byItem: new Map() }
  }
  const ids = items.map((item) => text(item.id)).filter(Boolean)
  if (!ids.length) return { scoped: false, byItem: new Map() }
  const from = new Date(`${addCalendarDays(facts.today, -DEMAND_WINDOW_DAYS - 1)}T00:00:00Z`)
  const to = new Date(`${addCalendarDays(facts.today, 1)}T12:00:00Z`)
  const lines = array(await prisma.shipmentLine.findMany({
    where: { itemId: { in: ids }, shipment: { tenantId, postingStatus: 'posted', postedAt: { gte: from, lt: to } } },
    select: { itemId: true, unit: true, postedQuantity: true, shipment: { select: { postedAt: true } } },
  }))
  const byLine = new Map()
  for (const line of lines) {
    const key = text(line.itemId)
    if (!byLine.has(key)) byLine.set(key, [])
    byLine.get(key).push({ itemId: key, unit: line.unit, quantity: Number(line.postedQuantity), postedAt: line.shipment?.postedAt?.toISOString?.() || line.shipment?.postedAt || null })
  }
  // With each item's shipped quantity on each window day, oldest first (the
  // replenishment-inputs export's series), for the order plan's scenarios.
  const days = Array.from({ length: DEMAND_WINDOW_DAYS }, (_, index) => addCalendarDays(facts.today, index - DEMAND_WINDOW_DAYS))
  return {
    scoped: false,
    byItem: new Map(items.map((item) => {
      const itemLines = byLine.get(text(item.id)) || []
      const { byDay } = shippedByWorkspaceDay({ lines: itemLines, stockUnit: itemStockUnit(item), days, timeZone: facts.timezone })
      return [text(item.id), { ...dailyDemand({ lines: itemLines, stockUnit: itemStockUnit(item), today: facts.today, timeZone: facts.timezone }), daily: days.map((day) => byDay.get(day)) }]
    })),
  }
}

// What an item needs to cover a period: recorded daily demand over the
// supplier's lead time and the days to cover after the order arrives, plus
// safety stock. null without enough recorded demand.
const coverTargetOf = (row, rate, lead, coverDays) => (rate === null || !coverDays ? null : Math.ceil(rate * ((lead ?? 0) + coverDays) + Math.max(0, Number(row.safetyStock) || 0)))
const COVER_SOURCE = Object.freeze({ [PURCHASE_SUGGESTION_SOURCES.reorderGap]: PURCHASE_SUGGESTION_SOURCES.coverDays, [PURCHASE_SUGGESTION_SOURCES.raisedToMoq]: PURCHASE_SUGGESTION_SOURCES.coverDaysRaisedToMoq })
// The shared quantity rule with the cover target in place of the reorder
// point; the reorder point rule when there is no cover target.
function sizeOf(facts, row, minimum, target) {
  if (target === null) return quantityOf(facts, row, minimum)
  const sized = suggestPurchaseQuantity({ reorderPoint: target, safetyStock: row.safetyStock, openDemand: row.openSalesDemand, available: row.available, incoming: row.incomingApprovedPo, openRequests: openRequestsOf(facts, row), minimum })
  const source = COVER_SOURCE[sized.quantity.source]
  return source ? { ...sized, quantity: { ...sized.quantity, source } } : sized
}
const preferredLead = (sources) => (sources.find((source) => source.preferred) || sources[0])?.leadTimeDays ?? null

// The open requests and purchase orders that bring an item (a request only
// when one of its lines counts towards the cover), each with its ref, so the
// record links and the grounding check find them.
function coverRecords(facts, row) {
  const requests = array(facts.purchaseRequests?.open)
    .filter((request) => OPEN_PURCHASE_REQUEST_STATUSES.includes(request.status) && request.lines.some((line) => requestLineCountsFor(line, row)))
    .map((request) => ({ label: request.number || request.id, status: request.status, ref: aiToolRef('purchase_request', request.id, request.number || request.id) }))
  const orders = array(row.purchaseOrderIds)
    .map((id) => array(facts.purchaseOrders?.index).find((po) => po.id === id))
    .filter((po) => po?.isOpen)
    .map((po) => ({ label: po.orderNumber, status: po.status, ref: aiToolRef('purchase_order', po.id, po.orderNumber) }))
  return [...requests, ...orders]
}

const suggestPurchaseLines = defineAiTool({
  name: 'suggest_purchase_lines',
  description: 'Purchase request lines worked out by the server, for the in-chat purchase request form: per item its on-hand stock, safety stock and reorder point, the suggested quantity (the gap between the highest of the reorder point, safety stock and open sales demand and what is available, incoming on purchase orders and on open purchase requests, raised to the supplier\'s minimum order; with coverDays, the cover target takes the reorder point\'s place), the supplier (the preferred, or the only approved one), the need-by date (today plus the supplier\'s lead time, with a warning when stock runs short sooner) and the reference price. Items already covered by open requests or orders come back as covered. An item that is not active, or has no stock row, gets no quantity (source item_inactive or no_stock_position). Name SKUs for those items; with none, the items below their stock levels, up to 8. The user chooses which lines to request.',
  parameters: {
    skus: { type: 'array', items: { type: 'string' }, maxItems: AI_TOOL_LIMITS.items, description: 'The SKUs the user named.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_SUGGESTED, description: `How many items to suggest when none is named, ${MAX_SUGGESTED} by default.` },
    coverDays: { type: 'integer', minimum: 1, maximum: COVER_DAYS_MAX, description: 'Size each line to cover this many days after the order arrives, when the user asks to order for a period ("what we need for the next 2 weeks", 一个月的量): target = average daily demand (posted shipments over the last 90 days) × (lead time + coverDays) + safety stock. Without names, any stocked item that falls short of it is suggested. Each row\'s cover gives the basis; an item without enough shipment history keeps the reorder point quantity (cover.basis says so).' },
  },
  available: (facts, context) => Boolean(facts.inventory) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    // Facts read without the open requests would count no request as cover:
    // a reader of requests never gets suggestions that ignore them.
    if (facts.purchaseRequests && !openRequestsRead(facts)) return { error: 'open_purchase_requests_not_read' }
    const named = array(args.skus).length > 0
    const coverDays = Number.isInteger(args.coverDays) && args.coverDays >= 1 && args.coverDays <= COVER_DAYS_MAX ? args.coverDays : null
    let rows = []
    if (named) {
      for (const sku of args.skus) {
        const row = stockRow(facts, sku) || array(facts.inventory.masterOnly).find((entry) => fold(entry.sku) === fold(sku))
        if (!row) return { error: 'not_found', details: [sku] }
        if (!rows.includes(row)) rows.push(row)
      }
    } else {
      // The items below their stock levels, in the order of today's
      // priorities (by date, then shortage before safety stock before
      // reorder point): the same items the order skill suggests.
      const ranked = rankAiSkillItemsByDate(buildAiSkillSignals(facts)).filter((item) => STOCK_SIGNALS.has(item.type))
      rows = ranked.map((item) => array(facts.inventory.rows).find((row) => row.itemId === item.entityId || row.sku === item.label)).filter(Boolean)
      // To cover a period any stocked item may fall short, not only those
      // below their levels: the others follow, by the days their stock lasts.
      if (coverDays) for (const row of array(facts.inventory.rows)) if (!row.noStock && !rows.includes(row)) rows.push(row)
    }
    const stored = await storedItems(context, [...new Set(rows.map((row) => text(row.itemId)).filter(Boolean))])
    const itemOf = (row) => stored.get(text(row.itemId)) || null
    const demand = coverDays ? await recordedDemand(context, facts, [...stored.values()]) : null
    const demandOf = (row) => demand?.byItem.get(text(row.itemId)) || null
    const rateOf = (row) => demandOf(row)?.averageDailyDemand ?? null
    if (coverDays && !named) {
      // Those with recorded demand by the days their stock lasts, then those
      // below their levels without it (sized by the reorder point rule).
      const ranked = new Set(rankAiSkillItemsByDate(buildAiSkillSignals(facts)).filter((item) => STOCK_SIGNALS.has(item.type)).map((item) => text(item.entityId || item.label)))
      const lasting = (row) => ((Number(row.available) || 0) + (Number(row.incomingApprovedPo) || 0)) / rateOf(row)
      const withDemand = rows.filter((row) => rateOf(row) !== null).sort((a, b) => lasting(a) - lasting(b))
      const belowWithout = rows.filter((row) => rateOf(row) === null && (ranked.has(text(row.itemId)) || ranked.has(text(row.sku))))
      rows = [...withDemand, ...belowWithout].slice(0, COVER_CANDIDATES)
    }
    // With coverDays and no names, the sources of every candidate are read
    // first, as the lead time decides which of them fall short.
    const candidateSources = coverDays && !named ? await itemSources(context, [...new Set(rows.map(itemOf).filter(Boolean))]) : null
    // Suggested without names: only active items that need ordering or are
    // covered, as the reorder list and the purchase request command take
    // them. The supplier's minimum only raises a positive gap, so this is
    // known before any supplier is read. A named item is always returned, so
    // the answer can say why nothing is suggested.
    const listed = named ? rows : rows.filter((row) => {
      const lead = candidateSources ? preferredLead(candidateSources.byItem.get(text(row.itemId)) || []) : null
      const quantity = sizeOf(facts, row, 0, coverTargetOf(row, rateOf(row), lead, coverDays))
      return isActiveItem(itemOf(row)) && (quantity.quantity.value !== null || quantity.covered)
    })
    const limit = named ? listed.length : args.limit || MAX_SUGGESTED
    const shown = listed.slice(0, limit)
    const { byItem, prices } = candidateSources || await itemSources(context, [...new Set(shown.map(itemOf).filter(Boolean))])
    const suppliersVisible = Array.isArray(facts.suppliers)
    const suggestions = shown.map((row) => {
      const item = itemOf(row)
      const sources = byItem.get(text(row.itemId)) || []
      const meta = isObject(item?.metadata) ? item.metadata : {}
      const plan = planPurchaseRequestPrefill({ query: { itemId: row.itemId, origin: 'ai_assistant' }, item: { itemId: row.itemId, defaultWarehouseId: text(meta.defaultWarehouseId || meta.warehouseId) }, suppliers: sources, today: facts.today })
      const chosen = sources.find((source) => source.id === plan.values.supplierId) || null
      const minimum = chosen && item ? requestMinimumOf(item, chosen, itemStockUnit(item)) : 0
      const coverTarget = row.noStock ? null : coverTargetOf(row, rateOf(row), chosen?.leadTimeDays ?? null, coverDays)
      const quantity = sizeOf(facts, row, minimum, coverTarget)
      // The rule is not run on an item that cannot be requested, nor on one
      // with no stock row, whose stock and levels are not known.
      const notRun = item && !isActiveItem(item) ? PURCHASE_SUGGESTION_SOURCES.itemInactive : row.noStock ? PURCHASE_SUGGESTION_SOURCES.noStockPosition : null
      const lead = chosen?.leadTimeDays ?? null
      const weeks = lead === null ? 4 : Math.min(PROJECTION_WEEKS, Math.max(1, Math.ceil((lead + 1) / 7)))
      const projection = row.noStock ? null : aiStockProjection(facts, { sku: row.sku, weeks })
      const needBy = suggestNeedByDate({ today: facts.today, leadTimeDays: lead, firstShortWeek: projection?.firstWeekShort })
      const covered = !notRun && quantity.covered ? { by: coverRecords(facts, row) } : null
      return {
        item: { id: text(row.itemId) || null, sku: row.sku, name: row.itemName || null, unit: row.unit || (item ? itemStockUnit(item) : '') || null },
        onHand: row.onHand ?? null, available: row.available ?? null, safetyStock: row.safetyStock ?? null, reorderPoint: row.reorderPoint ?? null,
        openSalesDemand: row.openSalesDemand ?? null, incoming: row.incomingApprovedPo ?? null, openRequests: openRequestsOf(facts, row),
        target: row.noStock ? null : quantity.target, gap: row.noStock ? null : quantity.gap,
        suggestedQuantity: notRun ? { value: null, source: notRun } : quantity.quantity,
        supplier: suppliersVisible && chosen ? { id: chosen.id, name: chosen.name, source: SUPPLIER_SOURCE[plan.fields.supplierId?.ref] || 'approved_supplier' } : null,
        supplierChoices: suppliersVisible ? plan.supplierChoices.map((choice) => ({ id: choice.id, name: choice.name })) : [],
        // Every approved source, so the form's select holds them all and a
        // supplier the user names comes with its own lead time and price.
        approvedSuppliers: suppliersVisible ? sources.map((source) => ({ id: source.id, name: source.name, preferred: source.preferred, leadTimeDays: source.leadTimeDays, unitPrice: source.referencePrice === null || source.referencePrice === undefined ? null : Number(source.referencePrice), currency: source.currency })) : [],
        needByDate: { value: needBy.value, source: needBy.source, leadTimeDays: needBy.leadTimeDays, warning: needBy.warning },
        estimatedUnitPrice: plan.values.estimatedUnitPrice ? { value: Number(plan.values.estimatedUnitPrice), currency: plan.values.currency || null, source: 'reference_price' } : null,
        // The line's value at that price, so an answer reads it instead of
        // multiplying (2026-11-07: Haiku wrote $32,541 for 1,735 × $18.75).
        estimatedValue: !notRun && plan.values.estimatedUnitPrice && Number.isFinite(Number(quantity.quantity?.value)) && Number(quantity.quantity.value) > 0 ? { value: Math.round(Number(quantity.quantity.value) * Number(plan.values.estimatedUnitPrice) * 100) / 100, currency: plan.values.currency || null } : null,
        warehouseId: plan.values.targetWarehouseId || null,
        covered,
        // The basis of a period's quantity: recorded_demand, or why the
        // reorder point rule stands (not_enough_shipment_history,
        // warehouse_scope, no_stock_position).
        ...(coverDays ? { cover: {
          days: coverDays,
          basis: coverTarget !== null ? 'recorded_demand' : row.noStock ? 'no_stock_position' : demand?.scoped ? 'warehouse_scope' : 'not_enough_shipment_history',
          averageDailyDemand: rateOf(row),
          demandWindowDays: DEMAND_WINDOW_DAYS,
          shipmentDays: demandOf(row)?.shipmentDays ?? 0,
          leadTimeDays: chosen?.leadTimeDays ?? null,
          target: coverTarget,
        } } : {}),
        ref: aiToolRef('item', row.itemId || row.sku, row.sku),
      }
    })
    return {
      asOf: facts.asOf,
      today: facts.today,
      from: named ? 'named' : 'suggestions',
      ...(coverDays ? { coverDays } : {}),
      pricesHidden: !prices,
      suppliersHidden: !suppliersVisible,
      purchaseRequestsRead: openRequestsRead(facts),
      rows: suggestions,
      total: listed.length,
      more: Math.max(0, listed.length - limit),
    }
  },
})

// What records_missing_data reports an item lacks, as the setup gaps count it.
const SETUP_GAPS = Object.freeze({ unit: 'unit', preferredSupplier: 'preferred_supplier', thresholds: 'stock_threshold' })

// The first-day checklist exactly as Today builds it (first-run-setup.mjs:
// the same counts, the same steps and the same pages for the same reader),
// with every step also once all are done, and the gaps of the items already
// there, from the facts records_missing_data reads. Counts only: no record
// is named, so the checklist is offered to every reader, as Today shows it.
const setupStatus = defineAiTool({
  name: 'setup_status',
  description: 'The workspace\'s first-day setup checklist, the same one the Today page shows, in order: items, suppliers, customers, opening_stock, teammates. Per step: done, count (records so far), blocked (permission: this user cannot do it; unavailable: no page for it here) and href, the page in the app that does it; with import turned on that is the import page, which takes a CSV or XLSX file for many rows at once. open is false once every step is done. gaps counts the items that still lack a unit, a preferred supplier or stock thresholds (a reorder point or safety stock), which reorder suggestions need; null when the user cannot read inventory.',
  available: (_facts, context) => Boolean(context?.actor && context.prisma && context.tenantId),
  assistantV2Only: true,
  async run(_args, { facts, context }) {
    let checklist
    try {
      checklist = await readFirstRunSetup(context.prisma, { tenantId: context.tenantId, now: context.now, access: reportReadAccessFor(context.actor), env: context.routeContext?.env || process.env })
    } catch {
      return { error: 'setup_counts_unavailable' }
    }
    const checked = facts.recordsChecked?.items
    const items = array(facts.records).filter((record) => record.source === 'items')
    const gaps = Number.isInteger(checked)
      ? { checked, ...Object.fromEntries(Object.entries(SETUP_GAPS).map(([key, field]) => [key, items.filter((record) => record.missing.includes(field)).length])) }
      : null
    return {
      asOf: facts.asOf,
      open: checklist.done < checklist.total,
      done: checklist.done,
      total: checklist.total,
      importOn: checklist.steps.some((step) => String(step.href || '').startsWith('/app/master-data/import')),
      steps: checklist.steps.map((step) => ({ id: step.id, done: step.done, count: step.count, blocked: step.blocked, href: step.href })),
      gaps,
      // What the chat takes at once, so an answer that tells the user how
      // much to paste states figures a result holds.
      limits: { pasteCharacters: QUESTION_LIMITS.assistantV2, setupCardRows: SETUP_FORM_ROWS },
    }
  },
})

// An item's approved suppliers with their terms, as the item's purchasing
// set-up records them (the purchase request form's read, itemSources): for
// "should I switch supplier" the answer had no lead time or minimum order of
// the other supplier (2026-11-05). Prices only for a user who may see them.
const itemSuppliers = defineAiTool({
  name: 'item_suppliers',
  description: 'An item\'s approved suppliers as its purchasing set-up records them, the preferred first: each with its lead time in days, minimum order quantity and reference price (hidden from users who may not see prices). Use it to compare suppliers of an item or to judge a switch; price_history gives what was actually paid, supplier_performance how each delivers.',
  parameters: { sku: { type: 'string', description: 'The item\'s SKU.' } },
  required: ['sku'],
  available: (facts, context) => Boolean(facts.inventory) && Array.isArray(facts.suppliers) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const row = stockRow(facts, args.sku) || array(facts.inventory.masterOnly).find((entry) => fold(entry.sku) === fold(args.sku))
    if (!row || !text(row.itemId)) return { error: 'not_found' }
    const item = (await storedItems(context, [text(row.itemId)])).get(text(row.itemId))
    if (!item) return { error: 'not_found' }
    const { byItem, prices } = await itemSources(context, [item])
    const sources = byItem.get(text(item.id)) || []
    const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
    return {
      sku: row.sku, itemName: row.itemName || text(item.name) || null, unit: itemStockUnit(item) || row.unit || null, pricesHidden: !prices,
      suppliers: sources.map((source) => ({
        name: source.name, preferred: source.preferred, leadTimeDays: source.leadTimeDays ?? null, minimumOrderQuantity: number(source.minimumOrderQuantity),
        referencePrice: prices ? number(source.referencePrice) : null, currency: source.currency || null, ref: aiToolRef('supplier', source.id, source.name),
      })),
      total: sources.length,
    }
  },
})

// The quotes suppliers sent on open RFQs, read through the RFQ comparison
// (rfq-supplier-comparison-service.mjs, the RFQ page's read, which checks the
// user may see prices): "the RFQ has 2 quotes, but I don't have their
// content" (2026-11-05). Each supplier's latest quote, line by line; no
// ranking and no award, which stay the user's in the RFQ.
const RFQ_QUOTE_LIMIT = 3
const canReadPrices = (context) => Boolean(context?.actor?.permissionCodes?.has?.('procurement.prices.read'))
const rfqQuotes = defineAiTool({
  name: 'rfq_quotes',
  description: 'The quotes suppliers sent on open RFQs: per RFQ its number, title and quote due date, and one row per supplier and line of its latest quote with the SKU, quantity, unit price, currency, delivery date and how long the quote is valid, plus the invited suppliers that have not quoted. Name an RFQ by number, or a SKU for the open RFQs that ask for it (up to 3). No ranking or award: the user compares and awards in the RFQ.',
  parameters: {
    rfq: { type: 'string', description: 'An RFQ number.' },
    sku: { type: 'string', description: 'A SKU: the open RFQs with a line for it.' },
  },
  available: (facts, context) => Boolean(facts.rfqs) && Boolean(context?.actor && context.prisma) && canReadPrices(context),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const open = array(facts.rfqs.open)
    let picked = open
    if (args.rfq) picked = open.filter((row) => fold(row.number) === fold(args.rfq) || fold(row.id) === fold(args.rfq))
    else if (args.sku) {
      const stock = stockRow(facts, args.sku) || array(facts.inventory?.masterOnly).find((entry) => fold(entry.sku) === fold(args.sku))
      const match = [{ sku: { equals: text(args.sku), mode: 'insensitive' } }, ...(text(stock?.itemId) ? [{ itemId: text(stock.itemId) }] : [])]
      const lines = open.length ? await context.prisma.rfqLine.findMany({ where: { tenantId: context.tenantId, rfqId: { in: open.map((row) => row.id) }, OR: match }, select: { rfqId: true } }) : []
      const ids = new Set(array(lines).map((line) => text(line.rfqId)))
      picked = open.filter((row) => ids.has(row.id))
    }
    if (!picked.length) return { rfqs: [], rows: [], total: 0 }
    const service = context.routeContext?.aiReadServices?.rfqComparison || createRfqSupplierComparisonService({ prisma: context.prisma, env: context.routeContext?.env || process.env, now: () => context.now || new Date() })
    const day = (value) => (text(value) ? text(value).slice(0, 10) : null)
    const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
    const rfqs = []
    const rows = []
    for (const rfq of picked.slice(0, RFQ_QUOTE_LIMIT)) {
      let comparison
      try { comparison = await service.getComparison(rfq.id, { identity: context.routeContext?.identity }) } catch { continue }
      const ref = aiToolRef('rfq', rfq.id, rfq.number || rfq.title)
      for (const response of array(comparison.responses)) {
        const revision = response.latestRevision
        if (!revision) continue
        for (const line of array(revision.lines)) {
          if (args.sku && fold(line.sku) !== fold(args.sku)) continue
          rows.push({
            rfq: rfq.number || rfq.id, supplier: response.supplierName, sku: line.sku || null, quantity: number(line.quantity), unit: line.unit || null,
            unitPrice: number(line.unitPrice), currency: revision.currency || null, deliveryDate: day(line.deliveryDate || revision.deliveryDate), validUntil: day(revision.validUntil),
            ref,
          })
        }
      }
      rfqs.push({ rfq: rfq.number || rfq.id, title: rfq.title || null, due: rfq.due || null, quotes: array(comparison.responses).filter((response) => response.latestRevision).length, notQuoted: array(comparison.nonResponseParticipants).map((row) => row.supplierName).filter(Boolean), ref })
    }
    return { rfqs, ...aiToolList(rows, AI_TOOL_LIMITS.maxRows) }
  },
})

// Cost reasoning (2026-11-05: "should I order 100 instead of 50, is it cheaper?"
// got the price and the cash tied up, never the trade between ordering less
// often and holding more; "what does my stock cost me to hold?" got "I can't
// tell"). FlowChain records one reference price per approved supplier and no
// holding rate, cost per order or price breaks. So the tools below work from
// the recorded demand and reference prices, and where the workspace records
// no rate they use a common planning value, returned as an assumption for the
// answer to state (owner decision 2026-11-05: labelled assumptions are fine).
export const DEFAULT_HOLDING_RATE_PERCENT = 25
const EOQ_EXAMPLE_ORDER_COSTS = [25, 50, 100]
const VALUE_ITEMS_MAX = 200
const round = (value, places = 2) => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places)
const holdingRateParam = { type: 'number', minimum: 1, maximum: 100, description: `The yearly holding (carrying) cost as a percent of the item's value, when the user gives one. Without it, ${DEFAULT_HOLDING_RATE_PERCENT} (a common planning value, returned as an assumption).` }
const holdingAssumption = (args) => ({
  holdingRatePercent: args.holdingRatePercent ?? DEFAULT_HOLDING_RATE_PERCENT,
  holdingRateSource: args.holdingRatePercent === undefined || args.holdingRatePercent === null ? 'assumed_planning_value' : 'user',
  holdingCostCovers: ['capital', 'storage', 'insurance', 'obsolescence'],
})
// The price per stock unit from an approved source: its reference price, only
// when the item is bought in its stock unit and the user may see prices.
const unitPriceOf = (item, source, prices) => (prices && source && boughtInStockUnit(item, itemStockUnit(item)) && source.referencePrice !== null && source.referencePrice !== undefined && Number.isFinite(Number(source.referencePrice)) ? Number(source.referencePrice) : null)
const preferredSource = (sources) => sources.find((source) => source.preferred) || sources[0] || null

const orderQuantityCosts = defineAiTool({
  name: 'order_quantity_costs',
  description: `Compares order quantities for one item over a year: for each quantity the days of demand it covers, orders a year, average cycle stock, the order's value, the yearly holding cost and, when the user gives a cost per order, the yearly ordering cost and the total. For each pair, the extra holding cost of the larger one, the orders it saves and the break-even cost per order (the larger is cheaper overall when placing and receiving one order costs more than that), and, at the user's cost per order, how much less the larger costs a year in all (negative when it costs more). Also the economic order quantity (EOQ) at the user's cost per order, or at example costs per order of ${EOQ_EXAMPLE_ORDER_COSTS.join(', ')}. Demand is the item's recorded average daily demand (posted shipments over the last ${DEMAND_WINDOW_DAYS} days); price is the approved supplier's reference price. FlowChain records no price breaks and no cost per order, so the result says what it assumed. Use it for "order 100 instead of 50?", "is a bigger order cheaper?", "what quantity should I order?".`,
  parameters: {
    sku: { type: 'string', description: 'The item\'s SKU.' },
    quantities: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 10000000 }, maxItems: 5, description: 'The order quantities to compare, in the item\'s stock unit (for example [50, 100]).' },
    supplier: { type: 'string', description: 'An approved supplier\'s name; the preferred one by default.' },
    holdingRatePercent: holdingRateParam,
    costPerOrder: { type: 'number', minimum: 0, maximum: 1000000, description: 'What placing and receiving one order costs, when the user gives it (admin time, freight, receiving).' },
  },
  required: ['sku', 'quantities'],
  available: (facts, context) => Boolean(facts.inventory) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const row = stockRow(facts, args.sku) || array(facts.inventory.masterOnly).find((entry) => fold(entry.sku) === fold(args.sku))
    if (!row) return { error: 'not_found', details: [args.sku] }
    const quantities = [...new Set(array(args.quantities))].sort((a, b) => a - b)
    if (!quantities.length) return { error: 'quantities_required' }
    const stored = await storedItems(context, [text(row.itemId)].filter(Boolean))
    const item = stored.get(text(row.itemId)) || null
    if (!item) return { error: 'not_found', details: [args.sku] }
    const [demand, { byItem, prices }] = await Promise.all([recordedDemand(context, facts, [item]), itemSources(context, [item])])
    const sources = byItem.get(text(item.id)) || []
    let chosen = preferredSource(sources)
    if (args.supplier) {
      chosen = sources.find((source) => fold(source.name) === fold(args.supplier) || fold(source.id) === fold(args.supplier))
        || sources.find((source) => fold(source.name).includes(fold(args.supplier))) || null
      if (!chosen) return { error: 'supplier_not_approved_for_item', details: sources.map((source) => source.name) }
    }
    const daily = demand.byItem.get(text(item.id))?.averageDailyDemand ?? null
    const rate = daily !== null && daily > 0 ? daily : null
    const annual = rate === null ? null : rate * 365
    const minimum = chosen ? requestMinimumOf(item, chosen, itemStockUnit(item)) : 0
    const unitPrice = unitPriceOf(item, chosen, prices)
    const assumptions = holdingAssumption(args)
    const costPerOrder = args.costPerOrder ?? null
    const holdingPerUnit = unitPrice === null ? null : unitPrice * assumptions.holdingRatePercent / 100
    const options = quantities.map((quantity) => {
      const holding = holdingPerUnit === null ? null : (quantity / 2) * holdingPerUnit
      const ordering = annual === null || costPerOrder === null ? null : (annual / quantity) * costPerOrder
      return {
        quantity,
        belowSupplierMinimum: minimum > 0 && quantity < minimum,
        orderValue: unitPrice === null ? null : round(quantity * unitPrice),
        daysOfDemand: rate === null ? null : round(quantity / rate, 1),
        ordersPerYear: annual === null ? null : round(annual / quantity, 1),
        averageCycleStock: round(quantity / 2, 1),
        holdingCostPerYear: annual === null ? null : round(holding),
        orderingCostPerYear: round(ordering),
        totalCostPerYear: holding === null || ordering === null || annual === null ? null : round(holding + ordering),
      }
    })
    const comparisons = annual === null ? [] : quantities.slice(1).map((larger, index) => {
      const smaller = quantities[index]
      const breakEven = holdingPerUnit === null ? null : (holdingPerUnit * smaller * larger) / (2 * annual)
      return {
        smaller, larger,
        ordersSavedPerYear: round(annual / smaller - annual / larger, 1),
        extraHoldingCostPerYear: holdingPerUnit === null ? null : round(((larger - smaller) / 2) * holdingPerUnit),
        breakEvenCostPerOrder: round(breakEven),
        cheaperAtUserCostPerOrder: costPerOrder === null || breakEven === null ? null : costPerOrder > breakEven ? larger : costPerOrder < breakEven ? smaller : 'equal',
        // The yearly saving of the larger at the user's cost per order, so an
        // answer reads it instead of subtracting the totals (2026-11-07).
        largerSavesPerYear: options[index].totalCostPerYear === null || options[index + 1].totalCostPerYear === null ? null : round(options[index].totalCostPerYear - options[index + 1].totalCostPerYear),
      }
    })
    const eoqQuantity = (cost) => (annual === null || !holdingPerUnit ? null : Math.max(minimum, Math.round(Math.sqrt((2 * annual * cost) / holdingPerUnit))))
    // With the days of demand it covers, so the answer need not work them out.
    const eoqAt = (cost) => {
      const quantity = eoqQuantity(cost)
      return quantity === null ? null : { quantity, daysOfDemand: round(quantity / rate, 1), ordersPerYear: round(annual / quantity, 1) }
    }
    return {
      asOf: facts.asOf,
      sku: row.sku, itemName: row.itemName || item.name || null, unit: row.unit || itemStockUnit(item) || null,
      supplier: chosen ? { name: chosen.name, preferred: chosen.preferred, minimumOrderQuantity: minimum || null, leadTimeDays: chosen.leadTimeDays ?? null } : null,
      unitPrice, currency: chosen?.currency || facts.currency || null,
      unitPriceSource: unitPrice === null ? (prices ? 'no_reference_price_in_stock_unit' : 'prices_hidden') : 'reference_price',
      pricesHidden: !prices,
      priceBreaksRecorded: false,
      demand: rate === null
        ? { averageDailyDemand: null, basis: demand.scoped ? 'warehouse_scope' : 'not_enough_shipment_history', windowDays: DEMAND_WINDOW_DAYS }
        : { averageDailyDemand: round(rate), annualDemand: Math.round(annual), basis: 'recorded_demand', windowDays: DEMAND_WINDOW_DAYS, shipmentDays: demand.byItem.get(text(item.id))?.shipmentDays ?? null },
      assumptions: { ...assumptions, holdingCostPerUnitPerYear: round(holdingPerUnit), costPerOrder, costPerOrderSource: costPerOrder === null ? 'not_recorded' : 'user' },
      options,
      comparisons,
      economicOrderQuantity: annual === null || !holdingPerUnit ? null : {
        atUserCostPerOrder: costPerOrder === null ? null : eoqAt(costPerOrder),
        examples: costPerOrder === null ? EOQ_EXAMPLE_ORDER_COSTS.map((cost) => ({ costPerOrder: cost, ...eoqAt(cost) })) : [],
        raisedToSupplierMinimum: minimum > 0,
      },
      ref: aiToolRef('item', row.itemId || row.sku, row.sku),
    }
  },
})

const inventoryValue = defineAiTool({
  name: 'inventory_value',
  description: `What the stock on hand is worth and what holding it costs: on-hand quantity times the preferred approved supplier's reference price per item, totals per currency, and the yearly, monthly and daily holding cost at the holding rate (the user's, or a common planning value of ${DEFAULT_HOLDING_RATE_PERCENT}% a year, returned as an assumption). Items without a usable price are counted, not valued. Rows: the most valuable items first. Use it for "what is my inventory worth?", "what does holding my stock cost me?", "where is my cash tied up?".`,
  parameters: {
    skus: { type: 'array', items: { type: 'string' }, maxItems: AI_TOOL_LIMITS.items, description: 'Only these items.' },
    holdingRatePercent: holdingRateParam,
    limit: { type: 'integer', minimum: 1, maximum: 20, description: '10 rows by default.' },
  },
  available: (facts, context) => Boolean(facts.inventory) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const named = array(args.skus)
    let rows = array(facts.inventory.rows).filter((row) => !row.noStock && Number(row.onHand) > 0)
    if (named.length) {
      const missing = named.filter((sku) => !rows.some((row) => fold(row.sku) === fold(sku)))
      if (missing.length) return { error: 'not_found', details: missing }
      rows = rows.filter((row) => named.some((sku) => fold(sku) === fold(row.sku)))
    }
    const considered = rows.slice(0, VALUE_ITEMS_MAX)
    const stored = await storedItems(context, [...new Set(considered.map((row) => text(row.itemId)).filter(Boolean))])
    const { byItem, prices } = await itemSources(context, [...stored.values()])
    const assumptions = holdingAssumption(args)
    const valued = []
    const withoutPrice = []
    for (const row of considered) {
      const item = stored.get(text(row.itemId))
      const source = item ? preferredSource(byItem.get(text(item.id)) || []) : null
      const unitPrice = item ? unitPriceOf(item, source, prices) : null
      if (unitPrice === null) { withoutPrice.push(row.sku); continue }
      valued.push({ sku: row.sku, itemName: row.itemName || null, onHand: Number(row.onHand), unit: row.unit || null, unitPrice, currency: source.currency || facts.currency || null, value: round(Number(row.onHand) * unitPrice), supplier: source.name, ref: aiToolRef('item', row.itemId || row.sku, row.sku) })
    }
    const byCurrency = new Map()
    for (const row of valued) byCurrency.set(row.currency, (byCurrency.get(row.currency) || 0) + row.value)
    const totals = [...byCurrency].map(([currency, value]) => {
      const yearly = (value * assumptions.holdingRatePercent) / 100
      return { currency, value: round(value), holdingCostPerYear: round(yearly), holdingCostPerMonth: round(yearly / 12), holdingCostPerDay: round(yearly / 365) }
    })
    const limit = args.limit || 10
    const ranked = valued.sort((a, b) => b.value - a.value)
    // The running share within each currency, most valuable first, so "the
    // top three hold 88%" is a figure the result gives (an ABC view).
    const running = new Map()
    for (const row of ranked) {
      running.set(row.currency, (running.get(row.currency) || 0) + row.value)
      row.cumulativeSharePercent = round((running.get(row.currency) / (byCurrency.get(row.currency) || 1)) * 100, 1)
    }
    return {
      asOf: facts.asOf,
      pricesHidden: !prices,
      priceSource: 'reference_price_of_preferred_supplier',
      assumptions,
      itemsWithStock: rows.length,
      itemsValued: valued.length,
      itemsWithoutPrice: withoutPrice.length,
      withoutPrice: withoutPrice.slice(0, 10),
      notConsidered: Math.max(0, rows.length - considered.length),
      totals,
      rows: ranked.slice(0, limit).map((row) => ({ ...row, sharePercent: round((row.value / (byCurrency.get(row.currency) || 1)) * 100, 1) })),
      more: Math.max(0, ranked.length - limit),
    }
  },
})

// What to order now across items, solved exactly (replenishment-solver.mjs:
// the research prototype's SAA MILP on HiGHS), so the model never trades
// items off against a budget and minimum orders in its head (2026-11-06: on
// inventory decisions LLMs alone fall short of OR methods; LLM + solver does
// best). Read-only: placing an order still goes through the confirm cards.
//
// Inputs from the records, as the replenishment-inputs export reads them:
// stock position = on hand - reserved + every open purchase order line, late
// or not (the reorder list since #249), + open purchase requests (as
// suggest_purchase_lines counts them); the preferred approved supplier's lead
// time, minimum order and reference price (items bought in their stock unit,
// in the workspace currency); the shipped quantity on each of the last 90
// days. An item without them is listed with the reason, never guessed.
const PLAN_ITEMS_MAX = 40
const PLAN_ROWS = 12
const PLAN_TIME_LIMIT_SECONDS = 10
const planLine = { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'number', minimum: 0, maximum: 10000000 } }, required: ['sku', 'quantity'], additionalProperties: false }
const percent = (value) => round(value * 100, 1)
const linesText = (items, quantities) => items.map((item, index) => [item.sku, quantities[index]]).filter(([, quantity]) => quantity > 0).map(([sku, quantity]) => `${sku} ${quantity}`).join(', ')

// The planned items from the records, and the items left out with why.
async function orderPlanRecords(args, { facts, context }) {
  const currency = text(facts.currency) || null
  if (args.supplier && !Array.isArray(facts.suppliers)) return { error: 'suppliers_hidden' }
  const named = array(args.skus)
  let rows = named.length ? [] : array(facts.inventory.rows).filter((row) => !row.noStock)
  for (const sku of named) {
    const row = stockRow(facts, sku) || array(facts.inventory.masterOnly).find((entry) => fold(entry.sku) === fold(sku))
    if (!row) return { error: 'not_found', details: [sku] }
    if (!rows.includes(row)) rows.push(row)
  }
  // Lines the user names must be planned too.
  for (const line of [...array(args.plan), ...array(args.fixedLines), ...array(args.extraDemand)]) {
    const row = stockRow(facts, line.sku)
    if (!row) return { error: 'not_found', details: [line.sku] }
    if (!rows.includes(row)) rows.push(row)
  }
  const stored = await storedItems(context, [...new Set(rows.map((row) => text(row.itemId)).filter(Boolean))])
  const items = [...stored.values()]
  const [demand, { byItem, prices }, business] = await Promise.all([recordedDemand(context, facts, items), itemSources(context, items), scopedBusiness(context)])
  if (demand.scoped) return { error: 'warehouse_scope' }
  if (!prices) return { error: 'prices_hidden' }
  const allocation = buildRuntimeInventoryAllocation(business.access.collections.inventoryItems ? business.allocationContext : business.business)
  const stockBySku = new Map(array(allocation.availability).map((row) => [fold(row.sku), row]))
  // Incoming counts for every inventory reader, as on the reorder list; the
  // order numbers and supplier names only for those who may read them.
  const ordersVisible = Boolean(business.access.collections.purchaseOrders)
  const suppliersVisible = Array.isArray(facts.suppliers)
  const planned = []
  const left = []
  for (const row of rows) {
    const item = stored.get(text(row.itemId))
    const stock = stockBySku.get(fold(row.sku))
    const source = item ? preferredSource(byItem.get(text(item.id)) || []) : null
    const history = item ? demand.byItem.get(text(item.id)) : null
    const unitPrice = item ? unitPriceOf(item, source, prices) : null
    const reason = !item ? 'no_item_record' : !isActiveItem(item) ? 'item_inactive'
      : !itemStockUnit(item) ? 'no_stock_unit'
        : !boughtInStockUnit(item, itemStockUnit(item)) ? 'bought_in_another_unit'
          : !stock || row.noStock ? 'no_stock_position'
            : !source ? 'no_approved_supplier'
              : !Number.isInteger(source.leadTimeDays) ? 'no_lead_time'
                : unitPrice === null || !(unitPrice > 0) ? 'no_reference_price'
                  : currency && source.currency && fold(source.currency) !== fold(currency) ? 'price_in_another_currency'
                    : history?.averageDailyDemand === null || history?.averageDailyDemand === undefined ? 'not_enough_shipment_history' : null
    if (args.supplier && (!source || (!fold(source.name).includes(fold(args.supplier)) && fold(source.id) !== fold(args.supplier)))) continue
    if (reason) { left.push({ sku: row.sku, reason }); continue }
    planned.push({
      row, item, source,
      input: {
        sku: row.sku, name: row.itemName || item.name || null, unit: itemStockUnit(item), supplier: suppliersVisible ? source.name : null,
        unitPrice, moq: requestMinimumOf(item, source, itemStockUnit(item)), leadTimeDays: source.leadTimeDays,
        onHand: Number(stock.onHand) || 0, reserved: Number(stock.reserved) || 0, openRequests: openRequestsOf(facts, row),
        openLines: array(stock.incomingLines).map((line) => ({ remaining: Number(line.remaining) || 0, dueInDays: line.dueDay ? Math.round((Date.parse(`${line.dueDay}T12:00:00Z`) - Date.parse(`${facts.today}T12:00:00Z`)) / 86400000) : null, reference: ordersVisible ? text(line.orderNumber) || null : null })),
        dailyDemand: history.daily,
        reorderPoint: recordedReorderPoint(item),
        // Days of cover, to keep the items that run out first when there are many.
        cover: ((Number(stock.onHand) || 0) - (Number(stock.reserved) || 0) + array(stock.incomingLines).reduce((sum, line) => sum + (Number(line.remaining) || 0), 0)) / history.averageDailyDemand,
      },
    })
  }
  if (args.supplier && !planned.length && !left.length) return { error: 'supplier_not_found' }
  const wanted = new Set([...array(args.plan), ...array(args.fixedLines), ...array(args.extraDemand)].map((line) => fold(line.sku)))
  const unplanned = left.filter((entry) => wanted.has(fold(entry.sku)))
  if (unplanned.length) return { error: 'cannot_plan_item', details: unplanned.map((entry) => `${entry.sku}: ${entry.reason}`) }
  planned.sort((a, b) => Number(wanted.has(fold(b.input.sku))) - Number(wanted.has(fold(a.input.sku))) || a.input.cover - b.input.cover)
  return { currency, planned: planned.slice(0, PLAN_ITEMS_MAX), left, overLimit: Math.max(0, planned.length - PLAN_ITEMS_MAX) }
}

const optimizeOrderPlan = defineAiTool({
  name: 'optimize_order_plan',
  description: 'The cheapest order to place now across items, solved exactly (a mixed-integer program, HiGHS) from the records: each item\'s stock position (on hand - reserved + every open purchase order line and open purchase request), the preferred supplier\'s lead time, minimum order and reference price, and the last 90 days of shipments as 200 demand scenarios. It weighs the cost of holding stock against running short over each item\'s lead time plus the review days, within the budget and the minimum orders, and costs the plan beside ordering nothing, the reorder list\'s quantities and a plan the user proposes. Use it for what to order now (with or without a budget), for what-ifs, and to judge an order someone proposes. Read-only.',
  parameters: {
    budget: { type: 'number', minimum: 0, maximum: 100000000, description: 'The most to spend on this order, in the workspace currency, when the user gives one.' },
    plan: { type: 'array', items: planLine, maxItems: AI_TOOL_LIMITS.items, description: 'An order the user proposes or asks about, to cost beside the best one (e.g. [{ sku: "SKU-123", quantity: 50 }]).' },
    fixedLines: { type: 'array', items: planLine, maxItems: AI_TOOL_LIMITS.items, description: 'Lines the user will order anyway; the rest is planned around them.' },
    exclude: { type: 'array', items: { type: 'string' }, maxItems: AI_TOOL_LIMITS.items, description: 'SKUs not to order now.' },
    extraDemand: { type: 'array', items: planLine, maxItems: AI_TOOL_LIMITS.items, description: 'Demand the history does not show (a known extra order), added to each item\'s cycle.' },
    skus: { type: 'array', items: { type: 'string' }, maxItems: AI_TOOL_LIMITS.items, description: 'Only these items; all stocked items by default.' },
    supplier: { type: 'string', description: 'Only items whose preferred supplier this is.' },
    serviceLevelPercent: { type: 'number', minimum: 50, maximum: 99.9, description: 'When the user gives one: the share of cycles that should end without running short. Without it, running short costs 5 times holding (about 83%).' },
    holdingRatePercent: holdingRateParam,
    reviewDays: { type: 'integer', minimum: 1, maximum: 60, description: `Days until the next chance to order, ${REPLENISHMENT_SOLVER_DEFAULTS.reviewDays} by default.` },
  },
  available: (facts, context) => Boolean(facts.inventory) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const records = await orderPlanRecords(args, { facts, context })
    if (records.error) return records
    if (!records.planned.length) return { error: 'nothing_to_plan', details: records.left.slice(0, 10).map((entry) => `${entry.sku}: ${entry.reason}`) }
    const items = records.planned.map((entry) => ({ ...entry.input, extraDemand: array(args.extraDemand).filter((line) => fold(line.sku) === fold(entry.input.sku)).reduce((sum, line) => sum + line.quantity, 0) }))
    const skuOf = (sku) => items.find((item) => fold(item.sku) === fold(sku))?.sku || sku
    const linesOf = (lines) => Object.fromEntries(array(lines).map((line) => [skuOf(line.sku), line.quantity]))
    const options = {
      budget: args.budget ?? null, holdingRatePercent: args.holdingRatePercent, serviceLevelPercent: args.serviceLevelPercent, reviewDays: args.reviewDays,
      fixed: linesOf(args.fixedLines), exclude: array(args.exclude).filter((sku) => items.some((item) => fold(item.sku) === fold(sku))).map(skuOf),
      candidates: array(args.plan).length ? [{ id: 'your_plan', quantities: linesOf(args.plan) }] : [],
      timeLimitSeconds: PLAN_TIME_LIMIT_SECONDS,
    }
    const input = { today: facts.today, currency: records.currency, items: items.map(({ cover, ...item }) => item) }
    let result
    try {
      result = await planReplenishment(input, options)
    } catch (error) {
      if (error instanceof ReplenishmentInputError) return { error: 'invalid_plan', details: [error.message] }
      throw error
    }
    const shown = orderPlanResult(result, { facts, records, items, args })
    // For a study: the solver's full result and what the model was shown.
    logReplenishmentCall({ caller: 'assistant_v2', tenantId: context.tenantId, args, input, options, result, toolResult: shown }, { path: (context.routeContext?.env || process.env).FLOWCHAIN_REPLENISHMENT_SOLVER_LOG })
    return shown
  },
})

// The solver's answer as the assistant reads it: the decision first, then the
// plans side by side and the items, every figure rounded as the app shows it.
function orderPlanResult(result, { facts, records, items, args }) {
  const plan = (id) => result.plans.find((entry) => entry.id === id) || null
  const cost = (entry) => (entry.heldOut || entry.inSample)
  const optimal = plan('optimal')
  const reorder = plan('reorder_list')
  const yours = plan('your_plan')
  const noOrder = plan('no_order')
  const free = result.binding?.budget?.withoutBudget
  const planRow = (id, entry) => entry && ({
    plan: id,
    lines: linesText(items, entry.quantities),
    spend: round(entry.spend),
    holdingCost: round(cost(entry).holding),
    shortageCost: round(cost(entry).shortage),
    expectedCost: round(cost(entry).total),
    costAboveOptimal: entry.costAboveOptimal === null ? null : round(entry.costAboveOptimal),
    withinBudget: entry.withinBudget,
    // So "over budget by" is a figure the result gives (2026-11-06: an
    // answer worked it out itself).
    overBudgetAmount: args.budget !== undefined && args.budget !== null && entry.spend > args.budget ? round(entry.spend - args.budget) : null,
    // And what is left of it (2026-11-06: "$0.06 of the budget" was worked out).
    budgetLeft: args.budget !== undefined && args.budget !== null && entry.spend <= args.budget ? round(args.budget - entry.spend) : null,
    issues: entry.issues.map((issue) => (issue.sku ? `${issue.sku} ${issue.code}` : issue.code)),
  })
  const rows = [
    planRow('optimal', optimal),
    ...(free ? [planRow('without_budget_limit', { ...free, withinBudget: false, issues: [], costAboveOptimal: free.heldOut && optimal ? free.heldOut.total - optimal.heldOut.total : null })] : []),
    planRow('no_order', noOrder),
    planRow('reorder_list', reorder),
    planRow('your_plan', yours),
  ].filter(Boolean)
  const outcome = (entry, index) => entry?.perItem[index] || null
  const itemRows = result.items.map((item, index) => {
    const entry = records.planned[index]
    return {
      sku: item.sku, itemName: item.name, unit: item.unit, supplier: item.supplier,
      position: item.position, openRequests: item.openRequests, cycleDays: item.cycleDays, expectedDemand: round(item.meanCycleDemand, 1),
      minimumOrderQuantity: item.minimumOrder || null, unitPrice: item.unitPrice, minimumOrderValue: item.minimumOrder ? round(item.minimumOrder * item.unitPrice) : null,
      optimalQuantity: item.optimalQuantity,
      reorderListQuantity: reorder ? reorder.quantities[index] : null,
      ...(yours ? { planQuantity: yours.quantities[index] } : {}),
      chanceShortNoOrderPercent: percent(outcome(noOrder, index).chanceShort),
      chanceShortWithOptimalPercent: optimal ? percent(outcome(optimal, index).chanceShort) : null,
      ...(yours ? { chanceShortWithPlanPercent: percent(outcome(yours, index).chanceShort) } : {}),
      reason: item.reason,
      ...(item.openLinesDueAfterCycle.length ? { openLinesDueAfterCycle: item.openLinesDueAfterCycle.map((line) => ({ orderNumber: line.reference || null, remaining: line.remaining, dueInDays: line.dueInDays })) } : {}),
      ref: aiToolRef('item', entry.row.itemId || item.sku, item.sku),
    }
  })
  const interesting = (row) => row.optimalQuantity > 0 || row.reorderListQuantity > 0 || row.planQuantity > 0
  itemRows.sort((a, b) => Number(interesting(b)) - Number(interesting(a)) || b.chanceShortNoOrderPercent - a.chanceShortNoOrderPercent)
  const p = result.parameters
  const budget = result.binding?.budget
  return {
    asOf: facts.asOf,
    today: facts.today,
    currency: records.currency,
    status: result.status,
    ...(result.reason ? { reason: result.reason, reasonItems: result.reasonItems || [] } : {}),
    decision: optimal ? {
      lines: result.items.map((item, index) => ({ item, index })).filter(({ index }) => optimal.quantities[index] > 0).map(({ item, index }) => ({
        sku: item.sku, itemName: item.name, quantity: optimal.quantities[index], unit: item.unit, supplier: item.supplier, unitPrice: item.unitPrice, orderValue: round(optimal.quantities[index] * item.unitPrice),
        raisedToMinimumOrder: item.reason === 'raised_to_minimum_order',
      })),
      spend: round(optimal.spend),
      expectedCost: round(cost(optimal).total),
      savingVsNoOrder: round(cost(noOrder).total - cost(optimal).total),
      ...(reorder ? { savingVsReorderList: round(cost(reorder).total - cost(optimal).total) } : {}),
      ...(yours ? { savingVsYourPlan: round(cost(yours).total - cost(optimal).total) } : {}),
    } : null,
    budget: budget ? { amount: round(budget.amount), spend: round(budget.spend), left: round(budget.left), binds: budget.binds, ...(free ? { spendWithoutLimit: round(free.spend), costWithoutLimit: round(cost(free).total), costSavedWithoutLimit: round(cost(optimal).total - cost(free).total) } : {}) } : null,
    minimumOrders: result.binding ? { raised: result.binding.raisedToMinimumOrder, skippedAsTooCostly: result.binding.skippedForMinimumOrder } : null,
    plans: rows,
    items: itemRows.slice(0, PLAN_ROWS),
    itemsPlanned: itemRows.length,
    moreItems: Math.max(0, itemRows.length - PLAN_ROWS),
    assumptions: {
      holdingRatePercent: p.holdingRatePercent, holdingRateSource: p.sources.holdingRate,
      shortageCostMultiple: round(p.shortageCostMultiple, 2), serviceLevelPercent: round(p.serviceLevelPercent, 1), shortageCostSource: p.sources.shortageCost,
      reviewDays: p.reviewDays, reviewDaysSource: p.sources.reviewDays,
      budgetSource: p.sources.budget,
    },
    method: {
      solver: 'HiGHS mixed-integer program', solverStatus: result.solver?.status ?? null, gapPercent: result.solver?.mipGap === null || result.solver?.mipGap === undefined ? null : round(result.solver.mipGap * 100, 4),
      scenarios: p.samples, costSamples: p.heldOutSamples, demandWindowDays: result.historyDays,
      expectedCostMeans: 'holding cost of stock left at the end of each item\'s lead time plus review days, plus a shortage cost for each unit short, at the assumed rates: a planning figure, not cash. Spend is cash.',
    },
    notPlanned: records.left.slice(0, 10),
    notPlannedCount: records.left.length + records.overLimit,
    ...(args.supplier ? { supplier: args.supplier } : {}),
  }
}

// The stock projection with the demand the reorder list plans on (2026-11-07:
// on public data, where every sales order has shipped, it showed no demand
// for an item shipping 17 a day). weeks keep the open sales orders in the week
// promised; atRecordedRate runs the same weeks at the average shipped per day
// over the last 90 days, with the same incoming lines. The two are never
// added: an open sales order becomes a shipment.
const stockProjection = defineAiTool({
  name: 'stock_projection',
  description: 'How one SKU\'s available stock moves over the next weeks, from what is available today and adding open purchase order lines in the week they are promised. weeks takes off open sales orders in the week promised to the customer. atRecordedRate takes off the average quantity shipped per day over the last 90 days instead (recordedDemand, the reorder list\'s demand), for stock that sells without open sales orders. Lines past their promised date, or with none, are listed apart and not placed in a week, because no arrival date is guessed. Gives the first week the SKU falls below safety stock or short, on each basis.',
  parameters: { sku: { type: 'string', description: 'The SKU.' }, weeks: { type: 'integer', minimum: 1, maximum: 12, description: '4 by default.' } },
  required: ['sku'],
  available: (facts, context) => Boolean(facts.inventory) && Boolean(facts.asOf || facts.today) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const projection = aiStockProjection(facts, { sku: args.sku, weeks: args.weeks || 4 })
    if (projection.error || projection.noStockOrOrders) return projection
    const row = stockRow(facts, args.sku)
    const item = row?.itemId ? (await storedItems(context, [text(row.itemId)])).get(text(row.itemId)) : null
    const demand = item ? await recordedDemand(context, facts, [item]) : null
    if (!demand || demand.scoped) return { ...projection, recordedDemand: { averageDailyDemand: null, reason: demand?.scoped ? 'warehouse_scope' : 'no_item_record' } }
    const history = demand.byItem.get(text(item.id))
    const rate = history?.averageDailyDemand ?? null
    const recordedDemandRow = { averageDailyDemand: rate, windowDays: DEMAND_WINDOW_DAYS, shipmentDays: history?.shipmentDays ?? 0, ...(rate === null ? { reason: 'not_enough_shipment_history' } : {}) }
    if (rate === null) return { ...projection, recordedDemand: recordedDemandRow }
    const weekly = Math.round(rate * 7)
    const safety = projection.safetyStock
    let balance = projection.availableToday ?? 0
    const atRecordedRate = projection.weeks.map((week) => {
      balance += week.incoming - weekly
      return { from: week.from, to: week.to, incoming: week.incoming, demand: weekly, endAvailable: balance, belowSafetyStock: safety !== null && safety !== undefined && balance < safety, short: balance < 0 }
    })
    return {
      ...projection,
      recordedDemand: recordedDemandRow,
      atRecordedRate,
      firstWeekBelowSafetyStockAtRecordedRate: atRecordedRate.find((week) => week.belowSafetyStock)?.from || null,
      firstWeekShortAtRecordedRate: atRecordedRate.find((week) => week.short)?.from || null,
    }
  },
})

export const AI_ASSISTANT_V2_TOOLS = Object.freeze([attentionList, recordsMissingData, suggestPurchaseLines, listOpenPurchaseRequests, setupStatus, itemSuppliers, rfqQuotes, orderQuantityCosts, inventoryValue, optimizeOrderPlan, stockProjection])
