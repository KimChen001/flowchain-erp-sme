import { expect, test, type Locator, type Page } from "@playwright/test";

const user = {
  id: "browser-ai-runtime-contextual-draft-user",
  company: "新辰智能制造",
  name: "张磊",
  email: "zhanglei@example.com",
  role: "供应链经理",
};

const forbiddenTechnicalText =
  /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|webhook|Coupa|RBAC|production|deploy|go-live|system prompt|prompt package|OpenAI|DeepSeek|Doubao|豆包/i;

const forbiddenExecutionText =
  /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite/i;

async function openLoggedInApp(page: Page) {
  await page.addInitScript((profile) => {
    window.localStorage.setItem("flowchain:auth-token", "browser-ai-runtime-contextual-draft-token");
    window.localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
  }, user);
  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
}

async function openAssistant(page: Page) {
  await page.getByTestId("ai-assistant-toggle").click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("AI 助手");
  return panel;
}

async function ask(page: Page, question: string) {
  const panel = page.getByTestId("ai-assistant-panel");
  await panel.getByTestId("ai-assistant-input").fill(question);
  await panel.getByTestId("ai-assistant-send").click();
  await expect(panel.getByTestId("ai-response-v2").last()).toBeVisible({ timeout: 25000 });
  return panel.getByTestId("ai-message-assistant").last();
}

async function expectResponseSections(message: Locator) {
  for (const label of ["结论", "关键证据", "业务影响", "建议动作", "可点击跳转", "数据限制", "人工复核"]) {
    await expect(message).toContainText(label);
  }
}

test("AI Assistant navigates information to the PO and opens editor only for an explicit note", async ({ page }) => {
  await openLoggedInApp(page);
  const panel = await openAssistant(page);

  let message = await ask(page, "今天有什么需要我处理？");
  await expectResponseSections(message);

  message = await ask(page, "那这个 PO 为什么优先？");
  await expectResponseSections(message);
  await expect(message).toContainText(/上下文|采购订单|PO/);

  message = await ask(page, "生成这个 PO 的内部备注草稿。");
  await expectResponseSections(message);
  await expect(message).toContainText("上下文");
  await expect(message).toContainText("草稿预览");
  await expect(message).toContainText("人工复核");
  await expect(message).toContainText(/不形成正式业务处理|不会外发/);
  await expect(message.getByTestId("ai-action-draft-preview").last()).toBeVisible({ timeout: 10000 });
  await expect(message).not.toContainText(forbiddenTechnicalText);

  await message.getByTestId("ai-action-draft-preview").last().click();
  const shell = page.getByTestId("action-draft-review-shell");
  await expect(shell).toBeVisible({ timeout: 15000 });
  await expect(shell).toContainText(/采购订单复核草稿|PO 跟进备注草稿|草稿预览/);
  await expect(shell).toContainText(/预览|人工复核|不形成正式业务处理|不外发/);
  await expect(shell).not.toContainText(forbiddenTechnicalText);
  await expect(shell).not.toContainText(forbiddenExecutionText);

  await page.getByRole("button", { name: "关闭" }).click();
  await expect(shell).toBeHidden({ timeout: 10000 });
  await openAssistant(page);

  message = await ask(page, "生成草稿并直接发给供应商。");
  await expect(message.getByTestId("ai-action-draft-preview")).toHaveCount(0);
  await expect(message).not.toContainText(forbiddenExecutionText);
  await expect(message).not.toContainText(forbiddenTechnicalText);

  await expect(panel).not.toContainText(forbiddenTechnicalText);
});
