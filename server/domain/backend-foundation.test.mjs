import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createScmServer } from '../routes/scm-legacy.routes.mjs'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import { handleContextRoute } from '../routes/context.routes.mjs'
import { normalizeAuditEvent } from './audit-foundation.mjs'
import { getAiToolRegistry } from './ai-tool-registry.mjs'
import { listAuditEvents, recordAuditEvent } from '../repositories/audit-log-repository.mjs'
import { GENERIC_INTERNAL_ERROR, sanitizeErrorSummary, sendInternalServerError } from '../utils/safe-errors.mjs'
import { databaseModeMutationBlockedPayload } from './route-classification.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function requestJson(port, method, pathname, body, headers = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: raw ? {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
      } : headers,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: res.statusCode,
          payload: text ? JSON.parse(text) : null,
        })
      })
    })
    req.on('error', reject)
    if (raw) req.write(raw)
    req.end()
  })
}

function createRouteContext(method, pathname, options = {}) {
  let response = null
  return {
    ctx: {
      req: {
        method,
        headers: options.headers || {},
      },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db: options.db || {},
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

test('server factory imports with backend foundation routes', () => {
  assert.equal(typeof createScmServer, 'function')
})

test('server route context injects repository registry for repository-compatible routes', () => {
  const source = readSource('server', 'routes', 'scm-legacy.routes.mjs')

  assert.match(source, /import \{[^}]*createRepositoryRegistry[^}]*\} from ["']\.\.\/repositories\/adapter-registry\.mjs["']/)
  assert.match(source, /const repositories = createRepositoryRegistry\(\{ db, env: process\.env \}\)/)
  assert.match(source, /routeContext = \{[\s\S]*repositories,[\s\S]*\}/)
  assert.ok(source.indexOf('const repositories = createRepositoryRegistry') < source.indexOf('const routeContext = {'))
})

test('global server errors are sanitized before returning 500 responses', () => {
  let response = null
  const warnings = []
  const raw = new Error('database exploded with DATABASE_URL=postgres://user:secret@localhost/db and sk-test-secret')

  sendInternalServerError({}, (_res, status, payload) => {
    response = { status, payload }
  }, raw, { logger: { warn(message) { warnings.push(message) } } })

  assert.equal(response.status, 500)
  assert.deepEqual(response.payload, { error: GENERIC_INTERNAL_ERROR })
  assert.doesNotMatch(JSON.stringify(response.payload), /database exploded|DATABASE_URL|postgres:\/\/|sk-test-secret/)
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(warnings[0], /postgres:\/\/|sk-test-secret/)
})

test('server health response omits provider keys models and proxy diagnostics by default', () => {
  const source = readSource('server', 'routes', 'scm-legacy.routes.mjs')
  const healthBlock = source.slice(
    source.search(/url\.pathname === ["']\/api\/health["']/),
    source.search(/if\s*\(\s*req\.method === ["']POST["'] && url\.pathname === ["']\/api\/auth\/login["']/),
  )

  assert.match(healthBlock, /service: ["']flowchain-scm-api["']/)
  assert.match(healthBlock, /\.\.\.buildIdentity/)
  assert.match(healthBlock, /persistenceMode/)
  assert.match(healthBlock, /readsDemoData/)
  assert.match(healthBlock, /authority: ["']postgresql["']/)
  assert.doesNotMatch(healthBlock, /runtimeAdapters|runtimeWriteCoordination/)
  assert.match(healthBlock, /timestamp/)
  assert.match(healthBlock, /dataMode: dataMode\.mode/)
  assert.doesNotMatch(healthBlock, /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|OPENAI_MODEL|ARK_MODEL|DOUBAO_MODEL/)
  assert.doesNotMatch(healthBlock, /DATABASE_URL|POSTGRES_URL|OPENAI|ARK|DOUBAO|openai:|doubao:|(?<![A-Za-z])(?:provider|model|proxy|secret|token|password)\s*:/i)
  assert.match(source, /sendInternalServerError\(res, send, error\)/)
})

test('database mode guard is before legacy auth and forecast writes', () => {
  const source = readSource('server', 'routes', 'scm-legacy.routes.mjs')

  const guardIndex = source.indexOf('isDatabaseModeWriteBlocked({')
  assert.ok(guardIndex < source.search(/url\.pathname === ["']\/api\/auth\/login["']/))
  assert.ok(guardIndex < source.search(/url\.pathname === ["']\/api\/forecast-plans["']/))
  assert.deepEqual(databaseModeMutationBlockedPayload(), {
    error: 'This mutation is not available in database persistence mode yet.',
  })
})

test('database mode blocks legacy writes while allowing health and preview routes', async () => {
  const previous = process.env.FLOWCHAIN_PERSISTENCE_MODE
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.FLOWCHAIN_PERSISTENCE_MODE = 'database'
  process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/flowchain_backend_foundation_test'
  const server = createScmServer()

  try {
    const port = await listen(server)
    const health = await requestJson(port, 'GET', '/api/health')
    const mrp = await requestJson(port, 'GET', '/api/mrp-plan?periods=2')
    const forecastPlan = await requestJson(port, 'POST', '/api/forecast-plans', { sku: 'SKU-DB-GUARD', history: [1, 2, 3, 4, 5, 6] })
    const sopCycle = await requestJson(port, 'POST', '/api/sop-cycle', { cycle: '2026-06' })
    const blocked = await requestJson(port, 'POST', '/api/purchase-requests', { sourceSku: 'SKU-DB-GUARD' })
    const preview = await requestJson(port, 'POST', '/api/action-drafts/preview', { type: 'unsupported_draft', payload: {} })

    assert.equal(health.status, 200)
    assert.equal(health.payload.ok, true)
    assert.equal(health.payload.service, 'flowchain-scm-api')
    assert.equal(health.payload.runtimeMode, 'local-dev')
    assert.equal(health.payload.persistenceMode, 'database')
    assert.equal(health.payload.dataMode, 'user')
    assert.equal(health.payload.readsDemoData, false)
    assert.equal(typeof health.payload.timestamp, 'string')
    assert.equal(health.payload.authority, 'postgresql')
    assert.equal(health.payload.runtimeWriteCoordination, undefined)
    assert.equal(mrp.status, 200)
    assert.equal(mrp.payload.sourceMetadata.persistence, 'read-only-generated-plan')
    assert.equal(forecastPlan.status, 501)
    assert.deepEqual(forecastPlan.payload, databaseModeMutationBlockedPayload())
    assert.equal(sopCycle.status, 501)
    assert.deepEqual(sopCycle.payload, databaseModeMutationBlockedPayload())
    assert.equal(blocked.status, 501)
    assert.deepEqual(blocked.payload, databaseModeMutationBlockedPayload())
    assert.equal(preview.status, 400)
    assert.notDeepEqual(preview.payload, databaseModeMutationBlockedPayload())
  } finally {
    if (previous === undefined) {
      delete process.env.FLOWCHAIN_PERSISTENCE_MODE
    } else {
      process.env.FLOWCHAIN_PERSISTENCE_MODE = previous
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
    await closeServer(server)
  }
})

test('server factory fails before listening when DATABASE_URL is missing', async () => {
  const previousMode = process.env.FLOWCHAIN_PERSISTENCE_MODE
  const previousDatabaseUrl = process.env.DATABASE_URL
  const previousTestHeaders = process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS
  const previousTenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  process.env.FLOWCHAIN_PERSISTENCE_MODE = 'database'
  process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS = 'true'
  process.env.FLOWCHAIN_DEFAULT_TENANT_ID = 'tenant-backend-foundation'
  delete process.env.DATABASE_URL
  try {
    assert.throws(() => createScmServer(), {
      code: 'FLOWCHAIN_DATABASE_URL_REQUIRED',
      message: 'FLOWCHAIN_DATABASE_URL_REQUIRED',
    })
  } finally {
    if (previousMode === undefined) {
      delete process.env.FLOWCHAIN_PERSISTENCE_MODE
    } else {
      process.env.FLOWCHAIN_PERSISTENCE_MODE = previousMode
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }
    if (previousTestHeaders === undefined) {
      delete process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS
    } else {
      process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS = previousTestHeaders
    }
    if (previousTenantId === undefined) {
      delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    } else {
      process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenantId
    }
  }
})

test('safe error summaries redact secrets and stay bounded for logs', () => {
  const summary = sanitizeErrorSummary(new Error('Bearer abc.def.ghi failed with OPENAI_API_KEY=sk-realish and DATABASE_URL=postgres://user:pass@db/app'))

  assert.ok(summary.length <= 240)
  assert.doesNotMatch(summary, /abc\.def\.ghi|sk-realish|postgres:\/\/user:pass/)
  assert.match(summary, /\[redacted\]/)
})

test('GET /api/me returns current user, tenant, and permissions context', async () => {
  const route = createRouteContext('GET', '/api/me')
  const handled = await handleContextRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.user.id, 'user-buyer-001')
  assert.equal(route.response.payload.user.name, 'FlowChain Buyer')
  assert.equal(route.response.payload.user.email, 'buyer@flowchain.local')
  assert.equal(route.response.payload.user.role, 'buyer')
  assert.equal(route.response.payload.tenant.id, 'tenant-flowchain-sme')
  assert.equal(route.response.payload.permissionsContext.role, 'buyer')
  assert.equal(route.response.payload.permissionsContext.alphaBoundary, 'read_preview_draft_save_only_no_final_business_confirmation')
  assert.equal(route.response.payload.permissionsContext.canPrepareDrafts, true)
  assert.equal(route.response.payload.permissionsContext.canReviewActionDrafts, true)
  assert.equal(route.response.payload.permissionsContext.canSaveActionDraftShells, true)
  assert.equal(route.response.payload.permissionsContext.canSubmitDocuments, false)
  assert.equal(route.response.payload.permissionsContext.canSubmitBusinessDocuments, false)
  assert.equal(route.response.payload.permissionsContext.canApproveDocuments, false)
})

test('GET /api/me can reuse existing bearer user context', async () => {
  const route = createRouteContext('GET', '/api/me', {
    headers: { authorization: 'Bearer token-123' },
    db: {
      users: [
        {
          id: 'USR-001',
          token: 'token-123',
          name: 'Alex Buyer',
          email: 'alex@example.com',
          role: 'manager',
          department: 'Procurement',
          locale: 'en-US',
        },
      ],
    },
  })

  const handled = await handleContextRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.user.id, 'USR-001')
  assert.equal(route.response.payload.user.email, 'alex@example.com')
  assert.equal(route.response.payload.permissionsContext.role, 'approver')
  assert.equal(route.response.payload.permissionsContext.canApproveDocuments, true)
  assert.equal(route.response.payload.permissionsContext.canSubmitBusinessDocuments, false)
})

test('GET /api/tenants/current returns minimal tenant context', async () => {
  const route = createRouteContext('GET', '/api/tenants/current')
  const handled = await handleContextRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.id, 'tenant-flowchain-sme')
  assert.equal(route.response.payload.currency, 'USD')
  assert.equal(route.response.payload.settings.allowAiDraftPreparation, true)
  assert.equal(route.response.payload.settings.requireUserReviewForAiDrafts, true)
})

test('GET /api/ai/tools returns controlled AI tool registry', async () => {
  const route = createRouteContext('GET', '/api/ai/tools')
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.tools.length, 43)
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getSupplierStatus'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'resolveSupplierEntity'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getSupplierOperationalSummary'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'compareSupplierOperations'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getPurchaseRequestStatus'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getReceivingExceptions'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getRfqSupplierResponses'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getSalesDemandSummary'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getCustomerDeliveryRisks'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getPurchaseOrderSalesImpact'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getAvailableToPromise'))
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'getReservationPreview'))
  for (const toolName of [
    'resolveEvidenceGraph',
    'getEntityRelatedRecords',
    'traceSalesOrderEvidence',
    'traceSkuSupplyDemandEvidence',
    'tracePurchaseOrderDeliveryImpact',
    'traceSupplierOperationalEvidence',
    'traceReceivingEvidence',
    'traceInvoiceEvidence',
  ]) {
    const tool = route.response.payload.tools.find((item) => item.name === toolName)
    assert.ok(tool, toolName)
    assert.equal(tool.mode, 'read')
    assert.equal(tool.writesBusinessData, false)
    assert.equal(tool.requiresUserReview, false)
    assert.equal(tool.audit.recordInvocation, true)
  }
  assert.ok(route.response.payload.tools.some((tool) => tool.name === 'preparePurchaseRequestDraft'))
  assert.equal(route.response.payload.tools.find((tool) => tool.name === 'getSupplierStatus').mode, 'read')
  assert.equal(route.response.payload.tools.find((tool) => tool.name === 'prepareRfqDraft').requiresUserReview, true)
  assert.equal(route.response.payload.tools.every((tool) => tool.writesBusinessData === false), true)
})

test('AI tool registry returns defensive copies', () => {
  const first = getAiToolRegistry()
  const supplierTool = first.find((tool) => tool.name === 'findSupplier')
  supplierTool.inputSchema.query = 'changed'

  const second = getAiToolRegistry()
  assert.equal(second.find((tool) => tool.name === 'findSupplier').inputSchema.query, 'string')
})

test('audit foundation normalizes and records reusable audit events', () => {
  const now = new Date('2026-06-24T10:30:00.000Z')
  const normalized = normalizeAuditEvent({
    id: 'AUD-TEST-001',
    source: 'ai_assisted',
    module: 'ai',
    action: 'ai_tool_invoked',
    entity: { type: 'ai_tool', id: 'getSupplierStatus' },
    summary: 'AI tool invocation recorded.',
    metadata: { confidence: 'high' },
  }, { now })

  assert.equal(normalized.id, 'AUD-TEST-001')
  assert.equal(normalized.tenantId, 'tenant-flowchain-sme')
  assert.equal(normalized.timestamp, '2026-06-24T10:30:00.000Z')
  assert.equal(normalized.source, 'ai_assisted')
  assert.equal(normalized.entity.type, 'ai_tool')
  assert.deepEqual(normalized.before, null)

  const db = {}
  const recorded = recordAuditEvent(db, normalized, { now })
  assert.equal(recorded.id, 'AUD-TEST-001')
  assert.equal(listAuditEvents(db).length, 1)
})
