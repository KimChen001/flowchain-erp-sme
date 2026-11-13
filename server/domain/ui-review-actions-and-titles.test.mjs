import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source contracts for the second UI review: actions that change records ask
// first, as their siblings do; ids and old formats are not shown; and every
// detail page has one H1 title in the shared page-title style.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("setting a customer active or inactive asks first, as a supplier does", () => {
  const source = read("src/modules/master-data/StandardMasterTables.tsx");
  assert.match(source, /const confirmDialog = useConfirm\(\)/);
  assert.match(source, /const setStatus = async[\s\S]*?await confirmDialog\.confirm\([\s\S]*?if \(!confirmed\) return;[\s\S]*?\? "activate" : "deactivate"/);
  assert.match(source, /say\(`Set \$\{name\} inactive\?`, `停用 \$\{name\}？`\)/);
  assert.match(source, /\{confirmDialog\.element\}/);
});

test("withdrawing a purchase request from the list asks first", () => {
  const source = read("src/modules/purchase-requests/CanonicalProcurementPanel.tsx");
  assert.match(source, /withdrawTitle: \["Withdraw \{number\}\?", "撤回 \{number\}？"\]/);
  assert.match(source, /action === "withdraw" &&\s*!\(await confirmDialog\.confirm\(\{[\s\S]*?tr\("withdrawTitle"\)[\s\S]*?\}\)\)\s*\)\s*return;[\s\S]*?\/api\/procurement\/requests\/\$\{pr\.id\}\/\$\{action\}/);
});

test("Users & roles names a role change before it applies and shows warehouses by name", () => {
  const source = read("src/modules/settings/AuthorizationWorkbench.tsx");
  assert.match(source, /const assign = async \(user: User, roleId: string, enabled: boolean\) => \{[\s\S]*?await confirmDialog\.confirm\(\{[\s\S]*?`Give \$\{who\} the \$\{what\} role\?`[\s\S]*?`Remove the \$\{what\} role from \$\{who\}\?`[\s\S]*?if \(!confirmed\) return;[\s\S]*?\/api\/authorization\/users\//);
  assert.match(source, /\/api\/master-data\/warehouses/);
  assert.match(source, /String\(row\.name \|\| ""\)\.trim\(\) \|\| String\(row\.code \|\| ""\)\.trim\(\)/);
  assert.match(source, /\$\{warehouseLabel\(scope\.warehouseId\)\} · \$\{accessName\(scope\.accessLevel\)\}/);
  assert.doesNotMatch(source, /\$\{scope\.warehouseId\} ·/);
});

test("Add supplied item is disabled until an item is picked", () => {
  const source = read("src/modules/srm/Page.tsx");
  assert.match(source, /data-testid="add-supplied-item"[\s\S]{0,120}disabled=\{!relationForm\.itemId\}/);
});

test("Supplied items are paged 25 at a time with the shared list pager and the true total", () => {
  const source = read("src/modules/srm/Page.tsx");
  assert.match(source, /const SUPPLIED_ITEM_PAGE_SIZE = 25;/);
  assert.match(source, /usePagedRows\(relationships, SUPPLIED_ITEM_PAGE_SIZE, selected\?\.id \|\| ""\)/);
  assert.match(source, /suppliedItems\.pageRows\.map\(\(r, index\) =>/);
  assert.match(source, /<ListPager page=\{suppliedItems\.page\} pageSize=\{SUPPLIED_ITEM_PAGE_SIZE\} total=\{relationships\.length\}[^>]*testId="supplied-item-pager"/);
  // The add-supplied-item row stays above the table.
  assert.ok(source.indexOf('data-testid="add-supplied-item"') < source.indexOf("suppliedItems.pageRows.map"));
});

test("PO list filters use date inputs and the current PO number format", () => {
  const source = read("src/modules/purchasing/Page.tsx");
  assert.match(source, /<input type="date" value=\{filters\.etaFrom\}/);
  assert.match(source, /<input type="date" value=\{filters\.etaTo\}/);
  assert.match(source, /placeholder="PO-202611-0001"/);
  assert.doesNotMatch(source, /PO-2026-1287|placeholder="2026-06-0?1"|placeholder="2026-06-30"/);
});

test("Today says when nothing changed today and words units in the interface language", () => {
  const page = read("src/modules/overview/Page.tsx");
  const copy = read("src/modules/overview/todayCopy.ts");
  assert.match(page, /import \{ unitLabel \} from "\.\.\/\.\.\/i18n\/unitLabels"/);
  assert.match(page, /unitLabel\(unit, t\.language, Number\(value\)\)/);
  assert.match(page, /t\("changesNone"\)/);
  assert.match(page, /t\("changesNoneLast", \{ date: day\(lastChangeDay\) \}\)/);
  assert.doesNotMatch(page, /t\("changesShort", \{ date: day\(today\) \}\)/);
  assert.match(copy, /changesNone: "Nothing changed today"/);
  assert.match(copy, /changesNone: "今天没有更改"/);
});

test("contract detail actions are keyed", () => {
  const source = read("src/modules/contracts/ContractDetailPage.tsx");
  assert.match(source, /<button key=\{testId\} type="button" data-testid=\{testId\}/);
});

test("detail page titles are one H1 in the shared page-title style", () => {
  const titled = {
    "src/components/document/DocumentShell.tsx": /<h1 className="fc-page-title"[^>]*>\{copy\(title\)\}<\/h1>/,
    "src/modules/finance/SupplierInvoiceScreens.tsx": /<h1 className="fc-page-title"[^>]*>\{data\.invoiceNumber\}<\/h1>/,
    "src/modules/finance/OperationalFinanceO2cWorkbench.tsx": /<h1 className="fc-page-title"[^>]*>\{data\.invoiceNumber\}<\/h1>/,
    "src/modules/procurement/ProcurementDocumentDetailPage.tsx": /<h1 className="fc-page-title"[^>]*data-testid="procurement-document-heading">\{heading\}<\/h1>/,
    "src/modules/sales/OutboundWorkbench.tsx": /<h1 className="fc-page-title">\{data\.order\.orderNumber\}<\/h1>/,
    "src/modules/srm/Page.tsx": /<h1 className="fc-page-title">\{selected\.supplierName\}<\/h1>/,
    "src/modules/purchase-requests/CanonicalProcurementPanel.tsx": /<h1 className="fc-page-title"[^>]*>\{numberOf\(selected\)\}<\/h1>/,
    "src/modules/receiving/ReceivingPostingWorkbench.tsx": /<h1 className="fc-page-title">\{grn\.documentNumber\}<\/h1>/,
    "src/modules/procurement/CanonicalRfqDetailPage.tsx": /<h1 className="fc-page-title mt-1">/,
    "src/modules/procurement/CanonicalRfqComparisonPage.tsx": /<h1 className="fc-page-title mt-1">/,
    "src/components/business/BusinessEntityDetailPage.tsx": /<h1 className="fc-page-title mt-1 tabular-nums"/,
  };
  for (const [path, pattern] of Object.entries(titled)) assert.match(read(path), pattern, path);
  // The item is the H1 on its own page, an H2 when opened in place under the list's H1.
  const item = read("src/modules/master-data/ItemMasterWorkbench.tsx");
  assert.match(item, /const ItemTitle = onDetailRoute \? "h1" : "h2"/);
  // "Back to items" sits above the card since UI review 9, so the title starts the card.
  assert.match(item, /<ItemTitle className=\{onDetailRoute \? "fc-page-title"/);
});
