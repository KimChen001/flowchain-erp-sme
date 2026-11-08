import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('the assistant panel offers at most four starter cards and a Stop button while it answers', async () => {
  const panel = await read('src/modules/ai-assistant/Panel.tsx')
  assert.match(panel, /emptyPrompts\.slice\(0, 4\)/)
  assert.match(panel, /"ai-assistant-stop"/)
  assert.doesNotMatch(panel, /getContextualQuickPrompts/)
})

test('settings, PO, master data and reports expose consolidated product surfaces', async () => {
  const [routes, settings, purchasing, masterRoutes, entityRoutes, reports] = await Promise.all([
    read('src/app/routeRegistry.tsx'), read('src/modules/settings/Page.tsx'), read('src/modules/purchasing/Page.tsx'),
    read('server/routes/master-data.routes.mjs'), read('src/components/business/businessEntityRoutes.ts'), read('src/modules/reports/BiDashboard.tsx'),
  ])
  for (const path of ['company', 'roles', 'numbering', 'review', 'modules', 'ai', 'audit', 'advanced']) assert.match(routes, new RegExp(`/app/settings/${path}`))
  assert.doesNotMatch(settings, /ControlledSettingsView/)
  assert.match(purchasing, /min-w-\[1150px\]/)
  assert.match(purchasing, /sticky left-0/)
  assert.match(purchasing, /sticky right-0/)
  assert.match(masterRoutes, /url\.pathname === '\/api\/master-data'/)
  for (const type of ['warehouse', 'bin', 'payment_term', 'tax_code']) assert.match(entityRoutes, new RegExp(`${type}:`))
  assert.match(reports, /调整当前视图/)
  // Period comparison is not applied by the report service, so it is not offered.
  assert.doesNotMatch(reports, /aria-label=\{copy\("比较方式"\)\}/)
  assert.doesNotMatch(reports, /<Card className="flex flex-wrap items-end gap-3 p-3" data-testid="dashboard-configuration"/)
  assert.match(purchasing, /data-testid="po-fulfillment-focus"/)
  assert.match(purchasing, /AI 已定位：收货、发票差异与建议下一步/)
})
