import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { buildOpenPurchaseOrdersReport } from '../../server/domain/open-purchase-orders-report.mjs';

async function authenticate(page: Page, language = 'en-US') {
  const response = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York', workspaceName: 'FlowChain Operations' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return session;
}
const orders = Array.from({ length: 61 }, (_, index) => ({ id: `PO-REPORT-${String(index).padStart(3, '0')}`, supplierName: 'Acme Components', createdAt: '2026-09-01', expectedDate: '2026-09-09', owner: 'Alex', status: 'issued', currency: 'USD', totalAmount: 100, lines: [{ quantity: 10, receivedQuantity: 2, unit: 'pcs' }] }));
async function fixture(page: Page) {
  await page.route('**/api/reports/open-purchase-orders?*', route => route.fulfill({ json: buildOpenPurchaseOrdersReport(orders, Object.fromEntries(new URL(route.request().url()).searchParams), new Date('2026-09-11T10:00:00Z')) }));
}

test('English report pages through every row, preserves scope on links and exports all results', async ({ page }) => {
  await authenticate(page); await fixture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app/reports/procurement?view=orders');
  const report = page.getByTestId('open-purchase-orders-report');
  await expect(report.getByRole('heading', { name: 'Open purchase orders' })).toBeVisible();
  await expect(report).toContainText('Showing 1–25 of 61');
  await report.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(report).toContainText('Showing 26–50 of 61');
  await page.reload(); await expect(report).toContainText('Showing 26–50 of 61');
  await report.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(report).toContainText('Showing 51–61 of 61');
  await expect(page.getByTestId('open-po-table').getByRole('row')).toHaveCount(12);
  await expect(report.locator('a').first()).toHaveAttribute('href', /returnTo=.*reports.*procurement/);
  await report.getByRole('button', { name: 'Columns', exact: true }).click();
  await report.getByRole('checkbox', { name: 'Owner', exact: true }).click();
  await expect(report.getByRole('checkbox', { name: 'Owner', exact: true })).not.toBeChecked();
  await expect(report.getByRole('columnheader', { name: 'Owner' })).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await report.getByRole('button', { name: 'Export all results' }).click();
  const download = await downloaded;
  const bytes = await readFile((await download.path())!);
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  expect(workbook.SheetNames).toEqual(['Purchase orders', 'Report scope', 'Metric definitions']);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Purchase orders']);
  expect(rows).toHaveLength(61);
  expect(rows[0]).toMatchObject({ 'PO number': 'PO-REPORT-000', 'Order amount': 100, Remaining: 8 });
  expect(JSON.stringify(rows)).not.toMatch(/[\u3400-\u9fff]/);
  await expect(report).not.toContainText(/[\u3400-\u9fff]/);
  await report.getByRole('textbox', { name: 'Search PO, supplier or owner' }).fill('not-found');
  await expect(report).toContainText('No orders match these filters.');
  expect(errors).toEqual([]);
});

test('Chinese report keeps the same business values', async ({ page }) => {
  await authenticate(page, 'zh-CN'); await fixture(page);
  await page.goto('/app/reports/procurement?view=orders');
  const report = page.getByTestId('open-purchase-orders-report');
  await expect(report.getByRole('heading', { name: '未结采购订单' })).toBeVisible();
  await expect(report).toContainText('Acme Components');
  await expect(report).toContainText('PO-REPORT-000');
  await expect(report).toContainText('USD');
});

test('report endpoint uses the authenticated database workspace', async ({ page }) => {
  const session = await authenticate(page);
  const result = await page.request.get('/api/reports/open-purchase-orders?export=true', { headers: { Authorization: `Bearer ${session.token}` } });
  expect(result.ok()).toBeTruthy();
  const body = await result.json();
  expect(body.total).toBe(body.exportRows.length);
  const invalid = await page.request.get('/api/reports/open-purchase-orders?from=invalid', { headers: { Authorization: `Bearer ${session.token}` } });
  expect(invalid.status()).toBe(422);
  await page.goto('/app/reports/procurement?view=orders');
  await expect(page.getByTestId('open-purchase-orders-report')).toContainText('No orders match these filters.');
});

// Seven suppliers with overdue orders, one with two, and orders of several SKUs.
const multiSku = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].flatMap((supplier, index) => [
  { id: `PO-MULTI-${supplier}`, orderNumber: `PO-MULTI-${supplier}`, supplierName: `Vendor ${supplier}`, createdAt: '2026-09-01', expectedDate: '2026-09-09', owner: 'Alex', status: 'issued', currency: 'USD', totalAmount: 100 + index, lines: Array.from({ length: 13 }, (_, line) => ({ sku: `SKU-${line}`, quantity: 10, receivedQuantity: 0, unit: 'pcs' })) },
  ...(index === 0 ? [{ id: 'PO-MULTI-A2', orderNumber: 'PO-MULTI-A2', supplierName: 'Vendor A', createdAt: '2026-09-02', expectedDate: '2026-09-09', owner: 'Alex', status: 'issued', currency: 'USD', totalAmount: 50, lines: [{ sku: 'SKU-1', quantity: 10, receivedQuantity: 0, unit: 'pcs' }, { sku: 'SKU-2', quantity: 5, receivedQuantity: 5, unit: 'pcs' }] }] : []),
]);

test('procurement reports are sub-tabs; the overdue chart names the top five and what it leaves out', async ({ page }) => {
  await authenticate(page);
  await page.route('**/api/reports/open-purchase-orders?*', route => route.fulfill({ json: buildOpenPurchaseOrdersReport(multiSku, Object.fromEntries(new URL(route.request().url()).searchParams), new Date('2026-09-11T10:00:00Z')) }));
  await page.goto('/app/reports/procurement?view=orders');
  const tabs = page.getByTestId('procurement-report-tabs');
  await expect(tabs.getByRole('link', { name: 'Open purchase orders' })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current', 'page');
  const report = page.getByTestId('open-purchase-orders-report');
  const overdue = report.getByTestId('open-po-overdue-suppliers');
  await expect(overdue.getByRole('heading', { name: 'Top 5 suppliers with overdue orders' })).toBeVisible();
  await expect(overdue.getByTestId('open-po-overdue-more')).toHaveText('+2 more suppliers with 2 overdue orders');
  // Quantities of several SKUs are never added: the row says how many lines are open.
  const row = page.getByTestId('open-po-table').getByRole('row', { name: /PO-MULTI-A2/ });
  await expect(row).toContainText('1 line open');
  await expect(page.getByTestId('open-po-table').getByRole('row', { name: /PO-MULTI-B/ })).toContainText('13 lines open');
  await expect(report).not.toContainText('Unavailable');
  // The tab opens the dashboard by default (owner 11/11), as the other analytics tabs do.
  await tabs.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/app\/reports\/procurement$/);
  await expect(page.getByTestId('procurement-report-tabs').getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('bi-dashboard')).toBeVisible();
  // Business overview has no procurement sub-tabs.
  await page.goto('/app/reports/overview');
  await expect(page.getByTestId('bi-dashboard')).toBeVisible();
  await expect(page.getByTestId('procurement-report-tabs')).toHaveCount(0);
});

test('on a phone the open purchase orders are cards that show every field', async ({ page }) => {
  await authenticate(page, 'zh-CN');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/reports/open-purchase-orders?*', route => route.fulfill({ json: buildOpenPurchaseOrdersReport(multiSku, Object.fromEntries(new URL(route.request().url()).searchParams), new Date('2026-09-11T10:00:00Z')) }));
  await page.goto('/app/reports/procurement?view=orders');
  const report = page.getByTestId('open-purchase-orders-report');
  await expect(page.getByTestId('open-po-table')).toHaveAttribute('data-list-cards', '');
  await expect(report).toContainText('第 1 页，共 1 页');
  await expect(report).not.toContainText('页 1 / 1');
  // No sideways scroll: the page fits the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
