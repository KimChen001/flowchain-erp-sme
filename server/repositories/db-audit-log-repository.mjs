import { normalizeAuditEvent } from '../domain/audit-foundation.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|database_url|databaseurl|connectionstring)/i
const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /sk-[A-Za-z0-9._-]+/gi,
  /(OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|DATABASE_URL)\s*[:=]\s*[^,\s;]+/gi,
  /postgres(?:ql)?:\/\/[^,\s;]+/gi,
  /mysql:\/\/[^,\s;]+/gi,
]

function requireDatabaseConfig(env = process.env) {
  return validateDatabasePersistenceConfig(env)
}

async function resolvePrisma({ env = process.env, prisma } = {}) {
  requireDatabaseConfig(env)
  return prisma || getPrismaClient(env)
}

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function redactText(value = '') {
  return SECRET_VALUE_PATTERNS.reduce((output, pattern) => output.replace(pattern, '[redacted]'), String(value ?? ''))
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 5) return '[truncated]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value).slice(0, 1000)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1))

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeMetadata(item, depth + 1),
    ])
  )
}

function normalizeEntity(entry = {}) {
  return entry.entity || {
    type: entry.entityType || 'system',
    id: entry.entityId || '',
  }
}

function toDate(value) {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function toAuditCreateData(entry = {}, options = {}) {
  const normalized = normalizeAuditEvent({
    ...entry,
    entity: normalizeEntity(entry),
    metadata: sanitizeMetadata(entry.metadata || {}),
    summary: redactText(entry.summary || entry.reason || ''),
  }, options)
  return {
    id: normalized.id,
    tenantId: normalized.tenantId,
    source: normalized.source,
    module: normalized.module,
    action: normalized.action,
    entityType: normalized.entity?.type || 'system',
    entityId: normalized.entity?.id || '',
    actorId: entry.actorId || null,
    summary: normalized.summary,
    metadata: {
      actor: normalized.actor || null,
      before: sanitizeMetadata(normalized.before),
      after: sanitizeMetadata(normalized.after),
      metadata: normalized.metadata || {},
    },
    createdAt: toDate(normalized.timestamp),
  }
}

function mapAuditRecord(record = {}) {
  const metadata = record.metadata || {}
  return {
    id: record.id,
    tenantId: record.tenantId,
    timestamp: record.createdAt?.toISOString?.() || record.createdAt,
    actor: metadata.actor || (record.actorId ? { id: record.actorId } : null),
    source: record.source,
    module: record.module || '',
    action: record.action,
    entity: {
      type: record.entityType,
      id: record.entityId,
    },
    entityType: record.entityType,
    entityId: record.entityId,
    summary: record.summary,
    before: metadata.before ?? null,
    after: metadata.after ?? null,
    metadata: metadata.metadata || {},
  }
}

function whereFromFilters(filters = {}) {
  return {
    ...(text(filters.tenantId) ? { tenantId: text(filters.tenantId) } : { tenantId: 'tenant-flowchain-sme' }),
    ...(text(filters.entityType) ? { entityType: text(filters.entityType) } : {}),
    ...(text(filters.entityId) ? { entityId: text(filters.entityId) } : {}),
    ...(text(filters.action) ? { action: text(filters.action) } : {}),
    ...(text(filters.source) ? { source: text(filters.source) } : {}),
  }
}

export function createDbAuditLogRepository({ env = process.env, prisma } = {}) {
  return {
    mode: 'database',
    adapter: 'db-audit-log-v1',
    listAuditEntries: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const limit = Math.min(200, Math.max(1, Number(filters.limit || 100)))
      const records = await client.auditLog.findMany({
        where: whereFromFilters(filters),
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return records.map(mapAuditRecord)
    },
    recordAuditEntry: async (entry = {}, options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const record = await client.auditLog.create({
        data: toAuditCreateData(entry, options),
      })
      return mapAuditRecord(record)
    },
    recordAiEventBestEffort: async (entry = {}, options = {}) => {
      try {
        const record = await createDbAuditLogRepository({ env, prisma }).recordAuditEntry({
          ...entry,
          source: 'ai_assisted',
        }, options)
        return { ok: true, entry: record }
      } catch (error) {
        return { ok: false, errorCode: error?.code || error?.name || 'audit_failed' }
      }
    },
    listAuditEvents: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await client.auditLog.findMany({
        where: whereFromFilters(filters),
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return records.map(mapAuditRecord)
    },
    recordAuditEvent: async (entry = {}, options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const record = await client.auditLog.create({
        data: toAuditCreateData(entry, options),
      })
      return mapAuditRecord(record)
    },
    sanitizeMetadata,
  }
}
