import {
  activeContextEvidence,
  resolveContextualEntityId,
} from './ai-active-context.mjs'

export const aiProcurementOperationalCapabilityCatalog = Object.freeze([
  {
    intent: 'pr_status_query',
    examples: ['PR-1001 status', '这个 PR 到哪一步了？', '采购申请 PR-1001 进度'],
    requiredSlots: ['prId'],
    optionalSlots: [],
    responseCards: ['pr_status', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'pr_conversion_status_query',
    examples: ['这个 PR 为什么还没转 PO？', '哪些 PR 还没转 PO？', '待转 PO 的采购申请'],
    requiredSlots: [],
    optionalSlots: ['prId'],
    responseCards: ['pr_conversion_status', 'pr_conversion_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'po_status_query',
    examples: ['PO-1001 status', '这个 PO 收货怎么样？', 'PO-1001 是否逾期？'],
    requiredSlots: ['poId'],
    optionalSlots: [],
    responseCards: ['po_status', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'po_overdue_query',
    examples: ['哪些 PO 快逾期了？', 'overdue PO', '本周哪些 PO 要跟？'],
    requiredSlots: [],
    optionalSlots: ['timeWindow'],
    responseCards: ['po_overdue_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'receiving_status_query',
    examples: ['GRN-1001 status', 'PO-1001 receiving status', '收货单 GRN-1001 状态'],
    requiredSlots: [],
    optionalSlots: ['receivingId', 'poId'],
    responseCards: ['receiving_status', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'receiving_exception_query',
    examples: ['哪些收货有异常？', 'receiving exceptions', 'GRN variance'],
    requiredSlots: [],
    optionalSlots: [],
    responseCards: ['receiving_exception_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'procurement_followup_summary_query',
    examples: ['今天采购有什么要跟？', '采购下一步重点是什么？', '需要跟进哪些采购事项？'],
    requiredSlots: [],
    optionalSlots: [],
    responseCards: ['procurement_followup_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
])

const prIdPattern = /\bPR[-\w]*\d+\b/i
const poIdPattern = /\bPO[-\w]*\d+\b/i
const receivingIdPattern = /\b(?:GRN|RCV|RECEIPT)[-\w]*\d+\b/i
const draftVerbPattern = /create|prepare|generate|start|draft|生成|创建|准备|起草|起一个|做一个|新建/i
const rfqPattern = /\bRFQ\b|询价|报价请求/i

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

function sameId(a = '', b = '') {
  return normalizedText(a) === normalizedText(b)
}

function containsValue(text = '', value = '') {
  const raw = normalizedText(value)
  if (!raw) return false
  return normalizedText(text).includes(raw) || compactText(text).includes(compactText(value))
}

function normalizeProcurementOperationalMessage(body = {}) {
  return String(body.question || body.message || body.prompt || body.text || '').trim()
}

export { normalizeProcurementOperationalMessage }

function isTerminalStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase().replace(/\s+/g, '_')
  return new Set([
    '已完成',
    '已关闭',
    '已取消',
    '已驳回',
    '已转po',
    '已转_po',
    '已签收',
    '已入库',
    'completed',
    'complete',
    'closed',
    'cancelled',
    'canceled',
    'rejected',
    'converted',
    'converted_to_po',
    'posted',
    'done',
  ]).has(normalized)
}

function parseBusinessDate(value = '', now = new Date()) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`)
  const zh = raw.match(/(\d{1,2})月(\d{1,2})日/)
  if (zh) {
    return new Date(Date.UTC(now.getUTCFullYear(), Number(zh[1]) - 1, Number(zh[2])))
  }
  return null
}

function dateState(value = '', now = new Date()) {
  const parsed = parseBusinessDate(value, now)
  if (!parsed) return { overdue: false, dueSoon: false, parseable: false }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const diffDays = Math.floor((parsed.getTime() - today.getTime()) / (24 * 3600 * 1000))
  return {
    overdue: diffDays < 0,
    dueSoon: diffDays >= 0 && diffDays <= 7,
    parseable: true,
    diffDays,
  }
}

function purchaseRequestsFor(db = {}, options = {}) {
  if (typeof options.ensurePurchaseRequests === 'function') return asArray(options.ensurePurchaseRequests(db))
  return asArray(db.purchaseRequests)
}

function purchaseOrdersFor(db = {}) {
  return asArray(db.purchaseOrders)
}

function receivingDocsFor(db = {}) {
  return asArray(db.receivingDocs)
}

function rfqsFor(db = {}, options = {}) {
  if (typeof options.ensureRfqs === 'function') return asArray(options.ensureRfqs(db))
  return asArray(db.rfqs)
}

function prIdFor(pr = {}) {
  return String(pr.pr || pr.id || pr.requestId || pr.prId || '')
}

function poIdFor(po = {}) {
  return String(po.po || po.id || po.poId || po.number || '')
}

function receivingIdFor(doc = {}) {
  return String(doc.grn || doc.id || doc.receivingId || doc.receiptId || '')
}

function poDateFor(po = {}) {
  return po.expectedDate || po.promisedDate || po.requiredDate || po.eta || po.due || ''
}

function prRequiredDate(pr = {}) {
  return pr.requiredDate || pr.dueDate || pr.needByDate || ''
}

function linkedPoForPr(db = {}, pr = {}) {
  const explicit = pr.linkedPo || pr.po || pr.poId || ''
  if (explicit) return String(explicit)
  const prId = prIdFor(pr)
  const linked = purchaseOrdersFor(db).find((po) => sameId(po.sourceRequest || po.sourcePr || po.pr || po.prId, prId))
  return linked ? poIdFor(linked) : ''
}

function linkedRfqForPr(db = {}, pr = {}, options = {}) {
  const explicit = pr.linkedRfq || pr.rfq || pr.rfqId || ''
  if (explicit) return String(explicit)
  const prId = prIdFor(pr)
  const linked = rfqsFor(db, options).find((rfq) => sameId(rfq.sourceRequest || rfq.sourcePr || rfq.pr || rfq.prId, prId))
  return linked ? String(linked.id || linked.rfq || linked.rfqId || '') : ''
}

// By id or by the number the document shows (PR-202611-0001).
function findPr(requests = [], id = '') {
  return requests.find((pr) => sameId(prIdFor(pr), id) || (pr.number && sameId(pr.number, id))) || null
}

function findPo(orders = [], id = '') {
  return orders.find((po) => sameId(poIdFor(po), id) || [po.number, po.orderNumber].some((number) => number && sameId(number, id))) || null
}

function findReceiving(docs = [], id = '') {
  return docs.find((doc) => sameId(receivingIdFor(doc), id)) || null
}

function receivingDocsForPo(docs = [], poId = '') {
  return docs.filter((doc) => [doc.po, doc.poId, doc.purchaseOrder, doc.purchaseOrderId].some((value) => sameId(value, poId)))
}

function extractPrId(message = '') {
  return message.match(prIdPattern)?.[0] || ''
}

function extractPoId(message = '') {
  return message.match(poIdPattern)?.[0] || ''
}

function extractReceivingId(message = '') {
  return message.match(receivingIdPattern)?.[0] || ''
}

function resolvePrId(body = {}, message = '') {
  return resolveContextualEntityId(body, message, 'purchase_request', extractPrId(message))
}

function topPrFields(db = {}, pr = {}, options = {}) {
  return {
    prId: prIdFor(pr),
    status: pr.status || '',
    requester: pr.requester || pr.requestedBy || '',
    buyer: pr.buyer || pr.owner || '',
    supplier: pr.supplier || pr.supplierName || '',
    itemId: pr.itemId || pr.sourceSku || pr.sku || '',
    sku: pr.sourceSku || pr.sku || pr.itemSku || '',
    quantity: toNumber(pr.quantity ?? pr.qty, null),
    requiredDate: prRequiredDate(pr),
    priority: pr.priority || '',
    amount: toNumber(pr.amount, null),
    linkedPo: linkedPoForPr(db, pr) || null,
    linkedRfq: linkedRfqForPr(db, pr, options) || null,
    source: pr.source || '',
  }
}

function receivingSummaryForPo(docs = []) {
  const expected = docs.reduce((sum, doc) => sum + (toNumber(doc.items ?? doc.expectedQuantity ?? doc.orderedQty, 0) || 0), 0)
  const received = docs.reduce((sum, doc) => sum + (toNumber(doc.passed ?? doc.receivedQuantity ?? doc.acceptedQty, 0) || 0), 0)
  const failed = docs.reduce((sum, doc) => sum + (toNumber(doc.failed ?? doc.rejectedQty, 0) || 0), 0)
  const hasException = docs.some((doc) => doc.status === '异常处理' || (toNumber(doc.failed ?? doc.rejectedQty, 0) || 0) > 0)
  return {
    receivedQuantity: docs.length ? received : null,
    orderedQuantity: docs.length ? expected : null,
    failedQuantity: docs.length ? failed : null,
    receivingStatus: !docs.length ? 'none' : hasException ? 'exception' : expected > 0 && received >= expected ? 'complete' : received > 0 ? 'partial' : 'pending',
    receivingDocCount: docs.length,
  }
}

function poStatusData(po = {}, docs = [], now = new Date()) {
  const state = dateState(poDateFor(po), now)
  const receiving = receivingSummaryForPo(docs)
  return {
    poId: poIdFor(po),
    status: po.status || '',
    supplier: po.supplier || po.supplierName || '',
    sourceRequest: po.sourceRequest || po.pr || po.prId || '',
    expectedDate: poDateFor(po),
    overdue: !isTerminalStatus(po.status) && state.overdue,
    dueSoon: !isTerminalStatus(po.status) && state.dueSoon,
    receivedQuantity: receiving.receivedQuantity ?? toNumber(po.received, null),
    orderedQuantity: receiving.orderedQuantity ?? toNumber(po.items ?? po.quantity, null),
    receivingStatus: receiving.receivingStatus,
    receivingDocCount: receiving.receivingDocCount,
  }
}

function receivingStatusData(doc = {}, po = null) {
  const expected = toNumber(doc.items ?? doc.expectedQuantity ?? doc.orderedQty ?? po?.items, null)
  const received = toNumber(doc.passed ?? doc.receivedQuantity ?? doc.acceptedQty ?? po?.received, null)
  const failed = toNumber(doc.failed ?? doc.rejectedQty, 0) || 0
  return {
    receivingId: receivingIdFor(doc),
    poId: doc.po || doc.poId || doc.purchaseOrder || poIdFor(po || {}),
    supplier: doc.supplier || doc.supplierName || po?.supplier || '',
    status: doc.status || '',
    receivedQuantity: received,
    expectedQuantity: expected,
    variance: expected !== null && received !== null ? Math.max(0, expected - received) : null,
    failedQuantity: failed,
    exception: doc.status === '异常处理' || failed > 0,
    warehouse: doc.warehouse || '',
  }
}

function evidenceCard(evidence = []) {
  return { type: 'evidence', evidence }
}

function recommendedActions(actions = []) {
  return { type: 'recommended_actions', actions }
}

function missingFieldCard(name, reason) {
  return { type: 'missing_fields', fields: [{ name, reason }] }
}

function emptyStateCard(title, reason) {
  return { type: 'empty_state', title, reason }
}

function buildMissingIdResponse(intentName, field, label, target = '/procurement') {
  return {
    message: `请提供 ${label} ID，我会只读查询对应记录。`,
    intent: { name: intentName, confidence: 0.64, slots: { [field]: null } },
    cards: [
      missingFieldCard(field, `缺少 ${label} ID。`),
      recommendedActions([{ label: '打开采购工作台', kind: 'deep_link', target }]),
    ],
    evidence: [{ type: 'missing_field', id: field, summary: `本次查询需要 ${label} ID。` }],
  }
}

function buildNotFoundResponse(intentName, field, id, label, target = '/procurement') {
  return {
    message: `我没有找到 ${label} ${id}。`,
    intent: { name: intentName, confidence: 0.72, slots: { [field]: id } },
    cards: [
      emptyStateCard(`未找到 ${label}`, `没有记录匹配 ${id}。`),
      recommendedActions([{ label: '打开采购工作台', kind: 'deep_link', target }]),
    ],
    evidence: [{ type: label.toLowerCase().replace(/\s+/g, '_'), id, summary: `没有记录匹配该 ${label} ID。` }],
  }
}

function buildPrStatusResponse(db = {}, message = '', options = {}) {
  const requests = purchaseRequestsFor(db, options)
  const resolution = resolvePrId(options.body, message)
  const prId = resolution.entityId
  if (!prId) return buildMissingIdResponse('pr_status_query', 'prId', 'PR', '/procurement?view=requests')
  const pr = findPr(requests, prId)
  if (!pr) return buildNotFoundResponse('pr_status_query', 'prId', prId, 'PR', '/procurement?view=requests')
  const evidence = [{ type: 'purchase_request', id: prIdFor(pr), summary: '已匹配采购申请记录。' }]
  const contextEvidence = activeContextEvidence(resolution.context, 'purchase_request')
  if (contextEvidence) evidence.push(contextEvidence)
  if (linkedPoForPr(db, pr)) evidence.push({ type: 'purchase_order', id: linkedPoForPr(db, pr), summary: '已找到该 PR 关联的 PO。' })
  if (linkedRfqForPr(db, pr, options)) evidence.push({ type: 'rfq', id: linkedRfqForPr(db, pr, options), summary: '已找到该 PR 关联的 RFQ。' })
  return {
    message: `${prIdFor(pr)} 当前状态为 ${pr.status || '未知状态'}。`,
    intent: { name: 'pr_status_query', confidence: 0.88, slots: { prId: prIdFor(pr) } },
    cards: [
      { type: 'pr_status', title: prIdFor(pr), data: topPrFields(db, pr, options) },
      evidenceCard(evidence),
      recommendedActions([
        { label: '打开 PR', kind: 'deep_link', target: `/procurement?view=requests&prId=${encodeURIComponent(prIdFor(pr))}` },
        { label: '打开采购工作台', kind: 'deep_link', target: '/procurement?view=requests' },
      ]),
    ],
    evidence,
  }
}

function prConversionReason(db = {}, pr = {}, options = {}) {
  const linkedPo = linkedPoForPr(db, pr)
  const linkedRfq = linkedRfqForPr(db, pr, options)
  const status = String(pr.status || '')
  if (linkedPo) return { canConvert: false, blockedReason: '该 PR 已关联 PO。', nextStep: '复核已关联 PO。' }
  if (/待审批|草稿|pending|draft/i.test(status)) return { canConvert: false, blockedReason: `PR 状态为 ${status || '未批准'}。`, nextStep: '人工审批后再评估是否转换。' }
  if (/已驳回|已取消|rejected|cancelled|canceled/i.test(status)) return { canConvert: false, blockedReason: `PR 状态为 ${status}。`, nextStep: '先复核 PR 处理结果，再决定是否发起新动作。' }
  if (linkedRfq) return { canConvert: false, blockedReason: '该 PR 已关联 RFQ，应先复核询价结果。', nextStep: '复核 RFQ 结果，准备好后人工转换。' }
  if (/已批准|approved/i.test(status)) return { canConvert: true, blockedReason: null, nextStep: '复核供应商后人工转换。' }
  return { canConvert: false, blockedReason: `PR 状态为 ${status || '未知'}。`, nextStep: '复核 PR 状态和寻源证据。' }
}

function buildPrConversionStatusResponse(db = {}, message = '', options = {}) {
  const requests = purchaseRequestsFor(db, options)
  const resolution = resolvePrId(options.body, message)
  const prId = resolution.entityId
  if (prId) {
    const pr = findPr(requests, prId)
    if (!pr) return buildNotFoundResponse('pr_conversion_status_query', 'prId', prId, 'PR', '/procurement?view=requests')
    const conversion = prConversionReason(db, pr, options)
    const evidence = [{ type: 'purchase_request', id: prIdFor(pr), summary: '已匹配采购申请记录。' }]
    const contextEvidence = activeContextEvidence(resolution.context, 'purchase_request')
    if (contextEvidence) evidence.push(contextEvidence)
    return {
      message: conversion.canConvert
        ? `${prIdFor(pr)} 已批准，当前数据中未关联 PO。`
        : `${prIdFor(pr)} 尚不适合转换为 PO：${conversion.blockedReason}`,
      intent: { name: 'pr_conversion_status_query', confidence: 0.86, slots: { prId: prIdFor(pr) } },
      cards: [
        {
          type: 'pr_conversion_status',
          title: 'PR 转 PO 状态',
          data: {
            prId: prIdFor(pr),
            status: pr.status || '',
            ...conversion,
            linkedPo: linkedPoForPr(db, pr) || null,
            linkedRfq: linkedRfqForPr(db, pr, options) || null,
          },
        },
        evidenceCard(evidence),
        recommendedActions([{ label: '复核 PR', kind: 'review', target: `/procurement?view=requests&prId=${encodeURIComponent(prIdFor(pr))}` }]),
      ],
      evidence,
    }
  }
  const approvedNotConverted = requests.filter((pr) => /已批准|approved/i.test(String(pr.status || '')) && !linkedPoForPr(db, pr))
  const pendingApproval = requests.filter((pr) => /待审批|pending|草稿|draft/i.test(String(pr.status || '')) && !linkedPoForPr(db, pr))
  const evidence = [
    { type: 'purchase_request', id: 'purchase_requests', summary: `已检查 ${requests.length} 张采购申请。` },
  ]
  if (!approvedNotConverted.length && !pendingApproval.length) evidence.push({ type: 'empty_state', id: 'pr_conversion', summary: '当前没有发现 PR 转 PO 积压。' })
  return {
    message: approvedNotConverted.length
      ? `我找到 ${approvedNotConverted.length} 张已批准但未关联 PO 的采购申请。`
      : '当前数据没有发现已批准但未关联 PO 的采购申请。',
    intent: { name: 'pr_conversion_status_query', confidence: 0.82, slots: { prId: null } },
    cards: [
      {
        type: 'pr_conversion_summary',
        title: '待转 PO 的 PR',
        data: {
          approvedNotConvertedCount: approvedNotConverted.length,
          pendingApprovalCount: pendingApproval.length,
          topRequests: [...approvedNotConverted, ...pendingApproval].slice(0, 5).map((pr) => ({
            prId: prIdFor(pr),
            status: pr.status || '',
            requiredDate: prRequiredDate(pr),
            supplier: pr.supplier || pr.supplierName || '',
          })),
        },
      },
      ...(!approvedNotConverted.length && !pendingApproval.length ? [emptyStateCard('暂无 PR 转 PO 积压', '当前没有发现待转换记录。')] : []),
      evidenceCard(evidence),
      recommendedActions([{ label: '复核 PR', kind: 'deep_link', target: '/procurement?view=requests' }]),
    ],
    evidence,
  }
}

function buildPoStatusResponse(db = {}, message = '', options = {}) {
  const poId = extractPoId(message)
  if (!poId) return buildMissingIdResponse('po_status_query', 'poId', 'PO', '/procurement?view=orders')
  const po = findPo(purchaseOrdersFor(db), poId)
  if (!po) return buildNotFoundResponse('po_status_query', 'poId', poId, 'PO', '/procurement?view=orders')
  const docs = receivingDocsForPo(receivingDocsFor(db), poIdFor(po))
  const data = poStatusData(po, docs, options.now)
  const evidence = [
    { type: 'purchase_order', id: poIdFor(po), summary: '已匹配采购订单记录。' },
    docs.length
      ? { type: 'receiving', id: docs[0] ? receivingIdFor(docs[0]) : '', summary: `${docs.length} 张收货单关联到该 PO。` }
      : { type: 'limited_data', id: poIdFor(po), summary: '未找到关联收货单。' },
  ]
  return {
    message: `${poIdFor(po)} 当前状态为 ${po.status || '未知状态'}。`,
    intent: { name: 'po_status_query', confidence: 0.88, slots: { poId: poIdFor(po) } },
    cards: [
      { type: 'po_status', title: poIdFor(po), data },
      evidenceCard(evidence),
      recommendedActions([
        { label: '打开 PO', kind: 'deep_link', target: `/procurement?view=orders&poId=${encodeURIComponent(poIdFor(po))}` },
        {
          label: `预览 ${poIdFor(po)} 供应商跟进草稿，需人工审阅后再发送。`,
          kind: 'draft_preview',
          target: '',
          draftType: 'po_followup_draft',
          draftTitle: `${poIdFor(po)} 供应商跟进草稿预览`,
          requiresHumanReview: true,
          payload: {
            poId: poIdFor(po),
            message: `请确认 ${poIdFor(po)} 剩余未到货部分的预计交期。当前状态为 ${po.status || '待确认'}。`,
            reason: data.receivingStatus === 'partial'
              ? 'AI 基于采购订单部分到货状态建议跟进供应商剩余交期。'
              : 'AI 基于采购订单状态建议跟进供应商交付计划。',
          },
          originEvidence: evidence,
        },
        { label: '打开收货工作台', kind: 'deep_link', target: '/procurement?view=receiving' },
      ]),
    ],
    evidence,
  }
}

function purchaseOrderRisk(po = {}, now = new Date()) {
  const state = dateState(poDateFor(po), now)
  if (isTerminalStatus(po.status)) return null
  if (state.overdue) return 'high'
  if (state.dueSoon) return 'medium'
  return null
}

function poFollowupRows(db = {}, now = new Date()) {
  return purchaseOrdersFor(db)
    .map((po) => ({ po, riskLevel: purchaseOrderRisk(po, now) }))
    .filter((row) => row.riskLevel)
}

function buildPoOverdueResponse(db = {}, _message = '', options = {}) {
  const rows = poFollowupRows(db, options.now)
  const overdue = rows.filter((row) => row.riskLevel === 'high')
  const dueSoon = rows.filter((row) => row.riskLevel === 'medium')
  const evidence = rows.length
    ? rows.slice(0, 5).map((row) => ({ type: 'purchase_order', id: poIdFor(row.po), summary: `该 PO 需要跟进，风险等级 ${row.riskLevel}。` }))
    : [{ type: 'empty_state', id: 'po_followup', summary: '当前没有发现逾期或临期未结 PO。' }]
  return {
    message: rows.length
      ? `我找到 ${rows.length} 张需要跟进的采购订单。`
      : '当前数据没有发现逾期或临期采购订单。',
    intent: { name: 'po_overdue_query', confidence: 0.86, slots: { poId: null } },
    cards: [
      {
        type: 'po_overdue_summary',
        title: 'PO 跟进摘要',
        data: {
          overdueCount: overdue.length,
          dueSoonCount: dueSoon.length,
          topPurchaseOrders: rows.slice(0, 5).map((row) => ({
            poId: poIdFor(row.po),
            supplier: row.po.supplier || row.po.supplierName || '',
            status: row.po.status || '',
            expectedDate: poDateFor(row.po),
            riskLevel: row.riskLevel,
          })),
        },
      },
      ...(rows.length ? [] : [emptyStateCard('暂无 PO 跟进事项', '当前没有发现逾期或临期未结 PO。')]),
      evidenceCard(evidence),
      recommendedActions([{ label: '复核 PO', kind: 'deep_link', target: '/procurement?view=orders' }]),
    ],
    evidence,
  }
}

function buildReceivingStatusResponse(db = {}, message = '', options = {}) {
  const receivingId = extractReceivingId(message)
  const poId = extractPoId(message)
  const docs = receivingDocsFor(db)
  if (receivingId) {
    const doc = findReceiving(docs, receivingId)
    if (!doc) return buildNotFoundResponse('receiving_status_query', 'receivingId', receivingId, 'Receiving', '/procurement?view=receiving')
    const po = findPo(purchaseOrdersFor(db), doc.po || doc.poId || doc.purchaseOrder || '')
    const evidence = [
      { type: 'receiving', id: receivingIdFor(doc), summary: '已匹配收货单。' },
      ...(po ? [{ type: 'purchase_order', id: poIdFor(po), summary: '已找到该收货单关联的 PO。' }] : []),
    ]
    return {
      message: `${receivingIdFor(doc)} 当前状态为 ${doc.status || '未知状态'}。`,
      intent: { name: 'receiving_status_query', confidence: 0.86, slots: { receivingId: receivingIdFor(doc), poId: po ? poIdFor(po) : null } },
      cards: [
        { type: 'receiving_status', title: receivingIdFor(doc), data: receivingStatusData(doc, po) },
        evidenceCard(evidence),
        recommendedActions([{ label: '复核收货单', kind: 'review', target: `/procurement?view=receiving&receivingId=${encodeURIComponent(receivingIdFor(doc))}` }]),
      ],
      evidence,
    }
  }
  if (poId) {
    const po = findPo(purchaseOrdersFor(db), poId)
    if (!po) return buildNotFoundResponse('receiving_status_query', 'poId', poId, 'PO', '/procurement?view=orders')
    const linkedDocs = receivingDocsForPo(docs, poIdFor(po))
    if (!linkedDocs.length) {
      const evidence = [{ type: 'limited_data', id: poIdFor(po), summary: '该 PO 未关联收货单。' }]
      return {
        message: `${poIdFor(po)} 当前数据中没有关联收货单。`,
        intent: { name: 'receiving_status_query', confidence: 0.78, slots: { receivingId: null, poId: poIdFor(po) } },
        cards: [
          { type: 'receiving_status', title: '收货状态', data: { ...poStatusData(po, [], options.now), receivingId: null, poId: poIdFor(po), exception: false } },
          evidenceCard(evidence),
          recommendedActions([{ label: '打开收货工作台', kind: 'deep_link', target: '/procurement?view=receiving' }]),
        ],
        evidence,
      }
    }
    const primary = linkedDocs.find((doc) => doc.status === '异常处理') || linkedDocs[0]
    const evidence = [
      { type: 'purchase_order', id: poIdFor(po), summary: '已匹配采购订单记录。' },
      { type: 'receiving', id: receivingIdFor(primary), summary: `${linkedDocs.length} 张收货单关联到该 PO。` },
    ]
    return {
      message: `${poIdFor(po)} 有 ${linkedDocs.length} 张关联收货单。`,
      intent: { name: 'receiving_status_query', confidence: 0.84, slots: { receivingId: receivingIdFor(primary), poId: poIdFor(po) } },
      cards: [
        { type: 'receiving_status', title: '收货状态', data: receivingStatusData(primary, po) },
        evidenceCard(evidence),
        recommendedActions([{ label: '打开收货工作台', kind: 'deep_link', target: '/procurement?view=receiving' }]),
      ],
      evidence,
    }
  }
  return buildMissingIdResponse('receiving_status_query', 'receivingId', 'receiving', '/procurement?view=receiving')
}

function receivingExceptionRows(db = {}) {
  return receivingDocsFor(db).filter((doc) =>
    doc.status === '异常处理' ||
    (toNumber(doc.failed ?? doc.rejectedQty, 0) || 0) > 0 ||
    /异常|差异|variance|exception/i.test(String(doc.varianceType || doc.issueType || ''))
  )
}

function buildReceivingExceptionResponse(db = {}) {
  const rows = receivingExceptionRows(db)
  const evidence = rows.length
    ? rows.slice(0, 5).map((doc) => ({ type: 'receiving', id: receivingIdFor(doc), summary: '收货单存在异常或差异证据。' }))
    : [{ type: 'empty_state', id: 'receiving_exceptions', summary: '当前没有发现收货异常。' }]
  return {
    message: rows.length
      ? `我找到 ${rows.length} 张存在异常的收货单。`
      : '当前数据没有发现收货异常。',
    intent: { name: 'receiving_exception_query', confidence: 0.85, slots: { receivingId: null } },
    cards: [
      {
        type: 'receiving_exception_summary',
        title: '收货异常',
        data: {
          exceptionCount: rows.length,
          openExceptionCount: rows.filter((doc) => !isTerminalStatus(doc.status)).length,
          topExceptions: rows.slice(0, 5).map((doc) => ({
            receivingId: receivingIdFor(doc),
            poId: doc.po || doc.poId || doc.purchaseOrder || '',
            supplier: doc.supplier || doc.supplierName || '',
            varianceType: doc.varianceType || ((toNumber(doc.failed ?? doc.rejectedQty, 0) || 0) > 0 ? 'quantity_variance' : 'receiving_exception'),
            status: doc.status || '',
          })),
        },
      },
      ...(rows.length ? [] : [emptyStateCard('暂无收货异常', '当前没有收货单显示异常证据。')]),
      evidenceCard(evidence),
      recommendedActions([{ label: '打开收货工作台', kind: 'deep_link', target: '/procurement?view=receiving' }]),
    ],
    evidence,
  }
}

function buildFollowupSummaryResponse(db = {}, message = '', options = {}) {
  const requests = purchaseRequestsFor(db, options)
  const approvedNotConverted = requests.filter((pr) => /已批准|approved/i.test(String(pr.status || '')) && !linkedPoForPr(db, pr))
  const pendingPrs = requests.filter((pr) => /待审批|pending|草稿|draft/i.test(String(pr.status || '')) && !linkedPoForPr(db, pr))
  const rfqs = rfqsFor(db, options)
  const pendingRfqResponseCount = rfqs.filter((rfq) => !isTerminalStatus(rfq.status) && toNumber(rfq.suppliers, 0) > toNumber(rfq.quoted, 0)).length
  const poRows = poFollowupRows(db, options.now)
  const receivingExceptions = receivingExceptionRows(db)
  const topIssues = [
    ...poRows.map((row) => ({ type: row.riskLevel === 'high' ? 'po_overdue' : 'po_due_soon', id: poIdFor(row.po), summary: `${poIdFor(row.po)} 需要跟进。` })),
    ...receivingExceptions.map((doc) => ({ type: 'receiving_exception', id: receivingIdFor(doc), summary: `${receivingIdFor(doc)} 存在收货异常证据。` })),
    ...approvedNotConverted.map((pr) => ({ type: 'pr_pending_conversion', id: prIdFor(pr), summary: `${prIdFor(pr)} 已批准但未关联 PO。` })),
    ...pendingPrs.map((pr) => ({ type: 'pr_pending_approval', id: prIdFor(pr), summary: `${prIdFor(pr)} 仍待审批。` })),
  ].slice(0, 6)
  const evidence = [
    { type: 'purchase_request', id: 'purchase_requests', summary: `已检查 ${requests.length} 张 PR。` },
    { type: 'purchase_order', id: 'purchase_orders', summary: `已检查 ${purchaseOrdersFor(db).length} 张 PO。` },
    { type: 'receiving', id: 'receiving_docs', summary: `已检查 ${receivingDocsFor(db).length} 张收货单。` },
  ]
  if (!topIssues.length) evidence.push({ type: 'empty_state', id: 'procurement_followup', summary: '当前没有发现需要立即跟进的采购事项。' })
  return {
    message: topIssues.length
      ? `我找到 ${topIssues.length} 项采购跟进事项。`
      : '当前数据没有发现需要立即跟进的采购事项。',
    intent: { name: 'procurement_followup_summary_query', confidence: 0.8, slots: {} },
    cards: [
      {
        type: 'procurement_followup_summary',
        title: '采购跟进摘要',
        data: {
          pendingPrCount: pendingPrs.length,
          approvedNotConvertedPrCount: approvedNotConverted.length,
          pendingRfqResponseCount,
          overduePoCount: poRows.filter((row) => row.riskLevel === 'high').length,
          receivingExceptionCount: receivingExceptions.length,
          topIssues,
        },
      },
      ...(topIssues.length ? [] : [emptyStateCard('暂无采购跟进事项', '当前没有发现需要立即处理的 PR、PO、RFQ 或收货异常。')]),
      evidenceCard(evidence),
      recommendedActions([{ label: '打开采购工作台', kind: 'deep_link', target: '/procurement' }]),
    ],
    evidence,
  }
}

export function detectAiProcurementOperationalIntent(message = '', body = {}) {
  const text = String(message || '').trim()
  if (!text || draftVerbPattern.test(text) || rfqPattern.test(text)) return null
  const lower = normalizedText(text)
  const hasPrId = prIdPattern.test(text)
  const hasPoId = poIdPattern.test(text)
  const hasReceivingId = receivingIdPattern.test(text)
  const hasPurchaseRequestContext = resolveContextualEntityId(body, text, 'purchase_request').source === 'active_context'
  const prText = /\bPR\b|purchase\s+(?:request|requisition)|采购申请/i.test(text)
  const poText = /\bPO\b|purchase\s+order|采购订单/i.test(text)
  const receivingText = /GRN|receiving|receipt|收货|入库|质检/i.test(text)
  const conversionText = /转\s*PO|转.*采购订单|convert(?:ed)?\s*(?:to)?\s*po|conversion|还没转|待转/i.test(text)
  const overdueText = /逾期|快逾期|due soon|overdue|需要跟进的\s*PO|本周.*PO.*跟|po.*follow/i.test(text)
  const exceptionText = /收货.*(?:异常|差异)|receiving exceptions?|grn variance|收货差异/i.test(text)
  const followupText = /采购.*(?:跟进|下一步|重点|工作台|有什么要跟)|需要跟进.*采购|procurement.*(?:follow|need|items)|what procurement items need follow-up/i.test(text)
  const sopText = /SOP|规则|流程|通常|一般|怎么处理|应该/i.test(text)

  if (sopText) return null
  if (exceptionText) return 'receiving_exception_query'
  if (hasReceivingId || (receivingText && hasPoId)) return 'receiving_status_query'
  if (overdueText && !hasPoId) return 'po_overdue_query'
  if (hasPoId || (poText && /status|状态|查看|show|收货|receiving|逾期/.test(lower))) return 'po_status_query'
  if (conversionText && (hasPrId || hasPurchaseRequestContext || prText || /哪些|待转|pending/i.test(text))) return 'pr_conversion_status_query'
  if (hasPrId || hasPurchaseRequestContext || (prText && /status|状态|到哪一步|进度|查看|show|现在|怎么样/.test(lower))) return 'pr_status_query'
  if (followupText) return 'procurement_followup_summary_query'
  return null
}

export function buildAiProcurementOperationalResponse(db = {}, body = {}, options = {}) {
  const message = normalizeProcurementOperationalMessage(body)
  const intent = detectAiProcurementOperationalIntent(message, body)
  if (!intent) return null
  const contextOptions = { ...options, body }
  const response = intent === 'pr_status_query'
    ? buildPrStatusResponse(db, message, contextOptions)
    : intent === 'pr_conversion_status_query'
      ? buildPrConversionStatusResponse(db, message, contextOptions)
      : intent === 'po_status_query'
        ? buildPoStatusResponse(db, message, contextOptions)
        : intent === 'po_overdue_query'
          ? buildPoOverdueResponse(db, message, contextOptions)
          : intent === 'receiving_status_query'
            ? buildReceivingStatusResponse(db, message, contextOptions)
            : intent === 'receiving_exception_query'
              ? buildReceivingExceptionResponse(db, message, contextOptions)
              : buildFollowupSummaryResponse(db, message, contextOptions)
  return {
    provider: 'local_procurement_operational_query',
    mode: 'read',
    content: response.message,
    ...response,
    capabilityCatalog: aiProcurementOperationalCapabilityCatalog.map((item) => ({
      ...item,
      examples: [...item.examples],
      requiredSlots: [...item.requiredSlots],
      optionalSlots: [...item.optionalSlots],
      responseCards: [...item.responseCards],
    })),
  }
}
