import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { can } from "../auth/authorization-service.mjs";
import { escapeLikePattern } from "../persistence/like-pattern.mjs";
import { NEWEST_DUE_FIRST, OperationalFinanceReadError, allOf, outstandingPayableWhere, pagedInGroups, whereAll } from "./operational-finance-read-service.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";
import { paymentRecordsView } from "./payment-record-command-service.mjs";
import { CUSTOMER_NAMESPACE } from "./master-data-commands.mjs";
import { DEFAULT_TENANT_TIMEZONE, tenantCalendarDay } from "./tenant-calendar-day.mjs";
import { SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES } from "./outbound-transaction-policy.mjs";

// Cancelling a customer invoice (cancel_customer_invoice) is the preparer's
// step, as revising and cancelling a supplier invoice is
// (finance.supplier_invoice.revise): whoever may draft a customer invoice may
// withdraw one that was never issued.
export const CANCEL_CUSTOMER_INVOICE_PERMISSION = "finance.customer_invoice.create";
// A customer invoice that was never issued and holds no receivable: a draft,
// or one submitted for approval. As on the supplier side, an approved invoice
// is not cancelled, and an issued one never is: it has a receivable.
export const CANCELLABLE_CUSTOMER_INVOICE_STATUSES = Object.freeze(["draft", "submitted"]);
export const canCancelCustomerInvoice = (row) =>
  CANCELLABLE_CUSTOMER_INVOICE_STATUSES.includes(String(row?.status ?? "")) && !row?.issuedAt;

// Where an issued customer invoice stands with its payment, from its
// receivable: to be paid (nothing received yet, overdue or not), partly paid,
// or paid. The invoice list, the invoice page and Today show it in place of
// "Issued"; the stored invoice status stays "issued". An invoice that is not
// issued, or has no receivable, or whose receivable is disputed or cancelled,
// has none. Each payment state lists the receivable statuses it covers, so the
// list filter and its count agree (the supplier side's BILL_PAYMENT_STATUSES).
export const CUSTOMER_INVOICE_PAYMENT_STATUSES = Object.freeze({
  to_be_paid: Object.freeze(["open", "overdue"]),
  partially_settled: Object.freeze(["partially_settled"]),
  settled: Object.freeze(["settled"]),
});
export function customerInvoicePaymentStatus(invoiceStatus, receivableStatus) {
  if (String(invoiceStatus ?? "").trim() !== "issued" || !receivableStatus) return null;
  const status = String(receivableStatus).trim();
  return Object.keys(CUSTOMER_INVOICE_PAYMENT_STATUSES).find((state) => CUSTOMER_INVOICE_PAYMENT_STATUSES[state].includes(status)) || null;
}
// The invoices in one payment state, for the list's status filter and counts.
const invoicePaymentWhere = (state) => ({ status: "issued", receivableObligation: { is: { status: { in: [...CUSTOMER_INVOICE_PAYMENT_STATUSES[state]] } } } });

// Shipment lines already on a customer invoice: every invoice that holds its
// shipment (submitted, approved, issued, disputed: what submitting checks),
// and open drafts too, so the form does not offer the same shipped goods for a
// second draft that could never be submitted. Cancelled invoices hold nothing.
const ON_INVOICE_STATUSES = Object.freeze(["draft", ...SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES]);
// How many recent posted shipments the new invoice form looks through for
// ones with something left to invoice, and how many it offers.
const ENTRY_SHIPMENT_SCAN = 400;
const ENTRY_SHIPMENT_LIMIT = 100;

// "Net 30", "net-30" and "NET30" name the same term; so do "Due on receipt"
// and its code.
const termKey = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// A customer's payment terms are recorded as text. They count when they name
// one of the workspace's payment terms by code or name; otherwise the due
// date is left to the person.
export function customerPaymentTerm(text, terms) {
  const key = termKey(text);
  if (!key) return null;
  const term = terms.find((row) => termKey(row.code) === key) || terms.find((row) => termKey(row.name) === key);
  return term && term.days !== null && term.days !== undefined ? { code: term.code, name: term.name, days: term.days } : null;
}

const text = (value) => String(value ?? "").trim();
const decimal = (value) =>
  value === null || value === undefined ? null : String(value);
const serial = (value) =>
  value && typeof value.toISOString === "function" ? value.toISOString() : value;
const fail = (code, message, status = 400, details) => {
  throw new OperationalFinanceReadError(code, message, status, details);
};
const page = (query = {}) => {
  const number = Math.max(1, Math.floor(Number(query.page)) || 1);
  const size = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize)) || 25));
  return { page: number, pageSize: size, skip: (number - 1) * size };
};
const containsText = (value) => ({ contains: value, mode: "insensitive" });
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

// The invoice's next step, then "cancel" for one that was never issued.
function invoiceActions(actor, capability, row) {
  if (!capability?.enabled) return [];
  const allowed = (permission) => can({ actor, permission, tenantId: actor.tenantId });
  const actions = [];
  if (allowed("finance.customer_invoice.submit") && row.status === "draft") actions.push("submit");
  if (allowed("finance.customer_invoice.approve") && row.status === "submitted") actions.push("approve");
  if (allowed("finance.customer_invoice.issue") && row.status === "approved") actions.push("issue");
  if (allowed(CANCEL_CUSTOMER_INVOICE_PERMISSION) && canCancelCustomerInvoice(row)) actions.push("cancel");
  return actions;
}

function receivableActions(actor, capability, row) {
  if (!capability?.enabled) return [];
  // An external settlement reference is for money still owed; a paid
  // receivable does not offer it.
  const owed = !["settled", "cancelled", "voided"].includes(row.status) && Number(row.outstandingAmount) > 0;
  const result = owed && can({ actor, permission: "finance.receivable.record_external_reference", tenantId: actor.tenantId }) ? ["record_external_reference"] : [];
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
    // Once issued: to_be_paid, partially_settled or settled
    // (customerInvoicePaymentStatus), when the receivable's status was read.
    paymentStatus: customerInvoicePaymentStatus(row.status, row.receivableObligation?.status),
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

// A due date is a calendar day, stored at 00:00 UTC as the invoice form
// writes it, so it is read as that UTC day. Read in the workspace timezone it
// would fall a day early in the US, and an invoice due today would age by a
// day. "Today" is the workspace's calendar day.
function dueDayNumber(dueDate) {
  const day = new Date(dueDate);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

export function agingDays(dueDate, asOf, timezone) {
  return Math.floor(
    (localDateNumber(asOf, timezone) - dueDayNumber(dueDate)) / 86_400_000,
  );
}

// The first instant of the workspace's calendar day as a stored due date:
// a receivable is overdue when its due day is before it, so one due today
// is not overdue until the workspace's next day.
export function overdueBefore(asOf, timezone = DEFAULT_TENANT_TIMEZONE) {
  return new Date(`${tenantCalendarDay(asOf, timezone)}T00:00:00.000Z`);
}

export function agingBucket(days) {
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

export const AGING_BUCKETS = Object.freeze(["current", "1_30", "31_60", "61_90", "90_plus"]);
// The finance landing's "due soon" window for payables: due today or within
// this many days.
export const LANDING_DUE_SOON_DAYS = 7;

// Money still owed, by currency and aging bucket, in 1/10000 units: what the
// aging page totals and the finance landing's aging strip shows. Rows carry
// currency, dueDate and outstandingAmount (receivables or payables); currencies
// are never added together.
export function ageByCurrency(rows, asOf, timezone) {
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
        counts: Object.fromEntries(AGING_BUCKETS.map((key) => [key, 0])),
      };
    const amount = units(row.outstandingAmount);
    group[bucket] += amount;
    group.total += amount;
    group.count += 1;
    group.counts[bucket] += 1;
    groups.set(row.currency, group);
  }
  return groups;
}

// An overdue receivable is past its due date with money still owed. The stored
// status says "overdue" only after a dispute is resolved, so overdue is derived
// from the due date instead. The landing count and the receivables list's
// "overdue" filter both use this rule, so the count and the list agree.
export function overdueReceivableWhere(asOf, timezone) {
  return {
    dueDate: { lt: overdueBefore(asOf, timezone) },
    outstandingAmount: { gt: 0 },
    status: { in: ["open", "partially_settled", "overdue"] },
  };
}

// A receivable not yet paid in full, disputed or not: what aging counts. The
// "Open receivables" card and the list's "outstanding" filter both use it.
export function outstandingReceivableWhere() {
  return {
    outstandingAmount: { gt: 0 },
    status: { in: ["open", "partially_settled", "overdue", "disputed"] },
  };
}

// The receivables list's status filter: "overdue" and "outstanding" are
// derived; any other value is the stored status.
function receivableStatusWhere(status, asOf, timezone) {
  if (status === "overdue") return overdueReceivableWhere(asOf, timezone);
  if (status === "outstanding") return outstandingReceivableWhere();
  return status ? { status } : {};
}

export function createOperationalFinanceO2cReadService({
  prisma,
  capabilities = {},
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");
  const workspaceTimezone = async (tenantId) =>
    (
      await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      })
    )?.timezone || DEFAULT_TENANT_TIMEZONE;

  async function actor(context) {
    return resolveProvisionedActor(prisma, context?.identity || context);
  }

  async function listCustomerInvoices(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.customer_invoice.read");
    const paging = page(query);
    const search = escapeLikePattern(text(query.search));
    // to_be_paid, partially_settled and settled are payment states of issued
    // invoices (customerInvoicePaymentStatus); any other status is the stored one.
    const status = text(query.status);
    const where = {
      tenantId: current.tenantId,
      ...(CUSTOMER_INVOICE_PAYMENT_STATUSES[status] ? invoicePaymentWhere(status) : status ? { status } : {}),
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
    // The metric cards count every invoice in the workspace, not one page.
    // Past due is an issued invoice whose receivable is overdue (the rule the
    // receivables list's overdue filter uses), so a paid invoice is not.
    const timezone = await workspaceTimezone(current.tenantId);
    const count = (extra) => prisma.customerInvoice.count({ where: { tenantId: current.tenantId, ...extra } });
    const [total, rows, toApprove, toIssue, issued, pastDue, toBePaid, partlyPaid, paid, currencies] = await Promise.all([
      prisma.customerInvoice.count({ where }),
      prisma.customerInvoice.findMany({
        where,
        // The receivable's status alone, for the payment state.
        include: { salesOrder: true, shipment: true, receivableObligation: { select: { status: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: paging.skip,
        take: paging.pageSize,
      }),
      count({ status: { in: ["draft", "submitted"] } }),
      count({ status: "approved" }),
      count({ status: "issued" }),
      count({ status: "issued", receivableObligation: { is: overdueReceivableWhere(now(), timezone) } }),
      count(invoicePaymentWhere("to_be_paid")),
      count(invoicePaymentWhere("partially_settled")),
      count(invoicePaymentWhere("settled")),
      // Every currency, for the currency filter: one page shows only some.
      prisma.customerInvoice.findMany({ where: { tenantId: current.tenantId }, distinct: ["currency"], select: { currency: true } }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      ...paging,
      total,
      // issued counts every issued invoice; to_be_paid, partially_settled and
      // settled split those with a receivable by where its payment stands.
      counts: { toApprove, toIssue, issued, pastDue, to_be_paid: toBePaid, partially_settled: partlyPaid, settled: paid },
      currencies: currencies.map((row) => row.currency).filter(validCurrency).sort(),
      timezone,
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
      // When each step happened, for the invoice's history; a cancelled
      // invoice keeps its reason.
      history: {
        createdAt: serial(row.createdAt),
        submittedAt: serial(row.submittedAt) ?? null,
        approvedAt: serial(row.approvedAt) ?? null,
        issuedAt: serial(row.issuedAt) ?? null,
        cancelledAt: serial(row.cancelledAt) ?? null,
        cancellationReason: row.cancellationReason ?? null,
      },
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
    const asOf = now();
    const timezone = await workspaceTimezone(current.tenantId);
    const search = escapeLikePattern(text(query.search));
    const partnerVisible = can({ actor: current, permission: "finance.partner_snapshot.read", tenantId: current.tenantId });
    const where = {
      tenantId: current.tenantId,
      ...whereAll(
        receivableStatusWhere(text(query.status), asOf, timezone),
        text(query.disputeStatus) ? { disputeStatus: text(query.disputeStatus) } : {},
        validCurrency(query.currency) ? { currency: text(query.currency).toUpperCase() } : {},
        // The invoice or receivable number, or the customer: the customer's
        // name only for a role that may see it.
        search
          ? {
              OR: [
                { obligationNumber: containsText(search) },
                { customerInvoice: { is: { invoiceNumber: containsText(search) } } },
                ...(partnerVisible ? [{ customerInvoice: { is: { customerNameSnapshot: containsText(search) } } }] : []),
              ],
            }
          : {},
      ),
    };
    // sort=attention (the receivables page): overdue first, then the rest
    // still owed, then paid; each newest first. Without it the list keeps
    // the soonest due first, as the assistant's receivables tool reads it.
    const listed = text(query.sort) === "attention"
      ? pagedInGroups(prisma.receivableObligation, {
          where,
          groups: [
            overdueReceivableWhere(asOf, timezone),
            { AND: [outstandingReceivableWhere(), { NOT: allOf(overdueReceivableWhere(asOf, timezone)) }] },
            { NOT: allOf(outstandingReceivableWhere()) },
          ],
          orderBy: NEWEST_DUE_FIRST,
          include: { customerInvoice: true },
          skip: paging.skip,
          take: paging.pageSize,
        })
      : Promise.all([
          prisma.receivableObligation.count({ where }),
          prisma.receivableObligation.findMany({
            where,
            include: { customerInvoice: true },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
            skip: paging.skip,
            take: paging.pageSize,
          }),
        ]).then(([total, rows]) => ({ total, rows }));
    // The metric cards count every receivable in the workspace, not one page.
    const count = (extra) => prisma.receivableObligation.count({ where: { tenantId: current.tenantId, ...extra } });
    const [{ total, rows }, outstanding, overdue, disputed, settled, currencies] = await Promise.all([
      listed,
      count(outstandingReceivableWhere()),
      count(overdueReceivableWhere(asOf, timezone)),
      count({ disputeStatus: "open" }),
      count({ status: "settled" }),
      prisma.receivableObligation.findMany({ where: { tenantId: current.tenantId }, distinct: ["currency"], select: { currency: true } }),
    ]);
    return {
      dataSource: "Authoritative PostgreSQL",
      ...paging,
      total,
      counts: { outstanding, overdue, disputed, settled },
      currencies: currencies.map((row) => row.currency).filter(validCurrency).sort(),
      timezone,
      items: rows.map((row) => receivableSummary(row, current, capabilities)),
      capabilities,
    };
  }

  async function aging(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.receivable.read");
    const amountsVisible = amountsVisibleFor(current);
    const timezone = await workspaceTimezone(current.tenantId);
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
    const groups = ageByCurrency(rows, asOf, timezone);
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
    const search = escapeLikePattern(text(query.search));
    const partnerVisible = can({ actor: current, permission: "finance.partner_snapshot.read", tenantId: current.tenantId });
    const where = {
      tenantId: current.tenantId,
      ...whereAll(
        text(query.status) ? { status: text(query.status) } : {},
        validCurrency(query.currency) ? { currency: text(query.currency).toUpperCase() } : {},
        search
          ? {
              OR: [
                { creditNoteNumber: containsText(search) },
                { customerInvoice: { is: { invoiceNumber: containsText(search) } } },
                { returnPosting: { is: { postingNumber: containsText(search) } } },
                ...(partnerVisible ? [{ customerNameSnapshot: containsText(search) }] : []),
              ],
            }
          : {},
      ),
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

  // The new customer invoice form's data. Opened from a sales order
  // (query.salesOrder) or a shipment (query.shipment), it reads that order's
  // or that shipment's posted shipments, each with what is left to invoice,
  // and names the order or shipment so the form can say why none is offered.
  // Opened on its own, it offers the most recent posted shipments that still
  // have something left to invoice.
  async function entryData(context, query = {}) {
    const current = await actor(context);
    // Entry data serves the customer invoice and credit note forms; the endpoint is shared, so a role
    // that cannot create these documents gets empty lists, not a 403.
    if (!["finance.customer_invoice.create", "finance.customer_credit.create"].some((permission) => can({ actor: current, permission, tenantId: current.tenantId })))
      return { postedShipments: [], customerInvoices: [], customerReturnPostings: [], capabilities };
    const amountsVisible = amountsVisibleFor(current);
    const salesOrderFilter = text(query.salesOrder);
    const shipmentFilter = text(query.shipment);
    const focused = Boolean(salesOrderFilter || shipmentFilter);
    // No invoice number is suggested: the server assigns it when the draft is
    // created (CI-YYYYMM-NNNN).
    const [tenant, customerRecords, paymentTerms] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: current.tenantId }, select: { timezone: true } }),
      prisma.runtimeRecord.findMany({ where: { tenantId: current.tenantId, namespace: CUSTOMER_NAMESPACE }, select: { payload: true }, take: 2000 }),
      prisma.paymentTerm.findMany({ where: { tenantId: current.tenantId }, select: { code: true, name: true, days: true } }),
    ]);
    const customerTerms = new Map(customerRecords.map((record) => [String(record.payload?.id ?? ""), customerPaymentTerm(record.payload?.paymentTerms, paymentTerms)]));
    // The terms as recorded on the customer, so the form can say that they
    // name no payment term of the workspace instead of leaving the due date
    // blank without a word.
    const customerTermsText = new Map(customerRecords.map((record) => [String(record.payload?.id ?? ""), text(record.payload?.paymentTerms) || null]));
    const [shipments, invoices, returnPostings, sourceOrder, sourceShipment] = await Promise.all([
      prisma.shipmentDocument.findMany({
        where: {
          tenantId: current.tenantId,
          postingStatus: "posted",
          reversedAt: null,
          ...(shipmentFilter
            ? { OR: [{ id: shipmentFilter }, { shipmentNumber: shipmentFilter }] }
            : salesOrderFilter
              ? { salesOrderId: salesOrderFilter }
              : {}),
        },
        include: {
          salesOrder: true,
          lines: { include: { salesOrderLine: true } },
        },
        orderBy: { postedAt: "desc" },
        take: focused ? ENTRY_SHIPMENT_LIMIT : ENTRY_SHIPMENT_SCAN,
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
      salesOrderFilter
        ? prisma.salesOrder.findFirst({ where: { id: salesOrderFilter, tenantId: current.tenantId }, select: { id: true, orderNumber: true } })
        : null,
      shipmentFilter
        ? prisma.shipmentDocument.findFirst({ where: { tenantId: current.tenantId, OR: [{ id: shipmentFilter }, { shipmentNumber: shipmentFilter }] }, select: { id: true, shipmentNumber: true, salesOrderId: true } })
        : null,
    ]);
    // What each shipment line is already invoiced for, and on which invoices.
    const lineIds = shipments.flatMap((row) => row.lines.map((line) => line.id));
    const onInvoices = lineIds.length
      ? await prisma.customerInvoiceLine.findMany({
          where: {
            shipmentLineId: { in: lineIds },
            customerInvoice: { tenantId: current.tenantId, status: { in: [...ON_INVOICE_STATUSES] } },
          },
          select: { shipmentLineId: true, quantity: true, customerInvoice: { select: { id: true, invoiceNumber: true, status: true } } },
        })
      : [];
    const invoicedByLine = new Map();
    const invoicesByLine = new Map();
    for (const row of onInvoices) {
      invoicedByLine.set(row.shipmentLineId, (invoicedByLine.get(row.shipmentLineId) || 0n) + units(row.quantity));
      const listed = invoicesByLine.get(row.shipmentLineId) || [];
      const invoice = row.customerInvoice;
      if (invoice && !listed.some((entry) => entry.id === invoice.id)) listed.push({ id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status });
      invoicesByLine.set(row.shipmentLineId, listed);
    }
    const shipmentView = (row) => {
      const lines = row.lines.map((line) => {
        const posted = units(line.postedQuantity);
        const invoiced = invoicedByLine.get(line.id) || 0n;
        const left = posted > invoiced ? posted - invoiced : 0n;
        return {
          id: line.id,
          salesOrderLineId: line.salesOrderLineId,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          postedQuantity: decimal(line.postedQuantity),
          // On a draft or on an invoice that holds the shipment.
          invoicedQuantity: fixed(invoiced),
          remainingQuantity: fixed(left),
          unit: line.unit,
          unitPrice: amountsVisible ? decimal(line.salesOrderLine.unitPrice) : null,
        };
      });
      const invoicesOn = [];
      for (const line of row.lines)
        for (const invoice of invoicesByLine.get(line.id) || [])
          if (!invoicesOn.some((entry) => entry.id === invoice.id)) invoicesOn.push(invoice);
      return {
        id: row.id,
        shipmentNumber: row.shipmentNumber,
        salesOrderId: row.salesOrderId,
        salesOrderNumber: row.salesOrder.orderNumber,
        customerId: row.salesOrder.customerId,
        customerName: row.salesOrder.customerName,
        customerPaymentTerm: customerTerms.get(String(row.salesOrder.customerId ?? "")) || null,
        customerPaymentTerms: customerTermsText.get(String(row.salesOrder.customerId ?? "")) || null,
        currency: row.salesOrder.currency,
        // Something is left to invoice on at least one line.
        invoiceable: lines.some((line) => units(line.remainingQuantity) > 0n),
        invoices: invoicesOn,
        lines,
      };
    };
    const shipmentViews = shipments.map(shipmentView);
    return {
      // Opened from an order or a shipment: all of its posted shipments, each
      // saying what is left. Otherwise only those with something left.
      postedShipments: focused
        ? shipmentViews
        : shipmentViews.filter((row) => row.invoiceable).slice(0, ENTRY_SHIPMENT_LIMIT),
      // The order or shipment the form was opened from (the endpoint is shared
      // with the supplier side, hence the long name).
      customerInvoiceSource: {
        salesOrder: sourceOrder ? { id: sourceOrder.id, orderNumber: sourceOrder.orderNumber } : null,
        shipment: sourceShipment ? { id: sourceShipment.id, shipmentNumber: sourceShipment.shipmentNumber, salesOrderId: sourceShipment.salesOrderId } : null,
      },
      customerInvoices: invoices.map((row) =>
        invoiceSummary(row, current, capabilities),
      ),
      // The invoice date is the workspace's calendar day, not the browser's.
      today: tenantCalendarDay(now(), tenant?.timezone || "America/New_York"),
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
    const timezone = await workspaceTimezone(current.tenantId);
    // The money on the landing follows the lists it totals: payables need
    // finance.payable.read and receivables finance.receivable.read, as their
    // lists and the aging page do, and every amount needs finance.amounts.read
    // as well. A reader without them keeps the counts below; the amounts are
    // null, never 0.
    const allowed = (permission) => can({ actor: current, permission, tenantId: current.tenantId });
    const amountsVisible = amountsVisibleFor(current);
    const payablesReadable = allowed("finance.payable.read");
    const receivablesReadable = allowed("finance.receivable.read");
    const noRows = Promise.resolve([]);
    const owedFields = { currency: true, dueDate: true, outstandingAmount: true };
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
      openReceivables,
      openPayableRows,
      openReceivableRows,
      overdueReceivableRows,
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
      // The payables list's "outstanding" filter, which this card opens.
      prisma.payableObligation.count({
        where: { tenantId: current.tenantId, ...outstandingPayableWhere() },
      }),
      prisma.customerInvoice.count({
        where: { tenantId: current.tenantId, status: "approved" },
      }),
      prisma.receivableObligation.count({
        where: { tenantId: current.tenantId, ...overdueReceivableWhere(asOf, timezone) },
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
      // The receivables list's "outstanding" filter, which "Owed to us" opens.
      prisma.receivableObligation.count({
        where: { tenantId: current.tenantId, ...outstandingReceivableWhere() },
      }),
      // What the amounts and aging strips total: the same rules as the counts
      // and the lists the cards open.
      payablesReadable
        ? prisma.payableObligation.findMany({ where: { tenantId: current.tenantId, ...outstandingPayableWhere() }, select: owedFields })
        : noRows,
      receivablesReadable
        ? prisma.receivableObligation.findMany({ where: { tenantId: current.tenantId, ...outstandingReceivableWhere() }, select: owedFields })
        : noRows,
      receivablesReadable
        ? prisma.receivableObligation.findMany({ where: { tenantId: current.tenantId, ...overdueReceivableWhere(asOf, timezone) }, select: owedFields })
        : noRows,
    ]);
    const payableAging = ageByCurrency(openPayableRows, asOf, timezone);
    const receivableAging = ageByCurrency(openReceivableRows, asOf, timezone);
    const overdueByCurrency = ageByCurrency(overdueReceivableRows, asOf, timezone);
    // Payables falling due from today through the next DUE_SOON_DAYS days,
    // counted in the aging page's days (agingDays: negative before the due day).
    const dueSoon = ageByCurrency(
      openPayableRows.filter((row) => {
        const days = agingDays(row.dueDate, asOf, timezone);
        return days <= 0 && days >= -LANDING_DUE_SOON_DAYS;
      }),
      asOf,
      timezone,
    );
    const shown = (value, visible) => (visible ? fixed(value) : null);
    const currencies = (groups) => [...groups.keys()].sort();
    const totals = (groups, readable) => ({
      readable,
      amountsVisible: readable && amountsVisible,
      byCurrency: currencies(groups).map((currency) => ({
        currency,
        count: groups.get(currency).count,
        amount: shown(groups.get(currency).total, readable && amountsVisible),
      })),
    });
    const agingView = (groups, readable) => ({
      readable,
      amountsVisible: readable && amountsVisible,
      groups: currencies(groups).map((currency) => {
        const group = groups.get(currency);
        return {
          currency,
          count: group.count,
          amount: shown(group.total, readable && amountsVisible),
          buckets: AGING_BUCKETS.map((bucket) => ({
            bucket,
            count: group.counts[bucket],
            amount: shown(group[bucket], readable && amountsVisible),
          })),
        };
      }),
    });
    const payableTotals = totals(payableAging, payablesReadable);
    return {
      dataSource: "Authoritative PostgreSQL",
      generatedAt: asOf.toISOString(),
      timezone,
      cards: {
        supplierInvoicesAwaitingMatch,
        matchExceptions,
        approvedPayableObligations: approvedPayables,
        customerInvoicesAwaitingIssue,
        openReceivables,
        overdueReceivables,
        disputedReceivables,
        supplierCreditMemos,
        customerCreditNotes,
      },
      // Amounts per currency, never added across currencies.
      money: {
        dueSoonDays: LANDING_DUE_SOON_DAYS,
        payables: {
          ...payableTotals,
          byCurrency: payableTotals.byCurrency.map((row) => ({
            ...row,
            dueSoonCount: dueSoon.get(row.currency)?.count || 0,
            dueSoonAmount: shown(dueSoon.get(row.currency)?.total || 0n, payableTotals.amountsVisible),
          })),
        },
        receivables: totals(receivableAging, receivablesReadable),
        overdueReceivables: totals(overdueByCurrency, receivablesReadable),
      },
      aging: {
        asOf: asOf.toISOString(),
        receivables: agingView(receivableAging, receivablesReadable),
        payables: agingView(payableAging, payablesReadable),
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
