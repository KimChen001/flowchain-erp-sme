import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const aiPanelSource = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/app/FlowChainApp.tsx', import.meta.url), 'utf8')
const inventorySource = readFileSync(new URL('../../src/modules/inventory/Page.tsx', import.meta.url), 'utf8')
const purchasingSource = readFileSync(new URL('../../src/modules/purchasing/Page.tsx', import.meta.url), 'utf8')
const purchaseRequestsSource = readFileSync(new URL('../../src/modules/purchase-requests/CanonicalProcurementPanel.tsx', import.meta.url), 'utf8')
const rfqSource = readFileSync(new URL('../../src/modules/rfq/Page.tsx', import.meta.url), 'utf8')
const receivingSource = readFileSync(new URL('../../src/modules/receiving/Page.tsx', import.meta.url), 'utf8')
const actionDraftSource = readFileSync(new URL('../../src/modules/action-drafts/ActionDraftReviewShell.tsx', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../../src/components/ui/index.tsx', import.meta.url), 'utf8')

test('AI assistant UI has duplicate request guard, abort, and timeout fallback', () => {
  assert.match(aiPanelSource, /requestInFlightRef/)
  assert.match(aiPanelSource, /AbortController/)
  assert.match(aiPanelSource, /setTimeout\(\(\) =>/)
  assert.match(aiPanelSource, /displaySafeAssistantRecoveryMessage/)
  assert.match(aiPanelSource, /当前工作区数据暂时未能完整读取，仍可先从相关模块查看来源证据并进入人工复核。/)
  assert.match(aiPanelSource, /草稿预览 · 人工复核 · 不提交 · 不外发 · 不写库存/)
  assert.match(aiPanelSource, /retryPrompt/)
  assert.match(aiPanelSource, /retryPrompt: message/)
  assert.match(aiPanelSource, /askAi\(message\.retryPrompt \|\| ""\)/)
  assert.match(aiPanelSource, /重试/)
  assert.match(aiPanelSource, /disabled=\{asking\}/)
  assert.match(aiPanelSource, /Check npm run api, \/api\/health, SCM_API_PROXY_TARGET, stale node on 8787/)
  assert.match(aiPanelSource, /UTF-8 byte bodies for PowerShell Chinese prompt tests/)
})

test('global focus recovery preserves canonical return context without redundant focus chrome', () => {
  assert.match(uiSource, /export function RecoveryActions/)
  assert.match(appSource, /buildReturnContext/)
  assert.match(appSource, /setFocusReturnContext/)
  assert.match(appSource, /returnLabel:\s*searchFocus\?\.entityId/)
  assert.doesNotMatch(appSource, />\s*当前聚焦\s*</)
  assert.doesNotMatch(appSource, /data-testid="focus-banner"/)
})

test('inventory SKU focus renders a local detail and canonical entity navigation', () => {
  assert.match(inventorySource, /data-testid="inventory-local-detail"/)
  assert.match(inventorySource, /库存详情/)
  assert.match(inventorySource, /<EntityLink kind="item"/)
  assert.match(inventorySource, /movements:\s*\{\s*url:\s*"\/api\/inventory\/movements"/)
  assert.match(inventorySource, /exceptions:\s*\{\s*url:\s*"\/api\/inventory\/exceptions"/)
})

test('PO detail and draft review shell use shared recovery actions', () => {
  assert.match(purchasingSource, /<RecoveryActions/)
  assert.match(purchasingSource, /返回采购订单/)
  assert.match(purchasingSource, /查看三单匹配/)
  assert.match(actionDraftSource, /<RecoveryActions/)
  assert.match(actionDraftSource, /取消草稿/)
  assert.doesNotMatch(actionDraftSource, /onConfirmSafeAction|记录复核结果/)
  assert.match(actionDraftSource, /文本草稿编辑器/)
  assert.match(actionDraftSource, /不外发/)
})

test('procurement PR RFQ and GRN details expose canonical recovery paths', () => {
  assert.match(purchaseRequestsSource, /返回采购申请列表/)
  assert.match(purchaseRequestsSource, /"procurement:orders"/)
  assert.match(purchaseRequestsSource, /entityType:\s*"purchase_order"/)
  assert.match(rfqSource, /<RecoveryActions/)
  assert.match(rfqSource, /返回采购工作台/)
  assert.match(receivingSource, /<RecoveryActions/)
  assert.match(receivingSource, /返回采购工作台/)
})
