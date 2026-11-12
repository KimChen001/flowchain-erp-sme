import { can } from '../auth/authorization-service.mjs'
import { DECISION_KIND_AREA, DECISION_PERMISSION, DRAFTED_DECISION_KINDS, decisionKey, parseDecision } from '../domain/decision-items.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { sendReadAccessError } from '../domain/report-read-access.mjs'
import { databaseClient } from '../domain/today-work-read-service.mjs'
import { SUPPLIER_EMAIL_PERMISSION } from '../domain/supplier-follow-up-email.mjs'
import { createDecisionItemRepository } from '../repositories/decision-item-repository.mjs'
import { sendSupplierFollowUp } from '../services/supplier-follow-up-email-service.mjs'
import { readTodayForReader } from '../services/today-read-service.mjs'

// A person's decision on a row of their Today (docs/drafted-decisions-design.md):
//   POST /api/decision-items/decide  { key, option, reasonCode?, note?, returnOn?, documentType?, documentIds? }
//   POST /api/decision-items/reopen  { key }
// key is "kind:recordId" as Today sends it. The row must be on the reader's
// own Today now, read by the same rules as GET /api/home/overview, so nobody
// decides on a row they cannot see. Deciding needs the permission the drafted
// actions need (DECISION_PERMISSION). A decision records only: the documents
// an accepted draft names were created through their own routes, with their
// own checks, and must exist in this workspace.
//
// One exception to "the row is on Today now": converting an approved request
// takes its row off Today at once, so "accepted" on a request whose live item
// still exists is taken when the request records the very orders named.

//   POST /api/decision-items/send-follow-up  { key, to, confirmedTo, subject, body }
//     emails the follow-up on an overdue order to its supplier
//     (server/services/supplier-follow-up-email-service.mjs); needs
//     SUPPLIER_EMAIL_PERMISSION and the workspace's supplier email switch.
const ROUTES = Object.freeze({ '/api/decision-items/decide': 'decide', '/api/decision-items/reopen': 'reopen', '/api/decision-items/send-follow-up': 'send' })
const text = (value) => String(value ?? '').trim()
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

async function readObject(ctx) {
  let body
  try { body = await ctx.readBody(ctx.req) } catch (error) {
    if (error instanceof SyntaxError) throw fail(400, 'DECISION_INVALID_BODY', 'The request body must be a JSON object.')
    throw error
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

// The row of a converted request, rebuilt from its live item, when the orders
// named are the ones the request records it made.
async function convertedRow(repository, tenantId, key, body, reader) {
  if (text(body.option) !== 'accepted' || text(body.documentType) !== 'purchase_order') return null
  const item = await repository.findLive(tenantId, key)
  if (!item || item.kind !== 'purchase_request_to_convert' || reader.hidden.includes(DECISION_KIND_AREA[item.kind])) return null
  const named = [...new Set((Array.isArray(body.documentIds) ? body.documentIds : []).map(text).filter(Boolean))]
  const made = new Set(await repository.ordersFromRequest(tenantId, item.recordId))
  if (!named.length || named.some((id) => !made.has(id))) return null
  return { kind: item.kind, entityType: item.entityType, recordId: item.recordId, date: item.snapshot?.date || null, overdueDays: 0, detail: {} }
}

export async function handleDecisionItemsRoute(ctx) {
  const { req, res, url, send } = ctx
  const action = req.method === 'POST' ? ROUTES[url.pathname] : null
  if (!action) return false
  const tenantId = text(ctx.identity?.tenantId)
  if (!ctx.identity?.authenticated || !tenantId) {
    send(res, 401, { code: 'AUTHENTICATION_REQUIRED', error: 'Sign in to a workspace to decide on Today.' })
    return true
  }
  try {
    const body = await readObject(ctx)
    const key = text(body.key)
    const prisma = await databaseClient(ctx)
    if (!prisma?.decisionItem) throw fail(503, 'DECISIONS_UNAVAILABLE', 'Decisions need the workspace database.')
    const actor = await resolveProvisionedActor(prisma, ctx.identity)
    const permission = action === 'send' ? SUPPLIER_EMAIL_PERMISSION : DECISION_PERMISSION
    if (!can({ actor, permission, tenantId: actor.tenantId })) throw fail(403, action === 'send' ? 'SUPPLIER_EMAIL_NOT_ALLOWED' : 'DECISION_NOT_ALLOWED', action === 'send' ? 'Your role cannot email suppliers. Ask an administrator.' : 'Your role cannot decide on these. Ask a buyer or an administrator.')
    const repository = createDecisionItemRepository({ prisma })
    const reader = await readTodayForReader(ctx)
    if (action === 'send') {
      const row = reader.work.all.find((entry) => entry.kind === 'purchase_order_overdue' && decisionKey(entry) === key)
      if (!row) throw fail(404, 'DECISION_ROW_NOT_FOUND', 'This is no longer on your Today. Reload Today.')
      const result = await sendSupplierFollowUp({ prisma, tenantId, actor, row, input: body, env: ctx.env || process.env, mailer: ctx.mailer, now: reader.now, today: reader.today, timeZone: reader.timeZone })
      send(res, 200, { key, ...result })
      return true
    }
    const row = reader.work.all.find((entry) => DRAFTED_DECISION_KINDS.includes(entry.kind) && decisionKey(entry) === key)
      || (action === 'decide' ? await convertedRow(repository, tenantId, key, body, reader) : null)
    if (!row) throw fail(404, 'DECISION_ROW_NOT_FOUND', 'This is no longer on your Today. Reload Today.')
    const options = { now: reader.now, today: reader.today }
    let saved
    if (action === 'decide') {
      const parsed = parseDecision(body, { kind: row.kind, today: reader.today })
      if (parsed.decision === 'accepted' && !(await repository.documentsExist(tenantId, parsed.documentType, parsed.documentIds))) {
        throw fail(422, 'DECISION_DOCUMENT_INVALID', 'Name documents that exist in this workspace.')
      }
      saved = await repository.decide(tenantId, actor.user.id, row, parsed, options)
    } else {
      saved = await repository.reopen(tenantId, actor.user.id, row, options)
    }
    send(res, 200, { key, state: saved.state, decision: saved.state === 'decided' ? saved.decision : null, returnOn: saved.returnOn || null })
  } catch (error) {
    if (error?.name === 'PilotIdentityError' || error?.name === 'AuthorizationError') { sendReadAccessError(ctx, error); return true }
    if (!error?.status) throw error
    send(res, error.status, { code: error.code || 'DECISION_FAILED', error: error.message, ...(error.details ? { details: error.details } : {}), ...(error.decidedBy !== undefined ? { decidedBy: error.decidedBy } : {}) })
  }
  return true
}
