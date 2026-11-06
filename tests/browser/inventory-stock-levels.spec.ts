import { expect, test } from "@playwright/test";

// An item's safety stock and reorder point are one figure for the whole item,
// so the balances and warnings pages set them against the item's stock over
// every location shown, as the reorder list does, never one location's row.
// The 2026-10-08 walkthrough had 30 EA with no location plus 35 EA at A-01
// against a reorder point of 40: the reorder list said nothing to order while
// both rows read "Replenishment needed".

// The chip in either interface language.
const REPLENISH = /Replenishment needed|需补货/;

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
  ] } }));

  await page.goto("/app/inventory/stock");
  const rows = page.locator("main tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "SEAL-400" })).toContainText(REPLENISH);
  for (const row of await rows.filter({ hasText: "VALVE-100" }).all()) await expect(row).not.toContainText(REPLENISH);

  await page.goto("/app/inventory/warnings");
  await expect(page.locator("main tbody tr")).toHaveCount(1);
  await expect(page.locator("main tbody tr")).toContainText("SEAL-400");
});
