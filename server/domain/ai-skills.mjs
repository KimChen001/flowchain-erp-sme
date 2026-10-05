import { aiSkillById, attachAiSkillHandlers } from './ai-skill-registry.mjs'
import { assertValidAiSkillResponse } from './ai-skill-validator.mjs'
import { attachAiSkillNextSteps } from './ai-skill-next-steps.mjs'
import { presentTodayPriorities, runTodayPriorities } from './ai-skill-today-priorities.mjs'
import { presentHighestRisk, runHighestRisk } from './ai-skill-highest-risk.mjs'
import { presentRecordsNeedingData, runRecordsNeedingData } from './ai-skill-records-needing-data.mjs'
import { presentPrepareActionDraft, runPrepareActionDraft } from './ai-skill-prepare-action-draft.mjs'
import { presentCapabilityOverview, presentWorkspaceMetrics, runCapabilityOverview, runWorkspaceMetrics } from './ai-skill-capabilities.mjs'
import { presentPurchaseOrders, runPurchaseOrders } from './ai-skill-purchase-orders.mjs'
import { presentPendingApprovals, runPendingApprovals } from './ai-skill-pending-approvals.mjs'
import { presentInventoryAvailability, runInventoryAvailability } from './ai-skill-inventory-availability.mjs'
import { presentInvoiceSummary, runInvoiceSummary } from './ai-skill-invoice-summary.mjs'
import { presentRfqFollowups, runRfqFollowups } from './ai-skill-rfq-followups.mjs'
import { presentReceivingIssues, runReceivingIssues } from './ai-skill-receiving-issues.mjs'
import { presentSupplierAttention, runSupplierAttention } from './ai-skill-supplier-attention.mjs'

// Attaches each skill's run and present to its registry entry. Import this
// module (or anything that imports it) before calling a skill.
attachAiSkillHandlers('today_priorities', { run: runTodayPriorities, present: presentTodayPriorities })
attachAiSkillHandlers('highest_risk_items', { run: runHighestRisk, present: presentHighestRisk })
attachAiSkillHandlers('records_needing_data', { run: runRecordsNeedingData, present: presentRecordsNeedingData })
attachAiSkillHandlers('prepare_action_draft', { run: runPrepareActionDraft, present: presentPrepareActionDraft })
attachAiSkillHandlers('workspace_metrics', { run: runWorkspaceMetrics, present: presentWorkspaceMetrics })
attachAiSkillHandlers('capability_overview', { run: runCapabilityOverview, present: presentCapabilityOverview })
attachAiSkillHandlers('purchase_orders', { run: runPurchaseOrders, present: presentPurchaseOrders })
attachAiSkillHandlers('pending_approvals', { run: runPendingApprovals, present: presentPendingApprovals })
attachAiSkillHandlers('inventory_availability', { run: runInventoryAvailability, present: presentInventoryAvailability })
attachAiSkillHandlers('invoice_summary', { run: runInvoiceSummary, present: presentInvoiceSummary })
attachAiSkillHandlers('rfq_followups', { run: runRfqFollowups, present: presentRfqFollowups })
attachAiSkillHandlers('receiving_issues', { run: runReceivingIssues, present: presentReceivingIssues })
attachAiSkillHandlers('supplier_attention', { run: runSupplierAttention, present: presentSupplierAttention })

export { aiSkillById, AI_SKILL_REGISTRY, toolsFor } from './ai-skill-registry.mjs'

// Runs one skill over the facts and returns its validated answer. route
// carries the mode and the records the question named (ai-skill-entities.mjs).
export function answerAiSkill({ skillId, facts = null, language, query, focus = null, refusal = false, outOfDomain = false, actor = null, route = null }) {
  const skill = aiSkillById(skillId)
  if (!skill?.run) throw Object.assign(new Error(`Unknown AI skill: ${skillId}`), { code: 'AI_SKILL_UNKNOWN', status: 500 })
  const result = skill.run(facts, { focus, refusal, outOfDomain, actor, route })
  // Each line that names a record needing attention states its next step
  // and offers the review-only draft for it (ai-skill-next-steps.mjs).
  const response = attachAiSkillNextSteps(skill.present(result, facts, { skill, language, query }), facts)
  return { result, response: assertValidAiSkillResponse(response, facts) }
}
