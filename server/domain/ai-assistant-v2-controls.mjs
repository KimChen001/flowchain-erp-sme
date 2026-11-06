import { createAssistantV2ModelClient } from './ai-assistant-v2-model/index.mjs'
import { ASSISTANT_V2_LIMITS } from './ai-assistant-v2.mjs'

// What runs in front of the assistant v2 loop (docs/ai-assistant-v2-design.md
// §3.2, §8.5): whether v2 answers this request at all, the per-user rate
// limit and the cost reservation. The length check and the injection guard
// run in the gateway before these.

const text = (value) => String(value ?? '').trim()

export const ASSISTANT_V2_RATE_LIMIT = Object.freeze({ questions: 30, windowMs: 10 * 60 * 1000 })

// The model client v2 would answer with, or null when v2 is off for this
// request: the mode is assistant_v2, a client can be made from the settings,
// and the workspace's model access (withAiWorkspaceAccess) is on. Over the cap,
// switched off or without a provider, modelFreeEnv has already reset the mode
// to rules; the access status is checked here as well, so the branch does not
// depend on that reset. `ctx.aiAssistantV2ModelClient` replaces the client
// made from the settings (the scripted client in tests).
export function assistantV2ModelClient(ctx = {}) {
  const env = ctx.env || process.env
  if (text(env.FLOWCHAIN_AI_ASSISTANT_MODE).toLowerCase() !== 'assistant_v2') return null
  if (ctx.aiWorkspaceAccessStatus !== 'on' || ctx.aiModelAccess) return null
  if (!ctx.identity?.authenticated || !text(ctx.identity.tenantId)) return null
  try {
    return (ctx.aiAssistantV2ModelClient !== undefined ? ctx.aiAssistantV2ModelClient : createAssistantV2ModelClient(env)) || null
  } catch {
    // A local-only provider in production, or settings the SDK refuses.
    return null
  }
}

export const assistantV2Enabled = (ctx) => Boolean(assistantV2ModelClient(ctx))

// Questions per user in a sliding window, in this process's memory (P1 runs
// one instance). A question is counted when it is let through.
export function createAssistantV2RateLimiter({ now = () => Date.now(), limits = ASSISTANT_V2_RATE_LIMIT } = {}) {
  const asked = new Map()
  return {
    allow(key) {
      const at = now()
      for (const [other, times] of asked) {
        const recent = times.filter((time) => at - time < limits.windowMs)
        if (recent.length) asked.set(other, recent)
        else asked.delete(other)
      }
      const times = asked.get(key) || []
      if (times.length >= limits.questions) return false
      asked.set(key, [...times, at])
      return true
    },
  }
}

// The cost check: what is left of this month's cap, less what answers still
// running hold (reservedMicros), must cover the worst case of one answer (its
// cost ceiling). { ok, capRemainingMicros }, with null when no cap applies:
// without a database nothing is counted, so there is no spend to hold an
// answer against.
export function assistantV2CostReservation(access, { ceilingMicros = ASSISTANT_V2_LIMITS.costCeilingMicros, reservedMicros = 0 } = {}) {
  if (!access || !Number.isFinite(Number(access.capUsd))) return { ok: true, capRemainingMicros: null }
  const remaining = Math.round(Number(access.capUsd) * 1e6) - Math.round(Number(access.costUsd || 0) * 1e6) - reservedMicros
  return { ok: remaining >= ceilingMicros, capRemainingMicros: Math.max(0, remaining) }
}

// The reservations of the answers running in this process, per workspace
// (P1 runs one instance). An answer let through holds its ceiling until it
// ends, so answers running together cannot each spend the same remaining
// budget: each one's in-loop cap check starts from the cap less the
// month-to-date spend and the others' holds. The spend is read once per
// request, so an answer that ended between that read and this reservation is
// counted by neither; that window is at most one answer's ceiling.
// reserve() → { ok, capRemainingMicros, release() }; release is idempotent.
export function createAssistantV2CostLedger({ ceilingMicros = ASSISTANT_V2_LIMITS.costCeilingMicros } = {}) {
  const held = new Map()
  return {
    reserve(tenantId, access) {
      const key = text(tenantId)
      const check = assistantV2CostReservation(access, { ceilingMicros, reservedMicros: held.get(key) || 0 })
      if (!check.ok || check.capRemainingMicros === null) return { ...check, release() {} }
      held.set(key, (held.get(key) || 0) + ceilingMicros)
      let released = false
      return {
        ...check,
        release() {
          if (released) return
          released = true
          const left = (held.get(key) || 0) - ceilingMicros
          if (left > 0) held.set(key, left)
          else held.delete(key)
        },
      }
    },
    heldMicros: (tenantId) => held.get(text(tenantId)) || 0,
  }
}
