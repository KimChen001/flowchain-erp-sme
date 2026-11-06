import {
  listMasterItems,
  listMasterSuppliers,
  listMasterWarehouses,
} from './master-data.mjs'
import { currentTenantContext, resolveCurrentUser } from './context.mjs'

export const aiDraftPreparationCapabilityCatalog = Object.freeze([
  {
    intent: 'prepare_purchase_request_draft',
    examples: ['PR A100 300 urgent', 'Create a purchase request for 200 units of A100', '帮我起一个采购申请，item B200，数量 50'],
    requiredSlots: ['item', 'quantity'],
    optionalSlots: ['supplier', 'requiredDate', 'prioritySignal', 'warehouse'],
    responseCards: ['pr_draft', 'missing_fields', 'confidence_summary', 'recommended_actions'],
    mode: 'draft_preparation',
  },
  {
    intent: 'prepare_rfq_draft',
    examples: ['Create RFQ for A100 qty 1000', 'quotation request motor 500 due next Friday', 'RFQ B200 200 pcs urgent'],
    requiredSlots: ['item', 'quantity'],
    optionalSlots: ['supplierCandidates', 'targetDeliveryDate', 'quotationDeadline', 'prioritySignal'],
    responseCards: ['rfq_draft', 'missing_fields', 'confidence_summary', 'recommended_actions'],
    mode: 'draft_preparation',
  },
])

const defaultPriorityReference = Object.freeze({
  priorityLevels: [
    { id: 'P1', label: 'High', keywords: ['urgent', 'high', '紧急', '高优先级'] },
    { id: 'P2', label: 'Normal', keywords: ['normal', '普通', '常规'] },
    { id: 'P3', label: 'Low', keywords: ['low', '低优先级'] },
  ],
  defaultPriorityId: 'P2',
})

const draftActionWords = /帮我|准备|生成|起一个|create|prepare|generate|start|draft|make/i
const prWords = /\bPR\b|purchase request|purchase requisition|采购申请|采购请求/i
const rfqWords = /\bRFQ\b|quotation request|quote request|request quotation|询价|报价请求/i
const statusWords = /status|pending|状态|待处理|进度|overdue|逾期/i
const prioritySignalPattern = /\burgent\b|\bhigh\b|\bnormal\b|\blow\b|紧急|高优先级|普通|常规|低优先级|priority\s+([a-z0-9_-]+)|优先级\s*([\w\u4e00-\u9fa5-]+)/i

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function toNumber(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizedText(value = '') {
  return String(value || '').trim().toLowerCase()
}

function compactText(value = '') {
  return normalizedText(value).replace(/[^\w\u4e00-\u9fa5-]+/g, '')
}

function containsValue(message, value) {
  const raw = normalizedText(value)
  if (!raw) return false
  return normalizedText(message).includes(raw) || compactText(message).includes(compactText(value))
}

function tokenize(value = '') {
  return normalizedText(value)
    .split(/[^\w\u4e00-\u9fa5-]+/)
    .filter((token) => token.length >= 2 && !['item', 'supplier', 'purchase', 'request', 'quotation', 'quote', 'create', 'draft'].includes(token))
}

export function normalizeDraftMessage(body = {}) {
  return String(body.question || body.message || body.prompt || body.text || '').trim()
}

function isDraftStyle(message = '') {
  return draftActionWords.test(message) || /\b(PR|RFQ)\b\s+[A-Z]{1,6}-?\d{2,}/i.test(message)
}

export function detectAiDraftIntent(message = '') {
  const text = String(message || '').trim()
  if (!text || statusWords.test(text)) return null
  const asksDraft = isDraftStyle(text)
  if (rfqWords.test(text) && asksDraft) return 'prepare_rfq_draft'
  if (prWords.test(text) && asksDraft) return 'prepare_purchase_request_draft'
  return null
}

function extractSku(message = '') {
  return message.match(/\b[A-Z]{1,6}-?\d{2,}\b/i)?.[0] || ''
}

function removeKnownSkus(message = '') {
  return message.replace(/\b[A-Z]{1,6}-?\d{2,}\b/gi, ' ')
}

function extractQuantity(message = '') {
  const withoutSkus = removeKnownSkus(message)
  const patterns = [
    /(?:qty|quantity)\s*[:：]?\s*(\d+(?:\.\d+)?)/i,
    /数量\s*[:：]?\s*(\d+(?:\.\d+)?)/i,
    /(?:买|采购)\s*(\d+(?:\.\d+)?)\s*(?:个|件|pcs|units?)?/i,
    /(\d+(?:\.\d+)?)\s*(?:pcs|units?|个|件)\b/i,
    /\b(\d+(?:\.\d+)?)\b/,
  ]
  for (const pattern of patterns) {
    const match = withoutSkus.match(pattern)
    if (match) return toNumber(match[1])
  }
  return null
}

function supplierCountFromMessage(message = '') {
  const digit = message.match(/(\d+|一|二|两|三|四|五)\s*(?:个|家)?\s*(?:suppliers?|供应商)/i)?.[1]
  if (!digit) return null
  return ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 })[digit] || toNumber(digit)
}

function extractItemKeyword(message = '') {
  const explicit = message.match(/(?:item|sku)\s*[:：]?\s*([\w\u4e00-\u9fa5-]+)/i)?.[1]
  if (explicit) return explicit
  const buy = message.match(/(?:买|采购)\s*(?:\d+(?:\.\d+)?\s*(?:个|件|pcs|units?)?\s*)?([\w\u4e00-\u9fa5-]+)/i)?.[1]
  if (buy && !/pr|rfq|purchase|quotation|request/i.test(buy)) return buy
  return extractSku(message)
}

function itemMatches(db = {}, message = '') {
  const items = listMasterItems(db)
  const sku = extractSku(message)
  const keyword = extractItemKeyword(message)
  const matches = items.filter((item) =>
    containsValue(message, item.sku) ||
    containsValue(message, item.id) ||
    containsValue(message, item.name) ||
    (sku && normalizedText(item.sku) === normalizedText(sku)) ||
    tokenize(item.name).some((token) => normalizedText(message).includes(token)) ||
    (keyword && tokenize(item.name).some((token) => token === normalizedText(keyword)))
  )
  return {
    raw: keyword || sku || '',
    matches: Array.from(new Map(matches.map((item) => [item.id, item])).values()),
  }
}

function supplierHint(message = '') {
  const id = message.match(/\bSUP-[A-Z0-9-]+\b/i)?.[0]
  if (id) return id
  const explicit = message.match(/(?:supplier|供应商|给)\s*[:：]?\s*([\w\u4e00-\u9fa5 -]+)/i)?.[1]
  if (!explicit) return ''
  return explicit.replace(/(?:询价|报价|采购|买|item|sku|qty|quantity|数量).*$/i, '').trim()
}

function supplierMatches(db = {}, message = '') {
  const suppliers = listMasterSuppliers(db)
  const hint = supplierHint(message)
  if (!hint || /^(供应商|suppliers?)$/i.test(hint)) return { raw: '', matches: [] }
  const matches = suppliers.filter((supplier) =>
    containsValue(hint, supplier.id) ||
    containsValue(hint, supplier.name) ||
    containsValue(message, supplier.id) ||
    containsValue(message, supplier.name) ||
    tokenize(supplier.name).some((token) => normalizedText(hint).includes(token))
  )
  return {
    raw: hint,
    matches: Array.from(new Map(matches.map((supplier) => [supplier.id, supplier])).values()),
  }
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10)
}

function nextWeekday(now, weekday) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  let days = (weekday - date.getUTCDay() + 7) % 7
  if (days === 0) days = 7
  date.setUTCDate(date.getUTCDate() + days)
  return dateToIso(date)
}

function extractDate(message = '', now = new Date()) {
  const iso = message.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return { value: iso[1], confidence: 'high', source: 'user_input' }
  const zh = message.match(/(\d{1,2})月(\d{1,2})日/)
  if (zh) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), Number(zh[1]) - 1, Number(zh[2])))
    return { value: dateToIso(date), confidence: 'high', source: 'user_input' }
  }
  if (/today|今天/i.test(message)) return { value: dateToIso(now), confidence: 'medium', source: 'relative_date' }
  if (/tomorrow|明天/i.test(message)) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    return { value: dateToIso(date), confidence: 'medium', source: 'relative_date' }
  }
  if (/next friday|下周五/i.test(message)) return { value: nextWeekday(now, 5), confidence: 'medium', source: 'relative_date' }
  if (/end of month|月底/i.test(message)) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    return { value: dateToIso(date), confidence: 'medium', source: 'relative_date' }
  }
  return { value: null, confidence: 'missing', source: 'missing' }
}

function configuredPriority(db = {}, options = {}) {
  const configured = options.priorityConfiguration ||
    db.tenantPriorityConfiguration ||
    db.tenantSettings?.priorityConfiguration ||
    db.settings?.priorityConfiguration
  return configured
    ? { config: configured, source: 'tenant_priority_mapping' }
    : { config: defaultPriorityReference, source: 'default_priority_reference' }
}

function extractPrioritySignal(message = '') {
  const match = message.match(prioritySignalPattern)
  if (!match) return ''
  return String(match[1] || match[2] || match[0]).trim()
}

function priorityFor(db = {}, message = '', options = {}) {
  const { config, source } = configuredPriority(db, options)
  const levels = asArray(config.priorityLevels)
  const prioritySignal = extractPrioritySignal(message) || levels
    .flatMap((level) => asArray(level.keywords))
    .find((keyword) => normalizedText(message).includes(normalizedText(keyword))) || ''
  if (prioritySignal) {
    const matched = levels.find((level) =>
      asArray(level.keywords).some((keyword) => normalizedText(keyword) === normalizedText(prioritySignal))
    )
    if (matched) {
      return {
        prioritySignal,
        priorityId: matched.id,
        priorityLabel: matched.label,
        prioritySource: source,
        priorityConfidence: source === 'tenant_priority_mapping' ? 'high' : 'medium',
      }
    }
    return {
      prioritySignal,
      priorityId: '',
      priorityLabel: '',
      prioritySource: 'user_input_unmapped',
      priorityConfidence: 'low',
    }
  }
  const fallback = levels.find((level) => level.id === config.defaultPriorityId)
  if (fallback) {
    return {
      prioritySignal: '',
      priorityId: fallback.id,
      priorityLabel: fallback.label,
      prioritySource: source,
      priorityConfidence: source === 'tenant_priority_mapping' ? 'medium' : 'medium',
    }
  }
  return {
    prioritySignal: '',
    priorityId: '',
    priorityLabel: '',
    prioritySource: 'missing',
    priorityConfidence: 'missing',
  }
}

function warehouseFor(db = {}, item = null, message = '') {
  const warehouses = listMasterWarehouses(db)
  const explicit = warehouses.find((warehouse) => containsValue(message, warehouse.id) || containsValue(message, warehouse.name))
  if (explicit) return { warehouseId: explicit.id, warehouseSource: 'matched_warehouse_master', confidence: 'high' }
  if (item?.defaultWarehouseId) return { warehouseId: item.defaultWarehouseId, warehouseSource: 'item_default', confidence: 'medium' }
  const fallback = warehouses[0]
  return fallback
    ? { warehouseId: fallback.id, warehouseSource: fallback.sourceType || 'default_reference', confidence: 'low' }
    : { warehouseId: '', warehouseSource: 'missing', confidence: 'missing' }
}

function confidenceForMatch(matches, raw) {
  if (matches.length > 1) return 'ambiguous'
  if (matches.length === 1) return raw ? 'high' : 'medium'
  return raw ? 'low' : 'missing'
}

function missingField(name, reason) {
  return { name, reason }
}

function recommendedActions(actions) {
  return { type: 'recommended_actions', actions }
}

function confidenceSummary(fields) {
  return { type: 'confidence_summary', fields }
}

function ambiguousCards(itemResolution, supplierResolution) {
  const cards = []
  if (itemResolution.matches.length > 1) {
    cards.push({
      type: 'ambiguous_match',
      field: 'item',
      matches: itemResolution.matches.slice(0, 5).map((item) => ({ itemId: item.id, sku: item.sku, name: item.name })),
    })
  }
  if (supplierResolution.matches.length > 1) {
    cards.push({
      type: 'ambiguous_match',
      field: 'supplier',
      matches: supplierResolution.matches.slice(0, 5).map((supplier) => ({ supplierId: supplier.id, name: supplier.name })),
    })
  }
  return cards
}

// Only the supplier's recorded term. Without one the draft leaves the term
// empty for a person to choose; the workspace's first term is not a choice.
function paymentTermsFor(supplier = null) {
  return supplier?.paymentTermsId
    ? { paymentTermsId: supplier.paymentTermsId, paymentTermsSource: 'supplier_default', confidence: 'medium' }
    : { paymentTermsId: '', paymentTermsSource: 'missing', confidence: 'missing' }
}

function evidenceForPriority(priority) {
  if (!priority.priorityId) {
    return {
      type: 'priority_reference',
      id: '',
      summary: priority.prioritySource === 'user_input_unmapped'
        ? '已捕捉优先级信号，但未映射到已配置优先级。'
        : '当前没有可用优先级参考。',
    }
  }
  return {
    type: 'priority_reference',
    id: priority.priorityId,
    summary: priority.prioritySource === 'tenant_priority_mapping'
      ? '优先级来自租户优先级配置。'
      : '优先级来自默认参考配置，仍需人工复核。',
  }
}

function supplierById(db = {}, id = '') {
  return listMasterSuppliers(db).find((supplier) => normalizedText(supplier.id) === normalizedText(id)) || null
}

function resolveSupplierForDraft(db = {}, message = '', item = null, options = {}) {
  const explicit = supplierMatches(db, message)
  if (explicit.matches.length) return { ...explicit, source: 'matched_supplier_master', confidence: confidenceForMatch(explicit.matches, explicit.raw) }
  if (item?.preferredSupplierSource === 'matched_supplier_master') {
    const supplier = supplierById(db, item.preferredSupplierId)
    if (supplier) {
      return {
        raw: item.preferredSupplierId,
        matches: [supplier],
        source: 'item_preferred_supplier',
        confidence: 'medium',
      }
    }
  }
  return { raw: explicit.raw, matches: [], source: options.required ? 'missing' : 'not_provided', confidence: explicit.raw ? 'low' : 'missing' }
}

function rfqSupplierCandidates(db = {}, message = '', item = null) {
  const explicit = supplierMatches(db, message)
  if (explicit.matches.length) {
    return {
      raw: explicit.raw,
      confidence: confidenceForMatch(explicit.matches, explicit.raw),
      candidates: explicit.matches.slice(0, 5).map((supplier) => ({ supplierId: supplier.id, name: supplier.name, source: 'matched_supplier_master', confidence: explicit.matches.length === 1 ? 'high' : 'ambiguous' })),
      matches: explicit.matches,
    }
  }
  const count = supplierCountFromMessage(message)
  if (count) {
    const suppliers = listMasterSuppliers(db).slice(0, count)
    return {
      raw: `${count}`,
      confidence: suppliers.length ? 'medium' : 'missing',
      candidates: suppliers.map((supplier) => ({ supplierId: supplier.id, name: supplier.name, source: 'supplier_master_candidate', confidence: 'medium' })),
      matches: suppliers,
    }
  }
  const inferred = resolveSupplierForDraft(db, message, item)
  return {
    raw: inferred.raw,
    confidence: inferred.confidence,
    candidates: inferred.matches.map((supplier) => ({ supplierId: supplier.id, name: supplier.name, source: inferred.source, confidence: inferred.confidence })),
    matches: inferred.matches,
  }
}

function buildCommon(db = {}, body = {}, options = {}) {
  const message = normalizeDraftMessage(body)
  const now = options.now || new Date()
  const currentUser = options.currentUser || resolveCurrentUser(db, options.authorization || '')
  const tenant = options.tenant || currentTenantContext
  const itemResolution = itemMatches(db, message)
  const item = itemResolution.matches.length === 1 ? itemResolution.matches[0] : null
  const quantity = extractQuantity(message)
  const dueDate = extractDate(message, now)
  const priority = priorityFor(db, message, options)
  const warehouse = warehouseFor(db, item, message)
  const evidence = []
  if (item) evidence.push({ type: 'item_master', id: item.id, summary: 'Matched item from Master Data.' })
  if (itemResolution.matches.length > 1) evidence.push({ type: 'ambiguous_match', id: 'item', summary: `${itemResolution.matches.length} item master records matched.` })
  if (!item && itemResolution.raw) evidence.push({ type: 'item_keyword', id: itemResolution.raw, summary: 'Item keyword was captured but not matched to Master Data.' })
  if (warehouse.warehouseId) evidence.push({ type: 'warehouse_reference', id: warehouse.warehouseId, summary: `Warehouse source is ${warehouse.warehouseSource}.` })
  evidence.push(evidenceForPriority(priority))
  return { message, currentUser, tenant, itemResolution, item, quantity, dueDate, priority, warehouse, evidence }
}

function buildPurchaseRequestDraft(db = {}, body = {}, options = {}) {
  const common = buildCommon(db, body, options)
  const supplierResolution = resolveSupplierForDraft(db, common.message, common.item)
  const supplier = supplierResolution.matches.length === 1 ? supplierResolution.matches[0] : null
  if (supplier) common.evidence.push({ type: 'supplier_master', id: supplier.id, summary: supplierResolution.source === 'item_preferred_supplier' ? 'Supplier inferred from matched item preferred supplier.' : 'Matched supplier from Master Data.' })
  if (supplierResolution.matches.length > 1) common.evidence.push({ type: 'ambiguous_match', id: 'supplier', summary: `${supplierResolution.matches.length} supplier master records matched.` })
  const missing = []
  if (!common.item) missing.push(missingField('item', common.itemResolution.matches.length > 1 ? '多个物料匹配项需要人工复核。' : '未匹配到物料主数据。'))
  if (common.quantity === null) missing.push(missingField('quantity', '缺少数量。'))
  if (!common.dueDate.value) missing.push(missingField('requiredDate', '缺少需求日期。'))
  if (!supplier) missing.push(missingField('preferredSupplierId', supplierResolution.matches.length > 1 ? '多个供应商匹配项需要人工复核。' : '没有可靠供应商候选。'))
  if (!common.priority.priorityId) missing.push(missingField('priorityId', '优先级信号未映射到已配置优先级。'))
  const data = {
    draftType: 'purchase_request',
    status: missing.length ? 'needs_review' : 'ready_for_review',
    documentStatus: 'draft',
    itemId: common.item?.id || '',
    itemLabel: common.item?.name || common.itemResolution.raw || '',
    sku: common.item?.sku || extractSku(common.message),
    quantity: common.quantity,
    uom: common.item?.baseUom || 'pcs',
    requiredDate: common.dueDate.value,
    warehouseId: common.warehouse.warehouseId,
    warehouseSource: common.warehouse.warehouseSource,
    preferredSupplierId: supplier?.id || '',
    preferredSupplierSource: supplier ? supplierResolution.source : supplierResolution.source,
    prioritySignal: common.priority.prioritySignal,
    priorityId: common.priority.priorityId,
    priorityLabel: common.priority.priorityLabel,
    prioritySource: common.priority.prioritySource,
    priorityConfidence: common.priority.priorityConfidence,
    requesterId: common.currentUser.id,
    tenantId: common.tenant.id,
  }
  const fields = {
    itemId: confidenceForMatch(common.itemResolution.matches, common.itemResolution.raw),
    quantity: common.quantity === null ? 'missing' : 'high',
    requiredDate: common.dueDate.confidence,
    warehouseId: common.warehouse.confidence,
    preferredSupplierId: supplierResolution.confidence,
    priorityId: common.priority.priorityConfidence,
  }
  return {
    message: missing.length ? '我准备了采购申请草稿，但仍需人工复核后才能保存或提交。' : '我准备了可复核的采购申请草稿。',
    intent: {
      name: 'prepare_purchase_request_draft',
      confidence: common.item && common.quantity !== null ? 0.86 : 0.68,
      slots: {
        item: common.item?.sku || common.itemResolution.raw,
        quantity: common.quantity,
        supplier: supplier?.id || supplierResolution.raw,
        prioritySignal: common.priority.prioritySignal,
      },
    },
    cards: [
      { type: 'pr_draft', title: '采购申请草稿', reviewRequired: true, data },
      { type: 'missing_fields', fields: missing },
      confidenceSummary(fields),
      ...ambiguousCards(common.itemResolution, supplierResolution),
      recommendedActions([
        { label: '复核草稿', kind: 'review' },
        { label: '编辑草稿字段', kind: 'edit' },
      ]),
    ],
    evidence: common.evidence,
  }
}

function buildRfqDraft(db = {}, body = {}, options = {}) {
  const common = buildCommon(db, body, options)
  const suppliers = rfqSupplierCandidates(db, common.message, common.item)
  const payment = paymentTermsFor(suppliers.matches.length === 1 ? suppliers.matches[0] : null)
  const missing = []
  if (!common.item) missing.push(missingField('item', common.itemResolution.matches.length > 1 ? '多个物料匹配项需要人工复核。' : '未匹配到物料主数据。'))
  if (common.quantity === null) missing.push(missingField('quantity', '缺少数量。'))
  if (!common.dueDate.value) missing.push(missingField('targetDeliveryDate', '缺少目标交付日期。'))
  if (!suppliers.candidates.length) missing.push(missingField('supplierCandidates', '主数据中没有可用供应商候选。'))
  missing.push(missingField('quotationDeadline', '缺少报价截止日期。'))
  if (!common.priority.priorityId) missing.push(missingField('priorityId', '优先级信号未映射到已配置优先级。'))
  if (suppliers.candidates.length) common.evidence.push({ type: 'supplier_master', id: suppliers.candidates[0].supplierId, summary: `${suppliers.candidates.length} 个供应商候选来自主数据。` })
  if (payment.paymentTermsId) common.evidence.push({ type: 'payment_terms', id: payment.paymentTermsId, summary: `付款条款来源：${payment.paymentTermsSource}。` })
  const data = {
    draftType: 'rfq',
    status: missing.length ? 'needs_review' : 'ready_for_review',
    documentStatus: 'draft',
    itemId: common.item?.id || '',
    itemLabel: common.item?.name || common.itemResolution.raw || '',
    sku: common.item?.sku || extractSku(common.message),
    quantity: common.quantity,
    uom: common.item?.baseUom || 'pcs',
    targetDeliveryDate: common.dueDate.value,
    supplierCandidates: suppliers.candidates,
    quotationDeadline: null,
    deliveryLocation: common.warehouse.warehouseId,
    paymentTermsId: payment.paymentTermsId,
    paymentTermsSource: payment.paymentTermsSource,
    prioritySignal: common.priority.prioritySignal,
    priorityId: common.priority.priorityId,
    priorityLabel: common.priority.priorityLabel,
    prioritySource: common.priority.prioritySource,
    priorityConfidence: common.priority.priorityConfidence,
    tenantId: common.tenant.id,
  }
  const fields = {
    itemId: confidenceForMatch(common.itemResolution.matches, common.itemResolution.raw),
    quantity: common.quantity === null ? 'missing' : 'high',
    targetDeliveryDate: common.dueDate.confidence,
    supplierCandidates: suppliers.confidence,
    priorityId: common.priority.priorityConfidence,
    quotationDeadline: 'missing',
  }
  return {
    message: missing.length ? '我准备了 RFQ 草稿，但仍需人工复核后才能保存或发送。' : '我准备了可复核的 RFQ 草稿。',
    intent: {
      name: 'prepare_rfq_draft',
      confidence: common.item && common.quantity !== null ? 0.84 : 0.66,
      slots: {
        item: common.item?.sku || common.itemResolution.raw,
        quantity: common.quantity,
        supplierCount: supplierCountFromMessage(common.message),
        prioritySignal: common.priority.prioritySignal,
      },
    },
    cards: [
      { type: 'rfq_draft', title: 'RFQ 草稿', reviewRequired: true, data },
      { type: 'missing_fields', fields: missing },
      confidenceSummary(fields),
      ...ambiguousCards(common.itemResolution, { raw: suppliers.raw, matches: suppliers.matches }),
      recommendedActions([
        { label: '复核草稿', kind: 'review' },
        { label: '编辑供应商列表', kind: 'edit' },
      ]),
    ],
    evidence: common.evidence,
  }
}

export function buildAiDraftPreparationResponse(db = {}, body = {}, options = {}) {
  const message = normalizeDraftMessage(body)
  const intent = detectAiDraftIntent(message)
  if (!intent) return null
  const response = intent === 'prepare_rfq_draft'
    ? buildRfqDraft(db, body, options)
    : buildPurchaseRequestDraft(db, body, options)
  return {
    provider: 'local_draft_preparation',
    mode: 'draft_preparation',
    content: response.message,
    ...response,
    capabilityCatalog: aiDraftPreparationCapabilityCatalog.map((item) => ({
      ...item,
      examples: [...item.examples],
      requiredSlots: [...item.requiredSlots],
      optionalSlots: [...item.optionalSlots],
      responseCards: [...item.responseCards],
    })),
  }
}
