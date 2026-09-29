import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document } from '@langchain/core/documents'
import { loadEnv } from '../server/config/env.mjs'
import { knowledgeProviderEnv } from '../server/domain/ai-knowledge-config.mjs'
import { callConfiguredEmbeddingProvider, canCallEmbeddingProvider } from '../server/domain/ai-embedding-provider.mjs'
import { callConfiguredProvider, canCallConfiguredProvider } from '../server/domain/ai-runtime-provider-adapter-v2.mjs'
import { answerKnowledgeQuery } from '../server/domain/ai-knowledge-service.mjs'

// Uses one synthetic passage, never customer documents or the business database.
export async function checkKnowledgeConnection(rawEnv, { embeddingProvider = callConfiguredEmbeddingProvider, provider = callConfiguredProvider } = {}) {
  const env = knowledgeProviderEnv(rawEnv)
  if (!canCallEmbeddingProvider(env) || !canCallConfiguredProvider(env)) return { ok: false, stage: 'configuration', reason: 'missing_credentials_or_configuration' }
  const passage = 'Connection test: The Orion calibration module has a warranty of 18 months.'
  const embedded = await embeddingProvider([passage], env)
  if (!embedded.ok) return { ok: false, stage: 'embedding', reason: embedded.reason }
  const document = new Document({ pageContent: passage, metadata: { id: 'connection-passage', documentId: 'connection-document', title: 'Connection test', position: 0, embedding: embedded.vectors[0], embeddingModel: embedded.model } })
  const result = await answerKnowledgeQuery({ question: 'How long is the Orion calibration module warranty?', language: 'en-US', actor: {}, service: { documents: async () => [document] }, env, embeddingProvider, provider })
  if (result.mode !== 'generated') return { ok: false, stage: 'generation', reason: result.mode }
  const grounded = /18|eighteen/i.test(result.answer) && result.citations.some(c => c.id === 'connection-passage')
  return { ok: grounded, stage: 'complete', embeddingModel: embedded.model, dimensions: embedded.dimensions, answerModel: env.FLOWCHAIN_AI_PROVIDER_MODEL, citedPassages: result.citations.length, ...(grounded ? {} : { reason: 'grounding_check_failed' }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..')
  // Only this explicit local check loads the ignored local credential file.
  const previous = process.env.FLOWCHAIN_DEV_LOCAL
  process.env.FLOWCHAIN_DEV_LOCAL = 'true'
  await loadEnv(root)
  if (previous === undefined) delete process.env.FLOWCHAIN_DEV_LOCAL
  else process.env.FLOWCHAIN_DEV_LOCAL = previous
  try {
    const result = await checkKnowledgeConnection(process.env)
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 2
  } catch { console.error('Knowledge connection check failed. No credentials or provider output were logged.'); process.exitCode = 1 }
}
