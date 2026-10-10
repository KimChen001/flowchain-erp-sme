import { expect, test, type Page } from "@playwright/test";

// Contracts, K1 (docs/contracts-module-design.md): the list, Ending soon, the
// form, one contract's page with its signed file, Today's row and the
// supplier's Contracts tab, in English and Chinese, and what a reader without
// contracts.contract.manage sees. Runs on the settings harness
// (PLAYWRIGHT_SETTINGS_DB=true), which turns the contracts capability on.

const CJK = /[㐀-鿿]/;
type Headers = Record<string, string>;

async function login(page: Page, language = "en-US", role = "manager") {
  const response = await page.request.post("/api/auth/login", { data: { email: `${role}@example.com`, name: "Ignored", company: "Ignored" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({ json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York" } }));
  await page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, session);
  return { Authorization: `Bearer ${session.token}` } as Headers;
}

async function createSupplier(page: Page, headers: Headers, stamp: string, name: string) {
  const created = await page.request.post("/api/master-data/suppliers", { headers, data: { supplierCode: `CT-SUP-${stamp}`, supplierName: name, defaultCurrency: "USD" } });
  expect(created.status()).toBe(201);
  return (await created.json()).supplier.id as string;
}

// The workspace day the server reads states on, and a day some days from it.
async function workspaceDay(page: Page, headers: Headers) {
  const list = await page.request.get("/api/contracts?pageSize=1", { headers });
  expect(list.ok()).toBeTruthy();
  const today = (await list.json()).today as string;
  return { today, plus: (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) };
}

// An active contract recorded through the API.
async function activeContract(page: Page, headers: Headers, input: Record<string, unknown>, signedOn: string) {
  const created = await page.request.post("/api/contracts", { headers, data: input });
  expect(created.status()).toBe(201);
  const draft = (await created.json()).contract;
  const activated = await page.request.post(`/api/contracts/${draft.id}/activate`, { headers, data: { expectedVersion: draft.version, signedOn, startDate: input.startDate } });
  expect(activated.status()).toBe(200);
  return (await activated.json()).contract as { id: string; number: string; version: number };
}

test("a manager records a draft, activates it and adds the signed file; Ending soon, Today and the supplier tab list it", async ({ page }) => {
  test.setTimeout(120_000);
  const headers = await login(page);
  const stamp = String(Date.now());
  const supplierName = `Cobalt Packaging ${stamp}`;
  const supplierId = await createSupplier(page, headers, stamp, supplierName);
  const { plus } = await workspaceDay(page, headers);
  const title = `Packaging supply agreement ${stamp}`;

  // The old placeholder's address lands on the list; the sidebar has Contracts after Suppliers.
  await page.goto("/app/procurement/contracts");
  await expect(page).toHaveURL(/\/app\/contracts\/list$/);
  const sidebar = page.locator("aside");
  // The entry may carry the capability's Beta badge.
  const labels = (await sidebar.locator("button").allInnerTexts()).map((label) => label.split(/\s+/)[0]);
  expect(labels.indexOf("Suppliers")).toBeGreaterThan(-1);
  expect(labels.indexOf("Contracts")).toBe(labels.indexOf("Suppliers") + 1);
  await expect(page.getByTestId("module-subnav").getByRole("link")).toHaveText(["Contracts", "Ending soon"]);
  await expect(page.getByTestId("contract-new")).toBeVisible();

  // From the supplier: the form starts with the supplier filled in.
  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  await page.getByTestId("supplier-tab-contracts").click();
  await expect(page.getByTestId("supplier-contracts-empty")).toHaveText("No contracts with this supplier yet.");
  await page.getByTestId("supplier-contract-new").click();
  await expect(page).toHaveURL(new RegExp(`/app/contracts/new\\?supplierId=${supplierId}$`));
  await expect(page.getByTestId("page-title")).toHaveText("New contract");
  await expect(page.locator("#contract-supplierId")).toHaveValue(supplierId);
  await expect(page.locator("#contract-reminderDays")).toHaveValue("60");
  // Notice days show only for a contract that renews automatically.
  await expect(page.locator("#contract-noticeDays")).toHaveCount(0);
  await page.locator("#contract-renewal").selectOption("automatic");
  await expect(page.locator("#contract-noticeDays")).toBeVisible();
  await page.locator("#contract-renewal").selectOption("none");

  // The server's field errors, in English.
  await page.getByTestId("contract-save").click();
  await expect(page.getByTestId("contract-error-title")).toHaveText("Enter a title.");
  await expect(page.getByTestId("contract-error-type")).toHaveText("Choose a contract type.");
  await page.locator("#contract-title").fill(title);
  await page.locator("#contract-externalReference").fill(`CP-${stamp}`);
  await page.locator("#contract-type").selectOption("purchase_agreement");
  await page.locator("#contract-startDate").fill(plus(-10));
  await page.locator("#contract-endDate").fill(plus(30));
  await page.getByTestId("contract-save").click();

  // Saved as a draft, then activated with its signed date.
  await expect(page).toHaveURL(/\/app\/contracts\/[0-9a-f-]{36}$/);
  const contractId = page.url().split("/").pop()!;
  const detail = page.getByTestId("contract-detail");
  await expect(detail.getByTestId("contract-state-chip").first()).toHaveText("Draft");
  const number = (await page.getByTestId("contract-number").innerText()).trim();
  expect(number).toMatch(/^CT-[0-9A-F]{8}$/);
  await expect(page.getByTestId("contract-title")).toHaveText(title);
  await page.getByTestId("contract-action-activate").click();
  await page.getByTestId("contract-activate-signed").fill(plus(-12));
  await expect(page.getByTestId("contract-activate-start")).toHaveValue(plus(-10));
  await page.getByTestId("contract-activate-confirm").click();
  await expect(page.getByTestId("contract-header").getByTestId("contract-state-chip")).toHaveText("Ending soon");
  await expect(page.getByTestId("contract-key-date-line")).toContainText("Ends");
  await expect(page.getByTestId("contract-action-activate")).toHaveCount(0);
  await expect(page.getByTestId("contract-action-terminate")).toBeVisible();

  // A signed PDF, uploaded, listed and downloadable.
  await page.getByTestId("contract-file-input").setInputFiles({ name: "signed-agreement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n") });
  await expect(page.getByTestId("contract-file-name")).toHaveText(["signed-agreement.pdf"]);
  const download = page.waitForEvent("download");
  await page.getByTestId("contract-file-download").click();
  expect((await download).suggestedFilename()).toBe("signed-agreement.pdf");
  // History: readable action names, newest first, never the stored codes.
  const history = page.getByTestId("contract-history");
  await expect(history.getByTestId("contract-history-entry")).toHaveCount(3);
  await expect(history.getByTestId("contract-history-entry").first()).toContainText("File added");
  await expect(history).toContainText("Activated");
  await expect(history).toContainText("Created");
  await expect(history).not.toContainText(/contract_[a-z_]+/);
  await expect(page.getByTestId("contract-value")).toContainText("Not recorded");
  await expect(page.locator("main")).not.toContainText(CJK);

  // Ending soon lists it by its key date, with what each state means.
  await page.goto("/app/contracts/ending");
  await expect(page.getByTestId("contracts-ending-explained")).toContainText("The end date is inside the reminder window");
  await page.getByLabel("Search contracts", { exact: true }).fill(stamp);
  const row = page.getByTestId("contract-row").filter({ hasText: number });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("contract-key-date")).toHaveAttribute("data-date", plus(30));
  await expect(row).toContainText(supplierName);
  await expect(row).toContainText("Purchase agreement");
  await expect(row.getByTestId("contract-state-chip")).toHaveText("Ending soon");
  const keyDates = (await page.getByTestId("contract-key-date").evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-date") || ""))).filter(Boolean);
  expect(keyDates).toEqual([...keyDates].sort());
  await expect(page.locator("main")).not.toContainText(CJK);

  // The list: cards, the search card and the table.
  await page.goto("/app/contracts/list");
  await page.getByLabel("Search contracts", { exact: true }).fill(stamp);
  await expect(page.getByTestId("contracts-count")).toHaveText("1 contract, 1 shown");
  await expect(page.getByTestId("contract-row")).toHaveCount(1);
  await page.getByLabel("State filter", { exact: true }).selectOption("draft");
  await expect(page.getByTestId("contracts-empty")).toContainText("No contracts match these filters");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("main")).not.toContainText(CJK);

  // Today names it and opens it.
  await page.goto("/app/overview/risks");
  const todayList = page.getByTestId("today-work-list");
  await expect(todayList).toBeVisible();
  const showAll = page.getByRole("button", { name: /^Show all \d+$/ });
  if (await showAll.count()) await showAll.click();
  const todayRow = todayList.locator('[data-kind="contract_ending"]').filter({ hasText: number });
  await expect(todayRow).toContainText(title);
  await todayRow.getByRole("link", { name: number, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/contracts/${contractId}$`));
  await expect(page.getByTestId("contract-number")).toHaveText(number);

  // The supplier's Contracts tab lists it.
  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  await page.getByTestId("supplier-tab-contracts").click();
  await expect(page.getByTestId("supplier-contract-table").getByTestId("contract-row")).toHaveCount(1);
  await expect(page.getByTestId("supplier-contract-table")).toContainText(number);
  await expect(page.getByTestId("supplier-contract-new")).toHaveAttribute("href", `/app/contracts/new?supplierId=${supplierId}`);
});

test("the contract pages read in Chinese", async ({ page }) => {
  const headers = await login(page, "zh-CN");
  const stamp = String(Date.now());
  const supplierId = await createSupplier(page, headers, stamp, `Juniper Freight ${stamp}`);
  const { plus } = await workspaceDay(page, headers);
  const contract = await activeContract(page, headers, { title: `Freight services ${stamp}`, type: "service_agreement", supplierId, startDate: plus(-100), endDate: plus(40), renewal: "automatic", noticeDays: 30 }, plus(-101));

  await page.goto("/app/contracts/list");
  await expect(page.locator("aside").getByRole("button", { name: /^合同/ })).toBeVisible();
  await expect(page.getByTestId("module-subnav").getByRole("link")).toHaveText(["合同", "即将到期"]);
  await expect(page.getByText("合同查询", { exact: true })).toBeVisible();
  await page.getByLabel("搜索合同", { exact: true }).fill(stamp);
  const row = page.getByTestId("contract-row").filter({ hasText: contract.number });
  await expect(row.getByTestId("contract-state-chip")).toHaveText("通知截止将至");
  await expect(row).toContainText("服务协议");
  await expect(row).toContainText("通知截止");

  await page.goto(`/app/contracts/${contract.id}`);
  await expect(page.getByTestId("contract-header").getByTestId("contract-state-chip")).toHaveText("通知截止将至");
  await expect(page.getByTestId("contract-dates")).toContainText("自动续约");
  await expect(page.getByTestId("contract-dates")).toContainText("30 天");
  await expect(page.getByTestId("contract-notice-deadline")).toBeVisible();
  await expect(page.getByTestId("contract-history")).toContainText("已生效");
  await expect(page.getByTestId("contract-action-renew")).toHaveText("续约");

  await page.goto("/app/contracts/ending");
  await expect(page.getByTestId("contracts-ending-explained")).toContainText("除非在通知截止日前发出通知");
});

test("a change made meanwhile is refused and offered for reload", async ({ page }) => {
  const headers = await login(page);
  const stamp = String(Date.now());
  const supplierId = await createSupplier(page, headers, stamp, `Harbor Tools ${stamp}`);
  const { plus } = await workspaceDay(page, headers);
  const contract = await activeContract(page, headers, { title: `Tooling agreement ${stamp}`, type: "purchase_agreement", supplierId, startDate: plus(-30), endDate: plus(300) }, plus(-31));
  await page.goto(`/app/contracts/${contract.id}`);
  await expect(page.getByTestId("contract-header").getByTestId("contract-state-chip")).toHaveText("Active");
  // Someone else changes it after the page loaded.
  const changed = await page.request.patch(`/api/contracts/${contract.id}`, { headers, data: { expectedVersion: contract.version, notes: "Changed elsewhere" } });
  expect(changed.status()).toBe(200);
  await page.getByTestId("contract-action-terminate").click();
  await page.getByTestId("contract-terminate-reason").fill("Supplier closed the plant");
  await page.getByTestId("contract-terminate-confirm").click();
  await expect(page.getByTestId("contract-action-error")).toContainText("This contract was changed by someone else. Reload it to see the latest version.");
  await page.getByTestId("contract-reload").click();
  await expect(page.getByTestId("contract-terms")).toContainText("Changed elsewhere");
  await expect(page.getByTestId("contract-action-error")).toHaveCount(0);
});

test("a reader without contracts.contract.manage sees contracts but no actions, and no value", async ({ page }) => {
  const managerHeaders = { Authorization: `Bearer ${(await (await page.request.post("/api/auth/login", { data: { email: "manager@example.com", name: "Ignored", company: "Ignored" } })).json()).token}` };
  const stamp = String(Date.now());
  const supplierId = await createSupplier(page, managerHeaders, stamp, `Willow Labels ${stamp}`);
  const { plus } = await workspaceDay(page, managerHeaders);
  const contract = await activeContract(page, managerHeaders, { title: `Label supply ${stamp}`, type: "purchase_agreement", supplierId, startDate: plus(-20), endDate: plus(200), currency: "USD", totalValue: "48000" }, plus(-21));

  await login(page, "en-US", "viewer");
  await page.goto("/app/contracts/list");
  await page.getByLabel("Search contracts", { exact: true }).fill(stamp);
  const row = page.getByTestId("contract-row").filter({ hasText: contract.number });
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("contract-new")).toHaveCount(0);
  await expect(row.getByTestId("contract-row-edit")).toHaveCount(0);

  await page.goto(`/app/contracts/${contract.id}`);
  await expect(page.getByTestId("contract-number")).toHaveText(contract.number);
  await expect(page.getByTestId("contract-actions")).toHaveCount(0);
  await expect(page.getByTestId("contract-value-hidden")).toHaveText("Hidden for your role");
  await expect(page.getByTestId("contract-value")).not.toContainText("48,000");
  // A typed edit address shows the page, not the form.
  await page.goto(`/app/contracts/${contract.id}?edit=1`);
  await expect(page.getByTestId("contract-detail")).toBeVisible();
  await expect(page.getByTestId("contract-form")).toHaveCount(0);

  await page.goto(`/app/master-data/suppliers/${supplierId}`);
  await page.getByTestId("supplier-tab-contracts").click();
  await expect(page.getByTestId("supplier-contract-table")).toContainText(contract.number);
  await expect(page.getByTestId("supplier-contract-new")).toHaveCount(0);
});
