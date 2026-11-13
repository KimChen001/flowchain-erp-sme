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
    // A page with records shows its data scope notes; a page with none shows
    // one empty state in place of its charts, notes and table.
    await expect(dashboard.getByTestId('reports-data-scope-limitations').or(dashboard.getByTestId('report-empty-state')).first()).toBeVisible();
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

test('overview covers each area, and its figures and charts open their tabs with the date scope', async ({ page }) => {
  await login(page);
  const overview = '/app/reports/overview?from=2026-01-01&to=2026-12-31';
  await page.goto(overview);
  // One chart per area (round 8): purchases and sales, stock, activity, suppliers.
  for (const heading of ['Purchases and sales by month', 'SKUs by stock status', 'Record activity by month', 'Committed purchase orders by supplier']) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.locator('[data-chart-id]')).toHaveCount(4);
  // One figure per area: purchasing, sales, inventory and supplier invoices.
  for (const [id, label] of [['purchase_order_amount', 'Committed PO amount'], ['sales_order_amount', 'Sales order amount'], ['low_stock_sku', 'Low-stock SKUs'], ['invoice_amount', 'Supplier invoice amount']]) await expect(page.getByTestId(`report-kpi-${id}`)).toContainText(label);
  await expect(page.getByTestId('report-kpi-inventory_risk_sku')).toHaveCount(0);
  // A figure opens its area's analytics tab, keeping the dates.
  await page.getByTestId('report-kpi-sales_order_amount').click();
  await expect(page).toHaveURL(/\/app\/reports\/sales\?/);
  expect([new URL(page.url()).searchParams.get('from'), new URL(page.url()).searchParams.get('to')]).toEqual(['2026-01-01', '2026-12-31']);
  await page.goto(overview);
  await page.locator('[data-chart-id="overview_stock_status"]').getByRole('button', { name: 'View business details' }).click();
  await expect(page).toHaveURL(/\/app\/reports\/inventory\?/);
  await page.goto(overview);
  // The procurement tab opens on its dashboard even though the dates would otherwise open the open orders report.
  await page.locator('[data-chart-id="overview_suppliers"]').getByRole('button', { name: 'View business details' }).click();
  await expect(page).toHaveURL(/\/app\/reports\/procurement\?view=analytics/);
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'procurement');
  await page.goto(overview);
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
  await expect(page.getByRole('heading', { name: '每月采购与销售金额' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '按库存状态统计 SKU' })).toBeVisible();
  await expect(page.getByTestId('report-kpi-low_stock_sku')).toContainText('库存偏低 SKU');
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
});

// A populated overview: purchases and sales in one currency, four SKUs in
// four stock statuses and a supplier invoice.
const stockItem = (sku: string, safetyStock: number, reorderPoint: number) => ({ id: `ITEM-${sku}`, itemId: `ITEM-${sku}`, sku, itemName: sku, safetyStock, reorderPoint });
const stockRow = (sku: string, onHandQuantity: number) => ({ sku, itemId: `ITEM-${sku}`, onHandQuantity, reservedQuantity: 0, unit: 'pcs' });
const populatedOverview = {
  purchaseOrders: [
    { id: 'PO-1', status: 'issued', orderDate: '2026-08-10', currency: 'USD', totalAmount: 500, supplierName: 'Acme Components', lines: [] },
    { id: 'PO-2', status: 'fully_received', orderDate: '2026-09-10', currency: 'USD', totalAmount: 300, supplierName: 'Acme Components', lines: [] },
    { id: 'PO-3', status: 'issued', orderDate: '2026-09-12', currency: 'USD', totalAmount: 200, supplierName: 'Bolt Supply', lines: [] },
  ],
  salesOrders: [
    { id: 'SO-1', status: 'confirmed', orderDate: '2026-08-11', currency: 'USD', totalAmount: 700, customerName: 'Northwind', lines: [{ sku: 'D', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 1 }] },
    { id: 'SO-2', status: 'confirmed', orderDate: '2026-09-11', currency: 'USD', totalAmount: 400, customerName: 'Contoso', lines: [{ sku: 'D', unit: 'pcs', orderedQuantity: 1, fulfilledQuantity: 1 }] },
  ],
  items: [stockItem('A', 10, 20), stockItem('B', 10, 20), stockItem('C', 5, 10), stockItem('D', 5, 10)],
  inventoryItems: [stockRow('A', 0), stockRow('B', 8), stockRow('C', 10), stockRow('D', 50)],
  supplierInvoices: [{ id: 'INV-1', invoiceNumber: 'INV-1', status: 'approved', currency: 'USD', totalAmount: 120, invoiceDate: '2026-09-15', supplierName: 'Acme Components' }],
  suppliers: [], customers: [], receipts: [], dataLimitations: [],
};

test('a populated overview reads in words across areas, and a view saved with the old charts still loads', async ({ page }) => {
  await login(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reports/query', route => route.fulfill({ json: buildRuntimeGovernedReport(populatedOverview, route.request().postDataJSON()) }));
  // Hidden charts and an order saved before round 8 name charts the overview no longer has.
  await page.goto('/app/reports/overview?hiddenCharts=overview_status,overview_spend_trend,overview_lifecycle&chartOrder=overview_activity,overview_status,overview_suppliers,overview_spend_trend,overview_lifecycle');
  const dashboard = page.getByTestId('bi-dashboard');
  await expect(page.locator('[data-chart-id]')).toHaveCount(4);
  // The saved order still leads; the charts it does not name follow.
  expect(await page.locator('[data-chart-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-chart-id')))).toEqual(['overview_activity', 'overview_suppliers', 'overview_purchases_and_sales', 'overview_stock_status']);
  await expect(page.getByTestId('report-kpi-low_stock_sku').getByTestId('report-kpi-value')).toHaveText('3');
  await expect(page.getByTestId('report-kpi-sales_order_amount').getByTestId('report-kpi-value')).toHaveText('$1,100.00');
  await expect(page.getByTestId('report-kpi-invoice_amount').getByTestId('report-kpi-value')).toHaveText('$120.00');
  await expect(page.locator('[data-chart-id="overview_stock_status"]')).toContainText('Below safety stock');
  await expect(dashboard).not.toContainText(/below_safety_stock|out_of_stock|below_reorder_point/);
  // Key findings speak for sales, purchasing and stock.
  const findings = page.getByTestId('report-insights');
  await expect(findings).toContainText('2026-09, the last whole month: $400.00 in sales orders and $500.00 in committed purchases.');
  await expect(findings).toContainText('3 of 4 SKUs are low on stock: 1 out of stock, 1 below safety stock and 1 below reorder point.');
  await expect(findings).toContainText('Acme Components has the most committed purchase orders: 2.');
  // The old ids hide nothing and do not count against keeping one chart visible.
  await dashboard.getByRole('button', { name: 'Customize view', exact: true }).click();
  const drawer = page.getByTestId('chart-configuration');
  // The boxes follow the page link, which updates after the click, so each is clicked and then read.
  for (const title of ['Record activity by month', 'Committed purchase orders by supplier', 'Purchases and sales by month']) {
    const box = drawer.getByRole('checkbox', { name: new RegExp(title) });
    await box.click();
    await expect(box).not.toBeChecked();
  }
  await expect(page).toHaveURL(/hiddenCharts=overview_activity%2Coverview_suppliers%2Coverview_purchases_and_sales(&|$)/);
  await page.getByRole('button', { name: 'Close customization' }).click();
  await expect(page.locator('[data-chart-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('populated procurement dashboard uses readable status labels and filters by the original status value', async ({ page }) => {
  await login(page);
  await page.route('**/api/reports/query', async route => {
    const context = { purchaseOrders: [{ id: 'PO-DEMO', supplierName: 'Acme Components', status: 'partially_received', currency: 'USD', totalAmount: 900, createdAt: '2026-09-10', lines: [] }], salesOrders: [], suppliers: [], items: [], inventoryItems: [], supplierInvoices: [], receipts: [], dataLimitations: [] };
    await route.fulfill({ json: buildRuntimeGovernedReport(context, route.request().postDataJSON()) });
  });
  // The overview no longer repeats the status donut (round 8); Procurement analytics has it.
  await page.goto('/app/reports/procurement?view=analytics');
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

test('a date range sets the flow figures against the previous period, in neutral words', async ({ page }) => {
  await login(page);
  await page.route('**/api/reports/query', async route => {
    const po = (id: string, date: string, amount: number) => ({ id, supplierName: 'Acme Components', status: 'issued', currency: 'USD', totalAmount: amount, orderDate: date, createdAt: `${date}T12:00:00Z`, lines: [] });
    const context = { purchaseOrders: [po('PO-JUL', '2026-07-10', 100), po('PO-AUG-1', '2026-08-10', 150), po('PO-AUG-2', '2026-08-20', 50)], salesOrders: [], suppliers: [], items: [], inventoryItems: [], supplierInvoices: [], receipts: [], dataLimitations: [] };
    await route.fulfill({ json: buildRuntimeGovernedReport(context, route.request().postDataJSON()) });
  });
  await page.goto('/app/reports/procurement?view=analytics&from=2026-08-01&to=2026-08-31');
  const spend = page.getByTestId('report-kpi-purchase_order_amount');
  await expect(spend.getByTestId('report-kpi-change')).toHaveText('+100.0%');
  await expect(spend).toContainText('$100.00 in the previous period');
  // Open orders are a state as of today, so they are not compared.
  await expect(page.getByTestId('report-kpi-open_po_count')).toContainText('As of today');
  await expect(page.getByTestId('report-kpi-open_po_count').getByTestId('report-kpi-change')).toHaveCount(0);
  await expect(page.getByTestId('report-insights')).toContainText('rose 100.0% against the previous period: $200.00, against $100.00.');
  await page.getByTestId('bi-global-filters').getByLabel('Compare with', { exact: true }).selectOption('none');
  await expect(page).toHaveURL(/comparison=none/);
  await expect(spend.getByTestId('report-kpi-change')).toHaveCount(0);
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
  // With no supplier invoices the finance page says so once, not in six empty charts.
  await page.goto('/app/reports/finance');
  await expect(page.getByTestId('report-empty-state')).toContainText('No supplier invoices in this range.');
  await expect(page.locator('[data-chart-id]')).toHaveCount(0);
  await expect(page.getByTestId('bi-dashboard')).not.toContainText('Select a currency to compare amounts.');
  // Three-way match results are recorded on invoices, so the finance page reports them.
  await page.route('**/api/reports/query', async route => {
    const context = { purchaseOrders: [], salesOrders: [], suppliers: [], items: [], inventoryItems: [], receipts: [], dataLimitations: [], supplierInvoices: [{ id: 'INV-DEMO', invoiceNumber: 'INV-DEMO', supplierName: 'Acme Components', status: 'matched', matchStatus: 'matched', totalAmount: 90, currency: 'USD', invoiceDate: '2026-09-15' }] };
    await route.fulfill({ json: buildRuntimeGovernedReport(context, route.request().postDataJSON()) });
  });
  await page.reload();
  await expect(page.locator('[data-chart-id="finance_match_rate"]')).toBeVisible();
  await expect(page.locator('[data-chart-id="finance_match_outcome"]')).toBeVisible();
});

test('analytics subtitles stay accurate in Chinese', async ({ page }) => {
  await login(page, 'zh-CN');
  await page.goto('/app/reports/suppliers');
  await expect(page.getByTestId('bi-dashboard').getByText('查看供应商记录与已承诺采购支出', { exact: true })).toBeVisible();
  await expect(page.getByTestId('bi-dashboard')).not.toContainText(/OTIF|质量|三单匹配|账龄/);
});

// Walkthrough-shaped inventory: TST-001 has 8 on hand against an item master
// safety stock of 10, a 35 unit sales order and a partially received PO with
// 30 still in transit (ATP +3). TST-003 is in the item master with no stock.
const walkthroughInventory = {
  items: [
    { id: 'ITEM-1', itemId: 'ITEM-1', sku: 'TST-001', itemName: 'Flow Controller', safetyStock: 10, reorderPoint: 20 },
    { id: 'ITEM-3', itemId: 'ITEM-3', sku: 'TST-003', itemName: 'Shipping Carton', safetyStock: 10, reorderPoint: 20 },
  ],
  inventoryItems: [
    { sku: 'TST-001', itemId: 'ITEM-1', onHandQuantity: 8, reservedQuantity: 0, unit: 'pcs' },
    { sku: 'TST-003', itemId: 'ITEM-3', onHandQuantity: 0, reservedQuantity: 0, unit: 'pcs' },
  ],
  salesOrders: [{ id: 'SO-1', salesOrderId: 'SO-1', workflowStatus: 'confirmed', sku: 'TST-001', orderedQty: 35, fulfilledQty: 0, reservedQty: 0, lines: [{ sku: 'TST-001', orderedQuantity: 35, reservedQuantity: 0, fulfilledQuantity: 0 }] }],
  purchaseOrders: [{ id: 'PO-1', status: 'partially_received', lines: [{ sku: 'TST-001', orderedQuantity: 50, receivedQuantity: 20 }] }],
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
    const ldm1 = dashboard.locator('tr', { hasText: 'TST-001' });
    await expect(ldm1.locator('td').nth(7)).toHaveText('3');
    await expect(ldm1.locator('td').nth(8)).toHaveText(labels.belowSafety);
    await expect(ldm1.locator('td').nth(9)).toHaveText(labels.high);
    const ldm3 = dashboard.locator('tr', { hasText: 'TST-003' });
    await expect(ldm3.locator('td').nth(8)).toHaveText(labels.outOfStock);
    await expect(ldm3.locator('td').nth(9)).toHaveText(labels.medium);
    await expect(dashboard).not.toContainText(/below_safety_stock|out_of_stock|below_reorder_point/);
    if (language === 'en-US') {
      const pending = page.waitForEvent('download');
      await dashboard.getByRole('button', { name: 'Export', exact: true }).click();
      const workbook = XLSX.read(await readFile((await (await pending).path())!), { type: 'buffer' });
      const details = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['Detail data']);
      expect(details.map(row => [row.SKU, row['Item name'], row.Unit, row['Stock status'], row.Risk])).toEqual([['TST-001', 'Flow Controller', 'pcs', 'Below safety stock', 'High'], ['TST-003', 'Shipping Carton', 'pcs', 'Out of stock', 'Medium']]);
    }
  }
});
