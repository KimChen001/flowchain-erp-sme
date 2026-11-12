import { useEffect, useState, type ReactNode, useRef } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import { SUPPLIER_OVERRIDE_REASONS, overrideNeeded, validateSupplierOverride } from "../../../../../shared/supplier-override-reasons.mjs";
import { A } from "../../../../components/ui";
import { businessEntityRouteRegistry } from "../../../../components/business/businessEntityRoutes";
import { SUPPLIER_OVERRIDE_COPY, supplierOverrideReasonLabel } from "../../../../components/procurement/SupplierOverrideReason";
import { isTranslationKey, type TranslationKey } from "../../../../i18n/I18n";
import { unitLabel } from "../../../../i18n/unitLabels";
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
//
// A supplier the item has not approved yet (link "new": one the user named,
// or picked from "Another supplier…" when their role may add approved
// suppliers) is added to the item as an approved supplier by the same click,
// before the request is created, with the price, currency and lead time the
// user gives on the line.

// The price, currency and lead time of a line's new supplier, as typed.
export type LinkTerms = { price: string; currency: string; leadTime: string };
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
  // Suppliers the user picked from "Another supplier…", each new to the item.
  added: ApprovedSupplier[];
  picking: boolean;
  terms: LinkTerms;
  // Why a new supplier is used instead of the item's preferred one.
  override: { reasonCode: string; note: string };
};
type Block = "quantity" | "supplier" | "override" | "reason" | "terms" | "price";
type CatalogItem = { itemId?: string; id?: string; sku: string; itemName?: string; name?: string; purchaseUnit?: string; baseUnit?: string; defaultWarehouseId?: string };
export type ItemSupplier = { id: string; name?: string; supplierName?: string; preferred?: boolean; referencePrice?: number | string | null; currency?: string | null; leadTimeDays?: number | string | null; restrictedFields?: string[] };
// A supplier as the Suppliers list sends it (GET /api/master-data/suppliers).
export type WorkspaceSupplier = { id: string; name?: string; supplierName?: string; status?: string; defaultCurrency?: string | null };

const TEAL_TEXT = "#0F766E";
const ORANGE = toneStyle("warning");
const REQUEST_ROUTE = businessEntityRouteRegistry.purchase_request.listRouteId;
const OTHER_SUPPLIER = "__other_supplier__";
const NO_REASON = { reasonCode: "", note: "" };

const termsFrom = (option?: ApprovedSupplier | null): LinkTerms => ({
  price: option?.unitPrice === null || option?.unitPrice === undefined ? "" : String(option.unitPrice),
  currency: option?.currency || "",
  leadTime: option?.leadTimeDays === null || option?.leadTimeDays === undefined ? "" : String(option.leadTimeDays),
});

function lineOf(row: PrFormRow, origin: FormLine["origin"], partId: string): FormLine {
  const supplierId = row.supplier?.id || "";
  return {
    // Stable per form and item, so a retried create sends the same payload.
    key: `ai-${partId}-${row.item.id}`,
    origin,
    row,
    checked: origin !== "suggested" && row.checked && !row.covered,
    allowCovered: false,
    quantity: row.suggestedQuantity.value === null ? "" : String(row.suggestedQuantity.value),
    supplierId,
    needByDate: row.needByDate.value,
    needByEdited: false,
    added: [],
    picking: false,
    // Any price, currency or lead time the user gave for a new supplier in the chat.
    terms: termsFrom(row.suppliers?.find((option) => option.id === supplierId && option.link === "new")),
    override: NO_REASON,
  };
}

const rowOptions = (row: PrFormRow): ApprovedSupplier[] =>
  row.suppliers?.length ? row.suppliers : row.supplier ? [{ id: row.supplier.id, name: row.supplier.name, preferred: row.supplier.source === "preferred", leadTimeDays: row.needByDate.leadTimeDays ?? null, ...(row.supplier.link ? { link: row.supplier.link } : {}) }] : [];

// The suppliers a line may use: the item's (with one the user named that it
// has not approved yet), then those picked from "Another supplier…".
function supplierOptions(line: FormLine): ApprovedSupplier[] {
  const options = rowOptions(line.row);
  return [...options, ...line.added.filter((added) => !options.some((option) => option.id === added.id))];
}

const optionOf = (line: FormLine) => supplierOptions(line).find((supplier) => supplier.id === line.supplierId);
// The line's supplier is not an approved supplier of the item yet: Create adds it.
const isNewSupplier = (line: FormLine) => optionOf(line)?.link === "new";

// A new supplier's terms as the link and the request take them: a price of
// zero or more in a 3-letter currency, and a lead time in whole days or none.
function linkTermsOf(line: FormLine) {
  const priceText = line.terms.price.trim();
  const leadText = line.terms.leadTime.trim();
  const price = priceText ? Number(priceText) : null;
  const lead = leadText ? Number(leadText) : null;
  const currency = line.terms.currency.trim().toUpperCase();
  const leadValid = lead === null || (Number.isInteger(lead) && lead >= 0);
  const valid = price !== null && Number.isFinite(price) && price >= 0 && /^[A-Z]{3}$/.test(currency) && leadValid;
  return { valid, price: valid ? price : null, currency: valid ? currency : null, leadTimeDays: leadValid ? lead : null };
}

// The master-data reference price of the line's supplier, never a model
// value; for a supplier Create adds, the price the user gives.
function priceOf(line: FormLine): PriceValue {
  const { row } = line;
  const option = optionOf(line);
  if (option?.link === "new") {
    const terms = linkTermsOf(line);
    return terms.valid ? { value: terms.price, currency: terms.currency, source: "reference_price" } : { value: null, currency: null, source: "missing" };
  }
  if (row.supplier && line.supplierId === row.supplier.id) return row.estimatedUnitPrice;
  if (!option || option.unitPrice === null || option.unitPrice === undefined) return { value: null, currency: null, source: row.estimatedUnitPrice.source === "masked" ? "masked" : "missing" };
  return { value: option.unitPrice, currency: option.currency || row.estimatedUnitPrice.currency, source: "reference_price" };
}

function leadTimeOf(line: FormLine) {
  const option = optionOf(line);
  if (option?.link === "new") return linkTermsOf(line).leadTimeDays;
  return option?.leadTimeDays ?? (line.row.supplier?.id === line.supplierId ? line.row.needByDate.leadTimeDays ?? null : null);
}

const preferredOf = (line: FormLine) => supplierOptions(line).filter((supplier) => supplier.preferred);
const needsReason = (line: FormLine) => overrideNeeded({ supplierId: line.supplierId, preferredIds: preferredOf(line).map((supplier) => supplier.id) });

function blockOf(line: FormLine): Block | null {
  if (!(Number(line.quantity) > 0)) return "quantity";
  if (!line.supplierId) return "supplier";
  if (isNewSupplier(line)) {
    if (!linkTermsOf(line).valid) return "terms";
    // The full form cannot pick a supplier the item has not approved, so the reason is asked here.
    if (needsReason(line) && !validateSupplierOverride(line.override, true).value) return "reason";
    return null;
  }
  // A supplier other than the preferred one needs a reason, which only the full form asks for.
  if (needsReason(line)) return "override";
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
      // The reason asked on a line whose new supplier skips the preferred one.
      supplierOverride: isNewSupplier(line) && needsReason(line) ? validateSupplierOverride(line.override, true).value : null,
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

// A new supplier's link to the line's item, as the setup card adds one
// (SetupRecordsPart.tsx itemSupplierBody) but not preferred: approved and
// active, with the price, currency and lead time the user gave.
export function newSupplierLinkBody(line: FormLine) {
  const terms = linkTermsOf(line);
  return { supplierId: line.supplierId, preferred: false, approved: true, active: true, leadTimeDays: terms.leadTimeDays, referencePrice: terms.price, currency: terms.currency };
}

type Post = (url: string, body: unknown) => Promise<unknown>;
type Linked = Record<string, string>;
export type FormCreateOutcome =
  | { status: "link_failed"; linked: Linked; key: string; failure: unknown; added: string[] }
  | { status: "request_failed"; linked: Linked; failure: unknown; added: string[] }
  | { status: "created"; linked: Linked; created: PrReceipt & { idempotentReplay?: boolean }; added: string[] };

const failureCode = (failure: unknown) => (failure && typeof failure === "object" && "code" in failure ? String((failure as { code?: unknown }).code || "") : "");

// One click on Create: first each ticked line's new supplier, added to its
// item through the item supplier route (a link already there is fine), then
// the request exactly as without one. A link that fails stops the click, so
// no request is created without it. linked: the lines whose supplier this
// form already added (line key to supplier id), which a retry skips.
export async function createFormRequest({ ticked, props, ids, post, linked = {} }: {
  ticked: FormLine[];
  props: PrFormProps;
  ids: { threadId: string; messageId: string; partId: string };
  post: Post;
  linked?: Linked;
}): Promise<FormCreateOutcome> {
  const done: Linked = { ...linked };
  // The links this call created (a link already there is not one of them).
  const added: string[] = [];
  for (const line of ticked) {
    if (!isNewSupplier(line) || done[line.key] === line.supplierId) continue;
    try {
      const made = await post(`/api/master-data/items/${encodeURIComponent(line.row.item.id)}/suppliers`, newSupplierLinkBody(line)) as { relationship?: { relationshipId?: string } } | null;
      const id = made?.relationship?.relationshipId;
      if (typeof id === "string" && id) added.push(id);
    } catch (failure) {
      if (failureCode(failure) !== "RELATIONSHIP_EXISTS") return { status: "link_failed", linked: done, key: line.key, failure, added };
    }
    done[line.key] = line.supplierId;
  }
  try {
    const created = await post("/api/procurement/requests", draftRequestBody(ticked, props, ids)) as PrReceipt & { idempotentReplay?: boolean };
    return { status: "created", linked: done, created, added };
  } catch (failure) {
    return { status: "request_failed", linked: done, failure, added };
  }
}

function errorText(error: unknown, copy: PartCopy) {
  // Server messages are not shown: the domain's are Chinese-only. Codes are worded here.
  const key = `ai.v2.error.${error instanceof ApiError ? error.code || "" : ""}`;
  return isTranslationKey(key) ? copy.t(key) : copy.t("ai.v2.error.generic");
}

// Why a new supplier was not added, worded from its codes (a field's first), as the setup card words them.
function linkErrorText(error: unknown, copy: PartCopy, name: string, sku: string) {
  const head = copy.t("ai.v2.form.newSupplier.failed", { name, sku });
  if (!(error instanceof ApiError)) return head;
  const detail = error.details.map((entry) => String(entry?.code || "")).find((code) => code && isTranslationKey(`ai.v2.setup.error.${code}`));
  const key = [detail ? `ai.v2.setup.error.${detail}` : "", error.code ? `ai.v2.setup.error.${error.code}` : "", error.code ? `ai.v2.error.${error.code}` : ""].find((entry) => entry && isTranslationKey(entry));
  return key ? `${head} ${copy.t(key as TranslationKey)}` : head;
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

// A supplier from the Suppliers list as a line's new option: priced in its
// own currency, else the workspace's, with no lead time or price until the
// user gives them.
export function newSupplierOption(supplier: WorkspaceSupplier, workspaceCurrency?: string | null): ApprovedSupplier {
  const own = String(supplier.defaultCurrency || "").trim().toUpperCase();
  return {
    id: supplier.id,
    name: supplier.name || supplier.supplierName || supplier.id,
    preferred: false,
    leadTimeDays: null,
    unitPrice: null,
    currency: /^[A-Z]{3}$/.test(own) ? own : workspaceCurrency || null,
    link: "new",
  };
}

// "Another supplier…": the workspace's active suppliers the line does not
// offer yet, from the Suppliers list every signed-in role may read.
function OtherSupplierPicker({ copy, exclude, onPick, onCancel }: { copy: PartCopy; exclude: Set<string>; onPick: (supplier: WorkspaceSupplier) => void; onCancel: () => void }) {
  const [suppliers, setSuppliers] = useState<WorkspaceSupplier[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    apiJson<{ suppliers: WorkspaceSupplier[] }>("/api/master-data/suppliers?status=active")
      .then((result) => { if (live) setSuppliers((result.suppliers || []).filter((supplier) => supplier.id && String(supplier.status || "active").toLowerCase() === "active")); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const choices = (suppliers || []).filter((supplier) => !exclude.has(supplier.id));
  const label = copy.t("ai.v2.form.otherSupplier.label");
  return (
    <div data-testid="ai-v2-pr-other-supplier" className="space-y-1">
      <span className="block text-[12px]" style={{ color: A.sub }}>{label}</span>
      <span className="flex flex-wrap items-center gap-2">
        {failed ? <span role="alert" style={{ color: toneStyle("danger").color }}>{copy.t("ai.v2.form.otherSupplier.failed")}</span>
          : !suppliers ? <span style={{ color: A.sub }}>{copy.t("ai.v2.form.otherSupplier.loading")}</span>
          : !choices.length ? <span style={{ color: A.sub }}>{copy.t("ai.v2.form.otherSupplier.empty")}</span>
          : (
            <select value="" aria-label={label} onChange={(event) => { const picked = choices.find((supplier) => supplier.id === event.target.value); if (picked) onPick(picked); }} className={`${inputClass} max-w-[16rem]`} style={inputStyle}>
              <option value="">{copy.t("ai.v2.form.pickSupplier")}</option>
              {choices.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name || supplier.supplierName || supplier.id}</option>)}
            </select>
          )}
        <button type="button" onClick={onCancel} className={linkClass} style={{ color: A.blue }}>{copy.t("ai.v2.form.otherSupplier.cancel")}</button>
      </span>
    </div>
  );
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
  // The new suppliers this form added (line key to supplier id), and why one could not be added.
  const [linked, setLinked] = useState<Record<string, string>>({});
  const [linkErrors, setLinkErrors] = useState<Record<string, string>>({});

  const update = (key: string, patch: Partial<FormLine>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  // A date the user asked for or changed is kept; otherwise it follows the supplier's lead time.
  const needByFor = (line: FormLine, lead: number | null | undefined) =>
    !line.needByEdited && line.row.needByDate.source !== "user_named" && lead !== null && lead !== undefined ? addCalendarDays(todayInTimeZone(copy.timezone), lead) : line.needByDate;
  const chooseSupplier = (line: FormLine, supplierId: string, extra: ApprovedSupplier[] = line.added) => {
    const option = supplierOptions({ ...line, added: extra }).find((supplier) => supplier.id === supplierId);
    const fresh = option?.link === "new";
    const terms = fresh && supplierId !== line.supplierId ? termsFrom(option) : line.terms;
    const lead = fresh ? linkTermsOf({ ...line, terms }).leadTimeDays : option?.leadTimeDays;
    // Another supplier asks again why it is not the preferred one, as the full form does.
    update(line.key, { supplierId, added: extra, picking: false, terms, override: supplierId === line.supplierId ? line.override : NO_REASON, needByDate: needByFor(line, lead) });
  };
  const pickOther = (line: FormLine, supplier: WorkspaceSupplier) => {
    const option = newSupplierOption(supplier, props.workspaceCurrency);
    chooseSupplier(line, option.id, [...line.added.filter((entry) => entry.id !== option.id), option]);
  };
  const setTerms = (line: FormLine, patch: Partial<LinkTerms>) => {
    const terms = { ...line.terms, ...patch };
    // A lead time the user enters moves the need-by date as a supplier's recorded one does.
    const lead = patch.leadTime !== undefined && terms.leadTime.trim() ? linkTermsOf({ ...line, terms }).leadTimeDays : null;
    update(line.key, { terms, needByDate: needByFor(line, lead) });
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

  const addedLinksRef = useRef<string[]>([]);
  const record = (next: PrReceipt) => {
    setReceipt(next);
    onReceipt?.(next);
  };

  const create = async () => {
    if (createDisabled) return;
    setBusy(true);
    setError("");
    setLinkErrors({});
    try {
      const outcome = await createFormRequest({ ticked, props, ids: { threadId, messageId, partId }, linked, post: (url, body) => apiJson(url, { method: "POST", body: JSON.stringify(body) }) });
      setLinked(outcome.linked);
      // Links added on an earlier try count too: a retry after a failed request skips them.
      addedLinksRef.current = [...new Set([...addedLinksRef.current, ...outcome.added])];
      if (outcome.status === "link_failed") {
        const line = ticked.find((entry) => entry.key === outcome.key);
        setLinkErrors({ [outcome.key]: linkErrorText(outcome.failure, copy, (line && optionOf(line)?.name) || "", line?.row.item.sku || "") });
        return;
      }
      if (outcome.status === "request_failed") {
        setError(errorText(outcome.failure, copy));
        return;
      }
      const { created } = outcome;
      // A replay returns the request as it was first created; it may have been submitted or cancelled since.
      const current = created.idempotentReplay ? await apiJson<PrReceipt>(`/api/procurement/requests/${encodeURIComponent(created.id)}`) : created;
      record({ id: current.id || created.id, number: current.number || created.number, version: current.version, status: current.status || "draft", ...(addedLinksRef.current.length ? { addedSupplierLinks: addedLinksRef.current } : {}) });
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

  // With nothing ticked the button says what to do first (2026-11-05: it read
  // "Create draft request (0 lines)").
  const createLabel = busy ? copy.t("ai.v2.form.working") : !ticked.length ? copy.t("ai.v2.form.createNone") : ticked.length === 1 ? copy.t("ai.v2.form.createOne") : copy.t("ai.v2.form.create", { count: ticked.length });
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
          const options = supplierOptions(line);
          // The stored unit code worded for the form's language ("件", "boxes");
          // the request still records the code (unitSnapshot).
          const unit = row.item.unit ? unitLabel(row.item.unit, copy.language) : "";
          const unitFor = (quantity: number) => (row.item.unit ? unitLabel(row.item.unit, copy.language, quantity) : "");
          const chosen = optionOf(line);
          const fresh = chosen?.link === "new";
          const preferred = preferredOf(line);
          const reasonCopy = SUPPLIER_OVERRIDE_COPY[copy.language];
          const reasonQuestion = (preferred.length > 1 ? reasonCopy.questionMany : reasonCopy.question).replace("{name}", preferred.map((supplier) => supplier.name).join(", "));
          const linkError = linkErrors[line.key];
          // Where each field's value came from: the server's source while it is
          // unchanged, then "Edited", or "Your choice" where nothing was suggested.
          const quantitySource = !line.quantity ? ""
            : row.suggestedQuantity.value !== null && line.quantity === String(row.suggestedQuantity.value)
              ? copy.t(`ai.v2.form.source.${row.suggestedQuantity.source}`, { minimum: copy.number(row.suggestedQuantity.minimum ?? row.suggestedQuantity.value), requested: copy.number(row.suggestedQuantity.requested ?? 0), days: copy.number(row.suggestedQuantity.coverDays ?? 0) })
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
          // Stock figures with the item's unit ("On hand 150 pcs", 现有 150 件).
          const amount = (value: number) => `${copy.number(value)}${unit ? ` ${unitFor(value)}` : ""}`;
          const facts = [
            row.onHand !== undefined && row.onHand !== null ? copy.t("ai.v2.form.onHand", { value: amount(row.onHand) }) : "",
            row.safetyStock !== undefined && row.safetyStock !== null ? copy.t("ai.v2.form.safetyStock", { value: amount(row.safetyStock) }) : "",
            row.reorderPoint !== undefined && row.reorderPoint !== null ? copy.t("ai.v2.form.reorderPoint", { value: amount(row.reorderPoint) }) : "",
            line.origin === "suggested" && row.suggestedQuantity.value !== null ? copy.t("ai.v2.form.suggestedQuantity", { value: `${copy.number(row.suggestedQuantity.value)}${unit ? ` ${unitFor(row.suggestedQuantity.value)}` : ""}` }) : "",
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
                    <span className="block text-[12px]" style={{ color: A.sub }}>{unit ? copy.t("ai.v2.form.quantityUnit", { unit }) : copy.t("ai.v2.form.quantity")}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <input type="number" min="0" step="any" inputMode="decimal" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} className={`${inputClass} max-w-[8rem]`} style={inputStyle} />
                      {quantitySource ? <SourceChip>{quantitySource}</SourceChip> : null}
                    </span>
                  </label>
                  <label data-testid="ai-v2-pr-field" data-field="supplier" className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.supplier")}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <select value={line.supplierId} onChange={(event) => (event.target.value === OTHER_SUPPLIER ? update(line.key, { picking: true }) : chooseSupplier(line, event.target.value))} className={`${inputClass} max-w-[16rem]`} style={inputStyle}>
                        {!line.supplierId ? <option value="">{copy.t("ai.v2.form.pickSupplier")}</option> : null}
                        {options.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.preferred ? copy.t("ai.v2.form.preferred", { name: supplier.name }) : supplier.link === "new" ? copy.t("ai.v2.form.newOption", { name: supplier.name }) : supplier.name}</option>)}
                        {props.canLinkSuppliers ? <option value={OTHER_SUPPLIER}>{copy.t("ai.v2.form.otherSupplier")}</option> : null}
                      </select>
                      {supplierSource ? <SourceChip>{supplierSource}</SourceChip> : null}
                    </span>
                  </label>
                  {line.picking && props.canLinkSuppliers ? <OtherSupplierPicker copy={copy} exclude={new Set(options.map((supplier) => supplier.id))} onPick={(supplier) => pickOther(line, supplier)} onCancel={() => update(line.key, { picking: false })} /> : null}
                  {fresh && chosen ? (
                    <p data-testid="ai-v2-pr-new-supplier" data-linked={linked[line.key] === chosen.id ? "true" : "false"} className="flex items-start gap-1.5 text-[12px]" style={{ color: ORANGE.color }}>
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                      <span>{copy.t(linked[line.key] === chosen.id ? "ai.v2.form.newSupplier.added" : "ai.v2.form.newSupplier.note", { name: chosen.name, sku: row.item.sku })}</span>
                    </p>
                  ) : null}
                  {linkError ? <p role="alert" data-testid="ai-v2-pr-link-error" className="text-[12px]" style={{ color: toneStyle("danger").color }}>{linkError}</p> : null}
                  {fresh && needsReason(line) ? (
                    <div data-testid="ai-v2-pr-reason" className="space-y-1">
                      <label className="block space-y-0.5">
                        <span className="block text-[12px]" style={{ color: A.sub }}>{reasonQuestion}</span>
                        <select value={line.override.reasonCode} onChange={(event) => update(line.key, { override: { ...line.override, reasonCode: event.target.value } })} className={`${inputClass} max-w-[16rem]`} style={inputStyle}>
                          <option value="">{reasonCopy.choose}</option>
                          {SUPPLIER_OVERRIDE_REASONS.map((code) => <option key={code} value={code}>{supplierOverrideReasonLabel(code, copy.language)}</option>)}
                        </select>
                      </label>
                      <label className="block space-y-0.5">
                        <span className="block text-[12px]" style={{ color: A.sub }}>{reasonCopy.note}</span>
                        <input type="text" value={line.override.note} maxLength={500} onChange={(event) => update(line.key, { override: { ...line.override, note: event.target.value } })} className={`${inputClass} max-w-[16rem]`} style={inputStyle} />
                      </label>
                    </div>
                  ) : null}
                  <label data-testid="ai-v2-pr-field" data-field="needBy" className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.needBy")}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <input type="date" value={line.needByDate} onChange={(event) => update(line.key, { needByDate: event.target.value, needByEdited: true })} className={`${inputClass} max-w-[10rem]`} style={inputStyle} />
                      {needBySource ? <SourceChip>{needBySource}</SourceChip> : null}
                      {shortSoon ? <Chip testId="ai-v2-pr-short-week" style={ORANGE}><AlertTriangle size={11} aria-hidden />{copy.t("ai.v2.form.shortWeek", { date: copy.day(String(row.needByDate.shortWeekOf)) })}</Chip> : null}
                    </span>
                  </label>
                  {fresh ? (
                    // The new supplier's terms: the link records them and the request line uses the price.
                    <div data-testid="ai-v2-pr-new-terms" className="flex flex-wrap gap-2">
                      <label className="space-y-0.5">
                        <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.price")}</span>
                        <input type="number" min="0" step="any" inputMode="decimal" value={line.terms.price} onChange={(event) => setTerms(line, { price: event.target.value })} className={`${inputClass} max-w-[8rem]`} style={inputStyle} />
                      </label>
                      <label className="space-y-0.5">
                        <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.currency")}</span>
                        <input type="text" maxLength={3} value={line.terms.currency} onChange={(event) => setTerms(line, { currency: event.target.value.toUpperCase() })} className={`${inputClass} max-w-[5rem]`} style={inputStyle} />
                      </label>
                      <label className="space-y-0.5">
                        <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.leadTimeDays")}</span>
                        <input type="number" min="0" step="1" inputMode="numeric" value={line.terms.leadTime} onChange={(event) => setTerms(line, { leadTime: event.target.value })} className={`${inputClass} max-w-[6rem]`} style={inputStyle} />
                      </label>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {fresh ? null : (
                      <span data-testid="ai-v2-pr-field" data-field="price">
                        <span className="text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.form.price")} </span>
                        {price.value !== null
                          ? <><span className="tabular-nums" style={{ color: A.label }}>{copy.value(price.value, "money", price.currency)}</span> <SourceChip>{copy.t("ai.v2.form.referencePrice")}</SourceChip></>
                          : <span data-testid="ai-v2-pr-price-unavailable" style={{ color: ORANGE.color }}>{copy.t(price.source === "masked" ? "ai.v2.form.priceMasked" : "ai.v2.form.priceMissing")}</span>}
                      </span>
                    )}
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
