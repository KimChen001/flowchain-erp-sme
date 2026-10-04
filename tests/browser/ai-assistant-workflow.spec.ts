import { expect, test, type Locator, type Page } from "@playwright/test";

// The assistant's working loop on the US walkthrough: it answers about the
// whole workspace on every page, and about an opened purchase order only when
// the question points at it; a short follow-up is read with the previous
// answer and a compound question is answered part by part; the conversation
// survives minimizing; an instruction to act is refused with a draft offered
// instead; and a draft opens for review only. English first, then Chinese.
const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Assistant workflow", company: "FlowChain" },
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
}

async function openAssistant(page: Page) {
  await page.goto("/app/overview/risks");
  await page.getByTestId("ai-assistant-toggle").click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();
  return panel;
}

// Runs the step that asks a question and returns the answer it produced.
async function nextAnswer(panel: Locator, ask: () => Promise<void>) {
  const answers = panel.getByTestId("ai-response-v2");
  const before = await answers.count();
  await ask();
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  return answers.nth(before);
}

const askChip = (panel: Locator, chip: string) => nextAnswer(panel, () => panel.getByTestId("ai-empty-prompt-chip").filter({ hasText: chip }).click());
const askTyped = (panel: Locator, question: string) => nextAnswer(panel, async () => {
  await panel.getByTestId("ai-assistant-input").fill(question);
  await panel.getByTestId("ai-assistant-send").click();
});
const headline = (answer: Locator) => answer.getByTestId("ai-focused-conclusion").locator("h3");
// The records an answer lists as its priorities, by their link text.
const evidenceLinks = (answer: Locator) => answer.getByTestId("ai-focused-primary-items").locator('[data-action-kind="view_evidence"]');

async function newConversation(panel: Locator, label = "New conversation") {
  await panel.getByRole("button", { name: label }).click();
  await expect(panel.getByTestId("ai-empty-prompt-chip").first()).toBeVisible();
}

const chineseLines = async (locator: Locator) => (await locator.innerText()).split(/\n+/).map((line) => line.trim()).filter((line) => CJK.test(line));

async function expectNoInternalLeakage(locator: Locator) {
  await expect(locator).not.toContainText(/tool_result|response_card|entityType|documentType|skillHint|workspace_rules|provider|fallback|\{\s*"/i);
}

// Opens the first purchase order the answer to a prompt chip lists, then
// reopens the assistant there.
async function openPurchaseOrderFromAnswer(page: Page, panel: Locator, chip: string) {
  const answer = await askChip(panel, chip);
  const link = evidenceLinks(answer).filter({ hasText: /PO-/ }).first();
  const poId = (await link.innerText()).trim();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/app/procurement/orders/${poId}(\\?|$)`));
  await expect(panel).toHaveCount(0);
  await page.getByTestId("ai-assistant-toggle").click();
  await expect(panel).toBeVisible();
  // Opening the record kept the conversation.
  await expect(panel.getByTestId("ai-response-v2")).toHaveCount(1);
  return poId;
}

test("on a purchase order's page the assistant answers about the order only when asked", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  await expect(panel.getByTestId("ai-context-chip")).toHaveText("Scope: Whole workspace");
  await expect(panel.getByTestId("ai-assistant-input")).toHaveAttribute("placeholder", "Ask anything about your workspace");

  const poId = await openPurchaseOrderFromAnswer(page, panel, "What should I handle first today?");
  // The scope stays the workspace; the page's order is named beside it.
  await expect(panel.getByTestId("ai-context-chip")).toContainText(`Scope: Whole workspace · this page: Purchase order ${poId}`);
  await expect(panel.getByTestId("ai-assistant-input")).toHaveAttribute("placeholder", "Ask anything about your workspace, or about this PO");
  await newConversation(panel);
  // Two chips about the order, then two about the workspace.
  await expect(panel.getByTestId("ai-empty-prompt-chip")).toHaveText([
    "Why does this PO need attention?",
    "Which receipt or invoice evidence is missing?",
    "What should I handle first today?",
    "Which items have the highest risk?",
  ]);

  // The order's own chip answers about that order alone.
  const chipAnswer = await askChip(panel, "Why does this PO need attention?");
  await expect(headline(chipAnswer)).toHaveText(`Why ${poId} needs attention`);
  await expect(evidenceLinks(chipAnswer)).toHaveText([poId]);

  // So does a typed question about "this PO".
  const typed = await askTyped(panel, "Why is this PO a priority?");
  await expect(headline(typed)).toHaveText(`Why ${poId} needs attention`);
  await expect(evidenceLinks(typed)).toHaveText([poId]);

  // A question that does not point at the order is about the whole workspace.
  const workspace = await askTyped(panel, "What should I handle first today?");
  await expect(headline(workspace)).toHaveText(/items? needs? attention today/);
  expect(await evidenceLinks(workspace).count()).toBeGreaterThan(1);

  expect(await chineseLines(panel)).toEqual([]);
  await expectNoInternalLeakage(panel);

  // Setting the order aside leaves the workspace scope and its chips.
  await panel.getByTestId("ai-context-clear").click();
  await expect(panel.getByTestId("ai-context-chip")).toHaveText("Scope: Whole workspace");
  await expect(panel.getByTestId("ai-assistant-input")).toHaveAttribute("placeholder", "Ask anything about your workspace");
  await newConversation(panel);
  await expect(panel.getByTestId("ai-empty-prompt-chip")).toHaveText([
    "What should I handle first today?",
    "Which items have the highest risk?",
    "Which records need more data?",
    "Prepare an action draft",
  ]);
});

test("in Chinese the page's purchase order is named and answered in Chinese", async ({ page }) => {
  await signIn(page, "zh-CN");
  const panel = await openAssistant(page);
  await expect(panel.getByTestId("ai-context-chip")).toHaveText("范围：整个工作区");
  const poId = await openPurchaseOrderFromAnswer(page, panel, "今天先处理什么？");
  await expect(panel.getByTestId("ai-context-chip")).toContainText(`范围：整个工作区 · 本页：采购单 ${poId}`);
  await expect(panel.getByTestId("ai-assistant-input")).toHaveAttribute("placeholder", "问工作区的任何问题，或问这个 PO");
  await newConversation(panel, "新对话");
  const answer = await askChip(panel, "这个 PO 为什么需要关注？");
  await expect(headline(answer)).toHaveText(`${poId} 需要关注的原因`);
  await expect(evidenceLinks(answer)).toHaveText([poId]);
});

test("a short follow-up is read with the previous answer", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const risks = await askChip(panel, "Which items have the highest risk?");
  await expect(headline(risks)).toHaveText(/^Highest risk: /);
  const listed = (await evidenceLinks(risks).allInnerTexts()).map((label) => label.trim());
  expect(listed.length).toBeGreaterThan(1);

  // "The second one" is the second record that answer listed.
  const second = await askTyped(panel, "the second one");
  await expect(headline(second)).toContainText(listed[1]);
  await expect(evidenceLinks(second).first()).toHaveText(listed[1]);

  // "Why?" asks about the record the previous answer was about, named as
  // the list showed it: a supplier by its name, never by its code.
  const why = await askTyped(panel, "Why?");
  await expect(headline(why)).toHaveText(`Why ${listed[1]} needs attention`);
  // In the walkthrough that record is a supplier: the summary says what that
  // supplier has open and its most urgent record, not the workspace's totals.
  const whySummary = why.getByTestId("ai-focused-conclusion").locator("p");
  await expect(whySummary).toContainText(`${listed[1]} has `);
  await expect(whySummary).toContainText("Most urgent: ");
  await expect(whySummary).not.toContainText("open purchase orders");
  await expect(evidenceLinks(why).first()).toBeVisible();

  expect(await chineseLines(panel)).toEqual([]);
  await expectNoInternalLeakage(panel);
});

test("a question with two parts is answered part by part", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const answer = await askTyped(panel, "What should I handle first today, and which records need more data?");
  await expect(headline(answer)).toHaveText("Your question, answered part by part");
  const sections = answer.getByTestId("ai-answer-section");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toHaveAttribute("data-skill", "today_priorities");
  await expect(sections.nth(0).locator("h4")).toHaveText(/items? needs? attention today|Nothing needs attention today/);
  await expect(sections.nth(1)).toHaveAttribute("data-skill", "records_needing_data");
  await expect(sections.nth(1).locator("h4")).toHaveText(/records? needs? more data|No records are missing required fields/);
  expect(await chineseLines(panel)).toEqual([]);
  await expectNoInternalLeakage(panel);
});

test("minimizing the assistant keeps the conversation", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const answer = await askChip(panel, "Which items have the highest risk?");
  const title = await headline(answer).innerText();

  // A click outside the panel minimizes it; reopening shows the same answer.
  await page.locator("main h1, main h2").first().click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId("ai-assistant-toggle").click();
  await expect(panel.getByTestId("ai-response-v2")).toHaveCount(1);
  await expect(headline(panel.getByTestId("ai-response-v2"))).toHaveText(title);

  // So does Escape.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.getByTestId("ai-assistant-toggle").click();
  await expect(headline(panel.getByTestId("ai-response-v2"))).toHaveText(title);
});

test("an instruction to act is refused and a draft is offered instead", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const refusal = await askTyped(panel, "Approve this PO and send it to the supplier");
  await expect(headline(refusal)).toHaveText("I can't do that, but I can prepare a draft");
  await expect(refusal).toContainText("I can't approve, pay, send, issue, cancel or delete anything.");
  // Nothing on the refusal opens, drafts or changes a record.
  await expect(refusal.locator("[data-action-kind]")).toHaveCount(0);

  // The offered draft is one to review, not an action.
  const drafts = await nextAnswer(panel, () => refusal.getByTestId("ai-focused-follow-ups").getByRole("button", { name: "Prepare a draft" }).click());
  await expect(headline(drafts)).toHaveText(/drafts? ready for your review/);
  await expect(drafts.getByTestId("ai-action-draft-preview").first()).toHaveText("Review draft");
  expect(await chineseLines(panel)).toEqual([]);
  await expectNoInternalLeakage(panel);
});

test("in Chinese an instruction to act is refused in Chinese", async ({ page }) => {
  await signIn(page, "zh-CN");
  const panel = await openAssistant(page);
  const refusal = await askTyped(panel, "直接批准这个 PO 并发给供应商");
  await expect(headline(refusal)).toHaveText("我不能执行这个操作，但可以准备草稿");
  await expect(refusal.locator("[data-action-kind]")).toHaveCount(0);
});

for (const [language, copy] of [
  ["en-US", {
    chip: "Prepare an action draft", type: "PO follow-up note", labels: ["Purchase order", "Open lines"],
    limits: "Risky actions stay off: nothing is submitted, sent, or written to inventory, finance entries or payments.",
    confirmation: "Needs human confirmation", keep: "Keep draft for review", kept: "Only a draft for review was kept. No business document was created.",
  }],
  ["zh-CN", {
    chip: "帮我准备一个处理草稿", type: "PO 跟进备注草稿", labels: ["采购订单", "未到货明细"],
    limits: "危险动作保持关闭：不提交、不外发、不写库存、不写财务凭证、不处理资金。",
    confirmation: "需要人工确认", keep: "保留待复核草稿", kept: "仅保存待复核草稿，不会创建业务单据。",
  }],
] as const) {
  test(`a draft opens for review only and is kept for review (${language})`, async ({ page }) => {
    await signIn(page, language);
    const panel = await openAssistant(page);
    const answer = await askChip(panel, copy.chip);
    await answer.getByTestId("ai-action-draft-preview").first().click();
    const shell = page.getByTestId("action-draft-review-shell");
    await expect(shell).toBeVisible({ timeout: 15_000 });
    const dialog = page.locator("div.fixed.inset-0").filter({ has: shell });
    await expect(shell).toContainText(copy.limits);
    await expect(shell).toContainText(copy.type);
    await expect(shell).toContainText(copy.confirmation);
    // Every draft field has a label in the interface language, not its key.
    for (const label of copy.labels) await expect(shell).toContainText(label);
    await expect(shell).not.toContainText(/Po Id|Invoice Id|\bLines\b|\bLanguage\b/);
    if (language === "en-US") expect(await chineseLines(dialog)).toEqual([]);
    // Review, copy, discard or keep: nothing in the draft sends, submits or posts.
    await expect(dialog.getByRole("button", { name: /send|submit|approve|post|pay|发送|提交|批准|过账|付款/i })).toHaveCount(0);

    // Keeping it stores the draft and creates no business document.
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/action-drafts/save"));
    await dialog.getByRole("button", { name: copy.keep }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({ persisted: true, createsBusinessDocument: false, requiresConfirmation: true });
    await expect(page.getByText(copy.kept)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(shell).toHaveCount(0);
  });
}
