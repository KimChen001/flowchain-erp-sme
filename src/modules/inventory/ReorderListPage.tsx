import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ChevronDown, ClipboardList, RefreshCw } from "lucide-react";
import { A, Card, Chip, Modal, inputStyle } from "../../components/ui";
import { ExportButton, rowActionClass } from "../../components/ui/listLayout";
import { exportRowsToCsv } from "../../lib/data-export";
import { apiJson } from "../../lib/api-client";
import { apiErrorText } from "../../lib/apiErrorText";
import { PREFILL_LINES_MAX, prefillLineValue } from "../../lib/prefill";
import { formatQuantity } from "../../lib/format";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { listTableCardsRef } from "../../components/ui/workbenchTable";
import { ListPager, useMediaQuery, usePagedRows } from "../procurement/listPaging";
import { useMasterDataWriteAccess } from "../master-data/writeAccess";
import { useReorderListCopy, type ReorderListCopyKey } from "./reorderListCopy";

// The items to reorder, ranked by the day each one's stock position is
// expected to reach its recorded reorder point (GET /api/inventory/reorder-list,
// server/domain/reorder-list.mjs). Every row prints its inputs so a person can
// check the date. One action opens a prefilled purchase request; nothing is
// ordered from here. Beside the recorded reorder point each row shows a
// suggested one (server/domain/reorder-point-suggestion.mjs); a person with
// item rights may set it on the item after confirming, and nothing else
// changes it. Where the workspace runs the forecast service
// (tools/forecast-service), a TimesFM line under it gives the model's figure
// for the same days, loaded after the list; the confirm dialog offers either.

type Flag = { code: string; orderNumber?: string | null; unit?: string; dueDay?: string; count?: number };
type Supplier = { id: string; code: string; name: string; leadTimeDays: number | null; leadTimeFrom?: "supplier" | "item" | null; minimumOrderQuantity: number | null; moqFrom?: "supplier" | "item" | null; moqUnit: string | null };
type Suggestion = {
  suggestedReorderPoint: number | null;
  reason: "stock_unit_not_recorded" | "not_enough_history" | "lead_time_not_recorded" | null;
  coverDays: number | null;
  leadTimeDays: number | null;
  reviewDays: number;
  historyDays: number;
  windowCount: number;
  rank: number;
  shipmentDays: number;
  minShipmentDays: number;
  recordedBelow: boolean;
};
// The model's suggestion for the same days and target
// (GET /api/inventory/reorder-list/forecast, server/domain/reorder-point-forecast.mjs).
type Forecast = {
  reorderPoint: number | null;
  reason: "no_history_suggestion" | "not_enough_history" | "forecast_unavailable" | null;
  model: string;
  coverDays: number | null;
  periods: number;
  historyDays: number;
};
type ForecastState = "off" | "loading" | "ready" | "unavailable";
type ReorderRow = {
  itemId: string;
  sku: string;
  itemName: string;
  unit: string;
  orderByDate: string;
  orderNow: boolean;
  daysUntilOrderBy: number;
  onHand: number;
  reserved: number;
  incoming: number;
  // On order but not committed, and asked for: pending purchase orders and
  // open purchase requests; and backorders (design audit C2).
  requested?: number;
  backorders?: number;
  requests?: { number: string; status: string }[];
  pendingLines?: { orderNumber: string | null; status: string | null; remaining: number }[];
  position: number;
  reorderPoint: number;
  shortfall: number;
  demand: { averageDailyDemand: number | null; shipmentDays: number; shippedQuantity: number; windowDays: number; enough: boolean };
  supplier: Supplier | null;
  flags: Flag[];
  purchaseRequest: { itemId: string; supplierId: string | null; quantity: number | null; raisedToMinimum?: boolean };
  reorderPointSuggestion?: Suggestion;
  // The level the request orders up to (design audit C3): recorded on the
  // item, assumed (reorder point plus reviewDays of demand) or the reorder
  // point; and the item's lot size.
  orderUpTo?: { level: number | null; source: "recorded" | "assumed" | "reorder_point" | null; reviewDays: number };
  lotSize?: number | null;
};
type ItemRef = { itemId: string; sku: string; itemName: string };
// An item with no reorder point, with what a suggestion for it needs (L3-09).
type NoPointItem = ItemRef & { unit?: string | null; leadTimeDays?: number | null; reorderPointSuggestion?: Suggestion };
type NotChecked = ItemRef & { reason: "stock_incomplete" | "stock_unit_not_recorded" | "warehouse_scope" };
type ReorderList = {
  today: string;
  timeZone: string;
  scope: { kind: "all_warehouses" | "reader_warehouses"; warehouseCount: number | null; totalWarehouseCount: number | null };
  rule: { windowDays: number; minShipmentDays: number };
  rows: ReorderRow[];
  notJudged: NotChecked[];
  noReorderPoint: { count: number; href: string; items: NoPointItem[] };
  summary: { listed: number; orderNow: number; notJudged: number; noReorderPoint: number; aboveReorderPointWithoutHistory: number };
  suppliers: { id: string; code: string; name: string }[];
  truncatedSubjects?: { subject: string; limit: number }[];
  forecastAvailable?: boolean;
};
type ForecastReply = { forecast: { status: "ok" | "unavailable" }; rows: { itemId: string; reorderPointForecast: Forecast }[] };

// Rows drawn at a time; the ranking, the supplier filter and the total cover
// every row.
const PAGE_SIZE = 50;
const NO_SUPPLIER = "__none__";
const NOT_CHECKED_SECTIONS: { reason: NotChecked["reason"]; title: ReorderListCopyKey; body: ReorderListCopyKey }[] = [
  { reason: "warehouse_scope", title: "checkScopeTitle", body: "checkScopeBody" },
  { reason: "stock_unit_not_recorded", title: "checkNoUnitTitle", body: "checkNoUnitBody" },
  { reason: "stock_incomplete", title: "checkStockIncompleteTitle", body: "checkStockIncompleteBody" },
];
const SUBJECT_KEYS: Record<string, ReorderListCopyKey> = {
  items: "subjectItems",
  shipment_lines: "subjectShipmentLines",
  purchase_orders: "subjectPurchaseOrders",
  inventory_items: "subjectStockBalances",
  sales_orders: "subjectSalesOrders",
};
const STOCK_COLUMNS = ["colOnHand", "colReserved", "colIncoming", "colRequested", "colBackorders", "colPosition"] as const;
// Phones (below 640 px, the list card breakpoint in theme.css) draw the six
// stock quantities as one block of two columns without a column label.
const STOCK_BLOCK = "stock" as const;

// Dense cells, so a row stays within about 90 px and the eleven columns fit a
// 1440 px window: the four stock quantities are short numbers under one-word
// headers and take the least room.
const cell = "px-1.5 py-2";
const stockCell = "px-1 py-2";
const firstCell = "pl-3 pr-1.5 py-2";
const lastCell = "pl-1.5 pr-3 py-2";
const small = "text-[11px] leading-4";

// A workspace calendar day (YYYY-MM-DD) in the interface locale. The day is
// already the workspace's, so it is formatted as a date, not an instant.
function formatDay(day: string, locale: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(locale || "en-US", { timeZone: "UTC", dateStyle: "medium" }).format(date);
  } catch {
    return day;
  }
}

// A day in the list's own year without the year ("Nov 9", "11月9日"); any
// other day in full.
function formatShortDay(day: string, today: string, locale: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || day.slice(0, 4) !== String(today).slice(0, 4)) return formatDay(day, locale);
  try {
    return new Intl.DateTimeFormat(locale || "en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(date);
  } catch {
    return day;
  }
}

// Daily demand is an average: one decimal reads better than four ("10.0444").
const oneDecimal = (value: number | null | undefined) => (value === null || value === undefined ? value : Math.round(value * 10) / 10);
// A quantity with its unit. Given the interface language, the unit shows as
// its label in that language ("28 pcs", "28 件"); without one it stays as
// stored.
const withUnit = (value: number | null | undefined, unit: string | null, language?: string) => (value === null || value === undefined ? "—" : `${formatQuantity(value)}${unit ? ` ${language ? unitLabel(unit, language, value) : unit}` : ""}`);

function flagText(flag: Flag, t: ReturnType<typeof useReorderListCopy>, locale: string, today: string) {
  const hidden = !flag.orderNumber;
  const byCode: Record<string, () => string> = {
    po_line_other_unit: () => t(hidden ? "poOtherUnitHidden" : "poOtherUnit", { po: flag.orderNumber || "", unit: flag.unit || "" }),
    po_line_late: () => t(hidden ? "poLateHidden" : "poLate", { po: flag.orderNumber || "", day: flag.dueDay ? formatShortDay(flag.dueDay, today, locale) : "" }),
    po_line_no_due_day: () => t(hidden ? "poNoDueDayHidden" : "poNoDueDay", { po: flag.orderNumber || "" }),
    po_line_unit_not_recorded: () => t("poUnitNotRecorded"),
    shipment_other_unit: () => t.count("shipmentOtherUnit", flag.count ?? 0, { unit: flag.unit || "" }),
    shipment_unit_not_recorded: () => t.count("shipmentUnitNotRecorded", flag.count ?? 0),
    purchase_unit_differs: () => t("purchaseUnitDiffers", { unit: flag.unit || "" }),
    request_line_other_unit: () => t.count("requestOtherUnit", flag.count ?? 0),
  };
  return (byCode[flag.code] || (() => flag.code))();
}

// The purchase request form, prefilled from the row (shared/purchase-request-prefill.mjs).
// Without a shortfall in the request line's unit the quantity is left for the
// person to enter. A shortfall raised to the supplier's minimum order says so
// (quantityFrom=supplier_minimum) and hands over the shortfall too, so the
// form labels the quantity as the supplier's minimum, not as the shortfall.
function purchaseRequestHref(row: ReorderRow, reason: string) {
  const params = new URLSearchParams({ itemId: row.purchaseRequest.itemId, origin: "reorder_list", reason });
  if (row.purchaseRequest.quantity !== null) params.set("quantity", String(row.purchaseRequest.quantity));
  if (row.purchaseRequest.quantity !== null && row.purchaseRequest.raisedToMinimum) {
    params.set("quantityFrom", "supplier_minimum");
    params.set("shortfall", String(row.shortfall));
  }
  if (row.purchaseRequest.supplierId) params.set("suppliers", row.purchaseRequest.supplierId);
  return `/app/procurement/requests?${params.toString()}`;
}

// Several rows in one purchase request (design audit L3-24): the form opens
// with one line per row, each planned as the single-row link plans it (its
// supplier, its quantity and, when raised to the minimum, its shortfall).
// One row opens exactly as its own link does.
function batchRequestHref(rows: ReorderRow[], reason: string, singleReason: (row: ReorderRow) => string) {
  if (rows.length === 1) return purchaseRequestHref(rows[0], singleReason(rows[0]));
  const params = new URLSearchParams({ origin: "reorder_list", reason });
  for (const row of rows) {
    params.append("line", prefillLineValue({
      itemId: row.purchaseRequest.itemId || row.itemId,
      quantity: row.purchaseRequest.quantity,
      supplierId: row.purchaseRequest.supplierId,
      shortfall: row.purchaseRequest.quantity !== null && row.purchaseRequest.raisedToMinimum ? row.shortfall : null,
    }));
  }
  return `/app/procurement/requests?${params.toString()}`;
}

// The rows whose suggested reorder point can be adopted: a suggestion above
// 0 that differs from the recorded point.
const adoptable = (row: ReorderRow) => {
  const value = row.reorderPointSuggestion?.suggestedReorderPoint ?? null;
  return value !== null && value > 0 && value !== row.reorderPoint;
};

// Confirm, then set each selected item's reorder point to its suggestion,
// one item update after another (PATCH /api/master-data/items/:id, versioned
// and audited), as the single "Set reorder point" does (#263: nothing changes
// before the person confirms). A recorded order-up-to level the new point
// reaches is said, since the list then assumes a level (design audit C3).
function AdoptSuggestionsDialog({ rows, t, onClose, onDone }: { rows: ReorderRow[]; t: Copy; onClose: () => void; onDone: (count: number) => void }) {
  const [done, setDone] = useState<number | null>(null);
  const [failures, setFailures] = useState<{ sku: string; message: string }[]>([]);
  const running = done !== null && done < rows.length;
  const save = async () => {
    const failed: { sku: string; message: string }[] = [];
    let saved = 0;
    for (const [index, row] of rows.entries()) {
      setDone(index);
      const value = row.reorderPointSuggestion?.suggestedReorderPoint as number;
      try {
        const path = `/api/master-data/items/${encodeURIComponent(row.itemId)}`;
        const { item } = await apiJson<{ item: { version?: number } }>(path);
        await apiJson(path, { method: "PATCH", body: JSON.stringify({ reorderPoint: value, baseUnit: row.unit, expectedVersion: item?.version ?? 1 }) });
        saved += 1;
      } catch (cause) {
        failed.push({ sku: row.sku, message: apiErrorText(cause, t.language, ["Could not be saved.", "保存失败。"]) });
      }
    }
    setDone(rows.length);
    setFailures(failed);
    if (!failed.length) onDone(saved);
    else if (saved) onDone(saved);
  };
  return (
    <Modal
      open
      onClose={running ? () => {} : onClose}
      width={520}
      title={t.count("adoptTitle", rows.length)}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={running} className="rounded-md px-3 py-2 text-xs">{failures.length ? t("close") : t("dialogCancel")}</button>
          {!failures.length && (
            <button type="button" onClick={save} disabled={running} data-testid="reorder-adopt-confirm" className="rounded-md px-3 py-2 text-xs font-semibold text-white disabled:opacity-60" style={{ background: A.blue }}>
              {running ? t("adoptProgress", { done: (done ?? 0) + 1, n: rows.length }) : t.count("adoptConfirm", rows.length)}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-xs leading-5" data-testid="reorder-adopt-dialog">
        <p>{t("adoptIntro")}</p>
        <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="reorder-adopt-rows">
          {rows.map((row) => {
            const value = row.reorderPointSuggestion?.suggestedReorderPoint as number;
            const level = row.orderUpTo?.source === "recorded" ? row.orderUpTo.level : null;
            return (
              <li key={row.itemId} data-testid={`reorder-adopt-row-${row.sku}`}>
                <span className="font-semibold">{t("adoptRow", { sku: row.sku, current: withUnit(row.reorderPoint, row.unit, t.language), suggested: withUnit(value, row.unit, t.language) })}</span>
                {level !== null && level <= value && <div style={{ color: A.orange }} data-testid={`reorder-adopt-level-${row.sku}`}>{t("adoptLevelNote", { level: withUnit(level, row.unit, t.language) })}</div>}
              </li>
            );
          })}
        </ul>
        {failures.length > 0 && (
          <div role="alert" style={{ color: A.red }} data-testid="reorder-adopt-failures">
            <p>{t.count("adoptFailures", failures.length)}</p>
            <ul>{failures.map((failure) => <li key={failure.sku}>{failure.sku}: {failure.message}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

const itemHref = (itemId: string) => `/app/master-data/items/${encodeURIComponent(itemId)}`;

type Copy = ReturnType<typeof useReorderListCopy>;
const NO_SUGGESTION: Record<string, ReorderListCopyKey> = {
  stock_unit_not_recorded: "noSuggestionUnit",
  lead_time_not_recorded: "noSuggestionLeadTime",
  not_enough_history: "noSuggestionHistory",
};

// A row's model suggestion, when the service gave one.
const forecastValue = (forecast?: Forecast) => (forecast && forecast.reorderPoint !== null && forecast.reorderPoint > 0 ? forecast.reorderPoint : null);

// The suggested reorder point under the recorded one, in orange when the
// recorded value is below it (said in words to screen readers). Why it is that
// number is in the tooltip; it is printed on the row only when the row does
// not follow the rule printed above the table. Under it, the TimesFM
// forecast for the same days when there is one. The button only opens the
// confirm dialog.
function SuggestedReorderPoint({ row, forecast, t, canSet, followsRule, onSet }: { row: ReorderRow; forecast?: Forecast; t: Copy; canSet: boolean; followsRule: boolean; onSet: () => void }) {
  const suggestion = row.reorderPointSuggestion;
  if (!suggestion) return null;
  if (suggestion.suggestedReorderPoint === null) {
    return <div className={small} style={{ color: A.sub }} data-testid="reorder-suggestion">{t(NO_SUGGESTION[suggestion.reason || ""] || "noSuggestionHistory", { min: suggestion.minShipmentDays })}</div>;
  }
  const modelValue = forecastValue(forecast);
  const differs = (value: number | null) => value !== null && value > 0 && value !== row.reorderPoint;
  const why = t("suggestionWhy", { days: suggestion.coverDays ?? 0 });
  const detail = t("suggestionDetail", { lead: suggestion.leadTimeDays ?? 0, review: suggestion.reviewDays, days: suggestion.coverDays ?? 0, windows: suggestion.windowCount, rank: suggestion.rank, history: suggestion.historyDays });
  return (
    <>
      <div
        className={`whitespace-nowrap text-[12px] leading-[18px] ${suggestion.recordedBelow ? "font-semibold" : "font-medium"}`}
        style={{ color: suggestion.recordedBelow ? A.orange : A.sub }}
        data-testid="reorder-suggestion"
        title={t("suggestionTooltip", { why, detail })}
      >
        {t("suggested", { value: withUnit(suggestion.suggestedReorderPoint, row.unit, t.language) })}
        {suggestion.recordedBelow && <span className="sr-only" data-testid="reorder-below-suggestion">{` (${t("belowSuggestion")})`}</span>}
      </div>
      {!followsRule && <div className={small} style={{ color: A.sub }}>{why}</div>}
      {forecast && modelValue !== null && (
        <div
          className="whitespace-nowrap text-[12px] font-medium leading-[18px]"
          style={{ color: A.sub }}
          data-testid="reorder-forecast"
          title={t("forecastTooltip", { days: forecast.coverDays ?? 0, periods: forecast.periods })}
        >
          {t("forecastLine", { value: withUnit(modelValue, row.unit, t.language) })}
        </div>
      )}
      {canSet && (differs(suggestion.suggestedReorderPoint) || differs(modelValue)) && (
        <button type="button" onClick={onSet} data-testid={`reorder-set-point-${row.sku}`} className={`${small} whitespace-nowrap font-medium hover:underline max-sm:-my-1.5 max-sm:py-1.5 max-sm:text-[12px]`} style={{ color: A.blue }}>
          {t("setReorderPoint")}
        </button>
      )}
    </>
  );
}

// Confirm, then set the item's reorder point through the item update command
// (PATCH /api/master-data/items/:id: versioned and audited). Only the reorder
// point changes; the stock unit the list read is sent back as it is, so an
// item whose unit is recorded only in its metadata keeps it.
function SetReorderPointDialog({ row, forecast, t, onClose, onSaved }: { row: ReorderRow; forecast?: Forecast; t: Copy; onClose: () => void; onSaved: (value: number) => void }) {
  const suggestion = row.reorderPointSuggestion as Suggestion;
  const modelValue = forecastValue(forecast);
  const [value, setValue] = useState(String(suggestion.suggestedReorderPoint ?? ""));
  // With a model forecast the person picks which suggestion fills the field (or types another number).
  const choices = modelValue === null || suggestion.suggestedReorderPoint === null
    ? []
    : [
        { key: "dialogUseSuggested" as const, amount: suggestion.suggestedReorderPoint, testId: "reorder-set-point-use-suggested" },
        { key: "dialogUseForecast" as const, amount: modelValue, testId: "reorder-set-point-use-forecast" },
      ];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const next = Number(value);
    if (!value.trim() || !Number.isFinite(next) || next <= 0) {
      setError(t("dialogInvalid"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const path = `/api/master-data/items/${encodeURIComponent(row.itemId)}`;
      const { item } = await apiJson<{ item: { version?: number } }>(path);
      await apiJson(path, { method: "PATCH", body: JSON.stringify({ reorderPoint: next, baseUnit: row.unit, expectedVersion: item?.version ?? 1 }) });
      onSaved(next);
    } catch (cause: any) {
      setError(t("dialogError", { message: cause?.message || "" }));
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={t("dialogTitle", { sku: row.sku })}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-xs">{t("dialogCancel")}</button>
          <button type="button" onClick={save} disabled={saving} data-testid="reorder-set-point-confirm" className="rounded-md px-3 py-2 text-xs font-semibold text-white disabled:opacity-60" style={{ background: A.blue }}>
            {saving ? t("dialogSaving") : t("dialogConfirm")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs leading-5" data-testid="reorder-set-point-dialog">
        <p>{row.reorderPoint > 0 ? t("dialogCurrent", { value: withUnit(row.reorderPoint, row.unit, t.language) }) : t("dialogCurrentNone")}</p>
        <p>{t("dialogSuggested", { value: withUnit(suggestion.suggestedReorderPoint, row.unit, t.language), days: suggestion.coverDays ?? 0, lead: suggestion.leadTimeDays ?? 0, review: suggestion.reviewDays, history: suggestion.historyDays })}</p>
        {forecast && modelValue !== null && (
          <p data-testid="reorder-set-point-forecast">{t("dialogForecast", { value: withUnit(modelValue, row.unit, t.language), days: forecast.coverDays ?? 0, periods: forecast.periods })}</p>
        )}
        {choices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <button
                key={choice.key}
                type="button"
                onClick={() => setValue(String(choice.amount))}
                aria-pressed={value === String(choice.amount)}
                data-testid={choice.testId}
                className="rounded-md border px-2.5 py-1 text-xs font-medium"
                style={{ borderColor: value === String(choice.amount) ? A.blue : A.border, color: value === String(choice.amount) ? A.blue : undefined }}
              >
                {t(choice.key, { value: withUnit(choice.amount, row.unit, t.language) })}
              </button>
            ))}
          </div>
        )}
        <label className="block">
          <span className="font-semibold">{t("dialogField", { unit: unitLabel(row.unit, t.language) })}</span>
          <input type="number" min="0" step="any" value={value} onChange={(event) => setValue(event.target.value)} className="mt-1" style={inputStyle} data-testid="reorder-set-point-value" />
        </label>
        <p style={{ color: A.sub }}>{t("dialogNote")}</p>
        {error && <p role="alert" style={{ color: A.red }}>{error}</p>}
      </div>
    </Modal>
  );
}

export default function ReorderListPage() {
  const t = useReorderListCopy();
  const { locale } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [list, setList] = useState<ReorderList | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [setting, setSetting] = useState<ReorderRow | null>(null);
  // The rows ticked for one request or for adopting suggestions, by item.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [adopting, setAdopting] = useState<ReorderRow[] | null>(null);
  const [saved, setSaved] = useState("");
  const [forecasts, setForecasts] = useState<Record<string, Forecast>>({});
  const [forecastState, setForecastState] = useState<ForecastState>("off");
  const canSetReorderPoint = useMasterDataWriteAccess().items;
  const phone = useMediaQuery("(max-width: 639.98px)");
  // On a phone the method text folds behind "How this is worked out", so the
  // first item shows on the first screen; wider screens always show it.
  const [methodOpen, setMethodOpen] = useState(false);
  const showMethod = !phone || methodOpen;
  const supplierFilter = searchParams.get("supplier") || "";
  // A search by SKU or item name (design audit L3-24), kept in the address.
  const query = searchParams.get("q") || "";

  // The list first; then, where the workspace has a forecast service, the
  // TimesFM line, so the list never waits for the model.
  const loadForecasts = () => {
    setForecastState("loading");
    apiJson<ForecastReply>("/api/inventory/reorder-list/forecast")
      .then((reply) => {
        setForecasts(Object.fromEntries(reply.rows.map((row) => [row.itemId, row.reorderPointForecast])));
        setForecastState(reply.forecast.status === "ok" ? "ready" : "unavailable");
      })
      .catch(() => setForecastState("unavailable"));
  };
  const load = () => {
    setState("loading");
    setSelected(new Set());
    apiJson<ReorderList>("/api/inventory/reorder-list")
      .then((payload) => {
        setList(payload);
        setState("ready");
        if (payload.forecastAvailable) loadForecasts();
        else setForecastState("off");
      })
      .catch((error: any) => setState(error?.status === 409 || error?.code === "REORDER_LIST_NOT_AVAILABLE" ? "unavailable" : "error"));
  };
  useEffect(load, []);

  const rows = useMemo(() => {
    const all = list?.rows || [];
    const needle = query.trim().toLowerCase();
    const bySupplier = !supplierFilter ? all : supplierFilter === NO_SUPPLIER ? all.filter((row) => !row.supplier) : all.filter((row) => row.supplier?.id === supplierFilter);
    return needle ? bySupplier.filter((row) => row.sku.toLowerCase().includes(needle) || (row.itemName || "").toLowerCase().includes(needle)) : bySupplier;
  }, [list, supplierFilter, query]);
  // Every row the search and supplier filter show, ranked as on the page,
  // with the figures the columns show; numbers stay numbers, dates days.
  const exportRows = () => void exportRowsToCsv("reorder-list-export.csv", rows.map((row) => ({
    [t("colOrderBy")]: row.orderByDate,
    [t("exportDaysLeft")]: row.daysUntilOrderBy,
    [t("orderNow")]: row.orderNow ? "✓" : "",
    [t("exportSku")]: row.sku,
    [t("colItem")]: row.itemName,
    [t("exportUnit")]: row.unit,
    [t("colOnHand")]: row.onHand,
    [t("colReserved")]: row.reserved,
    [t("colIncoming")]: row.incoming,
    [t("colRequested")]: row.requested ?? 0,
    [t("colBackorders")]: row.backorders ?? 0,
    [t("colPosition")]: row.position,
    [t("colReorderPoint")]: row.reorderPoint,
    [t("colDemand")]: row.demand.averageDailyDemand ?? "",
    [t("colShortfall")]: row.shortfall,
    [t("exportSuggested")]: row.purchaseRequest.quantity ?? "",
    [t("colSupplier")]: row.supplier ? `${row.supplier.name}${row.supplier.code ? ` (${row.supplier.code})` : ""}` : "",
  })), list?.timeZone);
  // One page of the ranked rows; a new supplier filter or search starts at page 1.
  const { page, pageRows, setPage } = usePagedRows(rows, PAGE_SIZE, `${supplierFilter}|${query}`);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const setSupplierFilter = (value: string) => setParam("supplier", value);
  // An item with no reorder point opens the same dialog, as a row whose
  // recorded reorder point is none (L3-09).
  const noPointRow = (item: NoPointItem) => ({ ...item, unit: item.unit || "", reorderPoint: 0 }) as unknown as ReorderRow;

  // The ticked rows in rank order, across pages and filters.
  const selectedRows = (list?.rows || []).filter((row) => selected.has(row.itemId));
  const pageIds = pageRows.map((row) => row.itemId);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (ids: string[], on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  });
  const adoptableRows = canSetReorderPoint ? selectedRows.filter(adoptable) : [];
  const singleReason = (row: ReorderRow) => t("reason", { position: withUnit(row.position, row.unit, t.language), reorderPoint: withUnit(row.reorderPoint, row.unit, t.language), date: row.orderByDate });
  const batchReason = t("reasonMany", { n: selectedRows.length, date: selectedRows.map((row) => row.orderByDate).filter(Boolean).sort()[0] || "" });
  const total = list?.scope.totalWarehouseCount ?? list?.scope.warehouseCount ?? 0;
  const scopeLabel = list?.scope.kind === "reader_warehouses" ? t.count("scopeReader", list.scope.warehouseCount ?? 0, { total }) : t("scopeAll");
  const truncated = (list?.truncatedSubjects || []).map((entry) => t(SUBJECT_KEYS[entry.subject] || "subjectOther"));
  const stockColumns: readonly (ReorderListCopyKey | typeof STOCK_BLOCK)[] = phone ? [STOCK_BLOCK] : STOCK_COLUMNS;
  const columns: (ReorderListCopyKey | typeof STOCK_BLOCK)[] = ["colOrderBy", "colItem", ...stockColumns, "colReorderPoint", "colDemand", "colShortfall", "colSupplier", "colAction"];
  // The review days and history the rule above the table states. A row whose
  // suggestion uses these, over the lead time its supplier cell prints, needs
  // no sentence of its own.
  const ruleReviewDays = list?.rows.find((row) => row.reorderPointSuggestion)?.reorderPointSuggestion?.reviewDays ?? 7;
  const followsRule = (row: ReorderRow) => {
    const suggestion = row.reorderPointSuggestion;
    return !suggestion || (suggestion.reviewDays === ruleReviewDays && suggestion.historyDays === list?.rule.windowDays && suggestion.leadTimeDays === row.supplier?.leadTimeDays);
  };

  return (
    <div className="space-y-4" data-testid="reorder-list-page">
      <div className="flex items-start justify-between gap-4">
        {/* The page title above already says "Reorder list"; this line explains it. */}
        <p className="max-w-3xl text-xs leading-5" style={{ color: A.sub }}>{t("subtitle")}</p>
        <button onClick={load} aria-label={t("refresh")} className="rounded-md p-2" style={{ color: A.blue }}>
          <RefreshCw size={16} />
        </button>
      </div>

      {state === "loading" && <Card className="p-8 text-sm" style={{ color: A.sub }}>{t("loading")}</Card>}
      {state === "error" && <Card className="p-8 text-sm" style={{ color: A.red }}>{t("error")}</Card>}
      {state === "unavailable" && <Card className="p-8 text-sm" style={{ color: A.sub }}>{t("notAvailable")}</Card>}

      {state === "ready" && list && (
        <>
          <Card className="space-y-2 p-4 text-xs leading-5" data-testid="reorder-list-rules">
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="reorder-list-scope"><Chip label={scopeLabel} color={A.blue} bg="#eef5ff" /></span>
              {phone && (
                <button
                  type="button"
                  onClick={() => setMethodOpen((open) => !open)}
                  aria-expanded={methodOpen}
                  aria-controls="reorder-list-method"
                  data-testid="reorder-list-method-toggle"
                  className="inline-flex items-center gap-1 py-1 font-semibold max-sm:min-h-9"
                  style={{ color: A.blue }}
                >
                  {t("methodToggle")}
                  <ChevronDown size={14} aria-hidden className={methodOpen ? "rotate-180" : undefined} />
                </button>
              )}
            </div>
            {showMethod && (
              <div id="reorder-list-method" className="space-y-2" data-testid="reorder-list-method">
                <p style={{ color: A.sub }}>{t("rule", { window: list.rule.windowDays, min: list.rule.minShipmentDays })}</p>
                <p style={{ color: A.sub }} data-testid="reorder-list-horizon">{t("horizon")}</p>
                <p style={{ color: A.sub }}>{t("units")}</p>
                {list.rows.some((row) => row.orderUpTo) && (
                  <p style={{ color: A.sub }} data-testid="reorder-list-order-up-to-rule">{t("orderUpToRule", { days: list.rows.find((row) => row.orderUpTo)?.orderUpTo?.reviewDays ?? 7 })}</p>
                )}
                {list.rows.some((row) => row.reorderPointSuggestion) && (
                  <p style={{ color: A.sub }} data-testid="reorder-list-suggestion-rule">{t("suggestionRule", { review: ruleReviewDays, window: list.rule.windowDays })}</p>
                )}
                {forecastState !== "off" && (
                  <p style={{ color: forecastState === "unavailable" ? A.orange : A.sub }} data-testid="reorder-list-forecast-rule">
                    {forecastState === "loading"
                      ? t("forecastLoading")
                      : forecastState === "unavailable"
                        ? t("forecastUnavailable")
                        : t("forecastRule", { review: ruleReviewDays, window: list.rule.windowDays })}
                  </p>
                )}
              </div>
            )}
            {saved && <p data-testid="reorder-list-saved" style={{ color: A.green }}>{saved}</p>}
            {truncated.length > 0 && (
              <p data-testid="reorder-list-truncated" style={{ color: A.orange }}>{t("truncated", { subjects: truncated.join(", ") })}</p>
            )}
            {list.noReorderPoint.count > 0 && (
              <div data-testid="reorder-list-no-reorder-point">
                <p>{t.count("noReorderPoint", list.noReorderPoint.count)}</p>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {list.noReorderPoint.items.map((item) => {
                    // A suggested reorder point to set from here (L3-09).
                    const suggested = item.reorderPointSuggestion?.suggestedReorderPoint ?? null;
                    return (
                      <li key={item.itemId} className="max-sm:inline-flex max-sm:items-center max-sm:gap-1">
                        <Link to={itemHref(item.itemId)} className="font-semibold max-sm:inline-flex max-sm:min-h-9 max-sm:items-center" style={{ color: A.blue }}>{item.sku}</Link>
                        {suggested !== null && suggested > 0 && (
                          <span data-testid={`reorder-no-point-suggestion-${item.sku}`} style={{ color: A.sub }}>
                            {" "}({t("noPointSuggested", { value: withUnit(suggested, item.unit || "", t.language) })}
                            {canSetReorderPoint && (
                              <>
                                {" · "}
                                <button type="button" onClick={() => setSetting(noPointRow(item))} data-testid={`reorder-set-point-${item.sku}`} className="font-medium hover:underline max-sm:min-h-9" style={{ color: A.blue }}>{t("setReorderPoint")}</button>
                              </>
                            )}
                            )
                          </span>
                        )}
                      </li>
                    );
                  })}
                  {list.noReorderPoint.count > list.noReorderPoint.items.length && (
                    <li>
                      <Link to={list.noReorderPoint.href} className="max-sm:inline-flex max-sm:min-h-9 max-sm:items-center" style={{ color: A.blue }}>{t("noReorderPointMore", { n: list.noReorderPoint.count - list.noReorderPoint.items.length })}</Link>
                    </li>
                  )}
                </ul>
              </div>
            )}
            {list.summary.aboveReorderPointWithoutHistory > 0 && (
              <p style={{ color: A.sub }}>{t.count("aboveWithoutHistory", list.summary.aboveReorderPointWithoutHistory)}</p>
            )}
          </Card>

          {list.rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{t("search")}</span>
              <input
                type="search"
                data-testid="reorder-list-search"
                value={query}
                placeholder={t("searchPlaceholder")}
                onChange={(event) => setParam("q", event.target.value)}
                className="rounded-md border px-2 py-1 max-sm:h-9"
                style={{ borderColor: A.border }}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{t("supplierFilter")}</span>
              <select
                data-testid="reorder-list-supplier-filter"
                value={supplierFilter}
                onChange={(event) => setSupplierFilter(event.target.value)}
                className="rounded-md border px-2 py-1 max-sm:h-9"
                style={{ borderColor: A.border }}
              >
                <option value="">{t("allSuppliers")}</option>
                {list.suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
                <option value={NO_SUPPLIER}>{t("noSupplier")}</option>
              </select>
            </label>
            {/* The rows shown, in a spreadsheet, as on the other lists. */}
            <span data-testid="reorder-list-export"><ExportButton onClick={exportRows} /></span>
            </div>
          )}

          {selectedRows.length > 0 && (
            <Card className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-xs" data-testid="reorder-selection">
              <span className="font-semibold" data-testid="reorder-selection-count">{t.count("selectedCount", selectedRows.length)}</span>
              {selectedRows.length > PREFILL_LINES_MAX ? (
                <span style={{ color: A.orange }}>{t("batchRequestTooMany", { max: PREFILL_LINES_MAX })}</span>
              ) : (
                <Link to={batchRequestHref(selectedRows, batchReason, singleReason)} data-testid="reorder-batch-request" className={`${rowActionClass.primary} inline-block whitespace-nowrap !no-underline`}>
                  {t.count("batchRequest", selectedRows.length)}
                </Link>
              )}
              {adoptableRows.length > 0 && (
                <button type="button" onClick={() => setAdopting(adoptableRows)} data-testid="reorder-batch-adopt" className={`${rowActionClass.neutral} whitespace-nowrap`}>
                  {t("batchAdopt", { n: adoptableRows.length })}
                </button>
              )}
              <button type="button" onClick={() => setSelected(new Set())} data-testid="reorder-selection-clear" className="font-medium hover:underline" style={{ color: A.blue }}>
                {t("clearSelection")}
              </button>
            </Card>
          )}

          {rows.length === 0 ? (
            <Card className="p-10 text-center" data-testid="reorder-list-empty">
              <ClipboardList className="mx-auto mb-3" size={28} color={A.gray2} />
              <div className="text-sm font-semibold">{list.rows.length ? t("filteredEmpty") : t("emptyTitle")}</div>
              {!list.rows.length && list.scope.kind === "all_warehouses" && <p className="mt-2 text-xs" style={{ color: A.sub }}>{t("emptyBody")}</p>}
              {!list.rows.length && list.notJudged.length > 0 && <p className="mt-1 text-xs" style={{ color: A.sub }}>{t.count("emptyNotChecked", list.notJudged.length)}</p>}
            </Card>
          ) : (
            <Card>
              {/* The body holds the table and its pager, as ListCard's does: a new page scrolls back to the card's top. */}
              <div ref={listTableCardsRef}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1240px] text-xs">
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                        {columns.map((key, index) => (
                          <th key={key} className={`${index === 0 ? firstCell : index === columns.length - 1 ? lastCell : (STOCK_COLUMNS as readonly string[]).includes(key) ? stockCell : cell} !py-2.5 text-left align-bottom`} data-card-title={key === "colItem" ? "" : undefined}>
                            {index === 0 ? (
                              <label className="inline-flex items-center gap-1.5">
                                <input type="checkbox" checked={pageAllSelected} onChange={(event) => toggle(pageIds, event.target.checked)} aria-label={t("selectPage")} data-testid="reorder-select-page" />
                                {t(key as ReorderListCopyKey)}
                              </label>
                            ) : key === STOCK_BLOCK ? null : t(key)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row) => {
                        // The request's reason, in the interface language with its unit labels ("23 pcs", "23 件").
                        const reason = t("reason", { position: withUnit(row.position, row.unit, t.language), reorderPoint: withUnit(row.reorderPoint, row.unit, t.language), date: row.orderByDate });
                        const stock: [ReorderListCopyKey, number][] = [["colOnHand", row.onHand], ["colReserved", row.reserved], ["colIncoming", row.incoming], ["colRequested", row.requested ?? 0], ["colBackorders", row.backorders ?? 0], ["colPosition", row.position]];
                        // The requests and pending orders already asking for the item, by number (L1-11).
                        const requestedDocs = [...(row.requests || []).map((request) => request.number), ...(row.pendingLines || []).map((line) => line.orderNumber).filter(Boolean)];
                        const supplier = row.supplier;
                        const leadTimeText = supplier && (supplier.leadTimeDays === null ? t("leadTimeNotRecorded") : t.count("leadTimeShort", supplier.leadTimeDays));
                        // A lead time recorded on the item, not the supplier link, says so (L3-08).
                        const leadTime = leadTimeText && supplier?.leadTimeFrom === "item" ? t("fromItem", { text: leadTimeText }) : leadTimeText;
                        const moq = supplier && (supplier.minimumOrderQuantity === null
                          ? t("moqNotRecorded")
                          : t(supplier.moqUnit ? "moq" : "moqNoUnit", { n: formatQuantity(supplier.minimumOrderQuantity), unit: unitLabel(supplier.moqUnit, t.language, supplier.minimumOrderQuantity) }));
                        return (
                          <tr key={row.itemId} data-testid={`reorder-row-${row.sku}`} style={{ borderBottom: `1px solid ${A.border}` }} className="align-top">
                            <td className={`${firstCell} whitespace-nowrap`} data-testid="reorder-order-by">
                              <div className="max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-2">
                                <label className="inline-flex items-center gap-1.5 font-semibold max-sm:min-h-9">
                                  <input type="checkbox" checked={selected.has(row.itemId)} onChange={(event) => toggle([row.itemId], event.target.checked)} aria-label={t("selectRow", { sku: row.sku })} data-testid={`reorder-select-${row.sku}`} />
                                  {formatDay(row.orderByDate, locale)}
                                </label>
                                {row.orderNow ? (
                                  <span className="mt-0.5 inline-block max-sm:mt-0"><Chip label={t("orderNow")} color={A.orange} bg="#fff4e8" /></span>
                                ) : (
                                  <div className={small} style={{ color: A.sub }}>{row.daysUntilOrderBy === 0 ? t("today") : row.daysUntilOrderBy === 1 ? t("inOneDay") : t("inDays", { n: row.daysUntilOrderBy })}</div>
                                )}
                              </div>
                            </td>
                            <td className={cell}>
                              {/* Wide enough for a late purchase order note on two lines. */}
                              <div className="sm:w-[12.5rem]">
                                <div className="font-semibold">{row.sku}</div>
                                <div className="text-[12px] leading-[18px]" style={{ color: A.sub }}>{row.itemName}</div>
                                {row.flags.length > 0 && (
                                  <ul className={`mt-0.5 space-y-0.5 ${small}`} data-testid="reorder-flags">
                                    {row.flags.map((flag, index) => <li key={`${flag.code}-${index}`} style={{ color: A.orange }}>{flagText(flag, t, locale, list.today)}</li>)}
                                  </ul>
                                )}
                                {requestedDocs.length > 0 && (
                                  <div className={`mt-0.5 ${small}`} style={{ color: A.sub }} data-testid="reorder-requested">{t("alreadyRequested", { docs: requestedDocs.join(", ") })}</div>
                                )}
                              </div>
                            </td>
                            {phone ? (
                              <td className={cell}>
                                <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                  {stock.map(([key, value]) => (
                                    <div key={key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                                      <dt style={{ color: A.sub }}>{t(key)}</dt>
                                      <dd className={key === "colPosition" ? "font-semibold" : undefined}>{withUnit(value, row.unit, t.language)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </td>
                            ) : (
                              stock.map(([key, value]) => (
                                <td key={key} className={`${stockCell} whitespace-nowrap${key === "colPosition" ? " font-semibold" : ""}`}>{withUnit(value, row.unit, t.language)}</td>
                              ))
                            )}
                            <td className={cell} data-testid="reorder-point">
                              {/* Recorded, then suggested: stacked in the table, on one line on a phone. */}
                              <div className="max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-1.5">
                                <div className="whitespace-nowrap">{withUnit(row.reorderPoint, row.unit, t.language)}</div>
                                <SuggestedReorderPoint row={row} forecast={forecasts[row.itemId]} t={t} canSet={canSetReorderPoint} followsRule={followsRule(row)} onSet={() => setSetting(row)} />
                              </div>
                            </td>
                            <td className={cell} data-testid="reorder-demand">
                              {row.demand.enough ? (
                                <div className="max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-1.5" title={t.count("demandDays", row.demand.shipmentDays, { window: row.demand.windowDays })}>
                                  <div className="whitespace-nowrap">{t("perDay", { value: withUnit(oneDecimal(row.demand.averageDailyDemand), row.unit, t.language) })}</div>
                                  <div className={`${small} whitespace-nowrap`} style={{ color: A.sub }}>{t.count("demandDaysShort", row.demand.shipmentDays, { window: row.demand.windowDays })}</div>
                                </div>
                              ) : (
                                <div className={small} style={{ color: A.sub }}>{t.count("notEnoughHistory", row.demand.shipmentDays)}</div>
                              )}
                            </td>
                            <td className={`${cell} whitespace-nowrap`}>{withUnit(row.shortfall, row.unit, t.language)}</td>
                            <td className={cell} data-testid="reorder-supplier">
                              {supplier ? (
                                <>
                                  {/* The name (two lines at most at 1440 px; the whole name in its tooltip), then lead time and MOQ. */}
                                  <div className="line-clamp-2 font-semibold" title={supplier.name}>{supplier.name}</div>
                                  <div className={small} style={{ color: A.sub }} title={`${supplier.leadTimeDays === null ? t("leadTimeNotRecorded") : t.count("leadTime", supplier.leadTimeDays)} · ${moq}`}>
                                    <span className="whitespace-nowrap">{leadTime}</span> · <span className="whitespace-nowrap">{moq}</span>
                                  </div>
                                </>
                              ) : (
                                <span style={{ color: A.sub }}>{t("notRecorded")}</span>
                              )}
                            </td>
                            <td className={lastCell}>
                              <Link
                                to={purchaseRequestHref(row, reason)}
                                data-testid={`reorder-create-request-${row.sku}`}
                                className={`${rowActionClass.primary} inline-block whitespace-nowrap !no-underline max-sm:px-3 max-sm:py-1.5 max-sm:text-[12px]`}
                              >
                                {t("createRequest")}
                              </Link>
                              {/* The level the request's quantity orders up to, and where it comes from (C3): an assumed level says so. */}
                              {row.purchaseRequest.quantity !== null && row.orderUpTo?.level != null && (
                                <div className={`mt-1 max-w-[9.25rem] ${small}`} style={{ color: A.sub }} data-testid={`reorder-order-up-to-${row.sku}`}>
                                  {t(row.orderUpTo.source === "recorded" ? "orderUpToRecorded" : row.orderUpTo.source === "assumed" ? "orderUpToAssumed" : "orderUpToPoint", { level: withUnit(oneDecimal(row.orderUpTo.level), row.unit, t.language), days: row.orderUpTo.reviewDays })}
                                  {row.lotSize ? `, ${t("inLots", { lot: withUnit(row.lotSize, row.unit, t.language) })}` : ""}
                                </div>
                              )}
                              {/* The quantity the request opens with, when the shortfall is raised to the supplier's minimum. */}
                              {row.purchaseRequest.raisedToMinimum && row.purchaseRequest.quantity !== null && (
                                <div className={`mt-1 max-w-[9.25rem] ${small}`} style={{ color: A.sub }} data-testid={`reorder-order-minimum-${row.sku}`}>
                                  {t("orderMinimum", { n: formatQuantity(row.purchaseRequest.quantity), unit: unitLabel(row.unit, t.language, row.purchaseRequest.quantity) })}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <ListPager page={page} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} testId="reorder-list-pager" />
              </div>
            </Card>
          )}

          {NOT_CHECKED_SECTIONS.map((section) => {
            const items = list.notJudged.filter((row) => row.reason === section.reason);
            if (!items.length) return null;
            const body = section.reason === "warehouse_scope" ? t.count("checkScopeBody", list.scope.warehouseCount ?? 0, { total }) : t(section.body);
            return (
              <Card key={section.reason} className="p-4 text-xs" data-testid={`reorder-list-not-checked-${section.reason}`}>
                <div className="font-semibold">{t(section.title)}</div>
                <p className="mt-1" style={{ color: A.sub }}>{body}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {items.map((row) => (
                    <li key={row.itemId} className="rounded-md px-2 py-1" style={{ background: A.gray6 }}>
                      <Link to={itemHref(row.itemId)} className="max-sm:inline-flex max-sm:min-h-9 max-sm:items-center" style={{ color: A.blue }}>{row.sku}</Link> · {row.itemName}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </>
      )}

      {adopting && (
        <AdoptSuggestionsDialog
          rows={adopting}
          t={t}
          onClose={() => setAdopting(null)}
          onDone={(count) => {
            setSaved(t.count("adoptedNotice", count));
            if (count === adopting.length) setAdopting(null);
            load();
          }}
        />
      )}
      {setting && (
        <SetReorderPointDialog
          row={setting}
          forecast={forecasts[setting.itemId]}
          t={t}
          onClose={() => setSetting(null)}
          onSaved={(value) => {
            setSaved(t("savedNotice", { sku: setting.sku, value: withUnit(value, setting.unit, t.language) }));
            setSetting(null);
            load();
          }}
        />
      )}
    </div>
  );
}
