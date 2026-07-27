import { expect, test, type Locator, type Page } from "@playwright/test";

const user = {
  id: "browser-manager-cockpit-user",
  company: "新辰智能制造",
  name: "张磊",
  email: "zhanglei@example.com",
  role: "供应链经理",
};

const forbiddenTechnicalText =
  /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|system prompt|prompt package|OpenAI|DeepSeek|Doubao|豆包/i;

const forbiddenExecutionText =
  /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite/i;

async function openLoggedInApp(page: Page) {
  await page.addInitScript((profile) => {
    window.localStorage.setItem("flowchain:auth-token", "browser-manager-cockpit-token");
    window.localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
  }, user);
  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
}

async function openAssistant(page: Page) {
  await page.getByTestId("ai-assistant-toggle").click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(page: Page, question: string) {
  const panel = page.getByTestId("ai-assistant-panel");
  await panel.getByTestId("ai-assistant-input").fill(question);
  await panel.getByTestId("ai-assistant-send").click();
  await expect(panel.getByTestId("ai-response-v2").last()).toBeVisible({ timeout: 25000 });
  return panel.getByTestId("ai-message-assistant").last();
}

async function expectCleanVisibleText(target: Locator) {
  await expect(target).not.toContainText(forbiddenTechnicalText);
  await expect(target).not.toContainText(forbiddenExecutionText);
}

test("manager cockpit keeps dense surfaces and preserves drilldown recovery paths", async ({ page }) => {
  await openLoggedInApp(page);
  const scope = page.getByTestId("module-export-scope");

  await expect(page.getByRole("button", { name: "今日行动", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI 建议", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "风险异常", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "风险与异常", exact: true })).toHaveCount(0);

  for (const label of ["今日行动", "PO 看板", "库存管理", "供应商状态", "财务协同"]) {
    await expect(scope).toContainText(label);
  }

  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "AI 建议", exact: true }).click();
  const workbench = page.getByTestId("ai-suggestions-workbench");
  await expect(workbench).toBeVisible({ timeout: 15000 });
  await expect(workbench).toContainText("AI 建议列表");
  await expect(workbench).toContainText("建议详情");
  await expect(workbench).toContainText("问 AI 继续追问");
  await expectCleanVisibleText(workbench);

  await workbench.getByTestId("ai-suggestion-row").filter({ hasText: /PO 建议|库存建议/ }).first().click();
  await workbench.getByTestId("ai-suggestion-nav-link").first().click();
  await expect(scope).toContainText(/返回 AI 建议|返回上一层|返回 AI 助手|返回 今日行动/);

  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "AI 建议", exact: true }).click();
  await page.getByRole("button", { name: "问 AI 继续追问" }).first().click();
  let panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();

  let message = await ask(page, "今天有什么需要我处理？");
  await expect(message).toContainText(/结论|关键证据|建议动作/);
  message = await ask(page, "那这个 PO 为什么优先？");
  await expect(message).toContainText(/PO|采购订单|上下文/);

  panel = page.getByTestId("ai-assistant-panel");
  const runtimeChips = panel.getByTestId("ai-runtime-follow-up-chip");
  const legacyChips = panel.getByTestId("ai-follow-up-chip");
  expect(await runtimeChips.count()).toBeLessThanOrEqual(4);
  expect(await legacyChips.count()).toBe(0);
  const chipLabels = await runtimeChips.allTextContents();
  expect(new Set(chipLabels).size).toBe(chipLabels.length);

  message = await ask(page, "生成这个对象的内部备注草稿。");
  await expect(message.getByTestId("ai-action-draft-preview").last()).toBeVisible({ timeout: 10000 });
  await message.getByTestId("ai-action-draft-preview").last().click();
  const shell = page.getByTestId("action-draft-review-shell");
  await expect(shell).toBeVisible({ timeout: 15000 });
  await expect(shell).toContainText("草稿预览");
  await expect(shell).toContainText("人工复核");
  await expect(shell).toContainText("不提交");
  await expect(shell).toContainText("不外发");
  await expect(shell).toContainText("保留待复核草稿");
  await expect(page.getByRole("button", { name: "记录复核结果" })).toHaveCount(0);
  await expectCleanVisibleText(shell);
});
