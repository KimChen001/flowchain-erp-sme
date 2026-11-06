import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { auditEntityIdText, auditEntityLabel, auditSummaryText } from '../../src/i18n/auditSummaries.ts'
import { unitLabel } from '../../src/i18n/unitLabels.ts'

const CJK = /[㐀-鿿]/
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

// The audit log shows a stored summary in the interface language, from its
// action and the numbers inside it. Plan ids, skill ids, session ids and
// class names are never shown; the stored row is unchanged.
test('assistant answers read as their topic, never as a skill or plan id', () => {
  const plan = { action: 'ai_skill_answered', summary: 'Assistant answered with business_query_plan_v1 from workspace data.', entity: { type: 'ai_skill', id: 'business_query_plan_v1' } }
  assert.equal(auditSummaryText(plan, 'en-US'), 'Assistant answered: A business question')
  assert.equal(auditSummaryText(plan, 'zh-CN'), '助手已回答：业务查询')
  const today = { action: 'ai_skill_answered', summary: 'Assistant answered with today_priorities from workspace data.' }
  assert.equal(auditSummaryText(today, 'en-US'), "Assistant answered: Today's priorities")
  assert.equal(auditSummaryText({ action: 'ai_skill_answered', summary: 'Assistant answered with mystery_skill from workspace data.' }, 'zh-CN'), '助手已根据工作区数据回答。')
  assert.equal(auditSummaryText({ action: 'ai_skill_answered', summary: 'Assistant answered with knowledge_retrieval from workspace documents.' }, 'en-US'), 'Assistant answered from workspace documents.')
  for (const language of ['en-US', 'zh-CN']) assert.doesNotMatch(auditSummaryText(plan, language), /business_query|plan_v1|_/)
  assert.equal(auditEntityLabel('ai_skill', 'en-US'), 'Assistant answer')
  assert.equal(auditEntityIdText('ai_skill', 'business_query_plan_v1'), '')
})

test('sign-in rows name the session in words and hide its id', () => {
  const session = { action: 'session_created', summary: 'Signed in with an email link.', entity: { type: 'WorkspaceSession', id: '3f2a1c9e-1b2c-4d5e-8f90-123456789abc' } }
  assert.equal(auditSummaryText(session, 'en-US'), 'Signed in with an email link.')
  assert.equal(auditSummaryText(session, 'zh-CN'), '已通过邮件链接登录。')
  assert.equal(auditEntityLabel('WorkspaceSession', 'en-US'), 'Sign-in session')
  assert.equal(auditEntityLabel('WorkspaceSession', 'zh-CN'), '登录会话')
  assert.equal(auditEntityIdText('WorkspaceSession', session.entity.id), '')
  assert.equal(auditEntityLabel('WorkspaceSignInLink', 'zh-CN'), '登录链接')
  assert.equal(auditSummaryText({ summary: 'Ended 2 signed-in sessions.' }, 'zh-CN'), '已结束 2 个登录会话。')
  // A class name the map does not know still reads as words.
  assert.equal(auditEntityLabel('SomeNewDocument', 'en-US'), 'Some new document')
  // A record number stays as recorded; a uuid does not show.
  assert.equal(auditEntityIdText('PurchaseRequest', 'PR-202611-0003'), 'PR-202611-0003')
  assert.equal(auditEntityIdText('PurchaseRequest', '0f8fad5b-d9cb-469f-a165-70867728950e'), '')
})

test('document events read in both languages with their numbers and reasons', () => {
  const posted = { action: 'sales_shipment_posted', summary: 'Shipment SH-202611-0001 posted.' }
  assert.equal(auditSummaryText(posted, 'en-US'), 'Shipment SH-202611-0001 posted.')
  assert.equal(auditSummaryText(posted, 'zh-CN'), '发货单 SH-202611-0001 已过账。')
  assert.equal(auditSummaryText({ summary: 'Shipment SH-202611-0001 cancelled: Customer changed the date' }, 'zh-CN'), '发货单 SH-202611-0001 已取消：Customer changed the date')
  assert.equal(auditSummaryText({ summary: 'Sales order SO-202611-0002 hold completed.' }, 'en-US'), 'Sales order SO-202611-0002 put on hold.')
  assert.equal(auditSummaryText({ summary: 'Receiving GRN-202611-0004 posted to inventory.' }, 'en-US'), 'Receipt GRN-202611-0004 posted to inventory.')
  assert.equal(auditSummaryText({ summary: 'Receiving GRN-202611-0004 posted to inventory.' }, 'zh-CN'), '收货单 GRN-202611-0004 已过账入库。')
  assert.equal(auditSummaryText({ summary: 'Created purchase request PR-202611-0003.' }, 'zh-CN'), '已创建采购申请 PR-202611-0003。')
  assert.equal(auditSummaryText({ action: 'purchase_order_approve', summary: 'approve purchase order PO-202611-0001.' }, 'en-US'), 'Approved purchase order PO-202611-0001.')
  assert.equal(auditSummaryText({ action: 'purchase_order_issue', summary: 'issue purchase order PO-202611-0001.' }, 'zh-CN'), '已下达采购订单 PO-202611-0001。')
  assert.equal(auditSummaryText({ summary: 'review settings updated.' }, 'en-US'), 'Settings updated: Review policies.')
  assert.equal(auditSummaryText({ summary: 'Warehouse WH-02 set inactive' }, 'zh-CN'), '仓库 WH-02 已设为停用')
  // An unknown summary keeps its recorded text, with codes read as words.
  assert.equal(auditSummaryText({ summary: 'Recorded today_priorities once.' }, 'zh-CN'), 'Recorded today priorities once.')
  assert.equal(auditSummaryText({ action: 'some_action', summary: '' }, 'en-US'), 'Some action')
})

test('the audit log page renders summaries and entities through auditSummaries.ts', async () => {
  const page = await read('src/modules/settings/Page.tsx')
  assert.match(page, /\{auditSummaryText\(entry, language\)\}/)
  assert.match(page, /auditEntityIdText\(type, id\)/)
  assert.doesNotMatch(page, /title=\{entry\.entity\.type\}/)
  assert.doesNotMatch(page, /readableSummary\(entry\.summary\)/)
})

test('review policies show a label per id in both languages, sentence case in English', async () => {
  const [page, i18n, contract] = await Promise.all([read('src/modules/settings/Page.tsx'), read('src/i18n/I18n.tsx'), read('server/domain/workspace-settings-contract.mjs')])
  assert.match(page, /labelFor\(t, 'settings\.policy', policy\.id, policy\.name\)/)
  for (const id of [...contract.matchAll(/\{ id: '([a-z-]+)', name: '[^']+', enabled: true, reviewerRoles/g)].map((match) => match[1])) {
    const labels = [...i18n.matchAll(new RegExp(`"settings\\.policy\\.${id}": "([^"]+)"`, 'g'))].map((match) => match[1])
    assert.equal(labels.length, 2, id)
    assert.ok(labels.some((label) => CJK.test(label)), `${id} needs a Chinese label`)
    const english = labels.find((label) => !CJK.test(label))
    assert.match(english, /^[A-Z][a-z]+(?: [a-z]+)*$/, `${id} English label is sentence case`)
  }
})

test('unit labels cover the units seeds and imports use, in any case, and keep their signature', () => {
  for (const [code, zh] of [['pcs', '件'], ['EA', '个'], ['BOX', '箱'], ['case', '箱'], ['carton', '箱'], ['roll', '卷'], ['ft', '英尺'], ['M', '米'], ['kg', '千克'], ['set', '套'], ['pack', '包'], ['bag', '袋'], ['Pairs', '双'], ['pallet', '托'], ['sheet', '张'], ['dozen', '打']]) {
    assert.equal(unitLabel(code, 'zh-CN'), zh, code)
  }
  assert.equal(unitLabel('box', 'en-US', 1), 'box')
  assert.equal(unitLabel('box', 'en-US', 300), 'boxes')
  assert.equal(unitLabel('box', 'en-US'), 'boxes')
  assert.equal(unitLabel('drums of oil', 'zh-CN'), 'drums of oil')
  assert.equal(unitLabel(null, 'en-US'), '')
})

test('list titles are plural and the new receipt page is "New receipt"', async () => {
  const [i18n, copy] = await Promise.all([read('src/i18n/I18n.tsx'), read('src/i18n/workspaceCopy.ts')])
  assert.match(i18n, /"master-data:customers": "route\.customers"/)
  assert.match(i18n, /"master-data:tax-codes": "route\.taxCodes"/)
  assert.match(i18n, /"route\.customers": "Customers"/)
  assert.match(i18n, /"route\.taxCodes": "Tax codes"/)
  assert.match(copy, /'新建收货单': 'New receipt'/)
  assert.doesNotMatch(copy, /New receiving document/)
  assert.match(copy, /'交付风险': 'Shipment risks'/)
  assert.match(copy, /'询价单与报价': 'RFQs & quotations'/)
})
