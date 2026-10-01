import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { isInventoryRiskSku } from './runtime-inventory-allocation-read-model.mjs'

// Stock for one SKU, or the SKUs that need attention, from the runtime
// allocation model the inventory report uses (on hand, reservations, open
// sales demand, incoming on approved purchase orders, available to promise).
// Quantities stay in each SKU's own unit and are never added across SKUs.

const array = (value) => Array.isArray(value) ? value : []
const MAX_EVIDENCE = 8
const STATUSES = new Set(['out_of_stock', 'below_safety_stock', 'below_reorder_point', 'ok', 'unknown'])
const STATUS_ORDER = { out_of_stock: 0, below_safety_stock: 1, below_reorder_point: 2, unknown: 3, ok: 4 }
const needsAttention = (row) => isInventoryRiskSku(row) || ['out_of_stock', 'below_safety_stock', 'below_reorder_point'].includes(row.stockStatus) || (row.availableToPromise !== null && row.availableToPromise < 0)
const worstFirst = (a, b) => (b.shortage || 0) - (a.shortage || 0) || (STATUS_ORDER[a.stockStatus] ?? 5) - (STATUS_ORDER[b.stockStatus] ?? 5) || String(a.sku).localeCompare(String(b.sku))

const statusText = (status, language) => aiSkillText(`stock_status.${STATUSES.has(status) ? status : 'unknown'}`, language)

const figure = (code, entityId, value, extra = {}) => ({ key: entityId ? `${code}:${entityId}` : code, code, entityId: entityId || null, value, ...extra })

export function runInventoryAvailability(facts, { route = null } = {}) {
  const mode = route?.mode || 'overview'
  if (mode === 'hidden' || !facts?.inventory) return { skillId: 'inventory_availability', mode: 'hidden', hidden: true, ids: array(route?.entities?.hidden).map((entry) => entry.id) }
  const rows = array(facts.inventory.rows)
  if (mode === 'single') return { skillId: 'inventory_availability', mode, skus: array(route?.entities?.skus).slice(0, 5), total: rows.length }
  if (mode === 'not_found') return { skillId: 'inventory_availability', mode, ids: [...array(route?.entities?.truncated), ...array(route?.entities?.absent)].filter((entry) => entry.source === 'inventory').map((entry) => entry.id) }
  if (mode === 'short') return { skillId: 'inventory_availability', mode, skus: rows.filter(isInventoryRiskSku).sort(worstFirst), total: rows.length }
  return { skillId: 'inventory_availability', mode: 'overview', skus: rows.filter(needsAttention).sort(worstFirst), total: rows.length }
}

function skuRecord(row, fmt, language, rank) {
  const quantity = (value) => fmt.quantity(value, row.unit)
  const short = isInventoryRiskSku(row)
  const low = ['out_of_stock', 'below_safety_stock', 'below_reorder_point'].includes(row.stockStatus)
  const kind = short ? 'short' : low ? 'low' : row.stockStatus === 'unknown' || row.available === null ? 'unknown' : 'ok'
  const status = statusText(row.stockStatus, language)
  const entityId = row.itemId || row.sku
  return {
    evidence: aiSkillRecordEvidence({
      evidenceType: 'stock_position', entityType: 'item', entityId, label: row.sku, status,
      summary: aiSkillText('stock.evidence', language, { atp: quantity(row.availableToPromise), available: quantity(row.available), status }),
      value: short ? aiSkillText('value.short', language, { shortage: quantity(row.shortage) }) : quantity(row.availableToPromise),
      severity: short ? 'risk' : low ? 'warning' : 'info', rank,
    }, language),
    impact: aiSkillRecordImpact({ area: 'inventory', entityId, severity: short ? 'risk' : low ? 'warning' : 'info', impact: aiSkillText(`stock.impact_${kind}`, language), explanation: aiSkillText(`stock.impact_${kind}.explanation`, language) }, language),
    navigation: aiSkillNavigation({ label: row.sku, entityType: 'item', entityId }, language),
  }
}

function singleSentences(row, fmt, language) {
  const quantity = (value) => fmt.quantity(value, row.unit)
  const sentences = [aiSkillText('stock.single_summary', language, { onHand: quantity(row.onHand), reserved: quantity(row.reserved), available: quantity(row.available), demand: quantity(row.openSalesDemand), incoming: quantity(row.incomingApprovedPo) })]
  if (isInventoryRiskSku(row)) sentences.push(aiSkillText('stock.short', language, { shortage: quantity(row.shortage) }))
  sentences.push(aiSkillText('stock.status', language, { status: statusText(row.stockStatus, language) }))
  sentences.push(aiSkillText('stock.atp_definition', language))
  return sentences
}

export function presentInventoryAvailability(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['highest_risk_items', 'prepare_action_draft'] }
  if (result.hidden) return presentAiSkillAnswer({ ...base, title: result.ids?.length ? aiSkillText('stock.hidden_lookup', language, { id: aiSkillList(result.ids, language) }) : aiSkillText('stock.title_hidden', language), summary: '', severity: 'info', items: [], navigation: [] })
  const fmt = aiSkillFormatter(facts, language)
  if (result.mode === 'not_found' || (result.mode === 'single' && !result.skus.length)) {
    return presentAiSkillAnswer({ ...base, title: aiSkillText('stock.not_found_title', language, { id: aiSkillList(array(result.ids), language) || query }), summary: aiSkillText('stock.not_found_summary', language), severity: 'info', items: [], navigation: [] })
  }
  const built = result.skus.slice(0, MAX_EVIDENCE).map((row, index) => skuRecord(row, fmt, language, index + 1))
  const evidence = { evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation) }
  if (result.mode === 'single') {
    const [row, ...others] = result.skus
    const atp = row.availableToPromise
    const title = atp === null || atp === undefined
      ? aiSkillText('stock.single_title_unknown', language, { sku: row.sku })
      : atp < 0
        ? aiSkillText('stock.single_title_negative', language, { sku: row.sku, missing: fmt.quantity(-atp, row.unit) })
        : aiSkillText('stock.single_title', language, { sku: row.sku, atp: fmt.quantity(atp, row.unit) })
    const sentences = singleSentences(row, fmt, language)
    for (const other of others) sentences.push(aiSkillText('stock.single_title', language, { sku: other.sku, atp: fmt.quantity(other.availableToPromise, other.unit) }) + (language === 'zh-CN' ? '。' : '.'))
    const figures = result.skus.flatMap((entry) => [
      ...(entry.availableToPromise !== null && entry.availableToPromise !== undefined ? [figure('atp', entry.sku, entry.availableToPromise, { unit: entry.unit })] : []),
      ...(entry.available !== null && entry.available !== undefined ? [figure('available', entry.sku, entry.available, { unit: entry.unit })] : []),
      ...(entry.onHand !== null && entry.onHand !== undefined ? [figure('on_hand', entry.sku, entry.onHand, { unit: entry.unit })] : []),
    ])
    return presentAiSkillAnswer({ ...base, ...evidence, figures, title, summary: aiSkillSentences(sentences, language), severity: isInventoryRiskSku(row) ? 'risk' : 'info' })
  }
  // The at-risk sentence names every short SKU, as the reports count them.
  const atRisk = aiSkillMetricSentences(facts, language, { spend: false, invoices: false, atRisk: true }).slice(-1)
  const title = result.mode === 'short'
    ? aiSkillCountText('stock.short_title', result.skus.length, language, { count: fmt.number(result.skus.length) })
    : aiSkillCountText('stock.overview_title', result.skus.length, language, { count: fmt.number(result.skus.length), total: fmt.number(result.total) })
  return presentAiSkillAnswer({ ...base, ...evidence, figures: [figure(result.mode === 'short' ? 'at_risk_sku_count' : 'attention_sku_count', null, result.skus.length)], title, summary: aiSkillSentences(atRisk, language), severity: result.skus.some(isInventoryRiskSku) ? 'risk' : result.skus.length ? 'warning' : 'info' })
}
