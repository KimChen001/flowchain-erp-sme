import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";
import { mergeOperationalSettings } from "./workspace-settings-contract.mjs";
import {
  PURCHASE_ORDER_STATUS,
  RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES,
} from "./procurement-status-authority.mjs";
import {
  CREDIT_HOLDING_STATUSES,
  creditedQuantities,
  proportionalTaxCap,
} from "./return-credit-rules.mjs";
import { uncreditedReturnedQuantities } from "./return-quantity-ledger.mjs";

const SCALE = 10_000n;
const ZERO = 0n;
const text = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];
const issue = (code, message, status = 422, details) => ({
  code,
  message,
  status,
  ...(details ? { details } : {}),
});

function units(value, issues, label, { positive = false, nonNegative = false } = {}) {
  try {
    const parsed = decimalUnits(value);
    if (positive && parsed <= ZERO)
      issues.push(issue("FINANCE_DECIMAL_INVALID", `${label} must be positive.`));
    if (nonNegative && parsed < ZERO)
      issues.push(issue("FINANCE_DECIMAL_INVALID", `${label} cannot be negative.`));
    return parsed;
  } catch {
    issues.push(
      issue(
        "FINANCE_DECIMAL_INVALID",
        `${label} must be a fixed four-decimal number.`,
      ),
    );
    return null;
  }
}

function multiply(left, right) {
  const product = BigInt(left) * BigInt(right);
  const negative = product < ZERO;
  const absolute = negative ? -product : product;
  const rounded = (absolute + SCALE / 2n) / SCALE;
  return negative ? -rounded : rounded;
}

function abs(value) {
  return value < ZERO ? -value : value;
}

function basePlan(operation, blockingIssues, additions = {}) {
  return {
    operation,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    warnings: [],
    inventoryMutation: false,
    paymentExecution: false,
    ledgerMutation: false,
    ...additions,
  };
}

function validCurrency(value) {
  return /^[A-Z]{3}$/.test(text(value));
}

function normalizedInvoiceLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    purchaseOrderLineId: text(line.purchaseOrderLineId),
    receivingLineId: text(line.receivingLineId),
    quantity: text(line.quantity),
    unitPrice: text(line.unitPrice),
    lineAmount: text(line.lineAmount ?? line.amount),
    enteredTaxAmount: text(line.enteredTaxAmount || "0"),
  }));
}

// A supplier's bill often arrives before the goods (owner decision of
// 2026-10-03): it is recorded against the purchase order and waits for the
// receipt. Until the receipt is linked it cannot be matched, approved or paid,
// so payment still needs the three-way match. Such a bill needs a purchase
// order the supplier can still deliver against.
export const BILL_BEFORE_RECEIPT_PO_STATUSES = Object.freeze([
  PURCHASE_ORDER_STATUS.APPROVED,
  PURCHASE_ORDER_STATUS.ISSUED,
  PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED,
  PURCHASE_ORDER_STATUS.FULLY_RECEIVED,
  "received",
  "open",
]);

export const awaitingReceipt = (invoice) =>
  ["draft", "submitted"].includes(invoice?.status) &&
  Boolean(invoice?.relatedPoId) &&
  !invoice?.relatedGrnId;

export async function buildSupplierInvoicePlan({
  prisma,
  tenantId,
  input = {},
  currentInvoiceId,
  countCommittedOnly = true,
}) {
  const blockingIssues = [];
  const lines = normalizedInvoiceLines(input.lines);
  const currency = text(input.currency).toUpperCase();
  if (!text(input.invoiceNumber))
    blockingIssues.push(
      issue("SUPPLIER_INVOICE_NUMBER_REQUIRED", "Invoice number is required."),
    );
  if (!text(input.supplierId))
    blockingIssues.push(
      issue("SUPPLIER_REQUIRED", "Supplier selection is required."),
    );
  if (!validCurrency(currency))
    blockingIssues.push(
      issue("FINANCE_CURRENCY_INVALID", "Currency must be a three-letter ISO code."),
    );
  if (!text(input.invoiceDate) || !text(input.dueDate))
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_DATE_REQUIRED",
        "Invoice date and due date are required.",
      ),
    );
  if (!lines.length)
    blockingIssues.push(
      issue("SUPPLIER_INVOICE_LINES_REQUIRED", "At least one invoice line is required."),
    );
  // Every line names its purchase-order line. The receiving lines are named
  // for every line or for none: a bill recorded before the goods arrive waits
  // for its receipt as a whole.
  const receivingIds = lines.map((line) => line.receivingLineId).filter(Boolean);
  const poLineIds = lines.map((line) => line.purchaseOrderLineId);
  const waitingForReceipt = lines.length > 0 && receivingIds.length === 0;
  if (
    unique(receivingIds).length !== receivingIds.length ||
    unique(poLineIds).length !== poLineIds.length
  )
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_SOURCE_DUPLICATE",
        "A source line may appear only once in an invoice.",
      ),
    );
  if (lines.some((line) => !line.purchaseOrderLineId))
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_SOURCE_REQUIRED",
        "Every supplier invoice line names the purchase order line it invoices.",
      ),
    );
  if (receivingIds.length && receivingIds.length !== lines.length)
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_RECEIPT_PARTIAL",
        "Link every line to the receipt, or none until the goods arrive.",
      ),
    );
  if (blockingIssues.length)
    return basePlan("supplier_invoice_draft", blockingIssues, { lines: [] });

  const [receivingRows, poRows, supplier, tenant] = await Promise.all([
    receivingIds.length
      ? prisma.receivingLine.findMany({
          where: { id: { in: receivingIds } },
          include: { receivingDocument: true },
          orderBy: { id: "asc" },
        })
      : [],
    prisma.purchaseOrderLine.findMany({
      where: { id: { in: poLineIds } },
      include: { purchaseOrder: true },
      orderBy: { id: "asc" },
    }),
    prisma.supplier.findFirst({
      where: { id: text(input.supplierId), tenantId },
    }),
    prisma.tenant.findUnique({ where: { id: tenantId } }),
  ]);
  if (!supplier)
    blockingIssues.push(
      issue("SUPPLIER_NOT_FOUND", "Supplier was not found in this workspace.", 404),
    );
  if (
    receivingRows.length !== receivingIds.length ||
    poRows.length !== poLineIds.length
  )
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_SOURCE_NOT_FOUND",
        "Every invoice line must resolve to authoritative PO and posted receiving facts.",
        404,
      ),
    );
  const receivingById = new Map(receivingRows.map((row) => [row.id, row]));
  const poById = new Map(poRows.map((row) => [row.id, row]));
  const relatedPoIds = unique(poRows.map((row) => row.purchaseOrderId));
  const relatedGrnIds = unique(
    receivingRows.map((row) => row.receivingDocumentId),
  );
  if (relatedPoIds.length !== 1 || (!waitingForReceipt && relatedGrnIds.length !== 1))
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_SOURCE_MIXED",
        "One supplier invoice must use one purchase order and one posted receiving document.",
      ),
    );
  const consumingStatuses = countCommittedOnly
    ? []
    : [...RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES];
  // A bill waiting for its receipt is checked against what was ordered,
  // less what other bills already claim on the same purchase-order lines. A
  // bill from a receipt is checked on its purchase-order lines as well: what
  // every bill claims there, waiting for its receipt or not, cannot pass what
  // the line's posted receipts brought in (design audit L2-07).
  const previousPoRows = consumingStatuses.length
    ? await prisma.supplierInvoiceLine.findMany({
        where: {
          purchaseOrderLineId: { in: poLineIds },
          ...(currentInvoiceId
            ? { supplierInvoiceId: { not: currentInvoiceId } }
            : {}),
          supplierInvoice: {
            tenantId,
            status: { in: consumingStatuses },
          },
        },
        select: { purchaseOrderLineId: true, quantity: true },
      })
    : [];
  const previousByPoLine = new Map();
  for (const row of previousPoRows)
    previousByPoLine.set(
      row.purchaseOrderLineId,
      (previousByPoLine.get(row.purchaseOrderLineId) || ZERO) +
        decimalUnits(row.quantity || 0),
    );
  const previousRows = receivingIds.length && consumingStatuses.length
    ? await prisma.supplierInvoiceLine.findMany({
        where: {
          receivingLineId: { in: receivingIds },
          ...(currentInvoiceId
            ? { supplierInvoiceId: { not: currentInvoiceId } }
            : {}),
          supplierInvoice: {
            tenantId,
            status: { in: consumingStatuses },
          },
        },
        select: { receivingLineId: true, quantity: true },
      })
    : [];
  const previousByReceiving = new Map();
  for (const row of previousRows)
    previousByReceiving.set(
      row.receivingLineId,
      (previousByReceiving.get(row.receivingLineId) || ZERO) +
        decimalUnits(row.quantity || 0),
    );
  const lineReceiptRows = !waitingForReceipt && consumingStatuses.length
    ? await prisma.receivingLine.findMany({
        where: {
          purchaseOrderLineId: { in: poLineIds },
          receivingDocument: { tenantId, postingStatus: "posted", reversedAt: null },
        },
        select: { purchaseOrderLineId: true, acceptedQty: true },
      })
    : [];
  const receivedByPoLine = new Map();
  for (const row of lineReceiptRows)
    receivedByPoLine.set(
      row.purchaseOrderLineId,
      (receivedByPoLine.get(row.purchaseOrderLineId) || ZERO) +
        decimalUnits(row.acceptedQty || 0),
    );

  let subtotal = ZERO;
  let tax = ZERO;
  const authoritativeLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const requested = lines[index];
    const receiving = receivingById.get(requested.receivingLineId);
    const poLine = poById.get(requested.purchaseOrderLineId);
    const quantity = units(requested.quantity, blockingIssues, `Line ${index + 1} quantity`, {
      positive: true,
    });
    const unitPrice = units(
      requested.unitPrice,
      blockingIssues,
      `Line ${index + 1} unit price`,
      { nonNegative: true },
    );
    // The line amount is quantity × unit price to four decimals, worked out
    // here when the request leaves it out (the invoice form does, so no
    // floating-point rounding in the browser can make it differ: design audit
    // L2-17). A line amount that is sent must still equal it.
    const lineAmount = requested.lineAmount
      ? units(
          requested.lineAmount,
          blockingIssues,
          `Line ${index + 1} line amount`,
          { nonNegative: true },
        )
      : quantity !== null && unitPrice !== null
        ? multiply(quantity, unitPrice)
        : null;
    const enteredTaxAmount = units(
      requested.enteredTaxAmount,
      blockingIssues,
      `Line ${index + 1} entered tax`,
      { nonNegative: true },
    );
    if (waitingForReceipt && poLine) {
      const po = poLine.purchaseOrder;
      if (po.tenantId !== tenantId || po.supplierId !== supplier?.id)
        blockingIssues.push(
          issue(
            "SUPPLIER_INVOICE_SOURCE_INVALID",
            `Line ${index + 1} does not match the purchase order and supplier.`,
            409,
          ),
        );
      if (!BILL_BEFORE_RECEIPT_PO_STATUSES.includes(text(po.status)))
        blockingIssues.push(
          issue(
            "SUPPLIER_INVOICE_PO_NOT_OPEN",
            `Purchase order ${po.id} is ${po.status}. A supplier invoice can wait for its receipt only on an approved purchase order that can still be received; otherwise record the supplier invoice against its posted receipt.`,
            409,
          ),
        );
      if (po.currency !== currency)
        blockingIssues.push(
          issue(
            "FINANCE_CURRENCY_MISMATCH",
            `Line ${index + 1} source currency does not match invoice currency.`,
            409,
          ),
        );
      const ordered = decimalUnits(poLine.orderedQuantity || 0);
      const billedElsewhere = previousByPoLine.get(poLine.id) || ZERO;
      if (quantity !== null && quantity + billedElsewhere > ordered)
        blockingIssues.push(
          issue(
            "SUPPLIER_INVOICE_QUANTITY_EXCEEDS_ORDERED",
            `Line ${index + 1} invoices more than was ordered and not yet invoiced.`,
            409,
            {
              purchaseOrderLineId: poLine.id,
              orderedQuantity: decimalString(ordered),
              previouslyInvoicedQuantity: decimalString(billedElsewhere),
            },
          ),
        );
      if (
        quantity !== null &&
        unitPrice !== null &&
        lineAmount !== null &&
        multiply(quantity, unitPrice) !== lineAmount
      )
        blockingIssues.push(
          issue(
            "SUPPLIER_INVOICE_LINE_AMOUNT_MISMATCH",
            `Line ${index + 1} amount must equal quantity multiplied by entered unit price.`,
          ),
        );
      if (lineAmount !== null) subtotal += lineAmount;
      if (enteredTaxAmount !== null) tax += enteredTaxAmount;
      authoritativeLines.push({
        lineNumber: index + 1,
        purchaseOrderLineId: poLine.id,
        receivingLineId: null,
        itemId: poLine.itemId,
        sku: poLine.sku,
        itemName: poLine.itemName,
        unit: poLine.unit,
        quantity: quantity === null ? "0.0000" : decimalString(quantity),
        unitPrice: unitPrice === null ? "0.0000" : decimalString(unitPrice),
        lineAmount: lineAmount === null ? "0.0000" : decimalString(lineAmount),
        enteredTaxAmount:
          enteredTaxAmount === null ? "0.0000" : decimalString(enteredTaxAmount),
        amount:
          lineAmount === null || enteredTaxAmount === null
            ? "0.0000"
            : decimalString(lineAmount + enteredTaxAmount),
        orderedQuantity: decimalString(ordered),
        receivedQuantity: null,
        poUnitPrice: decimalString(decimalUnits(poLine.unitPrice || 0)),
      });
      continue;
    }
    if (!receiving || !poLine) continue;
    const receivingDocument = receiving.receivingDocument;
    const po = poLine.purchaseOrder;
    if (
      receivingDocument.tenantId !== tenantId ||
      po.tenantId !== tenantId ||
      receivingDocument.postingStatus !== "posted" ||
      receivingDocument.reversedAt ||
      receiving.purchaseOrderLineId !== poLine.id ||
      receivingDocument.poId !== po.id ||
      po.supplierId !== supplier?.id ||
      (receivingDocument.supplierId &&
        receivingDocument.supplierId !== supplier?.id) ||
      receiving.itemId !== poLine.itemId ||
      receiving.sku !== poLine.sku
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_INVOICE_SOURCE_INVALID",
          `Line ${index + 1} does not match authoritative PO, supplier, item, and posted receiving facts.`,
          409,
        ),
      );
    if (
      po.currency !== currency ||
      receivingDocument.currency !== currency ||
      tenant?.currency === undefined
    )
      blockingIssues.push(
        issue(
          "FINANCE_CURRENCY_MISMATCH",
          `Line ${index + 1} source currency does not match invoice currency.`,
          409,
        ),
      );
    if (
      quantity !== null &&
      quantity +
        (previousByReceiving.get(receiving.id) || ZERO) >
        decimalUnits(receiving.acceptedQty || 0)
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_INVOICE_QUANTITY_EXCEEDS_RECEIVED",
          `Line ${index + 1} exceeds received not-yet-invoiced quantity.`,
          409,
          {
            receivingLineId: receiving.id,
            receivedQuantity: decimalString(
              decimalUnits(receiving.acceptedQty || 0),
            ),
            previouslyInvoicedQuantity: decimalString(
              previousByReceiving.get(receiving.id) || ZERO,
            ),
          },
        ),
      );
    else if (
      quantity !== null &&
      consumingStatuses.length &&
      quantity + (previousByPoLine.get(poLine.id) || ZERO) >
        (receivedByPoLine.get(poLine.id) || ZERO)
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_INVOICE_QUANTITY_EXCEEDS_RECEIVED",
          `Line ${index + 1} and the other invoices of its purchase-order line bill more than was received on that line.`,
          409,
          {
            receivingLineId: receiving.id,
            purchaseOrderLineId: poLine.id,
            receivedQuantity: decimalString(receivedByPoLine.get(poLine.id) || ZERO),
            previouslyInvoicedQuantity: decimalString(
              previousByPoLine.get(poLine.id) || ZERO,
            ),
          },
        ),
      );
    if (
      quantity !== null &&
      unitPrice !== null &&
      lineAmount !== null &&
      multiply(quantity, unitPrice) !== lineAmount
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_INVOICE_LINE_AMOUNT_MISMATCH",
          `Line ${index + 1} amount must equal quantity multiplied by entered unit price.`,
        ),
      );
    if (lineAmount !== null) subtotal += lineAmount;
    if (enteredTaxAmount !== null) tax += enteredTaxAmount;
    authoritativeLines.push({
      lineNumber: index + 1,
      purchaseOrderLineId: poLine.id,
      receivingLineId: receiving.id,
      itemId: poLine.itemId,
      sku: poLine.sku,
      itemName: poLine.itemName,
      unit: poLine.unit,
      quantity: quantity === null ? "0.0000" : decimalString(quantity),
      unitPrice: unitPrice === null ? "0.0000" : decimalString(unitPrice),
      lineAmount: lineAmount === null ? "0.0000" : decimalString(lineAmount),
      enteredTaxAmount:
        enteredTaxAmount === null ? "0.0000" : decimalString(enteredTaxAmount),
      amount:
        lineAmount === null || enteredTaxAmount === null
          ? "0.0000"
          : decimalString(lineAmount + enteredTaxAmount),
      receivedQuantity: decimalString(decimalUnits(receiving.acceptedQty || 0)),
      poUnitPrice: decimalString(decimalUnits(poLine.unitPrice || 0)),
    });
  }
  const total = subtotal + tax;
  if (
    text(input.totalAmount) &&
    units(input.totalAmount, blockingIssues, "Invoice total", {
      nonNegative: true,
    }) !== total
  )
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_TOTAL_MISMATCH",
        "Invoice total must equal line amounts plus explicitly entered tax.",
      ),
    );
  return basePlan("supplier_invoice_draft", blockingIssues, {
    source: {
      supplier: supplier
        ? {
            id: supplier.id,
            code: supplier.code,
            name: supplier.name,
          }
        : null,
      purchaseOrderId: relatedPoIds[0] || null,
      receivingDocumentId: waitingForReceipt ? null : relatedGrnIds[0] || null,
    },
    waitingForReceipt,
    invoice: {
      invoiceNumber: text(input.invoiceNumber),
      supplierId: supplier?.id || text(input.supplierId),
      supplierName: supplier?.name || null,
      currency,
      invoiceDate: text(input.invoiceDate),
      dueDate: text(input.dueDate),
      subtotalAmount: decimalString(subtotal),
      enteredTaxAmount: decimalString(tax),
      totalAmount: decimalString(total),
    },
    lines: authoritativeLines,
    factsToCreate: {
      supplierInvoices: 1,
      supplierInvoiceLines: authoritativeLines.length,
      matchRuns: 0,
      matchExceptions: 0,
      payableObligations: 0,
      inventoryMovements: 0,
      payments: 0,
      journalEntries: 0,
    },
  });
}

function toleranceUnits(value) {
  try {
    const parsed = decimalUnits(value ?? 0);
    return parsed < ZERO ? ZERO : parsed;
  } catch {
    return ZERO;
  }
}

const larger = (...values) => values.reduce((top, value) => (value > top ? value : top), ZERO);

// The rule a three-way match was made under, kept on the match run
// (ThreeWayMatch.metadata.rule) with the tolerances it used, so a match keeps
// the rule it was made with. A match without it was made before 2026-11-17
// and keeps its result and its exceptions as they are.
//   per_line_2026_11 (design audit B2, owner decision 2026-11-17):
//   - quantity: what the invoice bills against what was received on the
//     purchase-order line, over all its posted receipts (a later receipt
//     counts when the invoice is matched again), less what other invoices
//     claim on the line and goods returned and not credited;
//   - price: the line's price difference (quantity × (invoice price − PO
//     price)) against the larger of the unit-price tolerances over the
//     quantity and the line amount tolerance; it is raised once, as a price
//     difference;
//   - amount: only what the invoice price does not explain (line amount
//     against quantity × invoice price), so a price difference never raises
//     a second, amount difference;
//   - a quantity difference cannot be approved for payment: it is rejected,
//     waits for the receipt and is matched again, or is accepted at the
//     received quantity (the payable leaves out what was not received).
export const THREE_WAY_MATCH_RULE = "per_line_2026_11";
export const matchRuleOf = (match) =>
  text(match?.metadata?.rule) || null;
export const quantityApprovalRefused = (match, exceptionType) =>
  exceptionType === "quantity" && matchRuleOf(match) === THREE_WAY_MATCH_RULE;

// Whether a line's price difference is held at the match
// (THREE_WAY_MATCH_RULE), in units of 0.0001: the difference over the line
// (quantity × (invoice price − PO price)) against the larger of the unit
// price tolerances over the quantity (a percentage of the PO line amount, or
// an amount per unit) and the line amount tolerance. With the defaults that
// is the larger of 2% of the line and 1 currency unit.
export function linePriceDifferenceHeld({ invoiceQuantity, poPrice, invoicePrice, pricePercentageTolerance, priceAbsoluteTolerance, amountTolerance }) {
  const expectedAmount = multiply(invoiceQuantity, poPrice);
  const atInvoicePrice = multiply(invoiceQuantity, invoicePrice);
  const lineThreshold = larger(
    multiply(abs(expectedAmount), pricePercentageTolerance) / 100n,
    multiply(invoiceQuantity, priceAbsoluteTolerance),
    amountTolerance,
  );
  return invoicePrice !== poPrice && abs(atInvoicePrice - expectedAmount) > lineThreshold;
}

// The same for decimal values, under a workspace's review settings (the
// defaults when it saved none): the public-data seed plans its invoice
// differences with it (scripts/public-data/plan.mjs).
export function priceDifferenceHeld({ quantity, orderPrice, invoicePrice, review = mergeOperationalSettings().review }) {
  return linePriceDifferenceHeld({
    invoiceQuantity: decimalUnits(String(quantity)),
    poPrice: decimalUnits(String(orderPrice)),
    invoicePrice: decimalUnits(String(invoicePrice)),
    pricePercentageTolerance: toleranceUnits(review.pricePercentageTolerance),
    priceAbsoluteTolerance: toleranceUnits(review.priceAbsoluteTolerance),
    amountTolerance: toleranceUnits(review.amountTolerance),
  });
}

// Statuses of other invoices whose lines count against a purchase-order
// line at the match.
const MATCH_CLAIMING_STATUSES = ["matching", "exception", "matched", "approved", "held"];

export async function buildSupplierMatchPlan({
  prisma,
  tenantId,
  invoiceId,
}) {
  const blockingIssues = [];
  const invoice = await prisma.supplierInvoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });
  if (!invoice)
    return basePlan("supplier_invoice_match", [
      issue("SUPPLIER_INVOICE_NOT_FOUND", "Supplier invoice was not found.", 404),
    ]);
  // A bill recorded before the goods arrived waits for its receipt: nothing
  // to match against yet, and so nothing to approve or pay.
  if (invoice.lines.some((line) => !line.receivingLineId))
    return basePlan("supplier_invoice_match", [
      issue(
        "SUPPLIER_INVOICE_RECEIPT_REQUIRED",
        "This supplier invoice is waiting for its receipt. Link the receipt once the goods are received; the invoice can be matched and paid only after that.",
        409,
      ),
    ], {
      invoice: {
        id: invoice.id,
        version: invoice.version,
        currency: invoice.currency,
        status: invoice.status,
      },
    });
  // A submitted invoice starts a match run. An invoice the match held is
  // matched again while a difference is still open or rejected, for example
  // once the rest of the goods are received (design audit L2-04): the new run
  // replaces the earlier one. An invoice whose every difference was accepted
  // is approved instead.
  const rematch = invoice.status === "exception";
  const blockingBefore = rematch
    ? await prisma.financeMatchException.count({
        where: { supplierInvoiceId: invoice.id, status: { in: ["open", "rejected"] } },
      })
    : 0;
  if (!["submitted", "exception"].includes(invoice.status))
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_STATUS_INVALID",
        "Only a submitted supplier invoice, or one the match held, can start a match run.",
        409,
      ),
    );
  else if (rematch && blockingBefore === 0)
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_MATCH_REVIEWED",
        "Every difference of this supplier invoice was accepted; approve the invoice instead of matching it again.",
        409,
      ),
    );
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const review = mergeOperationalSettings(tenant?.operationalSettings).review;
  const quantityTolerance = toleranceUnits(review.quantityTolerance);
  const priceAbsoluteTolerance = toleranceUnits(
    review.priceAbsoluteTolerance,
  );
  const amountTolerance = toleranceUnits(review.amountTolerance);
  const pricePercentageTolerance = toleranceUnits(
    review.pricePercentageTolerance,
  );
  const receivingIds = invoice.lines.map((line) => line.receivingLineId);
  const poLineIds = invoice.lines.map((line) => line.purchaseOrderLineId);
  const [receivingRows, poRows, previousRows, lineReceipts] = await Promise.all([
    prisma.receivingLine.findMany({
      where: { id: { in: receivingIds } },
      include: { receivingDocument: true },
    }),
    prisma.purchaseOrderLine.findMany({
      where: { id: { in: poLineIds } },
      include: { purchaseOrder: true },
    }),
    // What other invoices claim on the same purchase-order lines, whichever
    // receipt they name (design audit L2-07).
    prisma.supplierInvoiceLine.findMany({
      where: {
        purchaseOrderLineId: { in: poLineIds },
        supplierInvoiceId: { not: invoice.id },
        supplierInvoice: {
          tenantId,
          status: { in: MATCH_CLAIMING_STATUSES },
        },
      },
      select: { purchaseOrderLineId: true, quantity: true },
    }),
    // Every posted receipt line of those purchase-order lines.
    prisma.receivingLine.findMany({
      where: {
        purchaseOrderLineId: { in: poLineIds },
        receivingDocument: { tenantId, postingStatus: "posted", reversedAt: null },
      },
      select: { id: true, purchaseOrderLineId: true, acceptedQty: true },
    }),
  ]);
  const receivingById = new Map(receivingRows.map((row) => [row.id, row]));
  const poById = new Map(poRows.map((row) => [row.id, row]));
  const sumBy = (rows, key, value) => {
    const totals = new Map();
    for (const row of rows)
      totals.set(row[key], (totals.get(row[key]) || ZERO) + value(row));
    return totals;
  };
  const previousByPoLine = sumBy(previousRows, "purchaseOrderLineId", (row) =>
    decimalUnits(row.quantity || 0),
  );
  const receivedByPoLine = sumBy(lineReceipts, "purchaseOrderLineId", (row) =>
    decimalUnits(row.acceptedQty || 0),
  );
  const receiptLinesByPoLine = new Map();
  for (const row of lineReceipts)
    receiptLinesByPoLine.set(row.purchaseOrderLineId, [
      ...(receiptLinesByPoLine.get(row.purchaseOrderLineId) || []),
      row.id,
    ]);
  // Goods sent back to the supplier are no longer received for billing,
  // unless an approved credit memo already took them off a bill (L2-06).
  const returnsByReceiving = await uncreditedReturnedQuantities({
    prisma,
    tenantId,
    sourceDocumentType: "ReceivingDocument",
    sourceLineIds: lineReceipts.map((row) => row.id),
  });
  const returnsOfPoLine = (poLineId) => {
    let found = null;
    for (const id of receiptLinesByPoLine.get(poLineId) || []) {
      const entry = returnsByReceiving.get(id);
      if (!entry) continue;
      found = {
        returned: (found?.returned || ZERO) + entry.returned,
        credited: (found?.credited || ZERO) + entry.credited,
        uncredited: (found?.uncredited || ZERO) + entry.uncredited,
      };
    }
    return found;
  };
  const matchLines = [];
  const exceptions = [];
  let invoiceTotal = ZERO;
  let poTotal = ZERO;
  for (const line of invoice.lines) {
    const receiving = receivingById.get(line.receivingLineId);
    const poLine = poById.get(line.purchaseOrderLineId);
    if (
      !receiving ||
      !poLine ||
      receiving.receivingDocument.tenantId !== tenantId ||
      poLine.purchaseOrder.tenantId !== tenantId ||
      receiving.receivingDocument.postingStatus !== "posted" ||
      receiving.receivingDocument.reversedAt ||
      receiving.purchaseOrderLineId !== poLine.id ||
      receiving.itemId !== line.itemId ||
      receiving.sku !== line.sku
    ) {
      blockingIssues.push(
        issue(
          "THREE_WAY_MATCH_SOURCE_INVALID",
          `Invoice line ${line.id} no longer resolves to authoritative PO and receiving facts.`,
          409,
        ),
      );
      continue;
    }
    if (
      invoice.currency !== poLine.purchaseOrder.currency ||
      invoice.currency !== receiving.receivingDocument.currency
    ) {
      blockingIssues.push(
        issue(
          "FINANCE_CURRENCY_MISMATCH",
          `Invoice line ${line.id} currency does not match PO and receiving.`,
          409,
        ),
      );
      continue;
    }
    const invoiceQuantity = decimalUnits(line.quantity || 0);
    // Received on the purchase-order line over all its posted receipts, and
    // claimed there by other invoices (THREE_WAY_MATCH_RULE).
    const receivedQuantity = receivedByPoLine.get(poLine.id) || ZERO;
    const previouslyInvoiced = previousByPoLine.get(poLine.id) || ZERO;
    const returns = returnsOfPoLine(poLine.id);
    const returnedNotCredited = returns?.uncredited || ZERO;
    const available = receivedQuantity - previouslyInvoiced - returnedNotCredited;
    const poPrice = decimalUnits(poLine.unitPrice || 0);
    const invoicePrice = decimalUnits(line.unitPrice || 0);
    const invoiceLineAmount = decimalUnits(line.lineAmount ?? line.amount ?? 0);
    const expectedAmount = multiply(invoiceQuantity, poPrice);
    const atInvoicePrice = multiply(invoiceQuantity, invoicePrice);
    const quantityVariance = invoiceQuantity - available;
    const priceVariance = invoicePrice - poPrice;
    const amountVariance = invoiceLineAmount - expectedAmount;
    const lineExceptions = [];
    if (quantityVariance > quantityTolerance)
      lineExceptions.push({
        exceptionType: "quantity",
        expectedValue: decimalString(available),
        actualValue: decimalString(invoiceQuantity),
        varianceValue: decimalString(quantityVariance),
      });
    if (linePriceDifferenceHeld({ invoiceQuantity, poPrice, invoicePrice, pricePercentageTolerance, priceAbsoluteTolerance, amountTolerance }))
      lineExceptions.push({
        exceptionType: "price",
        expectedValue: decimalString(poPrice),
        actualValue: decimalString(invoicePrice),
        varianceValue: decimalString(priceVariance),
      });
    // The line amount the invoice price does not explain; a price difference
    // is not raised a second time as an amount difference (design audit L2-03).
    const unexplained = invoiceLineAmount - atInvoicePrice;
    if (abs(unexplained) > amountTolerance)
      lineExceptions.push({
        exceptionType: "amount",
        expectedValue: decimalString(atInvoicePrice),
        actualValue: decimalString(invoiceLineAmount),
        varianceValue: decimalString(unexplained),
      });
    invoiceTotal += invoiceLineAmount;
    poTotal += expectedAmount;
    const linePlan = {
      supplierInvoiceLineId: line.id,
      purchaseOrderLineId: poLine.id,
      receivingLineId: receiving.id,
      itemId: line.itemId,
      sku: line.sku,
      unit: line.unit,
      orderedQuantity: decimalString(decimalUnits(poLine.orderedQuantity || 0)),
      receivedQuantity: decimalString(receivedQuantity),
      previouslyInvoicedQuantity: decimalString(previouslyInvoiced),
      invoiceQuantity: decimalString(invoiceQuantity),
      poUnitPrice: decimalString(poPrice),
      invoiceUnitPrice: decimalString(invoicePrice),
      poLineAmount: decimalString(expectedAmount),
      invoiceLineAmount: decimalString(invoiceLineAmount),
      quantityVariance: decimalString(quantityVariance),
      priceVariance: decimalString(priceVariance),
      amountVariance: decimalString(amountVariance),
      currency: invoice.currency,
      status: lineExceptions.length ? "exception" : "matched",
      // The receipts of the purchase-order line counted as received, and
      // their supplier returns, so the expected quantity can be read back:
      // received - previously invoiced - returned + credited.
      metadata: {
        receiptLineIds: receiptLinesByPoLine.get(poLine.id) || [],
        ...(returns
          ? {
              returnedQuantity: decimalString(returns.returned),
              creditedReturnQuantity: decimalString(returns.credited),
            }
          : {}),
      },
    };
    matchLines.push(linePlan);
    exceptions.push(
      ...lineExceptions.map((entry) => ({
        ...entry,
        supplierInvoiceLineId: line.id,
        currency: invoice.currency,
      })),
    );
  }
  return basePlan("supplier_invoice_match", blockingIssues, {
    invoice: {
      id: invoice.id,
      version: invoice.version,
      currency: invoice.currency,
      status: invoice.status,
    },
    rule: THREE_WAY_MATCH_RULE,
    rematch,
    tolerances: {
      quantity: decimalString(quantityTolerance),
      pricePercentage: decimalString(pricePercentageTolerance),
      priceAbsolute: decimalString(priceAbsoluteTolerance),
      amount: decimalString(amountTolerance),
    },
    lines: matchLines,
    exceptions,
    resultStatus: exceptions.length ? "exception" : "matched",
    totals: {
      purchaseOrder: decimalString(poTotal),
      invoice: decimalString(invoiceTotal),
      variance: decimalString(invoiceTotal - poTotal),
    },
    factsToCreate: {
      matchRuns: 1,
      matchLines: matchLines.length,
      matchExceptions: exceptions.length,
      payableObligations: 0,
      payments: 0,
      journalEntries: 0,
    },
  });
}

export const supplierCreditMemoNumberDuplicate = (creditMemoNumber) =>
  issue(
    "SUPPLIER_CREDIT_MEMO_NUMBER_DUPLICATE",
    `Credit memo number ${creditMemoNumber} is already recorded in this workspace.`,
    409,
    { creditMemoNumber },
  );

export async function buildSupplierCreditMemoPlan({
  prisma,
  tenantId,
  input = {},
}) {
  const blockingIssues = [];
  const invoice = await prisma.supplierInvoice.findFirst({
    where: { id: text(input.supplierInvoiceId), tenantId },
    include: { lines: true },
  });
  const posting = await prisma.returnPostingDocument.findFirst({
    where: { id: text(input.returnPostingId), tenantId },
    include: {
      lines: {
        include: {
          returnAuthorizationLine: {
            include: { returnRequestLine: true },
          },
        },
      },
      returnAuthorization: {
        select: { returnRequest: { select: { resolution: true } } },
      },
    },
  });
  if (!invoice)
    blockingIssues.push(
      issue("SUPPLIER_INVOICE_NOT_FOUND", "Supplier invoice was not found.", 404),
    );
  // A credit follows its bill: the bill was submitted and is not cancelled
  // (the statuses in which a bill holds its receipt). A draft bill can still
  // change its lines, and a cancelled one is not owed.
  else if (!RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES.includes(invoice.status))
    blockingIssues.push(
      issue(
        "SUPPLIER_CREDIT_INVOICE_STATUS_INVALID",
        "A supplier credit memo needs a bill that was submitted and is not cancelled.",
        409,
        { invoiceStatus: invoice.status },
      ),
    );
  if (
    !posting ||
    posting.postingType !== "supplier_return_dispatch" ||
    posting.postingStatus !== "posted" ||
    posting.reversedAt
  )
    blockingIssues.push(
      issue(
        "SUPPLIER_RETURN_POSTING_REQUIRED",
        "Supplier credit memo requires a non-reversed posted supplier return.",
        409,
      ),
    );
  // A return for a replacement is settled by the replacement goods, which
  // the purchase order expects again (L3-23), not by a credit as well.
  else if (posting.returnAuthorization?.returnRequest?.resolution === "replacement")
    blockingIssues.push(
      issue(
        "SUPPLIER_CREDIT_REPLACEMENT_RETURN",
        "This supplier return asks for replacement goods, so it cannot also be credited.",
        409,
      ),
    );
  const requestedLines = Array.isArray(input.lines) ? input.lines : [];
  if (!requestedLines.length)
    blockingIssues.push(
      issue("SUPPLIER_CREDIT_LINES_REQUIRED", "Credit memo lines are required."),
    );
  if (blockingIssues.length)
    return basePlan("supplier_credit_memo", blockingIssues, { lines: [] });
  const invoiceById = new Map(invoice.lines.map((line) => [line.id, line]));
  const postingById = new Map(posting.lines.map((line) => [line.id, line]));
  // Earlier draft and approved credits on these bill lines or these return
  // lines, on any bill: one receipt line can be billed on several bills.
  const priorCredits = await prisma.supplierCreditMemoLine.findMany({
    where: {
      supplierCreditMemo: { tenantId, status: { in: [...CREDIT_HOLDING_STATUSES] } },
      OR: [
        { supplierInvoiceLineId: { in: unique(requestedLines.map((line) => line.supplierInvoiceLineId)) } },
        { returnPostingLineId: { in: unique(requestedLines.map((line) => line.returnPostingLineId)) } },
      ],
    },
    select: {
      supplierInvoiceLineId: true,
      returnPostingLineId: true,
      quantity: true,
    },
  });
  // Lines of this credit count against each other as well.
  const credited = creditedQuantities(priorCredits, "supplierInvoiceLineId", decimalUnits);
  let subtotal = ZERO;
  let tax = ZERO;
  const lines = [];
  for (let index = 0; index < requestedLines.length; index += 1) {
    const requested = requestedLines[index];
    const invoiceLine = invoiceById.get(text(requested.supplierInvoiceLineId));
    const postingLine = postingById.get(text(requested.returnPostingLineId));
    if (!invoiceLine || !postingLine) {
      blockingIssues.push(
        issue(
          "SUPPLIER_CREDIT_SOURCE_LINE_INVALID",
          `Credit memo line ${index + 1} does not belong to the selected invoice and return posting.`,
          409,
        ),
      );
      continue;
    }
    const sourceReceivingLineId =
      postingLine.returnAuthorizationLine.returnRequestLine
        .sourceDocumentLineId;
    if (
      invoiceLine.receivingLineId !== sourceReceivingLineId ||
      invoiceLine.itemId !== postingLine.itemId ||
      invoiceLine.sku !== postingLine.sku ||
      invoice.currency !== text(input.currency).toUpperCase()
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_CREDIT_SOURCE_MISMATCH",
          `Credit memo line ${index + 1} does not reconcile to the original invoice and supplier return.`,
          409,
        ),
      );
    const quantity = units(
      requested.quantity,
      blockingIssues,
      `Credit memo line ${index + 1} quantity`,
      { positive: true },
    );
    // At most what was returned on the return line, across every bill, and
    // at most what was billed on the bill line, across every return.
    const onReturnLine = credited.byReturnLine.get(postingLine.id) || ZERO;
    const onInvoiceLine = credited.byInvoiceLine.get(invoiceLine.id) || ZERO;
    if (
      quantity !== null &&
      (quantity + onReturnLine > decimalUnits(postingLine.quantity) ||
        quantity + onInvoiceLine > decimalUnits(invoiceLine.quantity || 0))
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_CREDIT_QUANTITY_EXCEEDED",
          `Credit memo line ${index + 1} exceeds returned or originally invoiced quantity.`,
          409,
          {
            returnedQuantity: decimalString(decimalUnits(postingLine.quantity)),
            creditedOnReturnLine: decimalString(onReturnLine),
            invoicedQuantity: decimalString(decimalUnits(invoiceLine.quantity || 0)),
            creditedOnInvoiceLine: decimalString(onInvoiceLine),
          },
        ),
      );
    if (quantity !== null && quantity > ZERO) {
      credited.byReturnLine.set(postingLine.id, onReturnLine + quantity);
      credited.byInvoiceLine.set(invoiceLine.id, onInvoiceLine + quantity);
    }
    const originalPrice = decimalUnits(invoiceLine.unitPrice || 0);
    const pricingSource = text(requested.pricingSource) || "original_invoice";
    let unitPrice = originalPrice;
    if (pricingSource === "manual_reviewed") {
      unitPrice = units(
        requested.unitPrice,
        blockingIssues,
        `Credit memo line ${index + 1} reviewed unit price`,
        { nonNegative: true },
      );
      // A reviewed price may credit less than the bill charged, never more.
      if (unitPrice !== null && unitPrice > originalPrice)
        blockingIssues.push(
          issue(
            "SUPPLIER_CREDIT_PRICE_EXCEEDS_INVOICE",
            `Credit memo line ${index + 1} reviewed unit price is above the bill's price of ${decimalString(originalPrice)}.`,
            409,
          ),
        );
    } else if (pricingSource !== "original_invoice")
      blockingIssues.push(
        issue(
          "SUPPLIER_CREDIT_PRICING_SOURCE_INVALID",
          "Credit amount must use original invoice price or an explicitly reviewed manual price.",
        ),
      );
    const enteredTax = units(
      requested.enteredTaxAmount || "0",
      blockingIssues,
      `Credit memo line ${index + 1} entered tax`,
      { nonNegative: true },
    );
    // Tax follows the bill line's tax in proportion to the quantity credited.
    const taxCap =
      quantity === null
        ? null
        : proportionalTaxCap(
            decimalUnits(invoiceLine.enteredTaxAmount || 0),
            quantity,
            decimalUnits(invoiceLine.quantity || 0),
          );
    if (enteredTax !== null && taxCap !== null && enteredTax > taxCap)
      blockingIssues.push(
        issue(
          "SUPPLIER_CREDIT_TAX_EXCEEDS_INVOICE",
          `Credit memo line ${index + 1} tax is above the bill's tax for that quantity, ${decimalString(taxCap)}.`,
          409,
        ),
      );
    const lineAmount =
      quantity === null || unitPrice === null ? ZERO : multiply(quantity, unitPrice);
    subtotal += lineAmount;
    tax += enteredTax || ZERO;
    lines.push({
      supplierInvoiceLineId: invoiceLine.id,
      returnPostingLineId: postingLine.id,
      quantity: quantity === null ? "0.0000" : decimalString(quantity),
      unitPrice: unitPrice === null ? "0.0000" : decimalString(unitPrice),
      lineAmount: decimalString(lineAmount),
      enteredTaxAmount:
        enteredTax === null ? "0.0000" : decimalString(enteredTax),
      totalAmount: decimalString(lineAmount + (enteredTax || ZERO)),
      pricingSource,
    });
  }
  // The number is stored as entered and is unique per workspace, so say so in
  // the preview instead of letting the create fail on the unique index.
  const creditMemoNumber = text(input.creditMemoNumber);
  if (
    creditMemoNumber &&
    (await prisma.supplierCreditMemo.findUnique({
      where: { tenantId_creditMemoNumber: { tenantId, creditMemoNumber } },
      select: { id: true },
    }))
  )
    blockingIssues.push(supplierCreditMemoNumberDuplicate(creditMemoNumber));
  return basePlan("supplier_credit_memo", blockingIssues, {
    invoice: {
      id: invoice.id,
      supplierId: invoice.supplierId,
      supplierName: invoice.supplierName,
      currency: invoice.currency,
    },
    returnPosting: { id: posting.id, postingNumber: posting.postingNumber },
    creditMemo: {
      creditMemoNumber,
      currency: text(input.currency).toUpperCase(),
      subtotalAmount: decimalString(subtotal),
      enteredTaxAmount: decimalString(tax),
      totalAmount: decimalString(subtotal + tax),
    },
    lines,
    factsToCreate: {
      supplierCreditMemos: 1,
      supplierCreditMemoLines: lines.length,
      payments: 0,
      journalEntries: 0,
    },
  });
}

export const financeFixed = decimalString;
export const financeUnits = decimalUnits;
// Quantity × price in units of 0.0001, rounded half away from zero, as a
// line amount is.
export const financeTimes = multiply;
