const MAX_INPUTS = 128
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
  const values = Array.isArray(inputs) ? inputs.map(value => text(value).slice(0, 12000)) : []
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
    if (!response.ok) return { ok: false, reason: 'non_success_status' }
    const payload = await response.json()
    const vectors = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => a.index - b.index).map(item => item.embedding) : []
    const dimensions = vectors[0]?.length || 0
    if (vectors.length !== values.length || !dimensions || dimensions > MAX_DIMENSIONS || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(value)))) return { ok: false, reason: 'malformed_output' }
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
