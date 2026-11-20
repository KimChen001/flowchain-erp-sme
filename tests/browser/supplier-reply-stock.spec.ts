import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SUPPLIER_REPLY_CONTRACT_VERSION, supplierReplyCardSchema } from "../../shared/supplier-reply-contract.mjs";
import { SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, supplierReplyStockResponseSchema } from "../../shared/supplier-reply-stock-contract.mjs";

// The supplier reply card's stock line (docs/supplier-reply-dates-design.md
// §4.6) on a real order page, over stubbed reply and stock reads, each checked
// against its shared contract: the line names what the dates being recorded
// do to stock, reads again when an open question is answered, and is left out
// when nothing changes, inventory is hidden or the read fails.

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

const line = (over: Record<string, unknown> = {}) => ({
  ref: "L1", purchaseOrderLineId: "pol-1", outcome: "proposed", issue: null, currentDate: "2026-11-12", proposedDate: "2026-11-28",
  quote: "Brackets ship 28 November.", dateKind: "stated", readAs: null, readings: null, parts: null,
  sku: "SKU-1040", supplierSku: null, itemName: "Bracket", remaining: 60, unit: "pcs", overdueDays: 5, inferred: false, ...over,
});
const formLine = (id: string, sku: string) => ({ purchaseOrderLineId: id, sku, supplierSku: null, itemName: null, remaining: 20, unit: "pcs", currentDate: "2026-11-12", overdueDays: 5 });
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
const effect = (over: Record<string, unknown> = {}) => ({ sku: "SKU-1040", itemName: "Bracket", unit: "pcs", kind: "below_reorder_point", from: "2026-11-24", newDate: "2026-11-28", basis: "recorded_rate", reorderPoint: 100, ...over });
function stock(effects: unknown[], over: Record<string, unknown> = {}) {
  const value = { contractVersion: SUPPLIER_REPLY_STOCK_CONTRACT_VERSION, asOf: "2026-11-20", available: true, reason: null, effects, ...over };
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

test.describe("the supplier reply card's stock line", () => {
  test("a proposed card names what its dates do to stock, with how it was projected", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const asked = await stub(page, [card(orderId)], () => ({ json: stock([effect(), effect({ sku: "SKU-2210", itemName: null, kind: "short", from: "2026-11-25", basis: "open_sales_orders" })]) }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    const line = view.getByTestId("supplier-reply-stock");
    await expect(line).toContainText("Stock:");
    await expect(line.getByTestId("supplier-reply-stock-effect")).toHaveText([
      "SKU-1040 · Bracket falls below its reorder point from Nov 24, 2026, before this delivery on Nov 28, 2026.",
      "SKU-2210 runs out from Nov 25, 2026, before this delivery on Nov 28, 2026.",
    ]);
    await expect(line.getByTestId("supplier-reply-stock-effect").first()).toHaveAttribute("title", /average shipped per day over the last 90 days/);
    await expect(line.getByTestId("supplier-reply-stock-effect").last()).toHaveAttribute("title", /open sales orders on the days promised to customers/);
    // Asked with the proposal's dates.
    expect(asked).toEqual(["pol-1:2026-11-28"]);
  });

  test("answering an open question reads the stock again with that date", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    const hinge = line({ ref: "L2", purchaseOrderLineId: "pol-2", sku: "SKU-2210", itemName: "Hinge", outcome: "needs_you", issue: "ambiguous_numeric", proposedDate: null, quote: "hinges 03/12", readings: ["2026-12-03", "2027-03-12"] });
    const asked = await stub(page, [card(orderId, { lines: [line(), hinge], formLines: [formLine("pol-1", "SKU-1040"), formLine("pol-2", "SKU-2210")] })], () => ({ json: stock([effect()]) }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await expect(view.getByTestId("supplier-reply-stock")).toBeVisible();
    expect(asked).toEqual(["pol-1:2026-11-28"]);
    await view.getByTestId("supplier-reply-readings").getByRole("button").first().click();
    await expect.poll(() => asked.at(-1)).toBe("pol-1:2026-11-28,pol-2:2026-12-03");
  });

  test("nothing changes, inventory hidden, or a failed read: no stock line, the card as before", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const orderId = await anIssuedOrder(request, auth);
    let answer: { status?: number; json: unknown } = { json: stock([]) };
    const asked = await stub(page, [card(orderId)], () => answer);
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const view = page.getByTestId("supplier-reply-card").first();
    await expect(view.getByTestId("supplier-reply-proposal")).toBeVisible();
    await expect.poll(() => asked.length).toBe(1);
    await expect(view.getByTestId("supplier-reply-stock")).toHaveCount(0);
    for (const next of [{ json: stock([], { available: false, reason: "inventory_hidden" }) }, { status: 500, json: { code: "BOOM", message: "No." } }, { json: { ...stock([effect()]), extra: true } }]) {
      answer = next;
      await page.reload();
      await expect(view.getByTestId("supplier-reply-proposal")).toBeVisible();
      await expect.poll(() => asked.length).toBeGreaterThan(1);
      await expect(view.getByTestId("supplier-reply-stock")).toHaveCount(0);
      await expect(view.getByTestId("supplier-reply-record")).toBeEnabled();
      asked.length = 1;
    }
  });

  test("in Chinese the line translates; the SKU and the dates stay in the workspace's format; more than three items are counted", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "zh-CN");
    const orderId = await anIssuedOrder(request, auth);
    const effects = ["A", "B", "C", "D", "E"].map((letter) => effect({ sku: `SKU-${letter}`, itemName: null }));
    await stub(page, [card(orderId)], () => ({ json: stock(effects) }));
    await page.goto(`/app/procurement/orders/${encodeURIComponent(orderId)}`);
    const line = page.getByTestId("supplier-reply-card").first().getByTestId("supplier-reply-stock");
    await expect(line).toContainText("库存：");
    await expect(line.getByTestId("supplier-reply-stock-effect")).toHaveCount(3);
    await expect(line.getByTestId("supplier-reply-stock-effect").first()).toHaveText("SKU-A 将自 Nov 24, 2026 起低于再订货点，早于本次交货日 Nov 28, 2026。");
    await expect(line.getByTestId("supplier-reply-stock-more")).toHaveText("另有 2 个物料受影响。");
  });
});
