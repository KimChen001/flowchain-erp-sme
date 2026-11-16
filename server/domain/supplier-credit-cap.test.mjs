import assert from "node:assert/strict";
import test from "node:test";
import { buildSupplierCreditMemoPlan } from "./operational-finance-policy.mjs";

// A where clause read the way Prisma reads it, for the shapes the plan uses:
// equality, { in: [...] }, OR / AND lists, and a to-one relation as a nested
// object. The stand-in answers only what the where asks for, so a query that
// leaves out a condition is caught here rather than in production.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return condition.some((entry) => matches(row, entry));
    if (key === "AND") return condition.every((entry) => matches(row, entry));
    const value = row[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("in" in condition) return condition.in.includes(value);
      return value && typeof value === "object" && matches(value, condition);
    }
    return value === condition;
  });
}

const tenantId = "tenant-credit-cap";

// One receipt line of 10 billed in two parts: bill A 6, bill B 4. A supplier
// return of 5 from that receipt line.
function facts({ priorCredits = [], billStatus = "approved" } = {}) {
  const invoices = [
    {
      id: "BILL-A",
      tenantId,
      status: billStatus,
      currency: "USD",
      supplierId: "SUP-1",
      supplierName: "Supplier",
      lines: [
        { id: "BILL-A-1", receivingLineId: "GRNL-1", itemId: "ITEM-1", sku: "SKU-1", quantity: "6.0000", unitPrice: "10.0000", enteredTaxAmount: "6.0000" },
      ],
    },
    {
      id: "BILL-B",
      tenantId,
      status: billStatus,
      currency: "USD",
      supplierId: "SUP-1",
      supplierName: "Supplier",
      lines: [
        { id: "BILL-B-1", receivingLineId: "GRNL-1", itemId: "ITEM-1", sku: "SKU-1", quantity: "4.0000", unitPrice: "10.0000", enteredTaxAmount: "4.0000" },
      ],
    },
  ];
  const posting = (id, lineId, quantity) => ({
    id,
    tenantId,
    postingNumber: id,
    postingType: "supplier_return_dispatch",
    postingStatus: "posted",
    reversedAt: null,
    lines: [
      {
        id: lineId,
        itemId: "ITEM-1",
        sku: "SKU-1",
        quantity,
        returnAuthorizationLine: { returnRequestLine: { sourceDocumentLineId: "GRNL-1" } },
      },
    ],
  });
  const postings = [posting("RP-1", "RPL-1", "5.0000"), posting("RP-2", "RPL-2", "3.0000")];
  const creditLines = priorCredits.map((row) => ({
    supplierInvoiceLineId: row.invoiceLineId,
    returnPostingLineId: row.returnLineId,
    quantity: row.quantity,
    supplierCreditMemo: { tenantId, status: row.status },
  }));
  return {
    supplierInvoice: { findFirst: async ({ where }) => invoices.find((row) => matches(row, where)) || null },
    returnPostingDocument: { findFirst: async ({ where }) => postings.find((row) => matches(row, where)) || null },
    supplierCreditMemoLine: { findMany: async ({ where }) => creditLines.filter((row) => matches(row, where)) },
    supplierCreditMemo: { findUnique: async () => null },
  };
}

const request = (invoiceId, invoiceLineId, quantity, extra = {}, postingId = "RP-1", returnLineId = "RPL-1") => ({
  creditMemoNumber: "SCM-NEW",
  supplierInvoiceId: invoiceId,
  returnPostingId: postingId,
  currency: "USD",
  lines: [
    {
      supplierInvoiceLineId: invoiceLineId,
      returnPostingLineId: returnLineId,
      quantity,
      pricingSource: "original_invoice",
      enteredTaxAmount: "0.0000",
      ...extra,
    },
  ],
});
const codes = (plan) => plan.blockingIssues.map((entry) => entry.code);

test("a return credited in full on bill A cannot be credited again on bill B (L8-01)", async () => {
  const prisma = facts({ priorCredits: [{ invoiceLineId: "BILL-A-1", returnLineId: "RPL-1", quantity: "5.0000", status: "approved" }] });
  const plan = await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-B", "BILL-B-1", "1.0000") });
  assert.equal(plan.allowed, false);
  assert.deepEqual(codes(plan), ["SUPPLIER_CREDIT_QUANTITY_EXCEEDED"]);
});

test("a draft credit holds the return's quantity too, and a cancelled one does not", async () => {
  const draft = facts({ priorCredits: [{ invoiceLineId: "BILL-A-1", returnLineId: "RPL-1", quantity: "5.0000", status: "draft" }] });
  assert.deepEqual(
    codes(await buildSupplierCreditMemoPlan({ prisma: draft, tenantId, input: request("BILL-B", "BILL-B-1", "1.0000") })),
    ["SUPPLIER_CREDIT_QUANTITY_EXCEEDED"],
  );
  const cancelled = facts({ priorCredits: [{ invoiceLineId: "BILL-A-1", returnLineId: "RPL-1", quantity: "5.0000", status: "cancelled" }] });
  const plan = await buildSupplierCreditMemoPlan({ prisma: cancelled, tenantId, input: request("BILL-B", "BILL-B-1", "4.0000") });
  assert.equal(plan.allowed, true, JSON.stringify(plan.blockingIssues));
  assert.equal(plan.creditMemo.totalAmount, "40.0000");
});

test("what is left of a return can still be credited on the other bill", async () => {
  const prisma = facts({ priorCredits: [{ invoiceLineId: "BILL-A-1", returnLineId: "RPL-1", quantity: "3.0000", status: "approved" }] });
  const plan = await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-B", "BILL-B-1", "2.0000") });
  assert.equal(plan.allowed, true, JSON.stringify(plan.blockingIssues));
  assert.deepEqual(
    codes(await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-B", "BILL-B-1", "3.0000") })),
    ["SUPPLIER_CREDIT_QUANTITY_EXCEEDED"],
  );
});

test("a bill line is credited at most its billed quantity across several returns (L2-18)", async () => {
  // Bill B billed 4; return RP-1 already credited 3 of them, so return RP-2
  // can add 1 more on that line and not 2.
  const prisma = facts({ priorCredits: [{ invoiceLineId: "BILL-B-1", returnLineId: "RPL-1", quantity: "3.0000", status: "approved" }] });
  assert.equal(
    (await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-B", "BILL-B-1", "1.0000", {}, "RP-2", "RPL-2") })).allowed,
    true,
  );
  assert.deepEqual(
    codes(await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-B", "BILL-B-1", "2.0000", {}, "RP-2", "RPL-2") })),
    ["SUPPLIER_CREDIT_QUANTITY_EXCEEDED"],
  );
});

test("a reviewed price above the bill's price and tax above the bill's share are refused (L2-18)", async () => {
  const prisma = facts();
  assert.deepEqual(
    codes(await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-A", "BILL-A-1", "2.0000", { pricingSource: "manual_reviewed", unitPrice: "10.5000" }) })),
    ["SUPPLIER_CREDIT_PRICE_EXCEEDS_INVOICE"],
  );
  const lower = await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-A", "BILL-A-1", "2.0000", { pricingSource: "manual_reviewed", unitPrice: "9.0000" }) });
  assert.equal(lower.allowed, true);
  assert.equal(lower.creditMemo.subtotalAmount, "18.0000");
  // Bill A carries 6.0000 tax on 6 units: 2 units may carry 2.0000.
  assert.equal(
    (await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-A", "BILL-A-1", "2.0000", { enteredTaxAmount: "2.0000" }) })).allowed,
    true,
  );
  assert.deepEqual(
    codes(await buildSupplierCreditMemoPlan({ prisma, tenantId, input: request("BILL-A", "BILL-A-1", "2.0000", { enteredTaxAmount: "2.0001" }) })),
    ["SUPPLIER_CREDIT_TAX_EXCEEDS_INVOICE"],
  );
});

test("a credit needs a bill that was submitted and is not cancelled (L8-11)", async () => {
  for (const billStatus of ["draft", "cancelled"])
    assert.deepEqual(
      codes(await buildSupplierCreditMemoPlan({ prisma: facts({ billStatus }), tenantId, input: request("BILL-A", "BILL-A-1", "1.0000") })),
      ["SUPPLIER_CREDIT_INVOICE_STATUS_INVALID"],
      billStatus,
    );
  for (const billStatus of ["submitted", "exception", "matched", "approved", "held"])
    assert.equal(
      (await buildSupplierCreditMemoPlan({ prisma: facts({ billStatus }), tenantId, input: request("BILL-A", "BILL-A-1", "1.0000") })).allowed,
      true,
      billStatus,
    );
});
