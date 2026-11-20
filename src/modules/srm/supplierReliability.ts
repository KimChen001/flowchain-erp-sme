// Supplier reliability, as GET /api/master-data/supplier-reliability serves it
// (shared/supplier-reliability-contract.mjs, docs/supplier-reply-dates-design.md
// §4.12): how often a supplier moved its promised dates and how its replies
// to a chase went, over the scorecard's 90 days. A measure of its own beside
// on time and OTIF, which stay on each order's original promise.

export type ReliabilityShare = { count: number; of: number; share: number | null };
export type ReliabilityRevisions = {
  orders: number;
  revisedOrders: number;
  revisions: number;
  perOrder: number | null;
  averageDaysMoved: number | null;
  movedLater: ReliabilityShare;
};
// recordedUnchanged and recordedEdited record a proposal; recordedManual
// records dates the person typed when nothing was proposed (AI off, a failed
// reading, every line needing the person).
export type ReliabilityOutcomes = {
  recordedUnchanged: number;
  recordedEdited: number;
  recordedManual: number;
  notRecorded: { wrong_reading: number; supplier_will_confirm: number; other: number };
  needsYou: number;
  proposed: number;
  nothingToRecord: number;
};
export type ReliabilityReplies = {
  received: number;
  read: number;
  withStatedDate: ReliabilityShare;
  outcomes: ReliabilityOutcomes;
  recorded: number;
  medianHoursToRecord: number | null;
};
// A part is null when the reader may not read it.
export type ReliabilityRow = { revisions: ReliabilityRevisions | null; replies: ReliabilityReplies | null };
export type SupplierReliability = {
  contractVersion: number;
  asOf: string;
  window: { from: string; to: string; days: number };
  minimumSample: number;
  visibility: { revisions: boolean; replies: boolean };
  suppliers: Record<string, ReliabilityRow>;
};

// The suppliers the block lists, in the order the indicator table shows them:
// those with an order due or a reply in the window, in a part the reader may
// see. The others are only counted, so a quiet supplier is not a row of "—".
export function reliabilityRows<T extends { id: string }>(shown: T[], data: SupplierReliability) {
  const active = (row: ReliabilityRow | undefined) => Boolean(row) && (
    (data.visibility.revisions && (row!.revisions?.orders ?? 0) > 0) || (data.visibility.replies && (row!.replies?.received ?? 0) > 0)
  );
  const listed = shown.filter((supplier) => active(data.suppliers[supplier.id]));
  return { listed, quiet: shown.length - listed.length };
}

// Each reply is in exactly one outcome; these group them for the cell.
export const recordedReplies = (outcomes: ReliabilityOutcomes) => outcomes.recordedUnchanged + outcomes.recordedEdited;
export const manualReplies = (outcomes: ReliabilityOutcomes) => outcomes.recordedManual;
export const notRecordedReplies = (outcomes: ReliabilityOutcomes) => outcomes.notRecorded.wrong_reading + outcomes.notRecorded.supplier_will_confirm + outcomes.notRecorded.other;
export const openReplies = (outcomes: ReliabilityOutcomes) => outcomes.needsYou + outcomes.proposed;
