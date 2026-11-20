import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
async function useLanguage(page: Page, language: "en-US" | "zh-CN") {
  await page.unroute("**/api/me/localization");
  await page.route("**/api/me/localization", async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), languagePreference: language, effectiveLanguage: language } }); });
}
// The workspace's suppliers, by name, as the page lists them.
async function suppliersOf(request: APIRequestContext, auth: { headers: Record<string, string> }) {
  const list = await (await request.get("/api/master-data/suppliers", auth)).json();
  const suppliers = (list.suppliers as Array<{ id: string; supplierName?: string; name?: string }>).map((row) => ({ id: row.id, name: row.supplierName || row.name || row.id }));
  expect(suppliers.length).toBeGreaterThanOrEqual(3);
  return suppliers;
}

const outcomes = { recordedUnchanged: 2, recordedEdited: 1, notRecorded: { wrong_reading: 1, supplier_will_confirm: 0, other: 0 }, needsYou: 1, proposed: 0, nothingToRecord: 1 };
const busy = {
  revisions: { orders: 8, revisedOrders: 3, revisions: 5, perOrder: 0.625, averageDaysMoved: 4.2, movedLater: { count: 4, of: 5, share: 0.8 } },
  replies: { received: 6, read: 5, withStatedDate: { count: 4, of: 5, share: 0.8 }, outcomes, recorded: 3, medianHoursToRecord: 5.5 },
};
const small = {
  revisions: { orders: 2, revisedOrders: 1, revisions: 1, perOrder: null, averageDaysMoved: null, movedLater: { count: 1, of: 1, share: null } },
  replies: { received: 1, read: 1, withStatedDate: { count: 1, of: 1, share: null }, outcomes: { ...outcomes, recordedUnchanged: 1, recordedEdited: 0, notRecorded: { wrong_reading: 0, supplier_will_confirm: 0, other: 0 }, needsYou: 0, nothingToRecord: 0 }, recorded: 1, medianHoursToRecord: null },
};
const quiet = {
  revisions: { orders: 0, revisedOrders: 0, revisions: 0, perOrder: null, averageDaysMoved: null, movedLater: { count: 0, of: 0, share: null } },
  replies: { received: 0, read: 0, withStatedDate: { count: 0, of: 0, share: null }, outcomes: { recordedUnchanged: 0, recordedEdited: 0, notRecorded: { wrong_reading: 0, supplier_will_confirm: 0, other: 0 }, needsYou: 0, proposed: 0, nothingToRecord: 0 }, recorded: 0, medianHoursToRecord: null },
};
const hide = <T extends Record<string, unknown>>(row: T, part: "revisions" | "replies") => ({ ...row, [part]: null });

function reliability(suppliers: Record<string, unknown>, visibility = { revisions: true, replies: true }) {
  const value = { contractVersion: SUPPLIER_RELIABILITY_CONTRACT_VERSION, asOf: "2026-11-20", window: { from: "2026-08-23", to: "2026-11-20", days: 90 }, minimumSample: 5, visibility, suppliers };
  const parsed = supplierReliabilityResponseSchema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return value;
}
async function stubReliability(page: Page, answer: () => { status?: number; json: unknown }) {
  await page.route(`**${SUPPLIER_RELIABILITY_ROUTE}`, (route) => { const { status = 200, json } = answer(); return route.fulfill({ status, json }); });
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
    const tableBox = await page.getByTestId("supplier-evaluation-table").boundingBox();
    const blockBox = await block.boundingBox();
    expect(blockBox!.y).toBeGreaterThan(tableBox!.y + tableBox!.height);
    await expect(page.getByTestId("supplier-evaluation-table").locator("thead th")).toContainText(["On time, 90 days", "OTIF, 90 days"]);
    await expect(block.locator("thead th")).toHaveText(["Supplier code", "Supplier name", "Orders due", "Date changes per order", "Average days moved", "Replies received", "Replies with a date", "Reply outcomes"]);
    await expect(block.locator("thead th").nth(3)).toHaveAttribute("title", /A first promise is not a change\./);

    const busyRow = block.getByTestId(`supplier-reliability-row-${first.id}`);
    await expect(busyRow.locator("td")).toHaveText([/.+/, first.name, "8", "0.6", "+4.2 days80% later", "6", "80%", "3 recorded · 1 not recorded · 1 open"]);
    await expect(busyRow.locator("td").nth(3).locator("span")).toHaveAttribute("title", "Orders due: 8. Orders with a date change: 3. Date changes: 5.");
    const tooltip = await busyRow.getByTestId("supplier-reliability-outcomes").getAttribute("title");
    expect(tooltip!.split("\n")).toEqual([
      "Recorded as read: 2", "Recorded after an edit: 1", "Not recorded, wrong reading: 1", "Not recorded, supplier will confirm: 0",
      "Not recorded, other reason: 0", "Needs you: 1", "Proposed, not decided: 0", "Nothing to record: 1", "Median time to record: 5.5 hours",
    ]);

    // Under 5: "—", with the counts and the minimum in the tooltip.
    const smallRow = block.getByTestId(`supplier-reliability-row-${second.id}`);
    await expect(smallRow.locator("td").nth(3)).toHaveText("—");
    await expect(smallRow.getByTestId("supplier-reliability-small")).toHaveCount(3);
    await expect(smallRow.getByTestId("supplier-reliability-small").first()).toHaveAttribute("title", "Orders due: 2. Orders with a date change: 1. Date changes: 1. A figure needs 5 orders.");
    await expect(smallRow.getByTestId("supplier-reliability-small").last()).toHaveAttribute("title", "1 of 1 replies read gave a date that passed the checks. A percentage needs 5 replies read.");

    // Suppliers with nothing in the window are counted, not listed.
    await expect(block.locator("tbody tr")).toHaveCount(2);
    await expect(page.getByTestId("supplier-reliability-quiet")).toHaveText(rest.length === 1
      ? "1 supplier with no orders due and no replies in these 90 days is not listed."
      : `${rest.length} suppliers with no orders due and no replies in these 90 days are not listed.`);
  });

  test("in Chinese the words translate and the figures keep the workspace's number format", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "zh-CN");
    const [first] = await suppliersOf(request, auth);
    await stubReliability(page, () => ({ json: reliability({ [first.id]: busy }) }));
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block).toContainText("承诺交期变更与供应商回复（90 天）");
    await expect(block.locator("thead th")).toHaveText(["供应商编号", "供应商名称", "到期订单", "每单交期变更次数", "平均变动天数", "收到的回复", "给出交期的回复", "回复处理结果"]);
    const row = block.getByTestId(`supplier-reliability-row-${first.id}`);
    await expect(row.getByTestId("supplier-reliability-moved")).toHaveText("+4.2 天80% 为推迟");
    await expect(row.getByTestId("supplier-reliability-outcomes")).toHaveText("已记录 3 · 未记录 1 · 待处理 1");
    expect((await row.getByTestId("supplier-reliability-outcomes").getAttribute("title"))!.split("\n")[0]).toBe("按读取结果记录：2");
  });

  test("a part the reader may not read is left out, never shown as zeros; neither part, no block", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const [first] = await suppliersOf(request, auth);
    let visibility = { revisions: true, replies: false };
    await stubReliability(page, () => ({ json: reliability({ [first.id]: visibility.replies ? busy : visibility.revisions ? hide(busy, "replies") : { revisions: null, replies: null } }, visibility) }));
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block.locator("thead th")).toHaveText(["Supplier code", "Supplier name", "Orders due", "Date changes per order", "Average days moved"]);
    visibility = { revisions: false, replies: false };
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(block).toHaveCount(0);
    await expect(page.getByTestId("supplier-evaluation-table")).toBeVisible();
  });

  test("a failed read or an answer off the contract says so and leaves the indicators", async ({ page, request }) => {
    const auth = await signIn(page, request);
    await useLanguage(page, "en-US");
    const [first] = await suppliersOf(request, auth);
    let answer: { status?: number; json: unknown } = { status: 503, json: { code: "SUPPLIER_RELIABILITY_UNAVAILABLE", message: "Try again." } };
    await stubReliability(page, () => answer);
    await page.goto("/app/master-data/supplier-evaluation");
    const block = page.getByTestId("supplier-reliability");
    await expect(block.getByRole("alert")).toHaveText("Promised-date changes and replies could not be loaded. Refresh to try again.");
    await expect(page.getByTestId("supplier-evaluation-table")).toBeVisible();
    // Refresh reads it again.
    answer = { json: reliability({ [first.id]: busy }) };
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(block.getByTestId(`supplier-reliability-row-${first.id}`)).toBeVisible();
    await expect(block.getByRole("alert")).toHaveCount(0);
    // A field the contract does not know is refused, not shown half-read.
    answer = { json: { ...reliability({ [first.id]: busy }), extra: true } };
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(block.getByRole("alert")).toBeVisible();
    await expect(block.getByTestId(`supplier-reliability-row-${first.id}`)).toHaveCount(0);
  });
});
