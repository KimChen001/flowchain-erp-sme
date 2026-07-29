import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const registry = readFileSync(new URL('../../src/app/routeRegistry.tsx', import.meta.url), 'utf8');
const routeTypes = readFileSync(new URL('../../src/app/routes/route-types.ts', import.meta.url), 'utf8');
const entityRoutes = readFileSync(new URL('../../src/components/business/businessEntityRoutes.ts', import.meta.url), 'utf8');
const link = readFileSync(new URL('../../src/components/business/BusinessEntityLink.tsx', import.meta.url), 'utf8');

test('business route registry contains all required deep links and return metadata', () => {
  const paths = [
    '/app/procurement/requests/:id', '/app/procurement/rfq/:id', '/app/procurement/orders/:id', '/app/procurement/receiving/:id',
    '/app/finance/invoices/:id', '/app/finance/three-way-match/:id', '/app/finance/reconciliation/:id', '/app/finance/settlement/:id', '/app/finance/credit-memos/:id',
    '/app/master-data/suppliers/:id', '/app/master-data/items/:id', '/app/master-data/customers/:id',
    '/app/sales/orders/:id', '/app/sales/deliveries/:id', '/app/sales/receipts/:id', '/app/inventory/adjustments/:id',
  ];
  for (const path of paths) assert.match(registry, new RegExp(path.replace(/[/:]/g, (value) => `\\${value}`)));
  assert.match(routeTypes, /entityType\?: string/);
  assert.match(routeTypes, /entityIdParam\?: string/);
  assert.match(routeTypes, /returnListRouteId\?: string/);
  assert.match(entityRoutes, /businessEntityRouteRegistry/);
});

test('business links preserve native anchor semantics and return context', () => {
  assert.match(link, /<Link/);
  assert.match(link, /returnTo/);
  assert.match(link, /hover:underline/);
  assert.doesNotMatch(link, /preventDefault/);
  assert.doesNotMatch(link, /onClick/);
});

test('reports routes separate BI dashboards from report library', () => {
  for (const path of ['/app/reports/overview', '/app/reports/procurement', '/app/reports/sales', '/app/reports/inventory', '/app/reports/finance', '/app/reports/suppliers', '/app/reports/library']) assert.ok(registry.includes(path));
});
