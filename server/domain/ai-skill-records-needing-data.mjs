import { aiSkillCountText, aiSkillList, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { aiSkillFocusName } from './ai-skill-today-priorities.mjs'

const TOP = 8
const SOURCE_AREA = { items: 'master_data', inventory: 'inventory', purchase_orders: 'purchasing', purchase_requests: 'purchasing', supplier_invoices: 'finance', receipts: 'receiving' }

export function runRecordsNeedingData(facts, { focus = null } = {}) {
  const records = (facts.records || []).filter((record) => !focus || record.entityId === focus.entityId || record.label === focus.entityId)
  const checked = Object.values(facts.recordsChecked || {}).reduce((sum, count) => sum + count, 0)
  return { skillId: 'records_needing_data', focus, total: records.length, checked, sources: Object.keys(facts.recordsChecked || {}).length, items: records.slice(0, TOP).map((record, index) => ({ ...record, rank: index + 1 })) }
}

export function presentRecordsNeedingData(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const reason = (record) => aiSkillText('records.missing', language, { fields: aiSkillList(record.missing.map((field) => aiSkillText(`field.${field}`, language)), language) })
  const status = aiSkillText('records.status', language)
  const evidence = result.items.map((record) => ({
    id: `records:${record.entityType}:${record.entityId}`, label: status, entityLabel: record.label, entityType: record.entityType, entityId: record.entityId,
    moduleId: AI_SKILL_MODULES[record.entityType], evidenceType: 'record_needs_data', summary: reason(record), value: null, status, statusCode: 'record_needs_data',
    severity: 'warning', rank: record.rank, sourceLabel: aiSkillText(`source.${record.source}`, language), missingFields: [...record.missing],
    linkTarget: { moduleId: AI_SKILL_MODULES[record.entityType], entityType: record.entityType, entityId: record.entityId },
  }))
  return presentAiSkillAnswer({
    skill, facts, language, query,
    title: result.focus
      ? aiSkillText(result.total ? 'records.focus_title' : 'records.focus_none', language, { id: aiSkillFocusName(result.focus, facts) })
      : aiSkillCountText('records.title', result.total, language, { count: fmt.number(result.total) }),
    summary: aiSkillText('records.summary', language, { checked: fmt.number(result.checked), sources: fmt.number(result.sources) }),
    severity: result.total ? 'warning' : 'success',
    evidence,
    impacts: result.items.map((record) => ({ area: aiSkillText(`area.${SOURCE_AREA[record.source] || 'master_data'}`, language), impact: status, severity: 'warning', explanation: reason(record), affectedObjects: [record.entityId] })),
    navigation: result.items.slice(0, 3).map((record) => ({ label: aiSkillText('nav.open', language, { id: record.label }), moduleId: AI_SKILL_MODULES[record.entityType], entityType: record.entityType, entityId: record.entityId, returnTo: 'ai-assistant', source: 'ai' })),
    followUpIds: ['today_priorities', 'highest_risk_items'],
    moneyLimitations: false,
  })
}
