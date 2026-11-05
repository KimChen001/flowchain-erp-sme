import { listMasterItems, listMasterSuppliers } from './master-data.mjs'
import {
  activeContextEvidence,
  resolveContextualEntityId,
} from './ai-active-context.mjs'

export const aiRfqOperationalCapabilityCatalog = Object.freeze([
  {
    intent: 'rfq_status_query',
    examples: ['RFQ-1001 status', 'Show RFQ RFQ-1001', '查看 RFQ-1001'],
    requiredSlots: ['rfqId'],
    optionalSlots: [],
    responseCards: ['rfq_status', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'rfq_response_query',
    examples: ['RFQ pending supplier response', '哪些询价还没报价？', 'Show RFQs with no supplier response'],
    requiredSlots: [],
    optionalSlots: ['rfqId'],
    responseCards: ['rfq_response_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'supplier_rfq_participation_query',
    examples: ['Show RFQs for ABC Components', '供应商 SUP-001 参与了哪些 RFQ？', 'ABC supplier RFQ status'],
    requiredSlots: ['supplier'],
    optionalSlots: ['status'],
    responseCards: ['supplier_rfq_participation', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
])

const rfqIdPattern = /\bRFQ[-\w]*\d+\b/i
const draftVerbPattern = /create|prepare|generate|start|draft|帮我|生成|准备|起一个|做一个/i
const rfqResponsePattern = /还没.*(?:回复|报价)|没.*(?:回复|报价)|waiting for supplier responses?|pending supplier response|no supplier response|with no supplier response|rfqs?\s+pending|pending\s+rfqs?|response|responses|回复|报价/i
const supplierRfqPattern = /supplier.*rfq|rfq.*supplier|供应商.*(?:rfq|询价)|参与.*询价|rfqs?\s+for/i
const rfqStatusPattern = /\brfqs?\b|询价|报价请求/i
const statusWordPattern = /status|查看|show|什么状态|到哪一步|现在/i

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizedText(value = '') {
  return String(value || '').trim().toLowerCase()
}

function compactText(value = '') {
  return normalizedText(value).replace(/[^\w\u4e00-\u9fa5-]+/g, '')
}

function containsValue(text, value) {
  const raw = normalizedText(value)
  if (!raw) return false
  return normalizedText(text).includes(raw) || compactText(text).includes(compactText(value))
}

export function normalizeRfqOperationalMessage(body = {}) {
  return String(body.question || body.message || body.prompt || body.text || '').trim()
}

function rfqIdFor(rfq = {}) {
  return String(rfq.id || rfq.rfq || rfq.rfqId || rfq.number || '')
}

function normalizeStatus(status = '') {
  const raw = String(status || '').trim()
  const lower = raw.toLowerCase()
  if (['进行中', '比价中', 'open', 'active', 'pending'].includes(lower)) return 'open'
  if (['已授标', 'awarded'].includes(lower)) return 'awarded'
  if (['已转po', '已转 PO', 'converted_to_po', 'converted'].includes(raw) || lower === 'converted_to_po') return 'converted_to_po'
  if (['已关闭', '已取消', 'closed', 'cancelled', 'canceled'].includes(lower)) return 'closed'
  return raw || 'unknown'
}

function isOpenRfq(rfq = {}) {
  return ['open', '进行中', '比价中', 'active', 'pending'].includes(normalizeStatus(rfq.status))
}

function rfqsFor(db = {}, options = {}) {
  if (typeof options.ensureRfqs === 'function') return asArray(options.ensureRfqs(db))
  return asArray(db.rfqs)
}

function extractRfqId(message = '') {
  return message.match(rfqIdPattern)?.[0] || ''
}

function resolveRfqId(body = {}, message = '') {
  return resolveContextualEntityId(body, message, 'rfq', extractRfqId(message))
}

function findRfq(rfqs = [], id = '') {
  const key = normalizedText(id)
  // By id or by the number the RFQ shows (RFQ-202611-0001).
  return rfqs.find((rfq) => normalizedText(rfqIdFor(rfq)) === key || (rfq.number && normalizedText(rfq.number) === key)) || null
}

function supplierCount(rfq = {}) {
  if (Array.isArray(rfq.invitedSuppliers)) return rfq.invitedSuppliers.length
  if (Array.isArray(rfq.participants)) return rfq.participants.length
  if (Array.isArray(rfq.responses)) return Math.max(rfq.responses.length, toNumber(rfq.suppliers, 0))
  return toNumber(rfq.suppliers, 0)
}

function responseRecords(rfq = {}) {
  const records = []
  for (const record of asArray(rfq.responses)) records.push(record)
  for (const record of asArray(rfq.participants)) records.push(record)
  return records
}

function responseStats(rfq = {}) {
  const records = responseRecords(rfq)
  if (records.length) {
    const responded = records.filter((record) =>
      record.responded === true ||
      record.submitted === true ||
      record.quoteReceived === true ||
      ['responded', 'submitted', 'quoted', 'received'].includes(normalizedText(record.responseStatus || record.status))
    ).length
    const pending = records.filter((record) =>
      record.responded === false ||
      ['pending', 'waiting', 'no_response'].includes(normalizedText(record.responseStatus || record.status))
    ).length
    return {
      supplierCount: Math.max(records.length, supplierCount(rfq)),
      respondedSupplierCount: responded,
      pendingSupplierCount: pending || Math.max(0, Math.max(records.length, supplierCount(rfq)) - responded),
      source: 'response_records',
    }
  }
  const total = supplierCount(rfq)
  const responded = toNumber(rfq.quoted ?? rfq.respondedSupplierCount ?? rfq.quoteReceivedCount, 0)
  return {
    supplierCount: total,
    respondedSupplierCount: responded,
    pendingSupplierCount: Math.max(0, total - responded),
    source: total || responded ? 'rfq_summary_fields' : 'missing_response_detail',
  }
}

function dueDateFor(rfq = {}) {
  return rfq.due || rfq.dueDate || rfq.targetDeliveryDate || rfq.quotationDeadline || ''
}

function itemIdsFor(db = {}, rfq = {}) {
  const items = listMasterItems(db)
  const rawValues = [rfq.itemId, rfq.sourceSku, rfq.sku, rfq.itemSku, rfq.sourceName, rfq.title].filter(Boolean)
  const matches = items.filter((item) =>
    rawValues.some((value) => [item.id, item.sku, item.name].some((candidate) => containsValue(value, candidate)))
  )
  return Array.from(new Set(matches.map((item) => item.id)))
}

function riskLevelFor(rfq = {}) {
  const stats = responseStats(rfq)
  if (!isOpenRfq(rfq)) return 'low'
  if (stats.supplierCount === 0) return 'unknown'
  if (stats.respondedSupplierCount === 0) return 'high'
  if (stats.pendingSupplierCount > 0) return 'medium'
  return 'low'
}

function rfqStatusData(db = {}, rfq = {}) {
  const stats = responseStats(rfq)
  return {
    rfqId: rfqIdFor(rfq),
    status: normalizeStatus(rfq.status),
    supplierCount: stats.supplierCount,
    respondedSupplierCount: stats.respondedSupplierCount,
    pendingSupplierCount: stats.pendingSupplierCount,
    dueDate: dueDateFor(rfq),
    itemIds: itemIdsFor(db, rfq),
    riskLevel: riskLevelFor(rfq),
  }
}

function evidenceCard(evidence = []) {
  return { type: 'evidence', evidence }
}

function recommendedActions(actions = []) {
  return { type: 'recommended_actions', actions }
}

function supplierFollowupDraftAction(rfq = {}, stats = responseStats(rfq)) {
  const rfqId = rfqIdFor(rfq)
  const pending = stats.pendingSupplierCount
  return {
    label: `预览 ${rfqId || '该 RFQ'} 供应商提醒草稿，需人工审阅后再发送。`,
    kind: 'draft_preview',
    target: '',
    draftType: 'supplier_followup_draft',
    draftTitle: `${rfqId || 'RFQ'} 供应商提醒草稿预览`,
    requiresHumanReview: true,
    payload: {
      supplierIdOrName: rfq.supplierName || rfq.awardedSupplier || rfq.bestSupplier || `RFQ ${rfqId}`,
      message: `请确认 ${rfqId} 的报价回复状态及预计回复时间。${dueDateFor(rfq) ? `当前报价截止日期为 ${dueDateFor(rfq)}。` : ''}${pending ? `仍有 ${pending} 家供应商待回复。` : ''}`,
      reason: 'AI 基于 RFQ 待回复证据建议跟进供应商。',
    },
    originEvidence: [
      { type: 'rfq', id: rfqId, summary: '已匹配 RFQ 记录。' },
      { type: 'supplier_response_evidence', id: rfqId, summary: stats.source === 'response_records' ? '供应商回复状态来自回复明细。' : '供应商回复状态来自 RFQ 汇总字段。' },
    ],
  }
}

function missingFieldCard(name, reason) {
  return { type: 'missing_fields', fields: [{ name, reason }] }
}

function emptyStateCard(title, reason) {
  return { type: 'empty_state', title, reason }
}

function extractSupplierHint(message = '') {
  const id = message.match(/\bSUP-[A-Z0-9-]+\b/i)?.[0]
  if (id) return id
  return message
    .replace(/rfqs?\s+for|show|status|open|supplier|供应商|参与了哪些询价|有哪些|询价|rfq/gi, ' ')
    .trim()
}

function supplierMatches(db = {}, message = '') {
  const suppliers = listMasterSuppliers(db)
  const hint = extractSupplierHint(message)
  if (!hint) return { raw: '', matches: [] }
  const exact = suppliers.filter((supplier) =>
    normalizedText(hint) === normalizedText(supplier.id) ||
    normalizedText(hint) === normalizedText(supplier.name) ||
    normalizedText(message).includes(normalizedText(supplier.id)) ||
    normalizedText(message).includes(normalizedText(supplier.name))
  )
  if (exact.length) {
    return {
      raw: hint,
      matches: Array.from(new Map(exact.map((supplier) => [supplier.id, supplier])).values()),
    }
  }
  const matches = suppliers.filter((supplier) =>
    containsValue(hint, supplier.id) ||
    containsValue(hint, supplier.name) ||
    containsValue(message, supplier.id) ||
    containsValue(message, supplier.name) ||
    normalizedText(supplier.name).split(/[^\w\u4e00-\u9fa5-]+/).some((token) => token.length >= 2 && normalizedText(hint).includes(token))
  )
  return {
    raw: hint,
    matches: Array.from(new Map(matches.map((supplier) => [supplier.id, supplier])).values()),
  }
}

function rfqSupplierValues(rfq = {}) {
  return [
    rfq.supplierId,
    rfq.supplier,
    rfq.supplierName,
    rfq.bestSupplier,
    ...asArray(rfq.invitedSuppliers),
    ...asArray(rfq.suppliersList),
    ...asArray(rfq.participants).flatMap((participant) => [participant.supplierId, participant.supplier, participant.supplierName, participant.name]),
    ...asArray(rfq.responses).flatMap((response) => [response.supplierId, response.supplier, response.supplierName, response.name]),
  ].filter(Boolean)
}

function rfqInvolvesSupplier(rfq = {}, supplier = {}) {
  return rfqSupplierValues(rfq).some((value) =>
    normalizedText(value) === normalizedText(supplier.id) ||
    normalizedText(value) === normalizedText(supplier.name) ||
    containsValue(value, supplier.name)
  )
}

function supplierResponseStatus(rfq = {}, supplier = {}) {
  const records = responseRecords(rfq)
  const record = records.find((item) =>
    [item.supplierId, item.supplier, item.supplierName, item.name].some((value) =>
      value && (normalizedText(value) === normalizedText(supplier.id) || normalizedText(value) === normalizedText(supplier.name))
    )
  )
  if (record) {
    if (record.responded === true || record.submitted === true || record.quoteReceived === true) return 'responded'
    if (record.responded === false) return 'pending'
    return record.responseStatus || record.status || 'unknown'
  }
  if (normalizedText(rfq.bestSupplier) === normalizedText(supplier.name)) return 'responded'
  return 'unknown'
}

export function detectAiRfqOperationalIntent(message = '') {
  const text = String(message || '').trim()
  if (!text || draftVerbPattern.test(text)) return null
  const hasRfq = rfqStatusPattern.test(text) || rfqIdPattern.test(text)
  if (!hasRfq) return null
  if (rfqResponsePattern.test(text)) return 'rfq_response_query'
  if (supplierRfqPattern.test(text) && !rfqIdPattern.test(text)) return 'supplier_rfq_participation_query'
  if (rfqIdPattern.test(text) || statusWordPattern.test(text)) return 'rfq_status_query'
  return null
}

function buildMissingRfqIdResponse(intentName = 'rfq_status_query') {
  return {
    message: '请提供 RFQ ID，我会只读查询该询价记录。',
    intent: { name: intentName, confidence: 0.66, slots: { rfqId: null } },
    cards: [
      missingFieldCard('rfqId', '缺少 RFQ ID。'),
      recommendedActions([{ label: '复核 RFQ', kind: 'deep_link', target: '/procurement?view=rfqs' }]),
    ],
    evidence: [{ type: 'rfq', id: '', summary: '本次查询需要 RFQ ID。' }],
  }
}

function buildRfqNotFoundResponse(rfqId = '', intentName = 'rfq_status_query') {
  return {
    message: `我没有找到 RFQ ${rfqId}。`,
    intent: { name: intentName, confidence: 0.74, slots: { rfqId } },
    cards: [
      emptyStateCard('未找到 RFQ', `没有 RFQ 记录匹配 ${rfqId}。`),
      recommendedActions([{ label: '复核 RFQ', kind: 'deep_link', target: '/procurement?view=rfqs' }]),
    ],
    evidence: [{ type: 'rfq', id: rfqId, summary: '没有 RFQ 记录匹配该 ID。' }],
  }
}

function buildRfqStatusResponse(db = {}, message = '', options = {}) {
  const rfqs = rfqsFor(db, options)
  const resolution = resolveRfqId(options.body, message)
  const rfqId = resolution.entityId
  if (!rfqId) return buildMissingRfqIdResponse()
  const rfq = findRfq(rfqs, rfqId)
  if (!rfq) return buildRfqNotFoundResponse(rfqId)
  const stats = responseStats(rfq)
  const evidence = [
    { type: 'rfq', id: rfqIdFor(rfq), summary: '已匹配 RFQ 记录。' },
    { type: 'supplier_response_evidence', id: rfqIdFor(rfq), summary: stats.source === 'response_records' ? '供应商回复状态来自回复明细。' : '供应商回复状态来自 RFQ 汇总字段。' },
  ]
  const contextEvidence = activeContextEvidence(resolution.context, 'rfq')
  if (contextEvidence) evidence.push(contextEvidence)
  if (stats.source === 'missing_response_detail') evidence.push({ type: 'limited_data', id: rfqIdFor(rfq), summary: '当前数据缺少 RFQ 回复明细。' })
  return {
    message: `${rfqIdFor(rfq)} 当前状态为 ${normalizeStatus(rfq.status)}。`,
    intent: { name: 'rfq_status_query', confidence: 0.88, slots: { rfqId: rfqIdFor(rfq) } },
    cards: [
      { type: 'rfq_status', title: rfqIdFor(rfq), data: rfqStatusData(db, rfq) },
      evidenceCard(evidence),
      recommendedActions([
        { label: '打开 RFQ', kind: 'deep_link', target: `/procurement?view=rfqs&rfqId=${encodeURIComponent(rfqIdFor(rfq))}` },
        supplierFollowupDraftAction(rfq, stats),
        { label: '打开采购工作台', kind: 'deep_link', target: '/procurement?view=rfqs' },
      ]),
    ],
    evidence,
  }
}

function pendingRfqSummary(rfqs = [], db = {}) {
  return rfqs
    .filter((rfq) => isOpenRfq(rfq) && responseStats(rfq).pendingSupplierCount > 0)
    .map((rfq) => ({
      rfqId: rfqIdFor(rfq),
      status: normalizeStatus(rfq.status),
      pendingSupplierCount: responseStats(rfq).pendingSupplierCount,
      respondedSupplierCount: responseStats(rfq).respondedSupplierCount,
      dueDate: dueDateFor(rfq),
      riskLevel: riskLevelFor(rfq),
      itemIds: itemIdsFor(db, rfq),
    }))
}

function buildRfqResponseQuery(db = {}, message = '', options = {}) {
  const rfqs = rfqsFor(db, options)
  const resolution = resolveRfqId(options.body, message)
  const rfqId = resolution.entityId
  if (rfqId) {
    const rfq = findRfq(rfqs, rfqId)
    if (!rfq) return buildRfqNotFoundResponse(rfqId, 'rfq_response_query')
    const stats = responseStats(rfq)
    const evidence = [
      { type: 'rfq', id: rfqIdFor(rfq), summary: '已匹配 RFQ 记录。' },
      { type: 'supplier_response_evidence', id: rfqIdFor(rfq), summary: stats.source === 'response_records' ? '供应商回复状态来自回复明细。' : '供应商回复状态来自 RFQ 汇总字段。' },
    ]
    const contextEvidence = activeContextEvidence(resolution.context, 'rfq')
    if (contextEvidence) evidence.push(contextEvidence)
    return {
      message: `${rfqIdFor(rfq)} 还有 ${stats.pendingSupplierCount} 个供应商回复待确认。`,
      intent: { name: 'rfq_response_query', confidence: 0.86, slots: { rfqId: rfqIdFor(rfq), supplier: null } },
      cards: [
        {
          type: 'rfq_response_summary',
          title: `${rfqIdFor(rfq)} 供应商回复`,
          data: {
            totalOpenRfqs: isOpenRfq(rfq) ? 1 : 0,
            rfqsWithPendingResponses: stats.pendingSupplierCount > 0 ? 1 : 0,
            topPendingRfqs: pendingRfqSummary([rfq], db),
          },
        },
        evidenceCard(evidence),
        recommendedActions([
          { label: '复核供应商回复', kind: 'deep_link', target: `/procurement?view=rfqs&rfqId=${encodeURIComponent(rfqIdFor(rfq))}` },
          supplierFollowupDraftAction(rfq, stats),
        ]),
      ],
      evidence,
    }
  }
  const openRfqs = rfqs.filter(isOpenRfq)
  const pending = pendingRfqSummary(openRfqs, db)
  const evidence = pending.length
    ? pending.slice(0, 5).map((rfq) => ({ type: 'rfq', id: rfq.rfqId, summary: 'RFQ 仍有供应商待回复。' }))
    : [{ type: 'empty_state', id: 'rfq_responses', summary: '当前没有发现 RFQ 供应商待回复。' }]
  return {
    message: pending.length
      ? `我找到 ${pending.length} 个仍在等待供应商回复的 RFQ。`
      : '当前数据没有发现供应商待回复的 RFQ。',
    intent: { name: 'rfq_response_query', confidence: 0.84, slots: { rfqId: null, supplier: null } },
    cards: [
      {
        type: 'rfq_response_summary',
        title: 'RFQ 待回复摘要',
        data: {
          totalOpenRfqs: openRfqs.length,
          rfqsWithPendingResponses: pending.length,
          topPendingRfqs: pending.slice(0, 5),
        },
      },
      ...(pending.length ? [] : [emptyStateCard('暂无 RFQ 待回复', '当前未结 RFQ 没有显示供应商待回复。')]),
      evidenceCard(evidence),
      recommendedActions([{ label: '复核 RFQ', kind: 'deep_link', target: '/procurement?view=rfqs' }]),
    ],
    evidence,
  }
}

function buildSupplierParticipationQuery(db = {}, message = '', options = {}) {
  const supplier = supplierMatches(db, message)
  if (!supplier.raw) {
    return {
      message: '请提供供应商名称或供应商 ID，我会只读复核 RFQ 参与记录。',
      intent: { name: 'supplier_rfq_participation_query', confidence: 0.62, slots: { supplier: null } },
      cards: [
        missingFieldCard('supplier', '缺少供应商。'),
        recommendedActions([{ label: '复核 RFQ', kind: 'deep_link', target: '/procurement?view=rfqs' }]),
      ],
      evidence: [{ type: 'supplier_master', id: '', summary: 'RFQ 参与查询需要供应商。' }],
    }
  }
  if (supplier.matches.length > 1) {
    return {
      message: '我找到多个供应商匹配项，请选择供应商 ID 后继续。',
      intent: { name: 'supplier_rfq_participation_query', confidence: 0.62, slots: { supplier: 'ambiguous' } },
      cards: [
        { type: 'ambiguous_match', field: 'supplier', matches: supplier.matches.slice(0, 5).map((item) => ({ supplierId: item.id, name: item.name })) },
        recommendedActions([{ label: '复核供应商', kind: 'deep_link', target: '/srm?view=suppliers' }]),
      ],
      evidence: [{ type: 'supplier_master', id: '', summary: `${supplier.matches.length} supplier master records matched.` }],
    }
  }
  if (!supplier.matches.length) {
    return {
      message: '我没有在供应商主数据中找到该供应商。',
      intent: { name: 'supplier_rfq_participation_query', confidence: 0.68, slots: { supplier: supplier.raw } },
      cards: [
        emptyStateCard('未找到供应商', '没有供应商主数据匹配当前输入。'),
        recommendedActions([{ label: '复核供应商', kind: 'deep_link', target: '/srm?view=suppliers' }]),
      ],
      evidence: [{ type: 'supplier_master', id: supplier.raw, summary: '未匹配到供应商主数据。' }],
    }
  }
  const matchedSupplier = supplier.matches[0]
  const related = rfqsFor(db, options).filter((rfq) => rfqInvolvesSupplier(rfq, matchedSupplier))
  const recentRfqs = related.slice(0, 8).map((rfq) => ({
    rfqId: rfqIdFor(rfq),
    status: normalizeStatus(rfq.status),
    responseStatus: supplierResponseStatus(rfq, matchedSupplier),
    dueDate: dueDateFor(rfq),
  }))
  const data = {
    supplierId: matchedSupplier.id,
    supplierName: matchedSupplier.name,
    totalRfqs: related.length,
    openRfqs: related.filter(isOpenRfq).length,
    pendingResponseCount: recentRfqs.filter((rfq) => rfq.responseStatus === 'pending' || rfq.responseStatus === 'unknown').length,
    respondedCount: recentRfqs.filter((rfq) => rfq.responseStatus === 'responded').length,
    recentRfqs,
  }
  const evidence = [
    { type: 'supplier_master', id: matchedSupplier.id, summary: '已匹配供应商主数据。' },
    ...(related.length
      ? [{ type: 'rfq', id: related[0] ? rfqIdFor(related[0]) : '', summary: `${related.length} 个 RFQ 记录引用该供应商。` }]
      : [{ type: 'empty_state', id: matchedSupplier.id, summary: '当前没有发现该供应商的 RFQ 参与记录。' }]),
  ]
  return {
    message: related.length
      ? `${matchedSupplier.name} 被 ${related.length} 个 RFQ 引用。`
      : `当前数据没有显示 ${matchedSupplier.name} 的 RFQ 参与记录。`,
    intent: { name: 'supplier_rfq_participation_query', confidence: 0.84, slots: { supplier: matchedSupplier.id } },
    cards: [
      { type: 'supplier_rfq_participation', title: `${matchedSupplier.name} RFQ 参与`, data },
      ...(related.length ? [] : [emptyStateCard('暂无 RFQ 参与', '当前没有 RFQ 记录引用该供应商。')]),
      evidenceCard(evidence),
      recommendedActions([
        { label: '复核供应商', kind: 'deep_link', target: `/srm?view=supplier&supplierId=${encodeURIComponent(matchedSupplier.id)}` },
        { label: '复核 RFQ', kind: 'deep_link', target: '/procurement?view=rfqs' },
      ]),
    ],
    evidence,
  }
}

export function buildAiRfqOperationalResponse(db = {}, body = {}, options = {}) {
  const message = normalizeRfqOperationalMessage(body)
  const intent = detectAiRfqOperationalIntent(message)
  if (!intent) return null
  const contextOptions = { ...options, body }
  const response = intent === 'rfq_status_query'
    ? buildRfqStatusResponse(db, message, contextOptions)
    : intent === 'rfq_response_query'
      ? buildRfqResponseQuery(db, message, contextOptions)
      : buildSupplierParticipationQuery(db, message, contextOptions)
  return {
    provider: 'local_rfq_operational_query',
    mode: 'read',
    content: response.message,
    ...response,
    capabilityCatalog: aiRfqOperationalCapabilityCatalog.map((item) => ({
      ...item,
      examples: [...item.examples],
      requiredSlots: [...item.requiredSlots],
      optionalSlots: [...item.optionalSlots],
      responseCards: [...item.responseCards],
    })),
  }
}
