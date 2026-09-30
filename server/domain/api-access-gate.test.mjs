import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { apiAccessDenial } from '../bootstrap/api-access-gate.mjs'
import { createScmServer } from '../bootstrap/scm-server.mjs'

const signedIn = { authenticated: true, source: 'local_signed_session', tenantId: 'tenant-gate' }

test('the gate lets only sessions bound to a workspace reach tenant APIs', () => {
  assert.equal(apiAccessDenial({ method: 'GET', pathname: '/app/procurement/orders', identity: { authenticated: false } }), null)
  assert.equal(apiAccessDenial({ method: 'POST', pathname: '/api/workspace/invitations/accept', identity: { authenticated: false } }), null)
  assert.equal(apiAccessDenial({ method: 'GET', pathname: '/api/purchase-orders', identity: signedIn }), null)

  const anonymous = apiAccessDenial({ method: 'GET', pathname: '/api/purchase-orders', identity: { authenticated: false, source: 'anonymous' } })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.body.code, 'AUTHENTICATION_REQUIRED')
  const expired = apiAccessDenial({ method: 'GET', pathname: '/api/purchase-orders', identity: { authenticated: false, source: 'invalid_session' } })
  assert.equal(expired.status, 401)
  assert.equal(expired.body.code, 'INVALID_SESSION')
  const noTenant = apiAccessDenial({ method: 'GET', pathname: '/api/purchase-orders', identity: { ...signedIn, tenantId: ' ' } })
  assert.equal(noTenant.status, 403)
  assert.equal(noTenant.body.code, 'TENANT_CONTEXT_REQUIRED')
  // Only the exact method and path are public.
  assert.equal(apiAccessDenial({ method: 'GET', pathname: '/api/workspace/invitations/accept', identity: { authenticated: false } }).status, 401)
})

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function request(port, method, pathname, { body, headers = {} } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = text
        try { payload = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: response.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

async function withServer(patch, run) {
  const keys = ['DATABASE_URL', 'FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS', 'FLOWCHAIN_DEFAULT_TENANT_ID']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/flowchain_api_access_gate'
  for (const key of keys.slice(1)) delete process.env[key]
  Object.assign(process.env, patch)
  const server = createScmServer()
  try {
    return await run(await listen(server))
  } finally {
    await new Promise(resolve => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('business, settings and AI endpoints refuse anonymous requests on the real server', async () => {
  await withServer({}, async port => {
    const closed = [
      ['GET', '/api/purchase-orders'],
      ['GET', '/api/purchase-requests'],
      ['GET', '/api/inventory'],
      ['GET', '/api/reports-analytics'],
      ['GET', '/api/settings-runtime'],
      ['GET', '/api/capabilities'],
      ['GET', '/api/authorization/context'],
      ['GET', '/api/search?q=PO'],
      ['GET', '/api/review-first-action-workflow'],
      ['GET', '/api/data-access-quality'],
      ['GET', '/api/ai-runtime/readiness'],
      ['POST', '/api/ai-runtime/respond'],
      ['POST', '/api/ai/chat'],
      ['POST', '/api/action-drafts/preview'],
      ['GET', '/api/master-data/items'],
      ['GET', '/api/workspace'],
    ]
    for (const [method, pathname] of closed) {
      const response = await request(port, method, pathname, method === 'POST' ? { body: { message: 'open purchase orders' } } : {})
      assert.equal(response.status, 401, `${method} ${pathname}`)
      assert.equal(response.payload.code, 'AUTHENTICATION_REQUIRED', `${method} ${pathname}`)
    }
    const expired = await request(port, 'GET', '/api/purchase-orders', { headers: { Authorization: 'Bearer not-a-session' } })
    assert.equal(expired.status, 401)
    assert.equal(expired.payload.code, 'INVALID_SESSION')

    assert.equal((await request(port, 'GET', '/api/health')).status, 200)
    // Outside local development and tests the email-only sign-in does not
    // exist; email-link confirm is reachable before sign-in.
    const login = await request(port, 'POST', '/api/auth/login', { body: {} })
    assert.equal(login.status, 404)
    const confirm = await request(port, 'POST', '/api/auth/email-link/confirm', { body: {} })
    assert.equal(confirm.status, 400)
    assert.equal(confirm.payload.code, 'SIGN_IN_LINK_INVALID')
    const accept = await request(port, 'POST', '/api/workspace/invitations/accept', { body: {} })
    assert.notEqual(accept.status, 401)
  })
})

test('a signed-in identity without a workspace tenant is refused before any route runs', async () => {
  await withServer({ FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: 'true' }, async port => {
    const response = await request(port, 'GET', '/api/purchase-orders', { headers: { 'x-flowchain-user': 'gate-user', 'x-flowchain-role': 'manager' } })
    assert.equal(response.status, 403)
    assert.equal(response.payload.code, 'TENANT_CONTEXT_REQUIRED')
  })
})

test('a signed-in identity with a tenant passes the gate and still gets a 404 for unknown APIs', async () => {
  await withServer({ FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: 'true', FLOWCHAIN_DEFAULT_TENANT_ID: 'tenant-gate' }, async port => {
    const response = await request(port, 'GET', '/api/not-a-route', { headers: { 'x-flowchain-user': 'gate-user', 'x-flowchain-role': 'manager' } })
    assert.equal(response.status, 404)
    assert.deepEqual(response.payload, { error: 'Not found' })
  })
})
