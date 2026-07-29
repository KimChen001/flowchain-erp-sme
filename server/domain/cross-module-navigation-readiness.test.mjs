import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

test('R202 linked record resolver maps business objects and disables unavailable routes', () => {
  const links = source('src', 'lib', 'businessLinks.ts')
  for (const route of [
    'procurement:requests',
    'procurement:rfq',
    'procurement:orders',
    'inventory',
    'srm:master',
    'procurement:receiving',
    'procurement:invoices',
    'inventory:movements',
    'inventory:exceptions',
  ]) {
    assert.match(links, new RegExp(route.replace(':', '[:]')))
  }
  assert.match(links, /Route not available yet/)
  assert.match(links, /Record not found in current data/)
  assert.match(links, /Relationship exists, but detail page is not available/)
  assert.match(links, /detailAvailable:\s*false/)
})

test('R203 workflow return context is compact encoded and label-safe', () => {
  const context = source('src', 'lib', 'workflowContext.ts')
  assert.match(context, /export function buildReturnContext/)
  assert.match(context, /export function parseReturnContext/)
  assert.match(context, /export function buildReturnUrl/)
  assert.match(context, /export function formatReturnLabel/)
  assert.match(context, /sourceQuery.*slice\(0,\s*80\)/)
  assert.match(context, /返回 今日行动/)
  assert.match(context, /返回上一级/)
  assert.doesNotMatch(context, /password|secret|token|apiKey|OPENAI_API_KEY/i)
})

test('R204-R205 business back link and related records panel render graceful navigation states', () => {
  const back = source('src', 'components', 'navigation', 'BusinessBackLink.tsx')
  const panel = source('src', 'components', 'navigation', 'RelatedRecordsPanel.tsx')
  const doc = source('src', 'components', 'document', 'DocumentShell.tsx')
  assert.match(back, /formatReturnLabel/)
  assert.match(back, /data-testid="business-back-link"/)
  assert.match(panel, /groupBusinessLinkedRecords/)
  assert.match(panel, /record\.routeAvailable/)
  assert.match(panel, /record\.disabledReason/)
  assert.match(doc, /RelatedRecordsPanel/)
  assert.match(doc, /returnContext/)
  assert.match(doc, /source:\s*"documentEvidence"/)
})

test('R206-R208 AI insight, cockpit, and transactional links preserve workflow return context', () => {
  const aiPanel = source('src', 'components', 'ai', 'ContextualAIInsightPanel.tsx')
  const cockpit = source('src', 'modules', 'overview', 'TodayCockpitPanel.tsx')
  const purchasing = source('src', 'modules', 'purchasing', 'Page.tsx')
  const receiving = source('src', 'modules', 'receiving', 'Page.tsx')
  const invoice = source('src', 'modules', 'procurement', 'SupplierInvoiceRegister.tsx')
  assert.match(aiPanel, /onNavigateRecord/)
  assert.match(aiPanel, /source:\s*"contextualAiInsight"/)
  assert.doesNotMatch(aiPanel, /Back to AI Assistant/)
  assert.match(cockpit, /returnLabel:\s*"返回 今日行动"/)
  assert.match(cockpit, /source:\s*"todayCockpit"/)
  assert.match(purchasing, /returnLabel:\s*`返回采购订单 \$\{order\.po\}`/)
  assert.match(purchasing, /buildGrnRows\(selectedPO, facts\)/)
  assert.match(purchasing, /buildInvoiceRows\(selectedPO, facts\)/)
  assert.match(receiving, /returnLabel:\s*`返回收货单 \$\{selectedGrn\.grn\}`/)
  assert.match(receiving, /"grn", selectedGrn\.grn/)
  assert.match(invoice, /returnLabel:\s*`返回供应商发票 \$\{selectedInvoice\.invoiceNumber\}`/)
  assert.match(invoice, /"invoice", selectedInvoice\.invoiceNumber/)
})

test('R210 guardrails keep AI embedded provider-free and non-mutating', () => {
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const app = source('src', 'app', 'FlowChainApp.tsx')
  const changed = [
    source('src', 'components', 'ai', 'ContextualAIInsightPanel.tsx'),
    source('src', 'components', 'document', 'DocumentShell.tsx'),
    source('src', 'modules', 'overview', 'TodayCockpitPanel.tsx'),
    source('src', 'modules', 'purchasing', 'Page.tsx'),
    source('src', 'modules', 'receiving', 'Page.tsx'),
    source('src', 'modules', 'procurement', 'SupplierInvoiceRegister.tsx'),
  ].join('\n')
  assert.match(app, /setFocusReturnContext/)
  assert.match(app, /buildReturnContext/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']/)
  assert.doesNotMatch(routes, /label:\s*["']AI Command Center["']/)
  assert.doesNotMatch(routes, /label:\s*["']Ask AI["']/)
  assert.doesNotMatch(changed, /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|AI_PROVIDER_ENABLED/)
  assert.match(changed, /mutationAllowed:\s*false/)
  assert.match(changed, /requiresReview:\s*true/)
})
