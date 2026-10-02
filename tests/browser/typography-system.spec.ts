import { expect, test, type Page } from "@playwright/test";

// The manager seeded by scripts/browser-product-recovery-api.mjs.
async function authenticate(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "kim@example.com", name: "Kim", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

test("primary module and page typography uses one computed semantic scale", async ({ page }) => {
  await authenticate(page);
  // A module shows either its own title or, when the module header is hidden,
  // the page title as its visible heading. (The reports center has no h1.)
  for (const path of ["overview", "master-data", "procurement", "sales", "inventory", "settings"]) {
    await page.goto(`/app/${path}`);
    const heading = page.locator("h1.fc-module-title, h1.fc-page-title").first();
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("font-size", "20px");
    await expect(heading).toHaveCSS("line-height", "28px");
  }
  // A seeded list page: header, sub-navigation and table body.
  await page.goto("/app/procurement/orders");
  await expect(page.getByTestId("page-title")).toHaveCSS("font-size", "20px");
  await expect(page.getByTestId("module-subnav").getByRole("link").first()).toHaveCSS("font-size", "13px");
  await expect(page.getByText("LOCAL-DEMO-PO-001", { exact: true }).first()).toBeVisible();
  await expect(page.locator("main tbody td").first()).toHaveCSS("font-size", "13px");
});
