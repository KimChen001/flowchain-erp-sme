import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, language = 'en-US', role = 'manager') {
  const response = await page.request.post('/api/auth/login', { data: { email: `${role}@example.com`, name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return { Authorization: `Bearer ${session.token}` };
}

test('supplier create and edit persist, preserve currency, and reject duplicates and stale changes', async ({ page }) => {
  const headers = await login(page);
  await page.goto('/app/master-data/suppliers');
  await page.getByRole('button', { name: 'New supplier', exact: true }).click();
  const form = page.getByTestId('supplier-form');
  await expect(form).not.toContainText(/[\u3400-\u9fff]/);
  // Workspace currency is CNY even though the interface is English.
  await expect(form.getByLabel('Default currency', { exact: true })).toHaveValue('CNY');
  await form.getByRole('button', { name: 'Save supplier' }).click();
  await expect(form.getByText('Enter a supplier code.', { exact: true })).toBeVisible();
  const code = `UAT-${Date.now()}`;
  await form.getByLabel('Supplier code', { exact: true }).fill(code);
  await form.getByLabel('Supplier name', { exact: true }).fill('Boston Components');
  await form.getByLabel('Email', { exact: true }).fill('invalid');
  await form.getByRole('button', { name: 'Save supplier' }).click();
  await expect(form.getByText('Enter a valid email address.', { exact: true })).toBeVisible();
  await form.getByLabel('Email', { exact: true }).fill('contact@example.com');
  await form.getByLabel('Default currency', { exact: true }).selectOption('USD');
  await form.getByLabel('Categories', { exact: true }).fill('Electronics, Components');
  await form.locator('summary').filter({ hasText: 'Tax and bank details' }).click();
  await expect(form).not.toContainText(/[\u3400-\u9fff]/);
  await form.getByLabel('Business registration ID', { exact: true }).fill('DEMO-REG-1');
  const created = page.waitForResponse(response => response.url().endsWith('/api/master-data/suppliers') && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Save supplier' }).click();
  const result = await created; expect(result.status()).toBe(201);
  const { supplier } = await result.json();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(form.getByLabel('Supplier name', { exact: true })).toHaveValue('Boston Components');
  await expect(form.getByLabel('Default currency', { exact: true })).toHaveValue('USD');
  await form.getByLabel('Short name', { exact: true }).fill('Boston');
  await form.getByLabel('Categories', { exact: true }).fill('');
  await form.getByRole('button', { name: 'Save supplier' }).click();
  await expect(form).toHaveCount(0);
  const persisted = await page.request.get(`/api/master-data/suppliers/${supplier.id}`, { headers });
  expect((await persisted.json()).supplier).toMatchObject({ shortName: 'Boston', defaultCurrency: 'USD', creditCode: 'DEMO-REG-1', categories: [], version: 2 });
  const duplicate = await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: code, supplierName: 'Duplicate', defaultCurrency: 'USD' } });
  expect(duplicate.status()).toBe(409);
  const stale = await page.request.patch(`/api/master-data/suppliers/${supplier.id}`, { headers, data: { supplierName: 'Stale', expectedVersion: 1 } });
  expect(stale.status()).toBe(409);
});

test('Chinese supplier form and cancel stay available', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/master-data/suppliers');
  await page.getByRole('button', { name: '新增供应商', exact: true }).click();
  await expect(page.getByTestId('supplier-form').getByRole('heading', { name: '基本信息' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('supplier-form')).toHaveCount(0);
});

test('read-only users cannot create suppliers', async ({ page }) => {
  const headers = await login(page, 'en-US', 'viewer');
  const response = await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: 'DENIED', supplierName: 'Denied' } });
  expect(response.status()).toBe(403);
});
