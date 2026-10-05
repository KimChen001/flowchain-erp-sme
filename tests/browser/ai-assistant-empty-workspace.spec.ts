import { expect, test, type Locator, type Page } from "@playwright/test";

// The assistant on a workspace with master data and no transactions, as a
// trial customer has after importing items and suppliers: it reports no
// orders rather than inventing any, and its purchase request drafts open the
// purchase request form prefilled, each value labelled with its source, and
// nothing saved.
test.skip(process.env.PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY !== "true", "Runs on the master-data-only seed (PLAYWRIGHT_PRODUCT_RECOVERY_EMPTY=true) in the product recovery runner.");

const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Assistant empty workspace", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  return session as { token: string };
}

async function askChip(panel: Locator, chip: string) {
  const answers = panel.getByTestId("ai-response-v2");
  const before = await answers.count();
  await panel.getByTestId("ai-empty-prompt-chip").filter({ hasText: chip }).click();
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  return answers.nth(before);
}

for (const [language, copy] of [
  ["en-US", {
    today: "What should I handle first today?", noOrders: "0 open purchase orders; none are overdue.", newConversation: "New conversation",
    draftChip: "Prepare an action draft", drafts: /drafts? ready for your review/, createDraft: "Create purchase request draft",
    quantity: /^Quantity$/, noteLabel: "Internal line notes 1", banner: "Prefilled from the assistant",
    quantitySource: "From the stock check", noteSource: "Reason from the assistant",
  }],
  ["zh-CN", {
    today: "今天先处理什么？", noOrders: "未结采购订单 0 张，没有逾期。", newConversation: "新对话",
    draftChip: "帮我准备一个处理草稿", drafts: /份草稿，等待你复核/, createDraft: "创建正式 PR 草稿",
    quantity: /^数量$/, noteLabel: "行级内部备注 1", banner: "已根据助手预填",
    quantitySource: "来自库存检查", noteSource: "来自助手的原因",
  }],
] as const) {
  test(`with no transactions the assistant invents no orders and opens prefilled purchase request drafts (${language})`, async ({ page }) => {
    const session = await signIn(page, language);
    const requests = async () => (await (await page.request.get("/api/procurement/requests", { headers: { Authorization: `Bearer ${session.token}` } })).json()) as unknown[];
    const before = (await requests()).length;
    await page.goto("/app/overview/risks");
    await page.getByTestId("ai-assistant-toggle").click();
    const panel = page.getByTestId("ai-assistant-panel");

    // Only the workspace's own items are cited; there is no order to cite.
    const today = await askChip(panel, copy.today);
    await expect(today).toContainText(copy.noOrders);
    await expect(today.locator('[data-action-kind="view_evidence"]').filter({ hasText: /PO-|GRN-|INV-|RFQ-/ })).toHaveCount(0);
    await panel.getByRole("button", { name: copy.newConversation }).click();

    // A shortage with nothing incoming is a purchase request to prepare, not a text note.
    const drafts = await askChip(panel, copy.draftChip);
    await expect(drafts.getByTestId("ai-focused-conclusion").locator("h3")).toHaveText(copy.drafts);
    await expect(drafts.getByTestId("ai-action-draft-preview")).toHaveCount(0);
    const create = drafts.getByTestId("ai-structured-draft-action").first();
    await expect(create).toHaveText(copy.createDraft);
    await create.click();

    // The form opens prefilled from the assistant and unsaved; the assistant steps aside.
    await expect(page).toHaveURL(/\/app\/procurement\/requests\?mode=create&itemId=/);
    await expect(panel).toHaveCount(0);
    const query = new URL(page.url()).searchParams;
    expect(query.get("origin")).toBe("ai_assistant");
    await expect(page.getByTestId("prefill-banner")).toContainText(copy.banner);
    await expect(page.getByLabel("SKU 1", { exact: true }).locator("option:checked")).toHaveText(new RegExp(`^${query.get("sku")} · `));
    const quantity = page.locator("label").filter({ hasText: copy.quantity }).locator("xpath=following-sibling::input[1]");
    await expect(quantity).toHaveValue(query.get("quantity") || "");
    await expect(page.getByTestId("prefill-source-quantity")).toHaveText(copy.quantitySource);
    // The line note is the assistant's reason, in the interface language.
    const reason = query.get("reason") || "";
    expect(reason).not.toBe("");
    if (language === "en-US") expect(reason).not.toMatch(CJK);
    else expect(reason).toMatch(CJK);
    await expect(page.getByLabel(copy.noteLabel, { exact: true })).toHaveValue(reason);
    await expect(page.getByTestId("prefill-source-internalLineComment")).toHaveText(copy.noteSource);
    if (language === "en-US") {
      const form = page.getByTestId("module-export-scope");
      const chinese = (await form.innerText()).split(/\n+/).map((line) => line.trim()).filter((line) => CJK.test(line));
      expect(chinese).toEqual([]);
    }
    // Opening the form saved nothing.
    expect(await requests()).toHaveLength(before);
  });
}
