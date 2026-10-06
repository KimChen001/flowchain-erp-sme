import { expect, test, type Page } from '@playwright/test';

// Earlier purchase order prices beside a price (shared/price-history.mjs, S1):
// the supplied items of a supplier, from that supplier's POs only. Display
// only; nothing is filled in.
async function login(page: Page, language = 'en-US', role = 'manager') {
  const response = await page.request.post('/api/auth/login', { data: { email: `${role}@example.com`, name: 'Ignored', company: 'Ignored' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
  return { Authorization: `Bearer ${session.token}` };
}

const fact = (overrides: Record<string, unknown>) => ({
  purchaseOrderId: 'PO-0031', orderNumber: 'PO-0031', lineId: 'PO-0031-L1', supplierId: 'sup-acme', supplierName: 'Acme',
  unit: 'EA', currency: 'USD', unitPrice: '4.2000', orderedQuantity: '10.0000', date: '2026-09-14', dateSource: 'issue_date', instant: '2026-09-14T15:00:00.000Z',
  ...overrides,
});

async function supplierWithItem(page: Page, headers: Record<string, string>) {
  const stamp = Date.now();
  const supplierId = (await (await page.request.post('/api/master-data/suppliers', { headers, data: { supplierCode: `PH-${stamp}`, supplierName: `Price History ${stamp}`, defaultCurrency: 'USD' } })).json()).supplier.id as string;
  const created = await page.request.post('/api/master-data/items', { headers, data: { sku: `PH-${stamp}`, itemName: `Hinge ${stamp}`, baseUnit: 'EA' } });
  expect(created.status()).toBe(201);
  const item = (await created.json()).item;
  const itemId = String(item.itemId || item.id);
  const link = await page.request.post(`/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`, { headers, data: { supplierId, referencePrice: 4.5, currency: 'USD', preferred: true, approved: true } });
  expect(link.ok()).toBeTruthy();
  return { supplierId, itemId };
}

test('a supplied item shows its last PO price from this supplier in the link currency, labelled as a PO price', async ({ page }) => {
  const headers = await login(page);
  const { supplierId, itemId } = await supplierWithItem(page, headers);
  const requests: string[] = [];
  await page.route('**/api/procurement/price-history**', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: { timeZone: 'America/New_York', priceLabel: 'purchase_order_price', histories: [{
      key: `${itemId}||USD|${supplierId}`, itemId, supplierId, unit: 'EA', unitSource: 'item', currency: 'USD', status: 'found',
      latest: fact({}), earlier: [fact({ purchaseOrderId: 'PO-0020', orderNumber: 'PO-0020', lineId: 'PO-0020-L1', unitPrice: '4.4000', date: '2026-08-01' })],
      average: { unitPrice: '4.3000', n: 2 }, otherCurrencies: ['EUR'], otherUnits: [], unitNotRecordedCount: 0,
    }] } });
  });
  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  const facts = page.getByTestId(`supplied-item-price-history-${itemId}`);
  await expect(facts.getByTestId(`supplied-item-price-history-${itemId}-latest`)).toHaveText('Last PO price USD 4.20 / EA · PO-0031 · 2026-09-14 · Acme');
  await expect(facts).toContainText('Average PO price of 2 (by quantity): USD 4.30');
  await expect(facts).toContainText('Earlier purchases in EUR, not compared');
  // Compact: earlier lines are left to the forms.
  await expect(facts).not.toContainText('PO-0020');
  expect(requests).toHaveLength(1);
  // The key names the supplier: other suppliers' prices are not read here.
  expect(new URL(requests[0]).searchParams.getAll('key')).toEqual([`${itemId}||USD|${supplierId}`]);
});

test('without an issued PO from this supplier the item says so, and a role without purchase orders sees no block', async ({ page }) => {
  const headers = await login(page);
  const { supplierId, itemId } = await supplierWithItem(page, headers);
  await page.route('**/api/procurement/price-history**', route => route.fulfill({ json: { timeZone: 'America/New_York', priceLabel: 'purchase_order_price', histories: [{
    key: `${itemId}||USD|${supplierId}`, itemId, supplierId, unit: 'EA', unitSource: 'item', currency: 'USD', status: 'none', latest: null, earlier: [], average: null, otherCurrencies: [], otherUnits: [], unitNotRecordedCount: 0,
  }] } }));
  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  await expect(page.getByTestId(`supplied-item-price-history-${itemId}`)).toHaveText('No issued PO from this supplier yet');

  await page.unroute('**/api/procurement/price-history**');
  await page.route('**/api/procurement/price-history**', route => route.fulfill({ status: 403, json: { code: 'AUTHORIZATION_PERMISSION_DENIED', message: 'Denied' } }));
  await page.reload();
  await expect(page.getByText('Price History', { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId(`supplied-item-price-history-${itemId}`)).toHaveCount(0);
});

test('the facts read in Chinese, and a hidden price is never shown as 0', async ({ page }) => {
  const headers = await login(page, 'zh-CN');
  const { supplierId, itemId } = await supplierWithItem(page, headers);
  await page.route('**/api/procurement/price-history**', route => route.fulfill({ json: { timeZone: 'America/New_York', priceLabel: 'purchase_order_price', restrictedFields: ['unitPrice'], histories: [{
    key: `${itemId}||USD|${supplierId}`, itemId, supplierId, unit: 'EA', unitSource: 'item', currency: 'USD', status: 'found', latest: fact({ unitPrice: null, dateSource: 'order_date', date: '2026-09-10' }), earlier: [], average: null, otherCurrencies: [], otherUnits: ['CASE'], unitNotRecordedCount: 0, restrictedFields: ['unitPrice'],
  }] } }));
  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  const facts = page.getByTestId(`supplied-item-price-history-${itemId}`);
  await expect(facts.getByTestId(`supplied-item-price-history-${itemId}-latest`)).toHaveText('上次采购订单价对当前角色隐藏 · PO-0031 · 2026-09-10（下单日期 · 未记录下达日期） · Acme');
  await expect(facts).toContainText('以往采购以 CASE 计，未比较');
  await expect(facts).not.toContainText('0.00');
});

test('linking a new item shows its last PO price under the reference price, and leaves the price empty', async ({ page }) => {
  const headers = await login(page);
  const { supplierId } = await supplierWithItem(page, headers);
  const stamp = Date.now();
  const created = await page.request.post('/api/master-data/items', { headers, data: { sku: `PH-NEW-${stamp}`, itemName: `Bracket ${stamp}`, baseUnit: 'EA' } });
  expect(created.status()).toBe(201);
  const item = (await created.json()).item;
  const newItemId = String(item.itemId || item.id);
  const requests: string[][] = [];
  await page.route('**/api/procurement/price-history**', (route) => {
    const keys = new URL(route.request().url()).searchParams.getAll('key');
    requests.push(keys);
    return route.fulfill({ json: { timeZone: 'America/New_York', priceLabel: 'purchase_order_price', histories: keys.map((key) => ({
      key, itemId: key.split('|')[0], supplierId: key.split('|')[3] || null, unit: 'EA', unitSource: 'item', currency: 'USD', status: 'found',
      latest: fact({}), earlier: [], average: null, otherCurrencies: [], otherUnits: [], unitNotRecordedCount: 0,
    })) } });
  });
  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  await page.getByRole('combobox', { name: 'Select SKU' }).selectOption(newItemId);
  const facts = page.getByTestId('supplied-item-form-price-history');
  await expect(facts.getByTestId('supplied-item-form-price-history-latest')).toHaveText('Last PO price USD 4.20 / EA · PO-0031 · 2026-09-14 · Acme');
  await expect(facts).toContainText('not invoiced or paid prices');
  await expect(facts).toHaveAttribute('role', 'group');
  await expect(page.getByRole('textbox', { name: 'Reference price' })).toHaveValue('');
  // One request holds the linked items and the item being linked.
  expect(requests.at(-1)).toContain(`${newItemId}||USD|${supplierId}`);
});
