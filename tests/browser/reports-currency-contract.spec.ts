import { expect, test, type Page } from '@playwright/test'
import { buildRuntimeGovernedReport } from '../../server/domain/runtime-report-read-model.mjs'

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
  await expect(page.getByRole('button', { name: /Committed PO amount/ })).toContainText('No monetary data')
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
    payload.kpis = payload.kpis.map((item: { unit: string }) => item.unit === 'currency' ? { ...item, value: 100, currentValue: 100, dataStatus: 'complete', limitations: [], currencyCode: payload.dataScope.currencyCode, currencyLabel: payload.dataScope.currencyLabel, currencies: payload.dataScope.currencies, currencyAggregationStatus: 'single_currency', currencyAmounts: payload.dataScope.currencyAmounts } : item)
    await route.fulfill({ response, json: payload })
  })
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByText('Currency: Chinese yuan (CNY)')).toBeVisible()
  await expect(page.getByRole('button', { name: /Committed PO amount/ })).toContainText(/¥\s?100/)
  await expect(page.getByText('Business overview module failed')).toHaveCount(0)
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})

test('reports overview localizes a USD scope for the English workspace', async ({ page }) => {
  await authenticate(page)
  const errors = collectRuntimeErrors(page)
  await page.route('**/api/reports/query', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    payload.dataScope = {
      ...payload.dataScope,
      currencyCode: 'USD',
      currencyLabel: '美元（USD）',
      currencies: ['USD'],
      currencyAggregationStatus: 'single_currency',
      currencyAmounts: [{ currencyCode: 'USD', currencyLabel: '美元（USD）', amount: 100 }],
      fxConverted: false,
    }
    payload.kpis = payload.kpis.map((item: { unit: string }) => item.unit === 'currency' ? { ...item, value: 100, currentValue: 100, dataStatus: 'complete', limitations: [], currencyCode: payload.dataScope.currencyCode, currencyLabel: payload.dataScope.currencyLabel, currencies: payload.dataScope.currencies, currencyAggregationStatus: 'single_currency', currencyAmounts: payload.dataScope.currencyAmounts } : item)
    await route.fulfill({ response, json: payload })
  })
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByText('Currency: US dollar (USD)')).toBeVisible()
  await expect(page.getByRole('button', { name: /Committed PO amount/ })).toContainText(/\$100/)
  await expect(page.locator('body')).not.toContainText('美元')
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
    payload.kpis = payload.kpis.map((item: { unit: string }) => item.unit === 'currency' ? { ...item, value: null, currentValue: null, dataStatus: 'incomplete', limitations: ['multi_currency_unconverted'], currencyCode: null, currencyLabel: payload.dataScope.currencyLabel, currencies: payload.dataScope.currencies, currencyAggregationStatus: 'multi_currency_unconverted', currencyAmounts: payload.dataScope.currencyAmounts } : item)
    await route.fulfill({ response, json: payload })
  })
  await page.goto('/app/reports/overview')
  await expect(page.getByTestId('bi-dashboard')).toHaveAttribute('data-view', 'overview')
  await expect(page.getByTestId('reports-multi-currency-status')).toContainText('Multiple currencies, not converted')
  await expect(page.getByTestId('reports-multi-currency-status')).toContainText('Select a currency')
  await expect(page.getByText('Business overview module failed')).toHaveCount(0)
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})

const reportContext = (extra: Record<string, unknown>) => ({ purchaseOrders: [], salesOrders: [], suppliers: [], items: [], inventoryItems: [], supplierInvoices: [], receipts: [], dataLimitations: [], ...extra })

test('a money metric is shown in its own currency, not the dashboard currency', async ({ page }) => {
  await authenticate(page)
  const errors = collectRuntimeErrors(page)
  const context = reportContext({
    salesOrders: [{ id: 'SO-USD', orderedQty: 1, fulfilledQty: 0, currency: 'USD', totalAmount: 90, status: 'confirmed', createdAt: '2026-09-02' }],
    purchaseOrders: [{ id: 'PO-EUR', status: 'issued', totalAmount: 300, currency: 'EUR', createdAt: '2026-09-02', lines: [] }],
  })
  await page.route('**/api/reports/query', route => route.fulfill({ json: buildRuntimeGovernedReport(context, { ...route.request().postDataJSON(), measures: ['sales_order_count', 'purchase_order_amount'] }) }))
  await page.goto('/app/reports/sales')
  await expect(page.getByText('Currency: US dollar (USD)')).toBeVisible()
  await expect(page.getByRole('button', { name: /Committed PO amount/ })).toContainText(/€300/)
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})

test('a missing currency code blocks the total instead of borrowing a currency', async ({ page }) => {
  await authenticate(page)
  const errors = collectRuntimeErrors(page)
  const context = reportContext({ purchaseOrders: [
    { id: 'PO-USD', status: 'issued', totalAmount: 100, currency: 'USD', createdAt: '2026-09-02', lines: [] },
    { id: 'PO-BLANK', status: 'issued', totalAmount: 50, currency: '', createdAt: '2026-09-02', lines: [] },
  ] })
  await page.route('**/api/reports/query', route => route.fulfill({ json: buildRuntimeGovernedReport(context, route.request().postDataJSON()) }))
  await page.goto('/app/reports/overview')
  const amount = page.getByRole('button', { name: /Committed PO amount/ })
  await expect(amount).toContainText('Missing or invalid currency')
  await expect(amount).not.toContainText(/\$|¥|150/)
  await expect(page.getByTestId('reports-data-scope-limitations')).toContainText('missing or invalid currency code')
  expect(errors.join('\n')).not.toContain('Invalid currency code')
})
