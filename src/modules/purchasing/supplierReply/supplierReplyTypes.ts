// The supplier reply card as the server sends it (shared/supplier-reply-contract.mjs,
// supplierReplyCardSchema; docs/supplier-reply-dates-design.md §4.5–4.9). Labels
// are codes the card words in the reader's language; the supplier's words,
// SKUs, item names and quantities are shown as recorded.

export type SupplierReplyState = "proposed" | "needs_you" | "nothing_to_record" | "recorded" | "not_recorded" | "superseded";
export type SupplierReplyReadingStatus = "read" | "ai_off" | "no_provider" | "over_cap" | "failed" | "invalid";
export type SupplierReplyFlagKind = "quantity_change" | "price_change" | "cancellation" | "substitution" | "other_order";
export type SupplierReplyDismissReason = "wrong_reading" | "supplier_will_confirm" | "other";
export type SupplierReplyEmailOrderStatus = "this" | "read" | "closed" | "other_supplier" | "unknown" | "over_limit" | "open_card_kept";
export type SupplierReplyLineIssue =
  | "quote_not_found" | "date_mismatch" | "ambiguous_numeric" | "vague" | "relative_unreadable"
  | "before_reply" | "too_far" | "unknown_line" | "not_open" | "unchanged" | "split_incomplete" | "several_dates"
  | "refused" | "addressed_to_system" | "line_mismatch" | "ambiguous_weekday" | "other_order_text" | "no_order_part"
  | "correction_across_orders" | "several_orders" | "other_order_number";

export type SupplierReplyLine = {
  ref: string | null;
  purchaseOrderLineId: string | null;
  outcome: "proposed" | "needs_you" | "dropped" | "confirmed";
  issue: SupplierReplyLineIssue | null;
  currentDate: string | null;
  proposedDate: string | null;
  quote: string | null;
  dateKind: "stated" | "relative" | "vague" | null;
  readAs: { phrase: string; from: string; date: string } | null;
  // The reading gave no exact day and code read the one day the quote names;
  // readAs is set. Optional from an older server.
  inferred?: boolean;
  readings: string[] | null;
  parts: Array<{ quantity: number | null; date: string; quote: string }> | null;
  sku: string | null;
  // The supplier's own code for the item, which a reply often quotes.
  supplierSku: string | null;
  itemName: string | null;
  remaining: number | null;
  unit: string | null;
  overdueDays: number | null;
};

export type SupplierReplyFormLine = Pick<SupplierReplyLine, "purchaseOrderLineId" | "sku" | "supplierSku" | "itemName" | "remaining" | "unit" | "currentDate" | "overdueDays">;

export type SupplierReplyCardData = {
  contractVersion: number;
  id: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  orderVersion: number;
  supplierName: string | null;
  source: "paste" | "email";
  receivedOn: string;
  createdAt: string;
  state: SupplierReplyState;
  readingStatus: SupplierReplyReadingStatus;
  replyKind: "dates" | "confirms" | "no_date" | "auto_reply" | "other" | null;
  text: string;
  quotedTextHidden: boolean;
  // What was cut before reading (a signature, ">" lines, the earlier
  // message), kept for display only; null when nothing was cut.
  quotedText: string | null;
  lines: SupplierReplyLine[];
  flags: Array<{ kind: SupplierReplyFlagKind; quote: string; orderNumber: string | null }>;
  reason: string | null;
  instructionsIgnored: boolean;
  formLines: SupplierReplyFormLine[];
  canDecide: boolean;
  notNowUntil: string | null;
  decision: {
    option: "recorded" | "not_recorded";
    reason: SupplierReplyDismissReason | null;
    note: string | null;
    decidedById: string;
    decidedAt: string;
    editedLines: number;
    revisionIds: string[];
  } | null;
  supersededById: string | null;
  // The orders the email names, when it names several; absent otherwise.
  emailOrders?: { number: string; status: SupplierReplyEmailOrderStatus }[];
};
