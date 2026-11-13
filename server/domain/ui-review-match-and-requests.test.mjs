import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source contracts for the seventh UI review, on the three-way match pages,
// the purchase request detail, the prefilled request form and the reorder
// list. The browser specs check the rendered pages; these keep the fixes from
// drifting back.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the three-way match list names each match by its invoice number and searches the numbers people read", () => {
  const source = read("src/modules/procurement/ThreeWayMatchListPage.tsx");
  // The link text is the invoice number (the id only when none is recorded), never the match id.
  assert.match(source, /const invoiceOf = \(row: MatchRow\) => row\.invoiceNumber \|\| row\.invoiceId \|\| row\.id/);
  assert.match(source, /entityType="three_way_match" entityId=\{row\.id\} className=\{tableLinkClass\}>\{invoiceOf\(row\)\}</);
  assert.doesNotMatch(source, />\{row\.id\}</);
  // The receipt by its GRN number; the invoice is not repeated in the documents cell.
  assert.match(source, /entityType="receiving_doc" entityId=\{row\.grnId\}>\{receiptOf\(row\) \|\| "—"\}</);
  assert.doesNotMatch(source, /entityType="supplier_invoice"/);
  // Search covers the invoice, PO and GRN numbers as well as the ids.
  assert.match(source, /\[row\.invoiceNumber, row\.poNumber, row\.grnNumber, row\.id, poOf\(row\), row\.grnId, row\.invoiceId\]/);
  // Six columns that fit 1440 px: no whole-PO amount column, a narrower table.
  assert.doesNotMatch(source, /poAmount/);
  assert.match(source, /min-w-\[900px\]/);
  assert.doesNotMatch(source, /colSpan=\{7\}/);
});

test("the three-way match page is titled by the invoice number and never shows a stored id", () => {
  const source = read("src/modules/procurement/ProcurementDocumentDetailPage.tsx");
  assert.match(source, /const readable = \(value\?: string\) => \(value && !looksLikeStoredId\(value\) \? value : ""\)/);
  assert.match(source, /const invoiceNumber = record\?\.invoiceNumber \|\| readable\(invoiceId\)/);
  // Without a number the heading says what the page is, and the breadcrumb (and so "Back to …") is not named by an id.
  assert.match(source, /: copy\(isInvoice \? "Supplier invoice" : "Three-way match"\);/);
  assert.match(source, /useDetailCrumb\(state === "loaded" \? invoiceNumber \|\| null : null\)/);
  assert.match(source, /entityType="receiving_doc" entityId=\{grnId\}>\{grnNumber \|\| "—"\}</);
  assert.match(source, /entityType="supplier_invoice" entityId=\{invoiceId\}>\{record\.invoiceNumber \|\| invoiceId \|\| "—"\}</);
});

test("a purchase request's detail header offers the list row's actions, by status and permission, and says what happened", () => {
  const source = read("src/modules/purchase-requests/CanonicalProcurementPanel.tsx");
  // One table of actions by status, each with the permission the server checks.
  assert.match(source, /submitted: \["approve", "reject", "withdraw"\]/);
  assert.match(source, /approved: \["generate-purchase-orders"\]/);
  assert.match(source, /approve: "procurement\.purchase_order\.approve"/);
  assert.match(source, /reject: "procurement\.purchase_order\.reject"/);
  assert.match(source, /"generate-purchase-orders": "procurement\.purchase_order\.revise"/);
  // The list row and the detail header both draw them from actionsFor.
  assert.match(source, /const rowActions = actionsFor\(pr\);/);
  assert.match(source, /const detailActions = \[\.\.\.actionsFor\(selected\)\]/);
  assert.match(source, /"pr-detail-create-po" : `pr-detail-\$\{action\}`/);
  // The reject and withdraw dialogs open on the detail page too.
  const detail = source.slice(source.indexOf("if (selected && !editingSelected) {"), source.indexOf("if (!formOpen) {"));
  assert.match(detail, /\{confirmDialog\.element\}/);
  // Feedback by number after each action.
  assert.match(source, /approved: \["Approved \{number\}", "已批准 \{number\}"\]/);
  assert.match(source, /if \(done\) toast\.success\(done\.replace\("\{number\}", number\)\);/);
});

test("a purchase request's header drops the version, uses full-width colons in Chinese, and words units", () => {
  const source = read("src/modules/purchase-requests/CanonicalProcurementPanel.tsx");
  assert.doesNotMatch(source, /· v\{selected\.version\}/);
  assert.match(source, /`\$\{label\}\$\{language === "en-US" \? ": " : "："\}\$\{value\}`/);
  assert.match(source, /unitLabel\(line\.unitSnapshot, language, Number\.isFinite\(quantity\) \? quantity : null\)/);
  assert.doesNotMatch(source, /\$\{line\.quantity\} \$\{line\.unitSnapshot/);
  // The lines table fits a 1440 px window.
  assert.doesNotMatch(source, /min-w-\[980px\]/);
  assert.match(source, /tr\("deliverTo"\)/);
});

test("a request state has one name on the request pages: the tiles use the status chip's label", () => {
  const source = read("src/modules/purchase-requests/CanonicalProcurementPanel.tsx");
  for (const status of ["draft", "submitted", "approved", "converted"]) {
    assert.match(source, new RegExp(`<ActionableMetricCard label=\\{statusLabel\\("${status}"\\)\\}`));
  }
  assert.match(source, /converted: \["Converted to PO", "已转采购订单"\]/);
  assert.match(source, /status === "converted" \? tr\("converted"\)/);
  assert.doesNotMatch(source, /"待审批"|"待生成采购订单"/);
});

test("a quantity raised to the supplier's minimum is labelled as that, with the shortfall", () => {
  const reorder = read("src/modules/inventory/ReorderListPage.tsx");
  assert.match(reorder, /params\.set\("quantityFrom", "supplier_minimum"\);\s*params\.set\("shortfall", String\(row\.shortfall\)\);/);
  const panel = read("src/modules/purchase-requests/CanonicalProcurementPanel.tsx");
  assert.match(panel, /query\.get\("quantityFrom"\) !== "supplier_minimum" \|\| quantity\?\.ref !== "reorder_list:gap"/);
  assert.match(panel, /ref: "reorder_list:supplier_minimum"/);
  const chip = read("src/components/prefill/PrefillSource.tsx");
  assert.match(chip, /"reorder_list:supplier_minimum": \["Supplier minimum \(shortfall \{shortfall\}\)", "按供应商最小起订量（缺口 \{shortfall\}）"\]/);
  assert.match(chip, /"reorder_list:supplier_minimum": \["Supplier minimum", "按供应商最小起订量"\]/);
});

test("the RFQ note on a prefilled request points to a step that exists", () => {
  const chip = read("src/components/prefill/PrefillSource.tsx");
  assert.doesNotMatch(chip, /create the RFQ from it|再从申请创建询价单/);
  assert.match(chip, /ask the assistant to request quotes for it/);
});

test("the reorder list folds its method behind a toggle on phones and says 库存位置（含在途）", () => {
  const page = read("src/modules/inventory/ReorderListPage.tsx");
  assert.match(page, /const showMethod = !phone \|\| methodOpen;/);
  assert.match(page, /data-testid="reorder-list-method-toggle"/);
  assert.match(page, /aria-expanded=\{methodOpen\}/);
  // The prefilled reason words its units in the interface language.
  assert.match(page, /position: withUnit\(row\.position, row\.unit, t\.language\), reorderPoint: withUnit\(row\.reorderPoint, row\.unit, t\.language\)/);
  const copy = read("src/modules/inventory/reorderListCopy.ts");
  assert.doesNotMatch(copy, /头寸/);
  assert.match(copy, /reason: "补货清单：库存位置（含在途）\{position\}/);
  assert.match(copy, /methodToggle: "How this is worked out"/);
  assert.match(copy, /methodToggle: "计算方法"/);
});
