import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// Model usage per workspace and calendar month (UTC), for the AI spend cap
// (ai-workspace-access.mjs). The assistant gateway opens a scope for each
// request with the workspace's recorder; every provider call made inside it,
// on any path (skills, knowledge, planners), is counted once. Outside a scope
// nothing is recorded. Recording is best effort: it never fails an answer.

const scope = new AsyncLocalStorage()

// claude-haiku-4-5 list prices, US dollars per million tokens: the prices of a
// model not listed below. Overridable with FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK /
// FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK.
export const AI_PRICE_DEFAULTS = Object.freeze({ inputPerMillion: 1, outputPerMillion: 5 })
// The configured model's list prices (Anthropic, October 2026; Haiku 5.5 for
// prompts up to 100K tokens), so the meter follows the model
// (docs/ai-model-first-design.md §5). A cache read costs a tenth of an input
// token and a five-minute cache write 1.25 times one.
export const AI_MODEL_PRICES = Object.freeze({
  'claude-haiku-5-5': Object.freeze({ inputPerMillion: 0.1, outputPerMillion: 0.5 }),
  'claude-haiku-4-5': AI_PRICE_DEFAULTS,
  'claude-sonnet-5-5': Object.freeze({ inputPerMillion: 2, outputPerMillion: 10 }),
})
const CACHE_READ_FACTOR = 0.1
const CACHE_WRITE_FACTOR = 1.25

const nonNegative = (value, fallback) => {
  const number = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(number) && number >= 0 ? number : fallback
}

export function aiUsageMonth(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

export function aiUsagePrices(env = {}) {
  const listed = AI_MODEL_PRICES[String(env.FLOWCHAIN_AI_PROVIDER_MODEL ?? '').trim()] || AI_PRICE_DEFAULTS
  return {
    inputPerMillion: nonNegative(env.FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK, listed.inputPerMillion),
    outputPerMillion: nonNegative(env.FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK, listed.outputPerMillion),
  }
}

// Millionths of a dollar: tokens times dollars per million tokens. Input
// counts every prompt token; the cache reads and writes inside it, when the
// provider reports them, are priced as such.
export function aiCallCostMicros(usage, prices = AI_PRICE_DEFAULTS) {
  const input = nonNegative(usage?.inputTokens, 0)
  const output = nonNegative(usage?.outputTokens, 0)
  const read = Math.min(input, nonNegative(usage?.cacheReadTokens, 0))
  const write = Math.min(input - read, nonNegative(usage?.cacheWriteTokens, 0))
  const prompt = (input - read - write) + read * CACHE_READ_FACTOR + write * CACHE_WRITE_FACTOR
  return Math.round(prompt * prices.inputPerMillion + output * prices.outputPerMillion)
}

// Runs fn with a recorder for the provider calls it makes. record(usage)
// receives { inputTokens, outputTokens } or null when the provider reported
// none; the call is still counted. Without a recorder nothing is counted, but
// the calls that failed are still noted for the answer (aiProviderFailures).
// Each scope also has a random session id, which the provider calls of this
// request share (a provider that routes by conversation asks for one; see
// FLOWCHAIN_AI_PROVIDER_SESSION_HEADER). It says nothing about the workspace.
export function runWithAiUsageScope(record, fn) {
  return scope.run({ record: typeof record === 'function' ? record : null, failures: [], sessionId: randomUUID() }, fn)
}

// This request's session id, or null outside an assistant request.
export function aiProviderSessionId() {
  return scope.getStore()?.sessionId || null
}

export async function recordAiProviderCall(response) {
  const context = scope.getStore()
  if (!context) return
  // 'budget' when the provider refused for its spending limit (HTTP 402).
  if (response?.ok === false) context.failures.push(response.budgetExceeded ? 'budget' : 'error')
  if (!context.record) return
  try { await context.record(response?.usage || null) } catch { /* best effort */ }
}

// The provider calls that failed so far in this request: 'budget' or 'error'
// for each. Empty outside a scope.
export function aiProviderFailures() {
  return [...(scope.getStore()?.failures || [])]
}

// The recorder for one workspace: an atomic increment of its month's row.
export function aiUsageRecorder({ prisma, tenantId, env = {}, now = () => new Date() }) {
  const prices = aiUsagePrices(env)
  return async (usage) => {
    const month = aiUsageMonth(now())
    const inputUnits = Math.round(nonNegative(usage?.inputTokens, 0))
    const outputUnits = Math.round(nonNegative(usage?.outputTokens, 0))
    const costMicros = aiCallCostMicros(usage, prices)
    await prisma.aiUsageMonthly.upsert({
      where: { tenantId_month: { tenantId, month } },
      create: { tenantId, month, calls: 1, inputUnits, outputUnits, costMicros },
      update: { calls: { increment: 1 }, inputUnits: { increment: inputUnits }, outputUnits: { increment: outputUnits }, costMicros: { increment: costMicros } },
    })
  }
}
