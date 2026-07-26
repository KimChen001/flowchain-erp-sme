import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import {
  buildAiSuggestionsWorkbenchV2,
  FORBIDDEN_AI_SUGGESTIONS_ACTION_PATTERN,
  FORBIDDEN_AI_SUGGESTIONS_TECHNICAL_PATTERN,
} from './ai-suggestions-workbench-v2.mjs'
import { handleAiSuggestionsWorkbenchRoute } from '../routes/ai-suggestions-workbench.routes.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/sourceObjectType|targetEntityType|entityType|draftType|payload|raw|moduleId/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('AI suggestions workbench returns expected top-level contract', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb(), { generatedAt: '2026-07-06T00:00:00.000Z' })
  for (const key of ['summary', 'suggestions', 'draftPreviews', 'auditTrail', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(workbench, key), key)
  }
  assert.equal(workbench.dataScopeLabel, '当前工作区数据')
  assert.ok(workbench.suggestions.length >= 4)
  assert.ok(workbench.draftPreviews.length >= 1)
  assert.ok(workbench.auditTrail.length >= 1)
})

test('summary counts are derived from suggestions and draft previews', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb())
  const count = (category) => workbench.suggestions.filter((item) => item.category === category).length
  assert.equal(workbench.summary.totalSuggestionCount, workbench.suggestions.length)
  assert.equal(workbench.summary.poSuggestionCount, count('po'))
  assert.equal(workbench.summary.inventorySuggestionCount, count('inventory'))
  assert.equal(workbench.summary.supplierSuggestionCount, count('supplier'))
  assert.equal(workbench.summary.financeSuggestionCount, count('finance'))
  assert.equal(workbench.summary.dataQualitySuggestionCount, count('data_quality'))
  assert.equal(workbench.summary.draftAvailableCount, workbench.draftPreviews.length)
  assert.equal(workbench.summary.highPriorityCount, workbench.suggestions.filter((item) => item.priority === 'high').length)
  assert.equal(workbench.summary.dataLimitedCount, workbench.suggestions.filter((item) => item.dataLimitations.length).length)
})

test('suggestions cover at least four business categories', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb())
  const categories = new Set(workbench.suggestions.map((item) => item.category))
  const covered = ['po', 'inventory', 'supplier', 'finance', 'data_quality'].filter((category) => categories.has(category))
  assert.ok(covered.length >= 4, covered.join(','))
})

test('each suggestion is evidence-backed review-first and navigable', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb())
  for (const item of workbench.suggestions) {
    for (const key of ['id', 'title', 'category', 'priority', 'sourceObjectLabel', 'conclusion', 'whyNow', 'businessImpact', 'suggestedAction']) {
      assert.ok(item[key], `${item.id} ${key}`)
    }
    assert.ok(item.keyEvidence.length >= 1, item.id)
    assert.ok(item.navigationLinks.length >= 1, item.id)
    assert.ok(Array.isArray(item.dataLimitations), item.id)
    assert.equal(item.reviewRequired, true, item.id)
    assert.equal(item.previewOnly, true, item.id)
  }
})

test('draft previews are preview-only and human reviewed', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb())
  assert.ok(workbench.draftPreviews.length >= 1)
  assert.ok(workbench.draftPreviews.every((draft) => draft.previewOnly === true))
  assert.ok(workbench.draftPreviews.every((draft) => draft.requiresHumanReview === true || draft.reviewRequired === true))
  assert.ok(workbench.draftPreviews.every((draft) => draft.navigationLinks.length >= 1))
})

test('audit trail is business-readable and avoids forbidden wording', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb())
  const text = visibleText(workbench.auditTrail)
  assert.doesNotMatch(text, FORBIDDEN_AI_SUGGESTIONS_ACTION_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_AI_SUGGESTIONS_TECHNICAL_PATTERN)
})

test('visible workbench text avoids forbidden execution and technical wording', () => {
  const workbench = buildAiSuggestionsWorkbenchV2(loadDb())
  const text = visibleText(workbench)
  assert.doesNotMatch(text, FORBIDDEN_AI_SUGGESTIONS_ACTION_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_AI_SUGGESTIONS_TECHNICAL_PATTERN)
})

test('empty data returns limitations and minimum structure without throwing', () => {
  const workbench = buildAiSuggestionsWorkbenchV2({})
  assert.ok(Array.isArray(workbench.suggestions))
  assert.ok(Array.isArray(workbench.draftPreviews))
  assert.ok(Array.isArray(workbench.auditTrail))
  assert.ok(workbench.dataLimitations.length >= 1)
  assert.equal(workbench.summary.totalSuggestionCount, workbench.suggestions.length)
})

test('AI suggestions route returns workbench payload', async () => {
  let status = 0
  let body = null
  const handled = await handleAiSuggestionsWorkbenchRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/ai-suggestions-workbench', 'http://localhost'),
    db: loadDb(),
    send: (_res, code, payload) => { status = code; body = payload },
  })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.ok(body?.summary)
  assert.ok(body?.suggestions?.length >= 1)
})
