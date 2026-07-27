import { expect, test, type Locator, type Page } from "@playwright/test";

const user = {
  id: "browser-final-product-closure-user",
  company: "新辰智能制造",
  name: "张磊",
  email: "zhanglei@example.com",
  role: "供应链经理",
};

const unavailableText = /AI 助手暂不可用|当前未能读取工作区证据|请稍后重试/i;
const forbiddenProductPositioningText = /demo|UAT|sample|mock|fake|演示数据|样例数据|示例数据|测试数据|sample data|demo data/i;
const forbiddenTechnicalText =
  /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|response_card|entityType|documentType|raw enum|payload|webhook|system prompt|prompt package|OpenAI|DeepSeek|Doubao|豆包/i;
const forbiddenExecutionText =
  /自动批准|自动下单|正式创建 PO|正式创建 PR|下发 PO|发送 PO|发布 RFQ|邀请供应商|发送邮件|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|自动付款|真实付款|执行付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite|保存配置|保存权限|保存边界|保存历史|保存准备度|修改权限|修改历史|修改准备度|删除历史|立即生效|自动应用|分配角色|创建用户|删除用户|禁用用户|创建租户|切换租户|合并租户|迁移数据|同步数据|跨租户查询|写入配置|写入日志|推送日志|导出审计报告|生成正式审计报告|发送审计报告|启用试点|开启试点|上线|部署|生成正式报告|导出正式报告|发送报告/i;

async function openLoggedInApp(page: Page) {
  await page.addInitScript((profile) => {
    window.localStorage.setItem("flowchain:auth-token", "browser-final-product-closure-token");
    window.localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
  }, user);
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
}

async function expectCleanVisibleText(target: Locator) {
  await expect(target).not.toContainText(forbiddenProductPositioningText);
  await expect(target).not.toContainText(forbiddenTechnicalText);
  await expect(target).not.toContainText(forbiddenExecutionText);
}

async function openAssistant(page: Page) {
  const toggle = page.getByTestId("ai-assistant-toggle");
  if ((await page.getByTestId("ai-assistant-panel").count()) === 0) await toggle.click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel).toContainText("当前工作区数据");
  return panel;
}

async function ask(page: Page, question: string): Promise<Locator> {
  const panel = page.getByTestId("ai-assistant-panel");
  const before = await panel.getByTestId("ai-response-v2").count();
  await panel.getByTestId("ai-assistant-input").fill(question);
  await panel.getByTestId("ai-assistant-send").click();
  await expect(panel.getByTestId("ai-response-v2")).toHaveCount(before + 1, { timeout: 25000 });
  const message = panel.getByTestId("ai-message-assistant").last();
  await expect(message).toBeVisible({ timeout: 10000 });
  return message;
}

async function expectBusinessAnswer(message: Locator, businessText: RegExp) {
  await expect(message).toContainText("结论");
  await expect(message).toContainText(/关键证据|依据/);
  await expect(message).toContainText(/建议动作|建议操作/);
  await expect(message).toContainText("数据限制");
  await expect(message).toContainText(/人工复核|草稿预览|不提交|不外发|不写库存/);
  await expect(message).toContainText(businessText);
  await expect(message).not.toContainText(unavailableText);
  await expectCleanVisibleText(message);
}

async function openDataAccess(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /数据接入与质量/ }).first().click();
  const root = page.getByTestId("data-access-business-page");
  await expect(root).toBeVisible({ timeout: 15000 });
  return root;
}

async function openRolePermissions(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "角色权限可见性", exact: true }).click();
  const root = page.getByTestId("user-role-permission-visibility");
  await expect(root).toBeVisible({ timeout: 15000 });
  return root;
}

async function openAuditHistory(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "业务审计与历史", exact: true }).click();
  const root = page.getByTestId("audit-integration-history");
  await expect(root).toBeVisible({ timeout: 15000 });
  return root;
}

async function openWorkspaceBoundary(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "工作区边界", exact: true }).click();
  const root = page.getByTestId("workspace-boundary-visibility");
  await expect(root).toBeVisible({ timeout: 15000 });
  return root;
}

test("final product closure acceptance covers main surfaces AI chain governance and review drafts", async ({ page }) => {
  await openLoggedInApp(page);

  const homeScope = page.getByTestId("module-export-scope");
  await expect(page.getByRole("button", { name: "今日行动", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI 建议", exact: true })).toBeVisible();
  for (const label of ["PO 看板", "库存管理", "供应商状态", "财务协同"]) {
    await expect(homeScope).toContainText(label);
  }
  const chainEntry = page.getByTestId("core-business-chain-entry");
  await expect(chainEntry).toContainText("核心业务链");

  await openAssistant(page);
  let message = await ask(page, "今天最需要处理什么？");
  await expectBusinessAnswer(message, /今日行动|采购订单|库存|SKU|供应商|收货/);
  message = await ask(page, "今天有哪些收货异常？");
  await expectBusinessAnswer(message, /收货|GRN|采购订单|PO|库存|SKU|今日行动/);
  message = await ask(page, "哪些库存项目需要关注？");
  await expectBusinessAnswer(message, /库存|SKU|补货|可用量|可承诺量/);
  message = await ask(page, "生成这条链路的内部备注草稿。");
  await expectBusinessAnswer(message, /核心业务链|人工复核|草稿预览/);
  await expect(message.getByTestId("ai-action-draft-preview").last()).toBeVisible({ timeout: 10000 });
  await message.getByTestId("ai-action-draft-preview").last().click();
  const shell = page.getByTestId("action-draft-review-shell");
  await expect(shell).toBeVisible({ timeout: 15000 });
  await expect(shell).toContainText("草稿预览");
  await expect(shell).toContainText("人工复核");
  await expect(shell).toContainText("不提交");
  await expect(shell).toContainText("不外发");
  await expect(shell).toContainText("不写库存");
  await expect(shell).toContainText("不写财务凭证");
  await expectCleanVisibleText(shell);

  await page.goto("/");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("core-business-chain-entry").getByRole("button", { name: "查看主链证据" }).click();
  const chainScope = page.getByTestId("module-export-scope");
  await expect(chainScope).toContainText("订单证据链");
  await expect(chainScope).toContainText(/销售需求|客户订单/);
  await expect(chainScope).toContainText(/SKU/);
  await expect(chainScope).toContainText(/PO|采购订单/);
  await expect(chainScope).toContainText(/供应商/);
  await expect(chainScope).toContainText(/收货|GRN/);
  await expect(chainScope).toContainText(/返回 今日行动|返回上一层|返回主链证据|返回 AI 助手/);

  const dataAccess = await openDataAccess(page);
  await expect(dataAccess).toContainText(/当前工作区数据|数据限制|来源证据|人工复核/);
  await expect(dataAccess).not.toContainText(/自动覆盖数据|自动修复|自动提交导入/);
  await expectCleanVisibleText(dataAccess);

  const rolePermissions = await openRolePermissions(page);
  await expect(rolePermissions).toContainText(/角色权限|角色权限可见性|人工复核/);
  await expect(rolePermissions).not.toContainText(/创建用户|分配角色|保存权限|导出正式报告/);
  await expectCleanVisibleText(rolePermissions);

  const auditHistory = await openAuditHistory(page);
  await expect(auditHistory).toContainText(/业务历史|业务审计与历史|人工复核|当前工作区数据/);
  await expect(auditHistory).not.toContainText(/创建用户|分配角色|保存权限|导出正式报告|生成正式审计报告/);
  await expectCleanVisibleText(auditHistory);

  const boundary = await openWorkspaceBoundary(page);
  await expect(boundary).toContainText(/工作区边界|角色边界|人工复核|当前工作区数据/);
  await expect(boundary).not.toContainText(/创建用户|分配角色|保存权限|导出正式报告/);
  await expectCleanVisibleText(boundary);
});
