import { AI_TOOL_LIMITS, aiToolList, aiToolPurchaseOrder, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { aiStockProjection } from './ai-read-tools.mjs'
import { runHighestRisk } from './ai-skill-highest-risk.mjs'
import { runTodayPriorities } from './ai-skill-today-priorities.mjs'
import { AI_SKILL_SIGNAL_TYPES, buildAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'
import { listItemSupplierRecords, mapItemSupplierRecord } from './master-data-commands.mjs'
import { maskReferencePrice, masterDataReadAccessFor } from './master-data-read-access.mjs'
import { itemStockUnit, requestMinimumOf } from './reorder-list.mjs'
import { planPurchaseRequestPrefill } from '../../shared/purchase-request-prefill.mjs'
import { OPEN_PURCHASE_REQUEST_STATUSES, openRequestQuantity, suggestNeedByDate, suggestPurchaseQuantity } from '../../shared/purchase-suggestion.mjs'

// The data tools only assistant v2 is offered (docs/ai-assistant-v2-design.md
// §5.1): the attention list, the records missing data, the purchase request
// lines it suggests, and the purchase requests in any open status. They read
// the asking user's facts like the other read tools, and the suggestions also
// read the items' approved suppliers in the user's workspace. They need the
// facts read with { openPurchaseRequests: true } (ai-skill-readers.mjs), so a
// draft request counts as cover. Rows are ranked by date, never by a score,
// and contact details are never returned.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows, description: `How many rows to return, ${AI_TOOL_LIMITS.rows} by default.` }
const stockRow = (facts, sku) => array(facts.inventory?.rows).find((row) => fold(row.sku) === fold(sku)) || null

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
function attentionRow(item, rank) {
  const data = isObject(item.data) ? item.data : {}
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
  description: 'What needs attention, ranked by date and never by a score. kind today (default): today\'s priorities, the longest overdue first, then what falls due within 7 days, then the oldest open problems, then stock below its levels. kind problems: the open problems (late purchase orders, stock below its levels, supplier invoice differences, rejected receipts, and suppliers with several of them), the oldest date first. Narrow it to one record with focus (a purchase order number, a SKU or a supplier) or to some signal types with types. Each row gives the date that places it.',
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
      rows: items.slice(0, limit).map((item, index) => attentionRow(item, index + 1)),
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
  available: (facts) => Array.isArray(facts.purchaseRequests?.open),
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
          request: row.id, status: row.status, priority: row.priority, requiredDate: row.requiredDate,
          skus: [...new Set(lines.map((line) => line.sku).filter(Boolean))], lineCount: lines.length, quantity: only?.quantity ?? null, unit: only?.unit ?? null, lines,
          ref: aiToolRef('purchase_request', row.id, row.id),
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

// The items as stored (for the purchase unit and the default warehouse) and
// their approved sources, every read in the user's workspace. Reference
// prices are masked as the master data routes mask them.
async function itemSources(context, itemIds) {
  const { prisma, tenantId } = context
  const [items, links, suppliers] = await Promise.all([
    prisma.item.findMany({ where: { tenantId, id: { in: itemIds } }, select: { id: true, sku: true, name: true, unit: true, preferredSupplierId: true, metadata: true, status: true } }),
    Promise.all(itemIds.map((itemId) => listItemSupplierRecords(prisma, tenantId, { itemId }))),
    prisma.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true, status: true, metadata: true } }),
  ])
  const access = masterDataReadAccessFor(context.actor)
  const suppliersById = new Map(array(suppliers).map((row) => [text(row.id), row]))
  const byItem = new Map()
  itemIds.forEach((itemId, index) => {
    const item = array(items).find((row) => text(row.id) === itemId)
    if (item) byItem.set(itemId, { item, sources: approvedSourcesOf(item, array(links[index]), suppliersById).map((row) => maskReferencePrice(row, access)) })
  })
  return { byItem, prices: access.prices }
}

const STOCK_SIGNALS = new Set(['stock_shortage', 'stock_below_safety', 'stock_below_reorder'])
const SUPPLIER_SOURCE = Object.freeze({ 'item_supplier:preferred': 'preferred_supplier', 'item_supplier:only_approved': 'only_approved_supplier' })
const MAX_SUGGESTED = 8
const PROJECTION_WEEKS = 12

// The open requests and purchase orders that bring an item, each with its
// ref, so the record links and the grounding check find them.
function coverRecords(facts, row) {
  const requests = array(facts.purchaseRequests?.open)
    .filter((request) => OPEN_PURCHASE_REQUEST_STATUSES.includes(request.status) && request.lines.some((line) => line.sku === row.sku || (row.itemId && line.itemId === row.itemId)))
    .map((request) => ({ label: request.id, status: request.status, ref: aiToolRef('purchase_request', request.id, request.id) }))
  const orders = array(row.purchaseOrderIds)
    .map((id) => array(facts.purchaseOrders?.index).find((po) => po.id === id))
    .filter((po) => po?.isOpen)
    .map((po) => ({ label: po.orderNumber, status: po.status, ref: aiToolRef('purchase_order', po.id, po.orderNumber) }))
  return [...requests, ...orders]
}

const suggestPurchaseLines = defineAiTool({
  name: 'suggest_purchase_lines',
  description: 'Purchase request lines worked out by the server, for the in-chat purchase request form: per item its on-hand stock, safety stock and reorder point, the suggested quantity (the gap between the highest of the reorder point, safety stock and open sales demand and what is available, incoming on purchase orders and on open purchase requests, raised to the supplier\'s minimum order), the supplier (the preferred, or the only approved one), the need-by date (today plus the supplier\'s lead time, with a warning when stock runs short sooner) and the reference price. Items already covered by open requests or orders come back as covered. Name SKUs for those items; with none, the items below their stock levels, up to 8. The user chooses which lines to request.',
  parameters: {
    skus: { type: 'array', items: { type: 'string' }, maxItems: AI_TOOL_LIMITS.items, description: 'The SKUs the user named.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_SUGGESTED, description: `How many items to suggest when none is named, ${MAX_SUGGESTED} by default.` },
  },
  available: (facts, context) => Boolean(facts.inventory) && Boolean(context?.actor && context.prisma),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const named = array(args.skus).length > 0
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
    }
    const { byItem, prices } = await itemSources(context, [...new Set(rows.map((row) => text(row.itemId)).filter(Boolean))])
    const suppliersVisible = Array.isArray(facts.suppliers)
    const suggestions = rows.map((row) => {
      const stored = byItem.get(text(row.itemId)) || { item: null, sources: [] }
      const meta = isObject(stored.item?.metadata) ? stored.item.metadata : {}
      const plan = planPurchaseRequestPrefill({ query: { itemId: row.itemId, origin: 'ai_assistant' }, item: { itemId: row.itemId, defaultWarehouseId: text(meta.defaultWarehouseId || meta.warehouseId) }, suppliers: stored.sources, today: facts.today })
      const chosen = stored.sources.find((source) => source.id === plan.values.supplierId) || null
      const minimum = chosen && stored.item ? requestMinimumOf(stored.item, chosen, itemStockUnit(stored.item)) : 0
      const openRequests = openRequestQuantity(facts.purchaseRequests?.open, { sku: row.sku, itemId: row.itemId, unit: row.unit })
      const quantity = suggestPurchaseQuantity({
        reorderPoint: row.reorderPoint, safetyStock: row.safetyStock, openDemand: row.openSalesDemand, available: row.available, incoming: row.incomingApprovedPo, openRequests, minimum,
      })
      const lead = chosen?.leadTimeDays ?? null
      const weeks = lead === null ? 4 : Math.min(PROJECTION_WEEKS, Math.max(1, Math.ceil((lead + 1) / 7)))
      const projection = row.noStock ? null : aiStockProjection(facts, { sku: row.sku, weeks })
      const needBy = suggestNeedByDate({ today: facts.today, leadTimeDays: lead, firstShortWeek: projection?.firstWeekShort })
      const covered = quantity.covered ? { by: coverRecords(facts, row) } : null
      return {
        item: { id: text(row.itemId) || null, sku: row.sku, name: row.itemName || null, unit: row.unit || null },
        onHand: row.onHand ?? null, available: row.available ?? null, safetyStock: row.safetyStock ?? null, reorderPoint: row.reorderPoint ?? null,
        openSalesDemand: row.openSalesDemand ?? null, incoming: row.incomingApprovedPo ?? null, openRequests,
        target: quantity.target, gap: quantity.gap,
        suggestedQuantity: quantity.quantity,
        supplier: suppliersVisible && chosen ? { id: chosen.id, name: chosen.name, source: SUPPLIER_SOURCE[plan.fields.supplierId?.ref] || 'approved_supplier' } : null,
        supplierChoices: suppliersVisible ? plan.supplierChoices.map((choice) => ({ id: choice.id, name: choice.name })) : [],
        needByDate: { value: needBy.value, source: needBy.source, leadTimeDays: needBy.leadTimeDays, warning: needBy.warning },
        estimatedUnitPrice: plan.values.estimatedUnitPrice ? { value: Number(plan.values.estimatedUnitPrice), currency: plan.values.currency || null, source: 'reference_price' } : null,
        warehouseId: plan.values.targetWarehouseId || null,
        covered,
        ref: aiToolRef('item', row.itemId || row.sku, row.sku),
      }
    })
    // Suggested without names: only what needs ordering or is covered; a
    // named item is always returned, so the answer can say it is not needed.
    const listed = named ? suggestions : suggestions.filter((row) => row.suggestedQuantity.value !== null || row.covered)
    const limit = named ? listed.length : args.limit || MAX_SUGGESTED
    return {
      asOf: facts.asOf,
      today: facts.today,
      from: named ? 'named' : 'suggestions',
      pricesHidden: !prices,
      suppliersHidden: !suppliersVisible,
      purchaseRequestsRead: Array.isArray(facts.purchaseRequests?.open),
      rows: listed.slice(0, limit),
      total: listed.length,
      more: Math.max(0, listed.length - limit),
    }
  },
})

export const AI_ASSISTANT_V2_TOOLS = Object.freeze([attentionList, recordsMissingData, suggestPurchaseLines, listOpenPurchaseRequests])
