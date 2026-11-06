import { test, expect } from '@playwright/test'

// A PO command refused because the order changed elsewhere (another user, or
// the mobile approval) says so in plain words and reloads the order, instead
// of leaving buttons for the version the page no longer matches. Runs against
// the PostgreSQL API started by scripts/browser-receiving-api.mjs; only the
// refused command is stubbed, the page and its reload read the real API.
test('a PO action refused for a stale version says the order changed and reloads it', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { company: 'Browser Company', name: 'Kim', email: 'kim@example.com' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  await page.route('**/api/procurement/orders/browser-po/close', (route) => route.fulfill({
    status: 409,
    json: { code: 'SYNC_VERSION_CONFLICT', message: 'Purchase order changed concurrently.', entityId: 'browser-po', expectedVersion: 0, currentVersion: 1, availableActions: ['reload'] },
  }))

  await page.goto('/app/procurement/orders/browser-po')
  await expect(page.getByTestId('po-action-close')).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept('Supplier stopped the line'))
  const reload = page.waitForRequest((req) => req.method() === 'GET' && req.url().endsWith('/api/purchase-orders-workbench'))
  await page.getByTestId('po-action-close').click()
  await reload
  await expect(page.getByText('This purchase order was changed elsewhere, so nothing was done. It has been reloaded; check it and try again.')).toBeVisible()
  await expect(page.getByTestId('po-workflow-actions').getByRole('button')).toHaveText(['Close PO'])
})
