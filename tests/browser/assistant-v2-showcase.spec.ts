import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// Assistant v2 end to end (docs/ai-assistant-v2-design.md §9, §11 S2 and S4):
// the panel reads readiness, streams the answer and renders its parts, and the
// in-chat form creates, submits and cancels a purchase request with the
// user's own clicks. The model is the recorded turns in
// tests/browser/fixtures/assistant-v2/showcase-turns.json, replayed by the
// API (FLOWCHAIN_AI_ASSISTANT_MODE=assistant_v2,
// FLOWCHAIN_AI_ASSISTANT_SCRIPTED, PLAYWRIGHT_ASSISTANT_V2=true; see the
// "assistant v2 showcase" phase of scripts/run-product-recovery-playwright.mjs).
// Every value in a table or form comes from the walkthrough data through the
// read tools.
const CJK = /[㐀-鿿]/;
const S2 = "Which purchase orders are overdue, by supplier?";
const S4 = "What should I reorder this week? Fill in a request.";
const FOLLOW_UP = "Which purchase requests are waiting for approval?";
const SLOW = "Give me a summary of this week's purchasing.";

type Session = { token: string; user: unknown };

async function signIn(page: Page): Promise<Session> {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Assistant showcase", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: "en-US", defaultLanguage: "en-US", effectiveLanguage: "en-US", locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  return session;
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

async function apiJson<T>(request: APIRequestContext, session: Session, path: string): Promise<T> {
  const response = await request.get(path, { headers: auth(session) });
  expect(response.ok(), path).toBeTruthy();
  return await response.json() as T;
}

type AuditRow = { entityType: string; entityId: string; metadata?: Record<string, unknown> | null };
type AssistantAudit = { status?: string; formNotes?: number; stopReason?: string };
const latestAssistantAudit = async (request: APIRequestContext, session: Session) => {
  const [row] = await apiJson<AuditRow[]>(request, session, "/api/audit-log?entityType=ai_skill&limit=1");
  return (row?.metadata?.assistantV2 || null) as AssistantAudit | null;
};

async function openAssistant(page: Page, session: Session) {
  // The server says v2 answers this user; without the v2 settings the panel
  // would ask the rules assistant and nothing below would hold.
  const readiness = await apiJson<{ assistantV2?: boolean }>(page.request, session, "/api/ai-runtime/readiness");
  expect(readiness.assistantV2, "start the API with FLOWCHAIN_AI_ASSISTANT_MODE=assistant_v2 and FLOWCHAIN_AI_ASSISTANT_SCRIPTED").toBe(true);
  await page.goto("/app/overview/risks");
  await page.getByTestId("ai-assistant-toggle").click();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(panel: Locator, question: string) {
  const answers = panel.getByTestId("ai-v2-message");
  const before = await answers.count();
  await panel.getByTestId("ai-assistant-input").fill(question);
  await panel.getByTestId("ai-assistant-send").click();
  await expect(answers).toHaveCount(before + 1);
  return answers.last();
}

const chineseLines = async (locator: Locator) => (await locator.innerText()).split(/\n+/).map((line) => line.trim()).filter((line) => CJK.test(line));

test("S2: the overdue orders stream in as a table with a record chip per order", async ({ page }) => {
  const session = await signIn(page);
  const panel = await openAssistant(page, session);
  const answer = await ask(panel, S2);
  await expect(answer).toHaveAttribute("data-done", "true", { timeout: 15_000 });

  await expect(answer.getByTestId("ai-v2-text")).toContainText("Precision Fastener Works is the furthest behind");
  const table = answer.getByTestId("ai-v2-table");
  await expect(table).toContainText("Overdue purchase orders");
  // One chip per order, in the result's order: the most days overdue first.
  const chips = table.locator('[data-testid="ai-record-chip"]:visible');
  await expect(chips).toHaveCount(8);
  await expect(chips.first()).toHaveText("LOCAL-DEMO-PO-020");
  await expect(chips.first()).toHaveAttribute("data-business-id", "LOCAL-DEMO-PO-020");
  await expect(table.locator(":visible", { hasText: "Precision Fastener Works" }).first()).toBeVisible();
  await expect(answer.getByTestId("ai-follow-up-chip")).toHaveCount(2);
  expect(await chineseLines(panel)).toEqual([]);

  // A chip opens the order; docked beside the page, the assistant stays open.
  const before = page.url();
  await chips.first().click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
});

test("S4: the form ticks nothing, creates one draft request, submits and cancels it, and the next question reports it", async ({ page }) => {
  const session = await signIn(page);
  const panel = await openAssistant(page, session);
  const requestsBefore = await apiJson<Array<{ id: string }>>(page.request, session, "/api/procurement/requests");

  const answer = await ask(panel, S4);
  await expect(answer).toHaveAttribute("data-done", "true", { timeout: 15_000 });
  const form = answer.getByTestId("ai-v2-pr-form");
  await expect(form).toBeVisible();
  const rows = form.getByTestId("ai-v2-pr-row");
  await expect(rows).toHaveCount(3);
  // Suggested items are never ticked for the user (decision V2-4).
  await expect(form.locator('[data-testid="ai-v2-pr-row"][data-checked="true"]')).toHaveCount(0);
  await expect(form.getByTestId("ai-v2-pr-create")).toBeDisabled();
  const covered = rows.filter({ hasText: "LDM-001" });
  await expect(covered).toHaveAttribute("data-covered", "true");
  await expect(covered.getByTestId("ai-v2-pr-covered")).toContainText("Already requested:");
  await expect(covered.getByTestId("ai-v2-pr-covered")).toContainText("LOCAL-DEMO-PR-001");

  const sensor = rows.filter({ hasText: "LDM-002" });
  await sensor.getByTestId("ai-v2-pr-tick").check();
  await expect(sensor).toHaveAttribute("data-checked", "true");
  await expect(sensor.locator('[data-field="quantity"] input')).toHaveValue("1735");
  await expect(sensor.locator('[data-field="needBy"]')).toContainText("Lead time 14 days");
  const create = form.getByTestId("ai-v2-pr-create");
  await expect(create).toHaveText("Create draft request (1 line)");
  const formId = await form.getAttribute("data-form-id") || "";
  expect(formId).toMatch(/^thr_\w+:msg_[\w-]+:p\d+$/);

  // A double click creates one request: the form's idempotency key holds even
  // if both clicks reach the server.
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/procurement/requests") posts.push(request.postData() || "");
  });
  await create.dblclick();
  const receipt = answer.getByTestId("ai-v2-pr-receipt");
  await expect(receipt).toHaveAttribute("data-status", "draft");
  const requestsAfter = await apiJson<Array<{ id: string }>>(page.request, session, "/api/procurement/requests");
  const created = requestsAfter.filter((row) => !requestsBefore.some((old) => old.id === row.id));
  expect(created).toHaveLength(1);
  const requestId = created[0].id;
  await expect(receipt).toContainText(requestId);
  expect(posts.length).toBeGreaterThanOrEqual(1);
  for (const body of posts) expect(JSON.parse(body).idempotencyKey).toBe(`ai-form:${formId}`);

  // Submit is its own click, and says the approvers were emailed.
  await receipt.getByTestId("ai-v2-pr-submit").click();
  await expect(receipt).toHaveAttribute("data-status", "submitted");
  await expect(receipt.getByTestId("ai-v2-pr-emailed")).toBeVisible();
  await receipt.getByTestId("ai-v2-pr-cancel").click();
  await expect(receipt).toHaveAttribute("data-status", "cancelled");
  const cancelled = (await apiJson<Array<{ id: string; status: string }>>(page.request, session, "/api/procurement/requests")).find((row) => row.id === requestId);
  expect(cancelled?.status).toBe("cancelled");

  // The next question reports what the form created; the server checks it
  // and adds the note to the thread.
  const reported = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/ai-runtime/respond" && request.method() === "POST");
  await answer.getByTestId("ai-follow-up-chip").filter({ hasText: FOLLOW_UP }).click();
  const next = (await reported).postDataJSON();
  expect(next.message).toBe(FOLLOW_UP);
  expect(next.formResults).toEqual([{ formId, purchaseRequestId: requestId }]);
  const followUp = panel.getByTestId("ai-v2-message").last();
  await expect(followUp).toHaveAttribute("data-done", "true", { timeout: 15_000 });
  await expect(followUp.getByTestId("ai-v2-table")).toBeVisible();
  await expect.poll(async () => (await latestAssistantAudit(page.request, session))?.formNotes).toBe(1);
  expect(await chineseLines(panel)).toEqual([]);
});

test("Stop ends a streaming answer and nothing more is spent on it", async ({ page }) => {
  const session = await signIn(page);
  const panel = await openAssistant(page, session);
  const answer = await ask(panel, SLOW);
  await expect(answer.getByTestId("ai-v2-text")).toContainText("Here is this week's purchasing so far.");
  await expect(answer).toHaveAttribute("data-done", "false");
  await panel.getByTestId("ai-assistant-stop").click();
  await expect(answer.getByTestId("ai-v2-notice")).toHaveAttribute("data-code", "cancelled");
  await expect(answer.getByTestId("ai-v2-notice")).toHaveText("Stopped. Nothing was changed.");
  await expect(answer).not.toContainText("The rest of this answer");
  await expect(panel.getByTestId("ai-assistant-stop")).toHaveCount(0);
  await expect(panel.getByTestId("ai-assistant-send")).toBeVisible();
  // The server saw the client go away and ended the answer there.
  await expect.poll(async () => (await latestAssistantAudit(page.request, session))?.status, { timeout: 10_000 }).toBe("cancelled");
  expect(await chineseLines(panel)).toEqual([]);
});
