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

export type ApprovedSupplier = { id: string; name: string; preferred: boolean; leadTimeDays?: number | null; unitPrice?: number | null; currency?: string | null };
export type PriceValue = { value: number | null; currency: string | null; source: "reference_price" | "masked" | "missing" };
export type PrFormRow = {
  item: { id: string; sku: string; name: string; unit?: string | null };
  onHand?: number | null;
  safetyStock?: number | null;
  reorderPoint?: number | null;
  suggestedQuantity: { value: number | null; source: "user_named" | "reorder_gap" | "reorder_gap_raised_to_moq"; minimum?: number | null };
  supplier: { id: string; name: string; source: "preferred" | "only_approved" | "user_named" } | null;
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
};
// The request a form created, as the procurement routes return it.
export type PrReceipt = { id: string; version: number; status: string };
