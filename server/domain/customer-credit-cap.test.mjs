import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerCreditNotePlan } from "./operational-finance-o2c-policy.mjs";

// Reads a where clause as Prisma does for the shapes the plan uses, so a query
// that leaves out a condition is caught (see supplier-credit-cap.test.mjs).
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

const tenantId = "tenant-customer-credit-cap";

// One shipment line of 10 invoiced in two parts: invoice A 6, invoice B 4. A
// customer return of 5 received from that shipment line.
function facts({ priorCredits = [] } = {}) {
  const invoice = (id, lineId, quantity, tax) => ({
    id,
    tenantId,
    status: "issued",
    currency: "USD",
    customerId: "CUST-1",
    customerNameSnapshot: "Customer",
    lines: [{ id: lineId, shipmentLineId: "SHIPL-1", itemId: "ITEM-1", sku: "SKU-1", quantity, unitPrice: "12.5000", enteredTaxAmount: tax }],
  });
  const invoices = [invoice("INV-A", "INV-A-1", "6.0000", "6.0000"), invoice("INV-B", "INV-B-1", "4.0000", "4.0000")];
  const postings = [
    {
      id: "RP-1",
      tenantId,
      postingNumber: "RP-1",
      postingType: "customer_return_receipt",
      postingStatus: "posted",
      reversedAt: null,
      lines: [{ id: "RPL-1", itemId: "ITEM-1", sku: "SKU-1", quantity: "5.0000", returnAuthorizationLine: { returnRequestLine: { sourceDocumentLineId: "SHIPL-1" } } }],
    },
  ];
  const creditLines = priorCredits.map((row) => ({
    customerInvoiceLineId: row.invoiceLineId,
    returnPostingLineId: row.returnLineId,
    quantity: row.quantity,
    customerCreditNote: { tenantId, status: row.status },
  }));
  return {
    customerInvoice: { findFirst: async ({ where }) => invoices.find((row) => matches(row, where)) || null },
    returnPostingDocument: { findFirst: async ({ where }) => postings.find((row) => matches(row, where)) || null },
    customerCreditNoteLine: { findMany: async ({ where }) => creditLines.filter((row) => matches(row, where)) },
  };
}

const request = (invoiceId, invoiceLineId, quantity, extra = {}) => ({
  creditNoteNumber: "CN-NEW",
  customerInvoiceId: invoiceId,
  returnPostingId: "RP-1",
  currency: "USD",
  lines: [
    {
      customerInvoiceLineId: invoiceLineId,
      returnPostingLineId: "RPL-1",
      quantity,
      pricingSource: "original_invoice",
      enteredTaxAmount: "0.0000",
      ...extra,
    },
  ],
});
const codes = (plan) => plan.blockingIssues.map((entry) => entry.code);

test("a customer return credited in full on invoice A cannot be credited again on invoice B (L8-01)", async () => {
  const prisma = facts({ priorCredits: [{ invoiceLineId: "INV-A-1", returnLineId: "RPL-1", quantity: "5.0000", status: "approved" }] });
  assert.deepEqual(
    codes(await buildCustomerCreditNotePlan({ prisma, tenantId, input: request("INV-B", "INV-B-1", "1.0000") })),
    ["CUSTOMER_CREDIT_QUANTITY_EXCEEDED"],
  );
  const cancelled = facts({ priorCredits: [{ invoiceLineId: "INV-A-1", returnLineId: "RPL-1", quantity: "5.0000", status: "cancelled" }] });
  const plan = await buildCustomerCreditNotePlan({ prisma: cancelled, tenantId, input: request("INV-B", "INV-B-1", "4.0000") });
  assert.equal(plan.allowed, true, JSON.stringify(plan.blockingIssues));
  assert.equal(plan.creditNote.totalAmount, "50.0000");
});

test("a customer credit's reviewed price and tax stay within the invoice line (L2-18)", async () => {
  const prisma = facts();
  assert.deepEqual(
    codes(await buildCustomerCreditNotePlan({ prisma, tenantId, input: request("INV-A", "INV-A-1", "2.0000", { pricingSource: "manual_reviewed", unitPrice: "13.0000" }) })),
    ["CUSTOMER_CREDIT_PRICE_EXCEEDS_INVOICE"],
  );
  assert.equal(
    (await buildCustomerCreditNotePlan({ prisma, tenantId, input: request("INV-A", "INV-A-1", "2.0000", { pricingSource: "manual_reviewed", unitPrice: "10.0000", enteredTaxAmount: "2.0000" }) })).allowed,
    true,
  );
  assert.deepEqual(
    codes(await buildCustomerCreditNotePlan({ prisma, tenantId, input: request("INV-A", "INV-A-1", "2.0000", { enteredTaxAmount: "2.0001" }) })),
    ["CUSTOMER_CREDIT_TAX_EXCEEDS_INVOICE"],
  );
});
