import { test, expect } from '@playwright/test'

test('receiving workbench posts and reverses through real PostgreSQL APIs', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { company: 'Forged Browser Company', name: 'Forged Name', email: 'kim@example.com', role: 'admin', tenantId: 'forged' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)

  await page.goto('/app/procurement/receiving/browser-grn')
  await expect(page.getByTestId('receiving-workbench')).toBeVisible()
  await expect(page.getByText('Kim', { exact: true })).toBeVisible()
  await expect(page.getByText('Supply Chain Manager', { exact: true })).toBeVisible()
  await expect(page.getByText('Workflow').first()).toBeVisible()
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Posting', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Unposted', { exact: true }).first()).toBeVisible()

  await page.getByTestId('receiving-primary-action').click()
  await expect(page.getByTestId('impact-preview')).toBeVisible()
  await expect(page.getByTestId('balance-impact')).toContainText('0.0000 → 4.0000')
  await page.getByTestId('confirm-receiving-action').click()
  await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Movements · 1/)).toBeVisible()
  await expect(page.getByText(/Audit · 1/)).toBeVisible()

  await page.getByTestId('receiving-primary-action').click()
  await expect(page.getByText('Review receipt reversal')).toBeVisible()
  await page.getByTestId('reversal-reason').fill('Playwright correction verification')
  await page.getByTestId('confirm-receiving-action').click()
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('evidence-event').filter({ hasText: 'receipt_posting' })).toBeVisible()
  await expect(page.getByTestId('evidence-event').filter({ hasText: 'receipt_reversal' })).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('receiving-workbench')).toBeVisible()
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/receipt_reversal/)).toBeVisible()

  await page.getByText('Kim', { exact: true }).click()
  await page.getByRole('button', { name: 'My Profile' }).click()
  await expect(page.getByTestId('workspace-settings-profile')).toBeVisible()
  await expect(page.locator('input[value="kim@example.com"]')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Role', exact: true })).toHaveValue('Manager')
})
