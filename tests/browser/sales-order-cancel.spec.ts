import { test, expect } from "@playwright/test";

// A confirmed, reserved sales order is cancelled from its workbench: the
// server previews what it releases, the reason is required, and afterwards the
// order is cancelled with its reservation released.
test("a reserved sales order is cancelled from its workbench", async ({ page, request }) => {
  const login = await request.post("/api/auth/login", { data: { company: "Browser Company", email: "kim@example.com", name: "Kim" } });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  const api = async (path: string) => (await request.get(path, { headers: { Authorization: `Bearer ${session.token}` } })).json();

  await page.goto("/app/sales/orders");
  await page.getByRole("link", { name: /New sales order|新建销售订单/ }).click();
  await page.getByLabel(/^(Customer|客户)$/).fill("Cancelling Customer");
  await page.getByLabel(/^(Quantity|数量)$/).fill("2.0000");
  await page.getByLabel(/^(Unit price|单价)$/).fill("8.0000");
  await page.getByTestId("create-sales-order").click();
  await expect(page.getByTestId("outbound-order-workbench")).toBeVisible();
  const orderId = decodeURIComponent(page.url().split("/").pop() || "");
  await page.getByTestId("confirm-sales-order").click();
  await expect(page.getByTestId("open-reserve")).toBeVisible();
  await page.getByTestId("open-reserve").click();
  await page.getByLabel(/Sales order line|销售订单行/).selectOption({ index: 1 });
  await page.getByLabel(/Inventory balance|库存余额/).selectOption({ index: 1 });
  await page.getByLabel(/Transaction quantity|交易数量/).fill("2.0000");
  await page.getByTestId("outbound-preview").click();
  await page.getByTestId("confirm-outbound-action").click();
  await expect.poll(async () => (await api(`/api/sales/orders/${encodeURIComponent(orderId)}/workbench`)).order.reservationStatus).toBe("fully_reserved");

  await page.getByTestId("open-cancel-order").click();
  const panel = page.getByTestId("cancel-order-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("confirm-cancel-order")).toBeDisabled();
  await page.getByTestId("cancel-order-preview-button").click();
  await expect(page.getByTestId("cancel-order-preview")).toContainText(/2/);
  // Without a reason the order is not cancelled.
  await expect(page.getByTestId("confirm-cancel-order")).toBeDisabled();
  await page.getByTestId("cancel-order-reason").fill("Customer cancelled the order");
  await page.getByTestId("confirm-cancel-order").click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("open-cancel-order")).toHaveCount(0);
  await expect(page.getByTestId("open-reserve")).toHaveCount(0);

  const workbench = await api(`/api/sales/orders/${encodeURIComponent(orderId)}/workbench`);
  expect(workbench.order.workflowStatus).toBe("cancelled");
  expect(workbench.order.reservationStatus).toBe("not_reserved");
  expect(workbench.reservations.every((reservation: { status: string }) => reservation.status === "released")).toBe(true);
});
