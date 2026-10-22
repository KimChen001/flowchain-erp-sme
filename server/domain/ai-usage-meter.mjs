import { AsyncLocalStorage } from 'node:async_hooks'

// Model usage per workspace and calendar month (UTC), for the AI spend cap
// (ai-workspace-access.mjs). The assistant gateway opens a scope for each
// request with the workspace's recorder; every provider call made inside it,
// on any path (skills, knowledge, planners), is counted once. Outside a scope
// nothing is recorded. Recording is best effort: it never fails an answer.

const scope = new AsyncLocalStorage()

// claude-haiku-4-5 list prices, US dollars per million tokens. Overridable
// with FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK / FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK.
export const AI_PRICE_DEFAULTS = Object.freeze({ inputPerMillion: 1, outputPerMillion: 5 })

const nonNegative = (value, fallback) => {
  const number = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(number) && number >= 0 ? number : fallback
}

export function aiUsageMonth(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

export function aiUsagePrices(env = {}) {
  return {
    inputPerMillion: nonNegative(env.FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK, AI_PRICE_DEFAULTS.inputPerMillion),
    outputPerMillion: nonNegative(env.FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK, AI_PRICE_DEFAULTS.outputPerMillion),
  }
}

// Millionths of a dollar: tokens times dollars per million tokens.
export function aiCallCostMicros(usage, prices = AI_PRICE_DEFAULTS) {
  const input = nonNegative(usage?.inputTokens, 0)
  const output = nonNegative(usage?.outputTokens, 0)
  return Math.round(input * prices.inputPerMillion + output * prices.outputPerMillion)
}

// Runs fn with a recorder for the provider calls it makes. record(usage)
// receives { inputTokens, outputTokens } or null when the provider reported
// none; the call is still counted.
export function runWithAiUsageScope(record, fn) {
  return typeof record === 'function' ? scope.run({ record }, fn) : fn()
}

export async function recordAiProviderCall(response) {
  const context = scope.getStore()
  if (!context) return
  try { await context.record(response?.usage || null) } catch { /* best effort */ }
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
