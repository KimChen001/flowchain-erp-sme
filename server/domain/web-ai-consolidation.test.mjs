import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('focused AI presentation limits priorities, actions, evidence and follow-ups', async () => {
  const [model, renderer, panel] = await Promise.all([
    read('src/domain/ai/focused-response.ts'), read('src/components/ai/AiResponseV2Renderer.tsx'), read('src/modules/ai-assistant/Panel.tsx'),
  ])
  assert.match(model, /evidence\.slice\(0, 3\)/)
  assert.match(model, /availableActions\.slice\(1, 3\)/)
  assert.match(model, /evidence: evidence\.slice\(0, 5\)/)
  assert.match(model, /\.slice\(0, 2\)/)
  assert.match(renderer, /<details data-testid=/)
  assert.match(panel, /emptyPrompts\.slice\(0, 4\)/)
  assert.match(panel, /取消请求/)
  assert.doesNotMatch(panel, /getContextualQuickPrompts/)
  assert.match(model, /explicitDraftRequest \? \[\.\.\.drafts, \.\.\.navigation\] : navigation/)
  assert.match(renderer, /data-action-kind="view_business_object"/)
  assert.match(renderer, /data-action-kind="generate_text_draft"/)
  assert.match(renderer, /data-action-kind="create_formal_business_draft"/)
  assert.match(renderer, /focusArea: "receiving-invoice-variance"/)
})

test('settings, PO, master data and reports expose consolidated product surfaces', async () => {
  const [routes, settings, purchasing, masterRoutes, entityRoutes, reports, rfqWorkbench] = await Promise.all([
    read('src/app/routeRegistry.tsx'), read('src/modules/settings/Page.tsx'), read('src/modules/purchasing/Page.tsx'),
    read('server/routes/master-data.routes.mjs'), read('src/components/business/businessEntityRoutes.ts'), read('src/modules/reports/BiDashboard.tsx'),
    read('src/components/procurement/CanonicalDownstreamPanel.tsx'),
  ])
  for (const path of ['company', 'roles', 'numbering', 'review', 'modules', 'ai', 'audit', 'advanced']) assert.match(routes, new RegExp(`/app/settings/${path}`))
  assert.doesNotMatch(settings, /ControlledSettingsView/)
  assert.match(purchasing, /min-w-\[1200px\]/)
  assert.match(purchasing, /sticky left-0/)
  assert.match(purchasing, /sticky right-0/)
  assert.match(masterRoutes, /url\.pathname === '\/api\/master-data'/)
  for (const type of ['warehouse', 'bin', 'payment_term', 'tax_code']) assert.match(entityRoutes, new RegExp(`${type}:`))
  assert.match(reports, /调整当前视图/)
  assert.match(reports, /aria-label="比较方式"/)
  assert.doesNotMatch(reports, /<Card className="flex flex-wrap items-end gap-3 p-3" data-testid="dashboard-configuration"/)
  assert.match(purchasing, /data-testid="po-fulfillment-focus"/)
  assert.match(purchasing, /AI 已定位：收货、发票差异与建议下一步/)
  assert.match(rfqWorkbench, /data-testid="formal-rfq-draft-form"/)
})
