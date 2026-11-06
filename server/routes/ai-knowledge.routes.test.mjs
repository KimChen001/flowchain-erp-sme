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
