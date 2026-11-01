import { AI_TOOL_LIMITS, aiToolList, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { capabilityForEnvironment } from './capability-registry.mjs'
import { createContractReadService } from './contract-read-service.mjs'
import { createOperationalFinanceO2cReadService } from './operational-finance-o2c-read-service.mjs'
import { createPriceHistoryReadService } from './price-history-read-service.mjs'
import { createReorderListReadService } from './reorder-list-read-service.mjs'
import { SUPPLIER_ISSUE_TYPES, createSupplierInsightsReadService } from './supplier-insights.mjs'
import { reportReadAccessFor, scopeBusinessContext } from './report-read-access.mjs'
import { searchRuntimeBusinessContext } from './runtime-business-search.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { CONTRACT_STATES } from '../../shared/contract-status.mjs'
import { answerKnowledgeQuery, createKnowledgeService } from './ai-knowledge-service.mjs'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'

// Read tools that need more than the user's facts (docs/ai-model-first-design.md
// §4): the request's context (the actor, the database and the route context
// from loadAiSkillContext), passed to runAiReadTool as `context`. Each tool is
// offered only when the user holds its read permission, and the read service
// it wraps checks that permission again, as its own route does. Services can
// be injected through context.routeContext.aiReadServices (tests). Two
// services were found on 2026-10-28 to check no permission code of their own
// (inventory balances and the purchase order receiving summary); no tool here
// uses them.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows, description: `How many rows to return, ${AI_TOOL_LIMITS.rows} by default.` }
const can = (context, permission) => Boolean(context?.actor?.permissionCodes?.has?.(permission))
const serviceOf = (context, name, create) => context?.routeContext?.aiReadServices?.[name] || create({ prisma: context.prisma, env: context.routeContext?.env || process.env, now: () => context.now })
const identityOf = (context) => ({ identity: context.routeContext?.identity })
// A row's own values (text, numbers, true or false, dates as text), without
// nested records, ids of other tables or free-text fields that could carry
// instructions.
const primitives = (row, keep) => Object.fromEntries(keep.filter((key) => row?.[key] !== undefined && (row[key] === null || typeof row[key] !== 'object')).map((key) => [key, row[key]]))
// Payment terms with their code, name and days, from the workspace's own
// terms. A contract holds a term's id or its code, as the contract commands
// accept either (contract-command-service.mjs); one the workspace does not
// hold is given as its code.
async function paymentTermsOf(context, keys) {
  const wanted = [...new Set(keys.map(text).filter(Boolean))]
  if (!wanted.length || typeof context.prisma?.paymentTerm?.findMany !== 'function') return new Map()
  const rows = await context.prisma.paymentTerm.findMany({ where: { tenantId: context.tenantId, OR: [{ id: { in: wanted } }, { code: { in: wanted } }] }, select: { id: true, code: true, name: true, days: true } })
  const terms = new Map()
  for (const row of rows) for (const key of [row.code, row.id]) terms.set(key, { code: row.code, name: row.name, days: row.days ?? null })
  return terms
}

// The user's business context, scoped as the reports scope it, read once per
// request: the record search and the reorder list read it.
const scoped = new WeakMap()
function scopedBusiness(context) {
  if (!scoped.has(context)) {
    scoped.set(context, (async () => {
      const access = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
      const readCtx = { ...context.routeContext, identity: { ...context.routeContext?.identity, tenantId: context.tenantId } }
      const allocationContext = context.routeContext?.aiSkillBusinessContext || await readBusinessContext(readCtx, { warehouseIds: access.warehouseIds })
      return { access, allocationContext, business: scopeBusinessContext(allocationContext, access) }
    })())
  }
  return scoped.get(context)
}

const searchRecords = defineAiTool({
  name: 'search_records',
  description: 'Finds records by number or name across what the user may read: items, suppliers, customers, sales orders, purchase requests, RFQs, purchase orders and warehouses. Use it to find a record the question names before reading it.',
  parameters: { query: { type: 'string', maxLength: 80, description: 'A number, code or part of a name.' }, limit: limitParam },
  required: ['query'],
  available: (_facts, context) => Boolean(context?.actor),
  async run(args, { context }) {
    const { business } = await scopedBusiness(context)
    const results = searchRuntimeBusinessContext(business, args.query, { limit: AI_TOOL_LIMITS.maxRows })
    return aiToolList(results.map((row) => ({ type: row.entityType, number: row.entityId, name: row.label, status: row.status || null, ref: aiToolRef(row.entityType, row.entityId, NAMED_RECORDS.has(row.entityType) ? row.label : row.entityId) })), args.limit)
  },
})
// Records a link names by their name: their id is internal. Documents are
// named by their number, and items by their SKU.
const NAMED_RECORDS = new Set(['supplier', 'customer', 'warehouse'])

const reorderList = defineAiTool({
  name: 'reorder_list',
  description: 'The reorder list as the inventory page shows it: the items to order now or soon, by the day they must be ordered, with the preferred supplier, the lead time and the quantity it suggests. Transfers between warehouses are not considered.',
  parameters: { limit: limitParam },
  available: (facts, context) => Boolean(facts?.inventory) && Boolean(context?.actor) && can(context, 'inventory.balance.read'),
  async run(args, { facts, context }) {
    const { access, allocationContext, business } = await scopedBusiness(context)
    const allocation = buildRuntimeInventoryAllocation(access.collections.inventoryItems ? allocationContext : business)
    const list = await serviceOf(context, 'reorderList', createReorderListReadService).read({
      tenantId: context.tenantId, warehouseIds: access.warehouseIds ?? null, today: facts.today, timeZone: facts.timezone,
      allocationRows: allocation.availability, showPurchaseOrders: Boolean(access.collections.purchaseOrders),
      truncatedSubjects: array(allocationContext.truncatedSubjects).filter((entry) => ['inventory_items', 'sales_orders', 'purchase_orders'].includes(entry?.subject)),
    })
    const rows = array(list.rows).map((row) => ({
      ...primitives(row, ['sku', 'itemName', 'name', 'unit', 'orderByDate', 'orderNow', 'daysUntilOrderBy', 'onHand', 'reserved', 'incoming', 'position', 'reorderPoint', 'shortfall', 'leadTimeDays']),
      averageDailyDemand: row.demand?.averageDailyDemand ?? null,
      supplier: text(row.supplier?.name) || null,
      requestQuantity: row.purchaseRequest?.quantity ?? null,
      incomingLines: array(row.incomingLines).map((line) => primitives(line, ['orderNumber', 'remaining', 'dueDay', 'counted'])),
      ref: aiToolRef('item', row.itemId || row.purchaseRequest?.itemId || row.sku, row.sku),
    }))
    rows.sort((a, b) => text(a.orderByDate || '9999').localeCompare(text(b.orderByDate || '9999')) || text(a.sku).localeCompare(text(b.sku)))
    return { asOf: facts.asOf, summary: list.summary && typeof list.summary === 'object' ? primitives(list.summary, Object.keys(list.summary)) : null, notJudged: array(list.notJudged).length, limitations: array(list.dataLimitations), ...aiToolList(rows, args.limit) }
  },
})

const listReceivables = defineAiTool({
  name: 'list_receivables',
  description: 'What customers owe: open receivables from customer invoices with the amount outstanding, the amount paid, the due date and any dispute, or an aging summary by currency (current, 1-30, 31-60, 61-90 and over 90 days past due). Soonest due first.',
  parameters: {
    view: { type: 'string', enum: ['items', 'aging'], description: 'items (default) or aging.' },
    status: { type: 'string', enum: ['open', 'overdue', 'disputed', 'all'], description: 'For items: open by default.' },
    customer: { type: 'string', description: 'Part of a customer name.' },
    limit: limitParam,
  },
  available: (_facts, context) => Boolean(context?.actor) && can(context, 'finance.receivable.read'),
  async run(args, { context }) {
    const service = serviceOf(context, 'receivables', createOperationalFinanceO2cReadService)
    if (args.view === 'aging') {
      const aging = await service.aging({}, identityOf(context))
      return { aging: array(aging.groups || aging.items || aging.currencies).map((group) => primitives(group, ['currency', 'current', '1_30', '31_60', '61_90', '90_plus', 'total', 'count'])), asOf: aging.asOf || null }
    }
    const status = args.status || 'open'
    const page = await service.listReceivables({ status: status === 'all' || status === 'disputed' ? '' : status, ...(status === 'disputed' ? { disputeStatus: 'open' } : {}), pageSize: 100 }, identityOf(context))
    let rows = array(page.items)
    if (args.customer) rows = rows.filter((row) => fold(row.customerName).includes(fold(args.customer)))
    return {
      total: page.total,
      ...aiToolList(rows.map((row) => ({
        ...primitives(row, ['obligationNumber', 'customerInvoiceNumber', 'customerName', 'outstandingAmount', 'paidAmount', 'originalAmount', 'currency', 'dueDate', 'status', 'disputeStatus']),
        ref: aiToolRef('receivable', row.id, row.obligationNumber || row.customerInvoiceNumber),
      })), args.limit),
    }
  },
})

// A contract's money and dates as the contract service returns them: the
// total value is null, and named in restrictedFields, for a user without
// procurement.prices.read (maskContract). K1 stores no per-item prices. The
// title and their reference are short entered text, which the loop hands to
// the model as data; the notes are not passed.
const listContracts = defineAiTool({
  name: 'list_contracts',
  description: 'Signed supplier contracts: number, title, their reference, type, supplier, state, start, end and signing dates, notice period, renewal, total contract value with its currency, and payment terms, soonest key date first. Contracts hold no per-item prices; use price_history for what an item cost. The total value is null for users who may not see prices. Filter by supplier, state or words.',
  parameters: {
    supplier: { type: 'string', description: 'A supplier name or code.' },
    state: { type: 'string', enum: CONTRACT_STATES },
    search: { type: 'string', maxLength: 80 },
    limit: limitParam,
  },
  available: (_facts, context) => Boolean(context?.actor) && can(context, 'contracts.contract.read') && Boolean(capabilityForEnvironment('contracts', context.routeContext?.env || process.env)?.enabled),
  async run(args, { facts, context }) {
    let supplierId = ''
    if (args.supplier) {
      const found = aiToolSupplier(facts, args.supplier)
      if (!found.supplier) return { error: found.error, candidates: found.candidates || [] }
      supplierId = found.supplier.id
    }
    const page = await serviceOf(context, 'contracts', createContractReadService).list({ search: args.search || '', state: args.state || '', supplierId, sort: 'key_date', pageSize: 100 }, identityOf(context))
    const contracts = array(page.contracts)
    const terms = await paymentTermsOf(context, contracts.map((row) => row.paymentTermsId))
    return {
      today: page.today,
      counts: page.counts,
      pricesHidden: !page.access?.prices,
      ...aiToolList(contracts.map((row) => ({
        ...primitives(row, ['number', 'title', 'externalReference', 'type', 'status', 'state', 'startDate', 'endDate', 'signedOn', 'noticeDays', 'counterpartyType', 'totalValue', 'currency']),
        supplier: text(row.supplier?.name) || null,
        paymentTerms: row.paymentTermsId ? terms.get(row.paymentTermsId) || { code: row.paymentTermsId } : null,
        renewal: row.renewal && typeof row.renewal === 'object' ? primitives(row.renewal, ['type', 'term', 'termMonths', 'noticeDate']) : row.renewal ?? null,
        ref: aiToolRef('contract', row.id, row.number),
      })), args.limit),
    }
  },
})

const priceHistory = defineAiTool({
  name: 'price_history',
  description: 'What the workspace paid for an item on purchase orders: the latest price with its order and day, earlier prices, the quantity-weighted average, and the last order with each supplier. In one currency and the item\'s unit; prices are hidden from users who may not see them.',
  parameters: {
    sku: { type: 'string', description: 'The item\'s SKU.' },
    supplier: { type: 'string', description: 'Only this supplier\'s prices.' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'The workspace currency by default.' },
  },
  required: ['sku'],
  available: (facts, context) => Boolean(facts?.purchaseOrders) && Boolean(context?.actor) && can(context, 'procurement.purchase_order.read'),
  async run(args, { facts, context }) {
    const item = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((row) => fold(row.sku) === fold(args.sku))
    const itemId = text(item?.itemId)
    if (!itemId) return { error: 'not_found' }
    let supplierId = null
    if (args.supplier) {
      const found = aiToolSupplier(facts, args.supplier)
      if (!found.supplier) return { error: found.error, candidates: found.candidates || [] }
      supplierId = found.supplier.id
    }
    const service = serviceOf(context, 'priceHistory', createPriceHistoryReadService)
    const currency = args.currency || facts.currency
    const [read, last] = await Promise.all([
      service.read([`${itemId}|${text(item.unit)}|${currency}`], identityOf(context), { supplierId }),
      service.lastOrders(itemId, identityOf(context)),
    ])
    const history = array(read.histories)[0] || {}
    const fact = (row) => (row ? { ...primitives(row, ['unitPrice', 'currency', 'unit', 'orderedQuantity', 'date', 'orderNumber', 'supplierName']), ref: aiToolRef('purchase_order', row.purchaseOrderId, row.orderNumber) } : null)
    const supplierName = (id) => array(facts.suppliers).find((row) => row.id === id)?.name || null
    return {
      sku: item.sku, unit: history.unit ?? null, currency: history.currency ?? currency, status: history.status ?? null,
      latest: fact(history.latest), earlier: array(history.earlier).map(fact), average: history.average ? primitives(history.average, ['unitPrice', 'quantity', 'orderedQuantity', 'count', 'lineCount']) : null,
      otherCurrencies: array(history.otherCurrencies), otherUnits: array(history.otherUnits),
      pricesHidden: Boolean(read.restrictedFields?.length),
      lastOrderBySupplier: array(last.lastOrders).map((row) => ({ supplier: supplierName(row.supplierId), orderNumber: row.orderNumber, day: row.day, ref: aiToolRef('purchase_order', row.purchaseOrderId, row.orderNumber) })),
    }
  },
})

// The Supplier risks page (supplier-insights.mjs readRisks), read as the page
// reads it for this user: each supplier's open issues, earliest date first,
// never a score (owner rule 2026-10-03). The issues come from the kinds of
// records the user may read; the others are named in `hidden`.
const supplierRisks = defineAiTool({
  name: 'supplier_risks',
  description: 'The Supplier risks list: each supplier\'s open issues (overdue purchase orders, rejected receipt quantities, receipts received but not posted, supplier invoice variances) with a count per supplier, earliest date first. It does not score or rank suppliers. Filter by supplier or issue type. Record kinds the user may not read are named in hidden: their issues are missing, not zero.',
  parameters: {
    supplier: { type: 'string', description: 'A supplier name or code.' },
    type: { type: 'string', enum: SUPPLIER_ISSUE_TYPES },
    limit: limitParam,
  },
  available: (_facts, context) => {
    if (!context?.actor || !(context.prisma || context.routeContext?.aiReadServices?.supplierInsights)) return false
    const { collections = {} } = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
    return Boolean(collections.purchaseOrders || collections.receipts || collections.supplierInvoices)
  },
  async run(args, { facts, context }) {
    const read = await serviceOf(context, 'supplierInsights', createSupplierInsightsReadService).readRisks(context.routeContext)
    let rows = array(read.issues)
    if (args.supplier) {
      // Among the suppliers the user may read when the facts hold them;
      // otherwise among the suppliers the list names.
      const listed = [...new Map(rows.map((row) => [row.supplierId, { id: row.supplierId, code: row.supplierCode, name: row.supplierName }])).values()]
      const found = aiToolSupplier(Array.isArray(facts?.suppliers) ? facts : { suppliers: listed }, args.supplier)
      if (found.supplier) rows = rows.filter((row) => row.supplierId === found.supplier.id)
      else if (Array.isArray(facts?.suppliers) || found.error === 'supplier_ambiguous') return { error: found.error, candidates: found.candidates || [] }
      else rows = []
    }
    if (args.type) rows = rows.filter((row) => row.type === args.type)
    const bySupplier = new Map()
    for (const row of rows) {
      const entry = bySupplier.get(row.supplierId) || { supplier: row.supplierName, code: row.supplierCode, issues: 0, byType: {}, ref: aiToolRef('supplier', row.supplierId, row.supplierName) }
      entry.issues += 1
      entry.byType[row.type] = (entry.byType[row.type] || 0) + 1
      bySupplier.set(row.supplierId, entry)
    }
    return {
      asOf: read.asOf,
      hidden: Object.entries(read.visibility || {}).filter(([key, visible]) => key !== 'issues' && !visible).map(([key]) => key),
      suppliers: [...bySupplier.values()],
      ...aiToolList(rows.map((row) => ({ supplier: row.supplierName, type: row.type, record: row.label, when: row.when ?? null, ...row.data, ref: aiToolRef(row.entityType, row.entityId, row.label) })), args.limit),
    }
  },
})

// The workspace's own documents (policies, product guides, procedures), as
// the knowledge search for agent planning reads them (aiAgentKnowledge,
// PR-3): only the documents the user may read, passages with their document
// and section, and no model asked to write an answer. Keyword search does not
// cross languages, so a search in Chinese over documents in English comes
// back as an error naming their language, for the model to search again.
// Passages are document text: the loop hands them to the model as data.
const CJK = /[㐀-鿿]/u
const PASSAGES = 5
const knowledge = new WeakMap()
function knowledgeOf(context) {
  if (!knowledge.has(context)) {
    knowledge.set(context, (async () => {
      const env = knowledgeProviderEnv(context.routeContext?.env || process.env)
      const service = context.routeContext?.aiReadServices?.knowledge || createKnowledgeService(context.prisma, { env })
      const documents = array((await service.list(context.actor))?.items)
      return { env, service, languages: [...new Set(documents.map((row) => (row.language === 'zh-CN' ? 'zh-CN' : 'en-US')))].sort(), count: documents.length }
    })())
  }
  return knowledge.get(context)
}
const databaseMode = (context) => context?.routeContext?.repositories?.mode === 'database' || (context?.routeContext?.env || process.env).FLOWCHAIN_PERSISTENCE_MODE === 'database'

const searchDocuments = defineAiTool({
  name: 'search_documents',
  description: 'Searches the workspace\'s own documents that the user may read (policies, product guides, procedures) and returns the matching passages with their document and section. Write the search words in the documents\' language; the result names it, and a search in another language finds nothing. State only what the passages say, citing the document and section; if they do not answer the question, say the documents do not cover it.',
  parameters: { query: { type: 'string', maxLength: 200, description: 'Search words in the documents\' language, for example "urgent purchase approval".' } },
  required: ['query'],
  available: (_facts, context) => Boolean(context?.actor && (context.prisma || context.routeContext?.aiReadServices?.knowledge)) && (databaseMode(context) || Boolean(context.routeContext?.aiReadServices?.knowledge)),
  async run(args, { context }) {
    const { env, service, languages, count } = await knowledgeOf(context)
    if (!count) return { documents: 0, passages: [], note: 'This workspace has no documents the user may read.' }
    if (CJK.test(args.query) && !languages.includes('zh-CN')) return { error: 'query_language', details: [`The documents are in ${languages.join(', ')}. A search in Chinese finds nothing in them: translate the search words and search again now, in that language.`] }
    const result = await answerKnowledgeQuery({ question: args.query, retrievalQuery: args.query, generate: false, actor: context.actor, service, env })
    const citations = array(result.citations)
    return {
      documents: count,
      documentLanguages: languages,
      found: citations.length,
      passages: citations.slice(0, PASSAGES).map((row) => ({ document: row.title, section: row.heading || null, excerpt: text(row.excerpt).slice(0, 900), ref: aiToolRef('document', row.documentId, row.title) })),
    }
  },
})

export const AI_READ_SERVICE_TOOLS = Object.freeze([searchRecords, reorderList, listReceivables, listContracts, priceHistory, supplierRisks, searchDocuments])
