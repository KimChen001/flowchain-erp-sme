import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";
import { mergeOperationalSettings } from "./workspace-settings-contract.mjs";
import { RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES } from "./procurement-status-authority.mjs";

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
  const receivingIds = lines.map((line) => line.receivingLineId);
  const poLineIds = lines.map((line) => line.purchaseOrderLineId);
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
  if (lines.some((line) => !line.receivingLineId || !line.purchaseOrderLineId))
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_SOURCE_REQUIRED",
        "Every invoice line requires explicit purchase-order and receiving lines.",
      ),
    );
  if (blockingIssues.length)
    return basePlan("supplier_invoice_draft", blockingIssues, { lines: [] });

  const [receivingRows, poRows, supplier, tenant] = await Promise.all([
    prisma.receivingLine.findMany({
      where: { id: { in: receivingIds } },
      include: { receivingDocument: true },
      orderBy: { id: "asc" },
    }),
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
  if (relatedPoIds.length !== 1 || relatedGrnIds.length !== 1)
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_SOURCE_MIXED",
        "One supplier invoice must use one purchase order and one posted receiving document.",
      ),
    );
  const consumingStatuses = countCommittedOnly
    ? []
    : [...RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES];
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
    const lineAmount = units(
      requested.lineAmount,
      blockingIssues,
      `Line ${index + 1} line amount`,
      { nonNegative: true },
    );
    const enteredTaxAmount = units(
      requested.enteredTaxAmount,
      blockingIssues,
      `Line ${index + 1} entered tax`,
      { nonNegative: true },
    );
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
      receivingDocumentId: relatedGrnIds[0] || null,
    },
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
  // The same rule as the match command: only a submitted invoice starts a
  // match run. An exception invoice is cancelled and entered again instead.
  if (invoice.status !== "submitted")
    blockingIssues.push(
      issue(
        "SUPPLIER_INVOICE_STATUS_INVALID",
        "Only a submitted supplier invoice can start a match run.",
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
  const [receivingRows, poRows, previousRows] = await Promise.all([
    prisma.receivingLine.findMany({
      where: { id: { in: receivingIds } },
      include: { receivingDocument: true },
    }),
    prisma.purchaseOrderLine.findMany({
      where: { id: { in: poLineIds } },
      include: { purchaseOrder: true },
    }),
    prisma.supplierInvoiceLine.findMany({
      where: {
        receivingLineId: { in: receivingIds },
        supplierInvoiceId: { not: invoice.id },
        supplierInvoice: {
          tenantId,
          status: { in: ["matching", "exception", "matched", "approved", "held"] },
        },
      },
      select: { receivingLineId: true, quantity: true },
    }),
  ]);
  const receivingById = new Map(receivingRows.map((row) => [row.id, row]));
  const poById = new Map(poRows.map((row) => [row.id, row]));
  const previousByReceiving = new Map();
  for (const row of previousRows)
    previousByReceiving.set(
      row.receivingLineId,
      (previousByReceiving.get(row.receivingLineId) || ZERO) +
        decimalUnits(row.quantity || 0),
    );
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
    const receivedQuantity = decimalUnits(receiving.acceptedQty || 0);
    const previouslyInvoiced =
      previousByReceiving.get(receiving.id) || ZERO;
    const available = receivedQuantity - previouslyInvoiced;
    const poPrice = decimalUnits(poLine.unitPrice || 0);
    const invoicePrice = decimalUnits(line.unitPrice || 0);
    const invoiceLineAmount = decimalUnits(line.lineAmount ?? line.amount ?? 0);
    const expectedAmount = multiply(invoiceQuantity, poPrice);
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
    const percentageThreshold =
      poPrice === ZERO
        ? ZERO
        : multiply(abs(poPrice), pricePercentageTolerance) / 100n;
    const priceThreshold =
      percentageThreshold > priceAbsoluteTolerance
        ? percentageThreshold
        : priceAbsoluteTolerance;
    if (abs(priceVariance) > priceThreshold)
      lineExceptions.push({
        exceptionType: "price",
        expectedValue: decimalString(poPrice),
        actualValue: decimalString(invoicePrice),
        varianceValue: decimalString(priceVariance),
      });
    if (abs(amountVariance) > amountTolerance)
      lineExceptions.push({
        exceptionType: "amount",
        expectedValue: decimalString(expectedAmount),
        actualValue: decimalString(invoiceLineAmount),
        varianceValue: decimalString(amountVariance),
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
    },
  });
  if (!invoice)
    blockingIssues.push(
      issue("SUPPLIER_INVOICE_NOT_FOUND", "Supplier invoice was not found.", 404),
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
  const requestedLines = Array.isArray(input.lines) ? input.lines : [];
  if (!requestedLines.length)
    blockingIssues.push(
      issue("SUPPLIER_CREDIT_LINES_REQUIRED", "Credit memo lines are required."),
    );
  if (blockingIssues.length)
    return basePlan("supplier_credit_memo", blockingIssues, { lines: [] });
  const invoiceById = new Map(invoice.lines.map((line) => [line.id, line]));
  const postingById = new Map(posting.lines.map((line) => [line.id, line]));
  const priorCredits = await prisma.supplierCreditMemoLine.findMany({
    where: {
      supplierCreditMemo: { tenantId, status: { in: ["draft", "approved"] } },
      supplierInvoiceLineId: {
        in: requestedLines.map((line) => text(line.supplierInvoiceLineId)),
      },
    },
    select: {
      supplierInvoiceLineId: true,
      returnPostingLineId: true,
      quantity: true,
    },
  });
  const priorByPair = new Map();
  for (const row of priorCredits) {
    const key = `${row.supplierInvoiceLineId}|${row.returnPostingLineId}`;
    priorByPair.set(key, (priorByPair.get(key) || ZERO) + decimalUnits(row.quantity));
  }
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
    const pair = `${invoiceLine.id}|${postingLine.id}`;
    const alreadyCredited = priorByPair.get(pair) || ZERO;
    if (
      quantity !== null &&
      (quantity + alreadyCredited > decimalUnits(postingLine.quantity) ||
        quantity + alreadyCredited > decimalUnits(invoiceLine.quantity || 0))
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_CREDIT_QUANTITY_EXCEEDED",
          `Credit memo line ${index + 1} exceeds returned or originally invoiced quantity.`,
          409,
        ),
      );
    const originalPrice = decimalUnits(invoiceLine.unitPrice || 0);
    const pricingSource = text(requested.pricingSource) || "original_invoice";
    let unitPrice = originalPrice;
    if (pricingSource === "manual_reviewed")
      unitPrice = units(
        requested.unitPrice,
        blockingIssues,
        `Credit memo line ${index + 1} reviewed unit price`,
        { nonNegative: true },
      );
    else if (pricingSource !== "original_invoice")
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
  return basePlan("supplier_credit_memo", blockingIssues, {
    invoice: {
      id: invoice.id,
      supplierId: invoice.supplierId,
      supplierName: invoice.supplierName,
      currency: invoice.currency,
    },
    returnPosting: { id: posting.id, postingNumber: posting.postingNumber },
    creditMemo: {
      creditMemoNumber: text(input.creditMemoNumber),
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
