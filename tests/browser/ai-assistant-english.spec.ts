import { expect, test, type Locator, type Page } from "@playwright/test";

// The assistant on the US walkthrough: visible, its layout on a phone, an
// English recovery message when the answer cannot be produced, and answers
// streamed with their checked record links. Since 2026-11-06 it answers only
// with assistant v2 (the rules engine was removed at the owner's direction);
// this server has no model set up, so a question gets a notice that says so.
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

async function newConversation(panel: Locator, label: string) {
  await panel.getByRole("button", { name: label }).click();
  await expect(panel.getByTestId("ai-empty-prompt-chip").first()).toBeVisible();
}

const chineseLines = async (locator: Locator) => (await locator.innerText()).split(/\n+/).map((line) => line.trim()).filter((line) => CJK.test(line));

// No rules answer stands in for the model any more: without one, a question
// gets a notice that says why, in the question's language.
test("without a model a question gets an English notice that says why, and no rules answer", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  await panel.getByTestId("ai-assistant-input").fill("Which purchase orders are overdue?");
  await panel.getByTestId("ai-assistant-send").click();
  await expect(panel.getByText("The assistant is not set up on this server yet.").first()).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('[data-answer-source="workspace_rules"]')).toHaveCount(0);
  expect(await chineseLines(panel)).toEqual([]);
});

test("on a phone the assistant fills the screen and gets out of the way when a record opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const panel = await openAssistant(page);
  await expect(panel).toHaveAttribute("data-docked", "false");
  const box = await panel.boundingBox();
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);
  // A streamed answer with a record link: this server has no model, and since
  // 2026-11-06 no rules answer either.
  const stream = await streamAnswers(page);
  await panel.getByTestId("ai-assistant-input").fill("When does our contract with Acme end?");
  await panel.getByTestId("ai-assistant-input").press("Enter");
  await stream.push({ type: "answer", status: 200, body: contractAnswer("ai-model-first-phone") });
  await stream.close();
  const before = page.url();
  await panel.getByTestId("ai-record-chip").filter({ hasText: "CT-ACME0001" }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId("ai-assistant-panel")).toHaveCount(0);
  await expect(page.getByTestId("ai-assistant-toggle")).toBeVisible();
});

test("a failed or slow answer shows an English recovery message", async ({ page }) => {
  // It waits out the client's 25 second limit.
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
  // No answer within the client's 25 second limit (a chip may go to the model too).
  await page.route("**/api/ai-runtime/respond", () => new Promise(() => {}));
  await panel.getByTestId("ai-empty-prompt-chip").first().click();
  await expect(panel.getByTestId("ai-message-assistant").last()).toContainText("took too long to answer", { timeout: 35_000 });
  expect(await chineseLines(panel)).toEqual([]);
});

// The model-first assistant's progress stream (server/routes/ai-runtime-stream.mjs),
// played line by line through the page's fetch: no model runs here.
// A checked answer about the Acme contract, with its record link.
function contractAnswer(responseId: string) {
  return {
    version: "v2", responseId, query: "When does our contract with Acme end?", intent: "model_first", language: "en-US",
    answerSource: "workspace_model", answerSourceLabel: "Written by AI from your records; figures checked", runtimeModeLabel: "Written by AI from your records; figures checked",
    checked: ["contracts"], checkedLabel: "Checked: contracts", figures: [], scope: { module: "workspace", dataScopeLabel: "Your workspace" },
    conclusion: { title: "The Acme agreement ends on 2026-12-31", summary: "Contract CT-ACME0001 ends on 2026-12-31.", severity: "info", confidence: "medium" },
    keyEvidence: [], contextCards: [], realEvidenceCount: 0, contextCardCount: 0, limitationCount: 0, businessImpact: [], recommendedActions: [],
    navigationLinks: [{ label: "Open CT-ACME0001", moduleId: "contracts:list", entityType: "contract", entityId: "CT-1", returnTo: "ai-assistant", source: "ai" }],
    dataLimitations: [], reviewCards: [], followUpQuestions: [], followUpSuggestions: [], contextBreadcrumbs: [],
    safetyBoundaries: [], sourceSummary: [], readinessSignals: [], generatedAt: new Date().toISOString(), dataScopeLabel: "Your workspace",
  };
}

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
  // A chip keeps the plain JSON request; without a model its answer is the notice.
  await newConversation(panel, "New conversation");
  await panel.getByTestId("ai-empty-prompt-chip").filter({ hasText: "What should I handle first today?" }).click();
  await expect(panel.getByText("The assistant is not set up on this server yet.").first()).toBeVisible({ timeout: 15_000 });
  const accepts = await stream.accepts();
  expect(accepts[0]).toContain("application/x-ndjson");
  expect(accepts[1]).not.toContain("application/x-ndjson");
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

