// Rules shared by supplier credit memos and customer credit notes, the two
// credits a posted return can carry (operational-finance-policy.mjs and
// operational-finance-o2c-policy.mjs), and by the reversal of that return.

// A credit that still counts: a draft, which may yet be approved, and an
// approved one. A cancelled draft counts for nothing, so cancelling a wrong
// draft gives its quantity back to the return and the bill or invoice.
export const CREDIT_HOLDING_STATUSES = Object.freeze(["draft", "approved"]);

const text = (value) => String(value ?? "").trim();

// Quantities already credited, from credit lines read with their quantity,
// summed two ways: per bill or invoice line (across every return), and per
// return line (across every bill or invoice that billed the same goods). A
// receipt or shipment line can be billed in parts, so only the second sum
// keeps one return from being credited once on each part.
export function creditedQuantities(rows, invoiceLineField, toUnits) {
  const byInvoiceLine = new Map();
  const byReturnLine = new Map();
  for (const row of rows) {
    const quantity = toUnits(row.quantity);
    const invoiceLineId = row[invoiceLineField];
    byInvoiceLine.set(invoiceLineId, (byInvoiceLine.get(invoiceLineId) || 0n) + quantity);
    byReturnLine.set(row.returnPostingLineId, (byReturnLine.get(row.returnPostingLineId) || 0n) + quantity);
  }
  return { byInvoiceLine, byReturnLine };
}

// The tax a credit line may carry: the original line's tax in proportion to
// the quantity credited, rounded half up to four decimals. All values are
// fixed-point units (four decimals).
export function proportionalTaxCap(originalTaxUnits, creditedQuantityUnits, invoicedQuantityUnits) {
  if (invoicedQuantityUnits <= 0n || originalTaxUnits <= 0n || creditedQuantityUnits <= 0n) return 0n;
  const product = originalTaxUnits * creditedQuantityUnits;
  return (product * 2n + invoicedQuantityUnits) / (invoicedQuantityUnits * 2n);
}

// Reversing a return would take back the goods a credit is based on. While a
// draft or approved credit names the return, the reversal is refused: a draft
// is cancelled first, an approved credit keeps the return in place.
export async function returnPostingCreditIssues({ prisma, tenantId, postingId, postingType }) {
  const customer = postingType === "customer_return_receipt";
  const where = {
    tenantId,
    returnPostingId: text(postingId),
    status: { in: [...CREDIT_HOLDING_STATUSES] },
  };
  const credits = customer
    ? (await prisma.customerCreditNote.findMany({ where, select: { creditNoteNumber: true, status: true } }))
        .map((row) => ({ number: row.creditNoteNumber, status: row.status }))
    : (await prisma.supplierCreditMemo.findMany({ where, select: { creditMemoNumber: true, status: true } }))
        .map((row) => ({ number: row.creditMemoNumber, status: row.status }));
  if (!credits.length) return [];
  const kind = customer ? "credit note" : "credit memo";
  const numbers = (status) => credits.filter((row) => row.status === status).map((row) => row.number).join(", ");
  const approved = numbers("approved");
  return [
    {
      code: "RETURN_REVERSAL_BLOCKED_BY_CREDIT",
      message: approved
        ? `Approved ${kind} ${approved} is based on this return, so the return cannot be reversed.`
        : `Draft ${kind} ${numbers("draft")} is based on this return. Cancel the draft before reversing the return.`,
      status: 409,
      details: { credits },
    },
  ];
}
