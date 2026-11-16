import test from 'node:test'
import assert from 'node:assert/strict'
import { handleKnowledgeRoute, runKnowledgeQuery } from './ai-knowledge.routes.mjs'
import { handleAiRuntimeGatewayRoute } from './ai-runtime-gateway.routes.mjs'

test('knowledge source access requires an authenticated identity', async () => {
  let response
  await handleKnowledgeRoute({ url: new URL('http://local/api/ai-runtime/knowledge'), req: { method: 'GET' }, aiKnowledgePrisma: {}, identity: {}, send: (_, status, body) => { response = { status, body } } })
  assert.equal(response.status, 401)
  assert.equal(response.body.code, 'AUTHENTICATION_REQUIRED')
})

// Design audit L10-04: who may import a file, and how often, is checked before
// the upload is read or parsed. A member without settings.workspace.manage is
// refused without the body being read; an administrator over the import limit
// is refused the same way.
test('knowledge import checks the administrator permission and the import limit before reading the file', async () => {
  const userWith = (permissionCodes) => ({
    id: 'user-1', tenantId: 'tenant-k', role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'), warehouseScopes: [],
    roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'role', name: 'Role', status: 'active', permissions: permissionCodes.map((permissionCode) => ({ permissionCode })) } }],
  })
  const importAs = async (permissionCodes, limiter) => {
    let response, read = 0
    await handleKnowledgeRoute({
      url: new URL('http://local/api/ai-runtime/knowledge/import'), req: { method: 'POST' },
      identity: { authenticated: true, tenantId: 'tenant-k', userId: 'user-1', role: 'manager' },
      aiKnowledgePrisma: { user: { findFirst: async () => userWith(permissionCodes) } },
      knowledgeImportLimiter: limiter,
      readBody: async () => { read += 1; return { fileName: 'bomb.docx', contentBase64: 'UEsDBA==' } },
      send: (_, status, body) => { response = { status, body } },
    })
    return { ...response, read }
  }
  const allowAll = { allow: () => true }
  const member = await importAs(['procurement.purchase_order.read'], allowAll)
  assert.deepEqual([member.status, member.body.code, member.read], [403, 'KNOWLEDGE_MANAGE_DENIED', 0])
  const keys = []
  const limited = await importAs(['settings.workspace.manage'], { allow: (key) => (keys.push(key), false) })
  assert.deepEqual([limited.status, limited.body.code, limited.read], [429, 'KNOWLEDGE_IMPORT_RATE_LIMITED', 0])
  assert.deepEqual(keys, ['tenant-k:user-1'])
  // An administrator within the limit gets the upload read and checked.
  const admin = await importAs(['settings.workspace.manage'], allowAll)
  assert.equal(admin.read, 1)
  assert.equal(admin.body.code, 'KNOWLEDGE_FILE_PARSE_FAILED')
})
