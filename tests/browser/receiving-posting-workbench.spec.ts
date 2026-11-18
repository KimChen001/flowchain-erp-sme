import { test, expect } from '@playwright/test'
import { PDFParse } from 'pdf-parse'

// Design audit L11-17: a receive sheet longer than one page printed only its
// first dozen lines (the table was a fixed box that clipped the rest) and
// "Page 1 of 1". Printed now, the sheet runs onto as many pages as its lines
// need, every line in full, numbered by the browser.
test('a 40-line receive sheet prints every line across pages', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { company: 'Forged Browser Company', name: 'Forged Name', email: 'kim@example.com', role: 'admin', tenantId: 'forged' } })
  expect(login.ok()).toBeTruthy()
  const session = await login.json()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  // The seeded receipt has one line; the page reads it with 40.
  const sku = (n: number) => `PRINT-SKU-${String(n).padStart(2, '0')}`
  await page.route('**/api/procurement/receiving/browser-grn', async (route) => {
    const response = await route.fetch()
    const detail = await response.json()
    const line = detail.lines[0]
    detail.lines = Array.from({ length: 40 }, (_, index) => ({ ...line, id: `${line.id}-print-${index + 1}`, sku: sku(index + 1), itemName: `Printed line ${index + 1}` }))
    await route.fulfill({ response, json: detail })
  })

  await page.goto('/app/procurement/receiving/browser-grn')
  await page.getByTestId('receiving-print-sheet').click()
  const editor = page.getByTestId('print-layout-editor')
  await expect(editor).toContainText(sku(40))
  await page.emulateMedia({ media: 'print' })
  // In print the table's box holds all 40 lines: none is cut off below it.
  const table = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="print-data-table"]')!.closest<HTMLElement>('.print-layout-element')!
    const rows = [...element.querySelectorAll('tbody tr')]
    return { rows: rows.length, overflow: getComputedStyle(element).overflow, inside: rows.every((row) => row.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1) }
  })
  expect(table).toEqual({ rows: 40, overflow: 'visible', inside: true })

  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
  const parser = new PDFParse({ data: new Uint8Array(pdf) })
  try {
    const { text, total } = await parser.getText()
    expect(total).toBeGreaterThan(1)
    for (let n = 1; n <= 40; n += 1) expect(text).toContain(sku(n))
    // The header row repeats on the next page; no page says "1 of 1".
    expect(text.split('Qty received').length - 1).toBeGreaterThanOrEqual(total)
    expect(text).not.toContain('Page 1 of 1')
    expect(text).toContain(`Page ${total} of ${total}`)
  } finally {
    await parser.destroy()
  }
})

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
  await expect(page.getByText('Operations manager', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Workflow').first()).toBeVisible()
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Posting', { exact: true }).first()).toBeVisible()
  // "Not posted", as the receiving cards and filters say (design audit U-21).
  await expect(page.getByText('Not posted', { exact: true }).first()).toBeVisible()

  // The receive sheet prints from the receipt: its number, the line and the
  // receiver as recorded. The print rules apply only while the editor is open.
  await page.getByTestId('receiving-print-sheet').click()
  const editor = page.getByTestId('print-layout-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('GRN-BROWSER-001')
  await expect(editor).toContainText('BROWSER-SKU')
  await expect(editor).toContainText('Receiving Browser Manager')
  // The built-in sheet is in the interface language.
  await expect(editor).toContainText('Goods Receipt')
  await expect(editor).toContainText('Received by')
  await expect(page.locator('body')).toHaveClass(/fc-print-layout-open/)
  await page.evaluate(() => { (window as unknown as { __printed?: boolean }).__printed = false; window.print = () => { (window as unknown as { __printed?: boolean }).__printed = true } })
  await editor.getByTestId('print-document-button').click()
  expect(await page.evaluate(() => (window as unknown as { __printed?: boolean }).__printed)).toBe(true)
  await editor.getByRole('button', { name: 'Back to document' }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/fc-print-layout-open/)

  await page.getByTestId('receiving-primary-action').click()
  await expect(page.getByTestId('impact-preview')).toBeVisible()
  await expect(page.getByTestId('balance-impact')).toContainText('0 → 4')
  await page.getByTestId('confirm-receiving-action').click()
  await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Movements · 1/)).toBeVisible()
  await expect(page.getByText(/Audit · 1/)).toBeVisible()
  // Once posted the posting status is the receipt's one status, beside its
  // number (design audit U-17).
  await expect(page.getByText('Workflow', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('receipt-status')).toHaveText('Posted')

  await page.getByTestId('receiving-primary-action').click()
  await expect(page.getByText('Review receipt reversal')).toBeVisible()
  await page.getByTestId('reversal-reason').fill('Playwright correction verification')
  await page.getByTestId('confirm-receiving-action').click()
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('evidence-event').filter({ hasText: 'Receipt posting' })).toBeVisible()
  await expect(page.getByTestId('evidence-event').filter({ hasText: 'Receipt reversal' })).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('receiving-workbench')).toBeVisible()
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Receipt reversal/)).toBeVisible()

  await page.getByText('Kim', { exact: true }).click()
  await page.getByRole('button', { name: 'My profile' }).click()
  await expect(page.getByTestId('workspace-settings-profile')).toBeVisible()
  await expect(page.locator('input[value="kim@example.com"]')).toBeVisible()
  // The profile names the roles assigned in Roles & permissions, not the legacy role.
  await expect(page.getByRole('textbox', { name: 'Role', exact: true })).toHaveValue('Operations manager')
})
