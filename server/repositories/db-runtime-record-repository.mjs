import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

function text(value = '') {
  return String(value ?? '').trim()
}

function requireScope(scope = {}) {
  const tenantId = text(scope.tenantId)
  if (!tenantId) {
    const error = new Error('Tenant context is required for runtime records.')
    error.code = 'TENANT_CONTEXT_REQUIRED'
    error.status = 403
    throw error
  }
  return tenantId
}

export function createDbRuntimeRecordRepository({ env = process.env, prisma } = {}) {
  const client = async () => prisma || getPrismaClient(env)

  return {
    async list(scope = {}, namespace = '') {
      const tenantId = requireScope(scope)
      const rows = await (await client()).runtimeRecord.findMany({
        where: { tenantId, namespace: text(namespace) },
        orderBy: { updatedAt: 'desc' },
      })
      return rows.map((row) => structuredClone(row.payload))
    },
    async get(scope = {}, namespace = '', recordKey = '') {
      const tenantId = requireScope(scope)
      const row = await (await client()).runtimeRecord.findUnique({
        where: {
          tenantId_namespace_recordKey: {
            tenantId,
            namespace: text(namespace),
            recordKey: text(recordKey),
          },
        },
      })
      return row ? structuredClone(row.payload) : null
    },
    async put(scope = {}, namespace = '', recordKey = '', payload = {}) {
      const tenantId = requireScope(scope)
      const normalizedNamespace = text(namespace)
      const normalizedKey = text(recordKey)
      const row = await (await client()).runtimeRecord.upsert({
        where: {
          tenantId_namespace_recordKey: {
            tenantId,
            namespace: normalizedNamespace,
            recordKey: normalizedKey,
          },
        },
        create: {
          id: randomUUID(),
          tenantId,
          namespace: normalizedNamespace,
          recordKey: normalizedKey,
          payload,
        },
        update: { payload },
      })
      return structuredClone(row.payload)
    },
  }
}
