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
