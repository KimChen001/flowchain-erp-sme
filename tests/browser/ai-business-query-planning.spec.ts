import { expect, test, type Locator, type Page } from '@playwright/test'

async function openApp(page: Page, language?: "en-US" | "zh-CN") {
  const login = await page.request.post('/api/auth/login', { data: { email: 'manager@example.com', name: 'Ignored', company: 'Ignored' } })
  expect(login.ok(), await login.text()).toBeTruthy()
  const session = await login.json()
  if (language) {
    const headers = { Authorization: `Bearer ${session.token}` }
    const profile = await (await page.request.get('/api/me/profile', { headers })).json()
    const update = await page.request.patch('/api/me/profile', { headers, data: { ...profile, languagePreference: language } })
    expect(update.ok(), await update.text()).toBeTruthy()
  }
  await page.addInitScript(({ token, user }) => {
    window.localStorage.setItem('flowchain:auth-token', token)
    window.localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, session)
  await page.goto('/')
  await expect(page.getByTestId('app-main')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('ai-assistant-toggle').click()
  await expect(page.getByTestId('ai-assistant-panel')).toBeVisible()
}

async function ask(page: Page, prompt: string): Promise<Locator> {
  await page.getByTestId('ai-assistant-input').fill(prompt)
  await page.getByTestId('ai-assistant-send').click()
  const assistant = page.getByTestId('ai-message-assistant').last()
  await expect(assistant).toBeVisible()
  await expect(assistant).not.toContainText('正在回复', { timeout: 15_000 })
  return assistant
}

async function expectNoInternalLeakage(assistant: Locator) {
  await expect(assistant).not.toContainText(/business-query-plan-v1|requestedActions|executedTools|toolName|getSupplierPaymentSummary|SELECT\s|Prisma|chain.?of.?thought/i)
  await expect(assistant).not.toContainText(/\{\s*"/)
}

test.describe('Phase 5.4A business query planning', () => {
  test('global supplier payment query renders authorized database facts', async ({ page }) => {
    await openApp(page)
    const assistant = await ask(page, '有哪些供应商需要付款？')
    await expect(assistant.getByTestId('ai-business-query-presentation')).toBeVisible()
    await expect(assistant.getByTestId('ai-business-query-scope')).toHaveText('All suppliers')
    await expect(assistant).toContainText('Payments due')
    const payment = assistant.getByTestId('ai-business-query-section').filter({ hasText: 'Payments due' })
    await expect(payment).toHaveAttribute('data-state', /confirmed|confirmed_zero|incomplete/)
    await expectNoInternalLeakage(assistant)
  })

  test('multi-goal question renders stable payment, invoice, and overdue PO sections', async ({ page }) => {
    await openApp(page)
    const assistant = await ask(page, '帮我同时看看供应商付款、延期 PO 和发票差异。')
    await expect(assistant.getByTestId('ai-business-query-scope')).toHaveText('All suppliers')
    for (const label of ['Payments due', 'Payment readiness', 'Invoice exceptions', 'Overdue POs']) await expect(assistant).toContainText(label)
    await expect(assistant.getByTestId('ai-business-query-section')).toHaveCount(4)
    await expectNoInternalLeakage(assistant)
  })

  test('unknown supplier produces clarification and executes no result section', async ({ page }) => {
    await openApp(page)
    const assistant = await ask(page, '为什么 Supplier Missing 暂时不能付款？')
    await expect(assistant.getByTestId('ai-business-query-clarification')).toContainText(/Which suppliers should I check/)
    await expect(assistant.getByTestId('ai-business-query-section')).toHaveCount(0)
    await expectNoInternalLeakage(assistant)
  })

  for (const viewport of [{ width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    test(`${viewport.width}px query cards have no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openApp(page)
      const assistant = await ask(page, '帮我同时看看供应商付款、延期 PO 和发票差异。')
      await expect(assistant.getByTestId('ai-business-query-presentation')).toBeVisible()
      const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }))
      expect(overflow.document).toBeLessThanOrEqual(1)
      expect(overflow.body).toBeLessThanOrEqual(1)
    })
  }

  test('Chinese preference changes query results while retaining English as workspace default', async ({ page }) => {
    await openApp(page, 'zh-CN')
    const assistant = await ask(page, '有哪些供应商需要付款？')
    await expect(assistant.getByTestId('ai-business-query-scope')).toHaveText('全部供应商')
    await expect(assistant).toContainText('需要付款')
    await expectNoInternalLeakage(assistant)
  })
})
