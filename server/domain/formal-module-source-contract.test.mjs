import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const entries = [
  'src/modules/inventory/Page.tsx',
  'src/modules/sales/Page.tsx',
  'src/modules/procurement/Page.tsx',
  'src/modules/purchase-requests/Page.tsx',
  'src/modules/suppliers/Page.tsx',
  'src/modules/finance/Page.tsx',
  'src/modules/srm/Page.tsx',
  'src/modules/overview/Page.tsx',
  'src/app/FlowChainApp.tsx',
  'src/components/business/BusinessEntityDetailPage.tsx',
]
const formalRoots = entries.map(file => path.dirname(path.resolve(root, file)))
const importPattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g

function resolveImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(existsSync)
}

function activeFormalGraph() {
  const queue = entries.map(file => path.resolve(root, file)), visited = new Set()
  while (queue.length) {
    const file = queue.shift()
    if (!file || visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const resolved = resolveImport(file, match[1])
      if (resolved && formalRoots.some(directory => resolved.startsWith(`${directory}${path.sep}`))) queue.push(resolved)
    }
  }
  return [...visited]
}

test('active formal module dependency graph cannot import fixture data modules', () => {
  const fixtureModule = ['de', 'mo', '-data'].join('')
  const violations = activeFormalGraph().filter(file => new RegExp(`(?:from\\s+|import\\s*\\()["'][^"']*${fixtureModule}`).test(readFileSync(file, 'utf8')))
  assert.deepEqual(violations.map(file => path.relative(root, file)), [])
  assert.equal(existsSync(path.resolve(root, 'src/modules/home')), false, 'home module is not present and therefore has no formal dependency graph to scan')
  assert.doesNotMatch(readFileSync(path.resolve(root, 'src/app/FlowChainApp.tsx'), 'utf8'), /demo-data/)
})

test('formal inventory and sales routes use authoritative runtime repositories without fallback', () => {
  const inventoryPage = readFileSync(path.resolve(root, 'src/modules/inventory/Page.tsx'), 'utf8')
  const inventoryRoute = readFileSync(path.resolve(root, 'server/routes/inventory.routes.mjs'), 'utf8')
  const salesRoute = readFileSync(path.resolve(root, 'server/routes/sales-demand.routes.mjs'), 'utf8')
  assert.doesNotMatch(inventoryPage, /inventoryItems|SKU_CATALOG|LOTS|SERIALS|TRANSFERS|COUNT_PLANS|VARIANCES|INVENTORY_MOVEMENT_LEDGER/)
  assert.match(inventoryRoute, /ctx\.repositories\?\.inventoryRead/)
  assert.match(salesRoute, /repositories\?\.salesOrders/)
  assert.doesNotMatch(salesRoute, /sales-demand-read-model|scm-demo|demo-data/)
})

test('every formal procurement route renders the runtime procurement panel', () => {
  const registry = readFileSync(path.resolve(root, 'src/app/routeRegistry.tsx'), 'utf8')
  for (const id of ['workbench', 'requests', 'rfq', 'orders', 'receiving', 'invoices', 'three-way-match', 'returns']) {
    const line = registry.split(/\r?\n/).find(row => row.includes(`/app/procurement/${id}`))
    assert.ok(line, `missing procurement route ${id}`)
    assert.doesNotMatch(line, /panelId:\s*["']finance["']/)
  }
})
