import { apiJson } from "../../lib/api-client";
import { buildSuggestionTrail, type PrefillEntry } from "../../lib/prefill";

// Text drafts addressed to a supplier: the review shows them as a message
// with a recipient and a subject (docs/ai-prefill-autocomplete-design.md, J1/J2).
export const MESSAGE_DRAFT_TYPES = new Set(["po_followup_draft", "supplier_followup_draft"]);
// Payload fields the message section shows instead of the generic field grid.
export const MESSAGE_FIELDS = new Set(["to", "toMissing", "contactName", "subject", "message", "messageDraft", "lines", "language", "basis", "poIds"]);

// `po`: the order a line belongs to, in a message about several orders.
export type DraftLine = {
  lineId?: string;
  po?: string | null;
  ordered?: number | null;
  received?: number | null;
  sku?: string | null;
  itemName?: string | null;
  remaining?: number | null;
  unit?: string | null;
  promisedDate?: string | null;
  originalPromisedDate?: string | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));

// The supplier follow-up preview stores the text as messageDraft.
export function messageKey(payload: Record<string, unknown>) {
  return "messageDraft" in payload ? "messageDraft" : "message";
}

// The document sections the answer cited, which the draft follows (shown
// with the draft, never in the message).
export type DraftBasis = { title?: string; section?: string | null; citationId?: string };

export function draftBasis(payload: Record<string, unknown>): DraftBasis[] {
  return Array.isArray(payload.basis) ? (payload.basis as DraftBasis[]).filter((entry) => entry && typeof entry === "object" && entry.title).slice(0, 2) : [];
}

export function draftLines(payload: Record<string, unknown>): DraftLine[] {
  return Array.isArray(payload.lines) ? (payload.lines as DraftLine[]).filter((line) => line && typeof line === "object").slice(0, 50) : [];
}

export function messageText(payload: Record<string, unknown>, labels: { to: string; subject: string }) {
  const to = text(payload.to).trim();
  const subject = text(payload.subject).trim();
  const body = text(payload[messageKey(payload)]).trim();
  const header = [to ? `${labels.to}: ${to}` : "", subject ? `${labels.subject}: ${subject}` : ""].filter(Boolean).join("\n");
  return header ? `${header}\n\n${body}`.trim() : body;
}

// Mail apps take a mailto link of about 2,000 characters; a longer body is
// shortened there, and Copy keeps the full text.
const MAILTO_LIMIT = 1900;
export function mailtoLink(payload: Record<string, unknown>) {
  const to = text(payload.to)
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map(encodeURIComponent)
    .join(",");
  const subject = encodeURIComponent(text(payload.subject).trim());
  const body = text(payload[messageKey(payload)]).trim();
  const head = `mailto:${to}?subject=${subject}&body=`;
  let encoded = encodeURIComponent(body);
  let shortened = false;
  if (head.length + encoded.length > MAILTO_LIMIT) {
    shortened = true;
    let keep = body.length;
    while (keep > 0 && head.length + encodeURIComponent(`${body.slice(0, keep)}…`).length > MAILTO_LIMIT) keep = Math.floor(keep * 0.9);
    encoded = encodeURIComponent(`${body.slice(0, keep)}…`);
  }
  return { href: `${head}${encoded}`, shortened };
}

// The user copied the draft or opened it in their own mail app. FlowChain
// sends nothing; the server records the draft type, the use and which
// suggested fields were kept, as codes. A failure never blocks the user.
export function recordActionDraftUse(
  draft: { type: string; source?: string; payload?: Record<string, unknown>; prefill?: Record<string, PrefillEntry> },
  use: "copied" | "opened_in_email",
) {
  const suggestionTrail = draft.prefill
    ? buildSuggestionTrail({ origin: draft.source, prefills: draft.prefill, values: draft.payload || {} })
    : null;
  return apiJson("/api/action-drafts/used", {
    method: "POST",
    body: JSON.stringify({ draftType: draft.type, use, ...(suggestionTrail ? { suggestionTrail } : {}) }),
  }).catch(() => undefined);
}
