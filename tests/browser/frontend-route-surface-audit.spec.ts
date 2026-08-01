import { expect, test } from "@playwright/test";
import { appRouteRegistry } from "../../src/app/routeRegistry";

test("162/162 frontend route stability audit resolves without crashes, route 404s, or API 5xx responses", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const login = await request.post("/api/auth/login", {
    data: {
      email: "kim@example.com",
      name: "Route Surface Audit",
      company: "Route Surface Audit",
    },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);

  const activeRoute = { id: "" };
  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(`${activeRoute.id}: page error: ${error.message}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) {
      failures.push(
        `${activeRoute.id}: API ${response.status()} ${response.url()}`,
      );
    }
  });

  for (const route of appRouteRegistry) {
    activeRoute.id = route.id;
    const auditPath = route.path.replace(
      /:[^/]+/g,
      "ROUTE-AUDIT-NOT-FOUND",
    );
    await page.goto(auditPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-main")).toBeVisible();
    await page.waitForTimeout(100);
    if ((await page.getByTestId("not-found-recovery").count()) > 0) {
      failures.push(`${route.id}: rendered not-found recovery`);
    }
    if ((await page.getByText(/模块加载失败/).count()) > 0) {
      failures.push(`${route.id}: rendered module crash boundary`);
    }
  }

  expect(
    failures,
    `${appRouteRegistry.length}/162 frontend route stability audit; business semantics are covered separately`,
  ).toEqual([]);
});
