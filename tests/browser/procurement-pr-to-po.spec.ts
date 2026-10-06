import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

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
  // Earlier PO prices show beside the price; the item has none yet, and the
  // price stays the supplier's reference price.
  await expect(page.getByTestId('pr-line-price-history-1')).toHaveText('No issued PO for this item yet')
  // The buyer agrees a price below the reference price, so the PO price
  // (4.10) and the reference price (4.25) tell the two sources apart below.
  await page.getByLabel('Estimated unit price 1').fill('4.10')
  await field(page, 'Quantity').locator('input').fill('12')
  await field(page, 'Destination warehouse or service location').locator('select').selectOption('browser-warehouse')
  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(page.getByText('Purchase request submitted')).toBeVisible()

  const submitted = (await api('/api/procurement/requests')).find((pr: { status: string }) => pr.status === 'submitted')
  expect(submitted).toBeTruthy()
  expect(submitted.currency).toBe('USD')
  expect(submitted.totalAmount).toBe(49.2)
  const row = page.locator('tr', { hasText: submitted.id })
  await row.getByRole('button', { name: 'Approve' }).click()
  await expect(row.getByRole('button', { name: 'Create draft PO' })).toBeVisible()
  await row.getByRole('button', { name: 'Create draft PO' }).click()

  await expect.poll(async () => (await api('/api/procurement/orders')).filter((po: { sourceRequest: string }) => po.sourceRequest === submitted.id).length).toBe(1)
  const po = (await api('/api/procurement/orders')).find((order: { sourceRequest: string }) => order.sourceRequest === submitted.id)
  expect(po.status).toBe('draft')
  expect(po.amount).toBe(49.2)
  expect(po.currency).toBe('USD')

  await page.goto(`/app/procurement/orders/${encodeURIComponent(po.id)}`)
  const issuedField = page.locator('div.min-w-0', { has: page.getByText('Issue date', { exact: true }) }).last()
  // A draft was never issued, so it says so rather than "not recorded".
  await expect(issuedField).toContainText('Not issued yet')
  await expect(issuedField).not.toContainText('Issue date not recorded')
  // The PO's own line is not its own history.
  await expect(page.locator('[data-testid^="po-line-price-history-"]').first()).toContainText('No issued PO for this item yet')
  await page.getByTestId('po-action-submit').click()
  await expect(page.getByTestId('po-action-approve')).toBeVisible()
  await page.getByTestId('po-action-approve').click()
  await expect(page.getByTestId('po-action-issue')).toBeVisible()
  await page.getByTestId('po-action-issue').click()
  await expect(page.getByTestId('po-workflow-actions')).toHaveCount(0)
  await expect(issuedField).toContainText(/\d{4}-\d{2}-\d{2}/)

  const issued = await api(`/api/procurement/orders/${encodeURIComponent(po.id)}`)
  expect(issued.status).toBe('issued')
  expect(issued.version).toBe(3)
  expect(issued.totalAmount).toBe('49.2000')
  expect(issued.currency).toBe('USD')

  // The next request for the item shows this PO's price (4.10) as the last
  // PO price, labelled as an ordered price, and the estimated price stays the
  // supplier's reference price (4.25): nothing is filled in from history.
  await page.goto('/app/procurement/requests')
  await page.getByLabel('SKU 1').selectOption('browser-pr-item')
  await expect(page.getByTestId('pr-line-price-history-1-latest')).toContainText(`Last PO price USD 4.10 / EA · ${po.id}`)
  await expect(page.getByTestId('pr-line-price-history-1-note')).toContainText('not invoiced or paid prices')
  await expect(page.getByLabel('Estimated unit price 1')).toHaveValue('4.25')
})

test('a purchase request opened from the assistant arrives prefilled, labels each value, and saves only when asked', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { company: 'Browser Company', name: 'Kim', email: 'kim@example.com' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  const api = async (path: string) => (await request.get(path, { headers: { Authorization: `Bearer ${session.token}` } })).json()
  const before = new Set((await api('/api/procurement/requests')).map((pr: { id: string }) => pr.id))

  // The query the assistant's purchase request draft opens the form with.
  const reason = '3 available against a reorder point of 20; nothing incoming covers it.'
  await page.goto(`/app/procurement/requests?mode=create&itemId=browser-pr-item&sku=browser-pr-item&quantity=17&reason=${encodeURIComponent(reason)}&origin=ai_assistant`)
  await expect(page.getByTestId('prefill-banner')).toContainText('Prefilled from the assistant')
  await expect(page.getByLabel('SKU 1')).toHaveValue('browser-pr-item')
  await expect(page.getByLabel('Suppliers 1')).toHaveValue('browser-supplier')
  await expect(field(page, 'Quantity').locator('input')).toHaveValue('17')
  await expect(page.getByLabel('Estimated unit price 1')).toHaveValue('4.25')
  await expect(field(page, 'Destination warehouse or service location').locator('select')).toHaveValue('browser-warehouse')
  await expect(page.getByLabel('Internal line notes 1')).toHaveValue(reason)
  await expect(page.getByTestId('prefill-source-quantity')).toHaveText('From the stock check')
  await expect(page.getByTestId('prefill-source-supplierId')).toHaveText('Preferred supplier')
  await expect(page.getByTestId('prefill-source-estimatedUnitPrice')).toHaveText('Reference price')
  await expect(page.getByTestId('prefill-source-targetWarehouseId')).toHaveText('Item default warehouse')
  await expect(page.getByTestId('prefill-source-internalLineComment')).toHaveText('Reason from the assistant')
  // Opening the form saves nothing.
  expect((await api('/api/procurement/requests')).filter((pr: { id: string }) => !before.has(pr.id))).toHaveLength(0)

  // A changed value is no longer the suggestion, so it loses its label.
  await field(page, 'Quantity').locator('input').fill('20')
  await expect(page.getByTestId('prefill-source-quantity')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Purchase request draft saved')).toBeVisible()
  await expect(page.getByTestId('prefill-banner')).toHaveCount(0)

  const saved = (await api('/api/procurement/requests')).filter((pr: { id: string }) => !before.has(pr.id))
  expect(saved).toHaveLength(1)
  expect(saved[0].status).toBe('draft')
  expect(Number(saved[0].lines[0].quantity)).toBe(20)
  expect(saved[0].lines[0].supplierId).toBe('browser-supplier')
  expect(saved[0].lines[0].internalLineComment).toBe(reason)
})

// Suppliers and items made through the API, so each run has its own:
// an item with a preferred supplier (Acme) and a second approved source
// (Bolt), and an item with two approved sources and none preferred.
async function supplierChoiceData(request: APIRequestContext, headers: Record<string, string>) {
  const stamp = Date.now()
  const supplier = async (name: string) => (await (await request.post('/api/master-data/suppliers', { headers, data: { supplierCode: `SC-${name}-${stamp}`, supplierName: `${name} ${stamp}`, defaultCurrency: 'USD' } })).json()).supplier.id as string
  const item = async (name: string) => {
    const created = await request.post('/api/master-data/items', { headers, data: { sku: `SC-${name}-${stamp}`, itemName: `${name} ${stamp}`, baseUnit: 'EA', defaultWarehouseId: 'browser-warehouse' } })
    expect(created.status()).toBe(201)
    const body = (await created.json()).item
    return String(body.itemId || body.id)
  }
  const ids = { acme: await supplier('Acme'), bolt: await supplier('Bolt'), crane: await supplier('Crane'), withPreferred: await item('Wrap'), nonePreferred: await item('Tape'), stamp }
  for (const [itemId, supplierId, preferred] of [[ids.withPreferred, ids.acme, true], [ids.withPreferred, ids.bolt, false], [ids.nonePreferred, ids.bolt, false], [ids.nonePreferred, ids.crane, false]] as const) {
    const link = await request.post(`/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`, { headers, data: { supplierId, preferred, approved: true, currency: 'USD', referencePrice: 3.5, leadTimeDays: 5 } })
    expect(link.ok()).toBeTruthy()
  }
  return ids
}

async function signIn(page: Page, request: APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { company: 'Browser Company', name: 'Kim', email: 'kim@example.com' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  return { Authorization: `Bearer ${session.token}` }
}

test('with several approved sources and none preferred, the supplier stays empty and the sources are listed by last PO date', async ({ page, request }) => {
  const headers = await signIn(page, request)
  const ids = await supplierChoiceData(request, headers)
  // Crane was ordered from on 2026-09-14; Bolt never.
  await page.route('**/api/procurement/item-supplier-orders**', (route) => route.fulfill({ json: { itemId: ids.nonePreferred, timeZone: 'America/New_York', lastOrders: [{ supplierId: ids.crane, purchaseOrderId: 'PO-0031', orderNumber: 'PO-0031', day: '2026-09-14', dateSource: 'issue_date' }] } }))

  await page.goto(`/app/procurement/requests?mode=create&itemId=${encodeURIComponent(ids.nonePreferred)}&quantity=5&origin=ai_assistant`)
  await expect(page.getByLabel('SKU 1')).toHaveValue(ids.nonePreferred)
  await expect(page.getByLabel('Suppliers 1')).toHaveValue('')
  await expect(page.getByTestId('prefill-source-supplierId')).toHaveText('Choose a supplier: several approved sources, none preferred')
  // Nothing of a supplier nobody chose: no reference price, no lead-time date.
  await expect(page.getByLabel('Estimated unit price 1')).toHaveValue('')
  await expect(page.getByTestId('prefill-source-needByDate')).toHaveCount(0)
  const choices = page.getByTestId('pr-supplier-choices')
  await expect(choices).toContainText('Approved sources, most recent issued PO first')
  const options = choices.getByTestId('pr-supplier-choices-option')
  await expect(options).toHaveCount(2)
  await expect(options.nth(0)).toHaveAttribute('data-supplier-id', ids.crane)
  await expect(options.nth(0)).toContainText('Last issued PO 2026-09-14 · PO-0031')
  await expect(options.nth(1)).toHaveAttribute('data-supplier-id', ids.bolt)
  await expect(options.nth(1)).toContainText('No issued PO yet')
  // Choosing one sets the supplier only.
  await options.nth(1).click()
  await expect(page.getByLabel('Suppliers 1')).toHaveValue(ids.bolt)
  await expect(page.getByLabel('Estimated unit price 1')).toHaveValue('')
  await expect(page.getByTestId('supplier-override-reason-1')).toHaveCount(0)

  // Without the PO dates the list is A-Z and says the dates are not available.
  await page.unroute('**/api/procurement/item-supplier-orders**')
  await page.route('**/api/procurement/item-supplier-orders**', (route) => route.fulfill({ status: 403, json: { code: 'AUTHORIZATION_PERMISSION_DENIED', message: 'Denied' } }))
  await page.goto(`/app/procurement/requests?mode=create&itemId=${encodeURIComponent(ids.nonePreferred)}&quantity=5&origin=ai_assistant&again=1`)
  await expect(page.getByTestId('pr-supplier-choices-no-dates')).toHaveText('PO dates not available')
  await expect(page.getByTestId('pr-supplier-choices')).toContainText('Approved sources, A–Z')
  await expect(page.getByTestId('pr-supplier-choices')).not.toContainText('No issued PO yet')
  await expect(page.getByTestId('pr-supplier-choices-option').nth(0)).toHaveAttribute('data-supplier-id', ids.bolt)
})

test('a line that skips the preferred supplier asks why, and the approver sees the reason on the request and the PO', async ({ page, request }) => {
  const headers = await signIn(page, request)
  const api = async (path: string) => (await request.get(path, { headers })).json()
  const ids = await supplierChoiceData(request, headers)
  const before = new Set((await api('/api/procurement/requests')).map((pr: { id: string }) => pr.id))

  await page.goto('/app/procurement/requests')
  await page.getByLabel('SKU 1').selectOption(ids.withPreferred)
  await expect(page.getByLabel('Suppliers 1')).toHaveValue(ids.acme)
  await expect(page.getByTestId('supplier-override-reason-1')).toHaveCount(0)
  await page.getByLabel('Suppliers 1').selectOption(ids.bolt)
  const picker = page.getByTestId('supplier-override-reason-1')
  await expect(picker).toContainText(`Why not the preferred supplier (Acme ${ids.stamp})?`)
  await page.getByLabel('Estimated unit price 1').fill('3.20')
  await field(page, 'Quantity').locator('input').fill('6')
  await field(page, 'Destination warehouse or service location').locator('select').selectOption('browser-warehouse')
  // No reason yet: nothing is saved and the picker says what is missing.
  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(picker.getByRole('alert')).toHaveText('Choose a reason')
  expect((await api('/api/procurement/requests')).filter((pr: { id: string }) => !before.has(pr.id))).toHaveLength(0)
  // Other needs a note.
  await picker.getByTestId('supplier-override-reason-1-code').selectOption('other')
  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(picker.getByRole('alert')).toHaveText('Add a note of 3 to 500 characters')
  // A reason belongs to the supplier it was given for: switching away and
  // back asks again.
  await picker.getByTestId('supplier-override-reason-1-code').selectOption('stock_now')
  await page.getByLabel('Suppliers 1').selectOption(ids.acme)
  await expect(picker).toHaveCount(0)
  await page.getByLabel('Suppliers 1').selectOption(ids.bolt)
  await expect(picker.getByTestId('supplier-override-reason-1-code')).toHaveValue('')
  await picker.getByTestId('supplier-override-reason-1-code').selectOption('lead_time')
  await picker.getByTestId('supplier-override-reason-1-note').fill('Acme is out until November')
  await page.getByRole('button', { name: 'Save and submit' }).click()
  await expect(page.getByText('Purchase request submitted')).toBeVisible()

  const submitted = (await api('/api/procurement/requests')).find((pr: { id: string }) => !before.has(pr.id))
  expect(submitted.lines[0].supplierOverride).toMatchObject({ reasonCode: 'lead_time', note: 'Acme is out until November', preferredSupplierId: ids.acme })
  const flag = `Not preferred (Acme ${ids.stamp}). Reason: Lead time — Acme is out until November`
  // The list row's approve button skips the detail, so the row shows the reason too.
  const row = page.locator('tr', { hasText: submitted.id })
  await expect(row.getByTestId('pr-row-supplier-overrides')).toHaveText('1 line skips the preferred supplier')
  await expect(row.getByTestId('pr-row-supplier-override')).toHaveText(`SC-Wrap-${ids.stamp} · Bolt ${ids.stamp}: ${flag}`)
  await row.getByText(submitted.id).click()
  await expect(page.getByTestId('pr-line-supplier-override')).toHaveText(flag)

  await page.goto('/app/procurement/requests')
  await row.getByRole('button', { name: 'Approve' }).click()
  await row.getByRole('button', { name: 'Create draft PO' }).click()
  await expect.poll(async () => (await api('/api/procurement/orders')).filter((po: { sourceRequest: string }) => po.sourceRequest === submitted.id).length).toBe(1)
  const po = (await api('/api/procurement/orders')).find((order: { sourceRequest: string }) => order.sourceRequest === submitted.id)
  await page.goto(`/app/procurement/orders/${encodeURIComponent(po.id)}`)
  await expect(page.getByTestId('po-line-supplier-override')).toHaveText(flag)
})
