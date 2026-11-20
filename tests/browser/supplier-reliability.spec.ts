import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { SUPPLIER_RELIABILITY_CONTRACT_VERSION, SUPPLIER_RELIABILITY_ROUTE, supplierReliabilityResponseSchema } from "../../shared/supplier-reliability-contract.mjs";

// Supplier evaluation's block on promised dates and supplier replies over 90
// days (supplier replies step 2c, docs/supplier-reply-dates-design.md §4.12),
// below the indicator table and apart from on time and OTIF. The reliability
// read is stubbed, each answer checked against the shared contract first; the
// suppliers and the indicators are the workspace's own.

async function signIn(page: Page, request: APIRequestContext) {
  const session = await (await request.post("/api/auth/login", { data: { email: "admin@flowchain.local", name: "Initial Admin", company: "Product Recovery" } })).json();
  await page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, session);
  return { headers: { Authorization: `Bearer ${session.token}` } };
}
// The interface language, and optionally the workspace's regional format,
// which numbers and dates follow whatever the language.
async function useLanguage(page: Page, language: "en-US" | "zh-CN", locale?: "en-US" | "en-GB" | "zh-CN") {
  await page.unroute("**/api/me/localization");
  await page.route("**/api/me/localization", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), languagePreference: language, effectiveLanguage: language, ...(locale ? { locale } : {}) } });
  });
}
// The workspace's suppliers, by name, as the page lists them.
async function suppliersOf(request: APIRequestContext, auth: { headers: Record<string, string> }) {
  const list = await (await request.get("/api/master-data/suppliers", auth)).json();
  const suppliers = (list.suppliers as Array<{ id: string; supplierName?: string; name?: string }>).map((row) => ({ id: row.id, name: row.supplierName || row.name || row.id }));
  expect(suppliers.length).toBeGreaterThanOrEqual(3);
  return suppliers;
}

// Six replies, each in one outcome: 2 as read, 1 edited, 1 typed by hand
// (nothing was proposed), 1 not recorded, 1 waiting for the person.
const outcomes = { recordedUnchanged: 2, recordedEdited: 1, recordedManual: 1, notRecorded: { wrong_reading: 1, supplier_will_confirm: 0, other: 0 }, needsYou: 1, proposed: 0, nothingToRecord: 0 };
const noOutcomes = { recordedUnchanged: 0, recordedEdited: 0, recordedManual: 0, notRecorded: { wrong_reading: 0, supplier_will_confirm: 0, other: 0 }, needsYou: 0, proposed: 0, nothingToRecord: 0 };
const busy = {
  revisions: { orders: 8, revisedOrders: 3, revisions: 5, perOrder: 0.625, averageDaysMoved: 4.2, movedLater: { count: 4, of: 5, share: 0.8 } },
  replies: { received: 6, read: 5, withStatedDate: { count: 4, of: 5, share: 0.8 }, outcomes, recorded: 4, medianHoursToRecord: 5.5 },
};
// Under the minimum sample everywhere; its one reply was an auto-reply.
const small = {
  revisions: { orders: 2, revisedOrders: 1, revisions: 1, perOrder: null, averageDaysMoved: null, movedLater: { count: 1, of: 1, share: null } },
  replies: { received: 1, read: 1, withStatedDate: { count: 0, of: 1, share: null }, outcomes: { ...noOutcomes, nothingToRecord: 1 }, recorded: 0, medianHoursToRecord: null },
};
const quiet = {
  revisions: { orders: 0, revisedOrders: 0, revisions: 0, perOrder: null, averageDaysMoved: null, movedLater: { count: 0, of: 0, share: null } },
  replies: { received: 0, read: 0, withStatedDate: { count: 0, of: 0, share: null }, outcomes: noOutcomes, recorded: 0, medianHoursToRecord: null },
};

function reliability(suppliers: Record<string, unknown>, visibility = { revisions: true, replies: true }) {
  const value = { contractVersion: SUPPLIER_RELIABILITY_CONTRACT_VERSION, asOf: "2026-11-20", window: { from: "2026-08-23", to: "2026-11-20", days: 90 }, minimumSample: 5, visibility, suppliers };
  const parsed = supplierReliabilityResponseSchema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return value;
}
async function stubReliability(page: Page, answer: (call: number) => { status?: number; json: unknown; delay?: number }) {
  let calls = 0;
  await page.route(`**${SUPPLIER_RELIABILITY_ROUTE}`, async (route) => {
    const { status = 200, json, delay = 0 } = answer(++calls);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({ status, json }).catch(() => undefined);
  });
  return { calls: () => calls };
}
// The outcome cell's parts add up to the replies received in the same row.
async function expectOutcomesAddUp(row: Locator) {
  const received = Number((await row.locator("td").nth(5).innerText()).replace(/\D/g, ""));
  const parts = (await row.getByTestId("supplier-reliability-outcomes").innerText()).split("·").map((part) => Number(part.replace(/\D/g, "")));
  expect(parts.reduce((sum, n) => sum + n, 0)).toBe(received);
}

test.describe("promised dates and supplier replies on Supplier evaluation", () => {
  test("each supplier's date changes and replies, small samples as counts, quiet suppliers counted", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const [first, second, ...rest] = await suppliersOf(request, auth);
    await stubReliability(page, () => ({ json: reliability({ [first.id]: busy, [second.id]: small, ...Object.fromEntries(rest.map((supplier) => [supplier.id, quiet])) }) }));
    await page.goto("/app/master-data/supplier-evaluation");

    const block = page.getByTestId("supplier-reliability");
    await expect(block).toContainText("Promised dates and supplier replies, 90 days");
    await expect(page.getByTestId("supplier-reliability-note")).toContainText("A measure of its own: on time and OTIF above stay on each order's original promise.");
    // Below the indicator table, whose on time and OTIF columns are as before.
    // A long table scrolls inside a box at most a window tall (src/styles/theme.css,
    // list tables from 640 px), so the block is measured against that box: the
    // table's own box runs on below it while its rows scroll.
    const scrollBox = page.getByTestId("supplier-evaluation-table").locator("xpath=..");
    await expect(scrollBox).toHaveClass(/overflow-x-auto/);
    const tableBox = await scrollBox.boundingBox();
    const blockBox = await block.boundingBox();
    expect(blockBox!.y).toBeGreaterThan(tableBox!.y + tableBox!.height);
    // Not inside the indicator table's card either.
    await expect(page.getByTestId("supplier-evaluation-table").locator("xpath=ancestor::*[@data-testid='supplier-reliability']")).toHaveCount(0);
    await expect(page.getByTestId("supplier-evaluation-table").locator("thead th")).toContainText(["On time, 90 days", "OTIF, 90 days"]);
    await expect(block.locator("thead th")).toHaveText(["Supplier code", "Supplier name", "Orders due", "Date changes per order", "Average days moved", "Replies received", "Replies with a date", "Reply outcomes"]);
    await expect(block.locator("thead th").nth(3)).toHaveAttribute("title", /A first promise is not a change\./);

    const busyRow = block.getByTestId(`supplier-reliability-row-${first.id}`);
    await expect(busyRow.locator("td")).toHaveText([/.+/, first.name, "8", "0.6", "+4.2 days80% later", "6", "80%", "3 recorded · 1 recorded by hand · 1 not recorded · 1 open"]);
    await expectOutcomesAddUp(busyRow);
    await expect(busyRow.locator("td").nth(3).locator("span")).toHaveAttribute("title", "Orders due: 8. Orders with a date change: 3. Date changes: 5.");
    const tooltip = await busyRow.getByTestId("supplier-reliability-outcomes").getAttribute("title");
    expect(tooltip!.split("\n")).toEqual([
      "Recorded as read: 2", "Recorded after an edit: 1", "Recorded by hand: 1", "Not recorded, wrong reading: 1", "Not recorded, supplier will confirm: 0",
      "Not recorded, other reason: 0", "Needs you: 1", "Proposed, not decided: 0", "Nothing to record: 0", "Median time from paste to record: 5.5 hours",
    ]);

    // Under 5: the counts, never a bare "—", with the minimum in the tooltip;
    // an auto-reply reads as nothing to record, not "0 recorded".
    const smallRow = block.getByTestId(`supplier-reliability-row-${second.id}`);
    await expect(smallRow.locator("td")).toHaveText([/.+/, second.name, "2", "1 change · 2 orders", "1 change1/1 later", "1", "0/1", "1 with nothing to record"]);
    await expectOutcomesAddUp(smallRow);
    const counts = smallRow.getByTestId("supplier-reliability-small");
    await expect(counts).toHaveCount(3);
    await expect(counts.first()).toHaveAttribute("title", "Orders due: 2. Orders with a date change: 1. Date changes: 1. A figure needs 5 orders.");
    await expect(counts.last()).toHaveAttribute("title", "0 of 1 replies read gave a date that passed the checks. A percentage needs 5 replies read.");

    // Suppliers with nothing in the window are counted, not listed.
    await expect(block.locator("tbody tr")).toHaveCount(2);
    await expect(page.getByTestId("supplier-reliability-quiet")).toHaveText(rest.length === 1
      ? "1 supplier with no orders due and no replies in these 90 days is not listed."
      : `${rest.length} suppliers with no orders due and no replies in these 90 days are not listed.`);
  });

  test("in Chinese the words translate, and numbers and dates follow the workspace's regional format", async ({ page, request }) => {
    const auth = await signIn(page, request);
    // A Chinese interface in a workspace written in British format.
    await useLanguage(page, "zh-CN", "en-GB");
    const [first] = await suppliersOf(request, auth);
    // 1,250 orders due: a count large enough to be grouped.
    await stubReliability(page, () => ({ json: reliability({ [first.id]: { ...busy, revisions: { ...busy.revisions, orders: 1250, perOrder: 0.004 } } }) }));
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block).toContainText("承诺交期变更与供应商回复（90 天）");
    await expect(block.locator("thead th")).toHaveText(["供应商编号", "供应商名称", "到期订单", "每单交期变更次数", "平均变动天数", "收到的回复", "给出交期的回复", "回复处理结果"]);
    // The window in the workspace's format (en-GB), not the interface's (zh-CN: 2026年8月23日).
    await expect(page.getByTestId("supplier-reliability-note")).toContainText("23 Aug 2026 至 20 Nov 2026。");
    const row = block.getByTestId(`supplier-reliability-row-${first.id}`);
    // A count in a tooltip sentence is grouped in that format too.
    await expect(row.locator("td").nth(3).locator("span")).toHaveAttribute("title", "到期订单：1,250。有交期变更的订单：3。交期变更：5。");
    await expect(row.getByTestId("supplier-reliability-moved")).toHaveText("+4.2 天80% 为推迟");
    await expect(row.getByTestId("supplier-reliability-outcomes")).toHaveText("已记录 3 · 手动记录 1 · 未记录 1 · 待处理 1");
    expect((await row.getByTestId("supplier-reliability-outcomes").getAttribute("title"))!.split("\n").slice(0, 3)).toEqual(["按读取结果记录：2", "修改后记录：1", "手动记录：1"]);
  });

  test("a part the reader may not read is left out and not named; neither part, no block", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const [first, ...others] = await suppliersOf(request, auth);
    const quietLine = (what: string) => others.length === 1 ? `1 supplier with no ${what} in these 90 days is not listed.` : `${others.length} suppliers with no ${what} in these 90 days are not listed.`;
    let visibility = { revisions: true, replies: false };
    const rowFor = () => (visibility.revisions && visibility.replies ? busy : visibility.revisions ? { ...busy, replies: null } : visibility.replies ? { ...busy, revisions: null } : { revisions: null, replies: null });
    await stubReliability(page, () => ({ json: reliability({ [first.id]: rowFor() }, visibility) }));
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block.locator("thead th")).toHaveText(["Supplier code", "Supplier name", "Orders due", "Date changes per order", "Average days moved"]);
    await expect(page.getByTestId("supplier-reliability-quiet")).toHaveText(quietLine("orders due"));
    // Orders hidden: the quiet line speaks of replies only.
    visibility = { revisions: false, replies: true };
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(block.locator("thead th")).toHaveText(["Supplier code", "Supplier name", "Replies received", "Replies with a date", "Reply outcomes"]);
    await expect(page.getByTestId("supplier-reliability-quiet")).toHaveText(quietLine("replies"));
    visibility = { revisions: false, replies: false };
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(block).toHaveCount(0);
    await expect(page.getByTestId("supplier-evaluation-table")).toBeVisible();
  });

  test("a failed read or an answer off the contract says so; an older answer arriving late is dropped", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const [first] = await suppliersOf(request, auth);
    let answer: (call: number) => { status?: number; json: unknown; delay?: number } = () => ({ status: 503, json: { code: "SUPPLIER_RELIABILITY_UNAVAILABLE", message: "Try again." } });
    const stub = await stubReliability(page, (call) => answer(call));
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block.getByRole("alert")).toHaveText("Promised-date changes and replies could not be loaded. Refresh to try again.");
    await expect(page.getByTestId("supplier-evaluation-table")).toBeVisible();
    // A field the contract does not know is refused, not shown half-read.
    answer = () => ({ json: { ...reliability({ [first.id]: busy }), extra: true } });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(block.getByRole("alert")).toBeVisible();
    await expect(block.getByTestId(`supplier-reliability-row-${first.id}`)).toHaveCount(0);
    // Two reads in flight: the first answers late with older figures and is dropped.
    const before = stub.calls();
    answer = (call) => (call === before + 1 ? { json: reliability({ [first.id]: busy }), delay: 1500 } : { json: reliability({ [first.id]: small }) });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => stub.calls()).toBe(before + 1);
    await page.getByRole("button", { name: "Refresh" }).click();
    const perOrder = block.getByTestId(`supplier-reliability-row-${first.id}`).locator("td").nth(3);
    await expect(perOrder).toHaveText("1 change · 2 orders");
    await page.waitForTimeout(2000);
    await expect(perOrder).toHaveText("1 change · 2 orders");
    await expect(block.getByRole("alert")).toHaveCount(0);
  });

  test("a search with no match hides the block, and clearing it shows it again without reading it again", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const [first] = await suppliersOf(request, auth);
    const stub = await stubReliability(page, () => ({ json: reliability({ [first.id]: busy }) }));
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block.getByTestId(`supplier-reliability-row-${first.id}`)).toBeVisible();
    const reads = stub.calls();
    const search = page.getByRole("textbox", { name: "Search suppliers" });
    await search.fill("no supplier is called this");
    await expect(block).toHaveCount(0);
    await search.fill("");
    await expect(block.getByTestId(`supplier-reliability-row-${first.id}`)).toBeVisible();
    await expect(block).not.toContainText("Loading…");
    expect(stub.calls()).toBe(reads);
  });
});
