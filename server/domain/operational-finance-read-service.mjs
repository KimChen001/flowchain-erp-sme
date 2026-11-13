import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { procurementDocumentNumber } from "../../shared/document-numbering.mjs";
import { can } from "../auth/authorization-service.mjs";
import { paymentRecordsView } from "./payment-record-command-service.mjs";
import { awaitingReceipt, financeFixed, financeUnits } from "./operational-finance-policy.mjs";
import { RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES } from "./procurement-status-authority.mjs";
import { escapeLikePattern } from "../persistence/like-pattern.mjs";
import { invoiceDayKey, isDuplicateReviewClosed, loadDuplicateChecks, workspaceTimezone } from "./supplier-invoice-duplicates.mjs";
import { DEFAULT_TENANT_TIMEZONE, tenantCalendarDay } from "./tenant-calendar-day.mjs";

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
// A payable still owed: approved and not paid in full, held or not. The
// landing's "to pay" count and the payables list's "outstanding" filter
// both use this rule, so the count and the list it opens agree.
const PAYABLE_OPEN_STATUSES = ["approved", "export_ready", "held", "partially_settled"];

// Where an approved supplier invoice stands with its payment, from its
// payable: to pay (nothing paid yet, held or not), partly paid, or paid. The
// supplier invoice list and Today show it in place of "Approved"; the stored
// invoice status stays "approved". An invoice that is not approved, or has
// no payable (a seeded or imported one), or whose payable was cancelled has
// none. Each payment state lists the payable statuses it covers, so the list
// filter and its card count the same invoices.
export const BILL_PAYMENT_STATUSES = Object.freeze({
  to_pay: Object.freeze(["approved", "export_ready", "held"]),
  partially_settled: Object.freeze(["partially_settled"]),
  settled: Object.freeze(["settled"]),
});
export function billPaymentStatus(invoiceStatus, payableStatus) {
  if (text(invoiceStatus) !== "approved" || !payableStatus) return null;
  return Object.keys(BILL_PAYMENT_STATUSES).find((state) => BILL_PAYMENT_STATUSES[state].includes(text(payableStatus))) || null;
}
// The invoices in one payment state, for the list's status filter and cards.
const billPaymentWhere = (state) => ({ status: "approved", payableObligation: { is: { status: { in: [...BILL_PAYMENT_STATUSES[state]] } } } });

export function outstandingPayableWhere() {
  return { status: { in: PAYABLE_OPEN_STATUSES }, outstandingAmount: { gt: 0 } };
}

// A due date is a calendar day stored at 00:00 UTC; a payable is overdue
// once the workspace's own calendar day is past it (see overdueBefore in the
// customer side's read service).
export function overduePayableWhere(asOf, timezone = DEFAULT_TENANT_TIMEZONE) {
  return {
    ...outstandingPayableWhere(),
    dueDate: { lt: new Date(`${tenantCalendarDay(asOf, timezone)}T00:00:00.000Z`) },
  };
}

function pageQuery(query = {}) {
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize)) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

// A where clause as one condition per field, so it can be negated as a whole:
// NOT { AND: [...] } is "not all of these".
export const allOf = (where) => ({ AND: Object.entries(where).map(([key, value]) => ({ [key]: value })) });
// The non-empty conditions, to AND together.
export const financeConditions = (...wheres) => wheres.filter((where) => where && Object.keys(where).length);
const conditions = financeConditions;
// Every given condition: { AND: [...] }, or nothing when none is set.
export const whereAll = (...wheres) => {
  const list = conditions(...wheres);
  return list.length ? { AND: list } : {};
};

// A finance list in the order that needs attention first: the rows of
// `groups` (disjoint, together every row of `where`) one group after the
// other, each in `orderBy`, paged across the groups. Overdue and open rows
// come before paid ones however many there are.
export async function pagedInGroups(model, { where, groups, orderBy, include, skip, take }) {
  const scoped = groups.map((group) => ({ AND: conditions(where, group) }));
  const counts = await Promise.all(scoped.map((groupWhere) => model.count({ where: groupWhere })));
  const rows = [];
  let offset = skip;
  for (let index = 0; index < scoped.length && rows.length < take; index += 1) {
    if (offset >= counts[index]) {
      offset -= counts[index];
      continue;
    }
    rows.push(...(await model.findMany({ where: scoped[index], ...(include ? { include } : {}), orderBy, skip: offset, take: take - rows.length })));
    offset = 0;
  }
  return { total: counts.reduce((sum, count) => sum + count, 0), rows };
}

// Newest first, with the id as the last tie-break so pages never overlap.
export const NEWEST_DUE_FIRST = [{ dueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }];

const workspaceZone = async (prisma, tenantId) =>
  (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }))?.timezone || DEFAULT_TENANT_TIMEZONE;

// A search box's text as a contains filter; LIKE wildcards are matched as typed.
const containsText = (value) => ({ contains: value, mode: "insensitive" });

function actions(actor, capability, row, type) {
  if (!capability?.enabled) return [];
  if (type === "invoice") {
    const values = [];
    const waiting = awaitingReceipt(row);
    if (can({ actor, permission: "finance.supplier_invoice.revise", tenantId: actor.tenantId }) && row.status === "draft")
      values.push("revise", "submit");
    // A bill recorded before the goods arrived is linked to its receipt
    // before it can be matched.
    if (can({ actor, permission: "finance.supplier_invoice.revise", tenantId: actor.tenantId }) && waiting)
      values.push("link_receipt");
    if (can({ actor, permission: "finance.three_way_match.execute", tenantId: actor.tenantId }) && row.status === "submitted" && !waiting)
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
    // Once approved: to_pay, partially_settled or settled (billPaymentStatus).
    paymentStatus: billPaymentStatus(row.status, row.payableObligation?.status),
    matchStatus: row.matchStatus,
    varianceAmount: decimal(row.varianceAmount),
    awaitingReceipt: awaitingReceipt(row),
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
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function actor(context) {
    return resolveProvisionedActor(prisma, context?.identity || context);
  }

  async function listSupplierInvoices(query, context) {
    const current = await actor(context);
    assertRead(current, "finance.supplier_invoice.read");
    const { page, pageSize, skip } = pageQuery(query);
    const search = escapeLikePattern(text(query.search));
    const partnerVisible = can({ actor: current, permission: "finance.partner_snapshot.read", tenantId: current.tenantId });
    // A variance is a non-zero variance amount or the match status "variance";
    // a missing amount or status is no variance. Nulls are named on both
    // sides, so neither filter loses a row to SQL's unknown.
    const withVariance = { OR: [{ AND: [{ varianceAmount: { not: null } }, { varianceAmount: { not: 0 } }] }, { matchStatus: "variance" }] };
    const noVariance = { AND: [{ OR: [{ varianceAmount: null }, { varianceAmount: 0 }] }, { OR: [{ matchStatus: null }, { matchStatus: { not: "variance" } }] }] };
    const variance = text(query.variance);
    // to_pay, partially_settled and settled are payment states of approved
    // invoices (billPaymentStatus); any other status is the stored one.
    const status = text(query.status);
    const where = {
      tenantId: current.tenantId,
      ...whereAll(
        BILL_PAYMENT_STATUSES[status] ? billPaymentWhere(status) : status ? { status } : {},
        text(query.currency) ? { currency: text(query.currency).toUpperCase() } : {},
        // The supplier filter names a supplier the list showed, so only a
        // role that sees supplier names filters by one.
        partnerVisible && text(query.supplier) ? { supplierName: text(query.supplier) } : {},
        variance === "with" ? withVariance : variance === "none" ? noVariance : {},
        search
          ? {
              OR: [
                { invoiceNumber: containsText(search) },
                { supplierName: containsText(search) },
                { relatedPoId: containsText(search) },
              ],
            }
          : {},
      ),
    };
    // The metric cards count every invoice in the workspace, not one page.
    const countWhere = (extra) => prisma.supplierInvoice.count({ where: { tenantId: current.tenantId, ...extra } });
    const countStatus = (status) => countWhere({ status });
    const [total, rows, submitted, exception, matched, approved, toPay, partlyPaid, paid, supplierNames] = await Promise.all([
      prisma.supplierInvoice.count({ where }),
      prisma.supplierInvoice.findMany({
        where,
        // The payable's status alone, for the payment state.
        include: { payableObligation: { select: { status: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: pageSize,
      }),
      countStatus("submitted"),
      countStatus("exception"),
      countStatus("matched"),
      countStatus("approved"),
      countWhere(billPaymentWhere("to_pay")),
      countWhere(billPaymentWhere("partially_settled")),
      countWhere(billPaymentWhere("settled")),
      partnerVisible
        ? prisma.supplierInvoice.findMany({ where: { tenantId: current.tenantId, supplierName: { not: null } }, distinct: ["supplierName"], select: { supplierName: true }, orderBy: { supplierName: "asc" }, take: 500 })
        : [],
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
      // approved counts every approved invoice; to_pay, partially_settled and
      // settled split those with a payable by where its payment stands.
      counts: { submitted, exception, matched, approved, to_pay: toPay, partially_settled: partlyPaid, settled: paid },
      suppliers: supplierNames.map((row) => row.supplierName).filter(Boolean),
      capabilities,
    };
  }

  // The duplicate flags of one bill (plan item C1): each with the other
  // bill's number, date, amount, status and version; open, dismissed, or
  // closed once this bill is past approval (approved, held or cancelled); the dismissal given on
  // this bill and the one given on the other bill, when their basis still
  // holds; and every dismissal on record, stale ones marked. A same-amount flag would reveal
  // that two totals are equal, so without finance.amounts.read those flags
  // and their dismissals are left out and possibleHidden says so.
  async function duplicateChecksView(invoice, current) {
    const amountsVisible = can({ actor: current, permission: "finance.amounts.read", tenantId: current.tenantId });
    const timezone = await workspaceTimezone(prisma, current.tenantId);
    const checks = await loadDuplicateChecks(prisma, { tenantId: current.tenantId, invoice, timezone });
    const visible = (entry) => amountsVisible || entry.kind !== "possible";
    const flags = checks.flags.filter(visible);
    const reviews = checks.reviews.filter(visible);
    const otherIds = [...new Set([...flags, ...reviews].map((entry) => entry.otherInvoiceId))];
    const otherSide = flags.map((flag) => flag.otherSideDismissal).filter(Boolean);
    const userIds = [...new Set([...reviews, ...otherSide].map((entry) => entry.dismissedById))];
    const [others, users] = await Promise.all([
      otherIds.length
        ? prisma.supplierInvoice.findMany({
            where: { tenantId: current.tenantId, id: { in: otherIds } },
            select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, amount: true, currency: true, status: true, version: true },
          })
        : [],
      userIds.length
        ? prisma.user.findMany({ where: { tenantId: current.tenantId, id: { in: userIds } }, select: { id: true, name: true, email: true } })
        : [],
    ]);
    const otherById = new Map(others.map((row) => [row.id, row]));
    const userById = new Map(users.map((row) => [row.id, row]));
    const other = (id) => {
      const row = otherById.get(id);
      return row
        ? protectFinanceFields({
            id: row.id,
            invoiceNumber: row.invoiceNumber || row.id,
            invoiceDate: invoiceDayKey(row.invoiceDate, timezone),
            totalAmount: decimal(row.totalAmount ?? row.amount),
            currency: row.currency,
            status: row.status,
            version: row.version,
          }, current)
        : null;
    };
    const review = (entry) => ({
      id: entry.id,
      otherInvoiceId: entry.otherInvoiceId,
      otherInvoice: other(entry.otherInvoiceId),
      kind: entry.kind,
      reason: entry.reason,
      dismissedById: entry.dismissedById,
      dismissedByName: text(userById.get(entry.dismissedById)?.name) || text(userById.get(entry.dismissedById)?.email) || entry.dismissedById,
      dismissedAt: serial(entry.dismissedAt),
      stale: Boolean(entry.stale),
    });
    return {
      windowDays: checks.windowDays,
      notChecked: checks.notChecked,
      possibleHidden: !amountsVisible,
      openCount: flags.filter((flag) => flag.status === "open").length,
      flags: flags.map((flag) => ({
        kind: flag.kind,
        otherInvoiceId: flag.otherInvoiceId,
        otherInvoice: other(flag.otherInvoiceId),
        daysApart: flag.daysApart,
        windowDays: flag.windowDays,
        status: flag.status,
        dismissal: flag.dismissal ? review(flag.dismissal) : null,
        otherSideDismissal: flag.otherSideDismissal ? review(flag.otherSideDismissal) : null,
      })),
      reviews: reviews.map(review),
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
    const duplicateChecks = await duplicateChecksView(invoice, current);
    // An approver dismisses an open flag with a reason before approval; an
    // approved, held or cancelled bill is past that step.
    if (
      capabilities["supplier-invoice"]?.enabled &&
      can({ actor: current, permission: "finance.supplier_invoice.approve", tenantId: current.tenantId }) &&
      !isDuplicateReviewClosed(invoice.status) &&
      duplicateChecks.openCount > 0
    )
      summary.availableActions = [...summary.availableActions, "dismiss_duplicate"];
    // Posted receipts of the purchase order that a waiting bill can be linked
    // to, newest first.
    const receiptCandidates = summary.availableActions.includes("link_receipt")
      ? await prisma.receivingDocument.findMany({
          where: { tenantId: current.tenantId, poId: invoice.relatedPoId, postingStatus: "posted", reversedAt: null },
          select: { id: true, documentNumber: true, postedAt: true },
          orderBy: { postedAt: "desc" },
          take: 20,
        })
      : [];
    // The receipt by its GRN number, as the rest of the app names it.
    const receipt = invoice.relatedGrnId
      ? await prisma.receivingDocument.findFirst({
          where: { tenantId: current.tenantId, id: invoice.relatedGrnId },
          select: { documentNumber: true },
        })
      : null;
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
      relatedGrnNumber: receipt?.documentNumber || null,
      receiptCandidates: receiptCandidates.map((row) => ({ id: row.id, documentNumber: row.documentNumber, postedAt: serial(row.postedAt) })),
      duplicateChecks,
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
    const search = escapeLikePattern(text(query.search));
    const partnerVisible = can({ actor: current, permission: "finance.partner_snapshot.read", tenantId: current.tenantId });
    const where = {
      tenantId: current.tenantId,
      ...whereAll(
        text(query.status) ? { status: text(query.status) } : {},
        search
          ? {
              OR: [
                { supplierInvoice: { is: { invoiceNumber: containsText(search) } } },
                { match: { is: { matchNumber: containsText(search) } } },
                ...(partnerVisible ? [{ supplierInvoice: { is: { supplierName: containsText(search) } } }] : []),
              ],
            }
          : {},
      ),
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
    const status = text(query.status);
    const asOf = now();
    const timezone = await workspaceZone(prisma, current.tenantId);
    const search = escapeLikePattern(text(query.search));
    const partnerVisible = can({ actor: current, permission: "finance.partner_snapshot.read", tenantId: current.tenantId });
    // "outstanding" and "overdue" are derived (see outstandingPayableWhere);
    // any other status is the stored one.
    const statusWhere = status === "overdue"
      ? overduePayableWhere(asOf, timezone)
      : status === "outstanding"
        ? outstandingPayableWhere()
        : status ? { status } : {};
    const where = {
      tenantId: current.tenantId,
      ...whereAll(
        statusWhere,
        text(query.currency) ? { currency: text(query.currency).toUpperCase() } : {},
        // The supplier's name is searched only by a role that may see it.
        search
          ? {
              OR: [
                { obligationNumber: containsText(search) },
                { supplierInvoice: { is: { invoiceNumber: containsText(search) } } },
                ...(partnerVisible ? [{ supplierInvoice: { is: { supplierName: containsText(search) } } }] : []),
              ],
            }
          : {},
      ),
    };
    // sort=attention (the payables page): overdue first, then the rest still
    // owed, then paid or cancelled; each newest first. Without it the list
    // keeps the soonest due first.
    const listed = text(query.sort) === "attention"
      ? pagedInGroups(prisma.payableObligation, {
          where,
          groups: [overduePayableWhere(asOf, timezone), { AND: [outstandingPayableWhere(), { NOT: allOf(overduePayableWhere(asOf, timezone)) }] }, { NOT: allOf(outstandingPayableWhere()) }],
          orderBy: NEWEST_DUE_FIRST,
          include: { supplierInvoice: true },
          skip,
          take: pageSize,
        })
      : Promise.all([
          prisma.payableObligation.count({ where }),
          prisma.payableObligation.findMany({
            where,
            include: { supplierInvoice: true },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
            skip,
            take: pageSize,
          }),
        ]).then(([total, rows]) => ({ total, rows }));
    // The metric cards count every payable in the workspace, not one page.
    const count = (extra) => prisma.payableObligation.count({ where: { tenantId: current.tenantId, ...extra } });
    const [{ total, rows }, outstanding, overdue, held, settled] = await Promise.all([
      listed,
      count(outstandingPayableWhere()),
      count(overduePayableWhere(asOf, timezone)),
      count({ status: "held" }),
      count({ status: "settled" }),
    ]);
    return {
      items: rows.map((row) => payableSummary(row, current, capabilities)),
      page,
      pageSize,
      total,
      counts: { outstanding, overdue, held, settled },
      timezone,
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
    const search = escapeLikePattern(text(query.search));
    const partnerVisible = can({ actor: current, permission: "finance.partner_snapshot.read", tenantId: current.tenantId });
    const where = {
      tenantId: current.tenantId,
      ...whereAll(
        text(query.status) ? { status: text(query.status) } : {},
        search
          ? {
              OR: [
                { creditMemoNumber: containsText(search) },
                { supplierInvoice: { is: { invoiceNumber: containsText(search) } } },
                { returnPosting: { is: { postingNumber: containsText(search) } } },
                ...(partnerVisible ? [{ supplierNameSnapshot: containsText(search) }] : []),
              ],
            }
          : {},
      ),
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

  // A supplier's recorded payment term, so a new bill's due date can start
  // from the invoice date plus the term's days. Only the term goes out, not
  // the rest of the supplier's metadata.
  async function withPaymentTerms(suppliers, tenantId) {
    const termIds = [...new Set(suppliers.map((row) => row.metadata?.paymentTermsId).filter(Boolean))];
    const terms = termIds.length
      ? await prisma.paymentTerm.findMany({ where: { tenantId, id: { in: termIds } }, select: { id: true, code: true, name: true, days: true } })
      : [];
    const byId = new Map(terms.map((term) => [term.id, term]));
    return suppliers.map(({ metadata, ...supplier }) => {
      const term = byId.get(metadata?.paymentTermsId);
      return { ...supplier, paymentTerm: term ? { code: term.code, name: term.name, days: term.days ?? null } : null };
    });
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
          select: { id: true, code: true, name: true, metadata: true },
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
    // What other bills already claim on each order line, so a bill recorded
    // before the goods arrive starts at what is left to bill.
    const billedRows = await prisma.supplierInvoiceLine.findMany({
      where: {
        purchaseOrderLineId: { in: purchaseOrders.flatMap((row) => row.lines.map((line) => line.id)) },
        supplierInvoice: { tenantId: current.tenantId, status: { in: [...RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES] } },
      },
      select: { purchaseOrderLineId: true, quantity: true },
    });
    const poNumbers = new Map(purchaseOrders.map((row) => [row.id, procurementDocumentNumber(row)]));
    const billed = new Map();
    for (const row of billedRows)
      billed.set(row.purchaseOrderLineId, (billed.get(row.purchaseOrderLineId) || 0n) + financeUnits(row.quantity || 0));
    return {
      suppliers: await withPaymentTerms(suppliers, current.tenantId),
      purchaseOrders: purchaseOrders.map((row) => ({
        id: row.id,
        // The number the order shows; orders created before numbering show their id.
        number: procurementDocumentNumber(row),
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        currency: row.currency,
        status: row.status,
        lines: row.lines.map((line) => ({
          id: line.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          orderedQuantity: decimal(line.orderedQuantity),
          billedQuantity: financeFixed(billed.get(line.id) || 0n),
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
        ...(poNumbers.get(row.poId) ? { poNumber: poNumbers.get(row.poId) } : {}),
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
