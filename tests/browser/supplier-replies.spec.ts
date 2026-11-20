import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Supplier replies on an issued order (docs/supplier-reply-dates-design.md,
// step 1b): paste the supplier's answer, read the card, record the new date.
// The reading is scripted on the server (FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED,
// set by scripts/run-product-recovery-playwright.mjs): no model is called.
// The phase also requires the workspace's AI switch
// (FLOWCHAIN_AI_WORKSPACE_OPT_IN=required), so switching it off in Settings
// leaves the reply unread.
// Runs on the product-recovery walkthrough data.

const SCRIPTED = process.env.FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED || "";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function signIn(page: Page, request: APIRequestContext) {
  const login = await request.post("/api/auth/login", { data: { email: "admin@flowchain.local", name: "Initial Admin", company: "Product Recovery" } });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  return { headers: { Authorization: `Bearer ${session.token}` } };
}

// The interface language, whatever the walkthrough admin chose: the page
// reads it from /api/me/localization; locale and timezone stay the workspace's.
async function useLanguage(page: Page, language: "en-US" | "zh-CN") {
  await page.unroute("**/api/me/localization");
  await page.route("**/api/me/localization", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), languagePreference: language, effectiveLanguage: language } });
  });
}

async function setAi(request: APIRequestContext, auth: { headers: Record<string, string> }, on: boolean) {
  const ai = (await (await request.get("/api/settings-runtime", auth)).json()).ai;
  expect((await request.patch("/api/settings-runtime/ai", { ...auth, data: { settings: { ...ai, modelAssistEnabled: on } } })).status()).toBe(200);
}

type OrderLine = { id: string; sku: string | null; orderedQuantity: string | null; receivedQuantity: string | null; promisedDate: string | null };
// An issued order with an open line, and that line's reference in the reading
// (L1, L2, ... in the order's line order, as the server numbers them).
async function issuedOrderWithOpenLine(request: APIRequestContext, auth: { headers: Record<string, string> }, skip: string[] = []) {
  const list = await (await request.get("/api/purchase-orders-workbench?view=list", auth)).json();
  for (const order of list.purchaseOrders as Array<{ po: string; status: string }>) {
    if (order.status !== "issued" || skip.includes(order.po)) continue;
    const detail = await (await request.get(`/api/procurement/orders/${encodeURIComponent(order.po)}`, auth)).json();
    const lines = (detail.lines || []) as OrderLine[];
    const at = lines.findIndex((line) => Number(line.orderedQuantity || 0) > Number(line.receivedQuantity || 0));
    if (at >= 0) return { id: order.po as string, number: String(detail.orderNumber || detail.number || order.po), line: lines[at], ref: `L${at + 1}`, version: Number(detail.version) };
  }
  throw new Error("No issued order with an open line in the walkthrough data.");
}

// The workspace's today and a day some weeks later, not the line's current date.
async function workspaceDays(request: APIRequestContext, auth: { headers: Record<string, string> }, current: string | null) {
  const { timezone } = await (await request.get("/api/me/localization", auth)).json();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "America/New_York" }).format(new Date());
  const day = (offset: number) => { const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
  const next = day(21) === current ? day(22) : day(21);
  return { today, next };
}
const written = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const shown = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${day}T12:00:00Z`));

test.describe("supplier replies on an issued order", () => {
  test("a pasted reply proposes the date it states, flags the price, hides the quoted chase, and records as proposed", async ({ page, request }) => {
    test.skip(!SCRIPTED, "needs FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED (run-product-recovery-playwright.mjs)");
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    await setAi(request, auth, true);
    try {
      const order = await issuedOrderWithOpenLine(request, auth);
      const { next } = await workspaceDays(request, auth, order.line.promisedDate);
      const said = `We can ship the balance on ${written(next)}.`;
      writeFileSync(SCRIPTED, JSON.stringify({ readings: [{ match: "We can ship the balance", reading: { replyKind: "dates", lines: [{ line: order.ref, date: next, quote: said, dateKind: "stated" }], flags: [{ kind: "price_change", quote: "Unit price rises 4% from next month." }], reason: null } }] }));

      await page.goto(`/app/procurement/orders/${encodeURIComponent(order.id)}`);
      const section = page.getByTestId("supplier-replies");
      await section.getByTestId("supplier-reply-open").click();
      await section.getByTestId("supplier-reply-paste-text").fill(`Hello,\n\n${said} Unit price rises 4% from next month.\n\nBest regards,\nSam\n\nOn Mon, Nov 16, 2026 at 9:00 AM Buyer wrote:\n> When will ${order.number} ship? It was promised for ${order.line.promisedDate}.`);
      await section.getByTestId("supplier-reply-read").click();

      // The proposal: the line now and proposed, with the supplier's sentence.
      const card = section.getByTestId("supplier-reply-card").first();
      await expect(card).toHaveAttribute("data-state", "proposed");
      const line = card.getByTestId("supplier-reply-line").first();
      await expect(line.getByTestId("supplier-reply-proposed-date")).toHaveText(shown(next));
      await expect(line).toContainText(said);
      await expect(card.getByTestId("supplier-reply-flags")).toContainText("Price change");
      // Our quoted chase, with the old date in it, was set aside and not read.
      await card.getByTestId("supplier-reply-toggle").click();
      await expect(card.getByTestId("supplier-reply-text")).not.toContainText("When will");
      await card.getByTestId("supplier-reply-quoted").getByRole("button", { name: "Show" }).click();
      await expect(card.getByTestId("supplier-reply-quoted-text")).toContainText(`When will ${order.number} ship?`);

      // Record: the promised date moves, with the supplier's sentence as the reason.
      await card.getByTestId("supplier-reply-record").click();
      await expect(section.getByTestId("supplier-reply-card").first()).toHaveAttribute("data-state", "recorded");
      await expect(section.getByTestId("supplier-reply-recorded")).toBeVisible();
      const after = await (await request.get(`/api/procurement/orders/${encodeURIComponent(order.id)}`, auth)).json();
      expect(after.lines.find((entry: OrderLine) => entry.id === order.line.id).promisedDate).toBe(next);
      expect(after.promiseRevisions.at(-1).reason).toContain(said);
      await expect(page.getByTestId("po-promise-history")).toContainText(said);
    } finally {
      await setAi(request, auth, false);
    }
  });

  test("a chased overdue order on Today takes the reply, and a wrong reading is not recorded, with its reason", async ({ page, request }) => {
    test.skip(!SCRIPTED, "needs FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED (run-product-recovery-playwright.mjs)");
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    await setAi(request, auth, true);
    try {
      // An overdue order waiting on Today, chased.
      const overview = await (await request.get("/api/home/overview", auth)).json();
      const item = (overview.decisions?.waiting || []).find((entry: { row: { kind: string; detail?: { notIssued?: boolean } } }) => entry.row.kind === "purchase_order_overdue" && !entry.row.detail?.notIssued);
      test.skip(!item, "no overdue order waits on Today in this data");
      expect((await request.post("/api/decision-items/decide", { ...auth, data: { key: item.key, option: "chased" } })).status()).toBe(200);
      const detail = await (await request.get(`/api/procurement/orders/${encodeURIComponent(item.row.recordId)}`, auth)).json();
      const at = (detail.lines as OrderLine[]).findIndex((line) => Number(line.orderedQuantity || 0) > Number(line.receivedQuantity || 0));
      const { next } = await workspaceDays(request, auth, detail.lines[at].promisedDate);
      const said = `Balance follows on ${written(next)}.`;
      writeFileSync(SCRIPTED, JSON.stringify({ readings: [{ match: "Balance follows on", reading: { replyKind: "dates", lines: [{ line: `L${at + 1}`, date: next, quote: said, dateKind: "stated" }], flags: [], reason: null } }] }));

      await page.goto("/app/overview");
      const aside = page.getByTestId("today-set-aside");
      await aside.getByRole("button").first().click();
      const entry = aside.getByTestId("today-set-aside-item").filter({ hasText: item.row.label });
      await entry.getByTestId("supplier-reply-open").click();
      await entry.getByTestId("supplier-reply-paste-text").fill(`Hi,\n${said}\nThanks`);
      await entry.getByTestId("supplier-reply-read").click();
      const card = entry.getByTestId("supplier-reply-card");
      await expect(card).toHaveAttribute("data-state", "proposed");
      // The box closes behind the open card; a newer reply can still be pasted.
      await expect(entry.getByTestId("supplier-reply-paste")).toHaveCount(0);
      await expect(entry.getByTestId("supplier-reply-paste-again")).toBeVisible();

      await card.getByTestId("supplier-reply-dont-record").click();
      const form = card.getByTestId("supplier-reply-dismiss-form");
      await form.locator("select").selectOption("other");
      await expect(form.getByTestId("supplier-reply-dismiss-save")).toBeDisabled();
      await form.getByRole("textbox").fill("Agreed a different date by phone.");
      await form.getByTestId("supplier-reply-dismiss-save").click();
      // The decided card stays in view with its reason; nothing was recorded.
      await expect(entry.getByTestId("supplier-reply-card")).toHaveAttribute("data-state", "not_recorded");
      await expect(entry.getByTestId("supplier-reply-not-recorded")).toContainText("Other");
      await expect(entry.getByTestId("supplier-reply-not-recorded")).toContainText("Agreed a different date by phone.");
      const after = await (await request.get(`/api/procurement/orders/${encodeURIComponent(item.row.recordId)}`, auth)).json();
      expect(after.lines[at].promisedDate).toBe(detail.lines[at].promisedDate);
    } finally {
      await setAi(request, auth, false);
    }
  });

  test("with AI off the reply is kept and the person enters the date beside it, in English and in Chinese", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    await setAi(request, auth, false);
    const order = await issuedOrderWithOpenLine(request, auth);
    const { next } = await workspaceDays(request, auth, order.line.promisedDate);
    const said = `The rest should be with you around ${written(next)}.`;

    await page.goto(`/app/procurement/orders/${encodeURIComponent(order.id)}`);
    const section = page.getByTestId("supplier-replies");
    await section.getByTestId("supplier-reply-open").click();
    await section.getByTestId("supplier-reply-paste-text").fill(said);
    await section.getByTestId("supplier-reply-read").click();
    const card = section.getByTestId("supplier-reply-card").first();
    await expect(card).toHaveAttribute("data-reading", "ai_off");
    await expect(card.getByTestId("supplier-reply-outage")).toContainText("AI is off for this workspace");
    await expect(card.getByTestId("supplier-reply-text")).toContainText(said);
    // Nothing was proposed, so recording needs a date the person entered.
    await card.getByTestId("supplier-reply-record-form").click();
    await expect(card.getByTestId("supplier-reply-message")).toHaveText("Enter at least one date that differs from the current one.");
    await card.locator(`[data-testid="supplier-reply-form-line"][data-line="${order.line.id}"] input[type="date"]`).fill(next);
    await card.getByTestId("supplier-reply-record-form").click();
    await expect(section.getByTestId("supplier-reply-card").first()).toHaveAttribute("data-state", "recorded");
    const after = await (await request.get(`/api/procurement/orders/${encodeURIComponent(order.id)}`, auth)).json();
    expect(after.lines.find((entry: OrderLine) => entry.id === order.line.id).promisedDate).toBe(next);

    // The same card in Chinese: its words translate, the supplier's stay as written.
    await useLanguage(page, "zh-CN");
    await page.reload();
    const chinese = page.getByTestId("supplier-replies");
    await expect(chinese).toContainText("供应商回复");
    await expect(chinese.getByTestId("supplier-reply-recorded")).toContainText("已于");
    await chinese.getByTestId("supplier-reply-toggle").first().click();
    await expect(chinese.getByTestId("supplier-reply-text").first()).toContainText(said);
  });
});

// A chased overdue order whose reply is an out-of-office: Today shows the
// reply just pasted, "nothing to record", instead of clearing the box
// (review finding 4).
test("Today shows an auto-reply pasted on a chased order as nothing to record", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED (run-product-recovery-playwright.mjs)");
  const auth = await signIn(page, request);
  await useLanguage(page, "en-US");
  await setAi(request, auth, true);
  try {
    const overview = await (await request.get("/api/home/overview", auth)).json();
    const item = (overview.decisions?.waiting || []).filter((entry: { row: { kind: string; detail?: { notIssued?: boolean } } }) => entry.row.kind === "purchase_order_overdue" && !entry.row.detail?.notIssued).at(-1);
    test.skip(!item, "no overdue order waits on Today in this data");
    expect((await request.post("/api/decision-items/decide", { ...auth, data: { key: item.key, option: "chased" } })).status()).toBe(200);
    writeFileSync(SCRIPTED, JSON.stringify({ readings: [{ match: "out of the office", reading: { replyKind: "auto_reply", lines: [], flags: [], reason: null } }] }));
    await page.goto("/app/overview");
    const aside = page.getByTestId("today-set-aside");
    await aside.getByRole("button").first().click();
    const entry = aside.getByTestId("today-set-aside-item").filter({ hasText: item.row.label });
    await entry.getByTestId("supplier-reply-open").click();
    await entry.getByTestId("supplier-reply-paste-text").fill("I am out of the office until Monday and will reply then.");
    await entry.getByTestId("supplier-reply-read").click();
    await expect(entry.getByTestId("supplier-reply-card")).toHaveAttribute("data-state", "nothing_to_record");
    await expect(entry.getByTestId("supplier-reply-nothing")).toBeVisible();
    await expect(entry.getByTestId("supplier-reply-paste")).toHaveCount(0);
  } finally {
    await setAi(request, auth, false);
  }
});
