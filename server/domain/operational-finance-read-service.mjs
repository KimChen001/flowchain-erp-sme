import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { can } from "../auth/authorization-service.mjs";
import { paymentRecordsView } from "./payment-record-command-service.mjs";
import { financeFixed, financeUnits } from "./operational-finance-policy.mjs";

export class OperationalFinanceReadError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "OperationalFinanceReadError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new OperationalFinanceReadError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const serial = (value) =>
  value && typeof value.toISOString === "function"
    ? value.toISOString()
    : value;
const decimal = (value) =>
  value === null || value === undefined ? null : String(value);

// Every finance read needs the record's own read permission. A role without
// it gets 403, not an empty list, so the UI can say why.
function assertRead(actor, permission) {
  if (!can({ actor, permission, tenantId: actor.tenantId }))
    fail("PERMISSION_DENIED", "Your role cannot view this finance record.", 403, { permission });
}

const PAYABLE_PAYMENT_STATUSES = ["approved", "export_ready", "partially_settled"];

function pageQuery(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 25)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function actions(actor, capability, row, type) {
  if (!capability?.enabled) return [];
  if (type === "invoice") {
    const values = [];
    if (can({ actor, permission: "finance.supplier_invoice.revise", tenantId: actor.tenantId }) && row.status === "draft")
      values.push("revise", "submit");
    if (can({ actor, permission: "finance.three_way_match.execute", tenantId: actor.tenantId }) && row.status === "submitted")
      values.push("match");
    // An exception invoice can be approved only once every match exception
    // is approved; until then the list must not offer Approve.
    if (
      can({ actor, permission: "finance.supplier_invoice.approve", tenantId: actor.tenantId }) &&
      (row.status === "matched" || (row.status === "exception" && Number(row.blockingExceptionCount || 0) === 0))
    )
      values.push("approve");
    if (
      can({ actor, permission: "finance.supplier_invoice.revise", tenantId: actor.tenantId }) &&
      ["draft", "submitted", "matched", "exception"].includes(row.status)
    )
      values.push("cancel");
    return values;
  }
  if (type === "payable") {
    // A payment can be recorded until nothing is outstanding; a held bill to
    // pay is released first.
    const payment = PAYABLE_PAYMENT_STATUSES.includes(row.status) && Number(row.outstandingAmount) > 0 && can({ actor, permission: "finance.payable.record_payment", tenantId: actor.tenantId }) ? ["record_payment"] : [];
    if (row.status === "approved") return [...payment, ...[["hold", "finance.payable.hold"], ["mark_export_ready", "finance.payable.mark_export_ready"]].filter(([, permission]) => can({ actor, permission, tenantId: actor.tenantId })).map(([action]) => action)];
    if (row.status === "export_ready") return [...payment, ...(can({ actor, permission: "finance.payable.hold", tenantId: actor.tenantId }) ? ["hold"] : [])];
    if (row.status === "held" && can({ actor, permission: "finance.payable.release", tenantId: actor.tenantId })) return ["release"];
    return payment;
  }
  if (type === "creditMemo") {
    if (can({ actor, permission: "finance.supplier_credit.approve", tenantId: actor.tenantId }) && row.status === "draft")
      return ["approve"];
  }
  return [];
}

// Money on a finance record needs finance.amounts.read and the supplier needs
// finance.partner_snapshot.read. A hidden value is null with a fieldVisibility
// entry, never 0. A quantity exception's values are quantities, not money.
const FINANCE_MONEY_KEYS = ["subtotalAmount", "enteredTaxAmount", "totalAmount", "varianceAmount", "originalAmount", "outstandingAmount", "approvedCreditAmount", "paidAmount", "unitPrice", "lineAmount", "poUnitPrice", "invoiceUnitPrice", "priceVariance", "amountVariance", "expectedValue", "actualValue", "varianceValue"];
const QUANTITY_VALUE_KEYS = new Set(["expectedValue", "actualValue", "varianceValue"]);

function protectFinanceFields(model, actor) {
  const amountsVisible = can({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId });
  const partnerVisible = can({ actor, permission: "finance.partner_snapshot.read", tenantId: actor.tenantId });
  const output = { ...model, fieldVisibility: { ...(model.fieldVisibility || {}) } };
  const quantityException = model.exceptionType === "quantity";
  for (const key of FINANCE_MONEY_KEYS) if (key in output && !(quantityException && QUANTITY_VALUE_KEYS.has(key))) { if (!amountsVisible) output[key] = null; output.fieldVisibility[key] = { visible: amountsVisible, reasonCode: amountsVisible ? null : "FIELD_PERMISSION_DENIED", permission: "finance.amounts.read" }; }
  for (const key of ["supplierName", "supplierNameSnapshot", "supplierSnapshot"]) if (key in output) { if (!partnerVisible) output[key] = null; output.fieldVisibility[key] = { visible: partnerVisible, reasonCode: partnerVisible ? null : "FIELD_PERMISSION_DENIED", permission: "finance.partner_snapshot.read" }; }
  return output;
}

function invoiceSummary(row, actor, capabilities) {
  return protectFinanceFields({
    id: row.id,
    invoiceNumber: row.invoiceNumber || row.id,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    relatedPoId: row.relatedPoId,
    relatedGrnId: row.relatedGrnId,
    invoiceDate: serial(row.invoiceDate),
    dueDate: serial(row.dueDate),
    subtotalAmount: decimal(row.subtotalAmount ?? row.amount),
    enteredTaxAmount: decimal(row.enteredTaxAmount ?? 0),
    totalAmount: decimal(row.totalAmount ?? row.amount),
    currency: row.currency,
    status: row.status,
    matchStatus: row.matchStatus,
    varianceAmount: decimal(row.varianceAmount),
    version: row.version,
    availableActions: actions(
      actor,
      capabilities["supplier-invoice"],
      row,
      "invoice",
    ),
  }, actor);
}

function payableSummary(row, actor, capabilities) {
  return protectFinanceFields({
    id: row.id,
    obligationNumber: row.obligationNumber,
    supplierInvoiceId: row.supplierInvoiceId,
    supplierInvoiceNumber: row.supplierInvoice?.invoiceNumber,
    supplierName: row.supplierInvoice?.supplierName,
    originalAmount: decimal(row.originalAmount),
    outstandingAmount: decimal(row.outstandingAmount),
    approvedCreditAmount: decimal(row.approvedCreditAmount),
    // What was paid so far: the original amount less approved credits and
    // what is still outstanding.
    paidAmount: financeFixed(financeUnits(row.originalAmount) - financeUnits(row.approvedCreditAmount || 0) - financeUnits(row.outstandingAmount)),
    currency: row.currency,
    dueDate: serial(row.dueDate),
    status: row.status,
    version: row.version,
    settlementExecuted: false,
    availableActions: actions(
      actor,
      capabilities["payable-obligation"],
      row,
      "payable",
    ),
  }, actor);
}

function creditMemoSummary(row, actor, capabilities) {
  return protectFinanceFields({
    id: row.id,
    creditMemoNumber: row.creditMemoNumber,
    supplierInvoiceId: row.supplierInvoiceId,
    supplierInvoiceNumber: row.supplierInvoice?.invoiceNumber,
    returnPostingId: row.returnPostingId,
    returnPostingNumber: row.returnPosting?.postingNumber,
    supplierName: row.supplierNameSnapshot,
    subtotalAmount: decimal(row.subtotalAmount),
    enteredTaxAmount: decimal(row.enteredTaxAmount),
    totalAmount: decimal(row.totalAmount),
    currency: row.currency,
    status: row.status,
    version: row.version,
    availableActions: actions(
      actor,
      capabilities["supplier-credit-memo"],
      row,
      "creditMemo",
    ),
  }, actor);
}

export function createOperationalFinanceReadService({
  prisma,
  capabilities = {},
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function actor(context) {
    return resolveProvisionedActor(prisma, context?.identity || context);
  }

  async function listSupplierInvoices(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.supplier_invoice.read");
    const { page, pageSize, skip } = pageQuery(query);
    const search = text(query.search);
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
      ...(text(query.currency)
        ? { currency: text(query.currency).toUpperCase() }
        : {}),
      ...(search
        ? {
            OR: [
              { invoiceNumber: { contains: search, mode: "insensitive" } },
              { supplierName: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.supplierInvoice.count({ where }),
      prisma.supplierInvoice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: pageSize,
      }),
    ]);
    // Open or rejected match exceptions per invoice, which block approval.
    const exceptionRows = rows.some((row) => row.status === "exception")
      ? await prisma.financeMatchException.groupBy({
          by: ["supplierInvoiceId"],
          where: { supplierInvoiceId: { in: rows.filter((row) => row.status === "exception").map((row) => row.id) }, status: { in: ["open", "rejected"] } },
          _count: { _all: true },
        })
      : [];
    const blocking = new Map(exceptionRows.map((row) => [row.supplierInvoiceId, row._count._all]));
    return {
      items: rows.map((row) => invoiceSummary({ ...row, blockingExceptionCount: blocking.get(row.id) || 0 }, current, capabilities)),
      page,
      pageSize,
      total,
      capabilities,
    };
  }

  async function supplierInvoiceDetail(invoiceId, context) {
    const current = await actor(context);
    assertRead(current, "finance.supplier_invoice.read");
    const invoice = await prisma.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId: current.tenantId },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        matchRuns: {
          orderBy: { createdAt: "desc" },
          include: {
            lines: { orderBy: { id: "asc" } },
            exceptions: { orderBy: { createdAt: "asc" } },
          },
        },
        payableObligation: { include: { paymentRecords: true } },
        supplierCreditMemos: {
          orderBy: { createdAt: "desc" },
          include: { lines: true },
        },
      },
    });
    if (!invoice)
      fail("SUPPLIER_INVOICE_NOT_FOUND", "Supplier invoice was not found.", 404);
    // The same approval rule as the list: open or rejected exceptions on any
    // match run block approval, so the detail does not offer it.
    const blockingExceptionCount = invoice.matchRuns
      .flatMap((run) => run.exceptions || [])
      .filter((entry) => ["open", "rejected"].includes(entry.status)).length;
    const summary = invoiceSummary({ ...invoice, blockingExceptionCount }, current, capabilities);
    const partner = protectFinanceFields({ supplierSnapshot: invoice.supplierSnapshot }, current);
    // The match result is part of the three-way match, which has its own read
    // permission; without it the invoice shows no match lines or variances.
    const matchVisible = can({ actor: current, permission: "finance.three_way_match.read", tenantId: current.tenantId });
    const match = matchVisible ? invoice.matchRuns[0] || null : null;
    return {
      ...summary,
      supplierSnapshot: partner.supplierSnapshot,
      fieldVisibility: { ...summary.fieldVisibility, ...partner.fieldVisibility },
      lines: invoice.lines.map((line) => protectFinanceFields({
        id: line.id,
        lineNumber: line.lineNumber,
        purchaseOrderLineId: line.purchaseOrderLineId,
        receivingLineId: line.receivingLineId,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        unit: line.unit,
        quantity: decimal(line.quantity),
        unitPrice: decimal(line.unitPrice),
        lineAmount: decimal(line.lineAmount ?? line.amount),
        enteredTaxAmount: decimal(line.enteredTaxAmount ?? 0),
        totalAmount: decimal(line.amount),
      }, current)),
      matchVisible,
      match: match
        ? {
            id: match.id,
            matchNumber: match.matchNumber,
            status: match.status,
            blockingReason: match.blockingReason,
            createdAt: serial(match.createdAt),
            lines: match.lines.map((line) => protectFinanceFields({
              id: line.id,
              supplierInvoiceLineId: line.supplierInvoiceLineId,
              purchaseOrderLineId: line.purchaseOrderLineId,
              receivingLineId: line.receivingLineId,
              status: line.status,
              orderedQuantity: decimal(line.orderedQuantity),
              receivedQuantity: decimal(line.receivedQuantity),
              previouslyInvoicedQuantity: decimal(
                line.previouslyInvoicedQuantity,
              ),
              invoiceQuantity: decimal(line.invoiceQuantity),
              poUnitPrice: decimal(line.poUnitPrice),
              invoiceUnitPrice: decimal(line.invoiceUnitPrice),
              quantityVariance: decimal(line.quantityVariance),
              priceVariance: decimal(line.priceVariance),
              amountVariance: decimal(line.amountVariance),
              currency: line.currency,
            }, current)),
            exceptions: match.exceptions.map((entry) => protectFinanceFields({
              id: entry.id,
              matchLineId: entry.matchLineId,
              exceptionType: entry.exceptionType,
              status: entry.status,
              expectedValue: decimal(entry.expectedValue),
              actualValue: decimal(entry.actualValue),
              varianceValue: decimal(entry.varianceValue),
              currency: entry.currency,
              resolution: entry.resolution,
              version: entry.version,
            }, current)),
          }
        : null,
      payable: invoice.payableObligation && can({ actor: current, permission: "finance.payable.read", tenantId: current.tenantId })
        ? {
            ...payableSummary(invoice.payableObligation, current, capabilities),
            payments: paymentRecordsView(invoice.payableObligation.paymentRecords, {
              amountsVisible: can({ actor: current, permission: "finance.amounts.read", tenantId: current.tenantId }),
              canRecord: Boolean(capabilities["payable-obligation"]?.enabled) && can({ actor: current, permission: "finance.payable.record_payment", tenantId: current.tenantId }),
            }),
          }
        : null,
      supplierCreditMemos: (can({ actor: current, permission: "finance.supplier_credit.read", tenantId: current.tenantId }) ? invoice.supplierCreditMemos : []).map((memo) =>
        creditMemoSummary(memo, current, capabilities),
      ),
      evidence: [
        {
          type: "PurchaseOrder",
          id: invoice.relatedPoId,
          relationship: "ordered_under",
        },
        {
          type: "ReceivingDocument",
          id: invoice.relatedGrnId,
          relationship: "received_under",
        },
        ...(match
          ? [
              {
                type: "ThreeWayMatch",
                id: match.id,
                relationship: "matched_by",
              },
            ]
          : []),
      ].filter((entry) => entry.id),
      reconciliation: match
        ? match.lines.map((line) => ({
            supplierInvoiceLineId: line.supplierInvoiceLineId,
            poLineId: line.purchaseOrderLineId,
            receivingLineId: line.receivingLineId,
            status: line.status,
            matched:
              line.status === "matched" ||
              !match.exceptions.some(
                (entry) =>
                  entry.matchLineId === line.id &&
                  !["approved", "resolved"].includes(entry.status),
              ),
          }))
        : [],
      capabilities,
    };
  }

  async function listMatchExceptions(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.three_way_match.read");
    const { page, pageSize, skip } = pageQuery(query);
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.financeMatchException.count({ where }),
      prisma.financeMatchException.findMany({
        where,
        include: { supplierInvoice: true, match: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => protectFinanceFields({
        id: row.id,
        matchId: row.matchId,
        matchNumber: row.match.matchNumber,
        matchLineId: row.matchLineId,
        supplierInvoiceId: row.supplierInvoiceId,
        invoiceNumber: row.supplierInvoice.invoiceNumber,
        supplierName: row.supplierInvoice.supplierName,
        exceptionType: row.exceptionType,
        status: row.status,
        expectedValue: decimal(row.expectedValue),
        actualValue: decimal(row.actualValue),
        varianceValue: decimal(row.varianceValue),
        currency: row.currency,
        resolution: row.resolution,
        version: row.version,
        availableActions:
          can({ actor: current, permission: "finance.match_exception.review", tenantId: current.tenantId }) && row.status === "open"
            ? ["approve", "reject"]
            : [],
      }, current)),
      page,
      pageSize,
      total,
      capabilities,
    };
  }

  async function listPayables(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.payable.read");
    const { page, pageSize, skip } = pageQuery(query);
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
      ...(text(query.currency)
        ? { currency: text(query.currency).toUpperCase() }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.payableObligation.count({ where }),
      prisma.payableObligation.findMany({
        where,
        include: { supplierInvoice: true },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        skip,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => payableSummary(row, current, capabilities)),
      page,
      pageSize,
      total,
      currencyAggregationStatus:
        new Set(rows.map((row) => row.currency)).size > 1
          ? "multi_currency_unconverted"
          : "single_currency",
      fxConverted: false,
      capabilities,
    };
  }

  async function listSupplierCreditMemos(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.supplier_credit.read");
    const { page, pageSize, skip } = pageQuery(query);
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.supplierCreditMemo.count({ where }),
      prisma.supplierCreditMemo.findMany({
        where,
        include: { supplierInvoice: true, returnPosting: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) =>
        creditMemoSummary(row, current, capabilities),
      ),
      page,
      pageSize,
      total,
      capabilities,
    };
  }

  async function entryData(context) {
    const current = await actor(context);
    // Entry data serves the supplier invoice and credit memo forms; the endpoint is shared, so a role
    // that cannot create these documents gets empty lists, not a 403.
    if (!["finance.supplier_invoice.create", "finance.supplier_credit.create"].some((permission) => can({ actor: current, permission, tenantId: current.tenantId })))
      return { suppliers: [], purchaseOrders: [], receivingDocuments: [], supplierReturnPostings: [], capabilities };
    const pricesVisible = can({ actor: current, permission: "procurement.prices.read", tenantId: current.tenantId });
    const [suppliers, purchaseOrders, receivingDocuments, returnPostings] =
      await Promise.all([
        prisma.supplier.findMany({
          where: { tenantId: current.tenantId, status: "active" },
          select: { id: true, code: true, name: true },
          orderBy: { name: "asc" },
          take: 100,
        }),
        prisma.purchaseOrder.findMany({
          where: { tenantId: current.tenantId },
          include: { lines: true },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        prisma.receivingDocument.findMany({
          where: {
            tenantId: current.tenantId,
            postingStatus: "posted",
            reversedAt: null,
          },
          include: { lines: true },
          orderBy: { postedAt: "desc" },
          take: 100,
        }),
        prisma.returnPostingDocument.findMany({
          where: {
            tenantId: current.tenantId,
            postingType: "supplier_return_dispatch",
            postingStatus: "posted",
            reversedAt: null,
          },
          include: { lines: true },
          orderBy: { postedAt: "desc" },
          take: 100,
        }),
      ]);
    return {
      suppliers,
      purchaseOrders: purchaseOrders.map((row) => ({
        id: row.id,
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        currency: row.currency,
        lines: row.lines.map((line) => ({
          id: line.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          orderedQuantity: decimal(line.orderedQuantity),
          unit: line.unit,
          unitPrice: pricesVisible ? decimal(line.unitPrice) : null,
        })),
      })),
      fieldVisibility: {
        unitPrice: { visible: pricesVisible, reasonCode: pricesVisible ? null : "FIELD_PERMISSION_DENIED", permission: "procurement.prices.read" },
      },
      receivingDocuments: receivingDocuments.map((row) => ({
        id: row.id,
        documentNumber: row.documentNumber,
        poId: row.poId,
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        currency: row.currency,
        lines: row.lines.map((line) => ({
          id: line.id,
          purchaseOrderLineId: line.purchaseOrderLineId,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          acceptedQuantity: decimal(line.acceptedQty),
          unit: line.unit,
          warehouseId: line.warehouseId,
        })),
      })),
      supplierReturnPostings: returnPostings.map((row) => ({
        id: row.id,
        postingNumber: row.postingNumber,
        lines: row.lines.map((line) => ({
          id: line.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          quantity: decimal(line.quantity),
          unit: line.unit,
        })),
      })),
      capabilities,
    };
  }

  return {
    listSupplierInvoices,
    supplierInvoiceDetail,
    listMatchExceptions,
    listPayables,
    listSupplierCreditMemos,
    entryData,
  };
}
