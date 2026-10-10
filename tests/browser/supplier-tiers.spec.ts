import { expect, test, type Page } from '@playwright/test';

// Supplier tiers and business owners (docs/supplier-tiers-design.md, T1).
async function login(page: Page, language = 'en-US', role = 'manager') {
  const response = await page.request.post('/api/auth/login', { data: { email: `${role}@example.com`, name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return { headers: { Authorization: `Bearer ${session.token}` }, userName: String(session.user?.name || '') };
}

async function createSupplier(page: Page, headers: Record<string, string>, code: string, name: string) {
  const created = await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: code, supplierName: name, defaultCurrency: 'USD' } });
  expect(created.status()).toBe(201);
  return (await created.json()).supplier.id as string;
}

test('a manager sets a tier with a reason and an owner; the list shows no tier and Managed by me follows', async ({ page }) => {
  const { headers, userName } = await login(page);
  const stamp = Date.now();
  const strategic = `Keystone Motors ${stamp}`;
  const other = `Larch Office Supply ${stamp}`;
  const strategicId = await createSupplier(page, headers, `TIER-A-${stamp}`, strategic);
  await createSupplier(page, headers, `TIER-B-${stamp}`, other);

  await page.goto('/app/master-data/suppliers');
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(row(strategic)).toHaveCount(1);
  // Tiers are not on the supplier list (owner decision 2026-10-09): no tier
  // tabs, no tier column. They are set on Supplier evaluation.
  await expect(page.getByTestId('supplier-list-tab-all')).toContainText('2');
  await expect(page.getByTestId('supplier-list-tab-mine')).toBeVisible();
  for (const tab of ['1', '2', '3', 'none']) await expect(page.getByTestId(`supplier-list-tab-${tab}`)).toHaveCount(0);
  await expect(row(strategic).getByTestId('supplier-tier-chip')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Tier', exact: true })).toHaveCount(0);

  // The tier needs a reason; the panel says what each tier means.
  await page.goto(`/app/master-data/suppliers/${strategicId}`);
  const panel = page.getByTestId('supplier-tier-panel');
  await expect(panel).toContainText('Nobody has decided yet.');
  await panel.getByTestId('supplier-change-tier').click();
  const form = panel.getByTestId('supplier-tier-form');
  await form.getByLabel('Tier 1 Strategic', { exact: true }).check();
  await form.getByRole('button', { name: 'Save tier' }).click();
  await expect(form.getByText('Enter a reason of 3 to 500 characters.', { exact: true })).toBeVisible();
  await form.getByLabel('Reason').fill('Only approved source of the drive motor');
  await form.getByRole('button', { name: 'Save tier' }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.getByTestId('supplier-tier-chip')).toHaveText('Tier 1 Strategic');
  await expect(panel.getByTestId('supplier-tier-reason')).toHaveText('Only approved source of the drive motor');
  await expect(panel.getByTestId('supplier-tier-history')).toContainText('Not tiered → Tier 1');
  await expect(panel).not.toContainText(/[㐀-鿿]/);

  // The owner comes from the workspace's active users.
  await panel.getByTestId('supplier-change-owner').click();
  await panel.getByLabel('Business owner', { exact: true }).selectOption({ label: userName });
  await panel.getByRole('button', { name: 'Save owner' }).click();
  await expect(panel.getByTestId('supplier-owner')).toHaveText(userName);
  await expect(panel.getByTestId('supplier-tier-history')).toContainText(`No owner → ${userName}`);

  // Back on the list: Managed by me picks it out.
  await page.goto('/app/master-data/suppliers');
  await page.getByLabel('Search suppliers', { exact: true }).fill(String(stamp));
  await expect(row(strategic)).toContainText(userName);
  await expect(page.getByTestId('supplier-list-tab-mine')).toContainText('1');
  await page.getByTestId('supplier-list-tab-mine').click();
  await expect(row(strategic)).toHaveCount(1);
  await expect(row(other)).toHaveCount(0);
});

test('the tier panel reads in Chinese, and read-only users cannot change it', async ({ page }) => {
  const { headers } = await login(page, 'zh-CN');
  const stamp = Date.now();
  const id = await createSupplier(page, headers, `TIER-ZH-${stamp}`, `Juniper Tools ${stamp}`);
  const detail = await (await page.request.get(`/api/master-data/suppliers/${id}`, { headers })).json();
  const set = await page.request.patch(`/api/master-data/suppliers/${id}/tier`, { headers, data: { tier: 2, reason: 'Regular orders with other sources', expectedVersion: detail.supplier.version } });
  expect(set.status()).toBe(200);
  await page.goto(`/app/master-data/suppliers/${id}`);
  const panel = page.getByTestId('supplier-tier-panel');
  await expect(panel.getByTestId('supplier-tier-chip')).toHaveText('二级 · 核心');
  await expect(panel).toContainText('常用的已批准来源，有替代来源或影响有限。');
  await expect(panel.getByTestId('supplier-change-tier')).toHaveText('调整层级');
  await expect(panel.getByTestId('supplier-tier-history')).toContainText('未分级 → 二级');

  const viewer = await page.context().newPage();
  await login(viewer, 'en-US', 'viewer');
  await viewer.goto(`/app/master-data/suppliers/${id}`);
  const readOnly = viewer.getByTestId('supplier-tier-panel');
  await expect(readOnly.getByTestId('supplier-tier-chip')).toHaveText('Tier 2 Core');
  await expect(readOnly.getByTestId('supplier-change-tier')).toHaveCount(0);
  await expect(readOnly.getByTestId('supplier-change-owner')).toHaveCount(0);
});
