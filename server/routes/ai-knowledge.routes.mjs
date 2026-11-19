import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { createKnowledgeService, answerKnowledgeQuery, canManageKnowledge, knowledgeResponse, KnowledgeError } from '../domain/ai-knowledge-service.mjs'
import { createAssistantV2RateLimiter } from '../domain/ai-assistant-v2-controls.mjs'
import { KNOWLEDGE_FILE_LIMITS, parseKnowledgeFile } from '../domain/ai-knowledge-file-parser.mjs'
import { classifyQueryScope } from '../domain/ai-query-scope.mjs'
import { knowledgeProviderEnv } from '../domain/ai-knowledge-config.mjs'
import { bodyLimitForFile } from '../utils/http.mjs'

async function context(ctx) {
  const prisma = ctx.aiKnowledgePrisma || await getPrismaClient(ctx.env || process.env)
  const actor = await resolveProvisionedActor(prisma, ctx.identity)
  const env = knowledgeProviderEnv(ctx.env || process.env)
  return { actor, env, service: createKnowledgeService(prisma, { env }) }
}

// File imports per user in a sliding window, in this process's memory, with
// the same limiter the assistant uses for questions.
export const KNOWLEDGE_IMPORT_RATE_LIMIT = Object.freeze({ questions: 20, windowMs: 10 * 60 * 1000 })
const knowledgeImportLimiter = createAssistantV2RateLimiter({ limits: KNOWLEDGE_IMPORT_RATE_LIMIT })

export async function handleKnowledgeRoute(ctx) {
  const prefix = '/api/ai-runtime/knowledge'
  if (ctx.url.pathname !== prefix && !ctx.url.pathname.startsWith(`${prefix}/`)) return false
  try {
    const { actor, service } = await context(ctx)
    const suffix = ctx.url.pathname.startsWith(`${prefix}/`) ? ctx.url.pathname.slice(prefix.length + 1) : ''
    const reindex = suffix.endsWith('/reindex')
    const importing = suffix === 'import'
    const id = suffix && !importing ? decodeURIComponent(reindex ? suffix.slice(0, -8) : suffix) : null
    let result
    if (ctx.req.method === 'GET' && !importing) result = id ? await service.get(actor, id) : await service.list(actor)
    else if (ctx.req.method === 'POST' && reindex && id) result = await service.reindex(actor, id)
    else if (ctx.req.method === 'POST' && importing) {
      // Who may import, and how often, is checked before the upload is read
      // or parsed (design audit L10-04).
      if (!canManageKnowledge(actor)) throw new KnowledgeError('KNOWLEDGE_MANAGE_DENIED', 'Workspace administrator access is required.', 403)
      if (!(ctx.knowledgeImportLimiter || knowledgeImportLimiter).allow(`${actor.tenantId}:${actor.user?.id || actor.userId}`)) throw new KnowledgeError('KNOWLEDGE_IMPORT_RATE_LIMITED', 'Too many files were imported in the last 10 minutes. Try again later.', 429)
      const body = await ctx.readBody(ctx.req, { maxBytes: bodyLimitForFile(KNOWLEDGE_FILE_LIMITS.maximumBytes) })
      const extracted = await parseKnowledgeFile(body)
      result = await service.add(actor, { ...body, title: extracted.title, content: extracted.content })
    }
    else if (ctx.req.method === 'POST' && !id) result = await service.add(actor, await ctx.readBody(ctx.req))
    else if (ctx.req.method === 'DELETE' && id) result = await service.archive(actor, id)
    else { ctx.send(ctx.res, 405, { error: 'Method not allowed.' }); return true }
    ctx.send(ctx.res, ctx.req.method === 'POST' && (!id || importing) ? 201 : 200, result)
  } catch (error) {
    ctx.send(ctx.res, error.status || 500, { code: error.code || 'KNOWLEDGE_UNAVAILABLE', error: error.status ? error.message : 'Knowledge service unavailable.' })
  }
  return true
}

export function isKnowledgeQuestion(body = {}) {
  return classifyQueryScope(body) === 'knowledge'
}

// Knowledge search for agent planning (docs/ai-assistant-plan.md, PR-3): null
// without database storage or without a document the actor may read;
// otherwise the languages of those documents, which the planner writes its
// search words in, and a search with those words. The search shows the
// passages found, with their sources, and asks no model to write an answer.
export async function aiAgentKnowledge(ctx) {
  if (ctx.repositories?.mode !== 'database' && (ctx.env || process.env).FLOWCHAIN_PERSISTENCE_MODE !== 'database') return null
  const { actor, service, env } = await context(ctx)
  const documents = (await service.list(actor)).items || []
  if (!documents.length) return null
  return {
    languages: [...new Set(documents.map((document) => document.language === 'zh-CN' ? 'zh-CN' : 'en-US'))].sort(),
    async search({ query, question, language }) {
      const result = await answerKnowledgeQuery({ question, retrievalQuery: query, generate: false, language, actor, service, env })
      return knowledgeResponse(result, question, language)
    },
  }
}

export async function runKnowledgeQuery(ctx, body = {}, { force = false } = {}) {
  if (!force && !isKnowledgeQuestion(body)) return null
  if (ctx.repositories?.mode !== 'database' && (ctx.env || process.env).FLOWCHAIN_PERSISTENCE_MODE !== 'database') throw new KnowledgeError('KNOWLEDGE_UNAVAILABLE', 'Knowledge requires database storage.', 503)
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1200) throw new KnowledgeError('KNOWLEDGE_QUERY_INVALID', 'Enter a question of 1–1200 characters.', 400)
  const { actor, service, env } = await context(ctx)
  const result = await answerKnowledgeQuery({ question: body.message, language: body.answerLanguage, actor, service, env })
  return knowledgeResponse(result, body.message, body.answerLanguage)
}
