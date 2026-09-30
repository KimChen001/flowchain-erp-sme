import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import {
  listMasterItems,
  listMasterSuppliers,
  listMasterWarehouses,
} from './master-data.mjs'
import {
  activeContextEvidence,
  resolveContextualEntityId,
} from './ai-active-context.mjs'
import { buildInventoryItems, buildInventoryMovements } from './inventory-read.mjs'
import { buildMrpPlan } from '../routes/mrp.routes.mjs'

export const aiChatStatusCapabilityCatalog = Object.freeze([
  {
    intent: 'supplier_status_query',
    examples: ['现在 ABC Supplier 状态怎么样？', 'Show me supplier ABC status', 'supplier SUP-001 risk'],
    requiredSlots: ['supplier'],
    optionalSlots: ['timeWindow'],
    responseCards: ['supplier_status', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'inventory_status_query',
    examples: ['今天库存有什么风险？', 'Show item A100 inventory status', 'shortage risk'],
    requiredSlots: [],
    optionalSlots: ['item', 'warehouse', 'riskLevel'],
    responseCards: ['inventory_status', 'inventory_risk_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'procurement_exception_query',
    examples: ['今天有哪些采购问题需要处理？', 'Show overdue POs', 'RFQ pending'],
    requiredSlots: [],
    optionalSlots: ['documentType', 'riskLevel', 'timeWindow'],
    responseCards: ['procurement_exception_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
  {
    intent: 'planning_status_query',
    examples: ['今天计划模块最需要处理什么？', '哪些 SKU 有 MRP 例外？', '这个 SKU 为什么 MRP 加急？', 'MRP 计划释放有哪些需要审阅？', '这个 forecast 的 MAPE 怎么样？', '这个 SKU 的计划参数是什么？'],
    requiredSlots: [],
    optionalSlots: ['sku', 'metric', 'exceptionType'],
    responseCards: ['planning_status_summary', 'evidence', 'recommended_actions'],
    mode: 'read',
  },
])

const supplierIntentPattern = /供应商|supplier|SUP-[A-Z0-9-]+/i
const inventoryIntentPattern = /库存|inventory|stock|shortage|缺货|断货|补货|仓库|warehouse|SKU|item|物料|movement history|movements?|事务流水|库存流水/i
const procurementIntentPattern = /采购.*(?:异常|问题|待处理|状态)|procurement|purchase\s+(?:order|orders|issues|exceptions)|po\s+(?:status|pending|overdue)|order\s+(?:status|pending|overdue)|overdue|逾期|异常|问题|待处理|pending\s+(?:procurement|pr|po)|pr\s+(?:status|pending)|grn|receiving/i
const planningIntentPattern = /MRP|forecast|预测|计划模块|计划释放|净需求|MAPE|WMAPE|RMSE|tracking signal|加急|例外|BOM|计划参数|lead time|MOQ|安全库存|safety stock|补货(?:建议)?(?:需要)?(?:转成)?草稿/i

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeAiChatMessage(body = {}) {
  return String(body.question || body.message || body.prompt || body.text || '').trim()
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

function tokenMatch(message, value) {
  const tokens = normalizedText(value)
    .split(/[^\w\u4e00-\u9fa5-]+/)
    .filter((token) => token.length >= 2 && !['supplier', 'status', 'risk', 'item', 'show', '现在', '状态'].includes(token))
  return tokens.some((token) => normalizedText(message).includes(token))
}

function inventoryRiskLevelLabel(value = '') {
  const level = String(value || '').toLowerCase()
  if (level === 'high') return '高'
  if (level === 'medium') return '中'
  if (level === 'low') return '低'
  if (level === 'unknown') return '待确认'
  return String(value || '')
}

function isTerminalStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase().replace(/\s+/g, '_')
  return new Set([
    '已完成',
    '已取消',
    '已关闭',
    '已驳回',
    '已转po',
    '已转_po',
    '已提交',
    '已过账',
    'completed',
    'complete',
    'closed',
    'cancelled',
    'canceled',
    'rejected',
    'converted',
    'converted_to_po',
    'submitted',
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
    const year = now.getUTCFullYear()
    return new Date(Date.UTC(year, Number(zh[1]) - 1, Number(zh[2])))
  }
  return null
}

function isPastDate(value = '', now = new Date()) {
  const parsed = parseBusinessDate(value, now)
  if (!parsed) return false
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return parsed < today
}

function purchaseOrderId(po = {}) {
  return String(po.po || po.poId || po.id || '')
}

function poSupplierId(po = {}) {
  return String(po.supplierId || po.vendorId || '')
}

function poSupplierName(po = {}) {
  return String(po.supplier || po.supplierName || po.vendor || '')
}

function poDate(po = {}) {
  return po.promisedDate || po.requiredDate || po.eta || po.due || ''
}

function isOpenPurchaseOrder(po = {}) {
  return !isTerminalStatus(po.status)
}

function isOverduePurchaseOrder(po = {}, now = new Date()) {
  return isOpenPurchaseOrder(po) && isPastDate(poDate(po), now)
}

function itemQuantity(item = {}) {
  for (const key of ['availableQuantity', 'onHandQuantity', 'onHandQty', 'stockOnHand', 'stock', 'quantityAvailable']) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') return toNumber(item[key], null)
  }
  return null
}

function rawItemFor(db = {}, item = {}) {
  const raw = asArray(db.products).find((product) =>
    [product.id, product.itemId, product.sku, product.code, product.name, product.itemName]
      .some((value) => value && [item.id, item.sku, item.name].some((candidate) => normalizedText(value) === normalizedText(candidate)))
  ) || {}
  const hasQuantityField = ['availableQuantity', 'onHandQuantity', 'onHandQty', 'stockOnHand', 'stock', 'quantityAvailable', 'currentStock']
    .some((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== '')
  if (!hasQuantityField) return raw
  return buildInventoryItems(db).find((product) =>
    [product.sku, product.itemName]
      .some((value) => value && [item.id, item.sku, item.name].some((candidate) => normalizedText(value) === normalizedText(candidate)))
  ) || raw
}

function quantityForItem(db = {}, item = {}) {
  const normalizedQuantity = itemQuantity(item)
  return normalizedQuantity === null ? itemQuantity(rawItemFor(db, item)) : normalizedQuantity
}

function purchaseRequestsFor(db = {}, options = {}) {
  if (typeof options.ensurePurchaseRequests === 'function') return asArray(options.ensurePurchaseRequests(db))
  return asArray(db.purchaseRequests)
}

function inventoryMovementsFor(db = {}, options = {}) {
  if (typeof options.ensureInventoryMovements === 'function') return buildInventoryMovements({ ...db, inventoryMovements: options.ensureInventoryMovements(db) })
  return buildInventoryMovements(db)
}

function movementItemMatches(movement = {}, item = {}) {
  return [movement.itemId, movement.sku, movement.itemSku, movement.sourceSku, movement.itemName, movement.name]
    .some((value) => value && [item.id, item.sku, item.name].some((candidate) => normalizedText(value) === normalizedText(candidate)))
}

function movementQuantity(movement = {}) {
  for (const key of ['quantity', 'qty', 'deltaQty', 'acceptedQty', 'receivedQty']) {
    if (movement[key] !== undefined && movement[key] !== null && movement[key] !== '') return toNumber(movement[key], 0)
  }
  return 0
}

function resolveSupplierMatches(db = {}, message = '', options = {}) {
  const suppliers = listMasterSuppliers(db)
  const idMatch = message.match(/\bSUP-[A-Z0-9-]+\b/i)?.[0]
  if (idMatch) {
    return {
      slot: idMatch.toUpperCase(),
      matches: suppliers.filter((supplier) => normalizedText(supplier.id) === normalizedText(idMatch)),
      context: null,
    }
  }
  const matches = suppliers.filter((supplier) =>
    containsValue(message, supplier.name) ||
    containsValue(message, supplier.id) ||
    tokenMatch(message, supplier.name)
  )
  const unique = Array.from(new Map(matches.map((supplier) => [supplier.id, supplier])).values())
  if (unique.length) return { slot: idMatch || '', matches: unique, context: null }
  const resolution = resolveContextualEntityId(options.body, message, 'supplier')
  if (resolution.source === 'active_context') {
    const contextMatches = suppliers.filter((supplier) =>
      [supplier.id, supplier.name].some((candidate) =>
        normalizedText(candidate) === normalizedText(resolution.entityId) ||
        normalizedText(candidate) === normalizedText(resolution.context?.entityLabel)
      )
    )
    if (contextMatches.length) {
      return {
        slot: resolution.entityId,
        matches: contextMatches,
        context: resolution.context,
      }
    }
  }
  return { slot: idMatch || '', matches: unique, context: null }
}

function resolveItemMatches(db = {}, message = '', options = {}) {
  const items = listMasterItems(db)
  const skuMatch = message.match(/\b[A-Z]{1,6}[-]?\d{2,}\b/i)?.[0]
  const matches = items.filter((item) =>
    containsValue(message, item.sku) ||
    containsValue(message, item.id) ||
    containsValue(message, item.name) ||
    (skuMatch && normalizedText(item.sku) === normalizedText(skuMatch)) ||
    tokenMatch(message, item.name)
  )
  const unique = Array.from(new Map(matches.map((item) => [item.id, item])).values())
  if (unique.length) return { slot: skuMatch || '', matches: unique, context: null }
  const resolution = resolveContextualEntityId(options.body, message, 'item')
  if (resolution.source === 'active_context') {
    const contextMatches = items.filter((item) =>
      [item.id, item.sku, item.name].some((candidate) =>
        normalizedText(candidate) === normalizedText(resolution.entityId) ||
        normalizedText(candidate) === normalizedText(resolution.context?.entityLabel)
      )
    )
    if (contextMatches.length) {
      return {
        slot: resolution.entityId,
        matches: contextMatches,
        context: resolution.context,
      }
    }
  }
  return { slot: skuMatch || '', matches: unique, context: null }
}

function recommendedActions(actions = []) {
  return { type: 'recommended_actions', actions }
}

function evidenceCard(evidence = []) {
  return { type: 'evidence', evidence }
}

function resolvePlanningRow(mrpPlan = {}, message = '') {
  const rows = asArray(mrpPlan.rows)
  const skuMatch = String(message || '').match(/\b[A-Z]{1,6}[-_]?[A-Z0-9]{2,}\b/i)?.[0]
  if (skuMatch) {
    const normalizedSku = normalizedText(skuMatch)
    const row = rows.find((item) => [item.sku, item.name].some((value) => normalizedText(value) === normalizedSku || normalizedText(value).includes(normalizedSku)))
    if (row) return row
  }
  const exception = asArray(mrpPlan.exceptions)[0]
  if (exception) return rows.find((row) => row.sku === exception.sku) || rows[0] || null
  return rows[0] || null
}

function latestForecastPlanFor(db = {}, row = null) {
  const plans = asArray(db.forecastPlans)
  if (!plans.length) return null
  if (row?.sku) {
    const match = plans.find((plan) => normalizedText(plan.sku) === normalizedText(row.sku))
    if (match) return match
  }
  return plans[0]
}

function planningViewForMessage(message = '') {
  if (/MAPE|WMAPE|RMSE|tracking signal|forecast|预测|需求/i.test(message)) return 'forecast:demand'
  if (/计划参数|lead time|MOQ|安全库存|safety stock|reorder point|batch/i.test(message)) return 'forecast:parameters'
  if (/补货|草稿|release|释放|PR draft|计划释放/i.test(message)) return 'forecast:replenishment'
  if (/MRP|净需求|BOM|例外|加急/i.test(message)) return 'forecast:mrp'
  return 'forecast:cockpit'
}

function buildPlanningStatusResponse(db = {}, message = '', options = {}) {
  const mrpPlan = buildMrpPlan(db, options.mrpOptions || {})
  const row = resolvePlanningRow(mrpPlan, message)
  const forecastPlan = latestForecastPlanFor(db, row)
  const exceptionRows = asArray(mrpPlan.exceptions)
  const releaseLines = asArray(row?.schedule).filter((line) => Number(line.plannedRelease || 0) > 0)
  const urgent = row?.exception === '加急' || exceptionRows.some((item) => item.sku === row?.sku && item.type === '加急')
  const mape = forecastPlan?.metrics?.mape ?? forecastPlan?.metrics?.MAPE ?? null
  const primaryTarget = planningViewForMessage(message)
  const evidence = [
    { type: 'mrp_plan', id: row?.sku || 'mrp_plan', moduleId: 'forecast:mrp', label: row?.name || 'MRP 计划', summary: `已检查 ${mrpPlan.summary?.exceptionCount || 0} 条 MRP 例外，覆盖 ${mrpPlan.summary?.skuCount || 0} 个 SKU。` },
    forecastPlan
      ? { type: 'forecast_plan', id: forecastPlan.id || forecastPlan.sku || row?.sku || 'forecast_plan', moduleId: 'forecast:demand', label: forecastPlan.name || forecastPlan.sku || row?.name, summary: `预测方法 ${forecastPlan.method || '未知'}，MAPE ${mape ?? '暂无'}。` }
      : { type: 'forecast_plan', id: 'forecast_plans', moduleId: 'forecast:demand', summary: '当前没有保存的 forecast 方案；MRP 仍使用只读模型输入。' },
    row?.bomSources?.length
      ? { type: 'bom_source', id: row.sku, moduleId: 'forecast:mrp', label: 'BOM 来源证据', summary: row.bomSources.map((source) => `${source.parentName || source.parent}:${source.demand}`).slice(0, 3).join(' | ') }
      : { type: 'bom_source', id: row?.sku || 'static_bom', moduleId: 'forecast:mrp', summary: '当前选中行没有找到下阶 BOM 来源。' },
  ]
  if (row?.sourceMetadata) evidence.push({ type: 'planning_source', id: row.sku, moduleId: 'forecast:parameters', summary: `计划来源：${row.sourceMetadata.generatedFrom}；持久化口径：${row.sourceMetadata.persistence}。` })

  return {
    message: row
      ? `${row.sku} 当前有 MRP 例外「${row.exception || '待复核'}」，计划收货 ${Number(row.totalPlannedReceipt || 0).toLocaleString()} ${row.unit || ''}；这是只读计划证据，不创建 PR/PO，${urgent ? '需人工复核提前期或预计可用量。' : '需人工复核计划释放时点。'}`
      : '当前计划只读模型没有可用 MRP 行，请先复核需求预测、BOM 和计划参数。',
    intent: {
      name: 'planning_status_query',
      confidence: /MRP|forecast|预测|MAPE|计划释放|例外/i.test(message) ? 0.9 : 0.76,
      slots: {
        sku: row?.sku || '',
        metric: /MAPE|WMAPE|RMSE|tracking signal/i.test(message) ? 'forecast_accuracy' : '',
        exceptionType: row?.exception || '',
      },
    },
    cards: [
      {
        type: 'planning_status_summary',
        title: row ? `${row.sku} 预测/MRP 只读摘要` : '预测/MRP 只读摘要',
        data: {
          sku: row?.sku || '',
          name: row?.name || '',
          exception: row?.exception || 'unknown',
          exceptionCount: mrpPlan.summary?.exceptionCount || 0,
          urgentCount: mrpPlan.summary?.urgentCount || 0,
          plannedQty: mrpPlan.summary?.plannedQty || 0,
          plannedAmount: mrpPlan.summary?.plannedAmount || 0,
          totalPlannedReceipt: row?.totalPlannedReceipt || 0,
          maxNetRequirement: row?.maxNetRequirement || 0,
          firstShortagePeriod: row?.firstShortagePeriod || null,
          plannedReleasePeriods: releaseLines.map((line) => line.plannedReleasePeriod).filter(Boolean).slice(0, 4),
          forecastPlanId: forecastPlan?.id || '',
          mape,
          rmse: forecastPlan?.metrics?.rmse ?? null,
          bomSourceCount: row?.bomSources?.length || 0,
          reviewBoundary: 'read_only_planning_evidence_no_pr_po_created',
        },
      },
      evidenceCard(evidence),
      recommendedActions([
        { label: '打开对应计划视图', kind: 'deep_link', target: primaryTarget },
        { label: '复核 MRP 例外', kind: 'deep_link', target: 'forecast:mrp' },
        { label: '预览补货草稿', kind: 'deep_link', target: 'forecast:replenishment' },
      ]),
    ],
    evidence,
  }
}

function buildSupplierStatusResponse(db = {}, message = '', options = {}) {
  const { matches, slot, context } = resolveSupplierMatches(db, message, options)
  const intent = { name: 'supplier_status_query', confidence: slot ? 0.9 : 0.82, slots: { supplier: slot || '' } }
  if (matches.length === 0) {
    const missing = {
      type: 'missing_fields',
      fields: [{ name: 'supplier', reason: '供应商主数据中没有匹配记录。' }],
    }
    return {
      message: '我没有在供应商主数据中找到该供应商，请提供供应商 ID 或更明确的供应商名称。',
      intent,
      cards: [missing, recommendedActions([{ label: '查看供应商主数据', kind: 'deep_link', target: '/srm?view=suppliers' }])],
      evidence: [{ type: 'supplier_master', id: '', summary: '未匹配到供应商主数据。' }],
    }
  }
  if (matches.length > 1) {
    return {
      message: '我找到多个供应商匹配项，请选择供应商 ID 后继续。',
      intent: { ...intent, confidence: 0.64, slots: { supplier: slot || 'ambiguous' } },
      cards: [
        {
          type: 'ambiguous_match',
          matches: matches.slice(0, 5).map((supplier) => ({ supplierId: supplier.id, name: supplier.name })),
        },
        recommendedActions([{ label: '查看供应商主数据', kind: 'deep_link', target: '/srm?view=suppliers' }]),
      ],
      evidence: [{ type: 'supplier_master', id: '', summary: `${matches.length} supplier master records matched.` }],
    }
  }

  const supplier = matches[0]
  const openPos = asArray(db.purchaseOrders).filter((po) =>
    isOpenPurchaseOrder(po) &&
    (normalizedText(poSupplierId(po)) === normalizedText(supplier.id) || normalizedText(poSupplierName(po)) === normalizedText(supplier.name))
  )
  const overduePos = openPos.filter((po) => isOverduePurchaseOrder(po, options.now))
  const receivingIssues = asArray(db.receivingDocs).filter((doc) =>
    normalizedText(doc.supplier || doc.supplierName) === normalizedText(supplier.name) &&
    (doc.status === '异常处理' || toNumber(doc.failed ?? doc.rejectedQty, 0) > 0)
  )
  const data = {
    supplierId: supplier.id,
    name: supplier.name,
    status: supplier.status,
    risk: supplier.risk,
    score: supplier.score,
    scoreSource: supplier.scoreSource,
    defaultCurrency: supplier.defaultCurrency,
    paymentTermsId: supplier.paymentTermsId,
    categories: supplier.categories,
    preferred: supplier.preferred,
    openPoCount: openPos.length,
    overduePoCount: overduePos.length,
    recentIssueCount: receivingIssues.length,
  }
  const evidence = [
    { type: 'supplier_master', id: supplier.id, summary: 'Matched supplier from Master Data.' },
    { type: 'supplier_score_source', id: supplier.id, summary: `Score source is ${supplier.scoreSource}.` },
  ]
  const contextEvidence = activeContextEvidence(context, 'supplier')
  if (contextEvidence) evidence.push(contextEvidence)
  if (openPos.length) evidence.push({ type: 'purchase_order', id: 'open_purchase_orders', summary: `${openPos.length} related open purchase orders found.` })
  if (overduePos.length) evidence.push({ type: 'purchase_order', id: purchaseOrderId(overduePos[0]), summary: `${overduePos.length} related purchase orders appear overdue.` })
  if (receivingIssues.length) evidence.push({ type: 'receiving', id: receivingIssues[0].grn || receivingIssues[0].id || '', summary: `${receivingIssues.length} related receiving issues found.` })

  return {
    message: `${supplier.name} 当前状态为 ${supplier.status || '未知状态'}，风险为 ${supplier.risk || '未标注'}，评分为 ${supplier.score || '暂无评分'}。`,
    intent: { ...intent, slots: { supplier: supplier.id } },
    cards: [
      { type: 'supplier_status', title: supplier.name, data },
      evidenceCard(evidence),
      recommendedActions([
        { label: '查看供应商', kind: 'deep_link', target: `/srm?view=supplier&supplierId=${encodeURIComponent(supplier.id)}` },
        { label: '复核未结 PO', kind: 'deep_link', target: `/procurement?view=purchase-orders&supplierId=${encodeURIComponent(supplier.id)}` },
        { label: '查看供应商绩效', kind: 'deep_link', target: `/srm?view=performance&supplierId=${encodeURIComponent(supplier.id)}` },
      ]),
    ],
    evidence,
  }
}

function buildInventoryStatusResponse(db = {}, message = '', options = {}) {
  const { matches, slot, context } = resolveItemMatches(db, message, options)
  const items = listMasterItems(db)
  const warehouses = listMasterWarehouses(db)
  const intent = { name: 'inventory_status_query', confidence: slot ? 0.88 : 0.8, slots: { item: slot || '' } }

  if (matches.length > 1) {
    return {
      message: '找到多个可能匹配的物料，请提供更明确的 SKU 或物料 ID 后再查看库存风险。',
      intent: { ...intent, confidence: 0.62, slots: { item: 'ambiguous' } },
      cards: [
        { type: 'ambiguous_match', matches: matches.slice(0, 5).map((item) => ({ itemId: item.id, sku: item.sku, name: item.name })) },
        recommendedActions([{ label: '查看物料主数据', kind: 'deep_link', target: '/inventory?view=items' }]),
      ],
      evidence: [{ type: 'item_master', id: '', summary: `匹配到 ${matches.length} 条物料主数据。` }],
    }
  }

  if (matches.length === 1) {
    const item = matches[0]
    const quantity = quantityForItem(db, item)
    const movements = inventoryMovementsFor(db, options).filter((movement) => movementItemMatches(movement, item))
    const movementDelta = movements.reduce((sum, movement) => sum + movementQuantity(movement), 0)
    const hasQuantity = quantity !== null
    const riskLevel = hasQuantity
      ? quantity <= 0
        ? 'high'
        : quantity < item.moq
          ? 'medium'
          : 'low'
      : 'unknown'
    const riskReason = hasQuantity
      ? (quantity <= 0 ? '可用库存为 0 或低于 0，需要优先复核补货。' : quantity < item.moq ? '可用库存低于 MOQ/补货批量口径，需要关注补货节奏。' : '可用库存不低于 MOQ/补货批量口径，余额风险较低。')
      : '当前数据缺少可用库存余额字段，因此无法确认 SKU 级库存余额风险；但可以基于库存事务、MRP 例外和主数据完整性给出观察项。'
    const warehouse = warehouses.find((record) => record.id === item.defaultWarehouseId)
    const data = {
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      status: item.status,
      category: item.category,
      baseUom: item.baseUom,
      defaultWarehouseId: item.defaultWarehouseId,
      preferredSupplierId: item.preferredSupplierId,
      preferredSupplierSource: item.preferredSupplierSource,
      availableQuantity: hasQuantity ? quantity : null,
      riskLevel,
      riskReason,
      recentMovementCount: movements.length,
    }
    const inventoryEvidenceId = item.sku || item.id
    const evidence = [
      { type: 'inventory_item', id: inventoryEvidenceId, label: item.name, summary: '已匹配库存物料用于 SKU 聚焦。' },
      { type: 'item_master', id: item.id, summary: '已匹配物料主数据。' },
      warehouse
        ? { type: 'warehouse_reference', id: warehouse.id, summary: `默认仓库来源：${warehouse.sourceType}。` }
        : { type: 'warehouse_reference', id: item.defaultWarehouseId, summary: '主数据中未找到默认仓库引用。' },
    ]
    const contextEvidence = activeContextEvidence(context, 'item')
    if (contextEvidence) evidence.push(contextEvidence)
    if (movements.length) evidence.push({ type: 'inventory_movement', id: movements[0].id || movements[0].movementId || '', summary: `找到 ${movements.length} 条相关库存流水，观察净变动 ${movementDelta}。` })
    if (!hasQuantity) evidence.push({ type: 'missing_quantity_evidence', id: item.id, summary: '当前数据缺少可用库存余额字段。' })

    return {
      message: hasQuantity
        ? `${item.sku || item.name} 当前可用库存为 ${quantity} ${item.baseUom || ''}，库存余额风险为${inventoryRiskLevelLabel(riskLevel)}。${riskReason}`
        : `${item.sku || item.name} 已在物料主数据中匹配。当前数据缺少可用库存余额字段，因此无法确认 SKU 级库存余额风险；但可以基于库存事务、MRP 例外和主数据完整性给出观察项。`,
      intent: { ...intent, slots: { item: context?.entityId || item.sku || item.id } },
      cards: [
        { type: 'inventory_status', title: item.sku || item.name, data },
        evidenceCard(evidence),
        recommendedActions([
          { label: '打开库存 SKU', kind: 'deep_link', target: `/inventory?sku=${encodeURIComponent(inventoryEvidenceId)}` },
          { label: '查看库存流水', kind: 'deep_link', target: `/inventory?view=movements&sku=${encodeURIComponent(inventoryEvidenceId)}` },
          { label: '查看补货选项', kind: 'deep_link', target: `/procurement?view=options&itemId=${encodeURIComponent(item.id)}` },
        ]),
      ],
      evidence,
    }
  }

  const movementCount = inventoryMovementsFor(db, options).length
  const quantityItems = items.filter((item) => quantityForItem(db, item) !== null)
  const riskItems = quantityItems.filter((item) => quantityForItem(db, item) <= 0 || quantityForItem(db, item) < item.moq)
  const evidence = [
    { type: 'item_master', id: 'items', summary: `当前有 ${items.length} 条物料主数据可用于库存风险观察。` },
    movementCount
      ? { type: 'inventory_movement', id: 'inventory_movements', summary: `当前有 ${movementCount} 条库存流水可用于观察事务风险。` }
      : { type: 'missing_quantity_evidence', id: 'inventory_balance', summary: '当前缺少库存流水或库存余额证据。' },
  ]
  if (!quantityItems.length) evidence.push({ type: 'missing_quantity_evidence', id: 'stock_balance', summary: '物料记录中未找到安全的当前库存余额字段。' })

  return {
    message: riskItems.length
      ? `当前有 ${riskItems.length} 个物料显示保守库存风险信号；请先区分已确认库存余额风险、库存事务风险和 MRP/计划风险，再决定是否准备补货草稿。`
      : '当前数据缺少可用库存余额字段，因此无法确认 SKU 级库存余额风险；但可以基于库存事务、MRP 例外和主数据完整性给出观察项。',
    intent,
    cards: [
      {
        type: 'inventory_risk_summary',
        title: '库存风险摘要',
        data: {
          itemCount: items.length,
          itemsWithQuantityEvidence: quantityItems.length,
          riskItemCount: riskItems.length,
          movementCount,
          topRiskItems: riskItems.slice(0, 5).map((item) => ({
            itemId: item.id,
            sku: item.sku,
            name: item.name,
            availableQuantity: quantityForItem(db, item),
            riskLevel: quantityForItem(db, item) <= 0 ? 'high' : 'medium',
            riskReason: quantityForItem(db, item) <= 0 ? '可用库存为 0 或低于 0。' : '可用库存低于 MOQ/补货批量口径。',
          })),
          stockBalanceEvidence: quantityItems.length ? 'available' : 'missing',
          balanceGapExplanation: quantityItems.length
            ? ''
            : '当前数据缺少可用库存余额字段，因此无法确认 SKU 级库存余额风险；但可以基于库存事务、MRP 例外和主数据完整性给出观察项。',
        },
      },
      evidenceCard(evidence),
      recommendedActions([
        { label: '查看物料主数据', kind: 'deep_link', target: '/inventory?view=items' },
        { label: '查看库存流水', kind: 'deep_link', target: '/inventory?view=movements' },
        { label: '查看补货选项', kind: 'deep_link', target: '/procurement?view=options' },
      ]),
    ],
    evidence,
  }
}

function buildProcurementExceptionResponse(db = {}, message = '', options = {}) {
  const purchaseOrders = asArray(db.purchaseOrders)
  const purchaseRequests = purchaseRequestsFor(db, options)
  const rfqs = asArray(db.rfqs)
  const receivingDocs = asArray(db.receivingDocs)
  const overduePos = purchaseOrders.filter((po) => isOverduePurchaseOrder(po, options.now))
  const pendingPrs = purchaseRequests.filter((pr) => !isTerminalStatus(pr.status))
  const pendingRfqs = rfqs.filter((rfq) => !isTerminalStatus(rfq.status))
  const receivingIssues = receivingDocs.filter((doc) => doc.status === '异常处理' || toNumber(doc.failed ?? doc.rejectedQty, 0) > 0)
  const topIssues = [
    ...overduePos.map((po) => ({
      type: 'overdue_purchase_order',
      id: purchaseOrderId(po),
      title: `${purchaseOrderId(po)} 已逾期`,
      severity: po.priority === '高' ? 'high' : 'medium',
      reason: '预计交付日期已过。',
      relatedSupplierId: poSupplierId(po),
      relatedItemIds: asArray(po.lines).map((line) => line.itemId || line.sku).filter(Boolean),
    })),
    ...receivingIssues.map((doc) => ({
      type: 'receiving_issue',
      id: doc.grn || doc.id || '',
      title: `${doc.grn || doc.id || '收货单'} 需要跟进`,
      severity: doc.status === '异常处理' ? 'high' : 'medium',
      reason: doc.status === '异常处理' ? '收货单处于异常处理状态。' : '收货单包含拒收数量。',
      relatedSupplierId: doc.supplierId || '',
      relatedItemIds: asArray(doc.lines).map((line) => line.itemId || line.sku).filter(Boolean),
    })),
    ...pendingPrs.slice(0, 3).map((pr) => ({
      type: 'pending_purchase_request',
      id: pr.pr || pr.id || '',
      title: `${pr.pr || pr.id || '采购申请'} 待处理`,
      severity: pr.priority === '高' ? 'high' : 'medium',
      reason: `采购申请状态为 ${pr.status || '未结'}。`,
      relatedSupplierId: pr.supplierId || '',
      relatedItemIds: [pr.itemId || pr.sourceSku || pr.sku].filter(Boolean),
    })),
    ...pendingRfqs.slice(0, 3).map((rfq) => ({
      type: 'pending_rfq',
      id: rfq.id || rfq.rfq || '',
      title: `${rfq.id || rfq.rfq || 'RFQ'} 待处理`,
      severity: isPastDate(rfq.due, options.now) ? 'high' : 'medium',
      reason: `RFQ 状态为 ${rfq.status || '未结'}。`,
      relatedSupplierId: '',
      relatedItemIds: [rfq.itemId || rfq.sku || rfq.sourceSku].filter(Boolean),
    })),
  ].slice(0, 8)
  const totalIssueCount = overduePos.length + pendingPrs.length + pendingRfqs.length + receivingIssues.length
  const evidence = [
    { type: 'purchase_order', id: 'purchase_orders', summary: `已检查 ${purchaseOrders.length} 张采购订单。` },
    { type: 'purchase_request', id: 'purchase_requests', summary: `已检查 ${purchaseRequests.length} 张采购申请。` },
    { type: 'rfq', id: 'rfqs', summary: `已检查 ${rfqs.length} 个 RFQ。` },
    { type: 'receiving', id: 'receiving_docs', summary: `已检查 ${receivingDocs.length} 张收货单。` },
  ]
  if (!totalIssueCount) evidence.push({ type: 'empty_state', id: 'procurement_exceptions', summary: '当前数据没有发现采购异常。' })

  return {
    message: totalIssueCount
      ? `我找到 ${totalIssueCount} 项可能需要跟进的采购事项。`
      : '当前数据没有发现采购异常。',
    intent: {
      name: 'procurement_exception_query',
      confidence: /overdue|逾期|po\b|purchase order/i.test(message) ? 0.9 : 0.82,
      slots: {
        documentType: /rfq/i.test(message) ? 'rfq' : /pr\b/i.test(message) ? 'purchase_request' : /po\b|overdue|逾期/i.test(message) ? 'purchase_order' : '',
      },
    },
    cards: [
      {
        type: 'procurement_exception_summary',
        title: '采购异常摘要',
        data: {
          totalIssueCount,
          overduePoCount: overduePos.length,
          pendingPrCount: pendingPrs.length,
          pendingRfqCount: pendingRfqs.length,
          receivingIssueCount: receivingIssues.length,
          topIssues,
        },
      },
      evidenceCard(evidence),
      recommendedActions([
        { label: '查看逾期 PO', kind: 'deep_link', target: '/procurement?view=purchase-orders&filter=overdue' },
        { label: '复核待处理 PR', kind: 'deep_link', target: '/procurement?view=purchase-requests&filter=pending' },
        { label: '复核 RFQ', kind: 'deep_link', target: '/procurement?view=rfqs&filter=pending' },
        { label: '复核收货异常', kind: 'deep_link', target: '/receiving?filter=issues' },
      ]),
    ],
    evidence,
  }
}

export function detectAiChatStatusIntent(message = '') {
  const text = String(message || '').trim()
  if (!text) return null
  if (/低于.*安全库存|安全库存.*(?:不足|偏低|风险)|below.*safety stock/i.test(text)) return 'inventory_status_query'
  if (planningIntentPattern.test(text)) return 'planning_status_query'
  if (supplierIntentPattern.test(text)) return 'supplier_status_query'
  if (inventoryIntentPattern.test(text)) return 'inventory_status_query'
  if (procurementIntentPattern.test(text)) return 'procurement_exception_query'
  return null
}

export function buildAiChatStatusResponse(db = {}, body = {}, options = {}) {
  const message = normalizeAiChatMessage(body)
  const intent = detectAiChatStatusIntent(message)
  if (!intent) return null
  const contextOptions = { ...options, body }
  const response = intent === 'supplier_status_query'
    ? buildSupplierStatusResponse(db, message, contextOptions)
    : intent === 'inventory_status_query'
      ? buildInventoryStatusResponse(db, message, contextOptions)
      : intent === 'procurement_exception_query'
        ? buildProcurementExceptionResponse(db, message, contextOptions)
        : buildPlanningStatusResponse(db, message, contextOptions)
  // Links into frozen or unavailable surfaces (forecast / MRP) are removed.
  return {
    provider: 'local_status_query',
    mode: 'read',
    content: response.message,
    ...withoutUnavailableProductLinks(response),
    capabilityCatalog: aiChatStatusCapabilityCatalog.map((item) => ({ ...item, examples: [...item.examples], requiredSlots: [...item.requiredSlots], optionalSlots: [...item.optionalSlots], responseCards: [...item.responseCards] })),
  }
}
