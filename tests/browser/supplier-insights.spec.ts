import { expect, test, type Page } from '@playwright/test';

// Supplier list metrics (docs/supplier-tiers-design.md, T2). FlowChain
// suggests no tier (owner decision 2026-10-09).
async function login(page: Page, language = 'en-US', role = 'manager') {
  const response = await page.request.post('/api/auth/login', { data: { email: `${role}@example.com`, name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return { Authorization: `Bearer ${session.token}` };
}

test('the list shows metrics without tiers or suggestions, and metrics follow the reader', async ({ page }) => {
  const headers = await login(page);
  const stamp = Date.now();
  const source = `Quarry Fittings ${stamp}`;
  const sourceId = (await (await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: `SUG-A-${stamp}`, supplierName: source, defaultCurrency: 'USD' } })).json()).supplier.id;
  const insights = await (await page.request.get('/api/master-data/supplier-insights', { headers })).json();
  expect(insights.suppliers[sourceId]).not.toHaveProperty('suggestion');

  // The list: metrics in their columns, no tier and no suggestion.
  await page.goto('/app/master-data/suppliers');
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(row(source)).toHaveCount(1);
  await expect(row(source).locator('td').nth(4)).toHaveText('0');
  await expect(row(source).getByTestId('supplier-tier-chip')).toHaveCount(0);
  await expect(page.getByTestId('supplier-suggestion-differs')).toHaveCount(0);
  await expect(page.getByTestId('supplier-review-suggestions-open')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Review suggestions/ })).toHaveCount(0);

  // The detail page keeps its tier panel, with no suggestion card.
  await page.goto(`/app/master-data/suppliers/${sourceId}`);
  await expect(page.getByTestId('supplier-tier-panel')).toBeVisible();
  await expect(page.getByTestId('supplier-tier-suggestion')).toHaveCount(0);
  await expect(page.getByTestId('supplier-accept-suggestion')).toHaveCount(0);

  // A viewer may not see prices: spend is hidden, the counts are not.
  const viewer = await page.context().newPage();
  await login(viewer, 'en-US', 'viewer');
  await viewer.goto('/app/master-data/suppliers');
  await viewer.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const viewerRow = viewer.getByRole('row').filter({ hasText: source });
  await expect(viewerRow.locator('td').nth(4)).toHaveText('—');
  await expect(viewerRow.locator('td').nth(5)).toHaveText('0');
});

async function createSupplier(page: Page, headers: Record<string, string>, code: string, name: string) {
  const created = await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: code, supplierName: name, defaultCurrency: 'USD' } });
  expect(created.status()).toBe(201);
  return (await created.json()).supplier as { id: string; version: number };
}

// Supplier evaluation (owner decision 2026-10-09): indicators per supplier
// with the tier a person sets, filtered by tier.
test('Supplier evaluation filters by tier, and a manager sets a tier there with a reason', async ({ page }) => {
  const headers = await login(page);
  const stamp = Date.now();
  const alder = `Alder Castings ${stamp}`;
  const brook = `Brook Labels ${stamp}`;
  const alderId = (await createSupplier(page, headers, `EVAL-A-${stamp}`, alder)).id;
  const brookSupplier = await createSupplier(page, headers, `EVAL-B-${stamp}`, brook);
  expect((await page.request.patch(`/api/master-data/suppliers/${brookSupplier.id}/tier`, { headers, data: { tier: 2, reason: 'Regular labels with a second source', expectedVersion: brookSupplier.version } })).status()).toBe(200);

  await page.goto('/app/master-data/supplier-evaluation');
  // The Suppliers sub-nav, with this tab's page header.
  await expect(page.getByTestId('module-subnav').getByRole('link')).toHaveText(['Suppliers', 'Supplier evaluation', 'Supplier risks']);
  await expect(page.getByTestId('page-title')).toHaveText('Supplier evaluation');
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(row(alder)).toHaveCount(1);
  await expect(row(brook).getByTestId('supplier-tier-chip')).toHaveText('Tier 2');
  await expect(row(alder).getByTestId('supplier-tier-chip')).toHaveText('Not tiered');
  // The indicators sit beside the tier: no orders yet, so no spend and no open POs.
  await expect(row(alder).locator('td').nth(3)).toHaveText('0');
  await expect(row(alder).locator('td').nth(4)).toHaveText('0');
  await expect(page.getByTestId('supplier-evaluation-count')).toHaveText('2 suppliers, 2 shown');

  // Tier is a dropdown filter.
  const tierFilter = page.getByLabel('Tier filter', { exact: true });
  await tierFilter.selectOption('2');
  await expect(row(alder)).toHaveCount(0);
  await expect(row(brook)).toHaveCount(1);
  await expect(page.getByTestId('supplier-evaluation-count')).toHaveText('2 suppliers, 1 shown');
  await tierFilter.selectOption('none');
  await expect(row(brook)).toHaveCount(0);
  await expect(row(alder)).toHaveCount(1);

  // Setting a tier needs a reason; it is saved with an audit row.
  await row(alder).getByTestId('supplier-evaluation-set-tier').click();
  const form = page.getByTestId('supplier-tier-form');
  await form.getByLabel('Tier 1 Strategic', { exact: true }).check();
  await form.getByRole('button', { name: 'Save tier' }).click();
  await expect(form.getByText('Enter a reason of 3 to 500 characters.', { exact: true })).toBeVisible();
  await form.getByLabel('Reason').fill('Sole source of the cast housing');
  await form.getByRole('button', { name: 'Save tier' }).click();
  await expect(form).toHaveCount(0);
  await expect(row(alder)).toHaveCount(0);
  await tierFilter.selectOption('1');
  await expect(row(alder).getByTestId('supplier-tier-chip')).toHaveText('Tier 1');
  const detail = await (await page.request.get(`/api/master-data/suppliers/${alderId}`, { headers })).json();
  expect(detail.supplier.tierHistory[0]).toMatchObject({ kind: 'tier', fromTier: null, toTier: 1, reason: 'Sole source of the cast housing', acceptedSuggestion: false });
  await expect(page.locator('main')).not.toContainText(/[㐀-鿿]/);

  // A viewer sees the indicators and tiers but cannot set one.
  const viewer = await page.context().newPage();
  await login(viewer, 'en-US', 'viewer');
  await viewer.goto('/app/master-data/supplier-evaluation');
  await viewer.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const viewerRow = viewer.getByRole('row').filter({ hasText: alder });
  await expect(viewerRow.getByTestId('supplier-tier-chip')).toHaveText('Tier 1');
  await expect(viewerRow.locator('td').nth(3)).toHaveText('—');
  await expect(viewer.getByTestId('supplier-evaluation-set-tier')).toHaveCount(0);

  // In Chinese the tabs and the tier filter read in Chinese.
  const chinese = await page.context().newPage();
  await login(chinese, 'zh-CN');
  await chinese.goto('/app/master-data/supplier-evaluation');
  await expect(chinese.getByTestId('module-subnav').getByRole('link')).toHaveText(['供应商', '供应商评估', '供应商风险']);
  await expect(chinese.getByLabel('层级筛选', { exact: true }).locator('option').first()).toContainText('全部层级');
});

test('Supplier risks says when there is nothing to follow up', async ({ page }) => {
  await login(page);
  await page.goto('/app/master-data/supplier-risks');
  await expect(page.getByTestId('page-title')).toHaveText('Supplier risks');
  await expect(page.getByTestId('supplier-risks-count')).toHaveText('0 issues, 0 shown');
  await expect(page.getByTestId('supplier-risks-empty')).toContainText('No open supplier issues');
  await expect(page.getByTestId('supplier-risks-empty')).toContainText('Nothing needs following up now.');
});

// Supplier prices (owner decision 2026-10-09): every item-supplier link, read
// only, the reference price masked without procurement.prices.read.
test('Supplier prices lists every item-supplier link and hides the reference price from a reader without prices', async ({ page }) => {
  const headers = await login(page);
  const stamp = Date.now();
  const supplier = await createSupplier(page, headers, `PRICE-${stamp}`, `Cedar Valves ${stamp}`);
  const item = await page.request.post('/api/master-data/items', { headers, data: { sku: `PRC-${stamp}`, itemName: `Gate valve ${stamp}`, baseUnit: 'EA' } });
  expect(item.status()).toBe(201);
  const itemId = (await item.json()).item.itemId;
  const linked = await page.request.post(`/api/master-data/items/${itemId}/suppliers`, { headers, data: { supplierId: supplier.id, supplierSku: `CV-${stamp}`, referencePrice: 12.5, currency: 'USD', minimumOrderQuantity: 40, leadTimeDays: 9, preferred: true } });
  expect(linked.status()).toBe(201);

  await page.goto('/app/master-data/item-suppliers');
  await expect(page.getByTestId('module-subnav').getByRole('link')).toHaveText(['Items', 'Supplier prices']);
  await expect(page.getByTestId('page-title')).toHaveText('Supplier prices');
  await page.getByLabel('Search supplier prices', { exact: true }).fill(String(stamp));
  const row = page.getByTestId('item-supplier-price-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('link', { name: `PRC-${stamp}` })).toHaveAttribute('href', `/app/master-data/items/${itemId}`);
  await expect(row.getByRole('link', { name: `Cedar Valves ${stamp}` })).toHaveAttribute('href', `/app/master-data/suppliers/${supplier.id}`);
  await expect(row.getByTestId('item-supplier-price')).toHaveText('12.50');
  await expect(row).toContainText(`CV-${stamp}`);
  await expect(row).toContainText('9 days');
  await expect(row).toContainText('Preferred');
  await expect(page.getByTestId('item-supplier-prices-hidden')).toHaveCount(0);

  const viewer = await page.context().newPage();
  await login(viewer, 'en-US', 'viewer');
  await viewer.goto('/app/master-data/item-suppliers');
  await viewer.getByLabel('Search supplier prices', { exact: true }).fill(String(stamp));
  const viewerRow = viewer.getByTestId('item-supplier-price-row');
  await expect(viewerRow).toHaveCount(1);
  await expect(viewerRow.getByTestId('item-supplier-price')).toHaveText('—');
  await expect(viewerRow.getByTestId('item-supplier-price').locator('span')).toHaveAttribute('title', 'Hidden for your role');
  await expect(viewerRow).toContainText(`CV-${stamp}`);
  await expect(viewer.getByTestId('item-supplier-prices-hidden')).toHaveText('Reference prices are hidden for your role.');
  await expect(viewer.locator('main')).not.toContainText('12.5');
});
