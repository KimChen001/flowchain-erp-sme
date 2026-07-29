import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

test('R197 contextual AI action contract is review-first and non-mutating', () => {
  const actionSource = source('src', 'domain', 'contextual-ai', 'actions.ts')
  assert.match(actionSource, /mutationAllowed:\s*false/)
  assert.match(actionSource, /requiresReview:\s*true/)
  assert.match(actionSource, /explain_po_delay/)
  assert.match(actionSource, /explain_sku_shortage/)
  assert.match(actionSource, /trace_receiving_exception/)
  assert.match(actionSource, /trace_invoice_matching_failure/)
  assert.match(actionSource, /preview_replenishment_draft/)
  assert.match(actionSource, /preview_supplier_followup_draft/)
  assert.doesNotMatch(actionSource, /approve|pay|post|submit|send\(/i)
})

test('R193 PO delayed risk stays aligned with open partially received PO logic', () => {
  const readiness = source('src', 'domain', 'contextual-ai', 'readiness.ts')
  assert.match(readiness, /receivedQty\s*<\s*orderedQty/)
  assert.match(readiness, /\["已完成", "已关闭", "已取消"\]/)
  assert.match(readiness, /ETA .* has passed and open quantity/)
  assert.match(source('src', 'modules', 'purchasing', 'Page.tsx'), /poDelayedRisk/)
})

test('R194 inventory warnings avoid dead supplier-gated replenishment navigation', () => {
  const inventory = source('src', 'modules', 'inventory', 'Page.tsx')
  assert.match(inventory, /<EntityLink kind="item"/)
  assert.doesNotMatch(inventory, /新建采购申请/)
  assert.doesNotMatch(inventory, /维护供应商关系/)
  assert.doesNotMatch(inventory, /\/app\/procurement\/requests\?itemId=/)
  assert.match(inventory, /\/api\/inventory\/balances/)
  assert.doesNotMatch(inventory, /预览 PR|auto-create|自动创建 PR/)
})

test('R195-R196 GRN and invoice contextual actions do not auto-post approve or pay', () => {
  const receiving = source('src', 'modules', 'receiving', 'Page.tsx')
  const invoice = source('src', 'modules', 'procurement', 'SupplierInvoiceRegister.tsx')
  assert.match(receiving, /不自动关闭、不自动收货过账、不修改库存/)
  assert.match(invoice, /不自动审批、不付款、不做应付过账/)
  assert.match(receiving, /解释收货异常/)
  assert.match(invoice, /解释匹配失败/)
})

test('R198 AI insight panel is embedded and not a standalone left navigation module', () => {
  const panel = source('src', 'components', 'ai', 'ContextualAIInsightPanel.tsx')
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const app = source('src', 'app', 'FlowChainApp.tsx')
  const floating = source('src', 'modules', 'ai-assistant', 'Panel.tsx')
  assert.match(panel, /上下文洞察/)
  assert.match(panel, /不自动改业务数据/)
  assert.match(panel, /仅生成可复核内容 · 需要人工确认 · 不自动修改业务记录/)
  assert.match(panel, /仅生成可复核内容 · 需要人工确认 · 不自动修改业务记录/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']/)
  assert.doesNotMatch(routes, /label:\s*["']AI Command Center["']/)
  assert.doesNotMatch(routes, /label:\s*["']Ask AI["']/)
  assert.match(app, /<span>\{t\("nav\.ai"\)\}<\/span>/)
  assert.match(app, /<AiPanel\s+moduleId=\{activeModule\}/)
  assert.match(floating, /data-testid="ai-assistant-root"/)
  assert.match(floating, /data-testid="ai-assistant-toggle"/)
  assert.match(floating, /export default function FloatingAiAssistant/)
})

test('R200 business modules remain navigable and provider keys are not introduced', () => {
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const allChangedSources = [
    source('src', 'domain', 'contextual-ai', 'actions.ts'),
    source('src', 'domain', 'contextual-ai', 'readiness.ts'),
    source('src', 'components', 'ai', 'ContextualAIInsightPanel.tsx'),
    source('src', 'modules', 'purchasing', 'Page.tsx'),
    source('src', 'modules', 'inventory', 'Page.tsx'),
    source('src', 'modules', 'receiving', 'Page.tsx'),
    source('src', 'modules', 'procurement', 'SupplierInvoiceRegister.tsx'),
  ].join('\n')
  for (const id of ['procurement', 'inventory', 'master-data', 'finance', 'imports']) {
    assert.match(routes, new RegExp(`id:\\s*["']${id}`))
  }
  assert.match(routes, /legacyIds:\s*\["srm",\s*"srm:master"\]/)
  assert.doesNotMatch(allChangedSources, /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|AI_PROVIDER_ENABLED/)
})
