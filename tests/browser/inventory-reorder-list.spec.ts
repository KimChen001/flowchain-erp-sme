import { expect, test, type Page } from "@playwright/test";
import { buildReorderList } from "../../server/domain/reorder-list.mjs";

// The reorder list page over a list the real rules build: rows ranked by
// order-by date with their inputs and flags, the items without a reorder
// point, the supplier filter, and the purchase request it opens prefilled.

const TODAY = "2026-10-05";
const shipments = (itemId: string, days: number, quantity: number) =>
  Array.from({ length: days }, (_, index) => ({ itemId, unit: "pcs", quantity, postedAt: new Date(Date.parse(`${TODAY}T15:00:00Z`) - (index + 1) * 86400000).toISOString() }));

const list = buildReorderList({
  today: TODAY,
  timeZone: "America/New_York",
  items: [
    { id: "ITEM-A", sku: "RL-A", name: "Valve", unit: "pcs", reorderPoint: 100, metadata: {}, preferredSupplierId: "SUP-1", status: "active" },
    { id: "ITEM-B", sku: "RL-B", name: "Gasket", unit: "pcs", reorderPoint: null, metadata: {}, preferredSupplierId: null, status: "active" },
    { id: "ITEM-C", sku: "RL-C", name: "Seal", unit: "pcs", reorderPoint: 20, metadata: {}, preferredSupplierId: null, status: "active" },
  ],
  allocationRows: [
    { sku: "RL-A", onHand: 110, reserved: 10, incomingLines: [{ purchaseOrderId: "PO-0039", orderNumber: "PO-0039", lineId: "L1", remaining: 30, dueDay: "2026-10-08" }], incomingExcluded: [{ purchaseOrderId: "PO-0040", orderNumber: "PO-0040", lineId: "L2", unit: "CASE", remaining: 5 }], dataLimitations: [] },
    { sku: "RL-B", onHand: 1, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [] },
    { sku: "RL-C", onHand: 5, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [] },
  ],
  shipmentLines: shipments("ITEM-A", 8, 9),
  supplierLinks: [{ id: "r1", payload: { itemId: "ITEM-A", supplierId: "SUP-1", preferred: true, leadTimeDays: 10 } }],
  suppliers: [{ id: "SUP-1", code: "S1", name: "Reorder Supply", status: "active" }],
});

async function open(page: Page, language = "en-US", payload: unknown = { ...list, dataLimitations: ["transfers_not_considered"] }) {
  const response = await page.request.post("/api/auth/login", { data: { email: "manager@example.com", name: "Ignored", company: "Ignored" } });
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({ json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: language, timezone: "America/New_York" } }));
  await page.route("**/api/inventory/reorder-list", (route) => route.fulfill({ json: payload }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  await page.goto("/app/inventory/reorder");
}

test("the reorder list ranks by order-by date and prints every input, in English", async ({ page }) => {
  await open(page);
  const pageRoot = page.getByTestId("reorder-list-page");
  await expect(pageRoot.getByRole("heading", { name: "Reorder list" })).toBeVisible();
  await expect(page.getByTestId("reorder-list-scope")).toContainText("All warehouses; transfers not considered");
  await expect(page.getByTestId("reorder-list-horizon")).toContainText("due after an item's order-by date are not counted");
  await expect(page.getByTestId("reorder-list-no-reorder-point")).toContainText("1 item has no reorder point");
  await expect(page.getByTestId("reorder-list-no-reorder-point").getByRole("link", { name: "Set it" })).toHaveAttribute("href", "/app/master-data/items");

  const rows = pageRoot.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-testid", "reorder-row-RL-C");
  await expect(rows.nth(1)).toHaveAttribute("data-testid", "reorder-row-RL-A");
  const c = page.getByTestId("reorder-row-RL-C");
  await expect(c.getByTestId("reorder-order-by")).toContainText("Order now");
  await expect(c.getByTestId("reorder-demand")).toContainText("Not enough shipment history (0 days)");
  await expect(c.getByTestId("reorder-supplier")).toContainText("Not recorded");
  const a = page.getByTestId("reorder-row-RL-A");
  await expect(a.getByTestId("reorder-order-by")).toContainText("Nov 11, 2026");
  await expect(a.getByTestId("reorder-order-by")).toContainText("in 37 days");
  await expect(a).toContainText("110 pcs");
  await expect(a).toContainText("130 pcs");
  await expect(a.getByTestId("reorder-demand")).toContainText("0.8 pcs");
  await expect(a.getByTestId("reorder-demand")).toContainText("8 shipment days in 90");
  await expect(a.getByTestId("reorder-flags")).toContainText("PO-0040 in CASE, not counted");
  await expect(a.getByTestId("reorder-supplier")).toContainText("Lead time 10 days");
  await expect(a.getByTestId("reorder-supplier")).toContainText("MOQ not recorded");
  await expect(pageRoot).not.toContainText(/[㐀-鿿]/);

  // The supplier filter keeps only that supplier's items.
  await page.getByTestId("reorder-list-supplier-filter").selectOption("SUP-1");
  await expect(rows).toHaveCount(1);
  await expect(page).toHaveURL(/supplier=SUP-1/);
});

test("Create purchase request opens the prefilled form; nothing is submitted", async ({ page }) => {
  await open(page);
  const link = page.getByTestId("reorder-create-request-RL-C");
  const href = new URL((await link.getAttribute("href"))!, "http://local");
  expect(href.pathname).toBe("/app/procurement/requests");
  expect(href.searchParams.get("itemId")).toBe("ITEM-C");
  expect(href.searchParams.get("quantity")).toBe("15");
  expect(href.searchParams.get("origin")).toBe("reorder_list");
  expect(href.searchParams.get("reason")).toContain("order by 2026-10-05");
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/procurement")) posts.push(request.url()); });
  await link.click();
  await expect(page).toHaveURL(/\/app\/procurement\/requests\?/);
  expect(posts).toEqual([]);
});

test("the reorder list is available in Chinese and says when nothing needs ordering", async ({ page }) => {
  await open(page, "zh-CN");
  await expect(page.getByTestId("reorder-list-page").getByRole("heading", { name: "补货清单" })).toBeVisible();
  await expect(page.getByTestId("reorder-row-RL-C")).toContainText("立即下单");
  await page.unrouteAll();
  await open(page, "en-US", { ...list, rows: [], suppliers: [], summary: { ...list.summary, listed: 0, orderNow: 0 } });
  await expect(page.getByTestId("reorder-list-empty")).toContainText("No items to reorder");
});

test("the inventory warnings page links to the reorder list", async ({ page }) => {
  await open(page);
  await page.goto("/app/inventory/warnings");
  await page.getByTestId("inventory-warnings-reorder-link").click();
  await expect(page).toHaveURL(/\/app\/inventory\/reorder$/);
});
