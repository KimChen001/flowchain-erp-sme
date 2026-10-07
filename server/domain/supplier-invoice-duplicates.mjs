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

const text = (value) => String(value ?? "").trim();

export const DUPLICATE_WINDOW_DAYS = 7;
export const DUPLICATE_EXCLUDED_STATUSES = Object.freeze(["cancelled", "rejected"]);
export const DUPLICATE_KINDS = Object.freeze(["likely", "possible"]);
// The bill statuses before approval. Flags are dismissed only in these; any
// other status (approved, held while its payable is on hold, cancelled) is
// past approval, so its flags are shown for information and can no longer be
// dismissed on it. An allow-list, so a later status is closed by default.
export const DUPLICATE_REVIEW_STATUSES = Object.freeze(["draft", "submitted", "matching", "matched", "exception"]);
export const isDuplicateReviewClosed = (status) => !DUPLICATE_REVIEW_STATUSES.includes(text(status));
const DAY_MS = 86_400_000;


// Normalizes an invoice number for comparison. Both readings of "leading
// zeros of a numeric part" are kept, and a likely duplicate is any shared key:
//
// - by part: leading zeros dropped from every run of digits first, then the
//   separators removed, so "INV-2024-001" and "inv 2024/1" both give
//   "inv20241";
// - joined: the separators removed first, then the leading zeros of each
//   remaining run of digits, so "INV-2024-001" and "INV2024001" both give
//   "inv2024001", and "A 0 1" and "A01" both give "a1".
//
// Before either: Unicode NFKC (so full-width characters become plain ones),
// trim and lowercase. Separators are whitespace, dashes (also U+2010 to
// U+2015), dots and slashes. An all-zero run keeps one 0. Because inner
// separators are removed, "INV-1-23" and "INV-12-3" share a key; the label
// says the numbers match once formatting is ignored, and both are printed.
// An empty number has no keys, which means no number check.
const SEPARATORS = /[\s\-‐-―./]/g;
const dropLeadingZeros = (value) => value.replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""));

export function invoiceNumberKeys(value) {
  if (value === null || value === undefined) return [];
  const prepared = String(value).normalize("NFKC").trim().toLowerCase();
  const byPart = dropLeadingZeros(prepared).replace(SEPARATORS, "");
  const joined = dropLeadingZeros(prepared.replace(SEPARATORS, ""));
  return [...new Set([byPart, joined].filter(Boolean))];
}

// The by-part key, or null when the number is empty.
export function normalizeInvoiceNumber(value) {
  return invoiceNumberKeys(value)[0] ?? null;
}

const sharedKey = (left, right) => left.find((key) => right.includes(key)) ?? null;

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
    numberKeys: invoiceNumberKeys(invoice?.invoiceNumber),
    currency: text(invoice?.currency).toUpperCase() || null,
    total: invoiceTotalKey(invoice),
    day: invoiceDayKey(invoice?.invoiceDate, timezone),
  };
}

const basisText = (basis) =>
  JSON.stringify({
    numberKeys: basis?.numberKeys ?? [],
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
  if (!self.numberKeys.length) notChecked.push("no_number");
  if (selfDay === null) notChecked.push("no_date");
  if (!self.total) notChecked.push("no_amount");
  const found = [];
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
    const flag = {
      otherInvoiceId: candidate.id,
      // What the approver is shown of the other bill. The total is a
      // four-decimal string and is left out by callers whose reader cannot
      // see amounts.
      otherInvoice: {
        id: candidate.id,
        invoiceNumber: text(candidate.invoiceNumber) || candidate.id,
        invoiceDate: other.day,
        totalAmount: other.total,
        currency: other.currency,
        status: text(candidate.status),
        version: candidate.version ?? null,
      },
      daysApart,
      windowDays: DUPLICATE_WINDOW_DAYS,
      basis: { self, other },
    };
    const order = { day: otherDay, number: text(candidate.invoiceNumber) };
    const numberKey = sharedKey(self.numberKeys, other.numberKeys);
    if (numberKey) {
      found.push({ flag: { kind: "likely", ...flag, numberKey }, order });
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
      found.push({ flag: { kind: "possible", ...flag }, order });
  }
  // Likely before possible; within a kind by the other bill's invoice date,
  // oldest first (undated last), then by its printed number. The id only
  // breaks a full tie, so the order is the same on every read.
  found.sort(
    (left, right) =>
      DUPLICATE_KINDS.indexOf(left.flag.kind) - DUPLICATE_KINDS.indexOf(right.flag.kind) ||
      (left.order.day ?? Infinity) - (right.order.day ?? Infinity) ||
      left.order.number.localeCompare(right.order.number) ||
      left.flag.otherInvoiceId.localeCompare(right.flag.otherInvoiceId),
  );
  return { flags: found.map((entry) => entry.flag), notChecked, windowDays: DUPLICATE_WINDOW_DAYS };
}

// A review kept on the other bill, turned round to read from this bill.
const fromThisSide = (review) => ({
  ...review,
  otherInvoiceId: review.supplierInvoiceId,
  basis: { self: review.basis?.other, other: review.basis?.self },
});

const latest = (reviews) =>
  [...reviews].sort((left, right) => new Date(right.dismissedAt) - new Date(left.dismissedAt))[0] || null;

const covers = (review, flag) =>
  review.otherInvoiceId === flag.otherInvoiceId && review.kind === flag.kind && sameBasis(review.basis, flag.basis);

// A flag is dismissed while a review for the same other bill and kind was
// given on this bill on the same basis. Reviews whose basis no longer holds
// stay on record and are marked stale ("no longer applies").
//
// A dismissal given on the other bill does not clear this bill's flag: each
// approver looks at their own bill. It is shown as otherSideDismissal while
// its basis holds. An approved or cancelled bill is past the step where a
// flag is dismissed, so an undismissed flag there is "closed", shown for
// information, never "open".
export function applyDuplicateReviews(flags, reviews = [], { otherSideReviews = [], closed = false } = {}) {
  const turned = otherSideReviews.map(fromThisSide);
  const withReviews = flags.map((flag) => {
    const dismissal = latest(reviews.filter((review) => covers(review, flag)));
    const otherSideDismissal = latest(turned.filter((review) => covers(review, flag)));
    return { ...flag, status: dismissal ? "dismissed" : closed ? "closed" : "open", dismissal, otherSideDismissal };
  });
  const current = new Set(withReviews.map((flag) => flag.dismissal?.id).filter(Boolean));
  const history = reviews.map((review) => ({
    ...review,
    stale: !withReviews.some((flag) => covers(review, flag)),
    current: current.has(review.id),
  }));
  return { flags: withReviews, reviews: history, openFlags: withReviews.filter((flag) => flag.status === "open") };
}

// What approval waits for while flags are open (used by the approve preview
// and the approval itself). A same-amount flag reveals that two totals are
// equal, so a role that cannot read finance amounts is not shown which bill
// or how many; it is told that a same-amount check waits for someone who can
// see amounts (DUPLICATE_REVIEW_HIDDEN), never refused without a reason.
export const duplicateFlagView = (flag, amountsVisible) => ({
  kind: flag.kind,
  otherInvoiceId: flag.otherInvoiceId,
  otherInvoice: flag.otherInvoice
    ? { ...flag.otherInvoice, totalAmount: amountsVisible ? flag.otherInvoice.totalAmount : null }
    : null,
  daysApart: flag.daysApart,
  windowDays: flag.windowDays,
});

// The issues that hold approval while flags are open: the flags this approver
// can see, each with the other bill, and a separate issue when only someone
// who can see amounts can review the rest.
export function duplicateReviewIssues(openFlags, amountsVisible) {
  const shown = openFlags.filter((flag) => amountsVisible || flag.kind !== "possible");
  const hidden = shown.length < openFlags.length;
  const issues = [];
  if (shown.length)
    issues.push({
      code: "DUPLICATE_REVIEW_REQUIRED",
      message: "This bill may duplicate another bill from the same supplier. Dismiss each open duplicate flag with a reason, or cancel the bill, before approving it.",
      status: 409,
      details: {
        flags: shown.map((flag) => duplicateFlagView(flag, amountsVisible)),
        possibleHidden: !amountsVisible,
        hiddenOpen: hidden,
      },
    });
  if (hidden)
    issues.push({
      code: "DUPLICATE_REVIEW_HIDDEN",
      message: "A same-amount duplicate check on this bill needs review by someone who can see amounts before approval.",
      status: 409,
      details: { flags: [], possibleHidden: true, hiddenOpen: true },
    });
  return issues;
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
  version: true,
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
    self.numberKeys.length
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

// The flags of one bill with its reviews applied: the dismissals given on
// this bill, and those given on the other bills against this one.
export async function loadDuplicateChecks(db, { tenantId, invoice, timezone }) {
  const result = await loadDuplicateFlags(db, { tenantId, invoice, timezone });
  const rows = await db.supplierInvoiceDuplicateReview.findMany({
    where: { tenantId, OR: [{ supplierInvoiceId: invoice.id }, { otherInvoiceId: invoice.id }] },
    orderBy: [{ dismissedAt: "desc" }, { id: "asc" }],
  });
  const reviews = rows.filter((row) => row.supplierInvoiceId === invoice.id);
  const otherSideReviews = rows.filter((row) => row.supplierInvoiceId !== invoice.id);
  const closed = isDuplicateReviewClosed(invoice.status);
  return { ...result, ...applyDuplicateReviews(result.flags, reviews, { otherSideReviews, closed }) };
}

export async function workspaceTimezone(db, tenantId) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  return text(tenant?.timezone) || "UTC";
}
