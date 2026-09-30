import { aiSkillLanguage } from './ai-skill-copy.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { answerAiSkill, toolsFor } from './ai-skills.mjs'
import { recordAiSkillAudit } from './ai-skill-audit.mjs'

// The assistant's answer path after knowledge and business queries: route the
// question to a workspace skill, read the facts through the report
// definitions for the signed-in actor, answer in the user's language, audit
// the answer. No model is called. A question no skill matches, an instruction
// to act, or a skill the actor may not use gets the capability answer.

const text = (value) => String(value ?? '').trim()

export function isLegacyAiTemplateGatewayEnabled(env = process.env) {
  return text(env?.FLOWCHAIN_AI_LEGACY_TEMPLATE_GATEWAY).toLowerCase() === 'true'
}

export async function runAiSkillRuntime(ctx, body = {}) {
  const started = Date.now()
  const message = text(body.message || body.question)
  const language = aiSkillLanguage(body.answerLanguage)
  const route = routeSkill({ message, skillHint: body.skillHint, focusTarget: body.focusTarget })
  const context = await loadAiSkillContext(ctx)
  const allowed = new Set(toolsFor(context.actor).map((entry) => entry.id))
  const refusal = Boolean(route?.refusal)
  const skillId = route?.skillId && allowed.has(route.skillId) ? route.skillId : 'capability_overview'
  const facts = skillId === 'capability_overview' ? null : await readAiSkillFacts(context)
  const { response } = answerAiSkill({ skillId, facts, language, query: message, focus: route?.focus || null, refusal, actor: context.actor })
  await recordAiSkillAudit(ctx, { response, facts, message, latencyMs: Date.now() - started, refusal })
  return response
}
