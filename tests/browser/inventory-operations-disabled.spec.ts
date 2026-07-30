import { expect, test } from "@playwright/test";

test("disabled inventory operations fail closed in UI and API", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Ignored", company: "Ignored" },
  });
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  await page.goto("/app/inventory/operations");
  await expect(page.getByTestId("capability-route-blocked")).toContainText(
    "能力暂不可用",
  );
  await page.goto("/app/inventory/transfers/new");
  await expect(page.getByTestId("capability-route-blocked")).toContainText(
    "能力暂不可用",
  );
  const mutation = await request.post("/api/inventory/adjustments", {
    headers: { Authorization: `Bearer ${session.token}` },
    data: {
      adjustmentNumber: "DISABLED",
      reasonCode: "damage",
      idempotencyKey: "disabled-browser",
      lines: [
        {
          inventoryBalanceId: "inventory-browser-balance-a",
          adjustmentQuantity: "1",
        },
      ],
    },
  });
  expect(mutation.status()).toBe(409);
  expect((await mutation.json()).code).toBe(
    "INVENTORY_OPERATIONS_CAPABILITY_NOT_AVAILABLE",
  );
});
