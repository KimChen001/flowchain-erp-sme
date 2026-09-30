import { randomUUID } from "node:crypto";
import { PURCHASE_ORDER_STATUS } from "./procurement-status-authority.mjs";
import { receivingDecimalUnits } from "./receiving-transaction-policy.mjs";

// The one place that sets or changes a purchase order line's promised date.
//
// A line has two dates:
//   - the current expected date, line.metadata.promisedDate, falling back to
//     PurchaseOrder.expectedDate when the line has none; it moves when the
//     supplier revises the delivery;
//   - the original promise, PurchaseOrderLine.originalPromisedDate, recorded
//     once: when the PO is issued with a date, or when a date is first set on an
//     issued PO. A database trigger refuses any later change.
// Supplier scorecards measure delivery against the original promise, because
// the current date follows the shipment and makes late deliveries look on time.
//
// After issue, every change to a line's date writes one
// PurchaseOrderPromiseRevision row and one audit row in the caller's
// transaction, and needs a reason. Dates are calendar days, stored at 12:00 UTC
// like every other date-only value, so they read as the same day in every US
// timezone.

export class PurchaseOrderPromiseError extends Error {
  constructor(code, message, status = 422, details) {
    super(message);
    this.name = "PurchaseOrderPromiseError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status, details) => { throw new PurchaseOrderPromiseError(code, message, status, details); };
const text = (value) => String(value ?? "").trim();

// Statuses in which the PO has been issued to the supplier.
export const ISSUED_PURCHASE_ORDER_STATUSES = Object.freeze([
  PURCHASE_ORDER_STATUS.ISSUED,
  PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED,
  PURCHASE_ORDER_STATUS.FULLY_RECEIVED,
]);

// A calendar day, YYYY-MM-DD, from a Date or an ISO string; null otherwise.
export function promiseDay(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1] ? match[1] : null;
}

export const promiseDateValue = (day) => new Date(`${day}T12:00:00Z`);

export function currentPromisedDay(line, purchaseOrder) {
  return promiseDay(line?.metadata?.promisedDate) || promiseDay(purchaseOrder?.expectedDate);
}

export const isIssuedPurchaseOrder = (purchaseOrder) => ISSUED_PURCHASE_ORDER_STATUSES.includes(purchaseOrder?.status);

// Records the original promise of each line that has a date and none yet.
// Called when a PO is issued, and by seeds that create issued POs. Idempotent:
// a line that already has its original promise is left alone.
export async function recordOriginalPromises(tx, { purchaseOrder, lines = purchaseOrder?.lines || [] }) {
  const recorded = [];
  for (const line of lines) {
    if (line.originalPromisedDate) continue;
    const day = currentPromisedDay(line, purchaseOrder);
    if (!day) continue;
    const updated = await tx.purchaseOrderLine.updateMany({ where: { id: line.id, purchaseOrderId: purchaseOrder.id, originalPromisedDate: null }, data: { originalPromisedDate: promiseDateValue(day) } });
    if (updated.count === 1) recorded.push({ purchaseOrderLineId: line.id, originalPromisedDate: day });
  }
  return recorded;
}

// Sets new promised dates on lines of one PO. changes: [{ purchaseOrderLineId,
// promisedDate }]. The PO must be read with its lines inside tx and locked by the
// caller. Before issue the dates simply change; after issue each change is a
// revision that needs a reason, and a first date also becomes the original
// promise. A change to the date a line already has is skipped. The header
// expected date follows the earliest line date. Returns the revisions written
// and the lines changed.
export async function applyPromisedDateChanges(tx, {
  tenantId,
  purchaseOrder,
  changes = [],
  reason,
  actorId = null,
  source,
  at = new Date(),
  idFactory = randomUUID,
}) {
  if (!tenantId || purchaseOrder?.tenantId !== tenantId) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
  if (!Array.isArray(changes) || !changes.length) fail("PROMISED_DATE_CHANGES_REQUIRED", "Choose at least one line and a new promised date.", 422, [{ field: "lines" }]);
  if (purchaseOrder.status === PURCHASE_ORDER_STATUS.CANCELLED || purchaseOrder.status === PURCHASE_ORDER_STATUS.REJECTED) {
    fail("PURCHASE_ORDER_PROMISE_CLOSED", `A ${purchaseOrder.status} purchase order has no delivery to promise.`, 409, { currentStatus: purchaseOrder.status });
  }
  const issued = isIssuedPurchaseOrder(purchaseOrder);
  const why = text(reason);
  const lines = new Map((purchaseOrder.lines || []).map((line) => [line.id, line]));
  const planned = [];
  const seen = new Set();
  for (const [index, change] of changes.entries()) {
    const lineId = text(change?.purchaseOrderLineId);
    const line = lines.get(lineId);
    if (!line) fail("PURCHASE_ORDER_LINE_NOT_FOUND", "The line is not on this purchase order.", 422, [{ field: `lines.${index}.purchaseOrderLineId` }]);
    if (seen.has(lineId)) fail("PROMISED_DATE_LINE_DUPLICATED", "Each line can change once per request.", 422, [{ field: `lines.${index}.purchaseOrderLineId` }]);
    seen.add(lineId);
    const day = promiseDay(change?.promisedDate);
    if (!day) fail("PROMISED_DATE_INVALID", "Enter the promised date as a calendar date.", 422, [{ field: `lines.${index}.promisedDate` }]);
    const previous = currentPromisedDay(line, purchaseOrder);
    if (previous === day) continue;
    if (issued && receivingDecimalUnits(line.receivedQuantity || 0) >= receivingDecimalUnits(line.orderedQuantity || 0) && receivingDecimalUnits(line.orderedQuantity || 0) > 0n) {
      fail("PURCHASE_ORDER_LINE_ALREADY_RECEIVED", "This line is fully received; its promised date can no longer change.", 409, [{ field: `lines.${index}.purchaseOrderLineId` }]);
    }
    planned.push({ line, previous, day });
  }
  if (!planned.length) return { revisions: [], changedLineIds: [], originalPromisesRecorded: [] };
  if (issued && !why) fail("PROMISE_REVISION_REASON_REQUIRED", "Give a reason for changing the promised date.", 422, [{ field: "reason" }]);

  const revisions = [];
  const originalPromisesRecorded = [];
  const currentDays = new Map((purchaseOrder.lines || []).map((line) => [line.id, currentPromisedDay(line, purchaseOrder)]));
  for (const { line, previous, day } of planned) {
    const recordOriginal = issued && !line.originalPromisedDate;
    const updated = await tx.purchaseOrderLine.updateMany({
      where: { id: line.id, purchaseOrderId: purchaseOrder.id, version: line.version },
      data: {
        metadata: { ...(line.metadata || {}), promisedDate: day },
        ...(recordOriginal ? { originalPromisedDate: promiseDateValue(day) } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) fail("SYNC_VERSION_CONFLICT", "A purchase order line changed concurrently.", 409, { entityId: line.id });
    currentDays.set(line.id, day);
    if (recordOriginal) originalPromisesRecorded.push({ purchaseOrderLineId: line.id, originalPromisedDate: day });
    if (!issued) continue;
    const revision = await tx.purchaseOrderPromiseRevision.create({
      data: {
        id: idFactory(), tenantId, purchaseOrderId: purchaseOrder.id, purchaseOrderLineId: line.id,
        previousDate: previous ? promiseDateValue(previous) : null, newDate: promiseDateValue(day), reason: why, actorId, source, createdAt: at,
      },
    });
    revisions.push(revision);
    await tx.auditLog.create({
      data: {
        id: idFactory(), tenantId, actorId, source, module: "procurement", action: "purchase_order_promise_revised",
        entityType: "PurchaseOrderLine", entityId: line.id,
        summary: `Promised date of ${purchaseOrder.id} line ${line.id} changed from ${previous || "none"} to ${day}.`,
        metadata: { purchaseOrderId: purchaseOrder.id, revisionId: revision.id, previousDate: previous, newDate: day, reason: why, originalPromiseRecorded: recordOriginal },
        createdAt: at,
      },
    });
  }
  const earliest = [...currentDays.values()].filter(Boolean).sort()[0] || null;
  const headerDay = promiseDay(purchaseOrder.expectedDate);
  if (earliest && earliest !== headerDay && headerDay) {
    // Lines without their own date read the header date. Pin them to it first,
    // so moving the header does not move their promise without a revision.
    const changed = new Set(planned.map(({ line }) => line.id));
    for (const line of purchaseOrder.lines || []) {
      if (changed.has(line.id) || promiseDay(line.metadata?.promisedDate)) continue;
      const pinned = await tx.purchaseOrderLine.updateMany({ where: { id: line.id, purchaseOrderId: purchaseOrder.id, version: line.version }, data: { metadata: { ...(line.metadata || {}), promisedDate: headerDay }, version: { increment: 1 } } });
      if (pinned.count !== 1) fail("SYNC_VERSION_CONFLICT", "A purchase order line changed concurrently.", 409, { entityId: line.id });
    }
  }
  const updatedHeader = await tx.purchaseOrder.updateMany({
    where: { id: purchaseOrder.id, tenantId, version: purchaseOrder.version },
    data: { expectedDate: earliest ? promiseDateValue(earliest) : purchaseOrder.expectedDate, version: { increment: 1 } },
  });
  if (updatedHeader.count !== 1) fail("SYNC_VERSION_CONFLICT", "Purchase order changed concurrently.", 409, { entityId: purchaseOrder.id });
  return { revisions, changedLineIds: planned.map(({ line }) => line.id), originalPromisesRecorded };
}
