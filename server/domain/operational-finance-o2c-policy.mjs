import {
  financeFixed as fixed,
  financeUnits as units,
} from "./operational-finance-policy.mjs";
import { SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES } from "./outbound-transaction-policy.mjs";

const SCALE = 10_000n;
const ZERO = 0n;
const text = (value) => String(value ?? "").trim();
const issue = (code, message, status = 422, details) => ({
  code,
  message,
  status,
  ...(details ? { details } : {}),
});
const multiply = (left, right) => {
  const product = BigInt(left) * BigInt(right);
  const negative = product < ZERO;
  const absolute = negative ? -product : product;
  const rounded = (absolute + SCALE / 2n) / SCALE;
  return negative ? -rounded : rounded;
};
const decimal = (value, issues, label, positive = false) => {
  try {
    const parsed = units(value);
    if ((positive && parsed <= ZERO) || (!positive && parsed < ZERO))
      issues.push(
        issue(
          "FINANCE_DECIMAL_INVALID",
          `${label} must be ${positive ? "positive" : "non-negative"}.`,
        ),
      );
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
};
const plan = (operation, blockingIssues, extra = {}) => ({
  operation,
  allowed: blockingIssues.length === 0,
  blockingIssues,
  warnings: [],
  paymentExecution: false,
  refundExecution: false,
  ledgerMutation: false,
  fxConverted: false,
  ...extra,
});

export async function buildCustomerInvoicePlan({
  prisma,
  tenantId,
  input = {},
  currentInvoiceId,
  consumeExisting = false,
}) {
  const blockingIssues = [];
  const shipmentId = text(input.shipmentId);
  const currency = text(input.currency).toUpperCase();
  const requestedLines = Array.isArray(input.lines) ? input.lines : [];
  if (!text(input.invoiceNumber))
    blockingIssues.push(
      issue("CUSTOMER_INVOICE_NUMBER_REQUIRED", "Invoice number is required."),
    );
  if (!shipmentId)
    blockingIssues.push(
      issue("POSTED_SHIPMENT_REQUIRED", "A posted shipment is required."),
    );
  if (!/^[A-Z]{3}$/.test(currency))
    blockingIssues.push(
      issue("FINANCE_CURRENCY_INVALID", "Currency must be a three-letter ISO code."),
    );
  if (!text(input.invoiceDate) || !text(input.dueDate))
    blockingIssues.push(
      issue(
        "CUSTOMER_INVOICE_DATE_REQUIRED",
        "Invoice date and due date are required.",
      ),
    );
  if (!requestedLines.length)
    blockingIssues.push(
      issue("CUSTOMER_INVOICE_LINES_REQUIRED", "At least one invoice line is required."),
    );
  const lineIds = requestedLines.map((line) => text(line.shipmentLineId));
  if (
    lineIds.some((id) => !id) ||
    new Set(lineIds).size !== lineIds.length
  )
    blockingIssues.push(
      issue(
        "CUSTOMER_INVOICE_SOURCE_DUPLICATE",
        "Every invoice line requires one explicit, non-duplicated shipment line.",
      ),
    );
  if (blockingIssues.length)
    return plan("customer_invoice_draft", blockingIssues, { lines: [] });
  const shipment = await prisma.shipmentDocument.findFirst({
    where: { id: shipmentId, tenantId },
    include: {
      salesOrder: true,
      lines: {
        where: { id: { in: lineIds } },
        include: { salesOrderLine: true, item: true },
      },
    },
  });
  if (
    !shipment ||
    shipment.postingStatus !== "posted" ||
    shipment.reversedAt ||
    shipment.lines.length !== lineIds.length
  )
    return plan("customer_invoice_draft", [
      issue(
        "POSTED_SHIPMENT_REQUIRED",
        "Every customer invoice line must come from a non-reversed posted shipment.",
        409,
      ),
    ]);
  if (shipment.salesOrder.currency !== currency)
    blockingIssues.push(
      issue(
        "FINANCE_CURRENCY_MISMATCH",
        "Customer invoice currency must match the sales order currency; no FX conversion is available.",
        409,
      ),
    );
  const previous = consumeExisting
    ? await prisma.customerInvoiceLine.findMany({
        where: {
          shipmentLineId: { in: lineIds },
          ...(currentInvoiceId
            ? { customerInvoiceId: { not: currentInvoiceId } }
            : {}),
          customerInvoice: {
            tenantId,
            status: { in: [...SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES] },
          },
        },
        select: { shipmentLineId: true, quantity: true },
      })
    : [];
  const previousByLine = new Map();
  for (const row of previous)
    previousByLine.set(
      row.shipmentLineId,
      (previousByLine.get(row.shipmentLineId) || ZERO) + units(row.quantity),
    );
  const shipmentById = new Map(
    shipment.lines.map((line) => [line.id, line]),
  );
  let subtotal = ZERO;
  let tax = ZERO;
  const lines = [];
  for (let index = 0; index < requestedLines.length; index += 1) {
    const requested = requestedLines[index];
    const shipmentLine = shipmentById.get(text(requested.shipmentLineId));
    if (!shipmentLine) continue;
    const salesLine = shipmentLine.salesOrderLine;
    if (
      shipmentLine.salesOrderLineId !== salesLine.id ||
      salesLine.salesOrderId !== shipment.salesOrderId ||
      shipmentLine.itemId !== salesLine.itemId ||
      shipmentLine.sku !== salesLine.sku ||
      shipmentLine.item.tenantId !== tenantId
    )
      blockingIssues.push(
        issue(
          "CUSTOMER_INVOICE_SOURCE_INVALID",
          `Line ${index + 1} does not reconcile to the authoritative shipment and sales order.`,
          409,
        ),
      );
    if (salesLine.unitPrice === null || salesLine.unitPrice === undefined)
      blockingIssues.push(
        issue(
          "SALES_PRICE_FACT_REQUIRED",
          `Line ${index + 1} has no authoritative sales-order price and cannot be invoiced.`,
          409,
        ),
      );
    const quantity = decimal(
      requested.quantity,
      blockingIssues,
      `Line ${index + 1} quantity`,
      true,
    );
    const enteredTax = decimal(
      requested.enteredTaxAmount || "0",
      blockingIssues,
      `Line ${index + 1} entered tax`,
    );
    const posted = units(shipmentLine.postedQuantity);
    const previouslyInvoiced = previousByLine.get(shipmentLine.id) || ZERO;
    if (
      quantity !== null &&
      quantity + previouslyInvoiced > posted
    )
      blockingIssues.push(
        issue(
          "CUSTOMER_INVOICE_QUANTITY_EXCEEDS_SHIPPED",
          `Line ${index + 1} exceeds shipped not-yet-invoiced quantity.`,
          409,
          {
            shipmentLineId: shipmentLine.id,
            shippedQuantity: fixed(posted),
            previouslyInvoicedQuantity: fixed(previouslyInvoiced),
          },
        ),
      );
    const unitPrice =
      salesLine.unitPrice === null || salesLine.unitPrice === undefined
        ? ZERO
        : units(salesLine.unitPrice);
    const lineAmount =
      quantity === null ? ZERO : multiply(quantity, unitPrice);
    subtotal += lineAmount;
    tax += enteredTax || ZERO;
    lines.push({
      lineNumber: index + 1,
      shipmentLineId: shipmentLine.id,
      salesOrderLineId: salesLine.id,
      itemId: salesLine.itemId,
      sku: salesLine.sku,
      itemName: salesLine.itemName,
      quantity: quantity === null ? "0.0000" : fixed(quantity),
      unit: salesLine.unit,
      unitPrice: fixed(unitPrice),
      lineAmount: fixed(lineAmount),
      enteredTaxAmount:
        enteredTax === null ? "0.0000" : fixed(enteredTax),
      totalAmount: fixed(lineAmount + (enteredTax || ZERO)),
      shippedQuantity: fixed(posted),
      previouslyInvoicedQuantity: fixed(previouslyInvoiced),
    });
  }
  const total = subtotal + tax;
  if (text(input.totalAmount)) {
    const enteredTotal = decimal(
      input.totalAmount,
      blockingIssues,
      "Invoice total",
    );
    if (enteredTotal !== null && enteredTotal !== total)
      blockingIssues.push(
        issue(
          "CUSTOMER_INVOICE_TOTAL_MISMATCH",
          "Invoice total must equal authoritative sales price times quantity plus explicitly entered tax.",
        ),
      );
  }
  return plan("customer_invoice_draft", blockingIssues, {
    source: {
      salesOrderId: shipment.salesOrderId,
      shipmentId: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      customerId: shipment.salesOrder.customerId,
      customerName: shipment.salesOrder.customerName,
    },
    invoice: {
      invoiceNumber: text(input.invoiceNumber),
      currency,
      invoiceDate: text(input.invoiceDate),
      dueDate: text(input.dueDate),
      subtotalAmount: fixed(subtotal),
      enteredTaxAmount: fixed(tax),
      totalAmount: fixed(total),
    },
    lines,
    factsToCreate: {
      customerInvoices: 1,
      customerInvoiceLines: lines.length,
      receivableObligations: 0,
      payments: 0,
      refunds: 0,
      journalEntries: 0,
    },
  });
}

export async function buildCustomerCreditNotePlan({
  prisma,
  tenantId,
  input = {},
}) {
  const blockingIssues = [];
  const creditNumber = text(input.creditNoteNumber);
  const currency = text(input.currency).toUpperCase();
  const requested = Array.isArray(input.lines) ? input.lines : [];
  if (!creditNumber)
    blockingIssues.push(
      issue(
        "CUSTOMER_CREDIT_NUMBER_REQUIRED",
        "Customer credit note number is required.",
      ),
    );
  if (!/^[A-Z]{3}$/.test(currency))
    blockingIssues.push(
      issue(
        "FINANCE_CURRENCY_INVALID",
        "Currency must be a three-letter ISO code.",
      ),
    );
  const lineKeys = requested.map(
    (line) =>
      `${text(line.customerInvoiceLineId)}|${text(line.returnPostingLineId)}`,
  );
  if (
    lineKeys.some((key) => key === "|") ||
    new Set(lineKeys).size !== lineKeys.length
  )
    blockingIssues.push(
      issue(
        "CUSTOMER_CREDIT_SOURCE_DUPLICATE",
        "Every credit line requires one explicit, non-duplicated invoice and return line pair.",
      ),
    );
  const invoice = await prisma.customerInvoice.findFirst({
    where: { id: text(input.customerInvoiceId), tenantId },
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
    },
  });
  if (!invoice || !["approved", "issued", "disputed"].includes(invoice.status))
    blockingIssues.push(
      issue(
        "CUSTOMER_INVOICE_REQUIRED",
        "Customer credit note requires an approved or issued customer invoice.",
        409,
      ),
    );
  if (
    !posting ||
    posting.postingType !== "customer_return_receipt" ||
    posting.postingStatus !== "posted" ||
    posting.reversedAt
  )
    blockingIssues.push(
      issue(
        "CUSTOMER_RETURN_RECEIPT_REQUIRED",
        "Customer credit note requires a non-reversed posted customer return receipt.",
        409,
      ),
    );
  if (!requested.length)
    blockingIssues.push(
      issue("CUSTOMER_CREDIT_LINES_REQUIRED", "Credit note lines are required."),
    );
  if (blockingIssues.length)
    return plan("customer_credit_note", blockingIssues, { lines: [] });
  const invoiceById = new Map(invoice.lines.map((line) => [line.id, line]));
  const postingById = new Map(posting.lines.map((line) => [line.id, line]));
  const prior = await prisma.customerCreditNoteLine.findMany({
    where: {
      customerCreditNote: {
        tenantId,
        status: { in: ["draft", "approved"] },
      },
      customerInvoiceLineId: {
        in: requested.map((line) => text(line.customerInvoiceLineId)),
      },
    },
  });
  const priorByPair = new Map();
  for (const row of prior) {
    const key = `${row.customerInvoiceLineId}|${row.returnPostingLineId}`;
    priorByPair.set(key, (priorByPair.get(key) || ZERO) + units(row.quantity));
  }
  let subtotal = ZERO;
  let tax = ZERO;
  const lines = [];
  for (let index = 0; index < requested.length; index += 1) {
    const row = requested[index];
    const invoiceLine = invoiceById.get(text(row.customerInvoiceLineId));
    const postingLine = postingById.get(text(row.returnPostingLineId));
    if (!invoiceLine || !postingLine) {
      blockingIssues.push(
        issue(
          "CUSTOMER_CREDIT_SOURCE_LINE_INVALID",
          `Credit note line ${index + 1} does not belong to the selected invoice and return receipt.`,
          409,
        ),
      );
      continue;
    }
    const sourceShipmentLineId =
      postingLine.returnAuthorizationLine.returnRequestLine
        .sourceDocumentLineId;
    if (
      invoiceLine.shipmentLineId !== sourceShipmentLineId ||
      invoiceLine.itemId !== postingLine.itemId ||
      invoiceLine.sku !== postingLine.sku ||
      invoice.currency !== currency
    )
      blockingIssues.push(
        issue(
          "CUSTOMER_CREDIT_SOURCE_MISMATCH",
          `Credit note line ${index + 1} does not reconcile to the original invoice and return receipt.`,
          409,
        ),
      );
    const quantity = decimal(
      row.quantity,
      blockingIssues,
      `Credit note line ${index + 1} quantity`,
      true,
    );
    const key = `${invoiceLine.id}|${postingLine.id}`;
    const credited = priorByPair.get(key) || ZERO;
    if (
      quantity !== null &&
      (quantity + credited > units(postingLine.quantity) ||
        quantity + credited > units(invoiceLine.quantity))
    )
      blockingIssues.push(
        issue(
          "CUSTOMER_CREDIT_QUANTITY_EXCEEDED",
          `Credit note line ${index + 1} exceeds returned or originally invoiced quantity.`,
          409,
        ),
      );
    const pricingSource = text(row.pricingSource) || "original_invoice";
    let unitPrice = units(invoiceLine.unitPrice);
    if (pricingSource === "manual_reviewed")
      unitPrice = decimal(
        row.unitPrice,
        blockingIssues,
        `Credit note line ${index + 1} reviewed price`,
      );
    else if (pricingSource !== "original_invoice")
      blockingIssues.push(
        issue(
          "CUSTOMER_CREDIT_PRICING_SOURCE_INVALID",
          "Credit amount must use original invoice price or an explicitly reviewed manual price.",
        ),
      );
    const enteredTax = decimal(
      row.enteredTaxAmount || "0",
      blockingIssues,
      `Credit note line ${index + 1} entered tax`,
    );
    const lineAmount =
      quantity === null || unitPrice === null ? ZERO : multiply(quantity, unitPrice);
    subtotal += lineAmount;
    tax += enteredTax || ZERO;
    lines.push({
      customerInvoiceLineId: invoiceLine.id,
      returnPostingLineId: postingLine.id,
      quantity: quantity === null ? "0.0000" : fixed(quantity),
      unitPrice: unitPrice === null ? "0.0000" : fixed(unitPrice),
      lineAmount: fixed(lineAmount),
      enteredTaxAmount:
        enteredTax === null ? "0.0000" : fixed(enteredTax),
      totalAmount: fixed(lineAmount + (enteredTax || ZERO)),
      pricingSource,
    });
  }
  return plan("customer_credit_note", blockingIssues, {
    invoice: {
      id: invoice.id,
      customerId: invoice.customerId,
      customerName: invoice.customerNameSnapshot,
      currency: invoice.currency,
    },
    returnPosting: { id: posting.id, postingNumber: posting.postingNumber },
    creditNote: {
      creditNoteNumber: creditNumber,
      currency,
      subtotalAmount: fixed(subtotal),
      enteredTaxAmount: fixed(tax),
      totalAmount: fixed(subtotal + tax),
    },
    lines,
    factsToCreate: {
      customerCreditNotes: 1,
      customerCreditNoteLines: lines.length,
      refunds: 0,
      payments: 0,
      journalEntries: 0,
    },
  });
}
