import test from 'node:test'
import assert from 'node:assert/strict'
import { aiKnowledgeAuditBlock, aiSkillAuditEntry, aiSkillQueryHash } from './ai-skill-audit.mjs'

test('a knowledge answer gets the same audit row as a skill answer, with its mode and cited documents only', () => {
  const question = 'What does our purchasing policy say about escalating a late supplier?'
  const rag = {
    mode: 'excerpt',
    citations: [
      { id: 'c1', documentId: 'doc-policy', title: 'purchasing-policy', heading: 'Example Purchasing Follow-up Policy › Follow-up and escalation', excerpt: 'Escalate to the purchasing manager when the supplier has not responded for two business days.' },
      { id: 'c2', documentId: 'doc-policy', title: 'purchasing-policy', heading: 'Example Purchasing Follow-up Policy › Overdue goods', excerpt: 'An issued purchase order line with outstanding quantity is overdue.' },
      { id: 'c3', documentId: 'doc-guide', title: 'product-guide', heading: null, excerpt: 'Sensor guide.' },
    ],
  }
  const response = { intent: 'knowledge_retrieval', answerSource: 'knowledge', language: 'en-US', conclusion: { summary: 'Escalate after two business days.' }, keyEvidence: [], reviewCards: [], rag }
  const entry = aiSkillAuditEntry({ response, facts: null, message: question, latencyMs: 12, knowledge: aiKnowledgeAuditBlock(rag) })
  assert.equal(entry.action, 'ai_skill_answered')
  assert.equal(entry.summary, 'Assistant answered with knowledge_retrieval from workspace documents.')
  assert.equal(entry.metadata.answerSource, 'knowledge')
  assert.equal(entry.metadata.queryHash, aiSkillQueryHash(question))
  assert.deepEqual(entry.metadata.knowledge, { mode: 'excerpt', citationCount: 3, documentIds: ['doc-policy', 'doc-guide'] })
  // Codes and ids only: no question, passage or answer text.
  const stored = JSON.stringify(entry)
  for (const text of [question, 'two business days', 'Follow-up and escalation', 'Sensor guide']) assert.equal(stored.includes(text), false, text)
})

test('a skill answer has no knowledge block', () => {
  const entry = aiSkillAuditEntry({ response: { intent: 'purchase_orders', answerSource: 'skill', keyEvidence: [{ entityId: 'PO-1' }], reviewCards: [] }, facts: null, message: 'Which POs are late?', latencyMs: 5 })
  assert.equal(entry.metadata.knowledge, undefined)
  assert.equal(entry.summary, 'Assistant answered with purchase_orders from workspace data.')
})
