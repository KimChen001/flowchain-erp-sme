import {
  buildEvidenceGraph,
  traceInvoiceEvidence,
  tracePurchaseOrderDeliveryImpact,
  traceReceivingEvidence,
  traceSalesOrderEvidence,
  traceSkuSupplyDemandEvidence,
  traceSupplierOperationalEvidence,
} from './evidence-graph-read-model.mjs'

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function question(body = {}) {
  return text(body.question || body.message || body.prompt || body.text)
}

function detect(message = '') {
  const id = text(message).match(/\b(?:SO|SKU|PO|PR|RFQ|GRN|INV|SUP|CASE)-[A-Z0-9-]+\b/i)?.[0] || ''
  if (/^SO-/i.test(id)) return { entityType: 'customer_order', entityId: id }
  if (/^SKU-/i.test(id)) return { entityType: 'inventory_availability', entityId: id }
  if (/^PO-/i.test(id)) return { entityType: 'purchase_order', entityId: id }
  if (/^PR-/i.test(id)) return { entityType: 'purchase_request', entityId: id }
  if (/^RFQ-/i.test(id)) return { entityType: 'rfq', entityId: id }
  if (/^GRN-/i.test(id)) return { entityType: 'receiving_doc', entityId: id }
  if (/^INV-/i.test(id)) return { entityType: 'supplier_invoice', entityId: id }
  if (/^SUP-/i.test(id)) return { entityType: 'supplier', entityId: id }
  if (/供应商/.test(message)) {
    const supplierName = text(message).match(/供应商\s*([\u4e00-\u9fa5A-Za-z0-9-]+)/)?.[1] || ''
    if (supplierName) return { entityType: 'supplier', entityId: supplierName }
  }
  return { entityType: '', entityId: '' }
}

function hasEvidenceGraphIntent(message = '') {
  if (!message) return false
  if (/草稿|生成.*PR|创建|保存|审批|确认|过账|付款|开票|发送/.test(message)) return false
  return /证据链|证据图谱|关联|相关|上游|下游|链路|依据完整|数据依据|和哪些|有关|影响哪些|为什么.*交付风险/.test(message)
}

function evidenceFromNodes(nodes = []) {
  return asArray(nodes).slice(0, 8).map((node) => ({
    type: node.type,
    id: node.id,
    label: node.label,
    status: node.status || node.riskLabel,
    summary: node.summary,
    route: node.route,
  }))
}

function readablePath(graph = {}) {
  return asArray(graph.primaryPath).map((item) => item.label).join(' → ')
}

function businessImpact(graph = {}) {
  const risks = asArray(graph.riskSignals).slice(0, 3)
  if (!risks.length) return '当前证据链未显示明确高风险，但仍建议复核关键业务记录。'
  return risks.map((item) => `${item.label}：${item.summary}`).join('；')
}

function recommendedAction(graph = {}) {
  const first = asArray(graph.navigationHints)[0]
  return first
    ? `先打开 ${first.label} 复核主证据链，再检查相关采购、库存、收货和供应商记录。`
    : '先复核当前工作区内的相关业务记录，再决定是否进入后续受控流程。'
}

function readableLimitation(code = '') {
  return ({
    record_not_found: '当前工作区未找到对应业务记录',
    missing_daily_demand_history: '缺少完整日需求历史',
    missing_inventory_balance: '缺少可用库存余额',
    missing_source_pr: '缺少来源采购申请',
    missing_rfq_link: '缺少询价单关联',
    missing_grn: '缺少收货记录',
    missing_invoice_match: '缺少发票匹配记录',
    route_not_available: '明细页暂不可用',
  })[code] || '存在未完全覆盖的数据限制'
}

function response(graph = {}, anchor = {}) {
  const evidence = evidenceFromNodes(graph.nodes)
  const limitations = asArray(graph.dataLimitations)
  const readableLimitations = limitations.map(readableLimitation)
  const path = readablePath(graph) || graph.anchor?.label || anchor.entityId
  const message = graph.dataLimitations?.includes('record_not_found') && graph.nodes?.length <= 1
    ? `结论：当前工作区缺少完整关联记录，因此该证据链需要人工复核。关键证据：未找到 ${anchor.entityId || '该业务对象'} 的完整证据链。业务影响：暂无法判断上游或下游影响。建议动作：先确认业务编号和当前数据范围。可点击跳转：暂无完整证据链接。数据限制 / 不确定性：当前工作区未找到对应业务记录。`
    : `结论：${graph.anchor?.label || anchor.entityId} 的主证据链为 ${path}。关键证据：${evidence.slice(0, 5).map((item) => item.label).join('、') || '当前工作区缺少完整关联记录'}。业务影响：${businessImpact(graph)} 建议动作：${recommendedAction(graph)} 可点击跳转见证据链接。数据限制 / 不确定性：${readableLimitations.join('、') || '当前工作区记录可支持初步判断'}。`
  return {
    message,
    content: message,
    provider: 'deterministic',
    providerStatus: 'deterministic',
    intent: { name: 'evidence_graph_query', confidence: 0.91, slots: anchor },
    evidence,
    cards: [
      {
        type: 'evidence_graph',
        title: '跨模块证据链',
        data: {
          conclusion: `${graph.anchor?.label || anchor.entityId} 的证据链已生成。`,
          primaryPath: asArray(graph.primaryPath).map((item) => item.label),
          relatedRecords: graph.relatedRecords,
          riskSignals: graph.riskSignals,
          suggestedAction: recommendedAction(graph),
          dataLimitations: limitations,
        },
        evidence,
      },
      { type: 'evidence', title: '可点击跳转', evidence },
      { type: 'recommended_actions', title: '建议动作', actions: [{ kind: 'review', label: recommendedAction(graph), target: graph.navigationHints?.[0]?.route || '' }] },
    ],
  }
}

export function buildAiEvidenceGraphResponse(db = {}, body = {}) {
  const msg = question(body)
  if (!hasEvidenceGraphIntent(msg)) return null
  const anchor = detect(msg)
  if (!anchor.entityId) return null
  let graph
  if (anchor.entityType === 'customer_order') graph = traceSalesOrderEvidence(db, anchor.entityId)
  else if (anchor.entityType === 'inventory_availability') graph = traceSkuSupplyDemandEvidence(db, anchor.entityId)
  else if (anchor.entityType === 'purchase_order') graph = tracePurchaseOrderDeliveryImpact(db, anchor.entityId)
  else if (anchor.entityType === 'supplier') graph = traceSupplierOperationalEvidence(db, anchor.entityId)
  else if (anchor.entityType === 'receiving_doc') graph = traceReceivingEvidence(db, anchor.entityId)
  else if (anchor.entityType === 'supplier_invoice') graph = traceInvoiceEvidence(db, anchor.entityId)
  else graph = buildEvidenceGraph(db, anchor)
  return response(graph, anchor)
}
