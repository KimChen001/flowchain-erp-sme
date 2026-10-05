import { expect, test } from "@playwright/test";

async function login(request: any, email: string) {
  const response = await request.post("/api/auth/login", {
    data: { email, name: "Ignored", company: "Ignored" },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function session(page: any, value: any) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, value);
}

test("inventory operations workbench closes transfer, count, and adjustment through PostgreSQL", async ({
  page,
  request,
  browser,
}) => {
  const kim = await login(request, "kim@example.com");
  await session(page, kim);
  await page.goto("/app/inventory/operations");
  await expect(page.getByTestId("inventory-operations-landing")).toBeVisible();

  await page.getByRole("link", { name: /库存调拨/ }).click();
  await page.getByRole("link", { name: "新建" }).click();
  await page.getByLabel("调拨物料 1").selectOption("inventory-browser-item");
  await page.getByLabel("调拨数量 1").fill("3.0000");
  await page.getByLabel("来源仓库 1").selectOption("inventory-browser-a");
  await page.getByLabel("来源库位 1").fill("A-01");
  await page.getByLabel("目标仓库 1").selectOption("inventory-browser-b");
  await page.getByLabel("目标库位 1").fill("B-01");
  await page.getByRole("button", { name: "添加行" }).click();
  await page.getByLabel("调拨物料 2").selectOption("inventory-browser-item");
  await page.getByLabel("调拨数量 2").fill("1.0000");
  await page.getByLabel("来源仓库 2").selectOption("inventory-browser-a");
  await page.getByLabel("来源库位 2").fill("A-01");
  await page.getByLabel("目标仓库 2").selectOption("inventory-browser-b");
  await page.getByLabel("目标库位 2").fill("B-01");
  await page.getByTestId("create-transfer").click();
  await expect(page.getByTestId("inventory-transfer-workbench")).toBeVisible();
  const transferUrl = page.url();
  await page.getByTestId("operation-ready").click();
  await page.getByTestId("operation-preview-post").click();
  await expect(page.getByTestId("inventory-operation-preview")).toContainText(
    "Preview 允许执行",
  );
  await page.getByTestId("confirm-inventory-operation").click();
  await expect(
    page
      .getByTestId("operation-movement-stock_transfer_out")
      .filter({ hasText: "出 3.0000" }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("operation-movement-stock_transfer_in")
      .filter({ hasText: "入 3.0000" }),
  ).toHaveCount(1);
  // The stored "matched" status is shown as its label.
  await expect(page.getByTestId("inventory-reconciliation")).toContainText(
    "对账：已匹配",
  );
  let balances = await request.get(
    "/api/inventory/balances?sku=INV-BROWSER-SKU",
    { headers: { Authorization: `Bearer ${kim.token}` } },
  );
  let balanceData = await balances.json();
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "inventory-browser-balance-a",
    ).onHandQuantity,
  ).toBe("6.0000");
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "inventory-browser-balance-b",
    ).onHandQuantity,
  ).toBe("9.0000");
  await page.getByTestId("operation-preview-reverse").click();
  await page.getByTestId("confirm-inventory-operation").click();
  await expect(
    page.getByTestId("operation-movement-stock_transfer_reversal_in").first(),
  ).toBeVisible();
  balances = await request.get("/api/inventory/balances?sku=INV-BROWSER-SKU", {
    headers: { Authorization: `Bearer ${kim.token}` },
  });
  balanceData = await balances.json();
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "inventory-browser-balance-a",
    ).onHandQuantity,
  ).toBe("10.0000");

  await page.goto("/app/inventory/counts/new");
  await page.getByLabel("盘点仓库").selectOption("inventory-browser-a");
  await page.getByRole("checkbox").nth(1).check();
  await page.getByTestId("create-count").click();
  await expect(page.getByTestId("inventory-count-workbench")).toBeVisible();
  await expect(page.getByTestId("count-recorded")).toContainText("盲盘隐藏");
  const countUrl = page.url();
  const specialist = await login(request, "specialist@example.com"),
    specialistContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
    }),
    specialistPage = await specialistContext.newPage();
  await session(specialistPage, specialist);
  await specialistPage.goto(countUrl);
  await expect(specialistPage.getByTestId("count-recorded")).toContainText(
    "盲盘隐藏",
  );
  await specialistPage.getByLabel("实盘数量 INV-BROWSER-SKU").fill("11.0000");
  await specialistPage.getByTestId("save-counts").click();
  await specialistPage.getByTestId("count-submit").click();
  await expect(specialistPage.getByTestId("count-recorded")).toContainText(
    "盲盘隐藏",
  );
  await specialistContext.close();
  await page.goto(countUrl);
  await expect(page.getByTestId("count-recorded")).toContainText("10.0000");
  await page.getByTestId("count-review").click();
  await page.getByTestId("operation-preview-post").click();
  await page.getByTestId("confirm-inventory-operation").click();
  await expect(
    page.getByTestId("operation-movement-cycle_count_adjustment"),
  ).toContainText("入 1.0000");

  await page.goto("/app/inventory/adjustments/new");
  await page
    .getByLabel("调整余额 1")
    .selectOption("inventory-browser-balance-b");
  await page.getByLabel("调整数量 1").fill("-1.0000");
  await page.getByTestId("create-adjustment").click();
  await page.getByTestId("operation-ready").click();
  await page.getByTestId("operation-preview-post").click();
  await page.getByTestId("confirm-inventory-operation").click();
  await expect(
    page.getByTestId("operation-movement-inventory_adjustment"),
  ).toContainText("出 1.0000");
  await page.getByTestId("operation-preview-reverse").click();
  await page.getByTestId("confirm-inventory-operation").click();
  await expect(
    page.getByTestId("operation-movement-inventory_adjustment_reversal"),
  ).toBeVisible();

  // Found stock: the default quantity adds, a key that already has a stock
  // record points to it, and switching back to Damage restores the picker
  // and a decrease.
  await page.goto("/app/inventory/adjustments/new");
  await expect(page.getByLabel("调整数量 1")).toHaveValue("-1.0000");
  await page.getByLabel("调整原因").selectOption({ label: "盘盈" });
  await expect(page.getByLabel("调整数量 1")).toHaveValue("1.0000");
  await page.getByTestId("adjustment-line-mode-1").selectOption("new");
  await page.getByLabel("调整物料 1").selectOption("inventory-browser-item");
  await page.getByLabel("调整仓库 1").selectOption("inventory-browser-b");
  await page.getByLabel("调整库位 1").fill("B-01");
  await expect(page.getByTestId("adjustment-line-existing-1")).toBeVisible();
  await page.getByLabel("调整原因").selectOption({ label: "损坏" });
  await expect(page.getByLabel("调整余额 1")).toBeVisible();
  await expect(page.getByLabel("调整数量 1")).toHaveValue("-1.0000");

  // Opening stock for a location with no stock record: posting creates it.
  await page.goto("/app/inventory/adjustments/new");
  await page.getByLabel("调整原因").selectOption({ label: "期初库存" });
  await page.getByLabel("调整物料 1").selectOption("inventory-browser-item");
  await page.getByLabel("调整仓库 1").selectOption("inventory-browser-b");
  await page.getByLabel("调整库位 1").fill("OPEN-01");
  await page.getByLabel("调整数量 1").fill("5.0000");
  await page.getByTestId("create-adjustment").click();
  await expect(page.getByTestId("adjustment-line-new-record")).toBeVisible();
  await page.getByTestId("operation-ready").click();
  await page.getByTestId("operation-preview-post").click();
  await page.getByTestId("confirm-inventory-operation").click();
  await expect(
    page.getByTestId("operation-movement-inventory_adjustment"),
  ).toContainText("入 5.0000");

  const viewer = await login(request, "viewer@example.com");
  const denied = await request.post("/api/inventory/counts", {
    headers: { Authorization: `Bearer ${viewer.token}` },
    data: {
      countNumber: "VIEWER-DENIED",
      warehouseId: "inventory-browser-a",
      balanceIds: ["inventory-browser-balance-a"],
      idempotencyKey: "viewer-denied",
    },
  });
  expect(denied.status()).toBe(403);
  const noScope = await login(request, "readonly@example.com");
  const hidden = await request.get(
    new URL(transferUrl).pathname.replace("/app/", "/api/") + "/workbench",
    { headers: { Authorization: `Bearer ${noScope.token}` } },
  );
  expect(hidden.status()).toBe(404);
});
