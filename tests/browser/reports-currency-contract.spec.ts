import { expect, test, type Page } from '@playwright/test'

async function authenticate(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Ignored', company: 'Ignored' } })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  await page.route('**/api/me/localization', route => route.fulfill({
    json: {
      languagePreference: 'en-US',
      defaultLanguage: 'zh-CN',
      effectiveLanguage: 'en-US',
      locale: 'en-US',
      timezone: 'America/New_York',
      workspaceName: 'FlowChain Operations',
    },
  }))
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token)
    localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
}

function collectRuntimeErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  return errors
}

test('reports overview presents a business-safe empty amount state', async ({ page }) => {
  await authenticate(page)
  const errors = collectRuntimeErrors(page)
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByRole('button', { name: /Purchase order amount/ })).toContainText('No monetary data')
  await expect(page.getByTestId('reports-multi-currency-status')).toHaveCount(0)
  await expect(page.getByText('Select a currency')).toHaveCount(0)
  await expect(page.getByTestId('reports-data-scope-limitations')).toContainText('Data scope notes')
  await expect(page.locator('body')).not.toContainText(/_runtime_|\b[a-z]+(?:_[a-z]+)+\b/)
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})

test('reports overview renders an unfiltered single-currency scope safely', async ({ page }) => {
  await authenticate(page)
  const errors = collectRuntimeErrors(page)
  await page.route('**/api/reports/query', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    payload.dataScope = {
      ...payload.dataScope,
      currencyCode: 'CNY',
      currencyLabel: '人民币（CNY）',
      currencies: ['CNY'],
      currencyAggregationStatus: 'single_currency',
      currencyAmounts: [{ currencyCode: 'CNY', currencyLabel: '人民币（CNY）', amount: 100 }],
      fxConverted: false,
    }
    payload.kpis = payload.kpis.map((item: { unit: string }) => item.unit === 'currency' ? { ...item, value: 100, currentValue: 100, dataStatus: 'complete', limitations: [] } : item)
    await route.fulfill({ response, json: payload })
  })
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByText('Currency: Chinese yuan (CNY)')).toBeVisible()
  await expect(page.getByRole('button', { name: /Purchase order amount/ })).toContainText(/¥\s?100/)
  await expect(page.getByText('Business overview module failed')).toHaveCount(0)
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})

test('reports overview presents an unconverted multi-currency scope without crashing', async ({ page }) => {
  await authenticate(page)
  const errors = collectRuntimeErrors(page)
  await page.route('**/api/reports/query', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    payload.dataScope = {
      ...payload.dataScope,
      currencyCode: null,
      currencyLabel: '多币种，未折算',
      currencies: ['CNY', 'USD'],
      currencyAggregationStatus: 'multi_currency_unconverted',
      currencyAmounts: [
        { currencyCode: 'CNY', currencyLabel: '人民币（CNY）', amount: 100 },
        { currencyCode: 'USD', currencyLabel: '美元（USD）', amount: 200 },
      ],
      fxConverted: false,
    }
    payload.kpis = payload.kpis.map((item: { unit: string }) => item.unit === 'currency' ? { ...item, value: null, currentValue: null, dataStatus: 'incomplete', limitations: ['multi_currency_unconverted'] } : item)
    await route.fulfill({ response, json: payload })
  })
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByTestId('reports-multi-currency-status')).toContainText('Multiple currencies, not converted')
  await expect(page.getByTestId('reports-multi-currency-status')).toContainText('Select a currency')
  await expect(page.getByText('Business overview module failed')).toHaveCount(0)
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})
