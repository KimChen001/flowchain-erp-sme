import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page, language = 'en-US') {
  const response = await page.request.post('/api/auth/login', { data: {
    email: process.env.OPERATIONS_TEST_EMAIL || 'manager@example.com', name: 'Manager', company: 'Demo',
  } });
  expect(response.ok()).toBeTruthy();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token);
    localStorage.setItem('flowchain:current-user', JSON.stringify(user));
  }, await response.json());
  await page.route('**/api/me/localization', route => route.fulfill({ json: {
    effectiveLanguage: language, languagePreference: language, defaultLanguage: 'en-US', locale: 'en-US', timezone: 'America/New_York',
  } }));
}

async function expectEnglish(page: Page) {
  await expect(page.locator('[data-testid="module-export-scope"], #module-export-scope').first().or(page.locator('main')).first()).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText(/[\u3400-\u9fff]/);
  const attributes = await page.locator('input,select,textarea,button').evaluateAll(nodes => nodes
    .filter(node => node.getClientRects().length)
    .flatMap(node => ['aria-label', 'placeholder', 'title'].map(key => node.getAttribute(key) || '')));
  expect(attributes.join('\n')).not.toMatch(/[\u3400-\u9fff]/);
}

const order = (id: string, status: string, currency = 'USD') => ({
  po: id, status, currency, supplier: 'Acme Components', buyer: 'Alex Morgan', created: '2026-09-09', eta: '2026-09-23',
  amount: 2400, totalAmount: 2400, ordered: 200, received: 0, warehouseId: 'WH-1', sourceRequest: '', sourceRfq: '',
  lines: [{ poLineId: `${id}-L1`, sku: 'SKU-1', itemName: 'Control module', quantityOrdered: 200, quantityReceived: 0, unit: 'pcs', unitPrice: 12, currency, status: 'pending_receipt' }],
});

test('PO currency follows the document; cancelled orders are excluded from open fulfillment', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/purchase-orders-workbench', route => route.fulfill({ json: {
    purchaseOrders: [order('PO-CANCELLED', 'cancelled'), order('PO-OPEN', 'issued'), order('PO-EUR', 'issued', 'EUR')],
    receivingDocs: [], supplierInvoices: [],
  } }));
  await page.goto('/app/procurement/orders/PO-CANCELLED');
  await expect(page.getByTestId('po-line-cards')).toContainText('$2,400.00');
  await expect(page.getByTestId('po-line-cards')).toContainText('$12.00');
  await expect(page.locator('body')).toContainText('Order cancelled; no receipt required');
  await expect(page.locator('body')).not.toContainText('¥');
  await expectEnglish(page);
  await page.goto('/app/procurement/orders/PO-EUR');
  await expect(page.getByTestId('po-line-cards')).toContainText('€2,400.00');
  await page.goto('/app/procurement/order-lines');
  const list = page.getByTestId('order-fulfillment-line-list');
  await expect(list).toContainText('PO-OPEN');
  await expect(list).not.toContainText('PO-CANCELLED');
  await expectEnglish(page);
  await page.getByRole('combobox', { name: 'Fulfillment view' }).selectOption('all');
  await expect(list).toContainText('PO-CANCELLED');
});

for (const language of ['en-US', 'zh-CN']) {
  test(`invoice and matching states and empty results use ${language}`, async ({ page }) => {
    await signIn(page, language);
    let records = true;
    await page.route('**/api/procurement/documents?*', route => route.fulfill({ json: { documents: records ? [{
      id: 'INV-TEST', supplierName: 'Acme Components', relatedPo: 'PO-TEST', currency: 'USD',
      amount: 2400, poAmount: 2000, invoiceAmount: 2400, varianceAmount: 400,
      matchStatus: '差异待处理', blockingReason: 'PO 金额与发票金额存在差异，需复核后处理。',
    }] : [] } }));
    await page.goto('/app/procurement/invoices');
    await expect(page.getByTestId('supplier-invoice-record-list')).toContainText('INV-TEST');
    if (language === 'en-US') await expectEnglish(page);
    else await expect(page.getByTestId('supplier-invoice-record-list')).toContainText('差异待处理');
    await page.goto('/app/procurement/three-way-match');
    await expect(page.getByTestId('three-way-match-record-list')).toContainText('INV-TEST');
    if (language === 'en-US') await expectEnglish(page);
    else await expect(page.getByTestId('three-way-match-record-list')).toContainText('需复核后处理');
    records = false;
    await page.getByRole('button', { name: language === 'en-US' ? 'Refresh' : '刷新', exact: true }).click();
    await expect(page.getByTestId('three-way-match-record-list')).toContainText(language === 'en-US' ? 'No matching records' : '暂无可匹配记录');
    if (language === 'en-US') await expectEnglish(page);
  });
}

test('purchase request labels and defaults are English without changing selected currency on refresh', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/settings-runtime', async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ json: { ...data, company: { ...data.company, currency: 'USD' } } });
  });
  await page.route('**/api/procurement/requests', route => route.fulfill({ json: [] }));
  await page.goto('/app/procurement/requests');
  const currency = page.getByRole('combobox', { name: 'Default currency', exact: true });
  await expect(currency).toHaveValue('USD');
  await expectEnglish(page);
  await currency.selectOption('EUR');
  await page.getByRole('button', { name: 'Refresh master data' }).click();
  await expect(currency).toHaveValue('EUR');
  await page.getByRole('button', { name: 'Add purchase line' }).click();
  await expect(page.getByRole('button', { name: 'Delete purchase line 2' })).toBeVisible();
});

test('sales risk and evidence views translate system reasons and preserve customer names', async ({ page }) => {
  await signIn(page);
  let customerName = 'Acme Retail';
  await page.route('**/api/sales-demand/orders', route => route.fulfill({ json: { orders: [{
    salesOrderId: 'SO-TEST', customerName, customerTier: 'Standard', itemId: 'ITEM-1', sku: 'SKU-1', itemName: 'Control module',
    orderedQty: 10, reservedQty: 0, fulfilledQty: 0, shortageQty: 10, promisedDate: '2026-09-23',
    statusLabel: '缺货风险', priority: '高', deliveryRiskLevel: 'high', deliveryRiskLabel: '高风险',
    deliveryRiskReason: '订单数量尚未被库存预留或履约记录覆盖，存在交付缺口。',
    dataLimitations: ['inventory_availability_not_joined', 'purchase_supply_not_joined'],
    linkedPurchaseOrders: [], linkedSuppliers: [], linkedReceivingDocs: [], linkedExceptionCases: [],
  }] } }));
  await page.goto('/app/sales/risks');
  await expect(page.locator('tbody')).toContainText('SO-TEST');
  await expect(page.locator('tbody')).toContainText('a delivery shortage remains');
  await expectEnglish(page);
  await page.goto('/app/sales/evidence');
  await expect(page.locator('tbody')).toContainText('Shortage risk');
  await expectEnglish(page);
  customerName = '示例客户';
  await page.reload();
  await expect(page.locator('tbody')).toContainText('示例客户');
  await expect(page.locator('tbody')).toContainText('Shortage risk');
});
