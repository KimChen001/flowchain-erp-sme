import { assertAuthorized } from '../auth/authorization-service.mjs'
import { escapeLikePattern } from '../persistence/like-pattern.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { DEFAULT_TENANT_TIMEZONE, tenantCalendarDay } from './tenant-calendar-day.mjs'
import {
  CONTRACT_PERMISSIONS,
  assertContractsEnabled,
  contractAccessFor,
  contractFail,
  contractHistoryDetails,
  contractView,
  maskContract,
} from './contract-policy.mjs'
import { CONTRACT_MAX_NOTICE_DAYS, CONTRACT_MAX_REMINDER_DAYS, CONTRACT_STATES, CONTRACT_TYPES, addContractDays } from '../../shared/contract-status.mjs'

// Reading contracts (docs/contracts-module-design.md, K1). Both reads need
// contracts.contract.read and the contracts capability; the total value needs
// procurement.prices.read (maskContract).
//
//   list    GET /api/contracts: search over the number, their reference, the
//           title and the supplier's name (LIKE wildcards escaped); filters
//           by type, owner, supplier and shown state; counts by shown state
//           under the same search, for the list's cards. The shown state is
//           read from the dates on the workspace day (shared/contract-status),
//           so it is filtered after the database read.
//   detail  GET /api/contracts/:id: the contract, its files and its history
//           (the audit rows of this contract, newest first).
//   Today   readContractWork: active contracts whose notice deadline or end
//           date is inside the reminder window, or whose end date passed, for
//           their owner, or every one for a reader who manages contracts.

export const CONTRACT_LIST_PAGE_SIZE = 50
export const CONTRACT_LIST_MAX_PAGE_SIZE = 200
// How many contracts one list read considers before filtering by state.
export const CONTRACT_LIST_SCAN_LIMIT = 5000
export const CONTRACT_TODAY_SCAN_LIMIT = 500
// A contract that ended without renewing stays on Today this many days after
// its end date, so a lapse is seen, then leaves it. One that renews
// automatically stays until someone records its new end date.
export const CONTRACT_ENDED_TODAY_DAYS = 30
const HISTORY_LIMIT = 200

const text = (value) => String(value ?? '').trim()
const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null)

export const CONTRACT_VIEW_INCLUDE = Object.freeze({
  supplier: { select: { id: true, code: true, name: true } },
  owner: { select: { id: true, name: true } },
  renews: { select: { id: true, number: true } },
  renewals: { select: { id: true, number: true, status: true, activatedAt: true }, orderBy: { createdAt: 'asc' } },
})

export async function workspaceDay(client, tenantId, now = new Date()) {
  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
  const timeZone = text(tenant?.timezone) || DEFAULT_TENANT_TIMEZONE
  return { today: tenantCalendarDay(now, timeZone), timeZone }
}

// One contract as the reader may see it, or null.
export async function loadContractView(client, { tenantId, id, access, today }) {
  const row = await client.contract.findFirst({ where: { id: text(id), tenantId }, include: CONTRACT_VIEW_INCLUDE })
  return row ? maskContract(contractView(row, { today }), access) : null
}

const SORTS = new Set(['recent', 'key_date', 'number'])
const listParams = (query = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1)
  const pageSize = Math.min(CONTRACT_LIST_MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize, 10) || CONTRACT_LIST_PAGE_SIZE))
  const states = [...new Set(text(query.state).split(',').map(text).filter(Boolean))]
  const unknownState = states.find((state) => !CONTRACT_STATES.includes(state))
  if (unknownState) contractFail('VALIDATION_ERROR', 'Check the filters.', 422, [{ field: 'state', code: 'INVALID', message: `Unknown state: ${unknownState}.` }])
  const type = text(query.type)
  if (type && !CONTRACT_TYPES.includes(type)) contractFail('VALIDATION_ERROR', 'Check the filters.', 422, [{ field: 'type', code: 'INVALID', message: `Unknown type: ${type}.` }])
  const sort = SORTS.has(text(query.sort)) ? text(query.sort) : 'recent'
  return { page, pageSize, states, type, sort, search: text(query.search ?? query.q), ownerId: text(query.ownerId), supplierId: text(query.supplierId) }
}

export function contractListWhere(tenantId, params) {
  const where = { tenantId }
  if (params.type) where.type = params.type
  if (params.supplierId) where.supplierId = params.supplierId
  if (params.ownerId) where.ownerId = params.ownerId === 'none' ? null : params.ownerId
  if (params.search) {
    const contains = { contains: escapeLikePattern(params.search), mode: 'insensitive' }
    where.OR = [{ number: contains }, { externalReference: contains }, { title: contains }, { supplier: { name: contains } }]
  }
  return where
}

// Earliest key date first, contracts without one last; then number.
const byKeyDate = (a, b) => (a.keyDate === b.keyDate ? a.number.localeCompare(b.number, 'en') : !a.keyDate ? 1 : !b.keyDate ? -1 : a.keyDate < b.keyDate ? -1 : 1)

export function createContractReadService({ prisma, env = process.env, now = () => new Date() } = {}) {
  const db = async () => prisma || getPrismaClient(env)

  async function reader(client, context) {
    assertContractsEnabled(env)
    const actor = await resolveProvisionedActor(client, context?.identity || context)
    assertAuthorized({ actor, permission: CONTRACT_PERMISSIONS.read, tenantId: actor.tenantId })
    return { actor, access: contractAccessFor(actor) }
  }

  async function list(query = {}, context) {
    const client = await db()
    const { actor, access } = await reader(client, context)
    const params = listParams(query)
    if (params.ownerId === 'me') params.ownerId = access.userId || 'none'
    const { today } = await workspaceDay(client, actor.tenantId, now())
    // Counts by state follow every filter but the state itself.
    const rows = await client.contract.findMany({
      where: contractListWhere(actor.tenantId, params),
      include: CONTRACT_VIEW_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: CONTRACT_LIST_SCAN_LIMIT + 1,
    })
    const truncated = rows.length > CONTRACT_LIST_SCAN_LIMIT
    const views = rows.slice(0, CONTRACT_LIST_SCAN_LIMIT).map((row) => maskContract(contractView(row, { today }), access))
    const counts = Object.fromEntries(['all', ...CONTRACT_STATES].map((state) => [state, 0]))
    for (const view of views) { counts.all += 1; counts[view.state] += 1 }
    const matching = params.states.length ? views.filter((view) => params.states.includes(view.state)) : views
    const sorted = params.sort === 'key_date' ? [...matching].sort(byKeyDate)
      : params.sort === 'number' ? [...matching].sort((a, b) => a.number.localeCompare(b.number, 'en'))
        : matching
    const start = (params.page - 1) * params.pageSize
    return {
      today,
      contracts: sorted.slice(start, start + params.pageSize),
      total: sorted.length,
      page: params.page,
      pageSize: params.pageSize,
      counts,
      filters: { search: params.search, type: params.type || null, states: params.states, ownerId: params.ownerId || null, supplierId: params.supplierId || null, sort: params.sort },
      access: { manage: access.manage, prices: access.prices },
      limitations: truncated ? ['truncated'] : [],
    }
  }

  async function get(id, context) {
    const client = await db()
    const { actor, access } = await reader(client, context)
    const { today } = await workspaceDay(client, actor.tenantId, now())
    const contract = await loadContractView(client, { tenantId: actor.tenantId, id, access, today })
    if (!contract) contractFail('CONTRACT_NOT_FOUND', 'Contract was not found.', 404)
    const [files, history] = await Promise.all([
      client.contractAttachment.findMany({ where: { tenantId: actor.tenantId, contractId: contract.id, status: 'active' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      client.auditLog.findMany({ where: { tenantId: actor.tenantId, entityType: 'Contract', entityId: contract.id }, include: { actor: { select: { id: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY_LIMIT }),
    ])
    const uploaderIds = [...new Set(files.map((file) => file.createdById))]
    const uploaders = uploaderIds.length ? await client.user.findMany({ where: { tenantId: actor.tenantId, id: { in: uploaderIds } }, select: { id: true, name: true } }) : []
    const names = new Map(uploaders.map((user) => [user.id, user.name]))
    return {
      today,
      contract: {
        ...contract,
        files: files.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          createdAt: iso(file.createdAt),
          createdBy: { id: file.createdById, name: names.get(file.createdById) ?? null },
          downloadUrl: `/api/attachments/${encodeURIComponent(file.id)}/download`,
        })),
        history: history.map((row) => ({
          id: row.id,
          action: row.action,
          at: iso(row.createdAt),
          actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
          summary: row.summary,
          details: contractHistoryDetails(row.metadata, access),
        })),
      },
      access: { manage: access.manage, prices: access.prices },
    }
  }

  return { list, get }
}

// The contracts Today lists: active ones whose key date is inside the
// reminder window (notice due, ending), that renew automatically and are past
// their end date, or that ended with nothing recorded in the last
// CONTRACT_ENDED_TODAY_DAYS days, for their owner, or all of them when ownerId
// is null (a reader who manages contracts). Rows hold codes, ids and days;
// the page writes the words.
export async function readContractWork(client, { tenantId, today, ownerId = null }) {
  // No key date can be further out than the longest notice plus reminder.
  const horizon = new Date(`${addContractDays(today, CONTRACT_MAX_NOTICE_DAYS + CONTRACT_MAX_REMINDER_DAYS)}T00:00:00.000Z`)
  const rows = await client.contract.findMany({
    where: { tenantId, status: 'active', endDate: { not: null, lte: horizon }, ...(ownerId ? { ownerId } : {}) },
    include: CONTRACT_VIEW_INCLUDE,
    orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
    take: CONTRACT_TODAY_SCAN_LIMIT + 1,
  })
  const truncated = rows.length > CONTRACT_TODAY_SCAN_LIMIT
  const contracts = rows.slice(0, CONTRACT_TODAY_SCAN_LIMIT)
    .map((row) => contractView(row, { today }))
    .filter((view) => ['notice_due', 'ending', 'past_end'].includes(view.state) || (view.state === 'ended' && view.daysUntilKeyDate >= -CONTRACT_ENDED_TODAY_DAYS))
    .map((view) => ({
      id: view.id,
      number: view.number,
      title: view.title,
      supplierName: view.supplier?.name ?? null,
      ownerId: view.ownerId,
      state: view.state,
      keyDate: view.keyDate,
      endDate: view.endDate,
      noticeDeadline: view.noticeDeadline,
      renewal: view.renewal,
    }))
  return { contracts, truncated }
}
