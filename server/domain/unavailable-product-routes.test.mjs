import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isUnavailableProductRoute, withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('frozen and unavailable surfaces are recognised by route id and path', () => {
  for (const target of ['finance:settlement', 'finance:reconciliation-detail', 'mobile-operations:settlement-detail', 'forecast', 'forecast:mrp', 'imports', 'imports:failed',
    '/app/finance/settlement', '/app/finance/settlement/SET-1', '/app/finance/reconciliation', '/app/mobile/settlements/SET-1', '/app/forecast/mrp', '/app/imports?source=x',
    'sales:delivery', 'sales:delivery:new', 'sales:delivery:edit', 'sales:delivery-detail', 'sales:receipts', 'sales:receipts:new', 'sales:receipt-detail',
    '/app/sales/deliveries', '/app/sales/deliveries/new', '/app/sales/deliveries/DN-1/edit', '/app/sales/receipts', '/app/sales/receipts/SR-1']) {
    assert.equal(isUnavailableProductRoute(target), true, target)
  }
  // Shipments are created and posted from the sales order and shipment pages, which stay available.
  for (const target of ['finance:invoices', 'finance:bank-reconciliation', 'procurement:orders', 'forecasting', '/app/finance/invoices', '/app/finance/bank-reconciliation', '/app/reports/finance',
    'sales:orders', 'sales:order-detail', 'sales:shipment-detail', '/app/sales/orders', '/app/sales/orders/SO-1', '/app/sales/shipments/SHIP-1', '', null]) {
    assert.equal(isUnavailableProductRoute(target), false, String(target))
  }
})

test('assistant responses drop links and actions into those surfaces', () => {
  const cleaned = withoutUnavailableProductLinks({ links: [{ moduleId: 'imports' }, { moduleId: 'procurement:orders' }], actions: [{ kind: 'deep_link', target: 'forecast:mrp' }], linkTarget: { moduleId: 'finance:settlement' } })
  assert.deepEqual(cleaned, { links: [{ moduleId: 'procurement:orders' }], actions: [], linkTarget: null })
  // Evidence keeps its text; only the link goes.
  assert.deepEqual(withoutUnavailableProductLinks({ keyEvidence: [{ label: 'Data quality', moduleId: 'imports', linkTarget: { moduleId: 'imports' } }] }), { keyEvidence: [{ label: 'Data quality', linkTarget: null }] })
  // The data limitation answer used to send the user to the retired imports page.
  const response = buildAiResponseContractV2({}, { message: '哪些数据依据不完整？', moduleId: 'overview' })
  assert.ok(response)
  assert.doesNotMatch(JSON.stringify(response), /"(moduleId|target|targetModule|route)":"(imports|forecast)[:"]/)
})

test('no in-page link or search entry points into a frozen or unavailable surface', () => {
  // The frozen modules' own pages and the route tables may name their routes;
  // nothing else may link to them.
  const allowed = new Set([
    'src/app/routeRegistry.tsx', 'src/app/routes/route-manifest.ts', 'src/app/capabilityRouteGuard.ts',
    'src/components/business/businessEntityRoutes.ts', 'src/i18n/I18n.tsx',
    'src/modules/finance/InternalSettlementWorkbench.tsx', 'src/modules/finance/Page.tsx', 'src/modules/forecast/Page.tsx', 'src/modules/imports/Page.tsx',
    // Kept code whose output is filtered: evidence links are hidden at render,
    // the planning answer and the report catalog drop these targets, and the
    // mobile settlement task loop is switched off.
    'src/lib/evidenceLinks.ts', 'server/domain/ai-chat-status.mjs',
    'server/domain/mobile-operations-service.mjs', 'server/domain/report-semantic-layer.mjs',
  ])
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!/\.(tsx?|mjs)$/.test(name) || /\.test\.mjs$/.test(name)) continue
      const file = relative(root, path).split(sep).join('/')
      if (allowed.has(file)) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/["'`](\/app\/(?:finance\/settlement|finance\/reconciliation|mobile\/settlements|sales\/deliveries|sales\/receipts|forecast|imports)\b[^"'`]*|(?:finance:settlement|finance:reconciliation|sales:delivery(?::new|:edit|-detail)?|sales:receipts(?::new)?|sales:receipt-detail|forecast:[a-z-]+|imports:[a-z-]+))["'`]/g)) {
        offenders.push(`${file}: ${match[1]}`)
      }
    }
  }
  walk(join(root, 'src'))
  walk(join(root, 'server'))
  assert.deepEqual(offenders, [])
})

test('suggestion, control tower, review and legacy assistant routes filter those links', () => {
  for (const file of ['server/routes/ai-suggestions-workbench.routes.mjs', 'server/routes/today-cockpit.routes.mjs', 'server/routes/review-first-action-workflow.routes.mjs', 'server/routes/ai-runtime-gateway.routes.mjs', 'server/domain/ai-chat-status.mjs', 'server/domain/ai-response-contract-v2.mjs']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /withoutUnavailableProductLinks\(/, file)
  }
})
