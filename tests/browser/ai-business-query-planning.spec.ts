import { expect, test, type Locator, type Page } from '@playwright/test'

const demoUser = {
  id: 'ai-business-query-browser-user',
  company: '新辰智能制造',
  name: 'AI Query Reviewer',
  email: 'ai-query-reviewer@example.invalid',
  role: '供应链经理',
}

async function openApp(page: Page) {
  await page.addInitScript((user) => {
    window.localStorage.setItem('flowchain:auth-token', 'ai-business-query-browser-token')
    window.localStorage.setItem('flowchain:current-user', JSON.stringify(user))
  }, demoUser)
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
  test('global supplier payment query renders scope and unavailable facts without a false zero', async ({ page }) => {
    await openApp(page)
    const assistant = await ask(page, '有哪些供应商需要付款？')
    await expect(assistant.getByTestId('ai-business-query-presentation')).toBeVisible()
    await expect(assistant.getByTestId('ai-business-query-scope')).toHaveText('全部供应商')
    await expect(assistant).toContainText('需要付款')
    const payment = assistant.getByTestId('ai-business-query-section').filter({ hasText: '需要付款' })
    await expect(payment).toHaveAttribute('data-state', 'unavailable')
    await expect(payment).toContainText('数据不可用')
    await expect(payment).not.toContainText(/到期\s*0|可付款\s*0/)
    await expectNoInternalLeakage(assistant)
  })

  test('multi-goal question renders stable payment, invoice, and overdue PO sections', async ({ page }) => {
    await openApp(page)
    const assistant = await ask(page, '帮我同时看看供应商付款、延期 PO 和发票差异。')
    await expect(assistant.getByTestId('ai-business-query-scope')).toHaveText('全部供应商')
    for (const label of ['需要付款', '付款准备度', '发票差异', '延期 PO']) await expect(assistant).toContainText(label)
    await expect(assistant.getByTestId('ai-business-query-section')).toHaveCount(4)
    await expectNoInternalLeakage(assistant)
  })

  test('unknown supplier produces clarification and executes no result section', async ({ page }) => {
    await openApp(page)
    const assistant = await ask(page, '为什么 Supplier Missing 暂时不能付款？')
    await expect(assistant.getByTestId('ai-business-query-clarification')).toContainText(/未找到 Supplier Missing|请确认供应商/)
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
})
