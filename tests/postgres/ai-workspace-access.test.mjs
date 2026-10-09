import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// The workspace AI switch and spend cap against PostgreSQL: the setting is
// saved and audited by an administrator only, the status reads it, and the
// monthly usage row counts calls atomically.
const tenantId = 'tenant-ai-workspace-access'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient, disconnectPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createScmServer } = await import('../../server/bootstrap/scm-server.mjs')
const { readAiWorkspaceAccess } = await import('../../server/domain/ai-workspace-access.mjs')
const { aiUsageMonth, aiUsageRecorder } = await import('../../server/domain/ai-usage-meter.mjs')

const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId }
// Placeholder provider settings: nothing here calls a provider.
const providerEnv = {
  ...env,
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'anthropic_chat', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/v1/chat/completions',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder', FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-haiku-4-5', FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required', FLOWCHAIN_AI_MONTHLY_CAP_USD: '0.01',
}

async function request(port, method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = text
        try { payload = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: res.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

test('an administrator switches AI on, the status reads it, and usage is counted against the cap', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  let server
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'AI Access Tenant', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', defaultLanguage: 'en-US' } })
    for (const [key, role] of Object.entries({ admin: 'admin', manager: 'manager' })) await prisma.user.create({ data: { id: `${tenantId}-${key}`, tenantId, email: `${key}-ai-access@example.com`, name: `AI ${key}`, role } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })

    // Off by default, and a server without a provider reports none.
    assert.equal((await readAiWorkspaceAccess({ prisma, tenantId, env: providerEnv })).status, 'off')
    assert.equal((await readAiWorkspaceAccess({ prisma, tenantId, env })).status, 'no_provider')

    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const login = async (email) => (await request(port, 'POST', '/api/auth/login', { body: { email, name: 'AI', company: 'AI Access Tenant' } })).payload.token
    const admin = { Authorization: `Bearer ${await login('admin-ai-access@example.com')}` }
    const manager = { Authorization: `Bearer ${await login('manager-ai-access@example.com')}` }

    const current = (await request(port, 'GET', '/api/settings-runtime', { headers: admin })).payload.ai
    assert.equal(current.modelAssistEnabled, false)
    // Only a workspace administrator may switch it.
    assert.equal((await request(port, 'PATCH', '/api/settings-runtime/ai', { headers: manager, body: { settings: { ...current, modelAssistEnabled: true } } })).status, 403)
    assert.equal((await request(port, 'PATCH', '/api/settings-runtime/ai', { headers: admin, body: { settings: { ...current, modelAssistEnabled: 'yes' } } })).status, 400)
    const saved = await request(port, 'PATCH', '/api/settings-runtime/ai', { headers: admin, body: { settings: { ...current, modelAssistEnabled: true } } })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.equal(saved.payload.settings.modelAssistEnabled, true)
    const audit = await prisma.auditLog.findFirst({ where: { tenantId, action: 'ai_settings_updated' } })
    assert.deepEqual([audit.metadata.before.modelAssistEnabled, audit.metadata.after.modelAssistEnabled], [false, true])

    // The status route reports it; this server has no provider configured.
    const status = await request(port, 'GET', '/api/settings-runtime/ai-status', { headers: admin })
    assert.equal(status.status, 200)
    assert.deepEqual([status.payload.status, status.payload.enabled, status.payload.calls], ['no_provider', true, 0])

    // With a provider and a one-cent cap: on, then over the cap after two calls.
    assert.equal((await readAiWorkspaceAccess({ prisma, tenantId, env: providerEnv })).status, 'on')
    const record = aiUsageRecorder({ prisma, tenantId, env: providerEnv })
    await Promise.all([record({ inputTokens: 2300, outputTokens: 50 }), record({ inputTokens: 8000, outputTokens: 400 })])
    const row = await prisma.aiUsageMonthly.findUnique({ where: { tenantId_month: { tenantId, month: aiUsageMonth() } } })
    assert.deepEqual([row.calls, row.inputUnits, row.outputUnits, row.costMicros], [2, 10300, 450, 12550])
    const over = await readAiWorkspaceAccess({ prisma, tenantId, env: providerEnv })
    assert.deepEqual([over.status, over.costUsd, over.capUsd], ['over_cap', 0.01255, 0.01])
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
