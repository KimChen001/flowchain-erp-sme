import { aiSkillQuestionLanguage } from './ai-skill-copy.mjs'
import { refineAiSkillRoute } from './ai-skill-entities.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { aiSkillSpendSignals, routeSkill } from './ai-skill-router.mjs'
import { resolveAiSkillFollowUp } from './ai-skill-follow-up.mjs'
import { answerAiSkill, toolsFor } from './ai-skills.mjs'
import { aiKnowledgeAuditBlock, recordAiSkillAudit } from './ai-skill-audit.mjs'
import { aiSkillIntentShadowAudit, aiSkillIntentShadowEnabled, classifyAiSkillIntentShadow } from './ai-skill-intent-shadow.mjs'
import { aiSkillIntentRoutingAudit, aiSkillIntentRoutingEnabled, routeAiSkillIntent } from './ai-skill-intent-routing.mjs'
import { aiCompoundAnswersEnabled, aiCompoundAudit, aiCompoundGaps, composeAiCompoundAnswer, planAiCompoundAnswer, splitAiCompoundQuestion } from './ai-skill-compound.mjs'
import { AI_AGENT_KNOWLEDGE, aiAgentAudit, aiAgentPlanningEnabled, planAiAgentTools } from './ai-agent-planning.mjs'
import { classifyQueryScope } from './ai-query-scope.mjs'
import { AI_AGENT_BUSINESS_QUERY, AI_AGENT_BUSINESS_QUERY_TITLE, answerAiAgentBusinessQuery } from './ai-agent-business-query.mjs'
import { aiSkillById } from './ai-skill-registry.mjs'
import { assertValidAiSkillResponse } from './ai-skill-validator.mjs'
import { aiAnswerComposeAudit, composeAiAnswer } from './ai-answer-compose.mjs'
import { aiConversationMemory, aiMemoryForModels, aiSkillMemoryReference } from './ai-conversation-memory.mjs'
import { aiSkillFocusName } from './ai-skill-today-priorities.mjs'

// The assistant's answer path after knowledge and business queries: route the
// question to a workspace skill, read the facts through the report
// definitions for the signed-in actor, look up the records the question
// names (which can choose the skill), answer in the question's language, and
// audit the answer. A short follow-up no rule answers on its own ("What about
// PO-020?", 为什么？, 第一个) is read with the previous answer the panel sends
// back (ai-skill-follow-up.mjs). A question that points at a record of the
// previous answer ("draft a follow-up email for it") is narrowed to it
// (ai-conversation-memory.mjs). A question with two or three parts the rules
// route to different skills gets a section per part (ai-skill-compound.mjs).
// A question no rule and no named record matches may be routed by a model
// when that is switched on (ai-skill-intent-routing.mjs). With agent planning
// on (ai-agent-planning.mjs), such a question, and a question with several
// parts the compound rules could not answer part by part, goes to one model
// call that picks up to three skills or the supplier business query; it
// replaces the one-skill pick, and the rules' answer stays when it fails. A
// question with several parts that the business query path would take comes
// here first (`agentFirst`, from the gateway): when the planner does not
// answer it, this returns null and the business query answers as before.
// Otherwise no model is called. A question
// still unmatched, an instruction to act, a question
// about the world outside the workspace, or a skill the actor may not use
// gets the capability answer.

const text = (value) => String(value ?? '').trim()

// Where a planned section goes: the skills' facts in the order the model
// called them (the question's order), then the supplier business query, then
// a draft, which follows the facts it is about.
function agentSectionRank(section) {
  const id = section.route.skillId
  return id === 'prepare_action_draft' ? 2 : id === AI_AGENT_BUSINESS_QUERY ? 1 : 0
}

// A record the model named, in the question's own spelling (case aside, the
// planner only keeps records the question contains).
function spelledAsAsked(message, record) {
  const escaped = record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(message).match(new RegExp(escaped, 'iu'))?.[0] || record
}

export function isLegacyAiTemplateGatewayEnabled(env = process.env) {
  return text(env?.FLOWCHAIN_AI_LEGACY_TEMPLATE_GATEWAY).toLowerCase() === 'true'
}

// `agentFirst`: an object the gateway reads back when this returns null (the
// planner's audit block and whether it failed). `skipAgent`: the planner has
// already been asked for this question. `knowledge`: the actor's documents for
// the planner's knowledge search ({ languages, search }), or null.
export async function runAiSkillRuntime(ctx, body = {}, { agentFirst = null, skipAgent = false, knowledge = null } = {}) {
  const started = Date.now()
  const message = text(body.message || body.question)
  const language = aiSkillQuestionLanguage(message, body.answerLanguage)
  const typed = routeSkill({ message, skillHint: body.skillHint, focusTarget: body.focusTarget })
  // A follow-up becomes the question the skills answer: `asked` is routed and
  // its records looked up; the question as typed sets the language, the audit
  // hash and the answer's query.
  const followUp = body.skillHint ? null : resolveAiSkillFollowUp({ message, route: typed, conversationContext: body.conversationContext })
  const asked = followUp ? followUp.message : message
  let route = followUp ? routeSkill({ message: asked, skillHint: followUp.skillHint, focusTarget: followUp.focusTarget || null }) : typed
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
  // Conversation memory: the previous question and the records its answer
  // showed, as the actor's own facts have them (ai-conversation-memory.mjs).
  // A question that points at one of them and names no record ("draft a
  // follow-up email for it", 这家供应商) is narrowed to it, as a question on
  // that record's page is. A chip or a follow-up hint keeps its own focus.
  const memory = readsFacts && !body.skillHint ? aiConversationMemory(body.conversationContext, facts) : null
  const reference = memory && !followUp ? aiSkillMemoryReference({ message, route, memory, facts }) : null
  if (reference) route = { ...route, focus: reference.focus }
  // What the models may read of it: only for a question that refers to the
  // earlier answer, the previous question and the remembered records' names.
  const remembered = memory ? aiMemoryForModels(memory, message) : null
  let refined = readsFacts ? refineAiSkillRoute(route, asked, facts) : route
  const env = ctx.env || process.env
  // Two or three parts the rules route to different skills: each skill
  // answers its part, and the answers come back as one, with a section per
  // part. Follow-ups, chips, follow-up hints, instructions and one-part
  // questions keep the one-skill answer. No model is asked.
  const compound = !agentFirst && readsFacts && !followUp && aiCompoundAnswersEnabled(env) ? planAiCompoundAnswer({ message, route, facts, allowed, focusTarget: reference ? reference.focus : body.focusTarget }) : null
  // No rule and no named record chose a skill, no record number was left
  // unread, and the message is not a greeting or a test: the model may pick
  // one of the actor's skills. The pick runs through the same record step as
  // a rule's, so the mode and the records stay deterministic.
  // Agent planning (P2): a question no rule and no named record chose a
  // skill for, or one with several parts the compound rules could not answer
  // part by part: a draft request among them, or a part no rule routes
  // (aiCompoundGaps). Parts the rules merged on purpose stay with the rules.
  // Chips, follow-ups, greetings, instructions and outside-world questions
  // never reach it. It calls at most one skill per part of the question.
  const agentOn = !skipAgent && readsFacts && !followUp && !route?.greeting && !route?.explicit && !refined?.capability && aiAgentPlanningEnabled(env)
  if (agentFirst && !agentOn) return null
  const gaps = !agentFirst && agentOn && refined?.skillId && !compound ? aiCompoundGaps({ message, route, facts, allowed, focusTarget: reference ? reference.focus : body.focusTarget }) : null
  // A question about records and documents together ("which of Acme's
  // overdue orders need follow-up under our policy"): the planner may search
  // the documents in their own language, so a Chinese question finds an
  // English policy (PR-3). Without documents to search, the rules answer.
  const mixed = !agentFirst && agentOn && knowledge && refined?.skillId && !compound && classifyQueryScope({ ...body, message }) === 'mixed'
  // A question that refers to the earlier answer in a way the rules could not
  // read ("compare these two suppliers", "those orders' invoices"): the
  // planner reads it with the remembered records (conversation memory).
  const unresolved = Boolean(remembered?.records.length) && !reference && !compound && !route?.ids?.length && !route?.focus
  const agentEntry = agentOn ? (agentFirst ? 'multi_part' : !refined?.skillId ? 'unmatched' : gaps && (gaps.draft || gaps.dropped) ? 'multi_part' : mixed ? 'mixed' : unresolved ? 'follow_up' : null) : null
  const parts = agentEntry ? (gaps?.parts ?? splitAiCompoundQuestion(message).length) : 0
  const agentPlan = agentEntry ? await planAiAgentTools({ message, actor: context.actor, env, parts, businessQuery: Boolean(agentFirst), knowledge: knowledge?.languages || null, excluded: route?.excluded || [], memory: remembered, ...(ctx.aiAgentProvider ? { provider: ctx.aiAgentProvider } : {}) }) : null
  // Each planned call runs through the same record step as a rule's: the
  // records the model named (written in the question, or remembered from the
  // previous answer) are looked up in the actor's own facts, and the skill
  // answers in its own words.
  // A supplier business query runs its own plan (ai-agent-business-query.mjs).
  // The sections come in a fixed order (agentSectionRank).
  const titleKey = language === 'zh-CN' ? 'zh' : 'en'
  const isBusinessQuery = (section) => section.route.skillId === AI_AGENT_BUSINESS_QUERY
  const agentSections = agentPlan?.status === 'planned'
    ? (await Promise.all(agentPlan.calls.map(async (call) => {
      // The knowledge search is not a section; its passages follow below.
      if (call.tool === AI_AGENT_KNOWLEDGE) return null
      if (call.tool === AI_AGENT_BUSINESS_QUERY) {
        const answered = await answerAiAgentBusinessQuery(ctx, body, { goals: call.goals, records: call.records, alone: agentPlan.calls.length === 1 }).catch(() => null)
        return answered ? { question: AI_AGENT_BUSINESS_QUERY_TITLE[titleKey], route: { skillId: AI_AGENT_BUSINESS_QUERY, mode: null }, ...answered } : null
      }
      // Each record as the question writes it, set off as a name, so the record
      // step reads it exactly as it reads the question.
      const named = call.records.map((record) => `${spelledAsAsked(message, record)},`).join(' ')
      const base = routeSkill({ message: named }) || {}
      // A tier the call names filters as the question's own tier does. A spend
      // call reads its period and currency from the question, as a rule-routed
      // spend question does, and its view from the call.
      const spend = call.tool === 'spend_analysis' ? { spend: { ...aiSkillSpendSignals(message), ...(call.mode ? { mode: call.mode } : {}) } } : {}
      const partRoute = refineAiSkillRoute({ ids: base.ids || [], signals: { ...(base.signals || {}), short: call.mode === 'short', tier: call.tier ?? null, ...spend }, skillId: call.tool }, named, facts)
      if (!partRoute || partRoute.capability || !partRoute.skillId || !allowed.has(partRoute.skillId)) return null
      return { question: aiSkillById(partRoute.skillId)?.title?.[titleKey] || partRoute.skillId, route: partRoute }
    }))).filter(Boolean).sort((a, b) => agentSectionRank(a) - agentSectionRank(b))
    : []
  // The planned answer: a business query alone answers as the business query
  // does; two or three sections give a compound answer, with the business
  // query's panel when it is one of them. An answer that fails validation is
  // not served, and the rules answer.
  const businessQuery = agentSections.find(isBusinessQuery) || null
  const planned = { source: 'model', modelStatus: 'planned' }
  // The knowledge search: the planner's words search the actor's own
  // documents, and the passages found are shown with their sources, beside the
  // sections or on their own. No model writes an answer from them here.
  const searchCall = agentPlan?.status === 'planned' ? agentPlan.calls.find((call) => call.tool === AI_AGENT_KNOWLEDGE) : null
  const found = searchCall && knowledge ? await knowledge.search({ query: searchCall.query, question: message, language }).catch(() => null) : null
  let agentResponse = null
  let agentFailure = null
  if (agentSections.length === 1 && businessQuery) agentResponse = { ...businessQuery.response, skillRouting: planned }
  else if (agentSections.length > 1) {
    try {
      const sections = agentSections.map((section) => ({ ...section, response: section.response || answerAiSkill({ skillId: section.route.skillId, facts, language, query: message, focus: section.route.focus || null, actor: context.actor, route: section.route }).response }))
      const composed = composeAiCompoundAnswer({ sections, facts, language, query: message })
      const extra = businessQuery ? { ids: businessQuery.readIds, stored: businessQuery.stored } : {}
      agentResponse = { ...assertValidAiSkillResponse(businessQuery ? { ...composed, businessQuery: businessQuery.response.businessQuery } : composed, facts, extra), skillRouting: planned }
    } catch { agentFailure = 'invalid_answer' }
  } else if (!agentSections.length && found) agentResponse = { ...found, skillRouting: planned }
  const agentResult = agentPlan && agentFailure ? { ...agentPlan, status: 'degraded', reason: agentFailure } : agentPlan
  const agentServed = Boolean(agentResponse) || (agentSections.length === 1 && !agentFailure)
  // Asked first for a question the business query path would take: when the
  // planner does not answer, the business query does, with this audit block.
  if (agentFirst && !agentServed) {
    agentFirst.agent = agentResult ? aiAgentAudit(agentResult, { entry: agentEntry, served: [] }) : null
    agentFirst.degraded = agentResult?.status === 'degraded'
    return null
  }
  let intentRouting = null
  if (!agentEntry && !compound && readsFacts && !refined?.skillId && !refined?.capability && !route?.greeting && aiSkillIntentRoutingEnabled(env)) {
    intentRouting = await routeAiSkillIntent({ message, actor: context.actor, env, excluded: route?.excluded || [], ...(ctx.aiSkillIntentProvider ? { provider: ctx.aiSkillIntentProvider } : {}) })
    if (intentRouting.status === 'routed' && allowed.has(intentRouting.skillId)) refined = refineAiSkillRoute({ ...route, skillId: intentRouting.skillId }, asked, facts) || refined
  }
  // One planned skill answers as that skill.
  if (agentServed && !agentResponse) refined = agentSections[0].route
  const skillId = agentResponse ? (agentResponse.intent === 'compound' ? 'compound' : agentResponse.intent === 'knowledge_retrieval' ? 'knowledge_retrieval' : 'business_query') : compound ? 'compound' : refined?.skillId && allowed.has(refined.skillId) ? refined.skillId : 'capability_overview'
  // A business query answer is audited as the business query path's: its
  // records are not in the skills' facts.
  const answerFacts = ['capability_overview', 'business_query', 'knowledge_retrieval'].includes(skillId) ? null : facts
  let response
  if (agentResponse) {
    response = agentResponse
  } else if (compound) {
    const sections = compound.sections.map((section) => ({ ...section, response: answerAiSkill({ skillId: section.route.skillId, facts, language, query: section.question, focus: section.route.focus || null, actor: context.actor, route: section.route }).response }))
    response = assertValidAiSkillResponse(composeAiCompoundAnswer({ sections, facts, language, query: message, skipped: compound.skipped }), facts)
  } else {
    const answered = answerAiSkill({ skillId, facts: answerFacts, language, query: message, focus: refined?.focus || null, refusal, outOfDomain: Boolean(route?.outOfDomain), actor: context.actor, route: refined }).response
    const modelRouted = intentRouting?.status === 'routed' && skillId === intentRouting.skillId
    const routed = agentServed
      ? { ...answered, skillRouting: { source: 'model', modelStatus: 'planned' } }
      : agentPlan
        ? { ...answered, skillRouting: { source: 'rules', modelStatus: agentPlan.status } }
        : intentRouting ? { ...answered, skillRouting: { source: modelRouted ? 'model' : 'rules', modelStatus: intentRouting.status } } : answered
    const resolvedKind = followUp?.kind || reference?.kind || null
    response = resolvedKind ? { ...routed, followUp: { kind: resolvedKind } } : routed
  }
  // A model step was tried and failed: the rules answered, and the answer says
  // it may not cover every part (the limited-mode label).
  if (agentResult && !agentServed && agentResult.status === 'degraded') response = { ...response, agentPlanning: { status: 'degraded', entry: agentEntry } }
  // The passages the planner's search found go with a planned answer from
  // records as its knowledge supplement; the gateway then adds none.
  if (found && agentServed && response.intent !== 'knowledge_retrieval') response = { ...response, supplementalKnowledge: { title: found.conclusion.title, summary: found.conclusion.summary, rag: found.rag } }
  // P3: with compose mode on, the model words the title and summary from this
  // answer's own facts; the verifier keeps the template on any doubt. A
  // follow-up or a question about the earlier answer also gives it the
  // previous question, so "why?" is read as about what was asked before. The
  // records a reference was read as go with the question ("the first two" is
  // PO-001 and PO-008), so the wording names those.
  const previousQuestion = followUp || reference || remembered ? memory?.question || null : null
  const referred = reference ? [aiSkillFocusName(reference.focus, facts)] : agentServed && remembered ? [...new Set(agentPlan.calls.flatMap((call) => call.records))] : []
  const resolvedQuestion = followUp ? asked : referred.length ? `${message} (${referred.join(', ')})` : null
  const composed = await composeAiAnswer({ response, facts, message, resolvedQuestion, previousQuestion, env, ...(ctx.aiComposeProvider ? { provider: ctx.aiComposeProvider } : {}) })
  response = composed.response
  const routingAudit = aiSkillIntentRoutingAudit(intentRouting)
  const agent = agentResult ? aiAgentAudit(agentResult, { entry: agentEntry, served: agentServed ? [...agentSections.map((section) => section.route.skillId), ...(found ? [AI_AGENT_KNOWLEDGE] : [])] : [] }) : compound ? aiCompoundAudit(compound) : null
  const audited = skillId === 'business_query' ? { ...response, answerSource: 'business_query' } : skillId === 'knowledge_retrieval' ? { ...response, answerSource: 'knowledge', language } : response
  const audit = (intentShadow = null) => recordAiSkillAudit(ctx, { response: audited, facts: answerFacts, message, latencyMs: Date.now() - started, refusal, intentShadow, intentRouting: routingAudit, followUp: followUp?.kind || reference?.kind || null, agent, knowledge: found && agentServed ? aiKnowledgeAuditBlock(found.rag) : null, compose: aiAnswerComposeAudit(composed.compose) })
  // With the classifier on, the answer does not wait for it: the audit row
  // is written when its suggestion arrives (best effort, like every audit).
  if (aiSkillIntentShadowEnabled(env) && !route?.capability) {
    shadow.then((value) => audit(aiSkillIntentShadowAudit(value, { skillId, mode: compound ? null : refined?.mode || null }))).catch(() => {})
    return response
  }
  await audit()
  return response
}
