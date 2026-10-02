import { expect, test, type APIRequestContext } from '@playwright/test'

// The workspace administrator seeded by scripts/browser-product-recovery-api.mjs.
async function signedAdmin(request: APIRequestContext) {
  const response = await request.post('/api/auth/login', {
    data: { company: 'FlowChain', name: 'Initial Admin', email: 'admin@flowchain.local' },
  })
  expect(response.status()).toBe(200)
  return (await response.json()).token as string
}

test('settings mutations reject anonymous callers and record the signed-in actor, not a forged one', async ({ request }) => {
  const headers = { authorization: `Bearer ${await signedAdmin(request)}` }
  expect((await request.get('/api/settings-runtime')).status()).toBe(401)
  const settingsResponse = await request.get('/api/settings-runtime', { headers })
  expect(settingsResponse.status()).toBe(200)
  const settings = await settingsResponse.json()
  // An unchanged numbering section: the write is audited even when nothing changes.
  const body = { settings: settings.numbering, actor: { id: 'forged-user', name: 'Forged Admin', role: 'admin' } }

  expect((await request.patch('/api/settings-runtime/numbering', { data: body })).status()).toBe(401)
  expect((await request.patch('/api/settings-runtime/numbering', { headers: { 'x-flowchain-role': 'admin', 'x-flowchain-user': 'forged-user' }, data: body })).status()).toBe(401)
  expect((await request.patch('/api/settings-runtime/numbering', { headers, data: body })).status()).toBe(200)

  const audit = await request.get('/api/audit-log?limit=50', { headers })
  expect(audit.status()).toBe(200)
  const payload = await audit.json()
  const entries: Array<{ action?: string; actor?: { id?: string; name?: string } }> = Array.isArray(payload) ? payload : payload.entries ?? payload.items ?? []
  const settingsAudit = entries.find((entry) => entry.action === 'numbering_settings_updated')
  expect(settingsAudit?.actor?.name).toBe('Initial Admin')
  expect(JSON.stringify(settingsAudit)).not.toContain('forged-user')
  expect(JSON.stringify(settingsAudit)).not.toContain('Forged Admin')
})
