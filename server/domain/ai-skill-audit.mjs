import { createHash, randomUUID } from 'node:crypto'
import { recordDatabaseAuditBestEffort } from './audit-policy.mjs'

// One audit row per assistant answer: which skill answered, from which
// source, which records it cited and how many rows each source gave. The
// question itself is stored only as a hash, never as text, so the row holds no
// free-text personal data. The write is best effort: an audit failure never
// fails the answer.

const array = (value) => Array.isArray(value) ? value : []

export function aiSkillQueryHash(message) {
  return createHash('sha256').update(String(message ?? '')).digest('hex').slice(0, 32)
}

export function aiSkillAuditEntry({ response, facts, message, latencyMs, refusal = false, intentShadow = null, intentRouting = null, agent = null }) {
  const recordIds = [...new Set([...array(response.keyEvidence).map((item) => item.entityId), ...array(response.reviewCards).map((card) => card.targetEntityId)].filter(Boolean))].slice(0, 25)
  const rowCounts = facts ? {
    purchase_orders: facts.purchaseOrders ? facts.purchaseOrders.rows.length : null,
    inventory: facts.inventory ? facts.inventory.rows.length : null,
    supplier_invoices: facts.invoices ? facts.invoices.committedCount : null,
    purchase_requests: facts.purchaseRequests ? facts.purchaseRequests.awaitingApproval.length : null,
    rfqs: facts.rfqs ? facts.rfqs.readyToAward.length : null,
    receipts: facts.receipts ? facts.receipts.rejected.length + facts.receipts.unposted.length : null,
  } : {}
  return {
    id: `AUD-AI-${randomUUID()}`,
    source: 'ai_assisted',
    module: 'ai-assistant',
    action: 'ai_skill_answered',
    entity: { type: 'ai_skill', id: response.intent },
    summary: `Assistant answered with ${response.intent} from workspace data.`,
    metadata: {
      skillId: response.intent,
      skillVersion: response.skill?.version || null,
      answerSource: response.answerSource,
      language: response.language,
      refusal,
      queryHash: aiSkillQueryHash(message),
      queryLength: String(message ?? '').length,
      recordIds,
      recordCount: recordIds.length,
      rowCounts,
      checkedSources: array(response.checked),
      deniedSources: array(facts?.hidden),
      reviewCardCount: array(response.reviewCards).length,
      latencyMs,
      ...(intentShadow ? { intentShadow } : {}),
      ...(intentRouting ? { intentRouting } : {}),
      // A compound answer: the skills and modes of its sections, never the parts' text.
      ...(agent ? { agent } : {}),
    },
  }
}

export async function recordAiSkillAudit(ctx, input) {
  return await recordDatabaseAuditBestEffort(ctx, aiSkillAuditEntry(input))
}
