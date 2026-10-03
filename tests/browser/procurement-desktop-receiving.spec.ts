import { test, expect } from '@playwright/test'

// Receives an issued PO on the desktop and posts the receipt against the real
// PostgreSQL API started by scripts/browser-receiving-api.mjs, which enables
// receiving posting and leaves mobile operations off.
test('a manager receives an issued purchase order on the desktop and posts the receipt', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { company: 'Browser Company', name: 'Kim', email: 'kim@example.com' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  const api = async (path: string) => (await request.get(path, { headers: { Authorization: `Bearer ${session.token}` } })).json()
  const capabilities = await api('/api/capabilities')
  expect(capabilities.capabilities.find((entry: { id: string }) => entry.id === 'mobile-operations')?.enabled).toBe(false)

  await page.goto('/app/procurement/orders/browser-receive-po')
  await page.getByTestId('po-action-receive').click()
  await expect(page).toHaveURL(/\/app\/procurement\/receiving\/new\?po=browser-receive-po$/)
  const form = page.getByTestId('receiving-form')
  await expect(form).toBeVisible()
  await expect(form.getByLabel('Receiving warehouse')).toHaveValue('browser-warehouse')
  await expect(form.getByTestId('receiving-form-line')).toContainText('BROWSER-SKU')
  await form.getByLabel('Accepted BROWSER-SKU').fill('4')
  await form.getByLabel('Rejected BROWSER-SKU').fill('1')
  await form.getByTestId('receiving-form-save').click()
  await expect(form.getByTestId('receiving-form-errors')).toContainText('Enter a reason for the rejected quantity.')
  await form.getByLabel('Rejection reason BROWSER-SKU').fill('Carton crushed in transit')
  await form.getByLabel('Location BROWSER-SKU').fill('B-02')
  await form.getByTestId('receiving-form-save').click()

  // The draft opens in the receiving workbench; edit it, then submit.
  await expect(page.getByTestId('receiving-workbench')).toBeVisible()
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('receiving-submit-draft')).toBeVisible()
  await page.getByTestId('receiving-edit-draft').click()
  await expect(page.getByTestId('receiving-form')).toBeVisible()
  await expect(page.getByLabel('Accepted BROWSER-SKU')).toHaveValue('4')
  await expect(page.getByLabel('Rejection reason BROWSER-SKU')).toHaveValue('Carton crushed in transit')
  await page.getByLabel('Accepted BROWSER-SKU').fill('5')
  await page.getByTestId('receiving-form-submit').click()

  await expect(page.getByTestId('receiving-workbench')).toBeVisible()
  await expect(page.getByText('Ready for posting', { exact: true }).first()).toBeVisible()
  await page.getByTestId('receiving-primary-action').click()
  await expect(page.getByTestId('impact-preview')).toBeVisible()
  await expect(page.getByTestId('balance-impact')).toContainText('0.0000 → 5.0000')
  await page.getByTestId('confirm-receiving-action').click()
  await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Movements · 1/)).toBeVisible()
  await expect(page.getByText(/Audit · 4/)).toBeVisible()

  const po = await api('/api/procurement/orders/browser-receive-po')
  expect(po.status).toBe('partially_received')
  expect(po.lines[0].receivedQuantity).toBe('5.0000')
  expect(po.lines[0].remainingQuantity).toBe('3.0000')
  const receipts = (await api('/api/procurement/receiving?poId=browser-receive-po')).items
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ workflowStatus: 'ready_for_receiving', postingStatus: 'posted', acceptedQuantity: '5.0000', rejectedQuantity: '1.0000' })

  await page.goto('/app/procurement/receiving')
  const row = page.getByTestId('receiving-record-list').locator('article', { hasText: receipts[0].documentNumber })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('receipt-posting-status')).toHaveText('Posted')
  await expect(row).toContainText('BROWSER-WH · Browser Warehouse')

  // The supplier drops the last 3. A receipt started by mistake is cancelled,
  // then the PO is closed and offers no more receiving.
  const stray = await (await request.post('/api/procurement/receiving', { headers: { Authorization: `Bearer ${session.token}` }, data: { poId: 'browser-receive-po', warehouseId: 'browser-warehouse', idempotencyKey: `stray-${Date.now()}`, lines: [{ purchaseOrderLineId: po.lines[0].id, acceptedQuantity: '1', location: 'B-02' }] } })).json()
  page.once('dialog', (dialog) => void dialog.accept('Started by mistake'))
  await page.goto(`/app/procurement/receiving/${stray.entityId}`)
  await page.getByTestId('receiving-cancel').click()
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('receiving-cancel')).toHaveCount(0)

  await page.goto('/app/procurement/orders/browser-receive-po')
  page.once('dialog', (dialog) => void dialog.accept('Supplier cancelled the remaining 3'))
  await page.getByTestId('po-action-close').click()
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('po-action-receive')).toHaveCount(0)
  const closed = await api('/api/procurement/orders/browser-receive-po')
  expect(closed.status).toBe('closed')
  expect(closed.lines[0].receivedQuantity).toBe('5.0000')
})
