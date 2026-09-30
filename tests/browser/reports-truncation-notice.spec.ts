import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, language: 'en-US' | 'zh-CN') {
  const response = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Ignored', company: 'Ignored' } })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  await page.route('**/api/me/localization', route => route.fulfill({ json: { languagePreference: language, defaultLanguage: 'en-US', effectiveLanguage: language, locale: 'en-US', timezone: 'America/New_York' } }))
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
}

// The server marks subjects it read only up to its row limit. Real truncation is
// covered by tests/postgres/report-truncation.test.mjs; here the response is
// marked so the page can be checked without seeding thousands of records.
async function markTruncated(page: Page) {
  await page.route('**/api/reports/query', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    payload.truncatedSubjects = [{ subject: 'purchase_orders', limit: 500 }, { subject: 'suppliers', limit: 200 }]
    await route.fulfill({ response, json: payload })
  })
}

test('a complete report shows no truncation notice', async ({ page }) => {
  await login(page, 'en-US')
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByRole('button', { name: /Purchase order amount/ })).toBeVisible()
  await expect(page.getByTestId('reports-truncation-notice')).toHaveCount(0)
})

test('a truncated report says which records are missing in English', async ({ page }) => {
  await login(page, 'en-US')
  await markTruncated(page)
  await page.goto('/app/reports/procurement?view=analytics')
  const notice = page.getByTestId('reports-truncation-notice')
  await expect(notice).toContainText('Not every record is included')
  await expect(notice).toContainText('Showing the latest 500 purchase orders. Totals may be incomplete.')
  await expect(notice).toContainText('Showing the first 200 suppliers by name. Totals may be incomplete.')
  await expect(notice).not.toContainText(/[㐀-鿿]/)
})

test('a truncated report says which records are missing in Chinese', async ({ page }) => {
  await login(page, 'zh-CN')
  await markTruncated(page)
  await page.goto('/app/reports/overview')
  const notice = page.getByTestId('reports-truncation-notice')
  await expect(notice).toContainText('部分记录未纳入报表')
  await expect(notice).toContainText('仅显示最新的 500 张采购订单。 合计可能不完整。')
  await expect(notice).toContainText('仅显示按名称排序的前 200 个供应商。 合计可能不完整。')
})
