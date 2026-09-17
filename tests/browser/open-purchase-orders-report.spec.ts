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
  await page.goto('/app/reports/procurement');
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
  await page.goto('/app/reports/procurement');
  const report = page.getByTestId('open-purchase-orders-report');
  await expect(report.getByRole('heading', { name: '未完成采购订单' })).toBeVisible();
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
  await page.goto('/app/reports/procurement');
  await expect(page.getByTestId('open-purchase-orders-report')).toContainText('No orders match these filters.');
});
