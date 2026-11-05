import { useState, type ReactNode } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import { overrideNeeded } from "../../../../../shared/supplier-override-reasons.mjs";
import { A } from "../../../../components/ui";
import { businessEntityRouteRegistry } from "../../../../components/business/businessEntityRoutes";
import { isTranslationKey } from "../../../../i18n/I18n";
import { ApiError, apiJson } from "../../../../lib/api-client";
import { todayInTimeZone } from "../../../../lib/format";
import { addCalendarDays, buildSuggestionTrail, type PrefillEntry } from "../../../../lib/prefill";
import { useWarehouseNames } from "../../../../lib/useWarehouseNames";
import { structuredDraftTarget } from "../../../action-drafts/structuredDraftHandoff";
import { RefChip, StatusPill, cardStyle, toneStyle, usePartCopy, type Navigate, type PartCopy } from "./partKit";
import type { ApprovedSupplier, PriceValue, PrFormProps, PrFormRow, PrReceipt } from "./types";

// The in-chat purchase request form (docs/ai-assistant-v2-design.md §4.1).
// Every value comes from the server with where it came from; nothing is
// ticked for the user unless they named the item. The user's own session
// creates the draft through the same route as the classic form, and
// submitting is a second, separate click because it emails the approvers.

export type FormLine = {
  key: string;
  origin: "suggested" | "named" | "added";
  row: PrFormRow;
  checked: boolean;
  allowCovered: boolean;
  quantity: string;
  supplierId: string;
  needByDate: string;
  needByEdited: boolean;
};
type Block = "quantity" | "supplier" | "override" | "price";
type CatalogItem = { itemId?: string; id?: string; sku: string; itemName?: string; name?: string; purchaseUnit?: string; baseUnit?: string; defaultWarehouseId?: string };
export type ItemSupplier = { id: string; name?: string; supplierName?: string; preferred?: boolean; referencePrice?: number | string | null; currency?: string | null; leadTimeDays?: number | string | null; restrictedFields?: string[] };

const TEAL_TEXT = "#0F766E";
const ORANGE = toneStyle("warning");
const REQUEST_ROUTE = businessEntityRouteRegistry.purchase_request.listRouteId;

function lineOf(row: PrFormRow, origin: FormLine["origin"], partId: string): FormLine {
  return {
    // Stable per form and item, so a retried create sends the same payload.
    key: `ai-${partId}-${row.item.id}`,
    origin,
    row,
    checked: origin !== "suggested" && row.checked && !row.covered,
    allowCovered: false,
    quantity: row.suggestedQuantity.value === null ? "" : String(row.suggestedQuantity.value),
    supplierId: row.supplier?.id || "",
    needByDate: row.needByDate.value,
    needByEdited: false,
  };
}

const supplierOptions = (row: PrFormRow): ApprovedSupplier[] =>
  row.suppliers?.length ? row.suppliers : row.supplier ? [{ id: row.supplier.id, name: row.supplier.name, preferred: row.supplier.source === "preferred", leadTimeDays: row.needByDate.leadTimeDays ?? null }] : [];

// The master-data reference price of the line's supplier; never a model value.
function priceOf(line: FormLine): PriceValue {
  const { row } = line;
  if (row.supplier && line.supplierId === row.supplier.id) return row.estimatedUnitPrice;
  const option = supplierOptions(row).find((supplier) => supplier.id === line.supplierId);
  if (!option || option.unitPrice === null || option.unitPrice === undefined) return { value: null, currency: null, source: row.estimatedUnitPrice.source === "masked" ? "masked" : "missing" };
  return { value: option.unitPrice, currency: option.currency || row.estimatedUnitPrice.currency, source: "reference_price" };
}

function leadTimeOf(line: FormLine) {
  const option = supplierOptions(line.row).find((supplier) => supplier.id === line.supplierId);
  return option?.leadTimeDays ?? (line.row.supplier?.id === line.supplierId ? line.row.needByDate.leadTimeDays ?? null : null);
}

function blockOf(line: FormLine): Block | null {
  if (!(Number(line.quantity) > 0)) return "quantity";
  if (!line.supplierId) return "supplier";
  // A supplier other than the preferred one needs a reason, which only the full form asks for.
  if (overrideNeeded({ supplierId: line.supplierId, preferredIds: supplierOptions(line.row).filter((supplier) => supplier.preferred).map((supplier) => supplier.id) })) return "override";
  if (priceOf(line).value === null) return "price";
  return null;
}

// The form's lines as they first show: lines for the items the user named
// (ticked as the server sent them), then the suggestions, never ticked.
export function initialFormLines(props: PrFormProps, partId: string): FormLine[] {
  const named = new Set(props.lines.map((row) => row.item.id));
  return [...props.lines.map((row) => lineOf(row, "named", partId)), ...props.suggested.filter((row) => !named.has(row.item.id)).map((row) => lineOf(row, "suggested", partId))];
}

// What "Create draft request" posts: the classic form's body
// (CanonicalProcurementPanel.tsx) for the ticked lines, one idempotency key
// per form, and the trail of which values were suggested and kept.
export function draftRequestBody(ticked: FormLine[], props: PrFormProps, ids: { threadId: string; messageId: string; partId: string }) {
  const prefills: Record<string, PrefillEntry> = {};
  const values: Record<string, string> = {};
  const suggested = (field: string, source: PrefillEntry["source"], value: string, submitted: string) => {
    prefills[field] = { source, ...(props.source ? { ref: props.source } : {}), value };
    values[field] = submitted;
  };
  const lines = ticked.map((line, index) => {
    const price = priceOf(line);
    const quantity = Number(line.quantity);
    const { row } = line;
    if (row.suggestedQuantity.value !== null && row.suggestedQuantity.source !== "user_named") suggested(`lines.${index}.quantity`, "record", String(row.suggestedQuantity.value), line.quantity);
    if (row.supplier && row.supplier.source !== "user_named") suggested(`lines.${index}.supplierId`, "default", row.supplier.id, line.supplierId);
    if (row.needByDate.source !== "user_named") suggested(`lines.${index}.needByDate`, "default", row.needByDate.value, line.needByDate);
    if (row.estimatedUnitPrice.value !== null) suggested(`lines.${index}.estimatedUnitPrice`, "default", String(row.estimatedUnitPrice.value), String(price.value));
    if (row.warehouse) suggested(`lines.${index}.targetWarehouseId`, "default", row.warehouse.id, row.warehouse.id);
    return {
      lineId: line.key,
      sourceType: "catalog_item",
      lineBasis: "quantity",
      itemId: row.item.id,
      sku: row.item.sku,
      supplierId: line.supplierId,
      itemNameSnapshot: row.item.name,
      unitSnapshot: row.item.unit || "",
      specificationSnapshot: "",
      commodityId: "",
      quantity,
      estimatedUnitPrice: price.value,
      estimatedAmount: quantity * Number(price.value),
      currency: price.currency || undefined,
      targetWarehouseId: row.warehouse?.id || "",
      needByDate: line.needByDate,
      serviceStartDate: "",
      serviceEndDate: "",
      internalLineComment: "",
      supplierOverride: null,
    };
  });
  return {
    departmentId: props.departmentId || "operations",
    defaultCurrency: ticked.map((line) => priceOf(line).currency).find(Boolean) || undefined,
    defaultNeedByDate: ticked.map((line) => line.needByDate).sort()[0],
    lines,
    // One key per form: a second click, or a retry after a lost answer, creates nothing new.
    idempotencyKey: `ai-form:${ids.threadId}:${ids.messageId}:${ids.partId}`,
    suggestionTrail: buildSuggestionTrail({ origin: "ai_assistant", prefills, values }) || { origin: "ai_assistant", fields: [] },
  };
}

function errorText(error: unknown, copy: PartCopy) {
  // Server messages are not shown: the domain's are Chinese-only. Codes are worded here.
  const key = `ai.v2.error.${error instanceof ApiError ? error.code || "" : ""}`;
  return isTranslationKey(key) ? copy.t(key) : copy.t("ai.v2.error.generic");
}

const chipStyle = { background: "#F0FDFA", color: TEAL_TEXT };
const Chip = ({ children, style = chipStyle, testId }: { children: ReactNode; style?: { background: string; color: string }; testId?: string }) =>
  <span data-testid={testId} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4" style={style}>{children}</span>;
const SourceChip = ({ children }: { children: ReactNode }) => <Chip testId="ai-v2-pr-source">{children}</Chip>;
const linkClass = "text-[13px] font-medium hover:underline disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "w-full rounded-lg px-2 py-1.5 text-[13px]";
const inputStyle = { border: `1px solid ${A.gray4}`, background: A.white, color: A.label };

function primaryButton(label: string, disabled: boolean, onClick: () => void, testId: string) {
  return <button type="button" data-testid={testId} data-primary="true" onClick={onClick} disabled={disabled} className="inline-flex min-h-9 items-center rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{ background: A.blue }}>{label}</button>;
}

function ItemSearch({ copy, exclude, onAdd }: { copy: PartCopy; exclude: Set<string>; onAdd: (item: CatalogItem) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  // The classic form's item list: purchasable items the user may read.
  const load = () => {
    if (items || state === "loading") return;
    setState("loading");
    apiJson<{ items: CatalogItem[] }>("/api/master-data/items?purchasable=true")
      .then((result) => { setItems(result.items || []); setState("idle"); })
      .catch(() => setState("failed"));
  };
  const needle = query.trim().toLowerCase();
  const matches = needle && items
    ? items.filter((item) => !exclude.has(item.itemId || item.id || "") && [item.sku, item.itemName, item.name].some((value) => String(value || "").toLowerCase().includes(needle))).slice(0, 6)
    : [];
  return (
    <div data-testid="ai-v2-pr-search" className="space-y-1">
      <label className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: A.label }}>
        <Plus size={13} aria-hidden />
        {copy.t("ai.v2.form.search")}
      </label>
      <input type="search" value={query} onFocus={load} onChange={(event) => { load(); setQuery(event.target.value); }} placeholder={copy.t("ai.v2.form.searchPlaceholder")} aria-label={copy.t("ai.v2.form.search")} className={inputClass} style={inputStyle} />
      {needle ? (
        <ul className="space-y-0.5 text-[13px]">
          {state === "loading" ? <li style={{ color: A.sub }}>{copy.t("ai.v2.form.searchLoading")}</li>
            : state === "failed" ? <li role="alert" style={{ color: toneStyle("danger").color }}>{copy.t("ai.v2.form.searchFailed")}</li>
            : !matches.length ? <li style={{ color: A.sub }}>{copy.t("ai.v2.form.searchEmpty")}</li>
            : matches.map((item) => (
              <li key={item.itemId || item.id}>
                <button type="button" onClick={() => { setQuery(""); onAdd(item); }} className="w-full rounded-md px-2 py-1 text-left hover:bg-blue-50">
                  <span className="font-semibold" style={{ color: A.blue }}>{item.sku}</span> <span style={{ color: A.label }}>{item.itemName || item.name}</span>
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

// A recorded number, or null. The item suppliers read sends the reference
// price as a string ("0.42"), as the classic form's prefill expects.
function recordedNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// An item the user added from the search, filled from its approved sources
// (GET /api/master-data/items/:id/suppliers) the same way the classic form fills a line.
export function addedFormRow(item: CatalogItem, sources: ItemSupplier[], today: string): PrFormRow {
  const itemId = item.itemId || item.id || "";
  const suppliers: ApprovedSupplier[] = sources.map((source) => {
    const lead = recordedNumber(source.leadTimeDays);
    const price = recordedNumber(source.referencePrice);
    return {
      id: source.id,
      name: source.name || source.supplierName || source.id,
      preferred: Boolean(source.preferred),
      leadTimeDays: lead !== null && Number.isInteger(lead) && lead >= 0 ? lead : null,
      unitPrice: price !== null && price >= 0 ? price : null,
      currency: source.currency || null,
    };
  });
  const preferred = suppliers.filter((supplier) => supplier.preferred);
  // One preferred source, or the only approved one; several preferred leave the choice to the user.
  const chosen = preferred.length === 1 ? preferred[0] : !preferred.length && suppliers.length === 1 ? suppliers[0] : null;
  const masked = sources.some((source) => source.restrictedFields?.includes("referencePrice"));
  const lead = chosen?.leadTimeDays ?? null;
  return {
    item: { id: itemId, sku: item.sku, name: item.itemName || item.name || "", unit: item.purchaseUnit || item.baseUnit || null },
    suggestedQuantity: { value: null, source: "user_named" },
    supplier: chosen ? { id: chosen.id, name: chosen.name, source: chosen.preferred ? "preferred" : "only_approved" } : null,
    suppliers,
    needByDate: { value: lead === null ? today : addCalendarDays(today, lead), source: lead === null ? "today" : "lead_time", leadTimeDays: lead },
    estimatedUnitPrice: chosen && chosen.unitPrice !== null && chosen.unitPrice !== undefined ? { value: chosen.unitPrice, currency: chosen.currency || null, source: "reference_price" } : { value: null, currency: null, source: masked ? "masked" : "missing" },
    warehouse: item.defaultWarehouseId ? { id: item.defaultWarehouseId, label: item.defaultWarehouseId } : null,
    covered: null,
    checked: true,
  };
}

async function addedRow(item: CatalogItem, timezone: string): Promise<PrFormRow> {
  const itemId = item.itemId || item.id || "";
  let sources: ItemSupplier[] = [];
  try {
    sources = (await apiJson<{ suppliers: ItemSupplier[] }>(`/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`)).suppliers || [];
  } catch {
    sources = [];
  }
  return addedFormRow(item, sources, todayInTimeZone(timezone));
}

export function PurchaseRequestFormPart({ props, partId, threadId, messageId, language, onNavigate, receipt: initialReceipt = null, onReceipt }: {
  props: PrFormProps;
  partId: string;
  threadId: string;
  messageId: string;
  language?: string;
  onNavigate?: Navigate;
  // The request this form already created, when an earlier answer is shown again.
  receipt?: PrReceipt | null;
  onReceipt?: (receipt: PrReceipt) => void;
}) {
  const copy = usePartCopy(language);
  const warehouseName = useWarehouseNames();
  const [lines, setLines] = useState<FormLine[]>(() => initialFormLines(props, partId));
  const [receipt, setReceipt] = useState<PrReceipt | null>(initialReceipt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = (key: string, patch: Partial<FormLine>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  const chooseSupplier = (line: FormLine, supplierId: string) => {
    const lead = supplierOptions(line.row).find((supplier) => supplier.id === supplierId)?.leadTimeDays;
    // A date the user asked for or changed is kept; otherwise it follows the new supplier's lead time.
    const followsLead = !line.needByEdited && line.row.needByDate.source !== "user_named" && lead !== null && lead !== undefined;
    const needByDate = followsLead ? addCalendarDays(todayInTimeZone(copy.timezone), lead) : line.needByDate;
    update(line.key, { supplierId, needByDate });
  };
  const addItem = async (item: CatalogItem) => {
    const row = await addedRow(item, copy.timezone);
    setLines((current) => current.some((line) => line.row.item.id === row.item.id) ? current : [...current, lineOf(row, "added", partId)]);
  };

  const ticked = lines.filter((line) => line.checked);
  const blocks = [...new Set(ticked.map(blockOf).filter((block): block is Block => Boolean(block)))];
  const canAddAll = lines.some((line) => line.origin === "suggested" && !line.checked && !line.row.covered);
  const createDisabled = busy || !ticked.length || blocks.length > 0 || !props.canCreate;

  // The handoff carries one line: the one that turned Create off, when there is one.
  const handoffLine = ticked.find((line) => blockOf(line)) || ticked[0] || lines[0];
  const openFullForm = () => {
    if (!onNavigate || !handoffLine) return;
    const target = structuredDraftTarget("purchase_request_draft", { itemIdOrSku: handoffLine.row.item.sku, quantity: handoffLine.quantity, supplierId: handoffLine.supplierId, requestedDeliveryDate: handoffLine.needByDate }, "ai_assistant");
    onNavigate(target.moduleId, null, { returnTo: "ai", source: "ai", entityLabel: copy.t("ai.v2.form.title"), query: target.query });
  };

  const record = (next: PrReceipt) => {
    setReceipt(next);
    onReceipt?.(next);
  };

  const create = async () => {
    if (createDisabled) return;
    setBusy(true);
    setError("");
    try {
      const created = await apiJson<PrReceipt & { idempotentReplay?: boolean }>("/api/procurement/requests", { method: "POST", body: JSON.stringify(draftRequestBody(ticked, props, { threadId, messageId, partId })) });
      // A replay returns the request as it was first created; it may have been submitted or cancelled since.
      const current = created.idempotentReplay ? await apiJson<PrReceipt>(`/api/procurement/requests/${encodeURIComponent(created.id)}`) : created;
      record({ id: current.id || created.id, number: current.number || created.number, version: current.version, status: current.status || "draft" });
    } catch (failure) {
      setError(errorText(failure, copy));
    } finally {
      setBusy(false);
    }
  };

  const transition = async (action: "submit" | "cancel" | "withdraw") => {
    if (!receipt || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await apiJson<PrReceipt>(`/api/procurement/requests/${encodeURIComponent(receipt.id)}/${action}`, { method: "POST", body: JSON.stringify({ expectedVersion: receipt.version }) });
      record({ id: next.id || receipt.id, number: next.number || receipt.number, version: next.version, status: next.status || receipt.status });
    } catch (failure) {
      setError(errorText(failure, copy));
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error ? <p role="alert" data-testid="ai-v2-pr-error" className="text-[13px]" style={{ color: toneStyle("danger").color }}>{error}</p> : null;
  const secondary = (label: string, onClick: () => void, testId: string) =>
    <button type="button" data-testid={testId} onClick={onClick} disabled={busy} className={linkClass} style={{ color: A.blue }}>{label}</button>;

  if (receipt) {
    const chip = <RefChip value={{ type: "purchase_request", id: receipt.id, label: receipt.number || receipt.id }} onNavigate={onNavigate} />;
    const open = onNavigate ? secondary(copy.t("ai.v2.form.open"), () => onNavigate(REQUEST_ROUTE, { entityType: "purchase_request", entityId: receipt.id }, { returnTo: "ai", source: "ai", entityLabel: receipt.number || receipt.id }), "ai-v2-pr-open") : null;
    const draft = receipt.status === "draft";
    const submitted = receipt.status === "submitted" || receipt.status === "pending_approval";
    return (
      <section data-testid="ai-v2-pr-receipt" data-status={receipt.status} lang={copy.language} className="space-y-2 rounded-xl p-3 text-[13px]" style={cardStyle}>
        <p className="flex flex-wrap items-center gap-1.5" style={{ color: A.label }}>
          {chip}
          <span>{draft ? copy.t("ai.v2.form.createdDraft") : submitted ? copy.t("ai.v2.form.submittedNote") : receipt.status === "cancelled" ? copy.t("ai.v2.form.cancelledNote") : null}</span>
          {!draft && !submitted && receipt.status !== "cancelled" ? <StatusPill status={{ code: receipt.status }} copy={copy} /> : null}
        </p>
        {submitted ? <p data-testid="ai-v2-pr-emailed" style={{ color: A.sub }}>{copy.t("ai.v2.form.emailed")}</p> : null}
        {errorLine}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {draft ? primaryButton(busy ? copy.t("ai.v2.form.working") : copy.t("ai.v2.form.submit"), busy, () => void transition("submit"), "ai-v2-pr-submit") : null}
          {draft ? secondary(copy.t("ai.v2.form.cancelDraft"), () => void transition("cancel"), "ai-v2-pr-cancel") : null}
          {submitted ? secondary(copy.t("ai.v2.form.withdraw"), () => void transition("withdraw"), "ai-v2-pr-withdraw") : null}
          {submitted ? secondary(copy.t("ai.v2.form.cancelRequest"), () => void transition("cancel"), "ai-v2-pr-cancel") : null}
          {open}
        </div>
      </section>
    );
  }

  const createLabel = busy ? copy.t("ai.v2.form.working") : ticked.length === 1 ? copy.t("ai.v2.form.createOne") : copy.t("ai.v2.form.create", { count: ticked.length });
  return (
    <section data-testid="ai-v2-pr-form" data-form-id={props.formId} lang={copy.language} className="space-y-3 rounded-xl p-3 text-[13px]" style={cardStyle}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[14px] font-semibold" style={{ color: A.label }}>{copy.t("ai.v2.form.title")}</h4>
        {canAddAll ? <button type="button" data-testid="ai-v2-pr-add-all" onClick={() => setLines((current) => current.map((line) => line.origin === "suggested" && !line.row.covered ? { ...line, checked: true } : line))} className={linkClass} style={{ color: A.blue }}>{copy.t("ai.v2.form.addAll")}</button> : null}
      </div>
      {props.suggested.length ? <p style={{ color: A.sub }}>{copy.t("ai.v2.form.suggested")} · {copy.t("ai.v2.form.tickHint")}</p> : null}
      <ul className="space-y-2">
        {lines.map((line) => {
          const { row } = line;
          const covered = Boolean(row.covered) && !line.allowCovered;
          const price = priceOf(line);
          const lead = leadTimeOf(line);
          const options = supplierOptions(row);
          const unit = row.item.unit || "";
          // Where each field's value came from: the server's source while it is
          // unchanged, then "Edited", or "Your choice" where nothing was suggested.
          const quantitySource = !line.quantity ? ""
            : row.suggestedQuantity.value !== null && line.quantity === String(row.suggestedQuantity.value)
              ? copy.t(`ai.v2.form.source.${row.suggestedQuantity.source}`, { minimum: copy.number(row.suggestedQuantity.minimum ?? row.suggestedQuantity.value) })
              : copy.t(row.suggestedQuantity.value !== null ? "ai.v2.form.source.edited" : "ai.v2.form.source.chosen");
          const supplierSource = !line.supplierId ? ""
            : row.supplier && line.supplierId === row.supplier.id ? copy.t(`ai.v2.form.source.${row.supplier.source}`)
              : copy.t(row.supplier ? "ai.v2.form.source.edited" : "ai.v2.form.source.chosen");
          // A date that moved with a newly chosen supplier follows that supplier's lead time.
          const needByMoved = line.needByDate !== row.needByDate.value;
          const leadDays = needByMoved ? lead : row.needByDate.leadTimeDays ?? lead;
          const needBySource = line.needByEdited ? copy.t("ai.v2.form.source.edited")
            : needByMoved || row.needByDate.source === "lead_time" ? (leadDays !== null ? copy.t("ai.v2.form.leadTime", { days: copy.number(leadDays) }) : "")
              : copy.t(`ai.v2.form.source.${row.needByDate.source}`);
          const facts = [
            row.onHand !== undefined && row.onHand !== null ? copy.t("ai.v2.form.onHand", { value: copy.number(row.onHand) }) : "",
            row.safetyStock !== undefined && row.safetyStock !== null ? copy.t("ai.v2.form.safetyStock", { value: copy.number(row.safetyStock) }) : "",
            row.reorderPoint !== undefined && row.reorderPoint !== null ? copy.t("ai.v2.form.reorderPoint", { value: copy.number(row.reorderPoint) }) : "",
            line.origin === "suggested" && row.suggestedQuantity.value !== null ? copy.t("ai.v2.form.suggestedQuantity", { value: `${copy.number(row.suggestedQuantity.value)}${unit ? ` ${unit}` : ""}` }) : "",
            row.orderByDate ? copy.t("ai.v2.form.orderBy", { date: copy.day(row.orderByDate) }) : "",
          ].filter(Boolean);
          const shortSoon = Boolean(row.needByDate.shortWeekOf) && line.needByDate > String(row.needByDate.shortWeekOf);
          return (
            <li key={line.key} data-testid="ai-v2-pr-row" data-origin={line.origin} data-checked={line.checked ? "true" : "false"} data-covered={row.covered ? "true" : "false"} className="space-y-1.5 rounded-lg p-2" style={{ border: `1px solid ${A.gray5}` }}>
              <div className="flex items-start gap-2">
                <input type="checkbox" data-testid="ai-v2-pr-tick" checked={line.checked} disabled={covered} onChange={(event) => update(line.key, { checked: event.target.checked })} aria-label={copy.t("ai.v2.form.select", { sku: row.item.sku })} className="mt-1 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5">
                    <RefChip value={{ type: "item", id: row.item.id, label: row.item.sku }} onNavigate={onNavigate} />
                    <span className="min-w-0 truncate" style={{ color: A.label }}>{row.item.name}</span>
                  </div>
                  {facts.length ? <p className="mt-0.5 text-[12px]" style={{ color: A.sub }}>{facts.join(" · ")}</p> : null}
                  {row.covered ? (
                    <p data-testid="ai-v2-pr-covered" className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: ORANGE.color }}>
                      {copy.t("ai.v2.form.covered")} <RefChip value={row.covered.ref} onNavigate={onNavigate} />
                      {!line.allowCovered ? <button type="button" data-testid="ai-v2-pr-order-anyway" onClick={() => update(line.key, { allowCovered: true, checked: true })} className={linkClass} style={{ color: A.blue }}>{copy.t("ai.v2.form.orderAnyway")}</button> : null}
                    </p>
                  ) : null}
                </div>
                {line.origin === "added" ? <button type="button" onClick={() => setLines((current) => current.filter((other) => other.key !== line.key))} aria-label={copy.t("ai.v2.form.remove", { sku: row.item.sku })} className="p-0.5" style={{ color: A.gray1 }}><X size={14} /></button> : null}
              </div>
              {line.checked ? (
                <div data-testid="ai-v2-pr-line-fields" className="grid gap-2 pl-6">
                  <label data-testid="ai-v2-pr-field" data-field="quantity" className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.quantity")}{unit ? ` (${unit})` : ""}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <input type="number" min="0" step="any" inputMode="decimal" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} className={`${inputClass} max-w-[8rem]`} style={inputStyle} />
                      {quantitySource ? <SourceChip>{quantitySource}</SourceChip> : null}
                    </span>
                  </label>
                  <label data-testid="ai-v2-pr-field" data-field="supplier" className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.supplier")}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <select value={line.supplierId} onChange={(event) => chooseSupplier(line, event.target.value)} className={`${inputClass} max-w-[16rem]`} style={inputStyle}>
                        {!line.supplierId ? <option value="">{copy.t("ai.v2.form.pickSupplier")}</option> : null}
                        {options.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.preferred ? copy.t("ai.v2.form.preferred", { name: supplier.name }) : supplier.name}</option>)}
                      </select>
                      {supplierSource ? <SourceChip>{supplierSource}</SourceChip> : null}
                    </span>
                  </label>
                  <label data-testid="ai-v2-pr-field" data-field="needBy" className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.needBy")}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <input type="date" value={line.needByDate} onChange={(event) => update(line.key, { needByDate: event.target.value, needByEdited: true })} className={`${inputClass} max-w-[10rem]`} style={inputStyle} />
                      {needBySource ? <SourceChip>{needBySource}</SourceChip> : null}
                      {shortSoon ? <Chip testId="ai-v2-pr-short-week" style={ORANGE}><AlertTriangle size={11} aria-hidden />{copy.t("ai.v2.form.shortWeek", { date: copy.day(String(row.needByDate.shortWeekOf)) })}</Chip> : null}
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span data-testid="ai-v2-pr-field" data-field="price">
                      <span className="text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.price")} </span>
                      {price.value !== null
                        ? <><span className="tabular-nums" style={{ color: A.label }}>{copy.value(price.value, "money", price.currency)}</span> <SourceChip>{copy.t("ai.v2.form.referencePrice")}</SourceChip></>
                        : <span data-testid="ai-v2-pr-price-unavailable" style={{ color: ORANGE.color }}>{copy.t(price.source === "masked" ? "ai.v2.form.priceMasked" : "ai.v2.form.priceMissing")}</span>}
                    </span>
                    {row.warehouse ? <span data-testid="ai-v2-pr-field" data-field="warehouse"><span className="text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.warehouse")} </span><span style={{ color: A.label }}>{row.warehouse.label === row.warehouse.id ? warehouseName(row.warehouse.id) : row.warehouse.label}</span> <SourceChip>{copy.t("ai.v2.form.source.item_default")}</SourceChip></span> : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ItemSearch copy={copy} exclude={new Set(lines.map((line) => line.row.item.id))} onAdd={(item) => void addItem(item)} />
      {blocks.length ? <ul data-testid="ai-v2-pr-blocked" className="space-y-0.5 text-[12px]" style={{ color: ORANGE.color }}>{blocks.map((block) => <li key={block}>{copy.t(`ai.v2.form.blocked.${block}`)}</li>)}</ul> : null}
      {errorLine}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {primaryButton(createLabel, createDisabled, () => void create(), "ai-v2-pr-create")}
        {onNavigate ? secondary(copy.t("ai.v2.form.openFullForm"), openFullForm, "ai-v2-pr-open-full-form") : null}
        {onNavigate && ticked.length > 1 && handoffLine ? <span data-testid="ai-v2-pr-handoff-line" className="text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.openFullFormLine", { sku: handoffLine.row.item.sku })}</span> : null}
      </div>
    </section>
  );
}
