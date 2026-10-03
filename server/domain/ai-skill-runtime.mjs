import { aiSkillQuestionLanguage } from './ai-skill-copy.mjs'
import { refineAiSkillRoute } from './ai-skill-entities.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { resolveAiSkillFollowUp } from './ai-skill-follow-up.mjs'
import { answerAiSkill, toolsFor } from './ai-skills.mjs'
import { recordAiSkillAudit } from './ai-skill-audit.mjs'
import { aiSkillIntentShadowAudit, aiSkillIntentShadowEnabled, classifyAiSkillIntentShadow } from './ai-skill-intent-shadow.mjs'
import { aiSkillIntentRoutingAudit, aiSkillIntentRoutingEnabled, routeAiSkillIntent } from './ai-skill-intent-routing.mjs'

// The assistant's answer path after knowledge and business queries: route the
// question to a workspace skill, read the facts through the report
// definitions for the signed-in actor, look up the records the question
// names (which can choose the skill), answer in the question's language, and
// audit the answer. A short follow-up no rule answers on its own ("What about
// PO-020?", 为什么？, 第一个) is read with the previous answer the panel sends
// back (ai-skill-follow-up.mjs). A question no rule and no named record
// matches may be routed by a model when that is switched on (ai-skill-intent-routing.mjs);
// otherwise no model is called. A question still unmatched, an instruction
// to act, a question about the world outside the workspace, or a skill the
// actor may not use gets the capability answer.

const text = (value) => String(value ?? '').trim()

export function isLegacyAiTemplateGatewayEnabled(env = process.env) {
  return text(env?.FLOWCHAIN_AI_LEGACY_TEMPLATE_GATEWAY).toLowerCase() === 'true'
}

export async function runAiSkillRuntime(ctx, body = {}) {
  const started = Date.now()
  const message = text(body.message || body.question)
  const language = aiSkillQuestionLanguage(message, body.answerLanguage)
  const typed = routeSkill({ message, skillHint: body.skillHint, focusTarget: body.focusTarget })
  // A follow-up becomes the question the skills answer: `asked` is routed and
  // its records looked up; the question as typed sets the language, the audit
  // hash and the answer's query.
  const followUp = body.skillHint ? null : resolveAiSkillFollowUp({ message, route: typed, conversationContext: body.conversationContext })
  const asked = followUp ? followUp.message : message
  const route = followUp ? routeSkill({ message: asked, skillHint: followUp.skillHint, focusTarget: followUp.focusTarget || null }) : typed
  const context = await loadAiSkillContext(ctx)
  // Off unless switched on: a model's suggestion for the audit row only. It
  // runs beside the facts read and never changes the route or the answer.
  // A refusal or a question about the outside world is not sent.
  const shadow = route?.capability
    ? Promise.resolve({ status: 'disabled' })
    : classifyAiSkillIntentShadow({ message, actor: context.actor, env: ctx.env || process.env, ...(ctx.aiSkillIntentProvider ? { provider: ctx.aiSkillIntentProvider } : {}) })
  const allowed = new Set(toolsFor(context.actor).map((entry) => entry.id))
  const refusal = Boolean(route?.refusal)
  // Any question that is not refused or about the outside world reads the
  // facts, so a record it names can be looked up, even when no rule matched.
  const dataSkills = [...allowed].some((id) => id !== 'capability_overview')
  const readsFacts = Boolean(route && !route.capability && dataSkills)
  const facts = readsFacts ? await readAiSkillFacts(context) : null
  let refined = readsFacts ? refineAiSkillRoute(route, asked, facts) : route
  // No rule and no named record chose a skill, no record number was left
  // unread, and the message is not a greeting or a test: the model may pick
  // one of the actor's skills. The pick runs through the same record step as
  // a rule's, so the mode and the records stay deterministic.
  const env = ctx.env || process.env
  let intentRouting = null
  if (readsFacts && !refined?.skillId && !refined?.capability && !route?.greeting && aiSkillIntentRoutingEnabled(env)) {
    intentRouting = await routeAiSkillIntent({ message, actor: context.actor, env, excluded: route?.excluded || [], ...(ctx.aiSkillIntentProvider ? { provider: ctx.aiSkillIntentProvider } : {}) })
    if (intentRouting.status === 'routed' && allowed.has(intentRouting.skillId)) refined = refineAiSkillRoute({ ...route, skillId: intentRouting.skillId }, asked, facts) || refined
  }
  const skillId = refined?.skillId && allowed.has(refined.skillId) ? refined.skillId : 'capability_overview'
  const answerFacts = skillId === 'capability_overview' ? null : facts
  const answered = answerAiSkill({ skillId, facts: answerFacts, language, query: message, focus: refined?.focus || null, refusal, outOfDomain: Boolean(route?.outOfDomain), actor: context.actor, route: refined }).response
  const modelRouted = intentRouting?.status === 'routed' && skillId === intentRouting.skillId
  const routed = intentRouting ? { ...answered, skillRouting: { source: modelRouted ? 'model' : 'rules', modelStatus: intentRouting.status } } : answered
  const response = followUp ? { ...routed, followUp: { kind: followUp.kind } } : routed
  const routingAudit = aiSkillIntentRoutingAudit(intentRouting)
  const audit = (intentShadow = null) => recordAiSkillAudit(ctx, { response, facts: answerFacts, message, latencyMs: Date.now() - started, refusal, intentShadow, intentRouting: routingAudit, followUp: followUp?.kind || null })
  // With the classifier on, the answer does not wait for it: the audit row
  // is written when its suggestion arrives (best effort, like every audit).
  if (aiSkillIntentShadowEnabled(env) && !route?.capability) {
    shadow.then((value) => audit(aiSkillIntentShadowAudit(value, { skillId, mode: refined?.mode || null }))).catch(() => {})
    return response
  }
  await audit()
  return response
}
