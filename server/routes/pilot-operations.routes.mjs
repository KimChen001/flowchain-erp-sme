import { PilotIdentityError } from '../domain/pilot-identity.mjs'
import { createPilotOperationsService } from '../domain/pilot-operations-service.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

export async function handlePilotOperationsRoute(ctx) {
  const diagnostics = ctx.req.method === 'GET' && ctx.url.pathname === '/api/admin/pilot-diagnostics'
  const exportMatch = ctx.req.method === 'GET' && ctx.url.pathname.match(/^\/api\/pilot\/exports\/([^/]+)$/)
  if (!diagnostics && !exportMatch) return false
  try {
    const service = createPilotOperationsService({ prisma: await getPrismaClient(ctx.env || process.env) })
    const result = diagnostics ? await service.diagnostics(ctx.identity) : await service.exportDataset(decodeURIComponent(exportMatch[1]), ctx.identity)
    ctx.send(ctx.res, 200, result); return true
  } catch (error) {
    if (!(error instanceof PilotIdentityError)) throw error
    ctx.send(ctx.res, error.status || 400, { code: error.code, message: error.message }); return true
  }
}
