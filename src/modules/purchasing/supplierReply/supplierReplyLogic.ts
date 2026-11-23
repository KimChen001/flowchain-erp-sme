import type { SupplierReplyCardData, SupplierReplyDismissReason } from "./supplierReplyTypes.ts";

// What the supplier reply card decides without React, so a node test can
// pin it (server/domain/supplier-reply-card.test.mjs).

// The cleaned reply the card shows (SUPPLIER_REPLY_LIMITS.text), and what
// may be pasted: twice that, since the quoted chase and signature are cut
// before reading (supplierReplyPasteRequestSchema).
export const SUPPLIER_REPLY_TEXT_LIMIT = 8000;
export const SUPPLIER_REPLY_PASTE_LIMIT = SUPPLIER_REPLY_TEXT_LIMIT * 2;
export const SUPPLIER_REPLY_NOTE_LIMIT = 200;

export const isOpenReply = (card: SupplierReplyCardData) => card.state === "proposed" || card.state === "needs_you";
// The cards to show first: the open reply the person decides on, and the
// latest one when it is another (a newer paste kept beside the open card:
// an outage or nothing to record, which the server lists with canDecide
// false). The rest are earlier replies.
export function featuredReplies(list: SupplierReplyCardData[], first: SupplierReplyCardData | null = list[0] || null) {
  const decidable = list.find((card) => isOpenReply(card) && card.canDecide) || list.find(isOpenReply) || null;
  const featured = [first, decidable].filter((card, index, all): card is SupplierReplyCardData => Boolean(card) && all.findIndex((other) => other?.id === card!.id) === index);
  return { featured, earlier: list.filter((card) => !featured.some((shown) => shown.id === card.id)) };
}
// The reply could not be read (AI off, no model, over the cap, a failure):
// the card shows the manual form with the reply beside it (#363 §4.9).
export const isOutage = (card: SupplierReplyCardData) => card.readingStatus !== "read";
// The person enters the dates: an outage, or a reading that needs them.
export const needsManualForm = (card: SupplierReplyCardData) => isOpenReply(card) && (isOutage(card) || card.state === "needs_you");

// The supplier's sentences on the reply, marked where they occur. A quote is
// found again after whitespace normalisation and regardless of case, as the
// server's check finds it.
export type ReplySegment = { text: string; marked: boolean };
export function markQuotes(text: string, quotes: Array<string | null | undefined>): ReplySegment[] {
  const ranges: Array<[number, number]> = [];
  for (const quote of new Set(quotes.map((value) => String(value || "").trim()).filter(Boolean))) {
    // Straight and curly quotes, and the dashes, count as one another.
    const pattern = quote.split(/\s+/).map((part) => part
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/['‘’‚′]/g, "['‘’‚′]")
      .replace(/["“”„″]/g, "[\"“”„″]")
      .replace(/[-–—]/g, "[-–—]")).join("\\s+");
    for (const match of text.matchAll(new RegExp(pattern, "gi"))) ranges.push([match.index!, match.index! + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const segments: ReplySegment[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) segments.push({ text: text.slice(at, start), marked: false });
    segments.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length || !segments.length) segments.push({ text: text.slice(at), marked: false });
  return segments;
}

// The manual form and Edit start from the proposal: a proposed line's date,
// nothing for the others (the person types it or picks a reading).
export function formStart(card: SupplierReplyCardData): Record<string, string> {
  const start: Record<string, string> = {};
  for (const line of card.formLines) if (line.purchaseOrderLineId) start[line.purchaseOrderLineId] = "";
  for (const line of card.lines) if (line.outcome === "proposed" && line.purchaseOrderLineId && line.proposedDate) start[line.purchaseOrderLineId] = line.proposedDate;
  return start;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The dates to record from the form: a filled, well-formed day that differs
// from the line's current promised date. Empty means nothing to send.
export function recordLines(card: SupplierReplyCardData, values: Record<string, string>) {
  const current = new Map(card.formLines.map((line) => [line.purchaseOrderLineId, line.currentDate]));
  return Object.entries(values)
    .filter(([lineId, day]) => DAY.test(day) && current.has(lineId) && current.get(lineId) !== day)
    .map(([purchaseOrderLineId, promisedDate]) => ({ purchaseOrderLineId, promisedDate }));
}

// Which of a line's readings the person may pick with one click: the two
// readings of a 03/12-style date, or the two dates one sentence names. A
// date_mismatch with readings offers none (one may be the model's own date,
// not the supplier's), so the person types the day.
// A vague line may offer the one or two days its words could mean
// (二十八号, "on Friday", a hedged "starting 3 Dec"), as choices.
const PICKABLE = new Set(["ambiguous_numeric", "ambiguous_weekday", "several_dates"]);
export function pickableReadings(line: { issue: string | null; readings: string[] | null }) {
  const readings = line.readings || [];
  if (PICKABLE.has(String(line.issue)) && readings.length === 2) return readings;
  if (line.issue === "vague" && readings.length >= 1 && readings.length <= 2) return readings;
  return null;
}

// The lines of a proposed card that still need the person: a reading that did
// not pass, on a line of the order (#363 §4.8, "unmatched items go to needs
// you"). Recording the proposal waits until each has a date or is left as is.
export const openQuestions = (card: SupplierReplyCardData) =>
  card.state === "proposed" ? card.lines.filter((line) => line.outcome === "needs_you" && line.purchaseOrderLineId) : [];

// The order's date for a line now (formLines, read when the card was
// rendered), and whether it moved since the reply was read: someone changed
// it in between, and recording would overwrite that change.
export function lineNow(card: SupplierReplyCardData, line: { purchaseOrderLineId: string | null; currentDate: string | null }) {
  const form = card.formLines.find((entry) => entry.purchaseOrderLineId === line.purchaseOrderLineId);
  const now = form ? form.currentDate : line.currentDate;
  return { now, overdueDays: form ? form.overdueDays : null, movedFrom: form && now !== line.currentDate ? line.currentDate : undefined };
}

// What Record sends on a proposed card. Without open questions, nothing but
// the version: the server records the proposal. With them, each must have a
// date (in `values`) or be left as is (`skipped`) first; the lines sent are
// the proposed dates plus the dates given for the questions.
export function proposalRecord(card: SupplierReplyCardData, values: Record<string, string>, skipped: Set<string>) {
  const questions = openQuestions(card);
  const answered = (lineId: string) => DAY.test(values[lineId] || "");
  const ready = questions.every((line) => skipped.has(line.purchaseOrderLineId!) || answered(line.purchaseOrderLineId!));
  const given = questions.filter((line) => !skipped.has(line.purchaseOrderLineId!) && answered(line.purchaseOrderLineId!));
  if (!ready) return { ready, lines: undefined };
  if (!given.length) return { ready, lines: undefined };
  const proposed = card.lines.filter((line) => line.outcome === "proposed" && line.purchaseOrderLineId && line.proposedDate).map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId!, promisedDate: line.proposedDate! }));
  const answers = recordLines(card, Object.fromEntries(given.map((line) => [line.purchaseOrderLineId!, values[line.purchaseOrderLineId!]])));
  return { ready, lines: [...proposed, ...answers] };
}

// One key per card, order version and set of dates, so a double click records
// once and a new choice is a new command.
export function recordKey(card: SupplierReplyCardData, lines?: Array<{ purchaseOrderLineId: string; promisedDate: string }>) {
  const basis = lines ? lines.map((line) => `${line.purchaseOrderLineId}=${line.promisedDate}`).sort().join(",") : "proposed";
  let hash = 5381;
  for (let index = 0; index < basis.length; index += 1) hash = ((hash * 33) ^ basis.charCodeAt(index)) >>> 0;
  return `supplier-reply:${card.id}:v${card.orderVersion}:${hash.toString(36)}`;
}

export const dismissReady = (reason: SupplierReplyDismissReason, note: string) =>
  note.length <= SUPPLIER_REPLY_NOTE_LIMIT && (reason !== "other" || note.trim().length > 0);

// A refusal the card explains on its own: the order changed since the card
// was shown (stale), a line's date moved since the reply was read (moved), or
// the reply is no longer open (closed). The code may
// sit at the top of the answer, as the procurement routes send it, or under
// `error`.
// The routes answer a stale card with SYNC_VERSION_CONFLICT (the
// promised-dates command's code) and a reply that was recorded, dismissed or
// replaced with SUPPLIER_REPLY_NOT_OPEN (shared/supplier-reply-contract.mjs).
const STALE_CODES = new Set(["SYNC_VERSION_CONFLICT", "PURCHASE_ORDER_VERSION_INVALID"]);
const CLOSED_CODES = new Set(["SUPPLIER_REPLY_NOT_OPEN"]);
const MOVED_CODES = new Set(["SUPPLIER_REPLY_STALE"]);
export function replyErrorCode(error: unknown): string {
  const value = (error ?? {}) as { code?: unknown; payload?: { code?: unknown; error?: { code?: unknown } } };
  const code = value.code ?? value.payload?.code ?? value.payload?.error?.code;
  return typeof code === "string" ? code : "";
}
export function replyErrorKind(error: unknown): "stale" | "moved" | "closed" | "other" {
  const code = replyErrorCode(error);
  if (STALE_CODES.has(code)) return "stale";
  if (MOVED_CODES.has(code)) return "moved";
  if (CLOSED_CODES.has(code)) return "closed";
  return "other";
}
