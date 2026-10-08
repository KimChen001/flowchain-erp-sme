import { expect, test, type Locator, type Page } from "@playwright/test";

// The assistant on the US walkthrough: visible, answering the prompt chips in
// English from the workspace data, with links and review-only drafts, and an
// English recovery message when the answer cannot be produced. The same flow
// in Chinese answers in Chinese.
const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Assistant walkthrough", company: "FlowChain" },
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

async function askChip(panel: Locator, chip: string) {
  const answers = panel.locator('[data-answer-source="workspace_rules"]');
  const before = await answers.count();
  await panel.getByTestId("ai-empty-prompt-chip").filter({ hasText: chip }).click();
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  return answers.last();
}

async function newConversation(panel: Locator, label: string) {
  await panel.getByRole("button", { name: label }).click();
  await expect(panel.getByTestId("ai-empty-prompt-chip").first()).toBeVisible();
}

const chineseLines = async (locator: Locator) => (await locator.innerText()).split(/\n+/).map((line) => line.trim()).filter((line) => CJK.test(line));

test("the assistant answers every prompt chip in English from the workspace data", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  for (const [chip, headline] of [
    ["What should I handle first today?", /items? needs? attention today|Nothing needs attention today/],
    ["What is at risk right now?", /^Oldest open problem: |No open problems found/],
    ["Which records need more data?", /records? needs? more data|No records are missing required fields/],
    ["Prepare an action draft", /drafts? ready for your review|No draft is needed right now/],
  ] as const) {
    const answer = await askChip(panel, chip);
    await expect(answer.getByTestId("ai-answer-source")).toContainText("Answered from your workspace data");
    await expect(answer.getByTestId("ai-answer-checked")).toContainText("Checked:");
    await expect(answer.getByTestId("ai-focused-conclusion").locator("h3")).toHaveText(headline);
    expect(await chineseLines(panel), chip).toEqual([]);
    if (chip === "Prepare an action draft") {
      const draft = answer.getByTestId("ai-action-draft-preview").first();
      await expect(draft).toHaveText("Review draft");
    }
    await newConversation(panel, "New conversation");
  }

  // An evidence link opens the record and minimizes the assistant.
  const answer = await askChip(panel, "What should I handle first today?");
  const link = answer.getByTestId("ai-focused-primary-items").locator('[data-action-kind="view_evidence"]').first();
  await expect(link).toBeVisible();
  const before = page.url();
  await link.click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId("ai-assistant-panel")).toHaveCount(0);
});

test("a prepared draft opens as a supplier message for the user's own mail app", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const answer = await askChip(panel, "Prepare an action draft");
  await answer.getByTestId("ai-action-draft-preview").first().click();
  const shell = page.getByTestId("action-draft-review-shell");
  await expect(shell.getByTestId("action-draft-message")).toContainText("Supplier message");
  // Prefilled from the record and supplier master data, each field with its source.
  await expect(shell.getByTestId("action-draft-to")).toHaveValue(/^[^@\s]+@[^@\s]+$/);
  await expect(shell.getByTestId("action-draft-source-to")).toHaveText("Supplier contact");
  await expect(shell.getByTestId("action-draft-subject")).not.toHaveValue("");
  await expect(shell.getByTestId("action-draft-message-body")).toHaveValue(/^Hello [^\n]+,\n\nPlease confirm/);
  await expect(shell.getByTestId("action-draft-source-message")).toHaveText("Template");
  await shell.getByTestId("action-draft-subject").fill("Delivery date");
  await expect(page.getByTestId("action-draft-open-email")).toHaveAttribute("href", /^mailto:[^?]*\?subject=Delivery%20date&body=\S+/);
  // FlowChain sends nothing: the link hands the text to the user's mail app.
  await expect(shell).toContainText("FlowChain does not send anything.");
  expect(await chineseLines(shell), "draft review").toEqual([]);
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(shell).toHaveCount(0);
});

test("every line that needs attention states its next step and offers its draft there", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const answer = await askChip(panel, "What should I handle first today?");
  const step = answer.getByTestId("ai-focused-primary-items").getByTestId("ai-line-next-step").first();
  await expect(step).toContainText(/^Next: /);
  await expect(step.locator('[data-action-kind="generate_text_draft"], [data-action-kind="create_formal_business_draft"]')).toHaveCount(1);
  expect(await chineseLines(answer)).toEqual([]);
});

test("a failed or slow answer shows an English recovery message", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  await page.route("**/api/ai-runtime/respond", (route) => route.fulfill({ status: 503, json: { code: "AI_SKILL_UNAVAILABLE", error: "The assistant could not read your workspace data just now. Please try again." } }));
  await panel.getByTestId("ai-empty-prompt-chip").first().click();
  const failed = panel.getByTestId("ai-message-assistant").last();
  await expect(failed).toContainText("could not read your workspace data just now");
  await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(await chineseLines(panel)).toEqual([]);

  await page.unroute("**/api/ai-runtime/respond");
  await newConversation(panel, "New conversation");
  // No answer within the client's 12 second limit.
  await page.route("**/api/ai-runtime/respond", () => new Promise(() => {}));
  await panel.getByTestId("ai-empty-prompt-chip").first().click();
  await expect(panel.getByTestId("ai-message-assistant").last()).toContainText("took too long to answer", { timeout: 20_000 });
  expect(await chineseLines(panel)).toEqual([]);
});

test("in Chinese the same chip answers in Chinese", async ({ page }) => {
  await signIn(page, "zh-CN");
  const panel = await openAssistant(page);
  const answer = await askChip(panel, "今天先处理什么？");
  await expect(answer.getByTestId("ai-answer-source")).toContainText("基于当前工作区数据回答");
  await expect(answer.getByTestId("ai-focused-conclusion").locator("h3")).toHaveText(/今天需要关注|今天没有需要优先处理的事项/);
});
