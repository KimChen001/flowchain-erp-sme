import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, language = 'en-US') {
  const response = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York', workspaceName: 'FlowChain Operations' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
}

test('report library and every available builder subject are English', async ({ page }) => {
  await login(page);
  await page.goto('/app/reports/library');
  const library = page.getByTestId('report-library-v2');
  await expect(library.getByRole('heading', { name: 'Report library', exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'Open report', exact: true })).toHaveCount(5);
  await expect(library).not.toContainText(/[\u3400-\u9fff]/);
  for (const label of ['My reports', 'Team reports', 'Recently opened']) {
    await library.getByText(label, { exact: true }).click();
    await expect(library).not.toContainText(/[\u3400-\u9fff]/);
  }
  await library.getByRole('button', { name: 'Create report', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create report' });
  for (const subject of ['purchase_orders', 'sales_orders', 'inventory_balances', 'supplier_invoices', 'suppliers']) {
    await dialog.getByLabel('Business subject', { exact: true }).selectOption(subject);
    await expect(dialog).not.toContainText(/[\u3400-\u9fff]/);
  }
  await dialog.getByRole('button', { name: 'Save private report' }).click();
  await expect(page.getByText('Enter a report name', { exact: true })).toBeVisible();
});

test('English create, clone, share and delete preserve report identity', async ({ page }) => {
  await login(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app/reports/library');
  const library = page.getByTestId('report-library-v2');
  await library.getByRole('button', { name: 'Create report', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create report' });
  const name = `Purchasing review ${Date.now()}`;
  await dialog.getByLabel('Report name', { exact: true }).fill(name);
  await dialog.getByRole('checkbox', { name: 'Purchase order amount', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save private report' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Report created', { exact: true })).toBeVisible();
  await library.getByText('My reports', { exact: true }).click();
  await expect(library.getByText(name, { exact: true })).toBeVisible();
  await library.getByRole('button', { name: `Copy ${name}`, exact: true }).click();
  await expect(library.getByText(`${name} (Copy)`, { exact: true })).toBeVisible();
  await library.getByRole('button', { name: `Share ${name}`, exact: true }).click();
  await library.getByText('Team reports', { exact: true }).click();
  await expect(library.getByText(name, { exact: true })).toBeVisible();
  await expect(library).not.toContainText(/[\u3400-\u9fff]/);
  page.once('dialog', async prompt => { expect(prompt.message()).toBe(`Delete ${name}?`); await prompt.accept(); });
  await library.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await expect(library.getByText(name, { exact: true })).toHaveCount(0);
  await library.getByText('My reports', { exact: true }).click();
  page.once('dialog', prompt => prompt.accept());
  await library.getByRole('button', { name: `Delete ${name} (Copy)`, exact: true }).click();
  await expect(library.getByText(`${name} (Copy)`, { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('library keeps Chinese available through language settings', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/reports/library');
  await expect(page.getByTestId('report-library-v2').getByRole('heading', { name: '报表库', exact: true })).toBeVisible();
  await page.getByTestId('report-library-v2').getByRole('button', { name: '基于模板创建报表' }).click();
  await expect(page.getByRole('dialog', { name: '基于模板创建报表' })).toBeVisible();
});

test('failed report-library loads show a localized retry state', async ({ page }) => {
  await login(page);
  await page.route('**/api/report-views', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.goto('/app/reports/library');
  await expect(page.getByRole('alert')).toContainText('Could not load the report library');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});
