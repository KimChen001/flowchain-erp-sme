// The props of each answer part, as shared/assistant-protocol.mjs validates
// them. The server builds every value from tool rows; labels are codes the
// parts word through i18n, and business names are shown as recorded.

export type AnswerLanguage = "en-US" | "zh-CN";
export type PartRef = { type: string; id: string; label: string };
export type FlagSpan = { text: string; kind: "number" | "date" | "name" | "record"; reason: string };
export type StatusTone = "danger" | "warning" | "success" | "info" | "neutral";
export type StatusValue = { code: string; tone?: StatusTone };
export type ValueUnit = "count" | "quantity" | "money" | "percent" | "days";
export type AppRoute = { moduleId: string; query?: Record<string, string> };

// A part of an answer as the stream builds it: text grows with each delta and
// carries its flags and the records the server found it names; a UI part
// arrives whole.
export type AnswerPart =
  | { id: string; type: "text"; text: string; flags?: FlagSpan[]; refs?: PartRef[] }
  | { id: string; type: "ui"; component: string; schemaVersion?: number; props: unknown; refs?: PartRef[] };

export type MoneyCell = { amount: number | null; currency: string };
export type TableCell = string | number | null | PartRef | MoneyCell | StatusValue;
export type TableColumnKind = "text" | "number" | "quantity" | "money" | "percent" | "days" | "date" | "status" | "ref";
export type TableProps = {
  title?: string;
  source?: string;
  columns: { code: string; kind: TableColumnKind }[];
  rows: Record<string, TableCell>[];
  total: number;
  more: boolean;
  listRoute?: AppRoute;
};

export type Figure = { code: string; value: number | null; unit: ValueUnit; currency?: string; unitLabel?: string };
export type RecordCardsProps = {
  source?: string;
  emphasis?: "overdue" | "pending" | "info";
  cards: {
    ref: PartRef;
    title?: string;
    status?: StatusValue;
    date?: { kind: "overdue" | "due" | "waiting" | "on"; days?: number; value?: string };
    figures?: Figure[];
  }[];
};

export type ChartProps = {
  source?: string;
  kind: "line" | "bar" | "stacked_bar";
  title?: string;
  x: { code: string; values: string[] };
  series: { code: string; name?: string; values: (number | null)[] }[];
  unit: ValueUnit;
  currency?: string;
  reportRoute?: AppRoute;
};

export type KpiTilesProps = {
  source?: string;
  tiles: { code: string; value: number | null; unit: ValueUnit; currency?: string; hidden?: boolean; route?: AppRoute }[];
};

export type ChoicesProps = { source?: string; promptCode: "pick_item" | "pick_supplier" | "pick_record"; options: PartRef[] };
export type FollowupsProps = { questions: string[] };

// link "new": an active supplier of the workspace the item has not approved
// yet; Create adds it as an approved supplier of the item first. Its lead
// time and price are then the ones the user typed, or null.
export type SupplierLink = "new";
export type ApprovedSupplier = { id: string; name: string; preferred: boolean; leadTimeDays?: number | null; unitPrice?: number | null; currency?: string | null; link?: SupplierLink };
export type PriceValue = { value: number | null; currency: string | null; source: "reference_price" | "masked" | "missing" };
export type PrFormRow = {
  item: { id: string; sku: string; name: string; unit?: string | null };
  onHand?: number | null;
  safetyStock?: number | null;
  reorderPoint?: number | null;
  suggestedQuantity: { value: number | null; source: "user_named" | "reorder_gap" | "reorder_gap_raised_to_moq" | "cover_days" | "cover_days_raised_to_moq" | "none"; minimum?: number | null; coverDays?: number };
  supplier: { id: string; name: string; source: "preferred" | "only_approved" | "user_named"; link?: SupplierLink } | null;
  suppliers?: ApprovedSupplier[];
  needByDate: { value: string; source: "lead_time" | "user_named" | "today"; leadTimeDays?: number | null; shortWeekOf?: string | null };
  orderByDate?: string | null;
  estimatedUnitPrice: PriceValue;
  warehouse?: { id: string; label: string } | null;
  covered: { ref: PartRef } | null;
  checked: boolean;
};
export type PrFormProps = {
  formId: string;
  source?: string;
  suggested: PrFormRow[];
  lines: PrFormRow[];
  canCreate: boolean;
  departmentId?: string;
  // The user may add approved suppliers to items: the form offers the
  // workspace's other active suppliers, priced by default in workspaceCurrency
  // when a supplier records no currency.
  canLinkSuppliers?: boolean;
  workspaceCurrency?: string;
};
// The request a form created, as the procurement routes return it.
// addedSupplierLinks: the item-supplier links this form created before the
// request, reported with it so the server can say they were added.
export type PrReceipt = { id: string; version: number; status: string; addedSupplierLinks?: string[] };

// The first-day checklist (setup_steps), as Today shows it.
export type SetupStepId = "items" | "suppliers" | "customers" | "opening_stock" | "teammates";
export type SetupStep = { id: SetupStepId; done: boolean; count: number; blocked?: "permission" | "unavailable"; route?: AppRoute };
export type SetupStepsProps = {
  source?: string;
  steps: SetupStep[];
  done: number;
  total: number;
  gaps?: { checked: number; unit: number; preferredSupplier: number; thresholds: number };
};

// The setup card (setup_form): rows the user typed or pasted, each value with
// where it came from and what the server found wrong with the row.
export type SetupValueSource = "user_typed" | "not_given" | "generated" | "default";
export type SetupText = { value: string | null; source: SetupValueSource };
export type SetupNumber = { value: number | null; source: SetupValueSource };
export type SetupProblem = { field: string; code: string; blocking: boolean; ref?: PartRef };
export type SetupSupplierRow = {
  key: string;
  name: SetupText;
  code: SetupText;
  contact: SetupText;
  email: SetupText;
  phone: SetupText;
  paymentTerms: { value: string | null; label: string | null; typed: string | null; source: SetupValueSource };
  problems: SetupProblem[];
};
export type SetupItemRow = {
  key: string;
  sku: SetupText;
  name: SetupText;
  unit: SetupText;
  category: SetupText;
  safetyStock: SetupNumber;
  reorderPoint: SetupNumber;
  referencePrice: SetupNumber;
  leadTimeDays: SetupNumber;
  currency: { value: string | null; source: SetupValueSource };
  preferredSupplier: { supplierId: string | null; rowKey: string | null; name: string | null; typed: string | null; source: SetupValueSource };
  problems: SetupProblem[];
};
export type SetupFormProps = {
  formId: string;
  suppliers: SetupSupplierRow[];
  items: SetupItemRow[];
  codeSeed: { prefix: string; next: number; width: number };
  paymentTerms: { code: string; label: string }[];
  supplierOptions: { id: string; name: string; currency?: string | null }[];
  workspaceCurrency: string;
  canCreateSuppliers: boolean;
  canCreateItems: boolean;
};
// The record card (record_actions): a purchase request or purchase order as
// stored, the steps on it the user's role permits (allowed) and those its
// status admits now (actions). The card works out the steps again after each
// click from the shared rules (shared/assistant-record-actions.mjs).
export type RecordActionCode = "submit" | "approve" | "reject" | "create_rfq" | "create_po" | "issue";
export type RecordActionType = "purchase_request" | "purchase_order";
export type ActionRecord = {
  ref: PartRef;
  type: RecordActionType;
  status: string;
  version: number;
  suppliers: string[];
  lines: { sku: string | null; name: string; quantity: number | null; unit: string | null }[];
  lineCount: number;
  amount?: MoneyCell;
};
export type RecordPath = { recommendation: "direct_po" | "rfq"; reasons: string[] };
export type RecordActionsProps = {
  cardId: string;
  source?: string;
  record: ActionRecord;
  allowed: RecordActionCode[];
  actions: RecordActionCode[];
  path?: RecordPath;
  poBlocked?: "lines_incomplete";
};
// What a card's clicks did: each step taken, with the records it created,
// and the record as it now stands. type and id say which record, for the
// next question's report.
export type RecordActionStep = { actionId: string; action: RecordActionCode; created: PartRef[] };
export type RecordActionReceipt = { type: RecordActionType; id: string; status: string; version: number; steps: RecordActionStep[]; sourced?: boolean };

// What one row of a setup card came to: the record it created (an item also
// with its supplier link, when it has a supplier), or why it failed.
export type SetupRowResult =
  | { status: "created"; type: "supplier" | "item"; id: string; label: string; linked?: boolean; linkError?: string }
  | { status: "failed"; error: string };
export type SetupReceipt = { results: Record<string, SetupRowResult> };
