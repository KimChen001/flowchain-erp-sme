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
  // The server numbers the transfer when it is saved; nobody types it.
  await expect(page.getByTestId("transfer-number-on-save")).toHaveText(
    "调拨单号：保存时自动生成",
  );
  // Save checks the rules first: the missing source warehouse and item are
  // said under their fields, the first gets the focus, and nothing is sent.
  await page.getByTestId("create-transfer").click();
  await expect(page.getByText("请选择调出仓库。")).toBeVisible();
  await expect(page.getByText("请选择物料。")).toBeVisible();
  await expect(page.getByLabel("来源仓库 1")).toBeFocused();
  await expect(page.getByTestId("transfer-create-errors")).toContainText(
    "请检查标出的字段。",
  );
  await expect(page).toHaveURL(/\/app\/inventory\/transfers\/new$/);
  // Quantities are typed left-aligned, as on every entry form.
  await expect(page.getByLabel("调拨数量 1")).not.toHaveClass(/text-right/);
  await page.getByLabel("来源仓库 1").selectOption("inventory-browser-a");
  // The item menu lists what warehouse A holds, with what is available.
  await expect(
    page.getByLabel("调拨物料 1").locator("option", { hasText: "INV-BROWSER-SKU" }),
  ).toHaveText(/可用 8/);
  await page.getByLabel("调拨物料 1").selectOption("inventory-browser-item");
  // The item has one stock record there, so its location is chosen.
  await expect(page.getByLabel("来源库位 1")).toHaveValue("inventory-browser-balance-a");
  await page.getByLabel("调拨数量 1").fill("3.0000");
  await page.getByLabel("目标仓库 1").selectOption("inventory-browser-b");
  // Target locations are the warehouse's known ones; a new one is typed only
  // after choosing "New location…".
  await expect(page.getByLabel("新库位 1")).toHaveCount(0);
  await page.getByLabel("目标库位 1").selectOption("__new_location__");
  await expect(page.getByLabel("新库位 1")).toBeVisible();
  await page.getByLabel("目标库位 1").selectOption("B-01");
  await expect(page.getByLabel("新库位 1")).toHaveCount(0);
  await page.getByRole("button", { name: "添加行" }).click();
  await page.getByLabel("来源仓库 2").selectOption("inventory-browser-a");
  await page.getByLabel("调拨物料 2").selectOption("inventory-browser-item");
  await page.getByLabel("调拨数量 2").fill("1.0000");
  await page.getByLabel("目标仓库 2").selectOption("inventory-browser-b");
  await page.getByLabel("目标库位 2").selectOption("B-01");
  await page.getByTestId("create-transfer").click();
  await expect(page.getByTestId("inventory-transfer-workbench")).toBeVisible();
  await expect(
    page.getByTestId("inventory-transfer-workbench").locator("h1"),
  ).toHaveText(/^TR-\d{6}-\d{4,}$/);
  const transferUrl = page.url();
  // Nothing has moved yet, so there is nothing to reconcile.
  await expect(page.getByTestId("inventory-reconciliation")).toHaveCount(0);
  await page.getByTestId("operation-ready").click();
  // Posting is one step: the dialog shows each stock record before → after.
  await page.getByTestId("operation-post").click();
  const postDialog = page.getByTestId("inventory-operation-confirm");
  await expect(postDialog.getByTestId("inventory-operation-stock-change-row")).toHaveCount(2);
  await expect(
    postDialog.getByTestId("inventory-operation-stock-change-row").filter({ hasText: "A-01" }),
  ).toContainText(/10\s*个\s*6\s*个/);
  await expect(
    postDialog.getByTestId("inventory-operation-stock-change-row").filter({ hasText: "B-01" }),
  ).toContainText(/5\s*个\s*9\s*个/);
  await page.getByTestId("inventory-operation-confirm-confirm").click();
  await expect(
    page
      .getByTestId("operation-movement-stock_transfer_out")
      .filter({ hasText: "出 3" }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("operation-movement-stock_transfer_in")
      .filter({ hasText: "入 3" }),
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
  // A reversal asks for its reason in the dialog; nothing is prefilled.
  await page.getByTestId("operation-reverse").click();
  await expect(page.getByTestId("inventory-operation-confirm-field")).toHaveValue("");
  await page.getByTestId("inventory-operation-confirm-field").fill("浏览器测试冲销");
  await page.getByTestId("inventory-operation-confirm-confirm").click();
  // The posting and its reversal make eight movements: few enough to stay
  // listed, not folded.
  await expect(page.getByTestId("operation-movements-summary")).toHaveCount(0);
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
  await page.getByTestId("create-count").click();
  await expect(page.getByText("请选择盘点仓库。")).toBeVisible();
  await expect(page.getByLabel("盘点仓库")).toBeFocused();
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
  await page.getByTestId("operation-post").click();
  await page.getByTestId("inventory-operation-confirm-confirm").click();
  await expect(
    page.getByTestId("operation-movement-cycle_count_adjustment"),
  ).toContainText("入 1");

  // A new adjustment starts neutral: no reason, no quantity. Save says what
  // is missing, the reason first.
  await page.goto("/app/inventory/adjustments/new");
  await expect(page.getByLabel("调整原因")).toHaveValue("");
  await expect(page.getByLabel("调整数量 1")).toHaveValue("");
  await expect(page.getByLabel("调整数量 1")).not.toHaveClass(/text-right/);
  await page.getByTestId("create-adjustment").click();
  await expect(page.getByText("请选择调整原因。")).toBeVisible();
  await expect(page.getByText("请选择库存余额。")).toBeVisible();
  await expect(page.getByLabel("调整原因")).toBeFocused();
  await page.getByLabel("调整原因").selectOption({ label: "损坏" });
  await page
    .getByLabel("调整余额 1")
    .selectOption("inventory-browser-balance-b");
  await page.getByLabel("调整数量 1").fill("-1.0000");
  // The line says the stock change it makes before it is saved.
  await expect(page.getByTestId("adjustment-line-change-1")).toContainText(/5\s*个\s*4\s*个/);
  await page.getByTestId("create-adjustment").click();
  await expect(page.getByTestId("inventory-adjustment-workbench")).toBeVisible();
  // No reason box on the document: only cancel and reverse ask for one.
  await expect(page.getByLabel("操作原因")).toHaveCount(0);
  await expect(page.getByTestId("inventory-reconciliation")).toHaveCount(0);
  await page.getByTestId("operation-ready").click();
  await page.getByTestId("operation-post").click();
  await expect(
    page.getByTestId("inventory-operation-confirm").getByTestId("inventory-operation-stock-change-row"),
  ).toContainText(/5\s*个\s*4\s*个/);
  await page.getByTestId("inventory-operation-confirm-confirm").click();
  await expect(
    page.getByTestId("operation-movement-inventory_adjustment"),
  ).toContainText("出 1");
  await expect(page.getByTestId("inventory-reconciliation")).toBeVisible();
  await page.getByTestId("operation-reverse").click();
  await page.getByTestId("inventory-operation-confirm-field").fill("浏览器测试冲销");
  await page.getByTestId("inventory-operation-confirm-confirm").click();
  await expect(
    page.getByTestId("operation-movement-inventory_adjustment_reversal"),
  ).toBeVisible();

  // Found stock: a key that already has a stock record points to it, and
  // switching to Damage restores the picker; the quantity stays as typed.
  await page.goto("/app/inventory/adjustments/new");
  await page.getByLabel("调整原因").selectOption({ label: "盘盈" });
  await expect(page.getByLabel("调整数量 1")).toHaveValue("");
  await page.getByTestId("adjustment-line-mode-1").selectOption("new");
  await page.getByLabel("调整物料 1").selectOption("inventory-browser-item");
  await page.getByLabel("调整仓库 1").selectOption("inventory-browser-b");
  await page.getByLabel("调整库位 1").fill("B-01");
  await expect(page.getByTestId("adjustment-line-existing-1")).toBeVisible();
  await page.getByLabel("调整原因").selectOption({ label: "损坏" });
  await expect(page.getByLabel("调整余额 1")).toBeVisible();
  await expect(page.getByLabel("调整数量 1")).toHaveValue("");

  // Opening stock for a location with no stock record: posting creates it.
  // A key that already has a stock record is flagged before saving.
  await page.goto("/app/inventory/adjustments/new");
  await page.getByLabel("调整原因").selectOption({ label: "期初库存" });
  await page.getByLabel("调整物料 1").selectOption("inventory-browser-item");
  await page.getByLabel("调整仓库 1").selectOption("inventory-browser-b");
  await page.getByLabel("调整库位 1").fill("B-01");
  await expect(page.getByTestId("adjustment-line-existing-1")).toContainText(
    "期初库存",
  );
  await page.getByLabel("调整库位 1").fill("OPEN-01");
  await expect(page.getByTestId("adjustment-line-existing-1")).toHaveCount(0);
  await page.getByLabel("调整数量 1").fill("5.0000");
  await page.getByTestId("create-adjustment").click();
  await expect(page.getByTestId("adjustment-line-new-record")).toBeVisible();
  await page.getByTestId("operation-ready").click();
  await page.getByTestId("operation-post").click();
  // A location with no stock record starts from 0 and is marked as new.
  await expect(
    page.getByTestId("inventory-operation-confirm").getByTestId("inventory-operation-stock-change-row"),
  ).toContainText(/OPEN-01[\s\S]*0\s*个\s*5\s*个/);
  await page.getByTestId("inventory-operation-confirm-confirm").click();
  await expect(
    page.getByTestId("operation-movement-inventory_adjustment"),
  ).toContainText("入 5");

  const viewer = await login(request, "viewer@example.com");
  const denied = await request.post("/api/inventory/counts", {
    headers: { Authorization: `Bearer ${viewer.token}` },
    data: {
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
