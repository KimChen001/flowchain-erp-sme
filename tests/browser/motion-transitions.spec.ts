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

type PageMount = { path: string; transforms: string[]; done: boolean };

// Runs in the page before the app: from the moment each page-transition
// element mounts, records its computed transform on every style write and
// every frame for 400 ms (twice the page animation), so even a one-frame rise
// shows up. Reading the recording later cannot race the route change.
function recordPageTransitions() {
  const mounts: PageMount[] = [];
  Object.assign(window, { __pageTransitionMounts: mounts });
  const watch = (element: Element) => {
    const mount: PageMount = { path: location.pathname, transforms: [], done: false };
    mounts.push(mount);
    const record = () => {
      if (element.isConnected) mount.transforms.push(getComputedStyle(element).transform);
    };
    record();
    new MutationObserver(record).observe(element, { attributes: true, attributeFilter: ["style"] });
    const start = performance.now();
    const sample = () => {
      record();
      if (performance.now() - start < 400) requestAnimationFrame(sample);
      else mount.done = true;
    };
    requestAnimationFrame(sample);
  };
  new MutationObserver((records) => {
    for (const { addedNodes } of records) {
      for (const node of addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('[data-testid="page-transition"]')) watch(node);
        node.querySelectorAll('[data-testid="page-transition"]').forEach(watch);
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

const pageMounts = (page: Page) => page.evaluate(() => (window as unknown as { __pageTransitionMounts: PageMount[] }).__pageTransitionMounts);

// Waits until the page-transition element for `path` has mounted and its
// recording window has closed, and returns every mount recorded so far.
async function settledPageMounts(page: Page, path: string) {
  await expect.poll(async () => (await pageMounts(page)).some((mount) => mount.path === path && mount.done)).toBe(true);
  const mounts = await pageMounts(page);
  return { mounts, current: mounts.find((mount) => mount.path === path && mount.done)! };
}

async function openNextTab(page: Page) {
  await expect(pillTab(page)).toHaveCount(1);
  await expect(pillTab(page)).toHaveAttribute("aria-current", "page");
  const nextTab = page.locator('[data-testid="module-subnav"] a:not([aria-current="page"])').first();
  const nextLabel = (await nextTab.innerText()).trim();
  const nextPath = new URL((await nextTab.getAttribute("href"))!, page.url()).pathname;
  await nextTab.click();
  // The pill now sits on the chosen tab, and only there.
  await expect(pillTab(page)).toHaveText(nextLabel);
  await expect(pillTab(page)).toHaveAttribute("aria-current", "page");
  return nextPath;
}

test("navigation animates in and leaves no transform behind", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(recordPageTransitions);
  await page.goto("/app/procurement/requests");
  await expect(page.getByTestId("page-transition")).toBeVisible();

  const nextPath = await openNextTab(page);
  // The new page mounts lowered and rises: the recording sees the transform
  // that reduced motion must never show.
  const { current } = await settledPageMounts(page, nextPath);
  expect(current.transforms[0]).toMatch(/^matrix\(/);
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
  await page.addInitScript(recordPageTransitions);
  await page.goto("/app/procurement/requests");
  const nextPath = await openNextTab(page);
  // Motion skips transforms: from the moment each page mounts, on the first
  // load and after the navigation, its content never carries a transform.
  const { mounts, current } = await settledPageMounts(page, nextPath);
  expect(mounts.map((mount) => mount.path)).toContain("/app/procurement/requests");
  expect(current.transforms.length).toBeGreaterThan(3);
  expect(mounts.flatMap((mount) => mount.transforms).filter((transform) => transform !== "none")).toEqual([]);
  await page.goto("/app/reports/procurement?view=analytics");
  await page.getByRole("button", { name: /调整当前视图|Customize this view/ }).click();
  await expect(page.getByTestId("dashboard-configuration")).toHaveCSS("animation-name", "none");
});
