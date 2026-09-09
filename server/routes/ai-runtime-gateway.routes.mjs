import { handleKnowledgeRoute, runKnowledgeQuery, isKnowledgeQuestion } from './ai-knowledge.routes.mjs'
import { buildAiRuntimeReadinessV2, buildAiRuntimeResponseV2Async, buildAiRuntimeSafeFallbackV2 } from '../domain/ai-runtime-gateway-v2.mjs'
import { runBusinessQueryRuntime } from '../domain/ai-business-query-runtime.mjs'

export async function loadAiRuntimeFacts(repositories = {}, tenantId = '') {
  if (!tenantId) return {}
  const scope = { tenantId }
  const [procurement, products, suppliers] = await Promise.all([
    repositories.procurementRead?.snapshot?.(scope) || {},
    repositories.inventoryRead?.listItems?.(scope) || [],
    repositories.masterData?.listSuppliers?.(scope) || [],
  ])
  return {
    purchaseRequests: procurement.purchaseRequests || [],
    rfqs: procurement.rfqs || [],
    purchaseOrders: procurement.purchaseOrders || [],
    receivingDocs: procurement.receivingDocs || [],
    supplierInvoices: procurement.supplierInvoices || [],
    products,
    suppliers,
  }
}

export async function handleAiRuntimeGatewayRoute(ctx) {
  if (await handleKnowledgeRoute(ctx)) return true
  const { req, res, url, db, send, readBody, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/ai-runtime/readiness') {
    send(res, 200, buildAiRuntimeReadinessV2(db, process.env))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-runtime/respond') {
    let body = {}
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, { error: '问题内容无法读取，请重新输入。', dataScopeLabel: '当前工作区数据' })
      return true
    }
    try {
      const knowledge = await runKnowledgeQuery(ctx, body)
      if (knowledge) { send(res, 200, knowledge); return true }
      const businessQuery = await runBusinessQueryRuntime(ctx, db, body, { responseMode: 'runtime' })
      if (businessQuery) {
        send(res, 200, businessQuery)
        return true
      }
      const facts = identity?.authenticated && identity.tenantId
        ? await loadAiRuntimeFacts(repositories, identity.tenantId)
        : {}
      const result = await buildAiRuntimeResponseV2Async({ ...db, ...facts }, body, { env: process.env })
      send(res, result.status, result.body)
    } catch (error) {
      if (isKnowledgeQuestion(body)) {
        send(res, error.status || 503, { code: error.code || 'KNOWLEDGE_UNAVAILABLE', error: error.status ? error.message : (body.answerLanguage === 'zh-CN' ? '知识库暂时不可用，请稍后重试。' : 'Knowledge is temporarily unavailable. Please try again.') })
        return true
      }
      send(res, 200, buildAiRuntimeSafeFallbackV2(body, '当前工作区证据暂不完整'))
    }
    return true
  }

  return false
}
