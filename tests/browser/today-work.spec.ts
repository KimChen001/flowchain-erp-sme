import { expect, test, type Page } from "@playwright/test";

// Today on the US walkthrough (PLAYWRIGHT_PRODUCT_RECOVERY_DB): the work that
// needs doing, from the same rules as the open purchase orders report and the
// reorder list, earliest date first, each row linking to its record; status
// tiles that count real rows; and recent documents of every type with one
// date format. The empty-workspace checklist is in today-first-run.spec.ts.

const CJK = /[㐀-鿿]/;

async function signIn(page: Page, language: "en-US" | "zh-CN" = "en-US") {
  const response = await page.request.post("/api/auth/login", {
    data: { email: "admin@flowchain.local", name: "Today walkthrough", company: "FlowChain" },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.route("**/api/me/localization", (route) => route.fulfill({
    json: { languagePreference: language, defaultLanguage: "en-US", effectiveLanguage: language, locale: "en-US", timezone: "America/New_York" },
  }));
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, session);
  return { authorization: `Bearer ${session.token}` };
}

type WorkItem = { kind: string; recordId: string; label: string; date: string | null; overdueDays: number; href: string };
type Decisions = { available: boolean; waiting?: Array<{ key: string; row: WorkItem; draft: any }>; setAside?: Array<{ key: string; row: WorkItem }> };
type Overview = { today: string; workItems: WorkItem[]; workTotal: number; overdue: number; todayChanges: number; firstRun: unknown; decisions: Decisions; recentDocuments: Array<{ type: string; number: string; updatedAt: string }> };

// The rows with a decision card, or set aside, leave Today's work
// (DecisionCards.tsx); the tiles count what is left.
function split(overview: Overview) {
  const waiting = overview.decisions?.available ? overview.decisions.waiting || [] : [];
  const aside = overview.decisions?.available ? overview.decisions.setAside || [] : [];
  const keys = new Set([...waiting, ...aside].map((entry) => entry.key));
  const work = overview.workItems.filter((item) => !keys.has(`${item.kind}:${item.recordId}`));
  return {
    waiting,
    work,
    workTotal: overview.workTotal - keys.size,
    overdue: overview.overdue - aside.filter((entry) => entry.row.overdueDays > 0).length,
  };
}

test("Today lists the walkthrough's work from the report and reorder rules, earliest date first", async ({ page }) => {
  const headers = await signIn(page);
  const overview: Overview = await (await page.request.get("/api/home/overview", { headers })).json();
  const report = await (await page.request.get("/api/reports/open-purchase-orders?export=true", { headers })).json();
  const reorder = await (await page.request.get("/api/inventory/reorder-list", { headers })).json();

  // The same day as the report, and the same overdue and due-soon orders.
  expect(overview.today).toBe(report.asOf);
  const ids = (kind: string) => overview.workItems.filter((item) => item.kind === kind).map((item) => item.recordId).sort();
  const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  const reportOverdue = report.exportRows.filter((row: any) => row.isOpen && row.overdueDays > 0).map((row: any) => row.id).sort();
  const reportDue = report.exportRows.filter((row: any) => row.isOpen && !(row.overdueDays > 0) && row.dueDate && days(report.asOf, row.dueDate) >= 0 && days(report.asOf, row.dueDate) <= 7).map((row: any) => row.id).sort();
  expect(reportOverdue.length).toBeGreaterThan(0);
  expect(ids("purchase_order_overdue")).toEqual(reportOverdue);
  expect(ids("purchase_order_due")).toEqual(reportDue);
  // The reorder list's "order now" items, no more and no fewer.
  expect(overview.workItems.filter((item) => item.kind === "reorder_now").map((item) => item.label).sort()).toEqual(reorder.rows.filter((row: any) => row.orderNow).map((row: any) => row.sku).sort());
  // Bills waiting for their match, and the confirmed sales order still to reserve.
  expect(ids("bill_to_match").length).toBeGreaterThan(0);
  expect(overview.workItems.some((item) => item.kind === "sales_order_to_reserve" && item.label === "LOCAL-DEMO-SO-001")).toBe(true);
  // Earliest date first; rows without a date last.
  const dates = overview.workItems.map((item) => item.date || "9999-12-31");
  expect(dates).toEqual([...dates].sort());
  // On the walkthrough every step of the first-day checklist is done.
  expect(overview.firstRun).toBeNull();

  // The drafted kinds wait for a decision, each with its draft.
  const parts = split(overview);
  expect(overview.decisions.available).toBe(true);
  expect(parts.waiting.every((entry) => ["reorder_now", "purchase_order_overdue", "purchase_request_to_convert"].includes(entry.row.kind))).toBe(true);
  expect(parts.waiting.some((entry) => entry.row.kind === "purchase_order_overdue" && entry.draft?.type === "supplier_follow_up")).toBe(true);

  await page.goto("/app/overview/risks");
  const root = page.getByTestId("runtime-homepage");
  const list = root.getByTestId("today-work-list");
  await expect(list).toBeVisible();
  await expect(root.getByTestId("first-run-checklist")).toHaveCount(0);
  // Two tiles count the rows. Decisions count themselves in their section,
  // and the documents changed today sit beside Recent documents (owner 11/13).
  await expect(root.getByTestId("today-tiles").locator("button")).toHaveCount(2);
  await expect(root.getByTestId("today-tile-all")).toContainText(`${parts.workTotal}Needs action`);
  await expect(root.getByTestId("today-tile-overdue")).toContainText(`${parts.overdue}Overdue`);
  await expect(root.getByTestId("today-changes")).toContainText(`${overview.todayChanges} updated today`);
  await expect(root).not.toContainText(/Assigned to me|Risk exceptions|Changes today|No work items/);
  // The page is named as the sidebar names it; the tab row is its header.
  await expect(page.getByTestId("page-title")).toHaveText("Today");

  // One line per kind of work, in the order of each kind's earliest row,
  // with how many; no row shows until its kind is opened.
  const kinds = [...new Set(parts.work.map((item) => item.kind))];
  const groups = list.getByTestId("today-work-group");
  const group = (kind: string) => list.locator(`[data-testid="today-work-group"][data-kind="${kind}"]`);
  expect(await groups.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")))).toEqual(kinds);
  for (const kind of kinds) await expect(group(kind)).toHaveAttribute("data-count", String(parts.work.filter((item) => item.kind === kind).length));
  await expect(list.getByTestId("today-work-item")).toHaveCount(0);

  // Opening the first kind lists its rows, ten at first, the most overdue
  // purchase order first with its reason.
  const firstItem = parts.work[0];
  const firstGroup = group(firstItem.kind);
  await firstGroup.getByTestId("today-work-group-toggle").click();
  await expect(firstGroup.getByTestId("today-work-group-toggle")).toHaveAttribute("aria-expanded", "true");
  const first = firstGroup.getByTestId("today-work-item").first();
  await expect(first).toContainText(firstItem.label);
  if (firstItem.kind === "purchase_order_overdue") {
    await expect(first).toContainText(new RegExp(`${firstItem.overdueDays} days? overdue`));
    await expect(first).toContainText(/still to receive|lines? still to receive/);
  }
  const firstCount = parts.work.filter((item) => item.kind === firstItem.kind).length;
  await expect(firstGroup.getByTestId("today-work-item")).toHaveCount(Math.min(firstCount, 10));
  if (firstCount > 10) {
    await firstGroup.getByTestId("today-work-group-all").click();
    await expect(firstGroup.getByTestId("today-work-item")).toHaveCount(firstCount);
  }
  // The sales order row says what is left to reserve.
  const salesGroup = group("sales_order_to_reserve");
  await expect(salesGroup).toContainText("Sales order to reserve");
  await salesGroup.getByTestId("today-work-group-toggle").click();
  const salesOrder = salesGroup.getByTestId("today-work-item").filter({ hasText: "LOCAL-DEMO-SO-001" });
  await expect(salesOrder).toContainText("35 pcs still to reserve");
  await expect(salesOrder).toContainText("Customer Redwood Retail");
  // A reorder row without a decision card opens the purchase request the
  // reorder list prefills for its item, and the reorder list.
  if (await group("reorder_now").count()) {
    await group("reorder_now").getByTestId("today-work-group-toggle").click();
    const reorderRow = group("reorder_now").getByTestId("today-work-item").first();
    await expect(reorderRow).toContainText(/Stock position .+, reorder point /);
    const sku = (await reorderRow.getByRole("link").first().innerText()).trim();
    const listRow = reorder.rows.find((row: any) => row.sku === sku);
    const href = await reorderRow.getByRole("link", { name: "Create purchase request" }).getAttribute("href");
    const url = new URL(href || "", "http://local");
    expect(url.pathname).toBe("/app/procurement/requests");
    expect(url.searchParams.get("itemId")).toBe(listRow.purchaseRequest.itemId);
    expect(url.searchParams.get("origin")).toBe("reorder_list");
    if (listRow.purchaseRequest.quantity !== null) expect(url.searchParams.get("quantity")).toBe(String(listRow.purchaseRequest.quantity));
    await expect(reorderRow.getByRole("link", { name: "Open reorder list" })).toHaveAttribute("href", "/app/inventory/reorder");
  }
  // A reorder card says why and opens the prefilled request form.
  const decisions = root.getByTestId("today-decisions");
  const reorderCard = decisions.locator('[data-testid="today-decision"][data-kind="reorder_now"]').first();
  if (await reorderCard.count()) {
    await expect(reorderCard).toContainText(/Stock position .+ against reorder point /);
    await expect(reorderCard.getByTestId("decision-primary")).toHaveAttribute("href", /^\/app\/procurement\/requests\?itemId=.+origin=reorder_list/);
  }
  // An overdue order's card holds the follow-up to copy; FlowChain sends nothing.
  const followUp = decisions.locator('[data-testid="today-decision"][data-kind="purchase_order_overdue"]').first();
  await expect(followUp).toContainText(/still to receive, due /);
  await followUp.getByTestId("decision-follow-up-toggle").click();
  await expect(followUp.getByTestId("decision-follow-up-text")).toHaveValue(/^Purchase order .+: delivery overdue/);
  await expect(followUp).toContainText("FlowChain does not send it");

  // The overdue tile keeps the kinds with overdue rows, each counting only those.
  await root.getByTestId("today-tile-overdue").click();
  const overdueWork = parts.work.filter((item) => item.overdueDays > 0);
  expect(await groups.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")))).toEqual([...new Set(overdueWork.map((item) => item.kind))]);
  await expect(decisions.getByTestId("today-decision")).toHaveCount(parts.waiting.filter((entry) => entry.row.overdueDays > 0).length);
  await expect(group("purchase_order_due")).toHaveCount(0);
  await root.getByTestId("today-tile-all").click();
  await expect(groups).toHaveCount(kinds.length);

  // Recent documents: every document type the reader can open, newest change
  // first, so on the seeded walkthrough the bills written last lead; one
  // date and time format.
  const table = root.getByTestId("recent-documents");
  const types = await table.locator("tbody tr td:first-child").allInnerTexts();
  const labels: Record<string, string> = { purchase_request: "Purchase request", rfq: "RFQ", purchase_order: "Purchase order", receipt: "Receipt", supplier_invoice: "Supplier invoice", sales_order: "Sales order", customer_invoice: "Customer invoice" };
  expect(types).toEqual(overview.recentDocuments.map((row) => labels[row.type]));
  expect(overview.recentDocuments.some((row) => ["receipt", "supplier_invoice", "sales_order", "customer_invoice"].includes(row.type))).toBe(true);
  const changes = overview.recentDocuments.map((row) => Date.parse(row.updatedAt));
  expect(changes).toEqual([...changes].sort((a, b) => b - a));
  for (const updated of await table.locator("tbody tr td:last-child").allInnerTexts()) {
    expect(updated).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M$/);
  }
  expect(overview.recentDocuments.every((row) => /T\d{2}:\d{2}/.test(row.updatedAt))).toBe(true);

  // A row opens its record.
  await first.getByRole("link", { name: firstItem.label, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`${firstItem.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("AI priorities lists the earliest row of every kind of Today's work, with their dates", async ({ page }) => {
  // The earliest row of every kind (the first row of each of Today's kind
  // lines), then the next earliest, five at least (firstRowsByKind).
  const headers = await signIn(page);
  const overview: Overview = await (await page.request.get("/api/home/overview", { headers })).json();
  const work = split(overview).work;
  const picked = new Set<number>();
  const seen = new Set<string>();
  work.forEach((item, index) => { if (!seen.has(item.kind)) { seen.add(item.kind); picked.add(index); } });
  for (let index = 0; index < work.length && picked.size < 5; index += 1) picked.add(index);
  const expected = work.filter((_, index) => picked.has(index)).map((item) => item.kind);
  await page.goto("/app/overview/ai");
  const priorities = page.getByTestId("ai-priorities-list").locator("li");
  await expect(priorities.first()).toBeVisible();
  expect(await priorities.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")))).toEqual(expected);
  // More than overdue orders: the walkthrough has other kinds of work.
  expect(new Set(expected).size).toBeGreaterThan(1);
  await expect(priorities.first().getByTestId("ai-priorities-date")).not.toBeEmpty();
});

test("Today stays in Chinese for a Chinese reader, with the same rows", async ({ page }) => {
  const headers = await signIn(page, "zh-CN");
  const overview: Overview = await (await page.request.get("/api/home/overview", { headers })).json();
  await page.goto("/app/overview/risks");
  const root = page.getByTestId("runtime-homepage");
  await expect(root.getByText("今日需处理", { exact: true })).toBeVisible();
  await expect(root.getByTestId("today-tile-all")).toContainText(`${split(overview).workTotal}待处理`);
  await expect(root.getByTestId("today-decisions")).toContainText("等你决定");
  await expect(root.getByTestId("today-changes")).toContainText(`今日更新 ${overview.todayChanges} 张`);
  await expect(page.getByTestId("page-title")).toHaveText("今日");
  await expect(root.getByText("销售订单待预留", { exact: true })).toBeVisible();
  const salesGroup = root.locator('[data-testid="today-work-group"][data-kind="sales_order_to_reserve"]');
  await salesGroup.getByTestId("today-work-group-toggle").click();
  await expect(salesGroup.getByTestId("today-work-item").first()).toContainText(CJK);
  await expect(salesGroup.getByTestId("today-work-item").filter({ hasText: "LOCAL-DEMO-SO-001" })).toContainText("仍待预留 35 件");
});

test("Not now sets a card aside until its day, and Reopen brings it back", async ({ page }) => {
  const headers = await signIn(page);
  const overview: Overview = await (await page.request.get("/api/home/overview", { headers })).json();
  const target = split(overview).waiting.find((entry) => entry.row.kind === "purchase_order_overdue");
  expect(target).toBeTruthy();
  await page.goto("/app/overview/risks");
  const decisions = page.getByTestId("today-decisions");
  const card = decisions.locator(`[data-testid="today-decision"][data-key="${target!.key}"]`);
  await card.getByTestId("decision-not-now").click();
  await card.getByRole("button", { name: "Tomorrow" }).click();
  await expect(card).toHaveCount(0);
  await decisions.getByRole("button", { name: /Set aside \(\d+\)/ }).click();
  const aside = decisions.getByTestId("today-set-aside-item").filter({ hasText: target!.row.label });
  await expect(aside).toHaveAttribute("data-decision", "not_now");
  await expect(aside).toContainText(/Not now, until /);
  await aside.getByRole("button", { name: "Reopen" }).click();
  await expect(decisions.locator(`[data-testid="today-decision"][data-key="${target!.key}"]`)).toContainText("Back again");
});
