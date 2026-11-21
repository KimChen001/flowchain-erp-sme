import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { SUPPLIER_REPLY_CONTRACT_VERSION, supplierReplyCardSchema } from "../../shared/supplier-reply-contract.mjs";
import { SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, supplierReplyStockResponseSchema } from "../../shared/supplier-reply-stock-contract.mjs";

// The supplier reply card's stock line (docs/supplier-reply-dates-design.md
// §4.6) on a real order page, over stubbed reply and stock reads, each checked
// against its shared contract: the line names what the dates being recorded
// do to stock, reads again when an open question is answered (not while a
// date is unfinished or past), and is left out when nothing changes,
// inventory is hidden or the read fails. Dates are counted from today, as the
// card reads no date before it.

async function signIn(page: Page, request: APIRequestContext) {
  const session = await (await request.post("/api/auth/login", { data: { email: "admin@flowchain.local", name: "Initial Admin", company: "Product Recovery" } })).json();
  await page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, session);
  return { headers: { Authorization: `Bearer ${session.token}` } };
}
async function useLanguage(page: Page, language: "en-US" | "zh-CN") {
  await page.unroute("**/api/me/localization");
  await page.route("**/api/me/localization", async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), languagePreference: language, effectiveLanguage: language, locale: "en-US" } }); });
}
async function anIssuedOrder(request: APIRequestContext, auth: { headers: Record<string, string> }) {
  const list = await (await request.get("/api/purchase-orders-workbench?view=list", auth)).json();
  return (list.purchaseOrders as Array<{ po: string; status: string }>).find((order) => order.status === "issued")!.po;
}
// Days from today (UTC; far enough ahead to be after the workspace's today),
// and how the card writes them in the en-US format.
const plus = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const shown = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const NEW_DATE = plus(8);

const line = (over: Record<string, unknown> = {}) => ({
  ref: "L1", purchaseOrderLineId: "pol-1", outcome: "proposed", issue: null, currentDate: plus(-8), proposedDate: NEW_DATE,
  quote: "Brackets ship in eight days.", dateKind: "stated", readAs: null, readings: null, parts: null,
  sku: "SKU-1040", supplierSku: null, itemName: "Bracket", remaining: 60, unit: "pcs", overdueDays: 5, inferred: false, ...over,
});
const formLine = (id: string, sku: string) => ({ purchaseOrderLineId: id, sku, supplierSku: null, itemName: null, remaining: 20, unit: "pcs", currentDate: plus(-8), overdueDays: 5 });
function card(orderId: string, over: Record<string, unknown> = {}) {
  const value = {
    contractVersion: SUPPLIER_REPLY_CONTRACT_VERSION, id: "sr-1", purchaseOrderId: orderId, purchaseOrderNumber: "PO-TEST-1", orderVersion: 4, supplierName: "Acme Ltd",
    source: "paste", receivedOn: plus(-3), createdAt: new Date().toISOString(), state: "proposed", readingStatus: "read", replyKind: "dates",
    text: "Brackets ship in eight days; hinges 03/12.", quotedTextHidden: false, quotedText: null, lines: [line()], flags: [], reason: null, instructionsIgnored: false,
    formLines: [formLine("pol-1", "SKU-1040")], canDecide: true, notNowUntil: null, decision: null, supersededById: null, ...over,
  };
  const parsed = supplierReplyCardSchema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return value;
}
const effect = (over: Record<string, unknown> = {}) => ({ sku: "SKU-1040", itemName: "Bracket", unit: "pcs", kind: "below_reorder_point", from: plus(4), outOfStockFrom: null, newDate: NEW_DATE, basis: "recorded_rate", reorderPoint: 100, beyondAYear: false, ...over });
function stock(effects: unknown[], over: Record<string, unknown> = {}) {
  const value = { contractVersion: SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, asOf: plus(0), available: true, reason: null, effects, ...over };
  const parsed = supplierReplyStockResponseSchema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return value;
}
// The reply list answers `cards`; the stock read answers `answer` and records
// the dates it was asked with.
async function stub(page: Page, cards: unknown[], answer: () => { status?: number; json: unknown }) {
  await page.route(/\/api\/procurement\/orders\/[^/]+\/supplier-replies$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { replies: cards } }) : route.fallback()));
  const asked: string[] = [];
  await page.route(/\/api\/procurement\/orders\/[^/]+\/supplier-replies\/[^/]+\/stock(\?.*)?$/, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("dates") || "");
    const { status = 200, json } = answer();
    return route.fulfill({ status, json });
  });
  return asked;
}
// The read has settled with nothing to show.
const settledEmpty = (view: Locator, state: "none" | "failed") => expect(view.getByTestId("supplier-reply-stock-read")).toHaveAttribute("data-state", state);

test.describe("the supplier reply card's stock line", () => {
  test("a proposed card names what its dates do to stock, with how it was projected", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const asked = await stub(page, [card(orderId)], () => ({ json: stock([
      effect({ sku: "SKU-2210", itemName: null, kind: "short", from: plus(5), basis: "open_sales_orders" }),
      effect({ outOfStockFrom: plus(6) }),
      effect({ sku: "SKU-3300", itemName: null }),
    ]) }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    const stockLine = view.getByTestId("supplier-reply-stock");
    await expect(stockLine).toHaveAttribute("data-state", "shown");
    await expect(stockLine).toContainText("Stock:");
    // Below the reorder point first and out of stock later: both are named.
    await expect(stockLine.getByTestId("supplier-reply-stock-effect")).toHaveText([
      `SKU-2210 is out of stock from ${shown(plus(5))}, before this delivery on ${shown(NEW_DATE)}.`,
      `SKU-1040 · Bracket is below its reorder point from ${shown(plus(4))} and out of stock from ${shown(plus(6))}, before this delivery on ${shown(NEW_DATE)}.`,
      `SKU-3300 is below its reorder point from ${shown(plus(4))}, before this delivery on ${shown(NEW_DATE)}.`,
    ]);
    await expect(stockLine.getByTestId("supplier-reply-stock-effect").first()).toHaveAttribute("title", /open sales orders on the days promised to customers/);
    await expect(stockLine.getByTestId("supplier-reply-stock-effect").last()).toHaveAttribute("title", /average shipped per day over the last 90 days/);
    // Asked with the proposal's dates.
    expect(asked).toEqual([`pol-1:${NEW_DATE}`]);
  });

  test("answering an open question reads the stock again with that date, not while the date is unfinished or past", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const readings = [plus(13), plus(110)];
    const hinge = line({ ref: "L2", purchaseOrderLineId: "pol-2", sku: "SKU-2210", itemName: "Hinge", outcome: "needs_you", issue: "ambiguous_numeric", proposedDate: null, quote: "hinges 03/12", readings });
    const asked = await stub(page, [card(orderId, { lines: [line(), hinge], formLines: [formLine("pol-1", "SKU-1040"), formLine("pol-2", "SKU-2210")] })], () => ({ json: stock([effect()]) }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    const stockLine = view.getByTestId("supplier-reply-stock");
    await expect(stockLine).toHaveAttribute("data-state", "shown");
    expect(asked).toEqual([`pol-1:${NEW_DATE}`]);
    // A year being typed (0002) is not read, and the line, which no longer
    // speaks for the card's dates, is hidden meanwhile.
    await view.getByTestId("supplier-reply-question").locator('input[type="date"]').fill("0002-12-03");
    await expect(view.getByTestId("supplier-reply-stock-read")).toHaveAttribute("data-state", "waiting");
    await expect(stockLine).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(asked).toEqual([`pol-1:${NEW_DATE}`]);
    // A reading picked: read with it.
    await view.getByTestId("supplier-reply-readings").getByRole("button").first().click();
    await expect.poll(() => asked.at(-1)).toBe(`pol-1:${NEW_DATE},pol-2:${readings[0]}`);
    await expect(stockLine).toHaveAttribute("data-state", "shown");
    await expect(stockLine).not.toHaveClass(/opacity-50/);
  });

  test("nothing changes, inventory hidden, or a failed read: no stock line, the card as before", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    let answer: { status?: number; json: unknown } = { json: stock([]) };
    await stub(page, [card(orderId)], () => answer);
    const cases: Array<[{ status?: number; json: unknown }, "none" | "failed"]> = [
      [{ json: stock([]) }, "none"],
      [{ json: stock([], { available: false, reason: "inventory_hidden" }) }, "none"],
      [{ status: 500, json: { code: "BOOM", message: "No." } }, "failed"],
      [{ json: { ...stock([effect()]), extra: true } }, "failed"],
    ];
    for (const [next, state] of cases) {
      answer = next;
      await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
      const view = page.getByTestId("supplier-reply-card").first();
      await expect(view.getByTestId("supplier-reply-proposal")).toBeVisible();
      // Settled first, then nothing shown.
      await settledEmpty(view, state);
      await expect(view.getByTestId("supplier-reply-stock")).toHaveCount(0);
      await expect(view.getByTestId("supplier-reply-record")).toBeEnabled();
    }
  });

  test("in Chinese the line translates; the SKU and the dates stay in the workspace's format; more than three items are counted", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "zh-CN");
    const orderId = await anIssuedOrder(request, auth);
    const effects = ["A", "B", "C", "D", "E"].map((letter) => effect({ sku: `SKU-${letter}`, itemName: null }));
    effects[0] = effect({ sku: "SKU-A", itemName: null, beyondAYear: true, newDate: plus(400) });
    await stub(page, [card(orderId, { lines: [line({ proposedDate: plus(400) })] })], () => ({ json: stock(effects) }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const stockLine = page.getByTestId("supplier-reply-card").first().getByTestId("supplier-reply-stock");
    await expect(stockLine).toContainText("库存：");
    await expect(stockLine.getByTestId("supplier-reply-stock-effect")).toHaveCount(3);
    await expect(stockLine.getByTestId("supplier-reply-stock-effect").first()).toHaveText(`SKU-A 自 ${shown(plus(4))} 起低于再订货点，早于本次交货日 ${shown(plus(400))}。 新交期在一年以后，推算只覆盖未来一年。`);
    await expect(stockLine.getByTestId("supplier-reply-stock-more")).toHaveText("另有 2 个物料受影响。");
  });
});
