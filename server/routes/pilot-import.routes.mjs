import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { PilotIdentityError } from '../domain/pilot-identity.mjs'
import { createPilotImportService } from '../domain/pilot-import-service.mjs'

export async function handlePilotImportRoute(ctx) {
  if (!ctx.url.pathname.startsWith('/api/imports')) return false
  const prisma = await getPrismaClient(ctx.env || process.env); const service = createPilotImportService({ prisma })
  try {
    if (!ctx.identity?.authenticated) throw new PilotIdentityError('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401)
    let result; let status = 200
    if (ctx.req.method === 'POST' && ctx.url.pathname === '/api/imports/preview') {
      const body = await ctx.readBody(ctx.req)
      if (!body?.importType) return false
      result = await service.preview(body, ctx.identity); status = 201
      ctx.send(ctx.res, status, result); return true
    }
    const detail = ctx.url.pathname.match(/^\/api\/imports\/([^/]+)$/)
    const issues = ctx.url.pathname.match(/^\/api\/imports\/([^/]+)\/issues$/)
    const commit = ctx.url.pathname.match(/^\/api\/imports\/([^/]+)\/commit$/)
    const cancel = ctx.url.pathname.match(/^\/api\/imports\/([^/]+)\/cancel$/)
    const routeId = decodeURIComponent((detail || issues || commit || cancel)?.[1] || '')
    if (routeId && !routeId.startsWith('pilot-')) return false
    if (ctx.req.method === 'GET' && detail) result = await service.getBatch(routeId, ctx.identity)
    if (ctx.req.method === 'GET' && issues) result = await service.getIssues(routeId, ctx.identity)
    if (ctx.req.method === 'POST' && commit) result = await service.commit(routeId, await ctx.readBody(ctx.req), ctx.identity)
    if (ctx.req.method === 'POST' && cancel) result = await service.cancel(routeId, ctx.identity)
    if (result === undefined) return false
    ctx.send(ctx.res, status, result); return true
  } catch (error) {
    if (!(error instanceof PilotIdentityError)) throw error
    ctx.send(ctx.res, error.status || 400, { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }); return true
  }
}
