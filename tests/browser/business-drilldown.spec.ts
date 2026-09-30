import { expect, test } from "@playwright/test";

const user = { id: "drilldown-user", company: "新辰智能制造", name: "张磊", email: "drill@example.com", role: "供应链经理" };
test.beforeEach(async ({ page }) => { await page.addInitScript((profile) => { localStorage.setItem("flowchain:auth-token", "drill-token"); localStorage.setItem("flowchain:current-user", JSON.stringify(profile)); }, user); });

test("runtime PR number opens a refresh-safe URL", async ({ page, request }) => {
  const code = `DRILL-${Date.now()}`;
  const supplierResponse = await request.post("/api/master-data/suppliers", { headers: { "x-flowchain-role": "manager" }, data: { supplierCode: code, supplierName: code, status: "active" } });
  const supplier = (await supplierResponse.json()).supplier;
  const prResponse = await request.post("/api/procurement/requests", { headers: { "x-flowchain-role": "manager", "x-flowchain-user": "drilldown-user" }, data: { departmentId: "operations", defaultCurrency: "CNY", lines: [{ lineId: "L1", sourceType: "non_catalog_item", lineBasis: "amount", supplierId: supplier.id, itemNameSnapshot: "钻取测试服务", commodityId: "service", estimatedAmount: 30, currency: "CNY", targetWarehouseId: "WH-MAIN", needByDate: "2026-08-01" }] } });
  expect(prResponse.status()).toBe(201);
  const pr = await prResponse.json();
  await page.goto(`/app/procurement/requests/${pr.id}`);
  await expect(page).toHaveURL(new RegExp(`/app/procurement/requests/${pr.id}$`));
  await expect(page.getByText(pr.id, { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("钻取测试服务", { exact: true })).toBeVisible();
});

test("legacy three-way match detail is treated as missing", async ({ page }) => {
  await page.goto("/app/finance/three-way-match/MATCH-INV-SZ-260422");
  const detail = page.getByTestId("business-entity-detail");
  await expect(detail).toContainText("未找到 三单匹配");
  await expect(detail).not.toContainText("容差规则");
  await expect(detail.locator('a[href*="PO-2026"]')).toHaveCount(0);
});

test("unconnected finance routes render real empty states without legacy identifiers", async ({ page }) => {
  // Reconciliation (cashbook) and settlement are frozen and show "Capability unavailable".
  for (const path of ["/app/finance/reconciliation", "/app/finance/settlement"]) {
    await page.goto(path);
    await expect(page.getByTestId("capability-route-blocked")).toBeVisible();
  }
  for (const [path, empty] of [["/app/finance/invoices", "暂无供应商发票"]] as const) {
    await page.goto(path);
    await expect(page.getByText(empty, { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/INV-HD-260421|INV-SZ-260422|RTV-2026-0501|GRN-202605-0418|PO-2026-128[4-7]/);
  }
});
