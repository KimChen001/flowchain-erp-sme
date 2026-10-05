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
  await expect(page.getByRole('heading', { name: 'Committed purchase orders by supplier' })).toBeVisible();
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
  // The chart's data table lists each slice as a filter, as selecting the slice does.
  await chart.getByRole('button', { name: 'Show data: Purchase order status' }).click();
  await chart.getByTestId('visual-data-table').getByRole('button', { name: 'Partially received', exact: true }).click();
  await expect(page).toHaveURL(/status=partially_received/);
  await expect(page.getByTestId('bi-global-filters')).toContainText('Status: Partially received');
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
    // Quality, aging and period comparisons are not measured, so no page names them.
    await expect(page.getByTestId('bi-dashboard')).not.toContainText(/OTIF|quality|aging|year over year/i);
  }
  // Three-way match results are recorded on invoices, so the finance page reports them.
  await page.goto('/app/reports/finance');
  await expect(page.locator('[data-chart-id="finance_match_rate"]')).toBeVisible();
  await expect(page.locator('[data-chart-id="finance_match_outcome"]')).toBeVisible();
});

test('analytics subtitles stay accurate in Chinese', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/reports/suppliers');
  await expect(page.getByTestId('bi-dashboard').getByText('查看供应商记录与已承诺采购支出', { exact: true })).toBeVisible();
  await expect(page.getByTestId('bi-dashboard')).not.toContainText(/OTIF|质量|三单匹配|账龄/);
});

// Walkthrough-shaped inventory: LDM-001 has 8 on hand against an item master
// safety stock of 10, a 35 unit sales order and a partially received PO with
// 30 still in transit (ATP +3). LDM-003 is in the item master with no stock.
const walkthroughInventory = {
  items: [
    { id: 'ITEM-1', itemId: 'ITEM-1', sku: 'LDM-001', itemName: 'Flow Controller', safetyStock: 10, reorderPoint: 20 },
    { id: 'ITEM-3', itemId: 'ITEM-3', sku: 'LDM-003', itemName: 'Shipping Carton', safetyStock: 10, reorderPoint: 20 },
  ],
  inventoryItems: [
    { sku: 'LDM-001', itemId: 'ITEM-1', onHandQuantity: 8, reservedQuantity: 0, unit: 'pcs' },
    { sku: 'LDM-003', itemId: 'ITEM-3', onHandQuantity: 0, reservedQuantity: 0, unit: 'pcs' },
  ],
  salesOrders: [{ id: 'SO-1', salesOrderId: 'SO-1', workflowStatus: 'confirmed', sku: 'LDM-001', orderedQty: 35, fulfilledQty: 0, reservedQty: 0, lines: [{ sku: 'LDM-001', orderedQuantity: 35, reservedQuantity: 0, fulfilledQuantity: 0 }] }],
  purchaseOrders: [{ id: 'PO-1', status: 'partially_received', lines: [{ sku: 'LDM-001', orderedQuantity: 50, receivedQuantity: 20 }] }],
  suppliers: [], supplierInvoices: [], receipts: [], dataLimitations: [],
};

test('inventory report shows translated stock status codes in English and Chinese', async ({ page }) => {
  for (const [language, labels] of [
    ['en-US', { header: 'Stock status', belowSafety: 'Below safety stock', outOfStock: 'Out of stock', high: 'High', medium: 'Medium' }],
    ['zh-CN', { header: '库存状态', belowSafety: '低于安全库存', outOfStock: '缺货', high: '高', medium: '中' }],
  ] as const) {
    await page.unrouteAll();
    await login(page, language);
    await page.route('**/api/reports/query', route => route.fulfill({ json: buildRuntimeGovernedReport(walkthroughInventory, route.request().postDataJSON()) }));
    await page.goto('/app/reports/inventory');
    const dashboard = page.getByTestId('bi-dashboard');
    await expect(dashboard.getByRole('columnheader', { name: labels.header, exact: true })).toBeVisible();
    const ldm1 = dashboard.locator('tr', { hasText: 'LDM-001' });
    await expect(ldm1.locator('td').nth(6)).toHaveText('3');
    await expect(ldm1.locator('td').nth(7)).toHaveText(labels.belowSafety);
    await expect(ldm1.locator('td').nth(8)).toHaveText(labels.high);
    const ldm3 = dashboard.locator('tr', { hasText: 'LDM-003' });
    await expect(ldm3.locator('td').nth(7)).toHaveText(labels.outOfStock);
    await expect(ldm3.locator('td').nth(8)).toHaveText(labels.medium);
    await expect(dashboard).not.toContainText(/below_safety_stock|out_of_stock|below_reorder_point/);
    if (language === 'en-US') {
      const pending = page.waitForEvent('download');
      await dashboard.getByRole('button', { name: 'Export', exact: true }).click();
      const workbook = XLSX.read(await readFile((await (await pending).path())!), { type: 'buffer' });
      const details = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['Detail data']);
      expect(details.map(row => [row.SKU, row['Stock status'], row.Status])).toEqual([['LDM-001', 'Below safety stock', 'High'], ['LDM-003', 'Out of stock', 'Medium']]);
    }
  }
});
