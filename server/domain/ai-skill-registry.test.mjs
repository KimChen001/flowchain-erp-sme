import test from 'node:test'
import assert from 'node:assert/strict'
import { authorize } from '../auth/authorization-service.mjs'
import { FIELD_GROUP_PERMISSION, defaultRoleTemplates } from '../auth/permission-catalog.mjs'
import { AI_SKILL_COPY, aiSkillCountText, aiSkillList, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_DRAFT_PERMISSION, AI_SKILL_FIELD_GROUPS, AI_SKILL_IDS, AI_SKILL_REGISTRY, AI_SKILL_SOURCES, aiSkillVisibility, toToolDescriptors, toolsFor } from './ai-skill-registry.mjs'

const CJK = /[㐀-鿿]/
const actorFor = (roleKey, tenantId = 'tenant-skills') => ({
  complete: true, authenticated: true, tenantId, userId: `${roleKey}-user`, roleIds: [roleKey], inactiveRoleIds: [],
  permissionCodes: new Set(defaultRoleTemplates.find((template) => template.roleKey === roleKey)?.permissions || []),
  permissionSourceRoleIds: new Map(), readWarehouseIds: new Set(), operateWarehouseIds: new Set(),
})

test('every skill copy key has an English and a Chinese text', () => {
  for (const [key, { en, zh }] of Object.entries(AI_SKILL_COPY)) {
    assert.equal(typeof en, 'string', key)
    assert.equal(typeof zh, 'string', key)
    assert.ok(en.length > 0, `${key} en`)
    assert.doesNotMatch(en, CJK, `${key} en has no Chinese`)
    // Placeholders are the same in both languages, so no value is dropped.
    const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(names(zh), names(en), `${key} placeholders`)
  }
  assert.equal(aiSkillText('today.title', 'en-US', { count: 3, date: 'Sep 29, 2026' }), '3 items need attention today (as of Sep 29, 2026)')
  assert.equal(aiSkillText('today.title', 'zh-CN', { count: 3, date: 'Sep 29, 2026' }), '今天需要关注 3 项（截至 Sep 29, 2026）')
  assert.equal(aiSkillCountText('records.title', 0, 'en-US'), 'No records are missing required fields')
  assert.equal(aiSkillCountText('records.title', 1, 'en-US'), '1 record needs more data')
  assert.equal(aiSkillList(['a', 'b', 'c'], 'en-US'), 'a, b and c')
  assert.equal(aiSkillList(['a', 'b'], 'zh-CN'), 'a和b')
  assert.throws(() => aiSkillText('not.a.key', 'en-US'), /Unknown AI skill copy key/)
})

test('every registry entry is read-only, bilingual and uses known permission codes', () => {
  assert.deepEqual(AI_SKILL_IDS, ['today_priorities', 'highest_risk_items', 'records_needing_data', 'prepare_action_draft', 'workspace_metrics', 'purchase_orders', 'pending_approvals', 'inventory_availability', 'invoice_summary', 'capability_overview'])
  // None contains "missing", which the client reads as an insufficient-data answer.
  for (const id of AI_SKILL_IDS) assert.doesNotMatch(id, /missing/)
  assert.match(AI_SKILL_IDS.find((id) => id.includes('draft')), /draft/)
  const actor = actorFor('workspace-administrator')
  for (const entry of AI_SKILL_REGISTRY) {
    assert.equal(entry.mode, 'read', entry.id)
    assert.equal(entry.writesBusinessData, false, entry.id)
    assert.ok(entry.title.en && entry.title.zh && entry.description.en && entry.description.zh, entry.id)
    assert.equal(entry.inputSchema.additionalProperties, false, `${entry.id} input schema is strict`)
    for (const permission of entry.requiredAnyPermission) assert.doesNotThrow(() => authorize({ actor, permission, tenantId: actor.tenantId }), permission)
    for (const source of entry.sources) assert.ok(AI_SKILL_SOURCES[source], `${entry.id} source ${source}`)
    for (const group of entry.fieldGroups) assert.ok(FIELD_GROUP_PERMISSION[AI_SKILL_FIELD_GROUPS[group]], `${entry.id} field group ${group}`)
  }
  for (const { permission } of Object.values(AI_SKILL_SOURCES)) assert.doesNotThrow(() => authorize({ actor, permission, tenantId: actor.tenantId }))
  assert.doesNotThrow(() => authorize({ actor, permission: AI_SKILL_DRAFT_PERMISSION, tenantId: actor.tenantId }))
})

test('toolsFor hides skills and sources the actor cannot read', () => {
  assert.deepEqual(toolsFor(actorFor('workspace-administrator')).map((entry) => entry.id), AI_SKILL_IDS)
  // An intake uploader reads no business sources: only the capability answer.
  assert.deepEqual(toolsFor(actorFor('intake-uploader')).map((entry) => entry.id), ['capability_overview'])
  // A missing or foreign-tenant actor gets no data skill.
  assert.deepEqual(toolsFor(null).map((entry) => entry.id), ['capability_overview'])
  assert.deepEqual(toolsFor({ ...actorFor('workspace-administrator'), complete: false }).map((entry) => entry.id), ['capability_overview'])

  // A procurement specialist cannot read supplier invoices; invoice amounts are hidden with them.
  const buyer = aiSkillVisibility(actorFor('procurement-specialist'))
  assert.equal(buyer.sources.supplier_invoices, false)
  assert.equal(buyer.sources.purchase_orders, true)
  assert.equal(buyer.amounts.invoice_amounts, false)
  assert.equal(buyer.amounts.purchase_order_amounts, true)
  assert.equal(buyer.canDraft, true)
  // A read-only viewer sees the records but no amounts, and cannot prepare procurement drafts.
  const viewer = aiSkillVisibility(actorFor('read-only-viewer'))
  assert.equal(viewer.sources.supplier_invoices, true)
  assert.deepEqual(viewer.amounts, { purchase_order_amounts: false, invoice_amounts: false })
  assert.equal(viewer.canDraft, false)
})

test('tool descriptors are stable, read-only and filtered by the actor', () => {
  const descriptors = toToolDescriptors(actorFor('workspace-administrator'))
  assert.deepEqual(descriptors.map(({ name, mode, writesBusinessData, requiresUserReview, sensitivityGroups }) => ({ name, mode, writesBusinessData, requiresUserReview, sensitivityGroups })), [
    { name: 'today_priorities', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: ['procurement_prices', 'finance_amounts'] },
    { name: 'highest_risk_items', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: ['procurement_prices', 'finance_amounts'] },
    { name: 'records_needing_data', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: [] },
    { name: 'prepare_action_draft', mode: 'read', writesBusinessData: false, requiresUserReview: true, sensitivityGroups: ['procurement_prices', 'finance_amounts'] },
    { name: 'workspace_metrics', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: ['procurement_prices', 'finance_amounts'] },
    { name: 'purchase_orders', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: ['procurement_prices'] },
    { name: 'pending_approvals', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: ['procurement_prices'] },
    { name: 'inventory_availability', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: [] },
    { name: 'invoice_summary', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: ['finance_amounts'] },
    { name: 'capability_overview', mode: 'read', writesBusinessData: false, requiresUserReview: false, sensitivityGroups: [] },
  ])
  for (const descriptor of descriptors) assert.doesNotMatch(descriptor.description, CJK)
  assert.deepEqual(toToolDescriptors(actorFor('intake-uploader')).map((descriptor) => descriptor.name), ['capability_overview'])
})
