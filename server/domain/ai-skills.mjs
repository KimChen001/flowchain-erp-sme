import { aiSkillById, attachAiSkillHandlers } from './ai-skill-registry.mjs'
import { assertValidAiSkillResponse } from './ai-skill-validator.mjs'
import { presentTodayPriorities, runTodayPriorities } from './ai-skill-today-priorities.mjs'
import { presentHighestRisk, runHighestRisk } from './ai-skill-highest-risk.mjs'
import { presentRecordsNeedingData, runRecordsNeedingData } from './ai-skill-records-needing-data.mjs'
import { presentPrepareActionDraft, runPrepareActionDraft } from './ai-skill-prepare-action-draft.mjs'
import { presentCapabilityOverview, presentWorkspaceMetrics, runCapabilityOverview, runWorkspaceMetrics } from './ai-skill-capabilities.mjs'

// Attaches each skill's run and present to its registry entry. Import this
// module (or anything that imports it) before calling a skill.
attachAiSkillHandlers('today_priorities', { run: runTodayPriorities, present: presentTodayPriorities })
attachAiSkillHandlers('highest_risk_items', { run: runHighestRisk, present: presentHighestRisk })
attachAiSkillHandlers('records_needing_data', { run: runRecordsNeedingData, present: presentRecordsNeedingData })
attachAiSkillHandlers('prepare_action_draft', { run: runPrepareActionDraft, present: presentPrepareActionDraft })
attachAiSkillHandlers('workspace_metrics', { run: runWorkspaceMetrics, present: presentWorkspaceMetrics })
attachAiSkillHandlers('capability_overview', { run: runCapabilityOverview, present: presentCapabilityOverview })

export { aiSkillById, AI_SKILL_REGISTRY, toolsFor } from './ai-skill-registry.mjs'

// Runs one skill over the facts and returns its validated answer.
export function answerAiSkill({ skillId, facts = null, language, query, focus = null, refusal = false, actor = null }) {
  const skill = aiSkillById(skillId)
  if (!skill?.run) throw Object.assign(new Error(`Unknown AI skill: ${skillId}`), { code: 'AI_SKILL_UNKNOWN', status: 500 })
  const result = skill.run(facts, { focus, refusal, actor })
  const response = skill.present(result, facts, { skill, language, query })
  return { result, response: assertValidAiSkillResponse(response, facts) }
}
