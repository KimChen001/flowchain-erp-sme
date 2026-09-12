const MAX_INPUTS = 2048
const MAX_DIMENSIONS = 4096

const text = value => String(value ?? '').trim()
const positiveInteger = (value, fallback, maximum) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

export function embeddingConfig(env = {}) {
  return {
    endpoint: text(env.FLOWCHAIN_AI_EMBEDDING_ENDPOINT),
    apiKey: text(env.FLOWCHAIN_AI_EMBEDDING_API_KEY),
    model: text(env.FLOWCHAIN_AI_EMBEDDING_MODEL),
    dimensions: positiveInteger(env.FLOWCHAIN_AI_EMBEDDING_DIMENSIONS, 0, MAX_DIMENSIONS),
    timeoutMs: positiveInteger(env.FLOWCHAIN_AI_EMBEDDING_TIMEOUT_MS, 10000, 30000),
  }
}

export const canCallEmbeddingProvider = env => {
  const config = embeddingConfig(env)
  return Boolean(config.endpoint && config.apiKey && config.model)
}

export async function callConfiguredEmbeddingProvider(inputs, env = {}, fetchImpl = globalThis.fetch) {
  const config = embeddingConfig(env)
  if (!fetchImpl || !canCallEmbeddingProvider(env)) return { ok: false, reason: 'not_configured' }
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_INPUTS || inputs.some(value => typeof value !== 'string' || !value.trim() || value.length > 12000)) return { ok: false, reason: 'invalid_input' }
  const vectors = []
  let dimensions = config.dimensions
  for (let offset = 0; offset < inputs.length; offset += 32) {
    let result
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await embeddingBatch(inputs.slice(offset, offset + 32), env, fetchImpl)
      if (result.ok || !['rate_limited', 'service_unavailable', 'timeout', 'network_error'].includes(result.reason)) break
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt))
    }
    if (!result.ok) return result
    if (dimensions && result.dimensions !== dimensions) return { ok: false, reason: 'dimension_mismatch' }
    dimensions = result.dimensions
    vectors.push(...result.vectors)
  }
  return { ok: true, vectors, model: config.model, dimensions }
}

export function validEmbedding(vector, dimensions) {
  return Array.isArray(vector) && Number.isInteger(dimensions) && dimensions > 0 && dimensions <= MAX_DIMENSIONS && vector.length === dimensions && vector.every(Number.isFinite) && vector.some(value => value !== 0)
}

async function embeddingBatch(inputs, env, fetchImpl) {
  const config = embeddingConfig(env)
  const values = inputs.map(text)
  if (!fetchImpl || !canCallEmbeddingProvider(env)) return { ok: false, reason: 'not_configured' }
  if (!values.length || values.length > MAX_INPUTS || values.some(value => !value)) return { ok: false, reason: 'invalid_input' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const body = { model: config.model, input: values }
    if (config.dimensions) body.dimensions = config.dimensions
    const response = await fetchImpl(config.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'service_unavailable' : 'non_success_status' }
    const payload = await response.json()
    const ordered = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => a.index - b.index) : []
    if (ordered.some((item, index) => item.index !== index)) return { ok: false, reason: 'malformed_output' }
    const vectors = ordered.map(item => item.embedding)
    const dimensions = vectors[0]?.length || 0
    if (vectors.length !== values.length || vectors.some(vector => !validEmbedding(vector, dimensions))) return { ok: false, reason: 'malformed_output' }
    if (config.dimensions && dimensions !== config.dimensions) return { ok: false, reason: 'dimension_mismatch' }
    return { ok: true, vectors, model: config.model, dimensions }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' }
  } finally { clearTimeout(timeout) }
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null
  let dot = 0, leftNorm = 0, rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) return null
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : null
}
