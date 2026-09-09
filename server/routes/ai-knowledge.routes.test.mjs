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
test('invalid knowledge requests cannot fall through to business answers', async () => {
  await assert.rejects(runKnowledgeQuery({ env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' } }, { queryMode: 'knowledge', message: '' }), { status: 400 })
  let response
  await handleAiRuntimeGatewayRoute({ url: new URL('http://local/api/ai-runtime/respond'), req: { method: 'POST' }, env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' }, readBody: async () => ({ queryMode: 'knowledge', message: '' }), send: (_, status, body) => { response = { status, body } } })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'KNOWLEDGE_QUERY_INVALID')
})
