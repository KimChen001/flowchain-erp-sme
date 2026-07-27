import { randomUUID } from 'node:crypto'
import { reportFieldCatalog, reportMetricCatalog, reportSubjectCatalog } from '../domain/report-semantic-layer.mjs'

const views = new Map()
const auditEvents = []

function clone(value) { return JSON.parse(JSON.stringify(value ?? null)) }
function text(value = '') { return String(value ?? '').trim() }
function canManage(view, actor) { return actor.role === 'admin' || actor.role === 'manager' || view.ownerId === actor.id }
function validate(input = {}) {
  const errors = []
  const subject = text(input.subject)
  if (!text(input.name)) errors.push('name is required')
  if (!reportSubjectCatalog[subject]) errors.push('unknown report subject')
  const allowedFields = new Set((reportFieldCatalog[subject] || []).map((field) => field.key))
  ;(input.columns || []).filter((key) => !allowedFields.has(key)).forEach((key) => errors.push(`field ${key} is not governed for ${subject}`))
  const isGovernedDashboard = String(input.sourceRoute || '').startsWith('/app/reports/')
  const allowedMetrics = new Set(reportMetricCatalog.filter((metric) => isGovernedDashboard || metric.subject === subject).map((metric) => metric.id))
  ;(input.measures || []).filter((key) => !allowedMetrics.has(key)).forEach((key) => errors.push(`metric ${key} is not governed for ${subject}`))
  if (!['private', 'team'].includes(input.visibility || 'private')) errors.push('visibility must be private or team')
  return errors
}
function audit(action, view, actor) {
  const event = { id: `AUD-RPT-${randomUUID().slice(0, 8)}`, timestamp: new Date().toISOString(), actor: { type: 'user', ...actor }, source: 'manual', module: 'reports', action, entity: { type: 'savedReportView', id: view.viewId }, summary: `${view.name} · ${action}`, metadata: { visibility: view.visibility, subject: view.subject, version: view.version } }
  auditEvents.unshift(event); return event
}

export function listReportViews(actor, filters = {}) {
  return clone([...views.values()].filter((view) => (view.visibility === 'team' || view.ownerId === actor.id || actor.role === 'admin') && (!filters.visibility || view.visibility === filters.visibility)).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)))
}
export function getReportView(id, actor) {
  const view = views.get(id)
  if (!view || (view.visibility !== 'team' && view.ownerId !== actor.id && actor.role !== 'admin')) return null
  view.lastOpenedAt = new Date().toISOString()
  return clone(view)
}
export function createReportView(input, actor) {
  if (!['analyst', 'manager', 'admin'].includes(actor.role)) return { ok: false, status: 403, error: 'Analyst permission is required.' }
  const errors = validate(input); if (errors.length) return { ok: false, status: 422, errors }
  if (input.visibility === 'team' && !['manager', 'admin'].includes(actor.role)) return { ok: false, status: 403, error: 'Manager permission is required to share team views.' }
  const now = new Date().toISOString(); const viewId = `RV-${randomUUID().slice(0, 10)}`
  const view = { viewId, name: text(input.name), description: text(input.description), ownerId: actor.id, ownerName: actor.name, subject: input.subject, sourceRoute: input.sourceRoute || '/app/reports/library', columns: clone(input.columns || []), columnOrder: clone(input.columnOrder || input.columns || []), filters: clone(input.filters || {}), sorting: clone(input.sorting || []), grouping: clone(input.grouping || []), measures: clone(input.measures || []), visualization: input.visualization || 'table', comparison: input.comparison || 'previous_period', hiddenCharts: clone(input.hiddenCharts || []), chartOrder: clone(input.chartOrder || []), ...([5, 10, 20].includes(Number(input.topN)) ? { topN: Number(input.topN) } : {}), dateRange: clone(input.dateRange || null), visibility: input.visibility || 'private', isDefault: Boolean(input.isDefault), createdAt: now, updatedAt: now, lastOpenedAt: now, version: 1 }
  views.set(viewId, view); const event = audit('report_view_created', view, actor)
  return { ok: true, status: 201, view: clone(view), auditEventId: event.id }
}
export function updateReportView(id, input, actor) {
  const current = views.get(id); if (!current) return { ok: false, status: 404, error: 'Report view not found.' }
  if (!canManage(current, actor)) return { ok: false, status: 403, error: 'Only the owner or manager can update this view.' }
  const next = { ...current, ...clone(input), viewId: id, ownerId: current.ownerId, ownerName: current.ownerName, version: current.version + 1, updatedAt: new Date().toISOString() }
  const errors = validate(next); if (errors.length) return { ok: false, status: 422, errors }
  if (next.visibility === 'team' && !['manager', 'admin'].includes(actor.role)) return { ok: false, status: 403, error: 'Manager permission is required to share team views.' }
  views.set(id, next); const event = audit('report_view_updated', next, actor)
  return { ok: true, status: 200, view: clone(next), auditEventId: event.id }
}
export function deleteReportView(id, actor) {
  const current = views.get(id); if (!current) return { ok: false, status: 404, error: 'Report view not found.' }
  if (!canManage(current, actor)) return { ok: false, status: 403, error: 'Only the owner or manager can delete this view.' }
  views.delete(id); const event = audit('report_view_deleted', current, actor)
  return { ok: true, status: 200, deleted: true, auditEventId: event.id }
}
export function cloneReportView(id, input, actor) {
  const current = getReportView(id, actor); if (!current) return { ok: false, status: 404, error: 'Report view not found.' }
  return createReportView({ ...current, name: text(input.name) || `${current.name}（副本）`, visibility: 'private' }, actor)
}
export function listReportViewAuditEvents() { return clone(auditEvents) }
