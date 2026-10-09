import { expect, test, type Page } from "@playwright/test";
import { buildReorderList } from "../../server/domain/reorder-list.mjs";

// The reorder list page over a list the real rules build: rows ranked by
// order-by date with their inputs and flags, the items without a reorder
// point, the supplier filter, the purchase request it opens prefilled, and a
// reader of only some warehouses, for whom nothing is checked.
// Runs with the settings suite (scripts/run-settings-playwright.mjs), whose
// API seeds manager@example.com; the reorder list itself is stubbed.

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
    // Kept in pcs, bought in CASE, 2 at least: above its point, so no shortfall.
    { id: "ITEM-D", sku: "RL-D", name: "Cap", unit: "pcs", reorderPoint: 10, metadata: { purchaseUnit: "CASE" }, preferredSupplierId: "SUP-1", status: "active" },
    { id: "ITEM-E", sku: "RL-E", name: "Ring", unit: "", reorderPoint: 10, metadata: {}, preferredSupplierId: null, status: "active" },
  ],
  allocationRows: [
    { sku: "RL-A", onHand: 110, reserved: 10, incomingLines: [{ purchaseOrderId: "PO-0039", orderNumber: "PO-0039", lineId: "L1", remaining: 30, dueDay: "2026-10-08" }], incomingExcluded: [{ purchaseOrderId: "PO-0040", orderNumber: "PO-0040", lineId: "L2", unit: "CASE", remaining: 5 }], dataLimitations: [] },
    { sku: "RL-B", onHand: 1, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [] },
    { sku: "RL-C", onHand: 5, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [] },
    { sku: "RL-D", onHand: 400, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [] },
    { sku: "RL-E", onHand: 0, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [] },
  ],
  shipmentLines: [...shipments("ITEM-A", 8, 9), ...shipments("ITEM-D", 8, 9), { itemId: "ITEM-A", unit: "CASE", quantity: 1, postedAt: "2026-10-01T15:00:00Z" }],
  supplierLinks: [
    { id: "r1", payload: { itemId: "ITEM-A", supplierId: "SUP-1", preferred: true, leadTimeDays: 10 } },
    { id: "r2", payload: { itemId: "ITEM-D", supplierId: "SUP-1", preferred: true, leadTimeDays: 1, minimumOrderQuantity: 2 } },
  ],
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
  await expect(page.getByTestId("reorder-list-no-reorder-point")).toContainText("1 item has no reorder point and is not checked");
  // Each item without a reorder point links to its own record.
  await expect(page.getByTestId("reorder-list-no-reorder-point").getByRole("link", { name: "RL-B" })).toHaveAttribute("href", "/app/master-data/items/ITEM-B");
  await expect(page.getByTestId("reorder-list-truncated")).toHaveCount(0);
  // No stock unit recorded: not checked, and said so in plain words.
  await expect(page.getByTestId("reorder-list-not-checked-stock_unit_not_recorded")).toContainText("Couldn't check: no stock unit recorded");
  await expect(page.getByTestId("reorder-list-not-checked-stock_unit_not_recorded")).toContainText("RL-E");

  const rows = pageRoot.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-testid", "reorder-row-RL-C");
  await expect(rows.nth(1)).toHaveAttribute("data-testid", "reorder-row-RL-A");
  await expect(rows.nth(2)).toHaveAttribute("data-testid", "reorder-row-RL-D");
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
  // One line: the singular form.
  await expect(a.getByTestId("reorder-flags")).toContainText("1 shipment line in CASE, not counted");
  await expect(a.getByTestId("reorder-supplier")).toContainText("Lead time 10 days");
  await expect(a.getByTestId("reorder-supplier")).toContainText("MOQ not recorded");
  // The MOQ is printed in the unit the item is bought in; one day is singular.
  const d = page.getByTestId("reorder-row-RL-D");
  await expect(d.getByTestId("reorder-supplier")).toContainText("MOQ 2 CASE");
  await expect(d.getByTestId("reorder-supplier")).toContainText("Lead time 1 day");
  await expect(d.getByTestId("reorder-flags")).toContainText("Purchase unit differs (CASE); enter the quantity");
  await expect(pageRoot).not.toContainText(/[㐀-鿿]/);

  // The supplier filter keeps only that supplier's items.
  await page.getByTestId("reorder-list-supplier-filter").selectOption("SUP-1");
  await expect(rows).toHaveCount(2);
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

test("a row without a shortfall hands over no quantity, so the form never starts at an unlabelled 1", async ({ page }) => {
  await open(page);
  const link = page.getByTestId("reorder-create-request-RL-A");
  const href = new URL((await link.getAttribute("href"))!, "http://local");
  // No shortfall: no quantity is handed over, so the form leaves it empty with
  // "Enter the quantity" (server/domain/purchase-request-prefill.test.mjs).
  expect(href.searchParams.get("quantity")).toBeNull();
  expect(href.searchParams.get("suppliers")).toBe("SUP-1");
});

test("the reorder list is available in Chinese and says when nothing needs ordering", async ({ page }) => {
  await open(page, "zh-CN");
  await expect(page.getByTestId("reorder-list-page").getByRole("heading", { name: "补货清单" })).toBeVisible();
  await expect(page.getByTestId("reorder-row-RL-C")).toContainText("立即下单");
  await page.unrouteAll();
  await open(page, "en-US", { ...list, rows: [], suppliers: [], summary: { ...list.summary, listed: 0, orderNow: 0 } });
  await expect(page.getByTestId("reorder-list-empty")).toContainText("No items to reorder yet");
  await expect(page.getByTestId("reorder-list-empty")).toContainText("1 item could not be checked; see below.");
});

test("a reader of one warehouse gets nothing checked against the whole item's reorder point", async ({ page }) => {
  const scoped = buildReorderList({
    today: TODAY,
    timeZone: "America/New_York",
    items: [{ id: "ITEM-A", sku: "RL-A", name: "Valve", unit: "pcs", reorderPoint: 100, metadata: {}, preferredSupplierId: null, status: "active" }],
    scope: { warehouseIds: ["WH-EAST"], totalWarehouses: 2 },
  });
  await open(page, "en-US", { ...scoped, dataLimitations: ["transfers_not_considered"], truncatedSubjects: [{ subject: "purchase_orders", limit: 500 }] });
  await expect(page.getByTestId("reorder-list-scope")).toContainText("You can see 1 of 2 warehouses");
  await expect(page.getByTestId("reorder-list-not-checked-warehouse_scope")).toContainText("Couldn't check: the reorder point covers every warehouse");
  await expect(page.getByTestId("reorder-list-not-checked-warehouse_scope")).toContainText("RL-A");
  await expect(page.getByTestId("reorder-list-truncated")).toContainText("Not every record could be read (purchase orders)");
  await expect(page.getByTestId("reorder-list-page").locator("tbody tr")).toHaveCount(0);
});

test("the inventory warnings page links to the reorder list", async ({ page }) => {
  await open(page);
  await page.goto("/app/inventory/warnings");
  await page.getByTestId("inventory-warnings-reorder-link").click();
  await expect(page).toHaveURL(/\/app\/inventory\/reorder$/);
});
