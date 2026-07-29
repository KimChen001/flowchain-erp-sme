import { expect, test, type Locator, type Page } from "@playwright/test";

const demoUser = {
  id: "browser-uat-user",
  company: "新辰智能制造",
  name: "张磊",
  email: "zhanglei@example.com",
  role: "供应链经理",
};

function installPageDiagnostics(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });
  return async (label: string) => {
    const title = await page.title().catch((error) => `title unavailable: ${String(error)}`);
    const body = await page.locator("body").innerText({ timeout: 1000 }).catch((error) => `body unavailable: ${String(error)}`);
    return [
      `${label} did not reach app-main`,
      `url=${page.url()}`,
      `title=${title}`,
      `body=${body.slice(0, 1000)}`,
      `consoleErrors=${consoleErrors.slice(-10).join("\n") || "none"}`,
      `pageErrors=${pageErrors.slice(-10).join("\n") || "none"}`,
    ].join("\n");
  };
}

async function openLoggedInApp(page: Page) {
  const describeFailure = installPageDiagnostics(page);
  await page.addInitScript((user) => {
    window.localStorage.setItem("flowchain:auth-token", "browser-uat-token");
    window.localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, demoUser);
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  try {
    await expect(page.getByTestId("app-main")).toBeVisible({ timeout: 15000 });
  } catch (error) {
    throw new Error(`${await describeFailure("AI Copilot app startup")}\n\n${error instanceof Error ? error.message : String(error)}`);
  }
  await expect(page.getByText("每日工作台").first()).toBeVisible();
}

async function openAssistant(page: Page) {
  await page.getByTestId("ai-assistant-toggle").click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
}

async function askAssistant(page: Page, prompt: string) {
  await page.getByTestId("ai-assistant-input").fill(prompt);
  await page.getByTestId("ai-assistant-send").click();
  await expect(page.getByTestId("ai-message-user").filter({ hasText: prompt })).toBeVisible();
  const assistant = page.getByTestId("ai-message-assistant").last();
  await expect(assistant).toBeVisible();
  await expect(assistant).not.toContainText("正在回复");
  return assistant;
}

async function expectCleanAssistantOutput(assistant: Locator) {
  await expect(assistant).not.toContainText(/provider fallback|tool_result|debug|documentType|entityType|response_card/i);
  await expect(assistant).not.toContainText(/\{\s*"/);
  await expect(assistant).not.toContainText(/"\s*:/);
}

async function expectRuntimeHotfixGate(assistant: Locator) {
  await expectCleanAssistantOutput(assistant);
  await expect(assistant).not.toContainText(/AI Provider|外部 AI Provider|外部模型|未启用外部|provider disabled|provider_disabled|deterministic|fallback|api key/i);
  await expect(assistant).not.toContainText(/打开采购单据并确认责任人与截止日期|复核库存覆盖与再订货点|确认待回复供应商、最佳报价和授标依据/);
  await expect(assistant).not.toContainText(/逾期\s*PO\s*[=:：]?\s*0/);
}

async function askTodayPriority(page: Page) {
  await openAssistant(page);
  const assistant = await askAssistant(page, "今天最需要处理什么？");
  await expect(assistant).toContainText("PO-2026-1282");
  await expect(assistant).toContainText("SKU-00412");
  await expect(assistant).toContainText("RFQ-26-0046");
  await expect(assistant).toContainText("依据");
  await expect(assistant).toContainText("建议操作");
  return assistant;
}

async function restoreAssistant(page: Page) {
  await page.getByTestId("ai-assistant-toggle").click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
}

async function clickEvidence(page: Page, businessId: string) {
  const evidence = page.getByTestId("ai-evidence-link").filter({ hasText: businessId }).first();
  await expect(evidence).toBeVisible();
  await evidence.click();
}

async function openDraftPreview(page: Page, draftType: string) {
  const action = page.locator(`[data-testid="ai-action-draft-preview"][data-draft-type="${draftType}"]`).last();
  await expect(action).toBeVisible();
  await action.click();
  const shell = page.getByTestId("action-draft-review-shell");
  await expect(shell).toBeVisible();
  await expect(shell).toContainText("草稿预览");
  await expect(shell).toContainText("不提交");
  await expect(shell).toContainText("不外发");
  await expect(shell).toContainText("人工");
  return shell;
}

async function expectTextDraftBoundary(page: Page) {
  const shell = page.getByTestId("action-draft-review-shell");
  await expect(shell).toContainText("文本草稿编辑器");
  await expect(shell).toContainText("不外发");
  await expect(shell).toContainText("不写库存");
  await expect(shell).toContainText("不处理资金");
  await expect(page.getByRole("button", { name: "记录复核结果" })).toHaveCount(0);
}

async function closeDraftPreview(page: Page) {
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("action-draft-review-shell")).toBeHidden();
  if (await page.getByTestId("ai-assistant-toggle").isVisible().catch(() => false)) {
    await restoreAssistant(page);
  }
}

test.describe("AI Copilot browser controlled review", () => {
  test("R134 empty AI panel shows prompt chips and 今日重点 returns overview", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);

    const chips = page.getByTestId("ai-empty-prompt-chip");
    await expect(chips.filter({ hasText: "今日重点" })).toBeVisible();
    await expect(chips.filter({ hasText: "库存风险" })).toBeVisible();
    await expect(chips.filter({ hasText: "供应商跟进" })).toBeVisible();
    await expect(page.getByTestId("ai-context-chip")).toContainText("每日工作台");

    await chips.filter({ hasText: "今日重点" }).click();
    const assistant = page.getByTestId("ai-message-assistant").last();
    await expect(assistant).toContainText("PO-2026-1282");
    await expect(assistant).toContainText("SKU-00412");
    await expect(assistant).not.toContainText(/provider fallback|tool_result|debug|documentType|entityType/i);
  });

  test("R135 placeholder changes after focusing a PO context", async ({ page }) => {
    await openLoggedInApp(page);
    await askTodayPriority(page);

    await clickEvidence(page, "PO-2026-1282");
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();
    await restoreAssistant(page);

    await expect(page.getByTestId("ai-context-chip")).toContainText("PO-2026-1282");
    await expect(page.getByTestId("ai-assistant-input")).toHaveAttribute("placeholder", /这个 PO 为什么优先|未到货风险/);
  });

  test("R136 follow-up chip resolves to prior PO through session grounding", async ({ page }) => {
    await openLoggedInApp(page);
    await askTodayPriority(page);

    const chip = page.getByTestId("ai-runtime-follow-up-chip").filter({ hasText: "展开相关对象" }).first();
    await expect(chip).toBeVisible();
    await chip.click();

    const assistant = page.getByTestId("ai-message-assistant").last();
    await expect(assistant).toContainText("PO-2026-1282");
    await expect(assistant).toContainText(/SKU-00412|RFQ-26-0046|GRN-202605-0419|相关对象/);
    await expect(assistant).not.toContainText(/provider fallback|tool_result|debug|documentType|entityType/i);
  });

  test("R122 answers Today priority with product-readable evidence and actions", async ({ page }) => {
    await openLoggedInApp(page);
    const assistant = await askTodayPriority(page);
    await expectRuntimeHotfixGate(assistant);
    await expect(assistant).toContainText(/打开 PO-2026-1282|打开 PO/);
    await expect(assistant).toContainText(/查看 SKU-00412|查看 SKU/);
    await expect(assistant).toContainText(/打开 RFQ-26-0046|打开 RFQ/);

    for (const forbidden of [
      "action-FOLLOWUP",
      "inventory_item",
      "documentType",
      "entityType",
      "tool_result",
      "response_card",
    ]) {
      await expect(assistant).not.toContainText(forbidden);
    }
    await expect(assistant).not.toContainText(/\{\s*"/);
    await expect(assistant).not.toContainText(/"\s*:/);
  });

  test("R139 mirrors runtime hotfix gates for Today priority in browser", async ({ page }) => {
    await openLoggedInApp(page);
    const assistant = await askTodayPriority(page);

    await expectRuntimeHotfixGate(assistant);
    await expect(assistant).toContainText("PO-2026-1282");
    await expect(assistant).toContainText("SKU-00412");
    await expect(assistant).toContainText("RFQ-26-0046");
    await expect(assistant).toContainText(/打开 PO-2026-1282|打开 PO/);
    await expect(assistant).toContainText(/查看 SKU-00412|查看 SKU/);
    await expect(assistant).toContainText(/打开 RFQ-26-0046|打开 RFQ/);
  });

  test("R139 supplier overview prompts stay overview-routed in browser", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);

    for (const prompt of ["有什么供应商我需要注意的么？", "供应商这边，你有什么推荐？"]) {
      const assistant = await askAssistant(page, prompt);
      await expectRuntimeHotfixGate(assistant);
      await expect(assistant).toContainText(/供应商|跟进|风险/);
      await expect(assistant).not.toContainText(/供应商主数据中没有匹配记录|请提供供应商名称|请提供供应商 ID|输入供应商/);
    }
  });

  test("R139 data limitation prompts stay deterministic in browser", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);

    for (const prompt of ["什么数据会比较有限，我需要重点关注？", "AI 现在有哪些地方不确定？"]) {
      const assistant = await askAssistant(page, prompt);
      await expectRuntimeHotfixGate(assistant);
      await expect(assistant).not.toContainText(/供应商主数据中没有匹配记录|请提供供应商名称|请提供供应商 ID/);
      await expect(assistant).toContainText(/RFQ|回复|报价/);
      await expect(assistant).toContainText(/ETA|交期|未到货/);
      await expect(assistant).toContainText(/GRN|质检|收货/);
      await expect(assistant).toContainText(/库存|预测|需求/);
      await expect(assistant).toContainText(/发票|三单/);
    }
  });

  test("R139 broad attention prompt returns object-specific overview in browser", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);

    const assistant = await askAssistant(page, "有什么需要我注意的？");
    await expectRuntimeHotfixGate(assistant);
    await expect(assistant).toContainText("PO-2026-1282");
    await expect(assistant).toContainText("SKU-00412");
    await expect(assistant).toContainText("RFQ-26-0046");
    await expect(assistant).toContainText(/打开 PO-2026-1282|打开 PO/);
    await expect(assistant).toContainText(/查看 SKU-00412|查看 SKU/);
    await expect(assistant).toContainText(/打开 RFQ-26-0046|打开 RFQ/);
  });

  test("R146 compound query answers all business parts in browser", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);

    const assistant = await askAssistant(page, "今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？");
    await expectRuntimeHotfixGate(assistant);
    await expect(assistant).toContainText(/今日待办|今日重点/);
    await expect(assistant).toContainText(/未收货订单|未完全收货|未到货|部分到货/);
    await expect(assistant).toContainText(/供应商风险|供应商跟进/);
    await expect(assistant).toContainText(/PO-2026-1282|PO-2026-1284|PO-2026-1285/);
    await expect(assistant).toContainText(/已收|订购|剩余/);
    await expect(assistant).toContainText(/GRN|收货单/);
    await expect(assistant).toContainText(/供应商|深圳新元电气|广州化工耗材|江苏铝合金集团/);
    await expect(assistant).toContainText("建议操作");
    await expect(assistant).not.toContainText(/请提供供应商名称|请提供供应商 ID|供应商主数据中没有匹配记录/);

    const evidence = page.getByTestId("ai-evidence-link").filter({ hasText: /PO-2026-|GRN-202605-/ }).first();
    await expect(evidence).toBeVisible();
  });

  test("R123 minimize and restore preserve the AI answer", async ({ page }) => {
    await openLoggedInApp(page);
    await askTodayPriority(page);

    await page.getByTestId("app-main").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();
    await expect(page.getByTestId("ai-assistant-toggle")).toBeVisible();

    await page.getByTestId("ai-assistant-toggle").click();
    await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
    await expect(page.getByTestId("ai-assistant-messages")).toContainText("PO-2026-1282");
    await expect(page.getByTestId("ai-assistant-messages")).toContainText("SKU-00412");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();

    await page.getByTestId("ai-assistant-toggle").click();
    await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
    await expect(page.getByTestId("ai-assistant-messages")).toContainText("PO-2026-1282");
    await expect(page.getByTestId("ai-assistant-messages")).toContainText("建议操作");
  });

  test("R124 evidence navigation minimizes AI and focuses PO SKU and RFQ objects", async ({ page }) => {
    await openLoggedInApp(page);
    await askTodayPriority(page);

    await clickEvidence(page, "PO-2026-1282");
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();
    await expect(page.getByTestId("focus-banner")).toContainText("PO-2026-1282");

    await restoreAssistant(page);
    await expect(page.getByTestId("ai-assistant-messages")).toContainText("PO-2026-1282");

    await clickEvidence(page, "SKU-00412");
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();
    await expect(page.getByTestId("focus-banner")).toContainText("SKU-00412");

    await restoreAssistant(page);
    await clickEvidence(page, "RFQ-26-0046");
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();
    await expect(page.getByTestId("focus-banner")).toContainText("RFQ-26-0046");
  });

  test("R125 follow-up question uses session grounding for the prior PO", async ({ page }) => {
    await openLoggedInApp(page);
    await askTodayPriority(page);

    const assistant = await askAssistant(page, "这个 PO 为什么优先？");
    await expect(assistant).toContainText("PO-2026-1282");
    await expect(assistant).toContainText("部分到货");
    await expect(assistant).toContainText("5月25日");
    await expect(assistant).toContainText(/未到货明细|供应商剩余交期/);
    await expect(assistant).not.toContainText(/provider fallback|tool_result|debug|documentType|entityType/i);
  });

  test("R126 ambiguous PO follow-up asks for clarification when multiple PO candidates are visible", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);
    await askAssistant(page, "哪些 PO 需要跟进？");

    const poEvidenceCount = await page.getByTestId("ai-evidence-link").filter({ hasText: /PO-2026-/ }).count();
    test.skip(poEvidenceCount < 2, "Current browser fixture did not expose multiple PO evidence candidates; domain grounding ambiguity remains covered.");

    const assistant = await askAssistant(page, "这个 PO 为什么优先？");
    await expect(assistant).toContainText(/需要确认|还是|请.*PO/);
    await expect(assistant).not.toContainText("PO-2026-1282 被列为优先事项");
  });

  test("R127 SKU replenishment opens the formal prefilled PR page", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);
    const assistant = await askAssistant(page, "为 SKU-00412 创建 PR 草稿");

    await expect(assistant).toContainText("SKU-00412");
    const action = assistant.getByTestId("ai-structured-draft-action");
    await expect(action).toContainText("创建正式 PR 草稿");
    await action.click();
    await expect(page).toHaveURL(/\/app\/procurement\/requests\?.*(itemId|sku)=SKU-00412/);
    await expect(page.getByTestId("action-draft-review-shell")).toBeHidden();
  });

  test("R128 PO and RFQ follow-up draft previews stay review-first", async ({ page }) => {
    await openLoggedInApp(page);
    await openAssistant(page);

    const poAnswer = await askAssistant(page, "解释 PO-2026-1282 为什么优先");
    await expect(poAnswer.getByTestId("ai-action-draft-preview")).toHaveCount(0);
    const poAction = poAnswer.locator('[data-testid="ai-business-navigation-action"][data-business-id="PO-2026-1282"]');
    await expect(poAction).toBeVisible();
    await poAction.click();
    await expect(page.getByTestId("po-fulfillment-focus")).toHaveAttribute("data-focus-highlight", "true");
    await expect(page.getByTestId("action-draft-review-shell")).toBeHidden();
    await restoreAssistant(page);

    await askAssistant(page, "为 RFQ-26-0046 生成供应商消息草稿");
    const shell = await openDraftPreview(page, "supplier_followup_draft");
    await expect(shell).toContainText("RFQ-26-0046");
    await expect(shell).toContainText(/不形成正式业务处理|不外发/);
    await expectTextDraftBoundary(page);
  });

  test("R129 full AI Copilot workspace scenario stays evidence-backed and review-first", async ({ page }) => {
    await openLoggedInApp(page);
    let assistant = await askTodayPriority(page);
    await expectCleanAssistantOutput(assistant);

    await clickEvidence(page, "PO-2026-1282");
    await expect(page.getByTestId("ai-assistant-panel")).toBeHidden();
    await expect(page.getByTestId("focus-banner")).toContainText("PO-2026-1282");

    await restoreAssistant(page);
    assistant = await askAssistant(page, "这个 PO 和 SKU-00412 有什么关系？");
    for (const expected of ["PO-2026-1282", "SKU-00412"]) {
      await expect(assistant).toContainText(expected);
    }
    await expect(assistant).toContainText(/GRN-202605-0418|GRN-202605-0419|收货单/);
    await expect(assistant).toContainText(/PR-2026-2401|当前采购链路|采购申请/);
    await expectCleanAssistantOutput(assistant);

    assistant = await askAssistant(page, "逾期 PO 一般怎么处理？");
    await expect(assistant).toContainText(/SOP-PO-OVERDUE|PO-OVERDUE/);
    await expect(assistant).toContainText("内部处理建议");
    await expect(assistant).toContainText("逾期 PO 跟进");
    await expect(assistant).toContainText("不得自动");
    await expectCleanAssistantOutput(assistant);

    await askAssistant(page, "生成 PO-2026-1282 的内部备注草稿");
    const shell = await openDraftPreview(page, "po_followup_draft");
    await expect(shell).toContainText("PO-2026-1282");
    await expect(shell).toContainText("待复核草稿");
    await expectTextDraftBoundary(page);
    await expect(page.getByRole("button", { name: "保留待复核草稿" })).toBeVisible();
  });
});
