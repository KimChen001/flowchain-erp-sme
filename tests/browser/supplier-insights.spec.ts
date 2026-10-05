import { expect, test, type Page } from '@playwright/test';

// Supplier list metrics and tier suggestions (docs/supplier-tiers-design.md, T2).
async function login(page: Page, language = 'en-US', role = 'manager') {
  const response = await page.request.post('/api/auth/login', { data: { email: `${role}@example.com`, name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return { Authorization: `Bearer ${session.token}` };
}

test('suggestions state their facts, are accepted one by one or all shown, and metrics follow the reader', async ({ page }) => {
  const headers = await login(page);
  const stamp = Date.now();
  const source = `Quarry Fittings ${stamp}`;
  const idle = `Rowan Couriers ${stamp}`;
  const sourceId = (await (await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: `SUG-A-${stamp}`, supplierName: source, defaultCurrency: 'USD' } })).json()).supplier.id;
  await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: `SUG-B-${stamp}`, supplierName: idle, defaultCurrency: 'USD' } });
  const item = await page.request.post('/api/master-data/items', { headers, data: { sku: `SUG-${stamp}`, itemName: `Fitting ${stamp}`, baseUnit: 'EA', defaultSupplierId: sourceId } });
  expect(item.status()).toBe(201);

  // The list: metrics in their columns, a mark where the suggestion differs.
  await page.goto('/app/master-data/suppliers');
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(row(source)).toHaveCount(1);
  await expect(row(source).getByTestId('supplier-suggestion-differs')).toHaveCount(1);
  await expect(row(idle).getByTestId('supplier-suggestion-differs')).toHaveCount(1);

  // The detail: the suggestion and its facts; accepting opens the form prefilled.
  await page.goto(`/app/master-data/suppliers/${sourceId}`);
  const card = page.getByTestId('supplier-tier-suggestion');
  await expect(card.getByTestId('supplier-suggested-tier')).toHaveText('Tier 2 Core');
  await expect(card).toContainText(`Preferred supplier of SUG-${stamp}; other sources are not recorded`);
  await expect(card).toContainText('No committed purchase orders in the last 12 months');
  await card.getByTestId('supplier-accept-suggestion').click();
  const form = page.getByTestId('supplier-tier-form');
  await expect(form.getByLabel('Tier 2 Core', { exact: true })).toBeChecked();
  await expect(form.getByLabel('Reason')).toHaveValue(`No committed purchase orders in the last 12 months; Preferred supplier of SUG-${stamp}; other sources are not recorded`);
  await form.getByRole('button', { name: 'Save tier' }).click();
  const panel = page.getByTestId('supplier-tier-panel');
  await expect(panel.getByTestId('supplier-tier-chip')).toHaveText('Tier 2 Core');
  await expect(panel.getByTestId('supplier-tier-history')).toContainText('Suggestion accepted');
  await expect(page.getByTestId('supplier-tier-suggestion')).toHaveCount(0);

  // Review suggestions: what the list shows and is not tiered, accepted after a confirmation.
  await page.goto('/app/master-data/suppliers');
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  await expect(row(idle)).toHaveCount(1);
  await page.getByTestId('supplier-review-suggestions-open').click();
  const review = page.getByTestId('supplier-review-suggestions');
  await expect(review.getByRole('row')).toHaveCount(2);
  await expect(review).toContainText(idle);
  await expect(review).toContainText('Not a source of any active item');
  await review.getByTestId('supplier-accept-all').click();
  await review.getByTestId('supplier-accept-all-confirm').click();
  await expect(review.getByRole('row').filter({ hasText: idle })).toContainText('Accepted');
  await review.getByRole('button', { name: 'Back to the list' }).click();
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  await expect(row(idle).getByTestId('supplier-tier-chip')).toHaveText('Tier 3');
  await expect(row(idle).getByTestId('supplier-suggestion-differs')).toHaveCount(0);
  await expect(row(source).getByTestId('supplier-tier-chip')).toHaveText('Tier 2');

  // A viewer may not see prices: spend is hidden, the counts are not.
  const viewer = await page.context().newPage();
  await login(viewer, 'en-US', 'viewer');
  await viewer.goto('/app/master-data/suppliers');
  await viewer.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const viewerRow = viewer.getByRole('row').filter({ hasText: source });
  await expect(viewerRow.locator('td').nth(5)).toHaveText('—');
  await expect(viewerRow.locator('td').nth(6)).toHaveText('0');
  await expect(viewer.getByTestId('supplier-review-suggestions-open')).toHaveCount(0);
});
