import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const screenshotDir = resolve("test-results", "product-recovery");

async function capture(page: Page, name: string) {
  await page.evaluate((url) => {
    document.querySelector("[data-acceptance-url]")?.remove();
    const bar = document.createElement("div");
    bar.dataset.acceptanceUrl = "true";
    bar.textContent = `验收 URL：${url}`;
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "6px 12px",
      borderRadius: "0 0 8px 8px",
      background: "#111827",
      color: "#fff",
      font: "12px sans-serif",
    });
    document.body.appendChild(bar);
  }, page.url());
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
});

test("authoritative Product Recovery pages remain useful and truthful", async ({ page, request }) => {
  const adminLogin = await request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Initial Admin", company: "Product Recovery" },
  });
  expect(adminLogin.ok()).toBeTruthy();

  const login = await request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Product Recovery", company: "Product Recovery" },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);

  await page.goto("/app/procurement/orders");
  await expect(page.getByText("LOCAL-DEMO-PO-001", { exact: true })).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-PO-002", { exact: true })).toBeVisible();
  await expect(page.getByText("本地演示供应商 A").first()).toBeVisible();
  await expect(page.getByText("部分收货").first()).toBeVisible();
  await expect(page.getByText("发票差异").first()).toBeVisible();
  await capture(page, "01-procurement-orders");

  await page.goto("/app/procurement/order-lines");
  const fulfillmentTable = page.getByTestId("order-fulfillment-line-list").getByRole("table");
  await expect(fulfillmentTable).toBeVisible();
  await expect(fulfillmentTable.getByRole("columnheader", { name: "已收", exact: true })).toBeVisible();
  await expect(fulfillmentTable.getByRole("columnheader", { name: "已开票", exact: true })).toBeVisible();
  await expect(page.getByTestId("fulfillment-line-LOCAL-DEMO-PO-001-LINE-001")).toContainText("20 pcs");
  await expect(page.getByTestId("fulfillment-line-LOCAL-DEMO-PO-002-LINE-001")).toContainText("40 pcs");
  await capture(page, "01a-order-fulfillment-lines");

  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-001");
  await expect(page.getByRole("heading", { name: "采购订单 / PO" })).toBeVisible();
  await expect(page.getByText(/LOCAL-DEMO-PO-001 · 本地演示供应商 A/)).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-PO-001-LINE-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-GRN-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-INV-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("金额差异", { exact: true }).first()).toBeVisible();
  await capture(page, "02-po-001-detail");

  await page.getByRole("button", { name: "查看供应商发票" }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/orders\/LOCAL-DEMO-PO-001/);
  await expect(page.getByTestId("po-fulfillment-focus")).toContainText("LOCAL-DEMO-INV-001");
  await page.getByRole("button", { name: "查看三单匹配" }).click();
  await expect(page).toHaveURL(/\/app\/procurement\/orders\/LOCAL-DEMO-PO-001/);
  await expect(page.getByTestId("po-fulfillment-focus")).toHaveAttribute("data-focus-highlight", "true");

  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-002");
  await expect(page.getByText("LOCAL-DEMO-PO-002-LINE-001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("当前 PO 暂无收货记录。")).toBeVisible();
  await expect(page.getByText("当前 PO 尚未读取到 Invoice Line。")).toBeVisible();
  await expect(page.getByText("等待收货", { exact: true }).first()).toBeVisible();
  await capture(page, "03-po-002-detail");

  await page.goto("/app/procurement/orders/LOCAL-DEMO-PO-002?focus=receiving-invoice-variance");
  await expect(page.getByTestId("po-fulfillment-focus")).toHaveAttribute("data-focus-highlight", "true");
  await capture(page, "04-ai-po-002-focus");

  await page.goto("/app/sales/orders");
  await expect(page.getByTestId("outbound-order-list")).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-SO-001", { exact: true })).toBeVisible();
  await expect(page.getByText("本地演示客户 A", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "新建销售订单" })).toHaveCount(0);
  await capture(page, "05-sales-orders-readonly");

  await page.goto("/app/sales/orders/LOCAL-DEMO-SO-001");
  await expect(page.getByTestId("outbound-order-workbench")).toBeVisible();
  const salesLine = page.getByRole("row").filter({ hasText: "LDM-001" });
  await expect(salesLine).toContainText("本地演示控制器");
  await expect(salesLine).toContainText("35.0000");
  await capture(page, "06-sales-order-detail");

  await page.goto("/app/sales/orders/new");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("能力暂不可用");
  await expect(page.getByTestId("create-sales-order")).toHaveCount(0);
  await capture(page, "07-sales-order-create-blocked");

  await page.goto("/app/inventory/stock");
  await expect(page.getByTestId("inventory-item-LDM-001")).toContainText("8");
  await expect(page.getByTestId("inventory-item-LDM-001")).toContainText("20 / 20");
  await expect(page.getByTestId("inventory-item-LDM-002")).toContainText("60");
  await capture(page, "08-inventory-stock");

  await page.goto("/app/inventory/warnings");
  await expect(page.getByTestId("inventory-item-LDM-001")).toContainText("需补货");
  await expect(page.getByTestId("inventory-item-LDM-001")).toContainText("20 / 20");
  await expect(page.getByTestId("inventory-item-LDM-002")).toHaveCount(0);
  await capture(page, "09-inventory-warnings");

  await page.goto("/app/procurement/workbench");
  await expect(page.getByRole("heading", { name: "今日采购待办：2" })).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-PO-001", { exact: true })).toBeVisible();
  await expect(page.getByText("LOCAL-DEMO-PO-002", { exact: true })).toBeVisible();
  await expect(page.getByText("partially_received", { exact: false })).toBeVisible();
  await expect(page.getByText("open", { exact: false })).toBeVisible();
  await expect(page.getByText("发票差异", { exact: true })).toBeVisible();
  await expect(page.getByText("三单匹配异常", { exact: true })).toBeVisible();
  await capture(page, "10-procurement-workbench");

  for (const route of ["movements", "lots", "serials", "exceptions"]) {
    await page.goto(`/app/inventory/${route}`);
    await expect(page.getByText(/当前工作区暂无|当前没有库存异常/)).toBeVisible();
    await expect(page.getByText(/STATIC-|SKU-01100/)).toHaveCount(0);
  }
});
