import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SUPPLIER_REPLY_CONTRACT_VERSION, supplierReplyCardSchema } from "../../shared/supplier-reply-contract.mjs";

// The supplier reply card's states, over stubbed reply routes on a real order
// page (review of #396, finding 9): a proposal with lines that need the
// person, a stale and a closed refusal, a reader who may not decide, Edit,
// the reading buttons, and the card in Chinese. Every stubbed card is checked
// against the shared contract first. supplier-replies.spec.ts drives the real
// routes with a scripted reading.

async function signIn(page: Page, request: APIRequestContext) {
  const session = await (await request.post("/api/auth/login", { data: { email: "admin@flowchain.local", name: "Initial Admin", company: "Product Recovery" } })).json();
  await page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, session);
  return { headers: { Authorization: `Bearer ${session.token}` } };
}
async function useLanguage(page: Page, language: "en-US" | "zh-CN") {
  await page.unroute("**/api/me/localization");
  await page.route("**/api/me/localization", async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), languagePreference: language, effectiveLanguage: language } }); });
}
async function anIssuedOrder(request: APIRequestContext, auth: { headers: Record<string, string> }) {
  const list = await (await request.get("/api/purchase-orders-workbench?view=list", auth)).json();
  return (list.purchaseOrders as Array<{ po: string; status: string }>).find((order) => order.status === "issued")!.po;
}

const line = (over: Record<string, unknown> = {}) => ({
  ref: "L1", purchaseOrderLineId: "pol-1", outcome: "proposed", issue: null, currentDate: "2026-11-12", proposedDate: "2026-11-28",
  quote: "Brackets ship 28 November.", dateKind: "stated", readAs: null, readings: null, parts: null,
  sku: "SKU-1040", supplierSku: null, itemName: "Bracket", remaining: 60, unit: "pcs", overdueDays: 5, inferred: false, ...over,
});
const formLine = (id: string, sku: string, currentDate = "2026-11-12") => ({ purchaseOrderLineId: id, sku, supplierSku: null, itemName: null, remaining: 20, unit: "pcs", currentDate, overdueDays: 5 });
function card(orderId: string, over: Record<string, unknown> = {}) {
  const value = {
    contractVersion: SUPPLIER_REPLY_CONTRACT_VERSION, id: "sr-1", purchaseOrderId: orderId, purchaseOrderNumber: "PO-TEST-1", orderVersion: 4, supplierName: "Acme Ltd",
    source: "paste", receivedOn: "2026-11-17", createdAt: "2026-11-17T10:00:00.000Z", state: "proposed", readingStatus: "read", replyKind: "dates",
    text: "Brackets ship 28 November; hinges 03/12.", quotedTextHidden: false, quotedText: null, lines: [line()], flags: [], reason: null, instructionsIgnored: false,
    formLines: [formLine("pol-1", "SKU-1040")], canDecide: true, notNowUntil: null, decision: null, supersededById: null, ...over,
  };
  const parsed = supplierReplyCardSchema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return value;
}
const recorded = (base: Record<string, unknown>) => ({ ...base, state: "recorded", decision: { option: "recorded", reason: null, note: null, decidedById: "u1", decidedAt: "2026-11-19T15:00:00.000Z", editedLines: 1, revisionIds: ["rev-1"] } });

// GET answers `cards`; a POST answers what `post` returns and is recorded.
async function stubReplies(page: Page, cards: () => unknown[], post: (url: string, body: any) => { status: number; json: unknown } = () => ({ status: 500, json: {} })) {
  const posts: Array<{ url: string; body: any }> = [];
  let gets = 0;
  await page.route(/\/api\/procurement\/orders\/[^/]+\/supplier-replies(\/[^/]+\/(record|dismiss|not-now))?$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") { gets += 1; return route.fulfill({ json: { replies: cards() } }); }
    const body = request.postDataJSON();
    posts.push({ url: request.url(), body });
    const answer = post(request.url(), body);
    return route.fulfill({ status: answer.status, json: answer.json });
  });
  return { posts, gets: () => gets };
}

test.describe("the supplier reply card's states", () => {
  test("a proposal whose other line needs a reading waits for it, marks a moved date, then records both", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    // The bracket line is proposed; its date moved to 5 Dec since the reading.
    // The hinge line's 03/12 needs the person.
    const hinge = line({ ref: "L2", purchaseOrderLineId: "pol-2", sku: "SKU-2210", itemName: "Hinge", outcome: "needs_you", issue: "ambiguous_numeric", proposedDate: null, quote: "hinges 03/12", readings: ["2026-12-03", "2027-03-12"] });
    const mixed = card(orderId, { lines: [line(), hinge], formLines: [formLine("pol-1", "SKU-1040", "2026-12-05"), formLine("pol-2", "SKU-2210")] });
    let answer: unknown = mixed;
    const stub = await stubReplies(page, () => [answer], (_url, body) => { answer = recorded(mixed); return { status: 200, json: { reply: answer, purchaseOrder: { id: orderId, version: 5 } } }; });
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await expect(view).toHaveAttribute("data-state", "proposed");
    await expect(view.getByTestId("supplier-reply-moved")).toContainText("Moved to Dec 5, 2026 since the reply was read (was Nov 12, 2026)");
    const question = view.getByTestId("supplier-reply-question");
    await expect(question).toContainText("Hinge");
    await expect(question).toContainText("Day and month could be read either way");
    // Record waits until the hinge line has a date or is left unchanged.
    await expect(view.getByTestId("supplier-reply-record")).toBeDisabled();
    await expect(view.getByTestId("supplier-reply-resolve-first")).toBeVisible();
    await question.getByTestId("supplier-reply-leave").check();
    await expect(view.getByTestId("supplier-reply-record")).toBeEnabled();
    await question.getByTestId("supplier-reply-leave").uncheck();
    await question.getByRole("button", { name: "Use Dec 3, 2026" }).click();
    await view.getByTestId("supplier-reply-record").click();
    await expect(page.getByTestId("supplier-reply-card").first()).toHaveAttribute("data-state", "recorded");
    expect(stub.posts[0].url).toMatch(/\/supplier-replies\/sr-1\/record$/);
    expect(stub.posts[0].body.expectedVersion).toBe(4);
    expect(stub.posts[0].body.lines).toEqual([{ purchaseOrderLineId: "pol-1", promisedDate: "2026-11-28" }, { purchaseOrderLineId: "pol-2", promisedDate: "2026-12-03" }]);
  });

  test("a stale card and a reply no longer open say so, and keep saying it after the reload", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const proposal = card(orderId);
    let refusal = { status: 409, json: { code: "SYNC_VERSION_CONFLICT", message: "Purchase order version does not match.", details: [{ currentVersion: 5 }], currentVersion: 5 } };
    const stub = await stubReplies(page, () => [proposal], () => refusal);
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await view.getByTestId("supplier-reply-record").click();
    const notice = page.getByTestId("supplier-reply-notice");
    await expect(notice).toHaveText("This order changed since the card was shown, so nothing was recorded. The card has been refreshed; check it and try again.");
    // The list was read again, and the card still says why.
    await expect.poll(() => stub.gets()).toBeGreaterThan(1);
    await expect(notice).toBeVisible();
    refusal = { status: 409, json: { code: "SUPPLIER_REPLY_NOT_OPEN", message: "The reply is not open.", details: [{ code: "recorded" }], currentVersion: undefined as never } };
    await page.getByTestId("supplier-reply-card").first().getByTestId("supplier-reply-record").click();
    await expect(notice).toHaveText("This reply was already handled, or a later reply replaced it. The card has been refreshed.");
  });

  test("a reader who may not change the order sees the card, not its buttons or date fields", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const hinge = line({ ref: "L2", purchaseOrderLineId: "pol-2", sku: "SKU-2210", outcome: "needs_you", issue: "ambiguous_numeric", proposedDate: null, quote: "hinges 03/12", readings: ["2026-12-03", "2027-03-12"] });
    await stubReplies(page, () => [card(orderId, { canDecide: false, lines: [line(), hinge], formLines: [formLine("pol-1", "SKU-1040"), formLine("pol-2", "SKU-2210")] })]);
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await expect(view.getByTestId("supplier-reply-proposal")).toBeVisible();
    await expect(view.getByTestId("supplier-reply-view-only")).toBeVisible();
    await expect(view.getByTestId("supplier-reply-actions")).toHaveCount(0);
    await expect(view.locator('input[type="date"]')).toHaveCount(0);
    await expect(view.getByTestId("supplier-reply-readings").getByRole("button").first()).toBeDisabled();
  });

  test("Edit turns the proposed date into a field and records only the changed date", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const proposal = card(orderId);
    const stub = await stubReplies(page, () => [proposal], () => ({ status: 200, json: { reply: recorded(proposal), purchaseOrder: { id: orderId, version: 5 } } }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await view.getByTestId("supplier-reply-edit").click();
    const field = view.locator('[data-testid="supplier-reply-form-line"][data-line="pol-1"] input[type="date"]');
    await expect(field).toHaveValue("2026-11-28");
    await expect(view.getByTestId("supplier-reply-form-quote")).toContainText("Brackets ship 28 November.");
    await field.fill("2026-11-30");
    await view.getByTestId("supplier-reply-record-form").click();
    await expect.poll(() => stub.posts.length).toBe(1);
    expect(stub.posts[0].body.lines).toEqual([{ purchaseOrderLineId: "pol-1", promisedDate: "2026-11-30" }]);
  });

  test("one click picks a 03/12 reading or one of two dates in a sentence; a date that does not match its sentence is typed", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const readings = ["2026-12-03", "2027-03-12"];
    await stubReplies(page, () => [card(orderId, {
      state: "needs_you",
      lines: [
        line({ outcome: "needs_you", issue: "ambiguous_numeric", proposedDate: null, quote: "Brackets 03/12.", readings }),
        line({ ref: "L2", purchaseOrderLineId: "pol-2", sku: "SKU-2210", outcome: "needs_you", issue: "several_dates", proposedDate: null, quote: "Hinges move from 3 December to 12 March.", readings }),
        line({ ref: "L3", purchaseOrderLineId: "pol-3", sku: "SKU-3300", outcome: "needs_you", issue: "date_mismatch", proposedDate: null, quote: "Clips on 4 December.", readings }),
      ],
      formLines: [formLine("pol-1", "SKU-1040"), formLine("pol-2", "SKU-2210"), formLine("pol-3", "SKU-3300")],
    })]);
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    const lineOf = (id: string) => view.locator(`[data-testid="supplier-reply-form-line"][data-line="${id}"]`);
    await expect(lineOf("pol-1").getByTestId("supplier-reply-readings")).toContainText("Day and month could be read either way");
    await expect(lineOf("pol-1").getByTestId("supplier-reply-readings").getByRole("button")).toHaveCount(2);
    await expect(lineOf("pol-2").getByTestId("supplier-reply-readings")).toContainText("The sentence names two dates. Which is the new one?");
    await expect(lineOf("pol-2").getByTestId("supplier-reply-readings").getByRole("button")).toHaveCount(2);
    await expect(lineOf("pol-3").getByTestId("supplier-reply-readings")).toHaveCount(0);
    await expect(lineOf("pol-3")).toContainText("the date does not match its sentence");
  });

  test("in Chinese the card's words translate; the supplier's sentence and the record values stay as written", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "zh-CN");
    const orderId = await anIssuedOrder(request, auth);
    await stubReplies(page, () => [card(orderId, { flags: [{ kind: "other_order", quote: "PO-TEST-2 ships with it.", orderNumber: "PO-TEST-2" }] })]);
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await expect(view.getByTestId("supplier-reply-proposal")).toContainText("建议交期");
    await expect(view.getByTestId("supplier-reply-record")).toHaveText("记录新交期");
    await expect(view.getByTestId("supplier-reply-proposal")).toContainText("Brackets ship 28 November.");
    await expect(view.getByTestId("supplier-reply-proposal")).toContainText("SKU-1040");
    // Another order the reply names links to it.
    await expect(view.getByTestId("supplier-reply-other-order")).toHaveAttribute("href", "/app/procurement/orders/PO-TEST-2");
  });
});
