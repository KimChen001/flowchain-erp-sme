import { expect, test, type Locator, type Page } from "@playwright/test";

// The assistant on the US walkthrough: visible, its layout on a phone, an
// English notice when it cannot answer here, English recovery messages, and
// answers streamed with their record chips. It answers only with the model
// (the rules engine was removed at the owner's direction, 2026-11-06 and
// 2026-11-07); this server has no model set up, so the panel says so before
// the first question. The tests that stream an answer play its events through
// the page's fetch and tell the panel a model is set up.
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

// The panel as it is on a server with a model: readiness says the assistant answers.
async function withModel(page: Page) {
  await page.route("**/api/ai-runtime/readiness", (route) => route.fulfill({ json: { assistantV2: true, setup: null } }));
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

// No rules answer stands in for the model: without one, the panel says why
// before the first question, offers no starter cards, and a question gets the
// same notice.
test("without a model the panel says why before the first question, and a question gets the same notice", async ({ page }) => {
  await signIn(page);
  const panel = await openAssistant(page);
  await expect(panel.getByTestId("ai-readiness-notice")).toHaveText("The assistant is not set up on this server yet.");
  await expect(panel.getByTestId("ai-empty-prompt-chip")).toHaveCount(0);
  await panel.getByTestId("ai-assistant-input").fill("Which purchase orders are overdue?");
  await panel.getByTestId("ai-assistant-send").click();
  await expect(panel.getByTestId("ai-v2-notice").last()).toHaveText("The assistant is not set up on this server yet.", { timeout: 15_000 });
  await expect(panel.locator('[data-answer-source="workspace_rules"]')).toHaveCount(0);
  expect(await chineseLines(panel)).toEqual([]);
});

test("on a phone the assistant fills the screen and gets out of the way when a record opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await withModel(page);
  const panel = await openAssistant(page);
  await expect(panel).toHaveAttribute("data-docked", "false");
  const box = await panel.boundingBox();
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);
  const stream = await streamAnswers(page);
  await panel.getByTestId("ai-assistant-input").fill("When does our contract with Acme end?");
  await panel.getByTestId("ai-assistant-input").press("Enter");
  await contractAnswer(stream, "msg_phone");
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
  await withModel(page);
  const panel = await openAssistant(page);
  await page.route("**/api/ai-runtime/respond", (route) => route.fulfill({ status: 503, json: { code: "AI_SKILL_UNAVAILABLE", error: "The assistant could not read your workspace data just now. Please try again." } }));
  await panel.getByTestId("ai-empty-prompt-chip").first().click();
  const failed = panel.getByTestId("ai-message-assistant").last();
  await expect(failed.getByTestId("ai-v2-error").locator("p")).toHaveText("The assistant could not answer just now. Nothing was changed.");
  await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(await chineseLines(panel)).toEqual([]);

  await page.unroute("**/api/ai-runtime/respond");
  await newConversation(panel, "New conversation");
  // No answer within the client's 25 second limit.
  await page.route("**/api/ai-runtime/respond", () => new Promise(() => {}));
  await panel.getByTestId("ai-empty-prompt-chip").first().click();
  await expect(panel.getByTestId("ai-message-assistant").last().getByTestId("ai-v2-error")).toContainText("stopped responding", { timeout: 35_000 });
  expect(await chineseLines(panel)).toEqual([]);
});

// An answer about the Acme contract, as the server streams it: its text, the
// check that names the contract it cites (the panel chips it), the answer line.
async function contractAnswer(stream: Awaited<ReturnType<typeof streamAnswers>>, messageId: string) {
  let seq = 0;
  const push = (event: Record<string, unknown>) => stream.push({ v: 2, seq: seq++, ...event });
  await push({ type: "start", threadId: "thr_contract", messageId, model: "scripted", language: "en-US" });
  await push({ type: "progress", step: "reading", sources: ["contracts", "purchase_orders"] });
  await push({ type: "text_delta", partId: "t1", text: "Contract CT-ACME0001 with Acme Components ends on Dec 31, 2026 and needs 60 days of notice." });
  await push({ type: "flag", partId: "t1", spans: [], refs: [{ type: "contract", id: "CT-1", label: "CT-ACME0001" }] });
  await push({ type: "answer", status: 200, body: { version: "v2", intent: "assistant_v2", language: "en-US", parts: [{ id: "t1", type: "text" }], conclusion: { title: "Contract CT-ACME0001 with Acme Components ends on Dec 31, 2026 and needs 60 days of notice.", summary: "Contract CT-ACME0001 with Acme Components ends on Dec 31, 2026 and needs 60 days of notice." } } });
  await stream.close();
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

test("a typed question shows what the assistant reads, then its answer with a contract chip", async ({ page }) => {
  await signIn(page);
  await withModel(page);
  const panel = await openAssistant(page);
  const stream = await streamAnswers(page);
  await panel.getByTestId("ai-assistant-input").fill("When does our contract with Acme end?");
  await panel.getByTestId("ai-assistant-input").press("Enter");
  const progress = panel.getByTestId("ai-progress-line");
  await expect(progress).toBeVisible();
  await stream.push({ v: 2, seq: 0, type: "progress", step: "reading", sources: ["contracts", "purchase_orders"] });
  await expect(progress).toHaveText("Reading contracts and purchase orders…");
  await stream.push({ v: 2, seq: 1, type: "progress", step: "writing" });
  await expect(progress).toHaveText("Writing the answer…");
  let seq = 2;
  const push = (event: Record<string, unknown>) => stream.push({ v: 2, seq: seq++, ...event });
  await push({ type: "text_delta", partId: "t1", text: "Contract CT-ACME0001 with Acme Components ends on Dec 31, 2026 and needs 60 days of notice." });
  await push({ type: "flag", partId: "t1", spans: [], refs: [{ type: "contract", id: "CT-1", label: "CT-ACME0001" }] });
  await push({ type: "answer", status: 200, body: { version: "v2", intent: "assistant_v2", language: "en-US", parts: [{ id: "t1", type: "text" }], conclusion: { title: "Contract CT-ACME0001", summary: "Contract CT-ACME0001 with Acme Components ends on Dec 31, 2026 and needs 60 days of notice." } } });
  await stream.close();
  const answer = panel.getByTestId("ai-v2-message").last();
  await expect(answer).toHaveAttribute("data-done", "true");
  // The contract number in the text is a chip.
  await expect(answer.getByTestId("ai-record-chip")).toHaveText("CT-ACME0001");
  await expect(progress).toHaveCount(0);
  expect(await chineseLines(panel)).toEqual([]);
  // A starter card is asked like a typed question: streamed, to the model.
  await newConversation(panel, "New conversation");
  await panel.getByTestId("ai-empty-prompt-chip").filter({ hasText: "What should I handle first today?" }).click();
  await expect(panel.getByTestId("ai-progress-line")).toBeVisible();
  const accepts = await stream.accepts();
  expect(accepts).toHaveLength(2);
  for (const accept of accepts) expect(accept).toContain("application/x-ndjson");
});

test("the record chip of an answer opens the contract", async ({ page }) => {
  await signIn(page);
  await withModel(page);
  const panel = await openAssistant(page);
  const stream = await streamAnswers(page);
  await panel.getByTestId("ai-assistant-input").fill("When does our contract with Acme end?");
  await panel.getByTestId("ai-assistant-input").press("Enter");
  await expect(panel.getByTestId("ai-progress-line")).toBeVisible();
  await contractAnswer(stream, "msg_link");
  await panel.getByTestId("ai-record-chip").filter({ hasText: "CT-ACME0001" }).click();
  await expect(page).toHaveURL(/\/app\/contracts\/CT-1$/);
});
