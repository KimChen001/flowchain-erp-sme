import { expect, test, type Page } from "@playwright/test";

// Page content fades in and rises on navigation, the active section tab's
// background slides to the new tab, and drawers and dialogs animate in. At
// rest nothing keeps a transform, so dialogs stay fixed to the viewport. With
// the system's reduced-motion setting, none of it moves.

async function signIn(page: Page) {
  const response = await page.request.post("/api/auth/login", { data: { email: "kim@example.com", name: "Kim", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
}

const pageTransform = (page: Page) => page.getByTestId("page-transition").evaluate((element) => getComputedStyle(element).transform);
const pillTab = (page: Page) => page.locator('[data-testid="module-subnav"] a:has(.fc-subnav-pill)');

test("navigation animates in and leaves no transform behind", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/procurement/requests");
  await expect(page.getByTestId("page-transition")).toBeVisible();
  await expect(pillTab(page)).toHaveCount(1);
  await expect(pillTab(page)).toHaveAttribute("aria-current", "page");

  const nextTab = page.locator('[data-testid="module-subnav"] a:not([aria-current="page"])').first();
  const nextHref = String(await nextTab.getAttribute("href"));
  await nextTab.click();
  // The pill now sits on the chosen tab, and only there. The link identifies
  // the tab: its label may still change language while the page loads.
  await expect(pillTab(page)).toHaveAttribute("href", nextHref);
  await expect(pillTab(page)).toHaveAttribute("aria-current", "page");
  // Once the animation settles the content carries no transform.
  await expect.poll(() => pageTransform(page)).toBe("none");
  await expect(page.getByTestId("page-transition")).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("page-transition")).not.toHaveCSS("will-change", /transform/);

  await page.goto("/app/reports/procurement?view=analytics");
  await page.getByRole("button", { name: /调整当前视图|Customize this view/ }).click();
  const drawer = page.getByTestId("dashboard-configuration");
  await expect(drawer).toHaveCSS("animation-name", "fc-drawer-in");
});

test("with reduced motion, navigation and drawers do not move", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await page.goto("/app/procurement/requests");
  const nextTab = page.locator('[data-testid="module-subnav"] a:not([aria-current="page"])').first();
  const nextHref = String(await nextTab.getAttribute("href"));
  await nextTab.click();
  // Read the new page, not the one being replaced: a detached element has no
  // computed transform at all. The link, not the label, identifies the tab,
  // because the interface language may still switch while the page loads.
  await expect(pillTab(page)).toHaveAttribute("href", nextHref);
  await expect(page.getByTestId("page-transition")).toBeVisible();
  // Motion skips transforms: the content never rises.
  expect(await pageTransform(page)).toBe("none");
  await page.goto("/app/reports/procurement?view=analytics");
  await page.getByRole("button", { name: /调整当前视图|Customize this view/ }).click();
  await expect(page.getByTestId("dashboard-configuration")).toHaveCSS("animation-name", "none");
});
