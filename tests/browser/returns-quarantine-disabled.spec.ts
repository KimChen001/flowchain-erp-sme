import { expect, test } from "@playwright/test";

test("disabled returns capability remains readable and fail-closed", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/auth/login", {
    data: {
      email: "manager@example.com",
      name: "Ignored",
      company: "Ignored",
    },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);

  await page.goto("/app/inventory/returns/requests/new");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("能力暂不可用");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("你有访问权限，但此功能在当前工作区未开启。");
  await expect(page.getByTestId("preview-return-request")).toHaveCount(0);
  await page.goto("/app/inventory/quarantine");
  await expect(page.getByTestId("capability-route-blocked")).toContainText("能力暂不可用");
  await expect(page.getByTestId("quarantine-inventory-workbench")).toHaveCount(0);

  const denied = await request.post("/api/returns/requests", {
    headers: { Authorization: `Bearer ${session.token}` },
    data: {
      requestNumber: "DISABLED-DENIED",
      returnType: "customer_return",
      contextDocumentType: "ShipmentDocument",
      contextDocumentId: "returns-browser-shipment",
      reasonCode: "damaged",
      lines: [
        {
          sourceDocumentLineId: "returns-browser-shipment-line",
          requestedQuantity: "1.0000",
        },
      ],
      idempotencyKey: "disabled-denied",
    },
  });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).code).toBe(
    "RETURN_GOVERNANCE_CAPABILITY_NOT_AVAILABLE",
  );
});
