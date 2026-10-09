import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The CSV import page: template download, a file with a bad row, the fix,
// the import, and the Chinese labels. Runs in the settings browser harness
// (scripts/run-settings-playwright.mjs), which enables FLOWCHAIN_ENABLE_DATA_IMPORT.

async function login(page: Page, language = 'en-US', role = 'manager') {
  const response = await page.request.post('/api/auth/login', { data: { email: `${role}@example.com`, name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return { Authorization: `Bearer ${session.token}` };
}

const csvFile = (name: string, lines: string[]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8') });

test('items: download the template, see a bad row, fix the file and import it', async ({ page }) => {
  const headers = await login(page);
  await page.goto('/app/master-data/items');
  await page.getByTestId('data-import-link-items').click();
  await expect(page).toHaveURL(/\/app\/master-data\/import\?type=items$/);
  const importPage = page.getByTestId('data-import-page');
  await expect(importPage.getByRole('heading', { name: 'Import data' })).toBeVisible();
  await expect(importPage).not.toContainText(/[㐀-鿿]/);

  const downloading = page.waitForEvent('download');
  await page.getByTestId('data-import-template').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('flowchain-items-template.csv');
  const template = readFileSync(await download.path() as string, 'utf8');
  expect(template.startsWith('﻿SKU,Item name,Category,Specification,Unit,')).toBeTruthy();

  const stamp = Date.now();
  await page.getByTestId('data-import-file').setInputFiles(csvFile('items.csv', ['SKU,Item name,Unit,Safety stock', `UI-${stamp}-1,Browser valve,EA,5`, `UI-${stamp}-2,Browser pump,,"1,000"`]));
  await page.getByTestId('data-import-check').click();
  await expect(page.getByTestId('data-import-counts')).toHaveText('2 rows: 1 to create, 0 already exist, 1 with errors');
  const badRow = page.getByTestId('data-import-row-3');
  await expect(badRow).toContainText('Error');
  await expect(badRow).toContainText('Safety stock: Write the number with digits and a decimal point only');
  await expect(badRow).toContainText('Unit: Enter a unit.');
  await page.getByTestId('data-import-errors-only').check();
  await expect(page.getByTestId('data-import-row-2')).toHaveCount(0);
  await expect(page.getByTestId('data-import-commit')).toHaveText(/Import 1 row$/);

  // Fixed in the file and uploaded again: nothing was written meanwhile.
  expect((await (await page.request.get('/api/master-data/items', { headers })).json()).items.some((item: { sku: string }) => item.sku === `UI-${stamp}-1`)).toBe(false);
  await page.getByTestId('data-import-file').setInputFiles(csvFile('items-fixed.csv', ['SKU,Item name,Unit,Safety stock', `UI-${stamp}-1,Browser valve,EA,5`, `UI-${stamp}-2,Browser pump,EA,1000`]));
  await page.getByTestId('data-import-check').click();
  await expect(page.getByTestId('data-import-counts')).toHaveText('2 rows: 2 to create, 0 already exist, 0 with errors');
  await page.getByTestId('data-import-commit').click();
  await expect(page.getByTestId('data-import-result-counts')).toHaveText('2 rows: 2 created, 0 already existed, 0 not imported');
  await expect(page.getByTestId('data-import-result-2')).toContainText('Created');
  const items = (await (await page.request.get('/api/master-data/items', { headers })).json()).items as Array<{ sku: string; safetyStock: number }>;
  expect(items.find(item => item.sku === `UI-${stamp}-2`)?.safetyStock).toBe(1000);

  const resultsDownload = page.waitForEvent('download');
  await page.getByTestId('data-import-download-results').click();
  expect((await resultsDownload).suggestedFilename()).toBe('flowchain-items-import-results.csv');

  // The same file again: every row already exists and is skipped.
  await page.getByRole('button', { name: 'Import another file' }).click();
  await page.getByTestId('data-import-file').setInputFiles(csvFile('items-fixed.csv', ['SKU,Item name,Unit,Safety stock', `UI-${stamp}-1,Renamed,EA,5`]));
  await page.getByTestId('data-import-check').click();
  await expect(page.getByTestId('data-import-row-2')).toContainText('Skipped — already exists');
  await expect(page.getByTestId('data-import-commit')).toBeDisabled();
});

test('the import page and its results read in Chinese', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/master-data/import?type=customers');
  const importPage = page.getByTestId('data-import-page');
  await expect(importPage.getByRole('heading', { name: '导入数据' })).toBeVisible();
  await expect(page.getByTestId('data-import-type-customers')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('data-import-type-opening-stock')).toHaveText('期初库存');
  await expect(page.getByTestId('data-import-template')).toHaveText('下载模板');
  await expect(page.getByTestId('data-import-check')).toHaveText('检查文件');
  const code = `CUST-UI-${Date.now()}`;
  await page.getByTestId('data-import-file').setInputFiles(csvFile('customers.csv', ['客户编号,客户名称,币种,邮箱', `${code},浏览器客户,,bad-email`]));
  await page.getByTestId('data-import-check').click();
  await expect(page.getByTestId('data-import-row-2')).toContainText('邮箱: 请填写有效邮箱。');
  await page.getByTestId('data-import-file').setInputFiles(csvFile('customers.csv', ['客户编号,客户名称,币种', `${code},浏览器客户,`]));
  await page.getByTestId('data-import-check').click();
  const row = page.getByTestId('data-import-row-2');
  await expect(row).toContainText('新建');
  // An empty customer currency stays empty: it is never guessed.
  await expect(row).toContainText('未记录');
  await page.getByTestId('data-import-commit').click();
  await expect(page.getByTestId('data-import-result-2')).toContainText('已创建');
  await page.getByRole('button', { name: '导入其他文件' }).click();
  await page.getByTestId('data-import-file').setInputFiles(csvFile('customers.csv', ['客户编号,客户名称', `${code},浏览器客户`]));
  await page.getByTestId('data-import-check').click();
  await expect(page.getByTestId('data-import-row-2')).toContainText('已存在，跳过');
  await page.getByTestId('data-import-type-opening-stock').click();
  await expect(page.getByTestId('data-import-opening-note')).toHaveText('期初库存将生成调整草稿，需由人工在库存中审核并过账。');
});
