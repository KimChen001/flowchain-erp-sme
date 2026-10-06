import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDuplicateReviews,
  duplicateBasis,
  findDuplicateFlags,
  invoiceDayKey,
  invoiceTotalKey,
  loadDuplicateFlags,
  normalizeInvoiceNumber,
} from "./supplier-invoice-duplicates.mjs";

const tz = "America/New_York";
const bill = (id, extra = {}) => ({
  id,
  tenantId: "T1",
  supplierId: "SUP-1",
  invoiceNumber: id,
  invoiceDate: new Date("2026-09-10"),
  totalAmount: "100.0000",
  currency: "USD",
  status: "submitted",
  ...extra,
});
const flagsOf = (invoice, candidates) =>
  findDuplicateFlags({ invoice, candidates, timezone: tz }).flags.map((flag) => [flag.kind, flag.otherInvoiceId, flag.daysApart]);

test("invoice numbers are compared without case, spacing, separators or leading zeros", () => {
  assert.equal(normalizeInvoiceNumber("  INV-001 "), "inv1");
  assert.equal(normalizeInvoiceNumber("inv 001"), "inv1");
  assert.equal(normalizeInvoiceNumber("Inv.0001/A"), "inv1a");
  // Unicode hyphens and dashes U+2010 to U+2015.
  assert.equal(normalizeInvoiceNumber("INV‐2024—007"), "inv20247");
  // Full-width letters and digits become plain ones first.
  assert.equal(normalizeInvoiceNumber("ＩＮＶ－００４２"), "inv42");
  // Zeros are dropped per run of digits, before the separators go.
  assert.equal(normalizeInvoiceNumber("INV-2024-001"), "inv20241");
  assert.equal(normalizeInvoiceNumber("inv 2024/1"), "inv20241");
  assert.equal(normalizeInvoiceNumber("A0B00C"), "a0b0c");
  assert.equal(normalizeInvoiceNumber("000"), "0");
  assert.equal(normalizeInvoiceNumber("1000"), "1000");
  assert.equal(normalizeInvoiceNumber(""), null);
  assert.equal(normalizeInvoiceNumber(" - / . "), null);
  assert.equal(normalizeInvoiceNumber(null), null);
  assert.equal(normalizeInvoiceNumber(undefined), null);
});

test("totals are compared as four-decimal amounts", () => {
  assert.equal(invoiceTotalKey({ totalAmount: "100" }), "100.0000");
  assert.equal(invoiceTotalKey({ totalAmount: "100.0000" }), "100.0000");
  assert.equal(invoiceTotalKey({ totalAmount: null, amount: "12.5" }), "12.5000");
  assert.equal(invoiceTotalKey({ totalAmount: null, amount: null }), null);
  assert.equal(invoiceTotalKey({ totalAmount: "abc" }), null);
});

test("a UTC-midnight bill date keeps its date; other times use the workspace day", () => {
  assert.equal(invoiceDayKey(new Date("2026-09-10T00:00:00.000Z"), tz), "2026-09-10");
  // 02:00 UTC is still 9 September in New York.
  assert.equal(invoiceDayKey(new Date("2026-09-10T02:00:00.000Z"), tz), "2026-09-09");
  assert.equal(invoiceDayKey(new Date("2026-09-10T02:00:00.000Z"), "Asia/Shanghai"), "2026-09-10");
  assert.equal(invoiceDayKey(null, tz), null);
});

test("the same supplier and normalized number is a likely duplicate", () => {
  const self = bill("B2", { invoiceNumber: "inv 2024/1", totalAmount: "55.0000" });
  const flags = flagsOf(self, [bill("B1", { invoiceNumber: "INV-2024-001", invoiceDate: new Date("2026-01-01") })]);
  assert.deepEqual(flags, [["likely", "B1", 252]]);
});

test("another supplier's bill is never flagged", () => {
  const self = bill("B2", { invoiceNumber: "INV-1" });
  assert.deepEqual(flagsOf(self, [bill("B1", { invoiceNumber: "INV-1", supplierId: "SUP-2" })]), []);
  assert.deepEqual(flagsOf(self, [bill("B3", { invoiceNumber: "X", supplierId: "SUP-2" })]), []);
});

test("another workspace's bill is never flagged", () => {
  const self = bill("B2", { invoiceNumber: "INV-1" });
  assert.deepEqual(flagsOf(self, [bill("B1", { invoiceNumber: "INV-1", tenantId: "T2" })]), []);
});

test("the same amount in another currency is not a duplicate", () => {
  const self = bill("B2");
  assert.deepEqual(flagsOf(self, [bill("B1", { currency: "EUR" })]), []);
});

test("cancelled and rejected bills are left out", () => {
  const self = bill("B2", { invoiceNumber: "INV-1" });
  assert.deepEqual(flagsOf(self, [bill("B1", { invoiceNumber: "INV-001", status: "cancelled" }), bill("B3", { status: "rejected" })]), []);
  // An approved original still counts.
  assert.deepEqual(flagsOf(self, [bill("B1", { invoiceNumber: "INV-001", status: "approved" })]), [["likely", "B1", 0]]);
});

test("the same amount within seven calendar days is a possible duplicate, eight days is not", () => {
  const self = bill("B0");
  const flags = flagsOf(self, [
    bill("B7", { invoiceDate: new Date("2026-09-17") }),
    bill("B8", { invoiceDate: new Date("2026-09-18") }),
    bill("BM7", { invoiceDate: new Date("2026-09-03") }),
    bill("BM8", { invoiceDate: new Date("2026-09-02") }),
    bill("BS", { invoiceDate: new Date("2026-09-10") }),
  ]);
  assert.deepEqual(flags, [["possible", "BS", 0], ["possible", "B7", 7], ["possible", "BM7", 7]]);
});

test("a likely duplicate is not repeated as a possible one", () => {
  const self = bill("B2", { invoiceNumber: "INV-9" });
  assert.deepEqual(flagsOf(self, [bill("B1", { invoiceNumber: "inv9" })]), [["likely", "B1", 0]]);
});

test("the bill itself is not a candidate, also after it was edited", () => {
  const before = bill("B1", { invoiceNumber: "INV-1" });
  const after = { ...before, invoiceNumber: "INV-0001", version: 2 };
  assert.deepEqual(flagsOf(after, [before]), []);
});

test("100 and 100.0000 are the same total", () => {
  assert.deepEqual(flagsOf(bill("B2", { totalAmount: "100" }), [bill("B1", { totalAmount: "100.0000" })]), [["possible", "B1", 0]]);
  assert.deepEqual(flagsOf(bill("B2", { totalAmount: "100.0001" }), [bill("B1")]), []);
});

test("a bill with no date or no supplier says what was not checked", () => {
  const undated = findDuplicateFlags({ invoice: bill("B2", { invoiceDate: null, invoiceNumber: "Z" }), candidates: [bill("B1"), bill("B3", { invoiceNumber: "z" })], timezone: tz });
  assert.deepEqual(undated.notChecked, ["no_date"]);
  assert.deepEqual(undated.flags.map((flag) => [flag.kind, flag.otherInvoiceId, flag.daysApart]), [["likely", "B3", null]]);
  const noSupplier = findDuplicateFlags({ invoice: bill("B2", { supplierId: null }), candidates: [bill("B1")], timezone: tz });
  assert.deepEqual(noSupplier, { flags: [], notChecked: ["no_supplier"], windowDays: 7 });
  const noNumber = findDuplicateFlags({ invoice: bill("B2", { invoiceNumber: " " }), candidates: [], timezone: tz });
  assert.deepEqual(noNumber.notChecked, ["no_number"]);
  // A candidate without a date is never a possible duplicate.
  assert.deepEqual(flagsOf(bill("B2"), [bill("B1", { invoiceDate: null })]), []);
});

test("a non-midnight date is read in the workspace timezone", () => {
  // 2026-09-18T02:00Z is 17 September in New York: 7 days from the 10th.
  assert.deepEqual(flagsOf(bill("B2"), [bill("B1", { invoiceDate: new Date("2026-09-18T02:00:00.000Z") })]), [["possible", "B1", 7]]);
  assert.deepEqual(
    findDuplicateFlags({ invoice: bill("B2"), candidates: [bill("B1", { invoiceDate: new Date("2026-09-18T02:00:00.000Z") })], timezone: "Asia/Shanghai" }).flags,
    [],
  );
});

test("a dismissal holds only while both bills keep the basis it was given for", () => {
  const self = bill("B2");
  const other = bill("B1");
  const { flags } = findDuplicateFlags({ invoice: self, candidates: [other], timezone: tz });
  const review = { id: "R1", otherInvoiceId: "B1", kind: "possible", basis: flags[0].basis, reason: "Two deliveries", dismissedAt: new Date("2026-09-11") };
  const dismissed = applyDuplicateReviews(flags, [review]);
  assert.equal(dismissed.flags[0].status, "dismissed");
  assert.equal(dismissed.openFlags.length, 0);
  assert.equal(dismissed.reviews[0].stale, false);

  // The other bill moved a day: the same flag again, but on a new basis.
  const moved = findDuplicateFlags({ invoice: self, candidates: [{ ...other, invoiceDate: new Date("2026-09-11") }], timezone: tz }).flags;
  const reopened = applyDuplicateReviews(moved, [review]);
  assert.equal(reopened.flags[0].status, "open");
  assert.equal(reopened.reviews[0].stale, true);

  // A dismissal of another kind does not cover this flag.
  assert.equal(applyDuplicateReviews(flags, [{ ...review, kind: "likely" }]).openFlags.length, 1);
  assert.deepEqual(duplicateBasis(self, tz), { numberKey: "b2", currency: "USD", total: "100.0000", day: "2026-09-10" });
});

test("the loader asks for the supplier's bills in the workspace and the window", async () => {
  const calls = [];
  const db = { supplierInvoice: { findMany: async (args) => { calls.push(args); return [bill("B1", { invoiceNumber: "INV-1" }), bill("B1", { invoiceNumber: "INV-1" })]; } } };
  const result = await loadDuplicateFlags(db, { tenantId: "T1", invoice: bill("B2", { invoiceNumber: "inv1" }), timezone: tz });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.where.tenantId, "T1");
    assert.equal(call.where.supplierId, "SUP-1");
    assert.deepEqual(call.where.id, { not: "B2" });
    assert.deepEqual(call.where.status, { notIn: ["cancelled", "rejected"] });
  }
  assert.equal(calls[1].where.currency, "USD");
  assert.equal(calls[1].where.invoiceDate.gte.toISOString(), "2026-09-02T00:00:00.000Z");
  assert.equal(calls[1].where.invoiceDate.lt.toISOString(), "2026-09-19T00:00:00.000Z");
  assert.deepEqual(result.flags.map((flag) => flag.kind), ["likely"]);
  const none = await loadDuplicateFlags(db, { tenantId: "T1", invoice: bill("B2", { supplierId: "" }), timezone: tz });
  assert.deepEqual(none.notChecked, ["no_supplier"]);
  assert.equal(calls.length, 2);
});
