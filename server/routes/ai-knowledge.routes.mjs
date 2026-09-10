import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { createKnowledgeService, answerKnowledgeQuery, knowledgeResponse, KnowledgeError } from '../domain/ai-knowledge-service.mjs'
import { parseKnowledgeFile } from '../domain/ai-knowledge-file-parser.mjs'

async function context(ctx) {
  const prisma = ctx.aiKnowledgePrisma || await getPrismaClient(ctx.env || process.env)
  const actor = await resolveProvisionedActor(prisma, ctx.identity)
  return { actor, service: createKnowledgeService(prisma, { env: ctx.env || process.env }) }
}

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
      const body = await ctx.readBody(ctx.req)
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
  return body.queryMode === 'knowledge' || /knowledge base|product (?:spec|manual|information|guide)|company (?:policy|handbook)|according to.*(?:document|manual)|cite.*source|procedure.*follow|知识库|产品资料|产品规格|公司制度|操作手册|引用.*来源|根据.*资料/i.test(body.message || '')
}

export async function runKnowledgeQuery(ctx, body = {}) {
  if (!isKnowledgeQuestion(body)) return null
  if (ctx.repositories?.mode !== 'database' && (ctx.env || process.env).FLOWCHAIN_PERSISTENCE_MODE !== 'database') throw new KnowledgeError('KNOWLEDGE_UNAVAILABLE', 'Knowledge requires database storage.', 503)
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1200) throw new KnowledgeError('KNOWLEDGE_QUERY_INVALID', 'Enter a question of 1–1200 characters.', 400)
  const { actor, service } = await context(ctx)
  const result = await answerKnowledgeQuery({ question: body.message, language: body.answerLanguage, actor, service, env: ctx.env || process.env })
  return knowledgeResponse(result, body.message, body.answerLanguage)
}
