import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { canCallConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'
import { aiUsageMonth, aiUsageRecorder, runWithAiUsageScope } from './ai-usage-meter.mjs'
import { mergeOperationalSettings } from './workspace-settings-contract.mjs'

// Which workspaces may call a model (docs: the owner's AI direction of
// 2026-10-05, agent mode decision 6). Where the workspace opt-in is required
// (production, or FLOWCHAIN_AI_WORKSPACE_OPT_IN=required), a workspace calls a
// model only when its administrator has switched on "AI features" in
// Settings › AI and its spend this month is under the cap; every other
// workspace answers exactly as without a provider. The decision is made once
// per assistant request, before any path runs, by handing the request a
// model-free environment, so knowledge, intent routing, the business query
// planner and agent planning are all covered. Local development keeps the
// provider settings as they are, without the opt-in.

export const AI_MONTHLY_CAP_DEFAULT_USD = 20
const text = (value) => String(value ?? '').trim()

export function aiOptInRequired(env = {}) {
  const value = text(env.FLOWCHAIN_AI_WORKSPACE_OPT_IN).toLowerCase()
  if (value === 'required') return true
  if (value === 'not_required') return false
  return text(env.NODE_ENV).toLowerCase() === 'production'
}

export function aiMonthlyCapUsd(env = {}) {
  const value = Number(env.FLOWCHAIN_AI_MONTHLY_CAP_USD)
  return env.FLOWCHAIN_AI_MONTHLY_CAP_USD !== undefined && env.FLOWCHAIN_AI_MONTHLY_CAP_USD !== '' && Number.isFinite(value) && value >= 0 ? value : AI_MONTHLY_CAP_DEFAULT_USD
}

// Whether any assistant path could call a model with these settings.
export function aiProviderConfigured(env = {}) {
  return canCallConfiguredProvider(env) || canCallConfiguredProvider(knowledgeProviderEnv(env))
}

// The same settings with every model path switched off: no provider mode, no
// knowledge or embedding provider, and every model feature flag off.
export function modelFreeEnv(env = {}) {
  const next = { ...env, FLOWCHAIN_AI_RUNTIME_MODE: 'local', FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'false', FLOWCHAIN_AI_INTENT_ROUTING: 'false', FLOWCHAIN_AI_INTENT_SHADOW: 'false', FLOWCHAIN_AI_AGENT_MODE: 'off' }
  for (const key of Object.keys(next)) if (key === 'FLOWCHAIN_KNOWLEDGE_PROVIDER' || key.startsWith('FLOWCHAIN_AI_EMBEDDING_')) delete next[key]
  return next
}

// One workspace's AI status: whether it is switched on, its spend this month
// against the cap, and what that means for its requests:
//   no_provider  no model is configured on this server
//   on           requests may call the model
//   off          the opt-in is required and the workspace has not switched it on
//   over_cap     switched on, but this month's spend reached the cap
export async function readAiWorkspaceAccess({ prisma, tenantId, env = {}, now = () => new Date() }) {
  const providerConfigured = aiProviderConfigured(env)
  const optInRequired = aiOptInRequired(env)
  const capUsd = aiMonthlyCapUsd(env)
  const month = aiUsageMonth(now())
  const [tenant, usage] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { operationalSettings: true } }),
    prisma.aiUsageMonthly.findUnique({ where: { tenantId_month: { tenantId, month } } }),
  ])
  const enabled = mergeOperationalSettings(tenant?.operationalSettings).ai.modelAssistEnabled === true
  const costUsd = Math.round(Number(usage?.costMicros || 0)) / 1e6
  const status = !providerConfigured ? 'no_provider'
    : !optInRequired ? 'on'
      : !enabled ? 'off'
        : costUsd >= capUsd ? 'over_cap' : 'on'
  return { status, providerConfigured, optInRequired, enabled, month, calls: usage?.calls || 0, costUsd, capUsd }
}

// Runs an assistant request with the environment its workspace may use, and
// counts its model calls. Without a provider nothing is looked up. A request
// with no workspace, or whose workspace cannot be read while the opt-in is
// required, gets no model.
export async function withAiWorkspaceAccess(ctx, run) {
  const env = ctx.env || process.env
  if (!aiProviderConfigured(env)) return run(ctx)
  const tenantId = text(ctx.identity?.tenantId)
  const required = aiOptInRequired(env)
  const prisma = ctx.aiWorkspacePrisma || (text(env.DATABASE_URL) ? await getPrismaClient(env).catch(() => null) : null)
  if (!tenantId || !prisma) return run(required || !tenantId ? { ...ctx, env: modelFreeEnv(env) } : ctx)
  let access = null
  if (required) {
    try { access = await readAiWorkspaceAccess({ prisma, tenantId, env }) } catch { access = null }
    if (access?.status !== 'on') return run({ ...ctx, env: modelFreeEnv(env), aiModelAccess: access?.status || 'off' })
  }
  return runWithAiUsageScope(aiUsageRecorder({ prisma, tenantId, env }), () => run(ctx))
}
