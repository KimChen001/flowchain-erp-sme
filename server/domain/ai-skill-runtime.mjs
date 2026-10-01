import { aiSkillQuestionLanguage } from './ai-skill-copy.mjs'
import { refineAiSkillRoute } from './ai-skill-entities.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { answerAiSkill, toolsFor } from './ai-skills.mjs'
import { recordAiSkillAudit } from './ai-skill-audit.mjs'
import { aiSkillIntentShadowAudit, classifyAiSkillIntentShadow } from './ai-skill-intent-shadow.mjs'

// The assistant's answer path after knowledge and business queries: route the
// question to a workspace skill, read the facts through the report
// definitions for the signed-in actor, look up the records the question
// names (which can choose the skill), answer in the question's language, and
// audit the answer. No model is called. A question no skill matches, an
// instruction to act, a question about the world outside the workspace, or a
// skill the actor may not use gets the capability answer.

const text = (value) => String(value ?? '').trim()

export function isLegacyAiTemplateGatewayEnabled(env = process.env) {
  return text(env?.FLOWCHAIN_AI_LEGACY_TEMPLATE_GATEWAY).toLowerCase() === 'true'
}

export async function runAiSkillRuntime(ctx, body = {}) {
  const started = Date.now()
  const message = text(body.message || body.question)
  const language = aiSkillQuestionLanguage(message, body.answerLanguage)
  const route = routeSkill({ message, skillHint: body.skillHint, focusTarget: body.focusTarget })
  const context = await loadAiSkillContext(ctx)
  // Off unless switched on: a model's suggestion for the audit row only. It
  // runs beside the facts read and never changes the route or the answer.
  const shadow = classifyAiSkillIntentShadow({ message, actor: context.actor, env: ctx.env || process.env, ...(ctx.aiSkillIntentProvider ? { provider: ctx.aiSkillIntentProvider } : {}) })
  const allowed = new Set(toolsFor(context.actor).map((entry) => entry.id))
  const refusal = Boolean(route?.refusal)
  // Any question that is not refused or about the outside world reads the
  // facts, so a record it names can be looked up, even when no rule matched.
  const dataSkills = [...allowed].some((id) => id !== 'capability_overview')
  const readsFacts = Boolean(route && !route.capability && dataSkills)
  const facts = readsFacts ? await readAiSkillFacts(context) : null
  const refined = readsFacts ? refineAiSkillRoute(route, message, facts) : route
  const skillId = refined?.skillId && allowed.has(refined.skillId) ? refined.skillId : 'capability_overview'
  const answerFacts = skillId === 'capability_overview' ? null : facts
  const { response } = answerAiSkill({ skillId, facts: answerFacts, language, query: message, focus: refined?.focus || null, refusal, outOfDomain: Boolean(route?.outOfDomain), actor: context.actor, route: refined })
  const intentShadow = aiSkillIntentShadowAudit(await shadow, { skillId, mode: refined?.mode || null })
  await recordAiSkillAudit(ctx, { response, facts: answerFacts, message, latencyMs: Date.now() - started, refusal, intentShadow })
  return response
}
