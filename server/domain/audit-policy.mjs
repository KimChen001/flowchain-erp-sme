import { classifyRoute } from './route-classification.mjs'

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /sk-[A-Za-z0-9._-]+/gi,
  /(OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|DATABASE_URL)\s*[:=]\s*[^,\s;]+/gi,
  /postgres(?:ql)?:\/\/[^,\s;]+/gi,
  /mysql:\/\/[^,\s;]+/gi,
]

function safeText(value = '', fallback = '') {
  const text = String(value || fallback)
  return SECRET_VALUE_PATTERNS
    .reduce((output, pattern) => output.replace(pattern, '[redacted]'), text)
    .slice(0, 240)
}

function databaseAuditRepository(ctx = {}) {
  const repository = ctx.repositories?.auditLog
  return repository?.mode === 'database' || repository?.adapter === 'db-audit-log-v1'
    ? repository
    : null
}

// Attribute the entry to the signed-in session. Without a tenant the audit
// foundation files it under a fallback tenant, the foreign key rejects it, and
// the failure is swallowed below, so the entry is silently lost.
function sessionAttribution(identity) {
  if (!identity?.authenticated) return {}
  const tenantId = String(identity.tenantId || '').trim()
  const userId = String(identity.userId || '').trim()
  return {
    ...(tenantId ? { tenantId } : {}),
    ...(userId
      ? { actorId: userId, actor: { type: 'user', id: userId, role: String(identity.role || '') } }
      : {}),
  }
}

export async function recordDatabaseAuditBestEffort(ctx = {}, entry = {}, options = {}) {
  const repository = databaseAuditRepository(ctx)
  if (typeof repository?.recordAuditEntry !== 'function') return { ok: false, skipped: true }

  try {
    const record = await repository.recordAuditEntry({
      source: 'system',
      module: 'system',
      ...entry,
      ...sessionAttribution(ctx.identity),
      summary: safeText(entry.summary || entry.reason || ''),
    }, options)
    return { ok: true, entry: record }
  } catch (error) {
    return { ok: false, errorCode: error?.code || error?.name || 'audit_failed' }
  }
}

export function actionDraftPreviewAuditEntry(result = {}) {
  const draft = result.draft || {}
  return {
    module: 'action-drafts',
    action: 'draft_previewed',
    entity: { type: 'actionDraft', id: draft.id || '' },
    summary: `Action draft preview prepared for ${safeText(draft.type || 'unknown draft')}.`,
    metadata: {
      draftType: safeText(draft.type || ''),
      previewOnly: true,
      requiresConfirmation: draft.requiresConfirmation !== false,
      validationOk: draft.validation?.ok === true,
    },
  }
}

export function actionDraftSavedAuditEntry(saved = {}) {
  return {
    module: 'action-drafts',
    action: 'draft_saved',
    entity: { type: 'actionDraft', id: saved.id || '' },
    summary: `Action draft ${safeText(saved.id || 'unknown')} saved without creating a business document.`,
    metadata: {
      draftType: safeText(saved.type || ''),
      createsBusinessDocument: false,
      requiresConfirmation: true,
      status: safeText(saved.status || ''),
    },
  }
}

export function legacyMutationBlockedAuditEntry({ method = '', pathname = '' } = {}) {
  const route = classifyRoute(method, pathname)
  return {
    module: route.group || 'legacy-mutation',
    action: 'legacy_mutation_blocked',
    entity: { type: 'route', id: `${route.method || method} ${route.pathname || pathname}` },
    summary: `Database mode blocked legacy mutation ${safeText(route.method || method)} ${safeText(route.pathname || pathname)}.`,
    metadata: {
      method: route.method || method,
      pathname: route.pathname || pathname,
      routeGroup: route.group,
      classification: route.classification,
      databaseMode: route.databaseMode,
    },
  }
}
