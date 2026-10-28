import { test, expect } from '@playwright/test';

// Today's rows, tiles, checklist and recent documents in each interface
// language, from the codes the server sends. Names and numbers stay as stored.
const overview = (supplier: string) => ({
  today: '2026-10-07', timeZone: 'America/New_York',
  workItems: [
    { id: 'purchase_order_overdue:PO-1', kind: 'purchase_order_overdue', entityType: 'purchase_order', recordId: 'PO-1', label: 'PO-0001', name: supplier, href: '/app/procurement/orders/PO-1', actionHref: null, date: '2026-10-04', dateKind: 'due', overdueDays: 3, detail: { remaining: 20, unit: 'EA', openLines: 1, received: 30, ordered: 50, notIssued: false, dueInDays: null } },
    { id: 'reorder_now:ITEM-1', kind: 'reorder_now', entityType: 'item', recordId: 'ITEM-1', label: 'VALVE-150', name: 'Ball valve', href: '/app/master-data/items/ITEM-1', actionHref: '/app/inventory/reorder', date: '2026-10-07', dateKind: 'order_by', overdueDays: 0, detail: { position: 20, reorderPoint: 20, shortfall: 0, unit: 'EA', stockSignal: 'stock_below_safety' } },
    { id: 'purchase_request_to_approve:PR-1', kind: 'purchase_request_to_approve', entityType: 'purchase_request', recordId: 'PR-1', label: 'PR-1', name: null, href: '/app/procurement/requests/PR-1', actionHref: null, date: '2026-10-09', dateKind: 'required', overdueDays: 0, detail: { amount: 1200, currency: 'USD' } },
    { id: 'draft_purchase_order:PO-2', kind: 'draft_purchase_order', entityType: 'purchase_order', recordId: 'PO-2', label: 'PO-0002', name: supplier, href: '/app/procurement/orders/PO-2', actionHref: null, date: null, dateKind: 'due', overdueDays: 0, detail: {} },
  ],
  workTotal: 4, overdue: 1, todayChanges: 2,
  firstRun: { done: 3, total: 5, steps: [
    { id: 'items', count: 4, done: true, href: '/app/master-data/import?type=items', blocked: null },
    { id: 'suppliers', count: 2, done: true, href: '/app/master-data/import?type=suppliers', blocked: null },
    { id: 'customers', count: 0, done: false, href: '/app/master-data/import?type=customers', blocked: null },
    { id: 'opening_stock', count: 0, done: false, href: null, blocked: 'permission' },
    { id: 'teammates', count: 1, done: true, href: '/app/settings/roles', blocked: null },
  ] },
  hidden: ['receivables'],
  recentDocuments: [
    ['purchase_order', 'fully_received'], ['purchase_order', 'pending_approval'], ['sales_order', 'confirmed'], ['supplier_invoice', 'matched'],
  ].map(([type, status], index) => ({ type, id: `DOC-${index}`, number: `DOC-${index}`, status, partner: supplier, amount: 1200, currency: 'USD', updatedAt: '2026-10-07T16:59:00.000Z', canonicalRoute: `/app/procurement/orders/DOC-${index}` })),
  limitations: [], generatedAt: '2026-10-07T17:00:00.000Z',
});

for (const language of ['en-US', 'zh-CN']) {
  test(`home work rows, tiles, checklist and recent documents use ${language}`, async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Manager', company: 'Demo' } });
    expect(login.ok()).toBeTruthy();
    const session = await login.json();
    await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
    await page.route('**/api/me/localization', route => route.fulfill({ json: { effectiveLanguage: language, languagePreference: language, defaultLanguage: 'en-US', locale: 'en-US', timezone: 'America/New_York' } }));
    let supplier = 'Acme Components';
    await page.route('**/api/home/overview', route => route.fulfill({ json: overview(supplier) }));
    await page.goto('/app/overview/risks');
    const root = page.getByTestId('runtime-homepage');
    await expect(root.getByText(language === 'en-US' ? 'Draft PO awaiting review' : 'Draft PO 待复核', { exact: true })).toBeVisible();
    const rows = root.getByTestId('today-work-item');
    await expect(rows).toHaveCount(4);
    if (language === 'en-US') {
      await expect(root).not.toContainText(/[㐀-鿿]/);
      await expect(rows.nth(0)).toContainText('3 days overdue');
      await expect(rows.nth(0)).toContainText('Purchase order overdue');
      await expect(rows.nth(0)).toContainText('20 EA still to receive · 30 of 50 EA received · Supplier Acme Components');
      await expect(rows.nth(1)).toContainText('Order today');
      await expect(rows.nth(1)).toContainText('Ball valve · Stock position 20 EA, reorder point 20 EA · Below safety stock');
      await expect(rows.nth(2)).toContainText('Needed by Oct 9, 2026');
      await expect(rows.nth(2)).toContainText('Request amount $1,200.00');
      await expect(rows.nth(3)).toContainText('No date');
      await expect(root.getByTestId('today-tile-all')).toContainText('Needs action4');
      await expect(root.getByTestId('today-tile-overdue')).toContainText('Overdue1');
      await expect(root.getByTestId('today-tile-changes')).toContainText('Documents updated today2');
      await expect(root.getByTestId('today-work-notes')).toContainText('Not listed for your role: receivables.');
      await expect(root.getByText('Fully received', { exact: true })).toBeVisible();
      await expect(root.getByText('Pending approval', { exact: true })).toBeVisible();
      await expect(root.getByText('Confirmed', { exact: true })).toBeVisible();
      await expect(root.getByText('Sales order', { exact: true })).toBeVisible();
      await expect(root.getByText('Bill', { exact: true })).toBeVisible();
      await expect(root.getByTestId('recent-documents').locator('tbody tr').first()).toContainText('Oct 7, 2026, 12:59 PM');
      const checklist = root.getByTestId('first-run-checklist');
      await expect(checklist).toContainText('3 of 5 steps done');
      await expect(checklist.getByTestId('first-run-step-opening_stock')).toContainText('Ask an administrator');
      // The overdue tile keeps the overdue row only.
      await root.getByTestId('today-tile-overdue').click();
      await expect(rows).toHaveCount(1);
      await root.getByTestId('today-tile-all').click();
      supplier = '示例供应商 · Trading';
      await root.getByRole('button', { name: 'Refresh overview' }).click();
      await expect(rows.nth(3)).toContainText('Supplier 示例供应商 · Trading');
      // A checklist step opens the import page for its record type.
      await checklist.getByTestId('first-run-step-customers').getByRole('link', { name: 'Start' }).click();
      await expect(page).toHaveURL(/\/app\/master-data\/import\?type=customers$/);
    } else {
      await expect(rows.nth(0)).toContainText('逾期 3 天');
      await expect(rows.nth(0)).toContainText('仍待收货 20 EA');
      await expect(root.getByText('全部收货', { exact: true })).toBeVisible();
      await expect(root.getByText('待审批', { exact: true })).toBeVisible();
      await expect(root.getByText('已确认', { exact: true })).toBeVisible();
      await expect(root.getByTestId('first-run-checklist')).toContainText('已完成 3/5 步');
      await expect(root.getByTestId('today-tile-changes')).toContainText('今日更新的单据2');
    }
  });
}
