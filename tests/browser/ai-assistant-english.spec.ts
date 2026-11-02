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
  // Docked to the right at full height beside the page; the launcher is hidden.
  await expect(panel).toHaveAttribute("data-docked", "true");
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && Math.round(box.x + box.width)).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);
  await expect(page.getByTestId("ai-assistant-toggle")).toHaveCount(0);
  await expect(panel.getByTestId("ai-query-mode")).toHaveCount(0);
  await expect(panel.getByTestId("ai-welcome")).toContainText("I can look up purchasing, inventory and invoices");
  for (const [chip, headline] of [
    ["What should I handle first today?", /items? needs? attention today|Nothing needs attention today/],
    ["Which purchase orders are overdue?", /purchase orders? (?:is|are) overdue/],
  ] as const) {
    const answer = await askChip(panel, chip);
    await expect(answer.getByTestId("ai-answer-source")).toContainText("Answered from your workspace data");
    await expect(answer.getByTestId("ai-answer-checked")).toContainText("Checked:");
    await expect(answer.getByTestId("ai-focused-conclusion").locator("h3")).toHaveText(headline);
    // One trust line, no severity chip or evidence count.
    await expect(answer.getByTestId("ai-trust-line").locator("summary")).toContainText("From your records");
    await expect(answer).not.toContainText(/Verifiable records|View key evidence/);
    expect(await chineseLines(panel), chip).toEqual([]);
    if (chip === "Which purchase orders are overdue?") {
      const draft = answer.getByTestId("ai-action-draft-preview").first();
      await expect(draft).toHaveText("Review draft");
    }
    await newConversation(panel, "New conversation");
  }

  // The request card is asked as typed: without an item, the assistant asks which one.
  const request = await askChip(panel, "Draft a purchase request");
  await expect(request.getByTestId("ai-focused-conclusion")).toBeVisible();
  expect(await chineseLines(panel)).toEqual([]);
  await newConversation(panel, "New conversation");

  // A record chip opens the record; docked beside the page, the assistant stays open.
  const answer = await askChip(panel, "What should I handle first today?");
  const link = answer.getByTestId("ai-focused-primary-items").locator('[data-action-kind="view_evidence"]').first();
  await expect(link).toBeVisible();
  const before = page.url();
  await link.click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
});

test("on a phone the assistant fills the screen and gets out of the way when a record opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const panel = await openAssistant(page);
  await expect(panel).toHaveAttribute("data-docked", "false");
  const box = await panel.boundingBox();
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);
  const answer = await askChip(panel, "What should I handle first today?");
  const before = page.url();
  await answer.getByTestId("ai-focused-primary-items").locator('[data-action-kind="view_evidence"]').first().click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId("ai-assistant-panel")).toHaveCount(0);
  await expect(page.getByTestId("ai-assistant-toggle")).toBeVisible();
});

test("a prepared draft opens as a supplier message for the user's own mail app", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const answer = await askChip(panel, "Which purchase orders are overdue?");
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

test("one message to a supplier covers its overdue orders, says how much arrived, and notes a missing email", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const answers = panel.locator('[data-answer-source="workspace_rules"]');
  const before = await answers.count();
  await page.getByTestId("ai-assistant-input").fill("Prepare a message to Acme Components asking about partial delivery.");
  await page.getByTestId("ai-assistant-send").click();
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  const answer = answers.last();
  // Every draft is for Acme: the follow-up and, when Acme has one, its invoice query.
  await expect(answer).toContainText(/[0-9]+ drafts? for Acme Components/);
  await answer.locator('[data-testid="ai-action-draft-preview"][data-draft-type="po_followup_draft"]').first().click();
  const shell = page.getByTestId("action-draft-review-shell");
  // Acme has no email on file: the review says so rather than leaving To blank.
  await expect(shell.getByTestId("action-draft-to-missing")).toContainText("No email on file for this supplier");
  // Both overdue orders, each line named by its order; the partly received one says how much arrived.
  const lines = shell.getByTestId("action-draft-lines");
  await expect(lines.locator("th")).toHaveText(["Order", "SKU", "Item", "Remaining", "Received", "Promised date"]);
  await expect(lines).toContainText("LOCAL-DEMO-PO-001");
  await expect(lines).toContainText("LOCAL-DEMO-PO-015");
  await expect(lines).toContainText("20 of 50");
  await expect(shell.getByTestId("action-draft-message-body")).toHaveValue(/could you ship what is ready now/);
  expect(await chineseLines(shell), "draft review").toEqual([]);
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(shell).toHaveCount(0);

  // Asked under the purchasing policy, the answer cites the workspace's policy
  // document, and the draft review shows it as the basis, outside the message.
  // (Docked beside the page, the assistant stays open while a draft is reviewed.)
  await expect(panel).toBeVisible();
  const count = await answers.count();
  await page.getByTestId("ai-assistant-input").fill("Under our purchasing policy, prepare a message to Acme Components about its overdue orders.");
  await page.getByTestId("ai-assistant-send").click();
  await expect(answers).toHaveCount(count + 1, { timeout: 15_000 });
  await answers.last().locator('[data-testid="ai-action-draft-preview"][data-draft-type="po_followup_draft"]').first().click();
  await expect(shell.getByTestId("action-draft-basis")).toContainText("Based on your documents:");
  await expect(shell.getByTestId("action-draft-basis")).toContainText("Procurement and Inventory Operating Policy");
  await expect(shell.getByTestId("action-draft-message-body")).not.toHaveValue(/Procurement and Inventory Operating Policy/);
  await page.getByRole("button", { name: "Discard draft" }).click();
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
  // The slow case waits out the client's 25 second limit.
  test.setTimeout(90_000);
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
  // No answer within the client's 25 second limit (a card may reach the model-first loop too).
  await page.route("**/api/ai-runtime/respond", () => new Promise(() => {}));
  await panel.getByTestId("ai-empty-prompt-chip").first().click();
  await expect(panel.getByTestId("ai-message-assistant").last()).toContainText("took too long to answer", { timeout: 40_000 });
  expect(await chineseLines(panel)).toEqual([]);
});

// The model-first assistant's progress stream (server/routes/ai-runtime-stream.mjs),
// played line by line through the page's fetch: no model runs here.
async function streamAnswers(page: Page) {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const state = window as unknown as { __aiAccepts: string[]; __aiPush: (line: unknown) => void; __aiClose: () => void };
    state.__aiAccepts = [];
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const accept = String(new Headers(init?.headers).get("accept") || "");
      if (!url.includes("/api/ai-runtime/respond")) return original(input, init);
      state.__aiAccepts.push(accept);
      if (!accept.includes("application/x-ndjson")) return original(input, init);
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          state.__aiPush = (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          state.__aiClose = () => controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    };
  });
  return {
    push: (line: unknown) => page.evaluate((value) => (window as unknown as { __aiPush: (line: unknown) => void }).__aiPush(value), line),
    close: () => page.evaluate(() => (window as unknown as { __aiClose: () => void }).__aiClose()),
    accepts: () => page.evaluate(() => (window as unknown as { __aiAccepts: string[] }).__aiAccepts),
  };
}

test("a typed question shows what the assistant reads, then its checked answer with a contract link", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const stream = await streamAnswers(page);
  await panel.getByTestId("ai-assistant-input").fill("When does our contract with Acme end?");
  await panel.getByTestId("ai-assistant-input").press("Enter");
  const progress = panel.getByTestId("ai-progress-line");
  await expect(progress).toBeVisible();
  await stream.push({ type: "progress", step: "reading", sources: ["contracts", "purchase_orders"] });
  await expect(progress).toHaveText("Reading contracts and purchase orders…");
  await stream.push({ type: "progress", step: "writing" });
  await expect(progress).toHaveText("Writing the answer…");
  await stream.push({ type: "progress", step: "checking" });
  await expect(progress).toHaveText("Checking the figures…");
  await stream.push({ type: "answer", status: 200, body: {
    version: "v2", responseId: "ai-model-first-test", query: "When does our contract with Acme end?", intent: "model_first", language: "en-US",
    answerSource: "workspace_model", answerSourceLabel: "Written by AI from your records; figures checked", runtimeModeLabel: "Written by AI from your records; figures checked",
    checked: ["contracts"], checkedLabel: "Checked: contracts", figures: [],
    scope: { module: "workspace", dataScopeLabel: "Your workspace" },
    conclusion: { title: "The Acme agreement ends on 2026-12-31", summary: "Contract CT-ACME0001 with Acme Components ends on 2026-12-31 and needs 60 days of notice.", severity: "info", confidence: "medium" },
    keyEvidence: [{ id: "mf-1", label: "CT-ACME0001", entityLabel: "CT-ACME0001", entityType: "contract", entityId: "CT-1", moduleId: "contracts:list", severity: "info", sourceLabel: "Your workspace" }],
    contextCards: [], realEvidenceCount: 1, contextCardCount: 0, limitationCount: 0, businessImpact: [], recommendedActions: [],
    navigationLinks: [{ label: "Open CT-ACME0001", moduleId: "contracts:list", entityType: "contract", entityId: "CT-1", returnTo: "ai-assistant", source: "ai" }],
    dataLimitations: [], reviewCards: [], followUpQuestions: [], followUpSuggestions: [], contextBreadcrumbs: [],
    safetyBoundaries: [], sourceSummary: [], readinessSignals: [], generatedAt: new Date().toISOString(), dataScopeLabel: "Your workspace",
  } });
  await stream.close();
  const answer = panel.locator('[data-answer-source="workspace_model"]');
  await expect(answer.getByTestId("ai-answer-source")).toContainText("Written by AI from your records; figures checked");
  await expect(answer.getByTestId("ai-focused-conclusion").locator("h3")).toHaveText("The Acme agreement ends on 2026-12-31");
  // The contract number in the text is a chip; one line says the figures were checked.
  await expect(answer.getByTestId("ai-answer-text").getByTestId("ai-record-chip")).toHaveText("CT-ACME0001");
  await expect(answer.getByTestId("ai-trust-line").locator("summary")).toHaveText(/Figures checked\s*· 1 source/);
  await expect(progress).toHaveCount(0);
  expect(await chineseLines(panel)).toEqual([]);
  // A card asks the same way: the model-first loop may answer it too (owner decision 2026-11-01).
  await newConversation(panel, "New conversation");
  await panel.getByTestId("ai-empty-prompt-chip").filter({ hasText: "What should I handle first today?" }).click();
  await expect.poll(async () => (await stream.accepts()).length).toBe(2);
  const accepts = await stream.accepts();
  expect(accepts[0]).toContain("application/x-ndjson");
  expect(accepts[1]).toContain("application/x-ndjson");
});

test("the record link of a model-first answer opens the contract", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  const stream = await streamAnswers(page);
  await panel.getByTestId("ai-assistant-input").fill("When does our contract with Acme end?");
  await panel.getByTestId("ai-assistant-input").press("Enter");
  await expect(panel.getByTestId("ai-progress-line")).toBeVisible();
  await stream.push({ type: "answer", status: 200, body: {
    version: "v2", responseId: "ai-model-first-link", query: "When does our contract with Acme end?", intent: "model_first", language: "en-US",
    answerSource: "workspace_model", answerSourceLabel: "Written by AI from your records; figures checked", runtimeModeLabel: "Written by AI from your records; figures checked",
    checked: ["contracts"], checkedLabel: "Checked: contracts", figures: [], scope: { module: "workspace", dataScopeLabel: "Your workspace" },
    conclusion: { title: "The Acme agreement ends on 2026-12-31", summary: "Contract CT-ACME0001 ends on 2026-12-31.", severity: "info", confidence: "medium" },
    keyEvidence: [], contextCards: [], realEvidenceCount: 0, contextCardCount: 0, limitationCount: 0, businessImpact: [], recommendedActions: [],
    navigationLinks: [{ label: "Open CT-ACME0001", moduleId: "contracts:list", entityType: "contract", entityId: "CT-1", returnTo: "ai-assistant", source: "ai" }],
    dataLimitations: [], reviewCards: [], followUpQuestions: [], followUpSuggestions: [], contextBreadcrumbs: [],
    safetyBoundaries: [], sourceSummary: [], readinessSignals: [], generatedAt: new Date().toISOString(), dataScopeLabel: "Your workspace",
  } });
  await stream.close();
  // The chip in the text is the link; it is not repeated as an "Open" button.
  await expect(panel.getByTestId("ai-business-navigation-action")).toHaveCount(0);
  await panel.getByTestId("ai-record-chip").filter({ hasText: "CT-ACME0001" }).click();
  await expect(page).toHaveURL(/\/app\/contracts\/CT-1$/);
});

test("in Chinese the same chip answers in Chinese", async ({ page }) => {
  await signIn(page, "zh-CN");
  const panel = await openAssistant(page);
  const answer = await askChip(panel, "今天先处理什么？");
  await expect(answer.getByTestId("ai-answer-source")).toContainText("基于当前工作区数据回答");
  await expect(answer.getByTestId("ai-focused-conclusion").locator("h3")).toHaveText(/今天需要关注|今天没有需要优先处理的事项/);
});
