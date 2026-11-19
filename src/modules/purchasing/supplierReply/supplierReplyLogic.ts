import type { SupplierReplyCardData, SupplierReplyDismissReason } from "./supplierReplyTypes.ts";

// What the supplier reply card decides without React, so a node test can
// pin it (server/domain/supplier-reply-card.test.mjs).

// The assistant's paste limit, as the server's (SUPPLIER_REPLY_LIMITS.text).
export const SUPPLIER_REPLY_TEXT_LIMIT = 8000;
export const SUPPLIER_REPLY_NOTE_LIMIT = 200;

export const isOpenReply = (card: SupplierReplyCardData) => card.state === "proposed" || card.state === "needs_you";
// The reply could not be read (AI off, no model, over the cap, a failure):
// the card shows the manual form with the reply beside it (#363 §4.9).
export const isOutage = (card: SupplierReplyCardData) => card.readingStatus !== "read";
// The person enters the dates: an outage, or a reading that needs them.
export const needsManualForm = (card: SupplierReplyCardData) => isOpenReply(card) && (isOutage(card) || card.state === "needs_you");

// The supplier's sentences on the reply, marked where they occur. A quote is
// found again after whitespace normalisation, as the server's check does.
export type ReplySegment = { text: string; marked: boolean };
export function markQuotes(text: string, quotes: Array<string | null | undefined>): ReplySegment[] {
  const ranges: Array<[number, number]> = [];
  for (const quote of new Set(quotes.map((value) => String(value || "").trim()).filter(Boolean))) {
    const pattern = quote.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    for (const match of text.matchAll(new RegExp(pattern, "g"))) ranges.push([match.index!, match.index! + match[0].length]);
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
// was shown (stale), or the reply is no longer open (closed). The code may
// sit at the top of the answer, as the procurement routes send it, or under
// `error`.
const STALE_CODES = new Set(["SYNC_VERSION_CONFLICT", "PURCHASE_ORDER_VERSION_INVALID", "PURCHASE_ORDER_WORKFLOW_CONFLICT", "SUPPLIER_REPLY_STALE", "SUPPLIER_REPLY_VERSION_CONFLICT"]);
const CLOSED_CODES = new Set(["SUPPLIER_REPLY_NOT_OPEN", "SUPPLIER_REPLY_CLOSED", "SUPPLIER_REPLY_SUPERSEDED", "SUPPLIER_REPLY_ALREADY_DECIDED"]);
export function replyErrorCode(error: unknown): string {
  const value = (error ?? {}) as { code?: unknown; payload?: { code?: unknown; error?: { code?: unknown } } };
  const code = value.code ?? value.payload?.code ?? value.payload?.error?.code;
  return typeof code === "string" ? code : "";
}
export function replyErrorKind(error: unknown): "stale" | "closed" | "other" {
  const code = replyErrorCode(error);
  if (STALE_CODES.has(code)) return "stale";
  if (CLOSED_CODES.has(code)) return "closed";
  return "other";
}
