import { test, expect } from '@playwright/test';

for (const language of ['en-US', 'zh-CN']) {
  test(`home work cards and recent document labels use ${language}`, async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Manager', company: 'Demo' } });
    expect(login.ok()).toBeTruthy();
    const session = await login.json();
    await page.addInitScript(({ token, user }) => { localStorage.setItem('flowchain:auth-token', token); localStorage.setItem('flowchain:current-user', JSON.stringify(user)); }, session);
    await page.route('**/api/me/localization', route => route.fulfill({ json: { effectiveLanguage: language, languagePreference: language, defaultLanguage: 'en-US', locale: 'en-US', timezone: 'America/New_York' } }));
    let supplier = 'Acme Components';
    await page.route('**/api/home/overview', route => route.fulfill({ json: {
      workItems: [
        { id: 'PO-1', entityType: 'purchase_order', title: 'Draft PO 待复核', description: `供应商 ${supplier} · not_sent`, priority: '中' },
        { id: 'PR-1', entityType: 'purchase_request', title: '采购申请待审批', description: '申请金额 1200', priority: '高' },
        { id: 'PR-2', entityType: 'purchase_request', title: '采购申请待转换', description: '审批已完成，等待生成 Draft PO', priority: '中' },
      ], unresolvedRisks: null, todayChanges: 2,
      recentDocuments: ['fully_received', 'pending_approval', 'partially_received', 'draft'].map((status, index) => ({ id: `PO-${index}`, entityType: 'purchase_order', type: '采购订单', status, supplier, amount: 1200, updatedAt: '2026-09-11T12:00:00Z' })), limitations: [],
    } }));
    await page.goto('/app/overview/risks');
    const root = page.getByTestId('runtime-homepage');
    await expect(root.getByText(language === 'en-US' ? 'Draft PO awaiting review' : 'Draft PO 待复核', { exact: true })).toBeVisible();
    if (language === 'en-US') {
      await expect(root).not.toContainText(/[\u3400-\u9fff]/);
      await expect(root.getByText('Supplier Acme Components · Not sent', { exact: true })).toBeVisible();
      await expect(root.getByText('Fully received', { exact: true })).toBeVisible();
      await expect(root.getByText('Pending approval', { exact: true })).toBeVisible();
      supplier = '示例供应商 · Trading';
      await root.getByRole('button', { name: 'Refresh overview' }).click();
      await expect(root.getByText('Supplier 示例供应商 · Trading · Not sent', { exact: true })).toBeVisible();
    } else {
      await expect(root.getByText('全部收货', { exact: true })).toBeVisible();
      await expect(root.getByText('待审批', { exact: true })).toBeVisible();
    }
  });
}
