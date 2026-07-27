import { expect, test, type Locator, type Page } from "@playwright/test";

const user = {
  id: "browser-core-chain-user",
  company: "新辰智能制造",
  name: "张磊",
  email: "zhanglei@example.com",
  role: "供应链经理",
};

async function openLoggedInApp(page: Page) {
  await page.addInitScript((profile) => {
    window.localStorage.setItem("flowchain:auth-token", "browser-core-chain-token");
    window.localStorage.setItem("flowchain:current-user", JSON.stringify(profile));
  }, user);
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
}

async function openAssistant(page: Page) {
  const toggle = page.getByTestId("ai-assistant-toggle");
  if (await page.getByTestId("ai-assistant-panel").count() === 0) await toggle.click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
}

async function ask(page: Page, question: string): Promise<Locator> {
  const panel = page.getByTestId("ai-assistant-panel");
  const before = await panel.getByTestId("ai-response-v2").count();
  await panel.getByTestId("ai-assistant-input").fill(question);
  await panel.getByTestId("ai-assistant-send").click();
  await expect(panel.getByTestId("ai-response-v2")).toHaveCount(before + 1, { timeout: 25000 });
  const message = panel.getByTestId("ai-message-assistant").last();
  await expect(message).toBeVisible();
  return message;
}

async function expectResponseSections(message: Locator) {
  for (const label of ["结论", "关键证据", "业务影响", "建议动作", "可点击跳转", "数据限制", "人工复核"]) {
    await expect(message).toContainText(label);
  }
}

test("core business chain closes sales inventory procurement receiving invoice finance and review draft flow", async ({ page }) => {
  await openLoggedInApp(page);

  const chainEntry = page.getByTestId("core-business-chain-entry");
  await expect(chainEntry).toBeVisible();
  await expect(chainEntry).toContainText("核心业务链");
  await expect(chainEntry).toContainText("销售需求");
  await expect(chainEntry).toContainText("SKU 库存风险");
  await expect(chainEntry).toContainText("PO");
  await expect(chainEntry).toContainText("财务协同");

  await chainEntry.getByRole("button", { name: "查看主链证据" }).click();
  const scope = page.getByTestId("module-export-scope");
  await expect(scope).toContainText("订单证据链");
  await expect(scope).toContainText("SO-2026-0412-A");
  await expect(scope).toContainText("客户订单 → SKU → 库存可用量 → 采购订单 → 供应商 → 收货单");

  await openAssistant(page);
  let message = await ask(page, "这个销售需求影响哪些 SKU？");
  await expectResponseSections(message);
  await expect(message).toContainText(/SO-2026|SKU-00412|销售需求|库存风险/);

  message = await ask(page, "这个 SKU 为什么有库存风险，它和哪些 PR / PO 有关系？");
  await expect(message).toContainText(/SKU-00412|库存风险|PR|PO/);

  message = await ask(page, "这个 PO 对应哪个供应商、收货和发票？");
  await expect(message).toContainText(/PO-2026-1282|供应商|收货|发票/);

  message = await ask(page, "这条链路哪里证据不足？");
  await expect(message).toContainText(/证据不足|发票差异证据待补充|数据限制/);

  message = await ask(page, "生成这条链路的内部备注草稿。");
  await expect(message).toContainText(/备注草稿|草稿预览|人工复核/);
  await expect(message.getByTestId("ai-action-draft-preview")).toBeVisible();
  await expect(message).not.toContainText(/JSON|payload|entityType|documentType|mock|fake|demo|UAT/i);
});
