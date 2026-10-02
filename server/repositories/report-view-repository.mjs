import { randomUUID } from 'node:crypto'
import { can } from '../auth/authorization-service.mjs'
import { isPrismaConcurrencyError } from '../domain/prisma-concurrency-error.mjs'
import { reportFieldCatalog, reportMetricCatalog, reportSubjectCatalog } from '../domain/report-semantic-layer.mjs'
import { getRuntimeReportCatalog } from '../domain/runtime-report-read-model.mjs'

// Saved report views: a name, a layout and filters for one of the governed
// report pages. Each view is a RuntimeRecord in this namespace, keyed by its
// viewId, so a view belongs to exactly one workspace and survives restarts.
//
// Who sees and changes a view:
//   private  only its owner. Workspace administrators do not see it either:
//            it is a personal working copy, not workspace data.
//   team     every member of the same workspace.
//   change   the owner may edit, share, unshare and delete. Anyone holding
//            settings.workspace.manage may also edit, unshare and delete team
//            views of their own workspace, so a stale or misleading shared
//            view can be cleaned up without its owner.
//
// Sharing needs ownership and nothing more. A view holds no business data,
// only a layout and filter values; whoever opens it still runs the report
// with their own tenant scope and permissions, so sharing cannot widen what a
// teammate can read. The old manager/admin gate came from header-supplied
// legacy roles that no longer authorize anything, and administrators keep
// the means to remove a team view.
export const REPORT_VIEW_NAMESPACE = 'reports.saved-views'
export const WORKSPACE_MANAGE_PERMISSION = 'settings.workspace.manage'
const DEFAULT_SOURCE_ROUTE = '/app/reports/library'

const EDITABLE_FIELDS = ['name', 'description', 'subject', 'sourceRoute', 'columns', 'columnOrder', 'filters', 'sorting', 'grouping', 'measures', 'visualization', 'comparison', 'hiddenCharts', 'chartOrder', 'topN', 'dateRange', 'visibility', 'isDefault']
const LIST_FIELDS = ['columns', 'columnOrder', 'sorting', 'grouping', 'measures', 'hiddenCharts', 'chartOrder']
const AUDIT_SUMMARY = { report_view_created: 'created', report_view_updated: 'updated', report_view_shared: 'shared with the team', report_view_unshared: 'made private', report_view_cloned: 'copied', report_view_deleted: 'deleted' }

function clone(value) { return JSON.parse(JSON.stringify(value ?? null)) }
function text(value = '') { return String(value ?? '').trim() }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function fail(status, code, message) { return Object.assign(new Error(message), { status, code }) }

const notFound = () => ({ ok: false, status: 404, code: 'REPORT_VIEW_NOT_FOUND', error: 'Report view not found.' })
const forbidden = (message) => ({ ok: false, status: 403, code: 'REPORT_VIEW_FORBIDDEN', error: message })
const invalid = (errors) => ({ ok: false, status: 422, code: 'REPORT_VIEW_INVALID', error: `The report view is not valid: ${errors.join('; ')}.`, errors })
const conflict = (currentVersion, expectedVersion) => ({ ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'This report view changed. Reload it and try again.', ...(currentVersion !== undefined ? { currentVersion, expectedVersion } : {}) })

export function validateReportView(input = {}) {
  const errors = []
  const subject = text(input.subject)
  if (!text(input.name)) errors.push('name is required')
  if (!reportSubjectCatalog[subject]) errors.push('unknown report subject')
  for (const key of LIST_FIELDS) if (input[key] !== undefined && input[key] !== null && !Array.isArray(input[key])) errors.push(`${key} must be a list`)
  if (input.filters !== undefined && input.filters !== null && !isPlainObject(input.filters)) errors.push('filters must be an object')
  const runtimeCatalog = getRuntimeReportCatalog()
  const allowedFields = new Set([...(reportFieldCatalog[subject] || []), ...(runtimeCatalog.fields[subject] || [])].map((field) => field.key))
  ;(Array.isArray(input.columns) ? input.columns : []).filter((key) => !allowedFields.has(key)).forEach((key) => errors.push(`field ${key} is not governed for ${subject}`))
  const isGovernedDashboard = String(input.sourceRoute || '').startsWith('/app/reports/')
  const allowedMetrics = new Set([...reportMetricCatalog, ...runtimeCatalog.metrics].filter((metric) => isGovernedDashboard || metric.subject === subject).map((metric) => metric.id))
  ;(Array.isArray(input.measures) ? input.measures : []).filter((key) => !allowedMetrics.has(key)).forEach((key) => errors.push(`metric ${key} is not governed for ${subject}`))
  if (!['private', 'team'].includes(input.visibility || 'private')) errors.push('visibility must be private or team')
  return errors
}

// The fields a caller may set. Identity, ownership, timestamps and the version
// are always the server's, whatever the request body carries. The source route
// stays as sent until it is validated: a view saved from no dashboard may use
// only its own subject's metrics, and only then falls back to the library.
function viewFields(input = {}) {
  const source = Object.fromEntries(EDITABLE_FIELDS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]))
  const columns = clone(source.columns || [])
  return {
    name: text(source.name),
    description: text(source.description),
    subject: text(source.subject),
    sourceRoute: text(source.sourceRoute),
    columns,
    columnOrder: clone(source.columnOrder || columns),
    filters: clone(source.filters || {}),
    sorting: clone(source.sorting || []),
    grouping: clone(source.grouping || []),
    measures: clone(source.measures || []),
    visualization: text(source.visualization) || 'table',
    comparison: text(source.comparison) || 'previous_period',
    hiddenCharts: clone(source.hiddenCharts || []),
    chartOrder: clone(source.chartOrder || []),
    ...([5, 10, 20].includes(Number(source.topN)) ? { topN: Number(source.topN) } : {}),
    dateRange: clone(source.dateRange || null),
    visibility: source.visibility || 'private',
    isDefault: Boolean(source.isDefault),
  }
}

// Every change names the version the caller last saw, as other commands in
// this codebase do. A stale version is refused so one person's edit never
// silently overwrites another's; a missing one is refused too, because
// without it a lost update could not be detected.
function expectedVersionOf(input = {}) {
  const raw = input.expectedVersion
  if (raw === undefined || raw === null || raw === '') return NaN
  const version = Number(raw)
  return Number.isInteger(version) && version > 0 ? version : NaN
}

// The signed-in person as this module needs them, from the provisioned actor
// (resolveProvisionedActor). Nothing here reads request headers.
export function reportViewActor(actor) {
  const tenantId = text(actor?.tenantId)
  const id = text(actor?.user?.id || actor?.userId)
  if (!actor?.authenticated || !tenantId || !id) throw fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in to a workspace to use saved report views.')
  return Object.freeze({
    tenantId,
    id,
    name: text(actor.user?.name) || id,
    role: text(actor.role),
    canManageTeamViews: can({ actor, permission: WORKSPACE_MANAGE_PERMISSION, tenantId }),
  })
}

function requireViewer(viewer) {
  if (!text(viewer?.tenantId) || !text(viewer?.id)) throw fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in to a workspace to use saved report views.')
}

// Rows are already limited to the viewer's tenant by the query; these checks
// decide what a member of that tenant may see and change.
export function canSeeReportView(view, viewer) {
  return Boolean(view) && (view.visibility === 'team' || view.ownerId === viewer.id)
}
export function canChangeReportView(view, viewer) {
  return canSeeReportView(view, viewer) && (view.ownerId === viewer.id || (view.visibility === 'team' && Boolean(viewer.canManageTeamViews)))
}

export function createReportViewRepository({ prisma } = {}) {
  if (!prisma) throw new Error('A database client is required for saved report views.')
  const recordKey = (viewer, viewId) => ({ tenantId_namespace_recordKey: { tenantId: viewer.tenantId, namespace: REPORT_VIEW_NAMESPACE, recordKey: text(viewId) } })
  const findRow = async (client, viewer, viewId) => text(viewId) ? client.runtimeRecord.findUnique({ where: recordKey(viewer, viewId) }) : null

  async function audit(tx, viewer, action, view, metadata = {}) {
    const row = await tx.auditLog.create({ data: { id: `AUD-RPT-${randomUUID()}`, tenantId: viewer.tenantId, source: 'report_views', module: 'reports', action, entityType: 'SavedReportView', entityId: view.viewId, actorId: viewer.id, summary: `Report view "${view.name}" ${AUDIT_SUMMARY[action]}`, metadata: { visibility: view.visibility, subject: view.subject, version: view.version, ownerId: view.ownerId, ...metadata } } })
    return row.id
  }

  // Every write reads, checks and writes in one serializable transaction, so
  // the version and permission checks see the row that is written.
  async function serializable(viewer, work) {
    requireViewer(viewer)
    try {
      return await prisma.$transaction(work, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isPrismaConcurrencyError(error)) return conflict()
      if (error?.code === 'P2002') return { ok: false, status: 409, code: 'REPORT_VIEW_ID_CONFLICT', error: 'A report view with this id already exists. Try again.' }
      throw error
    }
  }

  async function insert(tx, viewer, fields, action, metadata) {
    const now = new Date().toISOString()
    const view = { viewId: `RV-${randomUUID().slice(0, 10)}`, ...fields, sourceRoute: fields.sourceRoute || DEFAULT_SOURCE_ROUTE, ownerId: viewer.id, ownerName: viewer.name, createdAt: now, updatedAt: now, lastOpenedAt: now, version: 1 }
    await tx.runtimeRecord.create({ data: { id: randomUUID(), tenantId: viewer.tenantId, namespace: REPORT_VIEW_NAMESPACE, recordKey: view.viewId, payload: view } })
    return { ok: true, status: 201, view, auditEventId: await audit(tx, viewer, action, view, metadata) }
  }

  async function update(viewId, input = {}, viewer) {
    return serializable(viewer, async (tx) => {
      const row = await findRow(tx, viewer, viewId)
      const current = row?.payload
      if (!canSeeReportView(current, viewer)) return notFound()
      if (!canChangeReportView(current, viewer)) return forbidden('Only the owner or a workspace administrator can change this view.')
      const expected = expectedVersionOf(input)
      if (Number.isNaN(expected)) return invalid(['expectedVersion must be the positive whole version of the view'])
      if (expected !== current.version) return conflict(current.version, expected)
      const fields = viewFields({ ...current, ...input })
      const errors = validateReportView(fields)
      if (errors.length) return invalid(errors)
      // Only the owner can see a private view, so only the owner can share
      // one; an administrator can at most take a team view back to private.
      const next = { viewId: current.viewId, ...fields, sourceRoute: fields.sourceRoute || DEFAULT_SOURCE_ROUTE, ownerId: current.ownerId, ownerName: current.ownerName, createdAt: current.createdAt, updatedAt: new Date().toISOString(), lastOpenedAt: current.lastOpenedAt, version: current.version + 1 }
      await tx.runtimeRecord.update({ where: { id: row.id }, data: { payload: next } })
      const action = next.visibility === current.visibility ? 'report_view_updated' : next.visibility === 'team' ? 'report_view_shared' : 'report_view_unshared'
      return { ok: true, status: 200, view: next, auditEventId: await audit(tx, viewer, action, next, { previousVersion: current.version }) }
    })
  }

  return {
    async list(viewer, filters = {}) {
      requireViewer(viewer)
      const rows = await prisma.runtimeRecord.findMany({
        where: { tenantId: viewer.tenantId, namespace: REPORT_VIEW_NAMESPACE, OR: [{ payload: { path: ['visibility'], equals: 'team' } }, { payload: { path: ['ownerId'], equals: viewer.id } }] },
      })
      return rows.map((row) => row.payload)
        .filter((view) => canSeeReportView(view, viewer) && (!filters.visibility || view.visibility === filters.visibility))
        .sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)))
    },

    // Opening a view records when it was last opened. That is bookkeeping, not
    // an edit, so it keeps the version and gives way to a concurrent edit.
    async get(viewId, viewer) {
      requireViewer(viewer)
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await findRow(tx, viewer, viewId)
          if (!row || !canSeeReportView(row.payload, viewer)) return null
          const view = { ...row.payload, lastOpenedAt: new Date().toISOString() }
          await tx.runtimeRecord.update({ where: { id: row.id }, data: { payload: view } })
          return view
        }, { isolationLevel: 'Serializable' })
      } catch (error) {
        if (!isPrismaConcurrencyError(error)) throw error
        const row = await findRow(prisma, viewer, viewId)
        return row && canSeeReportView(row.payload, viewer) ? row.payload : null
      }
    },

    // Any provisioned member may save a view. It grants no access to data, so
    // a read-only member saving their own layout is harmless.
    async create(input = {}, viewer) {
      const fields = viewFields(input)
      const errors = validateReportView(fields)
      if (errors.length) return invalid(errors)
      return serializable(viewer, (tx) => insert(tx, viewer, fields, 'report_view_created'))
    },

    update,

    // Sharing changes only the visibility; the body may say 'private' to stop.
    share(viewId, input = {}, viewer) {
      return update(viewId, { visibility: input.visibility || 'team', expectedVersion: input.expectedVersion }, viewer)
    },

    // A copy is always a private view of the person copying it.
    async clone(viewId, input = {}, viewer) {
      return serializable(viewer, async (tx) => {
        const row = await findRow(tx, viewer, viewId)
        const source = row?.payload
        if (!canSeeReportView(source, viewer)) return notFound()
        const fields = viewFields({ ...source, name: text(input.name) || `${source.name} (Copy)`, visibility: 'private' })
        const errors = validateReportView(fields)
        if (errors.length) return invalid(errors)
        return insert(tx, viewer, fields, 'report_view_cloned', { sourceViewId: source.viewId })
      })
    },

    async remove(viewId, viewer) {
      return serializable(viewer, async (tx) => {
        const row = await findRow(tx, viewer, viewId)
        const current = row?.payload
        if (!canSeeReportView(current, viewer)) return notFound()
        if (!canChangeReportView(current, viewer)) return forbidden('Only the owner or a workspace administrator can delete this view.')
        await tx.runtimeRecord.delete({ where: { id: row.id } })
        return { ok: true, status: 200, deleted: true, auditEventId: await audit(tx, viewer, 'report_view_deleted', current) }
      })
    },
  }
}
