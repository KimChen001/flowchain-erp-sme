import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Mobile step 2 (owner decision of 2026-10-09): the approval inbox and
// receiving line by line on a phone, against the real PostgreSQL API started
// by scripts/browser-receiving-api.mjs. Runs after the desktop receiving
// specs, on its own purchase order (browser-phone-po).
const PHONE = { width: 390, height: 844 }
const field = (page: Page, label: string) => page.locator('div.space-y-1\\.5', { has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) })

async function signIn(page: Page, request: APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { company: 'Browser Company', name: 'Kim', email: 'kim@example.com' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  return async (path: string) => (await request.get(path, { headers: { Authorization: `Bearer ${session.token}` } })).json()
}

test('a manager approves a purchase request from the phone inbox', async ({ page, request }) => {
  const api = await signIn(page, request)
  // A submitted request, made on the desktop form.
  await page.goto('/app/procurement/requests')
  await page.getByLabel('SKU 1').selectOption('browser-pr-item')
  // The supplier's reference price arrives first; the agreed price replaces it.
  await expect(page.getByLabel('Suppliers 1')).toHaveValue('browser-supplier')
  await expect(page.getByLabel('Estimated unit price 1')).toHaveValue('4.25')
  await page.getByLabel('Estimated unit price 1').fill('3.50')
  await field(page, 'Quantity').locator('input').fill('7')
  await field(page, 'Destination warehouse or service location').locator('select').selectOption('browser-warehouse')
  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(page.getByText('Purchase request submitted')).toBeVisible()
  const submitted = (await api('/api/procurement/requests')).filter((pr: { status: string }) => pr.status === 'submitted')
  const waitingRequest = submitted.find((pr: { totalAmount: number }) => pr.totalAmount === 24.5)
  expect(waitingRequest).toBeTruthy()

  await page.setViewportSize(PHONE)
  await page.goto('/app/overview/risks')
  // The tab shows how many decisions wait.
  await expect(page.getByTestId('mobile-approvals-count')).toHaveText(String((await api('/api/me/approvals-waiting')).count))
  await page.getByTestId('mobile-tab-approvals').click()
  await expect(page).toHaveURL(/\/app\/overview\/approvals$/)
  await expect(page.getByTestId('mobile-tab-approvals')).toHaveAttribute('aria-current', 'page')
  const card = page.locator(`[data-approval-key="purchase_request:${waitingRequest.id}"]`)
  await expect(card).toContainText(waitingRequest.id)
  await expect(card).toContainText('$24.50')

  // A rejection needs a reason; cancelling leaves the request waiting.
  await card.getByTestId('approval-reject').click()
  const sheet = page.getByTestId('approval-reject-sheet')
  await sheet.getByTestId('approval-reject-confirm').click()
  await expect(sheet).toContainText('Enter a reason.')
  await sheet.getByRole('button', { name: 'Cancel' }).last().click()
  await expect(sheet).toHaveCount(0)

  await card.getByTestId('approval-approve').click()
  await expect(page.getByText(`${waitingRequest.id}: Approved`)).toBeVisible()
  await expect(card).toHaveCount(0)
  // The tab count follows the decision.
  await expect(page.getByTestId('mobile-approvals-count')).toHaveCount((await api('/api/me/approvals-waiting')).count ? 1 : 0)
  expect((await api('/api/procurement/requests')).find((pr: { id: string }) => pr.id === waitingRequest.id).status).toBe('approved')

  // Done by me lists the decision.
  await page.getByTestId('approval-view-done').click()
  const row = page.getByTestId('approval-history-row').filter({ hasText: waitingRequest.id })
  await expect(row).toContainText('Approved')
  await expect(row).toContainText('Purchase request')
})

test('a receiver receives an order line by line on a phone', async ({ page, request }) => {
  const api = await signIn(page, request)
  await page.setViewportSize(PHONE)
  await page.goto('/app/overview/risks')
  await page.getByTestId('mobile-tab-receive').click()
  const order = page.getByTestId('receiving-open-order').filter({ hasText: 'browser-phone-po' })
  await expect(order).toContainText('1 line open')
  await order.getByTestId('receiving-open-order-receive').click()
  await expect(page).toHaveURL(/\/app\/procurement\/receiving\/new\?po=browser-phone-po$/)

  const form = page.getByTestId('receiving-form')
  await expect(form.getByTestId('receiving-form-cards')).toBeVisible()
  const line = form.getByTestId('receiving-form-line')
  // The stepper starts at the open quantity and stays within it.
  await expect(line.getByLabel('Accepted BROWSER-SKU')).toHaveValue('6')
  await expect(line.getByRole('button', { name: 'One more BROWSER-SKU' })).toBeDisabled()
  await line.getByRole('button', { name: 'One less BROWSER-SKU' }).click()
  await line.getByRole('button', { name: 'One less BROWSER-SKU' }).click()
  await expect(line.getByLabel('Accepted BROWSER-SKU')).toHaveValue('4')
  await line.getByRole('button', { name: 'Some arrived damaged or wrong?' }).click()
  await line.getByLabel('Rejected BROWSER-SKU').fill('1')
  await line.getByLabel('Rejection reason BROWSER-SKU').fill('Dented')
  await line.getByLabel('Location BROWSER-SKU').fill('P-01')

  // The actions sit above the tabs, within thumb reach.
  const submit = page.getByTestId('receiving-form-submit')
  expect(await submit.evaluate((element) => getComputedStyle(element.parentElement!).position)).toBe('fixed')
  await submit.click()
  await expect(page.getByTestId('receiving-workbench')).toBeVisible()
  await expect(page.getByText('Ready for posting', { exact: true }).first()).toBeVisible()
  await page.getByTestId('receiving-primary-action').click()
  await expect(page.getByTestId('balance-impact')).toContainText('0.0000 → 4.0000')
  await page.getByTestId('confirm-receiving-action').click()
  await expect.poll(async () => (await api('/api/procurement/orders/browser-phone-po')).status).toBe('partially_received')
  const po = await api('/api/procurement/orders/browser-phone-po')
  expect(po.lines[0].receivedQuantity).toBe('4.0000')
  expect(po.lines[0].remainingQuantity).toBe('2.0000')
})

test('desktop keeps the receipt table and shows the approval inbox as a Today tab', async ({ page, request }) => {
  await signIn(page, request)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/app/overview/approvals')
  await expect(page.getByTestId('approval-inbox')).toBeVisible()
  await expect(page.getByTestId('module-subnav').getByRole('link', { name: 'Approvals' })).toHaveAttribute('aria-current', 'page')
  await page.goto('/app/procurement/receiving/new?po=browser-phone-po')
  await expect(page.getByTestId('receiving-form-cards')).toHaveCount(0)
  await expect(page.getByTestId('receiving-form').locator('table')).toBeVisible()
})
