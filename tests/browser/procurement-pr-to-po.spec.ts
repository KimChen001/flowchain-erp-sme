import { test, expect, type Page } from '@playwright/test'

// Drives the purchase request panel and the PO detail page against the real
// PostgreSQL API started by scripts/browser-receiving-api.mjs.
const field = (page: Page, label: string) => page.locator('div.space-y-1\\.5', { has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) })

test('a manager takes a purchase request to an issued purchase order in the browser', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { company: 'Browser Company', name: 'Kim', email: 'kim@example.com' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  const api = async (path: string) => (await request.get(path, { headers: { Authorization: `Bearer ${session.token}` } })).json()

  await page.goto('/app/procurement/requests')
  await page.getByLabel('SKU 1').selectOption('browser-pr-item')
  const supplier = page.getByLabel('Suppliers 1')
  await expect(supplier.locator('option[value="browser-supplier"]')).toHaveCount(1)
  await expect(supplier).toHaveValue('browser-supplier')
  await expect(page.getByLabel('Estimated unit price 1')).toHaveValue('4.25')
  await field(page, 'Quantity').locator('input').fill('12')
  await field(page, 'Destination warehouse or service location').locator('select').selectOption('browser-warehouse')
  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(page.getByText('Purchase request submitted')).toBeVisible()

  const submitted = (await api('/api/procurement/requests')).find((pr: { status: string }) => pr.status === 'submitted')
  expect(submitted).toBeTruthy()
  expect(submitted.currency).toBe('USD')
  expect(submitted.totalAmount).toBe(51)
  const row = page.locator('tr', { hasText: submitted.id })
  await row.getByRole('button', { name: 'Approve' }).click()
  await expect(row.getByRole('button', { name: 'Create draft PO' })).toBeVisible()
  await row.getByRole('button', { name: 'Create draft PO' }).click()

  await expect.poll(async () => (await api('/api/procurement/orders')).filter((po: { sourceRequest: string }) => po.sourceRequest === submitted.id).length).toBe(1)
  const po = (await api('/api/procurement/orders')).find((order: { sourceRequest: string }) => order.sourceRequest === submitted.id)
  expect(po.status).toBe('draft')
  expect(po.amount).toBe(51)
  expect(po.currency).toBe('USD')

  await page.goto(`/app/procurement/orders/${encodeURIComponent(po.id)}`)
  await page.getByTestId('po-action-submit').click()
  await expect(page.getByTestId('po-action-approve')).toBeVisible()
  await page.getByTestId('po-action-approve').click()
  await expect(page.getByTestId('po-action-issue')).toBeVisible()
  await page.getByTestId('po-action-issue').click()
  await expect(page.getByTestId('po-workflow-actions')).toHaveCount(0)

  const issued = await api(`/api/procurement/orders/${encodeURIComponent(po.id)}`)
  expect(issued.status).toBe('issued')
  expect(issued.version).toBe(3)
  expect(issued.totalAmount).toBe('51.0000')
  expect(issued.currency).toBe('USD')
})
