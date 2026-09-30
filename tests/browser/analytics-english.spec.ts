import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { readFile } from 'node:fs/promises';
import { buildRuntimeGovernedReport } from '../../server/domain/runtime-report-read-model.mjs';

async function login(page: Page, language = 'en-US') {
  const response = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Ignored', company: 'Ignored' } });
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
}

test('every analytics page, definitions, customization and workbook uses English', async ({ page }) => {
  await login(page);
  for (const view of ['overview', 'procurement?view=analytics', 'sales', 'inventory', 'finance', 'suppliers']) {
    await page.goto(`/app/reports/${view}`);
    const dashboard = page.getByTestId('bi-dashboard');
    await expect(dashboard.getByText('Loading report', { exact: true })).toHaveCount(0);
    await expect(dashboard.getByTestId('reports-data-scope-limitations')).toBeVisible();
    await dashboard.getByRole('button', { name: 'Metric definitions', exact: true }).click();
    await expect(dashboard.getByTestId('metric-definitions')).toBeVisible();
    await expect(dashboard).not.toContainText(/[\u3400-\u9fff]/);
    await dashboard.getByRole('button', { name: 'Customize view', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toContainText(/[\u3400-\u9fff]/);
    await page.getByRole('button', { name: 'Close customization' }).click();
    await expect(dashboard.getByRole('textbox', { name: 'Start date' })).toHaveAttribute('placeholder', 'YYYY-MM-DD');
    const pending = page.waitForEvent('download');
    await dashboard.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).not.toMatch(/[\u3400-\u9fff]/);
    const workbook = XLSX.read(await readFile((await download.path())!), { type: 'buffer' });
    expect(workbook.SheetNames).toEqual(['Metric summary', 'Chart data', 'Detail data', 'Filters', 'Metric definitions']);
    expect(Object.values(workbook.Sheets).flatMap(sheet => Object.values(sheet).map(cell => cell?.v).filter(value => typeof value === 'string' && /[\u3400-\u9fff]/.test(value)))).toEqual([]);
  }
});

test('overview exposes actionable charts and preserves date scope when drilling', async ({ page }) => {
  await login(page);
  await page.goto('/app/reports/overview?from=2026-01-01&to=2026-12-31');
  await expect(page.getByRole('heading', { name: 'Record activity by month' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Purchase order status' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Purchasing by supplier' })).toBeVisible();
  await page.getByTestId('overview-attention').getByRole('button', { name: /Open purchase orders/ }).click();
  await expect(page).toHaveURL(/reports\/procurement\?status=open/);
  const url = new URL(page.url());
  expect(url.searchParams.get('from')).toBe('2026-01-01');
  expect(url.searchParams.get('to')).toBe('2026-12-31');
});

test('overview stays available in Chinese', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/reports/overview');
  await expect(page.getByRole('heading', { name: '每月业务记录活动' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
});

test('populated overview uses readable status labels and filters by the original status value', async ({ page }) => {
  await login(page);
  await page.route('**/api/reports/query', async route => {
    const context = { purchaseOrders: [{ id: 'PO-DEMO', supplierName: 'Acme Components', status: 'partially_received', currency: 'USD', totalAmount: 900, createdAt: '2026-09-10', lines: [] }], salesOrders: [], suppliers: [], items: [], inventoryItems: [], supplierInvoices: [], receipts: [], dataLimitations: [] };
    await route.fulfill({ json: buildRuntimeGovernedReport(context, route.request().postDataJSON()) });
  });
  await page.goto('/app/reports/overview');
  const chart = page.locator('[data-chart-title="Purchase order status"]');
  await expect(chart).toContainText('Partially received');
  await expect(page.getByTestId('bi-dashboard')).not.toContainText('partially_received');
  await chart.locator('.recharts-pie-sector').first().click({ position: { x: 82, y: 10 } });
  await expect(page).toHaveURL(/status=partially_received/);
  const start = page.getByRole('textbox', { name: 'Start date' });
  await start.fill('2026-02-30');
  await expect(start).toHaveJSProperty('validationMessage', 'Dates must use YYYY-MM-DD.');
  expect(new URL(page.url()).searchParams.has('from')).toBeFalsy();
});

test('analytics pages offer only filters the report applies and promise no missing metrics', async ({ page }) => {
  await login(page);
  await page.goto('/app/reports/overview?company=Acme&warehouse=Main&category=Bolts&comparison=year_over_year');
  const filters = page.getByTestId('bi-global-filters');
  await expect(filters.getByRole('textbox', { name: 'Start date' })).toBeVisible();
  await expect(filters.getByLabel('Company', { exact: true })).toHaveCount(0);
  await expect(filters.getByLabel('Comparison', { exact: true })).toHaveCount(0);
  await expect(filters).not.toContainText(/Company:|Warehouse:|Category:/);
  await filters.getByRole('button', { name: /More filters/ }).click();
  for (const label of ['Supplier', 'Customer', 'Currency']) await expect(filters.getByLabel(label, { exact: true })).toBeVisible();
  for (const label of ['Warehouse', 'Category']) await expect(filters.getByLabel(label, { exact: true })).toHaveCount(0);
  for (const [view, subtitle] of [['procurement?view=analytics', 'Track committed purchasing spend and open purchase orders'], ['finance', 'Review submitted supplier invoice amounts'], ['suppliers', 'Review supplier records and committed purchasing spend']]) {
    await page.goto(`/app/reports/${view}`);
    await expect(page.getByTestId('bi-dashboard').getByText(subtitle, { exact: true })).toBeVisible();
    await expect(page.getByTestId('bi-dashboard')).not.toContainText(/OTIF|quality|three-way|aging|year over year/i);
  }
});

test('analytics subtitles stay accurate in Chinese', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/reports/suppliers');
  await expect(page.getByTestId('bi-dashboard').getByText('查看供应商记录与已承诺采购支出', { exact: true })).toBeVisible();
  await expect(page.getByTestId('bi-dashboard')).not.toContainText(/OTIF|质量|三单匹配|账龄/);
});
