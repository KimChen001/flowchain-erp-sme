import { buildAiRuntimeEvaluationV2, buildAiRuntimeObservabilityV2 } from '../domain/ai-runtime-observability-v2.mjs'
import { isLocalDatabaseUrl } from '../domain/local-development-contract.mjs'
import { isProductionEnv } from '../observability/error-reporter.mjs'

const text = (value) => String(value ?? '').trim()

// The evaluation endpoint calls the provider outside the workspace opt-in,
// the cap and the meter (docs/ai-assistant-v2-design.md §1, §8.5), so it runs
// only on a developer's machine: not in production, not on a hosted
// deployment, and against no database but a local one.
export function aiRuntimeEvaluateAllowed(env = {}) {
  if (isProductionEnv(env) || text(env.RENDER).toLowerCase() === 'true') return false
  return !text(env.DATABASE_URL) || isLocalDatabaseUrl(env.DATABASE_URL)
}

export async function handleAiRuntimeObservabilityRoute(ctx) {
  const { req, res, url, db, send, readBody } = ctx

  if (req.method === 'GET' && url.pathname === '/api/ai-runtime/observability') {
    send(res, 200, buildAiRuntimeObservabilityV2(db, process.env))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-runtime/evaluate') {
    if (!aiRuntimeEvaluateAllowed(ctx.env || process.env)) {
      send(res, 410, { code: 'AI_EVALUATE_LOCAL_ONLY', error: 'The assistant evaluation runs only in local development.' })
      return true
    }
    let body = {}
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, { error: '评估问题无法读取，请重新输入。', dataScopeLabel: '当前工作区数据' })
      return true
    }
    const result = await buildAiRuntimeEvaluationV2(db, body, { env: process.env })
    send(res, result.status, result.body)
    return true
  }

  return false
}
