import { createHash, randomUUID } from 'node:crypto'
import { Document } from '@langchain/core/documents'
import { BaseRetriever } from '@langchain/core/retrievers'
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { canCallConfiguredProvider, callConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { callConfiguredEmbeddingProvider, cosineSimilarity, embeddingConfig, canCallEmbeddingProvider, validEmbedding } from './ai-embedding-provider.mjs'
import { hasPgvectorKnowledgeStore, persistPgvectorEmbeddings, pgvectorKnowledgeRanks } from './ai-pgvector-store.mjs'

export const KNOWLEDGE_AUDIENCES = Object.freeze([null, 'finance.payable.read', 'procurement.purchase_order.read'])
export class KnowledgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new KnowledgeError(code, message, status) }
const readable = actor => ({ tenantId: actor.tenantId, status: 'active', OR: [{ requiredPermission: null }, { requiredPermission: { in: [...(actor.permissionCodes || [])] } }] })
const manageable = actor => Boolean(actor.permissionCodes?.has('settings.workspace.manage'))
const docSelect = { id: true, title: true, language: true, requiredPermission: true, createdAt: true, indexAttemptStatus: true, indexAttemptError: true, indexAttemptStartedAt: true, indexAttemptFinishedAt: true, _count: { select: { chunks: true } } }
const hash = value => createHash('sha256').update(value).digest('hex')
const leaseCutoff = () => new Date(Date.now() - 15 * 60 * 1000)

export function knowledgeIndexSummary(chunks, config = {}) {
  const valid = chunks.filter(chunk => chunk.embeddingModel && validEmbedding(chunk.embedding, chunk.embeddingDimensions))
  const compatible = valid.filter(chunk => (!config.model || chunk.embeddingModel === config.model) && (!config.dimensions || chunk.embeddingDimensions === config.dimensions))
  const uniform = new Set(compatible.map(chunk => `${chunk.embeddingModel}:${chunk.embeddingDimensions}`)).size <= 1
  return { indexStatus: !valid.length ? 'keyword' : compatible.length === chunks.length && uniform ? 'semantic' : compatible.length ? 'partial' : 'outdated', indexedChunks: compatible.length, embeddingModel: valid[0]?.embeddingModel || null, embeddingDimensions: valid[0]?.embeddingDimensions || null }
}

export function createKnowledgeService(prisma, { env = process.env, embeddingProvider = callConfiguredEmbeddingProvider } = {}) {
  const service = {
    async list(actor) {
      const rows = await prisma.aiKnowledgeDocument.findMany({ where: readable(actor), select: { ...docSelect, chunks: { select: { embedding: true, embeddingModel: true, embeddingDimensions: true } } }, orderBy: { createdAt: 'desc' }, take: 100 })
      const pgvector = await hasPgvectorKnowledgeStore(prisma)
      return { canManage: manageable(actor), capabilities: { embeddingConfigured: canCallEmbeddingProvider(env), vectorStorage: pgvector ? 'pgvector' : 'local_vectors', model: embeddingConfig(env).model || null, dimensions: embeddingConfig(env).dimensions || null }, items: rows.map(({ chunks, ...document }) => {
        const interrupted = document.indexAttemptStatus === 'processing' && new Date(document.indexAttemptStartedAt) < leaseCutoff()
        return { ...document, ...knowledgeIndexSummary(chunks, embeddingConfig(env)), ...(interrupted ? { indexAttemptStatus: 'failed', indexAttemptError: 'interrupted' } : {}) }
      }) }
    },
    async add(actor, body) {
      if (!manageable(actor)) fail('KNOWLEDGE_MANAGE_DENIED', 'Workspace administrator access is required.', 403)
      if (!body || typeof body !== 'object' || typeof body.title !== 'string' || typeof body.content !== 'string') fail('KNOWLEDGE_INVALID_INPUT', 'Provide a title and plain-text content.')
      const title = body.title.trim(), content = body.content.trim()
      if (!title || title.length > 160 || content.length < 20 || content.length > 100000) fail('KNOWLEDGE_INVALID_SIZE', 'Use a title up to 160 characters and content between 20 and 100,000 characters.')
      const requiredPermission = body.requiredPermission || null
      if (!KNOWLEDGE_AUDIENCES.includes(requiredPermission)) fail('KNOWLEDGE_INVALID_AUDIENCE', 'Choose a supported reader group.')
      if (requiredPermission && !actor.permissionCodes?.has(requiredPermission)) fail('KNOWLEDGE_AUDIENCE_DENIED', 'You must belong to the selected reader group.', 403)
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 120, separators: ['\n\n', '\n', '。', '. ', ' ', ''] })
      const chunks = await splitter.splitText(content)
      const documentId = randomUUID()
      const chunkRows = chunks.map((content, position) => ({ id: randomUUID(), position, content, contentHash: hash(content) }))
      const document = await prisma.aiKnowledgeDocument.create({ data: { id: documentId, tenantId: actor.tenantId, title, language: body.language === 'zh-CN' ? 'zh-CN' : 'en-US', requiredPermission, createdById: actor.user?.id || actor.userId, chunks: { create: chunkRows } }, select: docSelect })
      // Save readable text first. An unavailable provider must not lose the imported document.
      try { return { ...document, ...await service.reindex(actor, documentId) } }
      catch (error) { if (error instanceof KnowledgeError) return { ...document, indexStatus: 'keyword', indexAttemptStatus: 'failed', indexAttemptError: error.code }; throw error }
    },
    async get(actor, id) {
      const document = await prisma.aiKnowledgeDocument.findFirst({ where: { ...readable(actor), id }, include: { chunks: { orderBy: { position: 'asc' } } } })
      if (!document) fail('KNOWLEDGE_NOT_FOUND', 'Document not found or no longer accessible.', 404)
      return { id: document.id, title: document.title, language: document.language, createdAt: document.createdAt, chunks: document.chunks.map(({ id, position, content }) => ({ id, position, content })) }
    },
    async archive(actor, id) {
      if (!manageable(actor)) fail('KNOWLEDGE_MANAGE_DENIED', 'Workspace administrator access is required.', 403)
      const result = await prisma.aiKnowledgeDocument.updateMany({ where: { ...readable(actor), id }, data: { status: 'archived' } })
      if (!result.count) fail('KNOWLEDGE_NOT_FOUND', 'Document not found or no longer accessible.', 404)
      return { archived: true }
    },
    async reindex(actor, id) {
      if (!manageable(actor)) fail('KNOWLEDGE_MANAGE_DENIED', 'Workspace administrator access is required.', 403)
      const attemptId = randomUUID()
      const claim = await prisma.aiKnowledgeDocument.updateMany({ where: { AND: [{ ...readable(actor), id }, { OR: [{ indexAttemptStatus: { not: 'processing' } }, { indexAttemptStartedAt: { lt: leaseCutoff() } }] }] }, data: { indexAttemptStatus: 'processing', indexAttemptId: attemptId, indexAttemptError: null, indexAttemptStartedAt: new Date(), indexAttemptFinishedAt: null } })
      if (!claim.count) {
        if (!await prisma.aiKnowledgeDocument.findFirst({ where: { ...readable(actor), id }, select: { id: true } })) fail('KNOWLEDGE_NOT_FOUND', 'Document not found or no longer accessible.', 404)
        fail('KNOWLEDGE_INDEX_BUSY', 'This document is already being indexed. Refresh to check progress.', 409)
      }
      try {
        const document = await prisma.aiKnowledgeDocument.findFirst({ where: { ...readable(actor), id }, include: { chunks: { orderBy: { position: 'asc' } } } })
        if (!document) fail('KNOWLEDGE_NOT_FOUND', 'Document not found or no longer accessible.', 404)
        const config = embeddingConfig(env)
        const cached = new Map(document.chunks.filter(chunk => config.model && config.dimensions && chunk.embeddingModel === config.model && chunk.contentHash === hash(chunk.content) && validEmbedding(chunk.embedding, config.dimensions)).map(chunk => [chunk.contentHash, chunk.embedding]))
        const missing = [...new Map(document.chunks.filter(chunk => !cached.has(hash(chunk.content))).map(chunk => [hash(chunk.content), chunk.content])).entries()]
        const generated = missing.length ? await embeddingProvider(missing.map(([, content]) => content), env) : { ok: true, model: config.model, dimensions: config.dimensions, vectors: [] }
        if (!generated.ok) fail(generated.reason === 'not_configured' ? 'KNOWLEDGE_EMBEDDING_NOT_CONFIGURED' : 'KNOWLEDGE_EMBEDDING_UNAVAILABLE', generated.reason === 'not_configured' ? 'Embedding is not configured. Documents remain available for keyword search.' : 'Embedding service is unavailable. The existing index was kept.', 503)
        if (!generated.model || (config.model && generated.model !== config.model) || (config.dimensions && generated.dimensions !== config.dimensions) || !Array.isArray(generated.vectors) || generated.vectors.length !== missing.length || generated.vectors.some(vector => !validEmbedding(vector, generated.dimensions))) fail('KNOWLEDGE_EMBEDDING_INVALID', 'The embedding response failed validation. The existing index was kept.', 503)
        missing.forEach(([key], index) => cached.set(key, generated.vectors[index]))
        const embedded = { ...generated, vectors: document.chunks.map(chunk => cached.get(hash(chunk.content))) }
        const indexedAt = new Date()
        await prisma.$transaction(async tx => {
          const owned = await tx.aiKnowledgeDocument.updateMany({ where: { ...readable(actor), id, indexAttemptId: attemptId }, data: { indexAttemptStatus: 'ready', indexAttemptError: null, indexAttemptFinishedAt: indexedAt } })
          if (!owned.count) fail('KNOWLEDGE_INDEX_SUPERSEDED', 'Indexing was cancelled or replaced. Refresh the library.', 409)
          for (let position = 0; position < document.chunks.length; position += 1) {
            const chunk = document.chunks[position]
            await tx.aiKnowledgeChunk.update({ where: { id: chunk.id }, data: { contentHash: hash(chunk.content), embedding: embedded.vectors[position], embeddingModel: embedded.model, embeddingDimensions: embedded.dimensions, embeddedAt: indexedAt } })
          }
          await persistPgvectorEmbeddings(tx, document.chunks, embedded, { strict: true })
        }, { timeout: 30000 })
        return { id, indexStatus: 'semantic', indexAttemptStatus: 'ready', embeddingModel: embedded.model, embeddingDimensions: embedded.dimensions, chunkCount: document.chunks.length, reusedChunks: document.chunks.length - missing.length, indexedAt }
      } catch (error) {
        await prisma.aiKnowledgeDocument.updateMany({ where: { id, tenantId: actor.tenantId, indexAttemptId: attemptId }, data: { indexAttemptStatus: 'failed', indexAttemptError: error instanceof KnowledgeError ? error.code : 'KNOWLEDGE_INDEX_WRITE_FAILED', indexAttemptFinishedAt: new Date() } })
        if (error instanceof KnowledgeError) throw error
        fail('KNOWLEDGE_INDEX_WRITE_FAILED', 'The index could not be saved. The previous index was kept. Retry indexing.', 503)
      }
    },
    async documents(actor) {
      const chunks = await prisma.aiKnowledgeChunk.findMany({ where: { document: readable(actor) }, include: { document: { select: { id: true, title: true, language: true, createdAt: true } } }, orderBy: [{ documentId: 'asc' }, { position: 'asc' }], take: 2001 })
      if (chunks.length > 2000) fail('KNOWLEDGE_INDEX_LIMIT', 'The local index exceeds 2,000 chunks. Archive older documents before searching.', 409)
      return chunks.map(row => new Document({ pageContent: row.content, metadata: { id: row.id, documentId: row.documentId, title: row.document.title, position: row.position, language: row.document.language, contentHash: row.contentHash, embedding: row.embedding, embeddingModel: row.embeddingModel, embeddingDimensions: row.embeddingDimensions } }))
    },
    semanticRanks(actor, queryVector, model) { return pgvectorKnowledgeRanks(prisma, actor, queryVector, model) },
  }
  return service
}

const stopWords = new Set('a an the of to for in on and or is are was be with what which how should i we you it its this that please cite source sources according document documents tell me about do does can'.split(' '))
export function knowledgeTokens(text) {
  const input = String(text || '').toLowerCase().normalize('NFKC')
  const words = (input.match(/[a-z0-9][a-z0-9_-]*|[\p{Script=Han}]+/gu) || []).flatMap(word => /\p{Script=Han}/u.test(word) ? [...word].slice(0, -1).map((_, i) => word.slice(i, i + 2)) : [word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word])
  return words.filter(word => word.length > 1 && !stopWords.has(word))
}

// The actor-scoped corpus is fetched anew for every request; no shared tenant cache.
export class WorkspaceKnowledgeRetriever extends BaseRetriever {
  lc_namespace = ['flowchain', 'retrievers']
  constructor({ loadDocuments, limit = 5, queryEmbedding = null, embeddingModel = null, databaseSemanticRanks = null }) { super(); this.loadDocuments = loadDocuments; this.limit = limit; this.queryEmbedding = queryEmbedding; this.embeddingModel = embeddingModel; this.databaseSemanticRanks = databaseSemanticRanks }
  async _getRelevantDocuments(query) {
    const allDocuments = await this.loadDocuments()
    // Model codes are exact constraints: a near-neighbor SKU is not an answer for the requested SKU.
    const identifiers = String(query).toLowerCase().match(/\b[a-z]{2,}[a-z0-9]*-\d{3,}[a-z0-9-]*\b/g) || []
    const documents = allDocuments.filter(document => {
      const tokens = knowledgeTokens(`${document.metadata.title} ${document.pageContent}`)
      return identifiers.every(identifier => tokens.includes(identifier))
    })
    const tokens = documents.map(doc => knowledgeTokens(`${doc.metadata.title} ${doc.pageContent}`))
    const queryTokens = [...new Set(knowledgeTokens(query))]
    const average = tokens.reduce((n, words) => n + words.length, 0) / (tokens.length || 1)
    const scored = documents.map((document, index) => {
      let score = 0
      for (const token of queryTokens) {
        const frequency = tokens[index].filter(word => word === token).length
        if (!frequency) continue
        const df = tokens.filter(words => words.includes(token)).length
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
        score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * tokens[index].length / (average || 1)))
      }
      return { document, score }
    })
    const lexical = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.document.metadata.id.localeCompare(b.document.metadata.id))
    const byId = new Map(documents.map(document => [document.metadata.id, document]))
    const semantic = this.databaseSemanticRanks ? this.databaseSemanticRanks.map(item => ({ document: byId.get(item.id), score: item.score })).filter(item => item.document && item.score > 0) : this.queryEmbedding ? documents.map(document => ({ document, score: document.metadata.embeddingModel === this.embeddingModel ? cosineSimilarity(this.queryEmbedding, document.metadata.embedding) : null })).filter(item => item.score !== null && item.score > 0).sort((a, b) => b.score - a.score) : []
    const fused = new Map()
    lexical.forEach((item, rank) => fused.set(item.document.metadata.id, { document: item.document, score: (fused.get(item.document.metadata.id)?.score || 0) + 1 / (60 + rank) }))
    semantic.forEach((item, rank) => fused.set(item.document.metadata.id, { document: item.document, score: (fused.get(item.document.metadata.id)?.score || 0) + 1.25 / (60 + rank) }))
    return [...fused.values()].sort((a, b) => b.score - a.score || a.document.metadata.id.localeCompare(b.document.metadata.id)).slice(0, this.limit).map(item => item.document)
  }
}

export async function answerKnowledgeQuery({ question, language = 'en-US', actor, service, env = {}, provider = callConfiguredProvider }) {
  const zh = language === 'zh-CN'
  const queryVector = await callConfiguredEmbeddingProvider([question], env)
  const databaseSemanticRanks = queryVector.ok && service.semanticRanks ? await service.semanticRanks(actor, queryVector.vectors[0], queryVector.model) : null
  const retriever = new WorkspaceKnowledgeRetriever({ loadDocuments: () => service.documents(actor), queryEmbedding: queryVector.ok ? queryVector.vectors[0] : null, embeddingModel: queryVector.ok ? queryVector.model : null, databaseSemanticRanks })
  const chain = RunnableSequence.from([
    RunnableLambda.from(async input => ({ question: input, documents: await retriever.invoke(input) })),
    RunnableLambda.from(async ({ question, documents }) => {
      const citations = documents.map((doc, index) => ({ id: doc.metadata.id, documentId: doc.metadata.documentId, title: doc.metadata.title, position: doc.metadata.position, sourceNumber: index + 1, language: doc.metadata.language, contentHash: doc.metadata.contentHash, excerpt: doc.pageContent }))
      if (!citations.length) return { answer: zh ? '没有找到有权限访问的相关资料。请先导入产品资料或补充具体型号、术语。' : 'No relevant accessible documents were found. Import product information or add a specific model or term to your question.', citations, mode: 'no_results' }
      if (canCallConfiguredProvider(env)) {
        try {
          const result = await provider({ task: { type: 'knowledge_rag', question, answerLanguage: language }, evidencePackage: { citations }, safetyPolicy: { readOnly: true } }, env)
          const raw = result?.rawOutput?.conclusion?.summary || result?.rawOutput
          const output = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw
          if (result.ok && typeof output?.answer === 'string' && output.answer.trim() && output.answer.length <= 2400 && Array.isArray(output.citationIds) && output.citationIds.length && output.citationIds.every(id => citations.some(c => c.id === id))) {
            const selected = citations.filter(c => output.citationIds.includes(c.id))
            const numbers = [...output.answer.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]))
            if (numbers.every(number => selected.some(c => c.sourceNumber === number))) return { answer: output.answer, citations: selected, mode: 'generated' }
          }
        } catch { /* Retrieval remains available when model output cannot be used. */ }
      }
      return { answer: citations.slice(0, 3).map((source, index) => `[${index + 1}] ${source.excerpt.slice(0, 550)}`).join('\n\n'), citations, mode: canCallConfiguredProvider(env) ? 'model_unavailable' : 'retrieved_excerpts' }
    }),
  ])
  return chain.invoke(question)
}

export function knowledgeResponse(result, question, language = 'en-US') {
  const zh = language === 'zh-CN'
  const label = result.mode === 'generated' ? (zh ? '基于资料的回答' : 'Answer from your knowledge base') : result.mode === 'no_results' ? (zh ? '未找到相关资料' : 'No matching knowledge') : (zh ? '相关资料摘录' : 'Retrieved document excerpts')
  return { version: 'v2', query: question, intent: 'knowledge_retrieval', scope: { module: 'ai', dataScopeLabel: zh ? '当前工作区可访问资料' : 'Accessible workspace documents' }, conclusion: { title: label, summary: result.answer, severity: 'info', confidence: 'medium' }, keyEvidence: [], businessImpact: [], recommendedActions: [], navigationLinks: [], dataLimitations: [], reviewCards: [], followUpQuestions: [], rag: { ...result, answer: undefined }, runtimeModeLabel: label }
}
