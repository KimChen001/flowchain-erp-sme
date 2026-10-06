import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";

// Duplicate supplier invoice checks (plan item C1, decision 9). A bill is
// flagged, never blocked on its own: the approver dismisses a flag with a
// reason or cancels the bill. Two kinds of flag:
//
// - likely: the same supplier sent another bill whose invoice number is the
//   same once case, spaces, dashes, dots, slashes and leading zeros are set
//   aside. The exact number is already unique per supplier through the
//   partial index SupplierInvoice_tenant_supplier_number_key (migration
//   20261002010000), so this catches the numbers that differ only in format.
// - possible: the same supplier, the same currency and the same total, with
//   invoice dates at most DUPLICATE_WINDOW_DAYS calendar days apart. Amounts
//   are compared only within one currency.
//
// Cancelled bills are left out. Supplier invoices have no rejected status
// (rejecting a bill means cancelling it); "rejected" is listed defensively.

export const DUPLICATE_WINDOW_DAYS = 7;
export const DUPLICATE_EXCLUDED_STATUSES = Object.freeze(["cancelled", "rejected"]);
export const DUPLICATE_KINDS = Object.freeze(["likely", "possible"]);
const DAY_MS = 86_400_000;

const text = (value) => String(value ?? "").trim();

// Normalizes an invoice number for comparison, in this order: Unicode NFKC
// (so full-width characters become plain ones), trim and lowercase, leading
// zeros dropped from every run of digits (an all-zero run keeps one 0), then
// whitespace, dashes, dots and slashes removed. The zeros go before the
// separators, so "INV-2024-001" and "inv 2024/1" both become "inv20241".
// An empty result is null, which means no number check.
export function normalizeInvoiceNumber(value) {
  if (value === null || value === undefined) return null;
  const key = String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""))
    .replace(/[\s\-‐-―./]/g, "");
  return key || null;
}

// The total as a 4-decimal string, so "100" and "100.0000" agree. A total
// that is missing or not a decimal is null and is not compared.
export function invoiceTotalKey(invoice) {
  const raw = invoice?.totalAmount ?? invoice?.amount;
  if (raw === null || raw === undefined || text(raw) === "") return null;
  try {
    return decimalString(decimalUnits(String(raw)));
  } catch {
    return null;
  }
}

// The calendar day in the workspace timezone, as the UTC midnight of that day.
// Copied from localDateNumber in operational-finance-o2c-read-service.mjs.
function localDateNumber(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day));
}

// The invoice date as a day number. Bill dates are entered as YYYY-MM-DD and
// stored as UTC midnight; read in a timezone west of UTC that would be the day
// before, so a UTC-midnight value keeps its own date. Any other time of day is
// read in the workspace timezone.
export function invoiceDayNumber(value, timezone) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const utcMidnight =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  return utcMidnight ? date.getTime() : localDateNumber(date, timezone);
}

export function invoiceDayKey(value, timezone) {
  const day = invoiceDayNumber(value, timezone);
  return day === null ? null : new Date(day).toISOString().slice(0, 10);
}

// What a flag rests on for one bill. A dismissal holds only while both bills
// still have the basis it was given for; editing a draft reopens the flag.
export function duplicateBasis(invoice, timezone) {
  return {
    numberKey: normalizeInvoiceNumber(invoice?.invoiceNumber),
    currency: text(invoice?.currency).toUpperCase() || null,
    total: invoiceTotalKey(invoice),
    day: invoiceDayKey(invoice?.invoiceDate, timezone),
  };
}

const basisText = (basis) =>
  JSON.stringify({
    numberKey: basis?.numberKey ?? null,
    currency: basis?.currency ?? null,
    total: basis?.total ?? null,
    day: basis?.day ?? null,
  });

export function sameBasis(left, right) {
  return (
    basisText(left?.self) === basisText(right?.self) &&
    basisText(left?.other) === basisText(right?.other)
  );
}

// The flags of one bill against the other bills of its supplier. Candidates
// may come from any query; the rules are applied here: same tenant and
// supplier, not the bill itself, not cancelled. A bill without a supplier is
// not checked at all; one without a number or date skips that check. What was
// not checked is reported, never silently passed.
export function findDuplicateFlags({ invoice, candidates = [], timezone }) {
  const notChecked = [];
  if (!text(invoice?.supplierId)) return { flags: [], notChecked: ["no_supplier"], windowDays: DUPLICATE_WINDOW_DAYS };
  const self = duplicateBasis(invoice, timezone);
  const selfDay = invoiceDayNumber(invoice.invoiceDate, timezone);
  if (!self.numberKey) notChecked.push("no_number");
  if (selfDay === null) notChecked.push("no_date");
  if (!self.total) notChecked.push("no_amount");
  const flags = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (candidate.id === invoice.id) continue;
    if (text(candidate.tenantId) && text(invoice.tenantId) && candidate.tenantId !== invoice.tenantId) continue;
    if (text(candidate.supplierId) !== text(invoice.supplierId)) continue;
    if (DUPLICATE_EXCLUDED_STATUSES.includes(text(candidate.status))) continue;
    const other = duplicateBasis(candidate, timezone);
    const otherDay = invoiceDayNumber(candidate.invoiceDate, timezone);
    const daysApart =
      selfDay === null || otherDay === null ? null : Math.round(Math.abs(selfDay - otherDay) / DAY_MS);
    const basis = { self, other };
    if (self.numberKey && other.numberKey === self.numberKey) {
      flags.push({ kind: "likely", otherInvoiceId: candidate.id, daysApart, windowDays: DUPLICATE_WINDOW_DAYS, basis });
      continue;
    }
    if (
      self.currency &&
      other.currency === self.currency &&
      self.total &&
      other.total === self.total &&
      daysApart !== null &&
      daysApart <= DUPLICATE_WINDOW_DAYS
    )
      flags.push({ kind: "possible", otherInvoiceId: candidate.id, daysApart, windowDays: DUPLICATE_WINDOW_DAYS, basis });
  }
  // Likely before possible, then the closest dates, then by id, so the order
  // is the same on every read.
  flags.sort(
    (left, right) =>
      DUPLICATE_KINDS.indexOf(left.kind) - DUPLICATE_KINDS.indexOf(right.kind) ||
      (left.daysApart ?? Infinity) - (right.daysApart ?? Infinity) ||
      left.otherInvoiceId.localeCompare(right.otherInvoiceId),
  );
  return { flags, notChecked, windowDays: DUPLICATE_WINDOW_DAYS };
}

// A flag is dismissed while a review for the same other bill and kind was
// given on the same basis. Reviews whose basis no longer holds stay on
// record and are marked stale ("no longer applies").
export function applyDuplicateReviews(flags, reviews = []) {
  const withReviews = flags.map((flag) => {
    const dismissal =
      reviews
        .filter((review) => review.otherInvoiceId === flag.otherInvoiceId && review.kind === flag.kind && sameBasis(review.basis, flag.basis))
        .sort((left, right) => new Date(right.dismissedAt) - new Date(left.dismissedAt))[0] || null;
    return { ...flag, status: dismissal ? "dismissed" : "open", dismissal };
  });
  const current = new Set(withReviews.map((flag) => flag.dismissal?.id).filter(Boolean));
  const history = reviews.map((review) => ({
    ...review,
    stale: !withReviews.some(
      (flag) => flag.otherInvoiceId === review.otherInvoiceId && flag.kind === review.kind && sameBasis(review.basis, flag.basis),
    ),
    current: current.has(review.id),
  }));
  return { flags: withReviews, reviews: history, openFlags: withReviews.filter((flag) => flag.status === "open") };
}

const CANDIDATE_SELECT = {
  id: true,
  tenantId: true,
  supplierId: true,
  invoiceNumber: true,
  invoiceDate: true,
  totalAmount: true,
  amount: true,
  currency: true,
  status: true,
};

// Reads the candidates for one bill and applies the rules. One query reads the
// supplier's bills that carry a number (normalized here, so no SQL copy of the
// rule is needed); a second reads the bills of the same currency and total
// dated within a day more than the window on either side, and the exact
// calendar-day rule is applied here. Assumes SME volumes per supplier.
export async function loadDuplicateFlags(db, { tenantId, invoice, timezone }) {
  const supplierId = text(invoice?.supplierId);
  if (!supplierId) return findDuplicateFlags({ invoice, candidates: [], timezone });
  const base = {
    tenantId,
    supplierId,
    id: { not: invoice.id },
    status: { notIn: [...DUPLICATE_EXCLUDED_STATUSES] },
  };
  const self = duplicateBasis(invoice, timezone);
  const day = invoiceDayNumber(invoice.invoiceDate, timezone);
  const [numbered, sameAmount] = await Promise.all([
    self.numberKey
      ? db.supplierInvoice.findMany({ where: { ...base, invoiceNumber: { not: null } }, select: CANDIDATE_SELECT })
      : [],
    day !== null && self.total && self.currency
      ? db.supplierInvoice.findMany({
          where: {
            ...base,
            currency: self.currency,
            invoiceDate: {
              gte: new Date(day - (DUPLICATE_WINDOW_DAYS + 1) * DAY_MS),
              lt: new Date(day + (DUPLICATE_WINDOW_DAYS + 2) * DAY_MS),
            },
            OR: [{ totalAmount: self.total }, { totalAmount: null, amount: self.total }],
          },
          select: CANDIDATE_SELECT,
        })
      : [],
  ]);
  return findDuplicateFlags({ invoice: { ...invoice, tenantId }, candidates: [...numbered, ...sameAmount], timezone });
}

// The flags of one bill with its reviews applied.
export async function loadDuplicateChecks(db, { tenantId, invoice, timezone }) {
  const result = await loadDuplicateFlags(db, { tenantId, invoice, timezone });
  const reviews = await db.supplierInvoiceDuplicateReview.findMany({
    where: { tenantId, supplierInvoiceId: invoice.id },
    orderBy: [{ dismissedAt: "desc" }, { id: "asc" }],
  });
  return { ...result, ...applyDuplicateReviews(result.flags, reviews) };
}

export async function workspaceTimezone(db, tenantId) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  return text(tenant?.timezone) || "UTC";
}
