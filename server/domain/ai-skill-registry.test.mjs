import test from 'node:test'
import assert from 'node:assert/strict'
import { authorize } from '../auth/authorization-service.mjs'
import { defaultRoleTemplates } from '../auth/permission-catalog.mjs'
import { AI_SKILL_COPY, aiSkillList, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_DRAFT_PERMISSION, AI_SKILL_SOURCES, aiSkillVisibility } from './ai-skill-registry.mjs'

const CJK = /[㐀-鿿]/
const actorFor = (roleKey, tenantId = 'tenant-skills') => ({
  complete: true, authenticated: true, tenantId, userId: `${roleKey}-user`, roleIds: [roleKey], inactiveRoleIds: [],
  permissionCodes: new Set(defaultRoleTemplates.find((template) => template.roleKey === roleKey)?.permissions || []),
  permissionSourceRoleIds: new Map(), readWarehouseIds: new Set(), operateWarehouseIds: new Set(),
})

test('every copy key has an English and a Chinese text', () => {
  for (const [key, { en, zh }] of Object.entries(AI_SKILL_COPY)) {
    assert.equal(typeof en, 'string', key)
    assert.equal(typeof zh, 'string', key)
    assert.ok(en.length > 0, `${key} en`)
    assert.doesNotMatch(en, CJK, `${key} en has no Chinese`)
    // Placeholders are the same in both languages, so no value is dropped.
    const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(names(zh), names(en), `${key} placeholders`)
  }
  assert.equal(aiSkillText('nav.open', 'en-US', { id: 'PO-001' }), 'Open PO-001')
  assert.equal(aiSkillText('nav.open', 'zh-CN', { id: 'PO-001' }), '打开 PO-001')
  assert.equal(aiSkillList(['a', 'b', 'c'], 'en-US'), 'a, b and c')
  assert.equal(aiSkillList(['发票', '订单'], 'zh-CN'), '发票和订单')
  // A number or a Latin name after 和 gets a space.
  assert.equal(aiSkillList(['2 张订单', '1 张发票'], 'zh-CN'), '2 张订单和 1 张发票')
  assert.equal(aiSkillList(['甲', 'b'], 'zh-CN'), '甲和 b')
  assert.throws(() => aiSkillText('not.a.key', 'en-US'), /Unknown AI skill copy key/)
})

test('every source the assistant reads uses a known permission code', () => {
  const actor = actorFor('workspace-administrator')
  for (const { permission } of Object.values(AI_SKILL_SOURCES)) assert.doesNotThrow(() => authorize({ actor, permission, tenantId: actor.tenantId }))
  assert.doesNotThrow(() => authorize({ actor, permission: AI_SKILL_DRAFT_PERMISSION, tenantId: actor.tenantId }))
})

test('the visibility hides the sources and amounts a role cannot read', () => {
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
  // An intake uploader reads no business source; a missing actor none at all.
  assert.ok(Object.values(aiSkillVisibility(actorFor('intake-uploader')).sources).every((value) => value === false))
  assert.ok(Object.values(aiSkillVisibility(null).sources).every((value) => value === false))
})
