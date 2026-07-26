import { actionDraftSchema, supportedActionDraftTypes, validateActionDraftPayload } from '../domain/action-draft-boundary.mjs'
import { createTransientActionDraftPreview } from './transient-action-draft-preview.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'

const supportedTypes = new Set(supportedActionDraftTypes.map((item) => item.type))

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

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeCreatedById(draft = {}) {
  return text(draft.createdById)
}

function toDate(value) {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function validationData(draft = {}) {
  const validation = draft.validation || {}
  return {
    id: text(validation.id, `${draft.id}-VAL`),
    ok: Boolean(validation.ok),
    missingFields: asArray(validation.missingFields),
    warnings: asArray(validation.warnings),
    errors: asArray(validation.errors),
  }
}

function auditTrailData(draft = {}) {
  return asArray(draft.auditTrail).map((entry, index) => ({
    id: text(entry.id, `${draft.id}-AUD-${String(index + 1).padStart(3, '0')}`),
    action: text(entry.action, 'draft_previewed'),
    actorId: text(entry.actorId) || null,
    summary: text(entry.summary),
    metadata: {
      source: text(entry.source),
      timestamp: text(entry.timestamp),
    },
    createdAt: toDate(entry.timestamp),
  }))
}

function toActionDraftCreateData(draft = {}) {
  return {
    id: text(draft.id),
    tenantId: text(draft.tenantId, 'tenant-flowchain-sme'),
    type: text(draft.type),
    title: text(draft.title, 'Action Draft'),
    status: text(draft.status, 'preview'),
    source: text(draft.source) || null,
    createdById: normalizeCreatedById(draft) || null,
    requiresConfirmation: draft.requiresConfirmation !== false,
    previewOnly: draft.confirmationBoundary?.previewOnly !== false,
    originEvidence: asArray(draft.originEvidence),
    payload: draft.payload || {},
    createdAt: toDate(draft.createdAt),
    validations: {
      create: validationData(draft),
    },
    auditTrail: {
      create: auditTrailData(draft),
    },
  }
}

function mapActionDraftRecord(record = {}) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    type: record.type,
    title: record.title,
    status: record.status,
    source: record.source || '',
    createdById: record.createdById || '',
    createdAt: record.createdAt?.toISOString?.() || record.createdAt,
    updatedAt: record.updatedAt?.toISOString?.() || record.updatedAt,
    requiresConfirmation: record.requiresConfirmation,
    previewOnly: record.previewOnly,
    originEvidence: record.originEvidence || [],
    payload: record.payload || {},
    validation: record.validations?.[0] || null,
    auditTrail: record.auditTrail || [],
  }
}

export function createDbActionDraftRepository({ db = {}, env = process.env, prisma } = {}) {
  const previewRepository = createTransientActionDraftPreview(db)

  return {
    mode: 'database',
    adapter: 'db-action-draft-v1',
    getSchema: () => actionDraftSchema(),
    normalizeDraftType: (type = '') => {
      const normalized = text(type).toLowerCase()
      return supportedTypes.has(normalized) ? normalized : ''
    },
    validateDraft: ({ type = '', payload = {} } = {}) => validateActionDraftPayload(type, payload),
    previewDraft: (request = {}, options = {}) => previewRepository.previewDraft(request, options),
    persistDraft: async (draft = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const type = text(draft.type).toLowerCase()
      if (!supportedTypes.has(type)) {
        const error = new Error(`Unsupported draft type: ${text(draft.type, 'missing')}`)
        error.code = 'FLOWCHAIN_ACTION_DRAFT_UNSUPPORTED_TYPE'
        error.status = 400
        throw error
      }
      if (!draft?.id) {
        const error = new Error('Action draft id is required before persistence.')
        error.code = 'FLOWCHAIN_ACTION_DRAFT_ID_REQUIRED'
        error.status = 400
        throw error
      }
      const record = await client.actionDraft.create({
        data: toActionDraftCreateData(draft),
        include: { validations: true, auditTrail: true },
      })
      return mapActionDraftRecord(record)
    },
    getDraft: async (id = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const record = await client.actionDraft.findFirst({
        where: {
          id: text(id),
          tenantId: text(options.tenantId, 'tenant-flowchain-sme'),
        },
        include: { validations: true, auditTrail: true },
      })
      return record ? mapActionDraftRecord(record) : null
    },
    confirmDraft: async () => {
      const error = new Error('Action draft confirmation is not implemented in database mode yet.')
      error.code = 'FLOWCHAIN_ACTION_DRAFT_CONFIRM_NOT_IMPLEMENTED'
      error.status = 501
      throw error
    },
  }
}
