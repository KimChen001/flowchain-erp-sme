import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { can } from "../auth/authorization-service.mjs";
import { escapeLikePattern } from "../persistence/like-pattern.mjs";
import { OperationalFinanceReadError } from "./operational-finance-read-service.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";
import { paymentRecordsView } from "./payment-record-command-service.mjs";

const text = (value) => String(value ?? "").trim();
const decimal = (value) =>
  value === null || value === undefined ? null : String(value);
const serial = (value) =>
  value && typeof value.toISOString === "function" ? value.toISOString() : value;
const fail = (code, message, status = 400, details) => {
  throw new OperationalFinanceReadError(code, message, status, details);
};
const page = (query = {}) => {
  const number = Math.max(1, Number(query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return { page: number, pageSize: size, skip: (number - 1) * size };
};
const validCurrency = (value) => /^[A-Z]{3}$/.test(text(value).toUpperCase());
const CLOSED_DOCUMENT_STATUSES = ["cancelled", "void", "voided", "rejected"];

// The currencies the finance landing reports on: every live supplier and
// customer invoice as well as every open payable and receivable. Invoices
// that have not yet become obligations still carry money, so a workspace with
// only USD supplier invoices is a single-currency workspace, not one with no
// currency data. Amounts are never converted between currencies.
export function financeCurrencyLimitations(...currencyRows) {
  const currencies = [
    ...new Set(
      currencyRows
        .flat()
        .map((row) => text(row?.currency).toUpperCase())
        .filter(validCurrency),
    ),
  ].sort();
  return {
    currencies,
    aggregationStatus:
      currencies.length > 1
        ? "multi_currency_unconverted"
        : currencies.length === 1
          ? "single_currency"
          : "no_currency_data",
    fxConverted: false,
    message:
      currencies.length > 1
        ? "Amounts remain grouped by original currency; no FX conversion is applied."
        : "No FX conversion is applied.",
  };
}

function invoiceActions(actor, capability, row) {
  if (!capability?.enabled) return [];
  if (can({ actor, permission: "finance.customer_invoice.submit", tenantId: actor.tenantId }) && row.status === "draft") return ["submit"];
  if (can({ actor, permission: "finance.customer_invoice.approve", tenantId: actor.tenantId }) && row.status === "submitted") return ["approve"];
  if (can({ actor, permission: "finance.customer_invoice.issue", tenantId: actor.tenantId }) && row.status === "approved") return ["issue"];
  return [];
}

function receivableActions(actor, capability, row) {
  if (!capability?.enabled) return [];
  const result = can({ actor, permission: "finance.receivable.record_external_reference", tenantId: actor.tenantId }) ? ["record_external_reference"] : [];
  // A payment can be recorded until nothing is outstanding, but not while
  // the customer disputes the invoice.
  if (["open", "overdue", "partially_settled"].includes(row.status) && row.disputeStatus !== "open" && Number(row.outstandingAmount) > 0 && can({ actor, permission: "finance.receivable.record_payment", tenantId: actor.tenantId })) result.unshift("record_payment");
  if (["open", "overdue"].includes(row.status) && can({ actor, permission: "finance.receivable.dispute", tenantId: actor.tenantId })) result.unshift("dispute");
  if (row.disputeStatus === "open" && can({ actor, permission: "finance.receivable.resolve_dispute", tenantId: actor.tenantId })) result.unshift("resolve_dispute");
  return result;
}

function creditActions(actor, capability, row) {
  return capability?.enabled && can({ actor, permission: "finance.customer_credit.approve", tenantId: actor.tenantId }) && row.status === "draft"
    ? ["approve"]
    : [];
}

// Every finance read needs the record's own read permission; see the
// supplier side in operational-finance-read-service.mjs.
function assertRead(actor, permission) {
  if (!can({ actor, permission, tenantId: actor.tenantId }))
    fail("PERMISSION_DENIED", "Your role cannot view this finance record.", 403, { permission });
}

const amountsVisibleFor = (actor) => can({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId });

function protectFinanceFields(model, actor) {
  const amountsVisible = can({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId });
  const partnerVisible = can({ actor, permission: "finance.partner_snapshot.read", tenantId: actor.tenantId });
  const output = { ...model, fieldVisibility: { ...(model.fieldVisibility || {}) } };
  for (const key of ["subtotalAmount", "enteredTaxAmount", "totalAmount", "originalAmount", "outstandingAmount", "approvedCreditAmount", "paidAmount", "unitPrice", "lineAmount"]) if (key in output) { if (!amountsVisible) output[key] = null; output.fieldVisibility[key] = { visible: amountsVisible, reasonCode: amountsVisible ? null : "FIELD_PERMISSION_DENIED", permission: "finance.amounts.read" }; }
  for (const key of ["customerName", "customerNameSnapshot"]) if (key in output) { if (!partnerVisible) output[key] = null; output.fieldVisibility[key] = { visible: partnerVisible, reasonCode: partnerVisible ? null : "FIELD_PERMISSION_DENIED", permission: "finance.partner_snapshot.read" }; }
  return output;
}

function invoiceSummary(row, actor, capabilities) {
  return protectFinanceFields({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    salesOrderId: row.salesOrderId,
    salesOrderNumber: row.salesOrder?.orderNumber,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment?.shipmentNumber,
    customerId: row.customerId,
    customerName: row.customerNameSnapshot,
    invoiceDate: serial(row.invoiceDate),
    dueDate: serial(row.dueDate),
    subtotalAmount: decimal(row.subtotalAmount),
    enteredTaxAmount: decimal(row.enteredTaxAmount),
    totalAmount: decimal(row.totalAmount),
    currency: row.currency,
    status: row.status,
    version: row.version,
    availableActions: invoiceActions(
      actor,
      capabilities["customer-invoice"],
      row,
    ),
  }, actor);
}

function receivableSummary(row, actor, capabilities) {
  return protectFinanceFields({
    id: row.id,
    obligationNumber: row.obligationNumber,
    customerInvoiceId: row.customerInvoiceId,
    customerInvoiceNumber: row.customerInvoice?.invoiceNumber,
    customerId: row.customerInvoice?.customerId,
    customerName: row.customerInvoice?.customerNameSnapshot,
    originalAmount: decimal(row.originalAmount),
    outstandingAmount: decimal(row.outstandingAmount),
    approvedCreditAmount: decimal(row.approvedCreditAmount),
    // What the customer paid so far: the original amount less approved
    // credits and what is still outstanding.
    paidAmount: fixed(units(row.originalAmount) - units(row.approvedCreditAmount || 0) - units(row.outstandingAmount)),
    currency: row.currency,
    dueDate: serial(row.dueDate),
    status: row.status,
    disputeStatus: row.disputeStatus,
    disputeReason: row.disputeReason,
    externalSettlementReference: row.externalSettlementReference,
    externalSettlementEnteredAt: serial(row.externalSettlementEnteredAt),
    settlementVerified: false,
    collectionExecuted: false,
    version: row.version,
    availableActions: receivableActions(
      actor,
      capabilities["receivable-obligation"],
      row,
    ),
  }, actor);
}

function creditSummary(row, actor, capabilities) {
  return protectFinanceFields({
    id: row.id,
    creditNoteNumber: row.creditNoteNumber,
    customerInvoiceId: row.customerInvoiceId,
    customerInvoiceNumber: row.customerInvoice?.invoiceNumber,
    returnPostingId: row.returnPostingId,
    returnPostingNumber: row.returnPosting?.postingNumber,
    customerId: row.customerId,
    customerName: row.customerNameSnapshot,
    subtotalAmount: decimal(row.subtotalAmount),
    enteredTaxAmount: decimal(row.enteredTaxAmount),
    totalAmount: decimal(row.totalAmount),
    currency: row.currency,
    status: row.status,
    version: row.version,
    refundExecuted: false,
    availableActions: creditActions(
      actor,
      capabilities["customer-credit-note"],
      row,
    ),
  }, actor);
}

function localDateNumber(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day));
}

export function agingDays(dueDate, asOf, timezone) {
  return Math.floor(
    (localDateNumber(asOf, timezone) - localDateNumber(dueDate, timezone)) /
      86_400_000,
  );
}

export function agingBucket(days) {
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

export function createOperationalFinanceO2cReadService({
  prisma,
  capabilities = {},
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function actor(context) {
    return resolveProvisionedActor(prisma, context?.identity || context);
  }

  async function listCustomerInvoices(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.customer_invoice.read");
    const paging = page(query);
    const search = escapeLikePattern(text(query.search));
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
      ...(validCurrency(query.currency)
        ? { currency: text(query.currency).toUpperCase() }
        : {}),
      ...(search
        ? {
            OR: [
              { invoiceNumber: { contains: search, mode: "insensitive" } },
              {
                customerNameSnapshot: {
                  contains: search,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.customerInvoice.count({ where }),
      prisma.customerInvoice.findMany({
        where,
        include: { salesOrder: true, shipment: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: paging.skip,
        take: paging.pageSize,
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      ...paging,
      total,
      items: rows.map((row) => invoiceSummary(row, current, capabilities)),
      capabilities,
    };
  }

  async function customerInvoiceDetail(id, context) {
    const current = await actor(context);
    assertRead(current, "finance.customer_invoice.read");
    const row = await prisma.customerInvoice.findFirst({
      where: { id, tenantId: current.tenantId },
      include: {
        salesOrder: true,
        shipment: true,
        lines: { orderBy: { lineNumber: "asc" } },
        receivableObligation: { include: { paymentRecords: true } },
        creditNotes: {
          include: { returnPosting: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!row)
      fail("CUSTOMER_INVOICE_NOT_FOUND", "Customer invoice was not found.", 404);
    const amountsVisible = amountsVisibleFor(current);
    const hidden = (value) => (amountsVisible ? decimal(value) : null);
    return {
      ...invoiceSummary(row, current, capabilities),
      lines: row.lines.map((line) => protectFinanceFields({
        id: line.id,
        lineNumber: line.lineNumber,
        shipmentLineId: line.shipmentLineId,
        salesOrderLineId: line.salesOrderLineId,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        quantity: decimal(line.quantity),
        unit: line.unit,
        unitPrice: decimal(line.unitPrice),
        lineAmount: decimal(line.lineAmount),
        enteredTaxAmount: decimal(line.enteredTaxAmount),
        totalAmount: decimal(line.totalAmount),
      }, current)),
      receivable: row.receivableObligation && can({ actor: current, permission: "finance.receivable.read", tenantId: current.tenantId })
        ? {
            ...receivableSummary(row.receivableObligation, current, capabilities),
            payments: paymentRecordsView(row.receivableObligation.paymentRecords, {
              amountsVisible,
              canRecord: Boolean(capabilities["receivable-obligation"]?.enabled) && can({ actor: current, permission: "finance.receivable.record_payment", tenantId: current.tenantId }),
            }),
          }
        : null,
      customerCreditNotes: (can({ actor: current, permission: "finance.customer_credit.read", tenantId: current.tenantId }) ? row.creditNotes : []).map((note) =>
        creditSummary(note, current, capabilities),
      ),
      evidence: [
        {
          type: "SalesOrder",
          id: row.salesOrderId,
          number: row.salesOrder.orderNumber,
          authoritative: true,
        },
        {
          type: "PostedShipment",
          id: row.shipmentId,
          number: row.shipment.shipmentNumber,
          postingStatus: row.shipment.postingStatus,
          authoritative: true,
        },
      ],
      reconciliation: {
        currency: row.currency,
        subtotalAmount: hidden(row.subtotalAmount),
        enteredTaxAmount: hidden(row.enteredTaxAmount),
        totalAmount: hidden(row.totalAmount),
        fxConverted: false,
      },
    };
  }

  async function listReceivables(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.receivable.read");
    const paging = page(query);
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
      ...(text(query.disputeStatus)
        ? { disputeStatus: text(query.disputeStatus) }
        : {}),
      ...(validCurrency(query.currency)
        ? { currency: text(query.currency).toUpperCase() }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.receivableObligation.count({ where }),
      prisma.receivableObligation.findMany({
        where,
        include: { customerInvoice: true },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        skip: paging.skip,
        take: paging.pageSize,
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      ...paging,
      total,
      items: rows.map((row) => receivableSummary(row, current, capabilities)),
      capabilities,
    };
  }

  async function aging(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.receivable.read");
    const amountsVisible = amountsVisibleFor(current);
    const workspace = await prisma.tenant.findUnique({
      where: { id: current.tenantId },
      select: { timezone: true },
    });
    const timezone = workspace?.timezone || "America/New_York";
    const asOf = text(query.asOf) ? new Date(text(query.asOf)) : now();
    if (Number.isNaN(asOf.getTime()))
      fail("AGING_AS_OF_INVALID", "asOf must be a valid date.", 422);
    const rows = await prisma.receivableObligation.findMany({
      where: {
        tenantId: current.tenantId,
        status: { in: ["open", "partially_settled", "overdue", "disputed"] },
        outstandingAmount: { gt: 0 },
        ...(validCurrency(query.currency)
          ? { currency: text(query.currency).toUpperCase() }
          : {}),
      },
      include: { customerInvoice: true },
      orderBy: [{ currency: "asc" }, { dueDate: "asc" }, { id: "asc" }],
    });
    const groups = new Map();
    for (const row of rows) {
      const bucket = agingBucket(agingDays(row.dueDate, asOf, timezone));
      const group =
        groups.get(row.currency) || {
          currency: row.currency,
          current: 0n,
          "1_30": 0n,
          "31_60": 0n,
          "61_90": 0n,
          "90_plus": 0n,
          total: 0n,
          count: 0,
        };
      const amount = units(row.outstandingAmount);
      group[bucket] += amount;
      group.total += amount;
      group.count += 1;
      groups.set(row.currency, group);
    }
    const currencies = [...groups.keys()].sort();
    return {
      dataSource: "Authoritative PostgreSQL",
      asOf: asOf.toISOString(),
      timezone,
      currencies,
      currencyAggregationStatus:
        currencies.length > 1
          ? "multi_currency_unconverted"
          : currencies.length === 1
            ? "single_currency"
            : "no_currency_data",
      fxConverted: false,
      groups: currencies.map((currency) => {
        const group = groups.get(currency);
        return {
          currency,
          count: group.count,
          current: amountsVisible ? fixed(group.current) : null,
          "1_30": amountsVisible ? fixed(group["1_30"]) : null,
          "31_60": amountsVisible ? fixed(group["31_60"]) : null,
          "61_90": amountsVisible ? fixed(group["61_90"]) : null,
          "90_plus": amountsVisible ? fixed(group["90_plus"]) : null,
          total: amountsVisible ? fixed(group.total) : null,
        };
      }),
      items: rows.map((row) => ({
        ...receivableSummary(row, current, capabilities),
        overdueDays: Math.max(0, agingDays(row.dueDate, asOf, timezone)),
        agingBucket: agingBucket(agingDays(row.dueDate, asOf, timezone)),
      })),
    };
  }

  async function listCustomerCreditNotes(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.customer_credit.read");
    const paging = page(query);
    const where = {
      tenantId: current.tenantId,
      ...(text(query.status) ? { status: text(query.status) } : {}),
      ...(validCurrency(query.currency)
        ? { currency: text(query.currency).toUpperCase() }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.customerCreditNote.count({ where }),
      prisma.customerCreditNote.findMany({
        where,
        include: { customerInvoice: true, returnPosting: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: paging.skip,
        take: paging.pageSize,
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      ...paging,
      total,
      items: rows.map((row) => creditSummary(row, current, capabilities)),
      capabilities,
    };
  }

  async function entryData(context) {
    const current = await actor(context);
    // Entry data serves the customer invoice and credit note forms; the endpoint is shared, so a role
    // that cannot create these documents gets empty lists, not a 403.
    if (!["finance.customer_invoice.create", "finance.customer_credit.create"].some((permission) => can({ actor: current, permission, tenantId: current.tenantId })))
      return { postedShipments: [], customerInvoices: [], customerReturnPostings: [], capabilities };
    const amountsVisible = amountsVisibleFor(current);
    const [shipments, invoices, returnPostings] = await Promise.all([
      prisma.shipmentDocument.findMany({
        where: {
          tenantId: current.tenantId,
          postingStatus: "posted",
          reversedAt: null,
        },
        include: {
          salesOrder: true,
          lines: { include: { salesOrderLine: true } },
        },
        orderBy: { postedAt: "desc" },
        take: 100,
      }),
      prisma.customerInvoice.findMany({
        where: {
          tenantId: current.tenantId,
          status: { in: ["approved", "issued", "disputed"] },
        },
        include: { lines: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.returnPostingDocument.findMany({
        where: {
          tenantId: current.tenantId,
          postingType: "customer_return_receipt",
          postingStatus: "posted",
          reversedAt: null,
        },
        include: { lines: true },
        orderBy: { postedAt: "desc" },
        take: 100,
      }),
    ]);
    return {
      postedShipments: shipments.map((row) => ({
        id: row.id,
        shipmentNumber: row.shipmentNumber,
        salesOrderId: row.salesOrderId,
        salesOrderNumber: row.salesOrder.orderNumber,
        customerId: row.salesOrder.customerId,
        customerName: row.salesOrder.customerName,
        currency: row.salesOrder.currency,
        lines: row.lines.map((line) => ({
          id: line.id,
          salesOrderLineId: line.salesOrderLineId,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          postedQuantity: decimal(line.postedQuantity),
          unit: line.unit,
          unitPrice: amountsVisible ? decimal(line.salesOrderLine.unitPrice) : null,
        })),
      })),
      customerInvoices: invoices.map((row) =>
        invoiceSummary(row, current, capabilities),
      ),
      customerReturnPostings: returnPostings.map((row) => ({
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

  async function landing(context) {
    const current = await actor(context);
    assertRead(current, "finance.overview.read");
    const asOf = now();
    const [
      supplierInvoicesAwaitingMatch,
      matchExceptions,
      approvedPayables,
      customerInvoicesAwaitingIssue,
      overdueReceivables,
      disputedReceivables,
      supplierCreditMemos,
      customerCreditNotes,
      payableCurrencies,
      receivableCurrencies,
      supplierInvoiceCurrencies,
      customerInvoiceCurrencies,
    ] = await Promise.all([
      prisma.supplierInvoice.count({
        where: { tenantId: current.tenantId, status: "submitted", relatedGrnId: { not: null } },
      }),
      prisma.financeMatchException.count({
        where: {
          tenantId: current.tenantId,
          status: { in: ["open", "reviewed"] },
        },
      }),
      prisma.payableObligation.count({
        where: {
          tenantId: current.tenantId,
          status: { in: ["approved", "export_ready", "held", "partially_settled"] },
        },
      }),
      prisma.customerInvoice.count({
        where: { tenantId: current.tenantId, status: "approved" },
      }),
      prisma.receivableObligation.count({
        where: {
          tenantId: current.tenantId,
          dueDate: { lt: asOf },
          outstandingAmount: { gt: 0 },
          status: { in: ["open", "partially_settled", "overdue"] },
        },
      }),
      prisma.receivableObligation.count({
        where: {
          tenantId: current.tenantId,
          disputeStatus: "open",
        },
      }),
      prisma.supplierCreditMemo.count({
        where: { tenantId: current.tenantId, status: { not: "cancelled" } },
      }),
      prisma.customerCreditNote.count({
        where: { tenantId: current.tenantId, status: { not: "cancelled" } },
      }),
      prisma.payableObligation.findMany({
        where: {
          tenantId: current.tenantId,
          outstandingAmount: { gt: 0 },
          status: { not: "cancelled" },
        },
        distinct: ["currency"],
        select: { currency: true },
      }),
      prisma.receivableObligation.findMany({
        where: {
          tenantId: current.tenantId,
          outstandingAmount: { gt: 0 },
          status: { not: "cancelled" },
        },
        distinct: ["currency"],
        select: { currency: true },
      }),
      prisma.supplierInvoice.findMany({
        where: { tenantId: current.tenantId, status: { notIn: CLOSED_DOCUMENT_STATUSES } },
        distinct: ["currency"],
        select: { currency: true },
      }),
      prisma.customerInvoice.findMany({
        where: { tenantId: current.tenantId, status: { notIn: CLOSED_DOCUMENT_STATUSES } },
        distinct: ["currency"],
        select: { currency: true },
      }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      generatedAt: asOf.toISOString(),
      cards: {
        supplierInvoicesAwaitingMatch,
        matchExceptions,
        approvedPayableObligations: approvedPayables,
        customerInvoicesAwaitingIssue,
        overdueReceivables,
        disputedReceivables,
        supplierCreditMemos,
        customerCreditNotes,
      },
      currencyLimitations: financeCurrencyLimitations(
        payableCurrencies,
        receivableCurrencies,
        supplierInvoiceCurrencies,
        customerInvoiceCurrencies,
      ),
      settlementClaims: {
        payableMeansPaid: false,
        receivableMeansCollected: false,
      },
      capabilities,
    };
  }

  return {
    listCustomerInvoices,
    customerInvoiceDetail,
    listReceivables,
    aging,
    listCustomerCreditNotes,
    entryData,
    landing,
  };
}
