import { expect, test } from "@playwright/test";

// An item's safety stock and reorder point are one figure for the whole item,
// so the balances and warnings pages set them against the item's stock over
// every location shown, never one location's row. The 2026-10-08 walkthrough
// had 30 EA with no location plus 35 EA at A-01 against a reorder point of 40:
// the reorder list said nothing to order while both rows read "Replenishment
// needed". Since 2026-11-08 "need replenishment" is the reorder list's own
// "order now" (the stock position, with open purchase orders), and a shelf
// below safety stock is a separate signal that says when open orders cover it.

// The chips in either interface language.
const REPLENISH = /Need replenishment|需补货/;
const BELOW_SAFETY = /Below safety stock \(on hand\)|低于安全库存（现有）/;
const COVERED = /covered by open orders|已有在途采购覆盖/;

const balance = (id: string, sku: string, location: string | null, available: number, safetyStock: number, reorderPoint: number) => ({
  id, sku, itemName: sku, warehouseId: "WH-1", location, unit: "EA", status: "Available",
  onHandQuantity: String(available), reservedQuantity: "0", availableQuantity: String(available),
  safetyStock: String(safetyStock), reorderPoint: String(reorderPoint),
});

test("the balances and warnings pages judge an item on its stock over every location", async ({ page, request }) => {
  const response = await request.post("/api/auth/login", { data: { email: "kim@example.com", name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  await page.route("**/api/inventory/balances*", (route) => route.fulfill({ json: { balances: [
    balance("B-1", "VALVE-100", null, 30, 20, 40),
    balance("B-2", "VALVE-100", "A-01", 35, 20, 40),
    balance("B-3", "SEAL-400", "C-01", 35, 30, 60),
    balance("B-4", "LAMP-200", "C-02", 10, 20, 40),
  ] } }));
  // The reorder list judges by stock position: SEAL-400 has nothing coming and
  // is at or below its reorder point; LAMP-200's shelf is low but an open order
  // lifts its position above the reorder point; VALVE-100 is above it (no row).
  await page.route("**/api/inventory/reorder-list*", (route) => route.fulfill({ json: { rows: [
    { sku: "SEAL-400", position: 35, incoming: 0, reorderPoint: 60, orderNow: true },
    { sku: "LAMP-200", position: 60, incoming: 50, reorderPoint: 40, orderNow: false },
  ], notJudged: [] } }));

  await page.goto("/app/inventory/stock");
  const rows = page.locator("main tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "SEAL-400" })).toContainText(REPLENISH);
  await expect(rows.filter({ hasText: "LAMP-200" })).toContainText(BELOW_SAFETY);
  await expect(rows.filter({ hasText: "LAMP-200" })).toContainText(COVERED);
  await expect(rows.filter({ hasText: "LAMP-200" })).not.toContainText(REPLENISH);
  for (const row of await rows.filter({ hasText: "VALVE-100" }).all()) {
    await expect(row).not.toContainText(REPLENISH);
    await expect(row).not.toContainText(BELOW_SAFETY);
  }

  await page.goto("/app/inventory/warnings");
  const warned = page.locator("main tbody tr");
  await expect(warned).toHaveCount(2);
  await expect(warned.filter({ hasText: "SEAL-400" })).toContainText(REPLENISH);
  await expect(warned.filter({ hasText: "LAMP-200" })).toContainText(COVERED);
  // One item to reorder, as on the reorder list; one shelf below safety stock, covered.
  const cards = page.getByTestId("inventory-warning-cards");
  await expect(cards).toContainText(/Need replenishment\s*1|1\s*Need replenishment|需补货\s*1|1\s*需补货/);
});
