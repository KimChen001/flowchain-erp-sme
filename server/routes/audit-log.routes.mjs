import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'

function auditLogRepository(ctx) {
  if (!ctx.repositories?.auditLog) throw new Error('PostgreSQL audit repository is not configured.')
  return ctx.repositories.auditLog
}

export async function handleAuditLogRoute(ctx) {
  const { req, res, url, send } = ctx
  const repository = auditLogRepository(ctx)

  if (req.method === 'GET' && url.pathname === '/api/audit-log') {
    const actor = await resolveProvisionedActor(await getPrismaClient(ctx.env || process.env), ctx.identity)
    assertAuthorized({ actor, permission: 'audit.read', tenantId: actor.tenantId })
    const sensitive = can({ actor, permission: 'audit.read_sensitive', tenantId: actor.tenantId })
    const entityType = url.searchParams.get('entityType') || ''
    const entityId = url.searchParams.get('entityId') || ''
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)))
    const entries = await repository.listAuditEntries({ ...(ctx.identity?.tenantId ? { tenantId: ctx.identity.tenantId } : {}), entityType, entityId, limit })
    const visible = entries.map(entry => sensitive ? entry : { ...entry, metadata: null, before: entry.before === undefined ? undefined : null, after: entry.after === undefined ? undefined : null, redacted: true, fieldVisibility: { metadata: { visible: false, reasonCode: 'FIELD_PERMISSION_DENIED', permission: 'audit.read_sensitive' } } })
    send(res, 200, visible)
    return true
  }

  return false
}
