import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { localDevelopmentEnabled } from './local-development-contract.mjs'
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
// provider settings as they are, without the opt-in, but wherever a database
// is present the monthly cap still holds (docs/ai-assistant-v2-design.md §8.5):
// spend is never unlimited because the opt-in is not required.

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

// The startup check for assistant v2 (docs/ai-assistant-v2-design.md §8.5,
// decision V2-11): a server that answers with v2 anywhere but controlled local
// development or a test run must require the workspace opt-in (production
// does by default), so a showcase or trial deployment never calls the model
// for a workspace whose administrator has not switched AI on. Throws.
export const AI_ASSISTANT_V2_OPT_IN_ERROR = 'FLOWCHAIN_AI_ASSISTANT_V2_OPT_IN_REQUIRED'
export function assertAiAssistantV2Deployment(env = {}) {
  if (text(env.FLOWCHAIN_AI_ASSISTANT_MODE).toLowerCase() !== 'assistant_v2' || aiOptInRequired(env)) return
  if (localDevelopmentEnabled(env) || text(env.NODE_ENV).toLowerCase() === 'test') return
  const error = new Error(`${AI_ASSISTANT_V2_OPT_IN_ERROR}: FLOWCHAIN_AI_ASSISTANT_MODE=assistant_v2 outside local development needs FLOWCHAIN_AI_WORKSPACE_OPT_IN=required.`)
  error.code = AI_ASSISTANT_V2_OPT_IN_ERROR
  throw error
}

// Whether any assistant path could call a model with these settings. With
// assistant v2 on, a recorded transcript to replay
// (FLOWCHAIN_AI_ASSISTANT_SCRIPTED, ai-assistant-v2-model/index.mjs) counts as
// a provider, so a replay passes the same opt-in, cap and metering as a live
// model, its recorded usage priced like any call.
export function aiProviderConfigured(env = {}) {
  const replay = text(env.FLOWCHAIN_AI_ASSISTANT_MODE).toLowerCase() === 'assistant_v2' && Boolean(text(env.FLOWCHAIN_AI_ASSISTANT_SCRIPTED))
  return replay || canCallConfiguredProvider(env) || canCallConfiguredProvider(knowledgeProviderEnv(env))
}

// The same settings with every model path switched off: no provider mode, no
// knowledge or embedding provider, no replay, and every model feature flag off.
export function modelFreeEnv(env = {}) {
  const next = { ...env, FLOWCHAIN_AI_RUNTIME_MODE: 'local', FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'false', FLOWCHAIN_AI_INTENT_ROUTING: 'false', FLOWCHAIN_AI_INTENT_SHADOW: 'false', FLOWCHAIN_AI_AGENT_MODE: 'off', FLOWCHAIN_AI_ASSISTANT_MODE: 'rules' }
  for (const key of Object.keys(next)) if (key === 'FLOWCHAIN_KNOWLEDGE_PROVIDER' || key === 'FLOWCHAIN_AI_ASSISTANT_SCRIPTED' || key.startsWith('FLOWCHAIN_AI_EMBEDDING_')) delete next[key]
  return next
}

// One workspace's AI status: whether it is switched on, its spend this month
// against the cap, and what that means for its requests:
//   no_provider  no model is configured on this server
//   on           requests may call the model
//   off          the opt-in is required and the workspace has not switched it on
//   over_cap     this month's spend reached the cap (switched on, or no opt-in required)
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
    : optInRequired && !enabled ? 'off'
      : costUsd >= capUsd ? 'over_cap' : 'on'
  return { status, providerConfigured, optInRequired, enabled, month, calls: usage?.calls || 0, costUsd, capUsd }
}

// Runs an assistant request with the environment its workspace may use, and
// counts its model calls. Without a provider nothing is looked up. A request
// with no workspace gets no model; with a database configured, neither does
// one whose database or access cannot be read, or that is over the cap, and
// without one the opt-in cannot be read, so where it is required no request
// gets a model. Only a server with no database at all (unit tests; the
// server itself refuses to start without one) runs uncounted. The request carries the outcome for the
// paths that check it themselves (assistant v2): aiWorkspaceAccessStatus,
// and aiWorkspaceAccess, the status read from the database (null without one).
export async function withAiWorkspaceAccess(ctx, run) {
  const env = ctx.env || process.env
  if (!aiProviderConfigured(env)) return run({ ...ctx, aiWorkspaceAccessStatus: 'no_provider', aiWorkspaceAccess: null })
  const tenantId = text(ctx.identity?.tenantId)
  const required = aiOptInRequired(env)
  const databaseConfigured = Boolean(ctx.aiWorkspacePrisma || text(env.DATABASE_URL))
  const prisma = ctx.aiWorkspacePrisma || (databaseConfigured ? await getPrismaClient(env).catch(() => null) : null)
  if (!tenantId || (required && !prisma)) return run({ ...ctx, env: modelFreeEnv(env), aiWorkspaceAccessStatus: 'off', aiWorkspaceAccess: null })
  // A database that is configured but cannot be reached closes the model,
  // as an unreadable access row does: the cap must hold wherever one is set.
  if (databaseConfigured && !prisma) return run({ ...ctx, env: modelFreeEnv(env), aiModelAccess: 'off', aiWorkspaceAccessStatus: 'off', aiWorkspaceAccess: null })
  // Without a database nothing is counted, but a failed call is still noted.
  if (!prisma) return runWithAiUsageScope(null, () => run({ ...ctx, aiWorkspaceAccessStatus: 'on', aiWorkspaceAccess: null }))
  let access = null
  try { access = await readAiWorkspaceAccess({ prisma, tenantId, env }) } catch { access = null }
  if (access?.status !== 'on') return run({ ...ctx, env: modelFreeEnv(env), aiModelAccess: access?.status || 'off', aiWorkspaceAccessStatus: access?.status || 'off', aiWorkspaceAccess: access })
  return runWithAiUsageScope(aiUsageRecorder({ prisma, tenantId, env }), () => run({ ...ctx, aiWorkspaceAccessStatus: 'on', aiWorkspaceAccess: access }))
}
