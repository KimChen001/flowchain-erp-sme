import { expect, test } from "@playwright/test";

test("disabled operational finance remains fail-closed", async ({
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

  await page.goto("/app/finance/overview");
  const blocked = page.getByTestId("capability-route-blocked");
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText("能力暂不可用");

  const read = await request.get("/api/finance/customer-invoices", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  expect(read.ok()).toBeTruthy();
  const write = await request.post("/api/finance/customer-invoices/preview", {
    headers: { Authorization: `Bearer ${session.token}` },
    data: {},
  });
  expect(write.status()).toBe(409);
  const payload = await write.json();
  expect(payload.code).toBe("OPERATIONAL_FINANCE_CAPABILITY_NOT_AVAILABLE");
  expect(payload.details.capability).toBe("customer-invoice");
});
