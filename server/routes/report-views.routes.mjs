import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { createReportViewRepository, reportViewActor } from '../repositories/report-view-repository.mjs'

const COLLECTION_ACTIONS = { GET: 'list', POST: 'create' }
const VIEW_ACTIONS = { GET: 'get', PUT: 'update', DELETE: 'remove' }
const NOT_FOUND = { code: 'REPORT_VIEW_NOT_FOUND', error: 'Report view not found.' }

function matchRoute(method, pathname) {
  if (pathname === '/api/report-views') return COLLECTION_ACTIONS[method] ? { action: COLLECTION_ACTIONS[method] } : null
  const match = pathname.match(/^\/api\/report-views\/([^/]+)(?:\/(clone|share))?$/)
  const action = !match ? null : match[2] ? (method === 'POST' ? match[2] : null) : VIEW_ACTIONS[method]
  if (!action) return null
  try { return { action, id: decodeURIComponent(match[1]) } } catch { return { action: 'malformed' } }
}

async function readObject(ctx) {
  let body
  try { body = await ctx.readBody(ctx.req) } catch (error) {
    if (error instanceof SyntaxError) throw Object.assign(new Error('The request body must be a JSON object.'), { status: 400, code: 'REPORT_VIEW_INVALID_BODY' })
    throw error
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

// The actor comes only from the signed-in session: the tenant and the user it
// names, provisioned and active in that tenant. No request header supplies a
// role or a user here.
export async function handleReportViewsRoute(ctx) {
  const { res, url, send } = ctx
  const route = matchRoute(ctx.req.method, url.pathname)
  if (!route) return false
  if (!ctx.identity?.authenticated || !String(ctx.identity.tenantId || '').trim()) {
    send(res, 401, { code: 'AUTHENTICATION_REQUIRED', error: 'Sign in to a workspace to use saved report views.' })
    return true
  }
  if (route.action === 'malformed') { send(res, 404, NOT_FOUND); return true }
  try {
    const prisma = ctx.reportViewsPrisma || await getPrismaClient(ctx.env || process.env)
    const actor = reportViewActor(await resolveProvisionedActor(prisma, ctx.identity))
    const views = createReportViewRepository({ prisma })
    if (route.action === 'list') {
      send(res, 200, { views: await views.list(actor, { visibility: url.searchParams.get('visibility') || '' }), actor: { id: actor.id, name: actor.name, role: actor.role, canManageTeamViews: actor.canManageTeamViews } })
      return true
    }
    if (route.action === 'get') {
      const view = await views.get(route.id, actor)
      send(res, view ? 200 : 404, view || NOT_FOUND)
      return true
    }
    const result = route.action === 'create' ? await views.create(await readObject(ctx), actor)
      : route.action === 'update' ? await views.update(route.id, await readObject(ctx), actor)
      : route.action === 'share' ? await views.share(route.id, await readObject(ctx), actor)
      : route.action === 'clone' ? await views.clone(route.id, await readObject(ctx), actor)
      : await views.remove(route.id, actor)
    send(res, result.status, result)
  } catch (error) {
    if (!error?.status) throw error
    send(res, error.status, { code: error.code || 'REPORT_VIEW_FAILED', error: error.message })
  }
  return true
}
