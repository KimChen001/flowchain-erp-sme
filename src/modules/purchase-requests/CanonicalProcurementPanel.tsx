import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useI18n } from "../../i18n/I18n";
import { formatCalendarDay, formatLocaleAmount, todayInTimeZone } from "../../lib/format";
import { formatInstantDay } from "../business-documents/documentFormat";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { orderedCurrencyCodes } from "../../lib/currencyOptions";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { ArrowLeft, CheckCircle2, ClipboardCheck, FileText, Plus, RefreshCw, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { rememberDocumentNumbers, resolveDocumentNumbers } from "../../lib/documentNumbers";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { ExportButton, ListCard, ListSearchCard, ListStateRow, PrimaryButton, ResetButton, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { exportRowsToCsv } from "../../lib/data-export";
import { createClientTemporaryId } from "../../lib/client-id";
import { PrefillBanner, PrefillSourceChip } from "../../components/prefill/PrefillSource";
import { addCalendarDays, buildSuggestionTrail, planNonCatalogPrefill, planPurchaseRequestPrefill, type PrefillEntry, type PrefillOrigin, type SupplierChoice, type SupplierLastOrder } from "../../lib/prefill";
import { SupplierChoices } from "../../components/procurement/SupplierChoices";
import { SupplierOverrideCount, SupplierOverrideFlag, SupplierOverrideReason, hasSupplierOverride, supplierOverrideIssueText, type SupplierOverride } from "../../components/procurement/SupplierOverrideReason";
import { overrideNeeded, validateSupplierOverride } from "../../../shared/supplier-override-reasons.mjs";
import { PriceHistoryFacts, priceHistoryKey, usePriceHistory } from "../procurement/PriceHistoryFacts";

type Item = {
  itemId: string;
  id?: string;
  sku: string;
  itemName: string;
  name?: string;
  purchaseUnit: string;
  baseUnit: string;
  specification: string;
  category?: string;
  defaultWarehouseId: string;
  defaultSupplierId: string;
};
type Supplier = {
  id: string;
  name: string;
  supplierName?: string;
  supplierCode?: string;
  status: string;
  preferred?: boolean;
  defaultCurrency?: string;
};
type SelectorOption = { id: string; code: string; label: string; metadata?: Record<string, unknown> };
type SupplierOption = Supplier & {
  supplierName?: string;
  supplierCode?: string;
  preferred?: boolean;
  referencePrice?: number;
  currency?: string;
  leadTimeDays?: number | null;
  minimumOrderQuantity?: number | string | null;
};
type Line = {
  lineId: string;
  sourceType: "catalog_item" | "non_catalog_item";
  lineBasis: "quantity" | "amount";
  itemId: string | null;
  sku: string | null;
  supplierId: string;
  supplierSnapshot?: { id: string; supplierCode: string; supplierName: string };
  itemNameSnapshot: string;
  unitSnapshot: string | null;
  specificationSnapshot: string;
  commodityId: string;
  quantity: string;
  estimatedUnitPrice: string;
  estimatedAmount: string;
  currency: string;
  targetWarehouseId: string;
  needByDate: string;
  serviceStartDate: string;
  serviceEndDate: string;
  internalLineComment: string;
  // Why the line's supplier is not the item's preferred one; null when not needed.
  supplierOverride?: SupplierOverride | null;
};
type PR = {
  // The internal id: URLs, links and API calls.
  id: string;
  // The document number people read (PR-YYYYMM-NNNN; the id for requests made before numbering).
  number?: string;
  status: string;
  version: number;
  requesterId: string;
  // The requester's name; the id only when the user is not known.
  requesterName?: string;
  departmentId: string;
  defaultCurrency: string;
  defaultNeedByDate: string;
  totalAmount: number;
  lines: Line[];
  linkedPurchaseOrderIds?: string[];
  // Older requests recorded a name here rather than a user id.
  requester?: string;
  createdAt?: string;
};
// The number people read; the id stays in links and calls.
const numberOf = (pr: Pick<PR, "id" | "number">) => pr.number || pr.id;
type FieldError = { field?: string; code?: string; message?: string };
const OVERRIDE_FIELD = /^lines\.(\d+)\.supplierOverride\.(reasonCode|note)$/;
// The line fields a handoff (the assistant's purchase request draft) can fill.
type PrefillLineField = "itemId" | "itemNameSnapshot" | "unitSnapshot" | "supplierId" | "quantity" | "estimatedUnitPrice" | "targetWarehouseId" | "needByDate" | "internalLineComment";
type LinePrefill = { origin: PrefillOrigin; intent: string | null; lineId: string; fields: Partial<Record<PrefillLineField, PrefillEntry>>; supplierChoices: SupplierChoice[] };
// Today in the workspace timezone (America/New_York when unknown), not UTC.
const today = (timeZone?: string) => todayInTimeZone(timeZone);
const makeLine = (date = today()): Line => ({
  lineId: createClientTemporaryId("pr-line"),
  sourceType: "catalog_item",
  lineBasis: "quantity",
  itemId: "",
  sku: "",
  supplierId: "",
  itemNameSnapshot: "",
  unitSnapshot: "",
  specificationSnapshot: "",
  commodityId: "",
  quantity: "",
  estimatedUnitPrice: "",
  estimatedAmount: "",
  currency: "",
  targetWarehouseId: "",
  needByDate: date,
  serviceStartDate: "",
  serviceEndDate: "",
  internalLineComment: "",
  supplierOverride: null,
});
const PR_STATUSES = ["draft", "submitted", "approved", "converted", "rejected", "withdrawn", "cancelled"];
// A link that opens the form: "New purchase request", or a handoff that
// fills it (the assistant, the reorder list).
const opensForm = (params: URLSearchParams) =>
  params.get("mode") === "create" || params.get("lineType") === "non_catalog" || Boolean(params.get("itemId") || params.get("sku"));
const COPY = {
  drafts: ["Drafts", "草稿"],
  draftsNote: ["Saved, not yet submitted", "已保存，尚未提交"],
  awaitingApproval: ["Awaiting approval", "待审批"],
  awaitingApprovalNote: ["Submitted and waiting for an approver", "已提交，等待审批"],
  readyForPo: ["Ready for a purchase order", "待生成采购订单"],
  readyForPoNote: ["Approved, no purchase order yet", "已批准，尚未生成采购订单"],
  converted: ["Converted to purchase orders", "已转采购订单"],
  convertedNote: ["Purchase orders created from the request", "已据此生成采购订单"],
  searchTitle: ["Purchase request search", "采购申请查询"],
  searchSubtitle: ["Search requests by number, item, requester and status.", "按申请编号、物料、申请人和状态查询采购申请。"],
  requestNumber: ["Request number", "申请编号"],
  itemOrSku: ["Item / SKU", "物料 / SKU"],
  itemPlaceholder: ["SKU or item name", "SKU 或物料名称"],
  requester: ["Requester", "申请人"],
  requesterPlaceholder: ["Requester name", "申请人姓名"],
  status: ["Status", "状态"],
  allStatuses: ["All statuses", "全部状态"],
  listTitle: ["Purchase request list", "采购申请列表"],
  item: ["Item", "物料"],
  supplier: ["Supplier", "供应商"],
  needBy: ["Need by", "需求日期"],
  amount: ["Amount", "金额"],
  purchaseOrders: ["Purchase orders", "采购订单"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
  created: ["Created", "创建于"],
  moreLines: ["+{count} more lines", "另 {count} 行"],
  notChosen: ["Not chosen", "未选择"],
  nonCatalog: ["Non-catalog", "非目录"],
  noMatch: ["No purchase requests match these filters", "没有符合筛选条件的采购申请"],
  quantityPrice: ["Quantity × unit price", "数量 × 单价"],
  requestDetails: ["Request details", "申请信息"],
  lines: ["Purchase lines", "采购行"],
  lineAmount: ["Line amount", "行金额"],
  preferred: ["Preferred", "首选"],
  edit: ["Edit", "编辑"],
  submitForApproval: ["Submit for approval", "提交审批"],
  backToRequest: ["Back to the purchase request", "返回采购申请"],
} as const;
const request = <T,>(url: string, method = "GET", body?: unknown) =>
  apiJson<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export default function CanonicalProcurementPanel({
  onNavigate,
  focus,
}: {
  onNavigate?: (id: string, focus?: unknown) => void;
  focus?: { entityType: string; entityId: string; at: number } | null;
}) {
  const copy = useWorkspaceCopy();
  const { timezone, locale, language } = useI18n();
  const warehouseName = useWarehouseNames();
  // Amounts use the document currency; without one they stay a plain number.
  const amount = (value: unknown, currencyCode?: string | null) =>
    value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
      ? "—"
      : formatLocaleAmount(Number(value), currencyCode, locale, { maximumFractionDigits: 2 });
  const dayText = (value?: string | null) => !value ? "—" : /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatCalendarDay(value, locale) : formatInstantDay(value, locale, timezone);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  // The navigation the form was last filled from: each handoff is a new one,
  // so a handoff while the page is open (the assistant opening another
  // request, or the same one again) fills the form again.
  const prefilled = useRef<string | null>(null);
  const [prefill, setPrefill] = useState<LinePrefill | null>(null);
  const [items, setItems] = useState<Item[]>([]),
    [suppliers, setSuppliers] = useState<Supplier[]>([]),
    [warehouses, setWarehouses] = useState<SelectorOption[]>([]),
    [departments, setDepartments] = useState<SelectorOption[]>([]),
    [currencies, setCurrencies] = useState<SelectorOption[]>([]),
    [units, setUnits] = useState<SelectorOption[]>([]),
    [commodities, setCommodities] = useState<SelectorOption[]>([]),
    [rows, setRows] = useState<PR[]>([]);
  const [itemSuppliers, setItemSuppliers] = useState<
    Record<string, SupplierOption[]>
  >({});
  const [departmentId, setDepartmentId] = useState("operations"),
    [currency, setCurrency] = useState(""),
    [workspaceCurrency, setWorkspaceCurrency] = useState(""),
    [defaultDate, setDefaultDate] = useState(() => today(timezone)),
    [lines, setLines] = useState<Line[]>(() => [makeLine(today(timezone))]),
    [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<PR | null>(null),
    [errors, setErrors] = useState<FieldError[]>([]),
    [saving, setSaving] = useState(false),
    // The list and the selectors have loaded: the list's loading row, and a
    // non-catalog handoff matching its unit and supplier, wait on it.
    [loaded, setLoaded] = useState(false);
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  // Editing and submitting a draft need the permission the server checks for
  // them (PURCHASE_REQUEST_PERMISSIONS: update and submit follow PO revise).
  const permissions = usePermissionSet();
  const canRevise = Boolean(permissions?.has("procurement.purchase_order.revise"));
  // The request whose detail page opened the edit form, if any.
  const detailEdit = useRef("");
  const [submitting, setSubmitting] = useState(false);
  const statusLabel = (status: string) => statusCodeLabel(status, language) || copy(status);
  // The list shows first; the form opens from "New purchase request", Edit,
  // or a link that asks for it.
  const [formOpen, setFormOpen] = useState(() => opensForm(searchParams));
  useEffect(() => {
    if (opensForm(searchParams)) setFormOpen(true);
  }, [location.key]);
  const [filters, setFilters] = useState({ number: "", item: "", requester: "" });
  // The status filter lives in the URL, so the metric cards can set it.
  const statusFilter = searchParams.get("status") || "";
  const setStatusFilter = (status: string) => {
    const params = new URLSearchParams(searchParams);
    if (status) params.set("status", status); else params.delete("status");
    setSearchParams(params, { replace: true });
  };
  const currencyInitialized = useRef(false);
  // The default date is first set before the workspace timezone loads, on the
  // browser's own day. Once the timezone is known, a default nobody changed,
  // and the lines still on it, move to the workspace day, which the
  // lead-time need-by date also counts from.
  const untouchedDefault = useRef(defaultDate);
  useEffect(() => {
    const workspaceDay = today(timezone);
    const previous = untouchedDefault.current;
    if (defaultDate !== previous || workspaceDay === previous) return;
    untouchedDefault.current = workspaceDay;
    setDefaultDate(workspaceDay);
    setLines((current) => current.map((line) => (line.needByDate === previous ? { ...line, needByDate: workspaceDay } : line)));
  }, [timezone]);
  const selected =
    focus?.entityType === "purchase_request"
      ? rows.find((row) => row.id === focus.entityId)
      : null;
  // The breadcrumb names the request by its number, not the id in the address.
  useDetailCrumb(selected ? numberOf(selected) : null);
  const load = async () => {
    try {
      const [prs, catalog, selector, departmentSelector, currencySelector, unitSelector, commoditySelector, warehouseSelector, settings] = await Promise.all([
        request<PR[]>("/api/procurement/requests"),
        request<{ items: Item[] }>("/api/master-data/items?purchasable=true"),
        request<{ suppliers: SupplierOption[] }>(
          "/api/master-data/suppliers/select",
        ),
        request<{ options: SelectorOption[] }>("/api/master-data/departments/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/currencies/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/units/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/commodities/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/warehouses/select"),
        request<{ company: { currency: string } }>("/api/settings-runtime").catch(() => null),
      ]);
      rememberDocumentNumbers("purchase_request", prs, (pr) => [pr.id, pr.number]);
      setRows(prs);
      setItems(catalog.items);
      setSuppliers(
        selector.suppliers.map((s) => ({
          ...s,
          name: s.name || s.supplierName || s.id,
        })),
      );
      setDepartments(departmentSelector.options);
      setCurrencies(currencySelector.options);
      setWorkspaceCurrency(settings?.company.currency || "");
      if (!currencyInitialized.current) {
        currencyInitialized.current = true;
        setCurrency(settings?.company.currency || "");
      }
      setUnits(unitSelector.options);
      setCommodities(commoditySelector.options);
      setWarehouses(warehouseSelector.options);
      setLoaded(true);
      setLoadError("");
    } catch (error: any) {
      setLoadError(error.message || "采购申请数据加载失败");
      throw error;
    }
  };
  useEffect(() => {
    load().catch((e) => toast.error(copy(e.message)));
  }, []);
  // A handoff opens the form with one line filled from the query: the item,
  // the quantity and reason the assistant computed, and the master data
  // defaults for that item. Every filled field shows where its value came
  // from, and nothing is saved until the user saves.
  useEffect(() => {
    const handoff = location.key;
    if (prefilled.current === handoff) return;
    // An item the workspace does not have (owner, 2026-11-04): one "Other"
    // line with only what the user wrote, each field marked as theirs. The
    // person adds the category and price, and saves.
    if (searchParams.get("lineType") === "non_catalog") {
      if (!loaded) return;
      prefilled.current = handoff;
      const plan = planNonCatalogPrefill({ query: Object.fromEntries(searchParams.entries()), units, suppliers, defaultDate });
      const line: Line = {
        ...makeLine(defaultDate),
        sourceType: "non_catalog_item",
        itemNameSnapshot: plan.values.itemNameSnapshot,
        quantity: plan.values.quantity,
        unitSnapshot: plan.values.unitSnapshot,
        supplierId: plan.values.supplierId,
        currency,
        needByDate: plan.values.needByDate,
        internalLineComment: plan.values.internalLineComment,
      };
      setLines([line]);
      setPrefill({ origin: plan.origin, intent: plan.intent, lineId: line.lineId, fields: plan.fields, supplierChoices: [] });
      return;
    }
    if (!items.length) return;
    const requestedItem = searchParams.get("itemId") || searchParams.get("sku");
    if (!requestedItem) return;
    const item = items.find(
      (row) =>
        (row.itemId || row.id) === requestedItem || row.sku === requestedItem,
    );
    if (!item) return;
    prefilled.current = handoff;
    const itemId = item.itemId || item.id || "";
    // The last PO date of each source orders the list a person chooses from
    // when none is preferred; without them (no PO read rights, or an error)
    // the list is A-Z and says the dates are not available.
    Promise.all([
      request<{ suppliers: SupplierOption[] }>(
        `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
      ),
      request<{ lastOrders: (SupplierLastOrder & { supplierId: string })[] }>(
        `/api/procurement/item-supplier-orders?itemId=${encodeURIComponent(itemId)}`,
      )
        .then((payload) => Object.fromEntries(payload.lastOrders.map((row) => [row.supplierId, row])))
        .catch(() => null),
    ])
      .then(([result, lastOrders]) => {
        setItemSuppliers((current) => ({
          ...current,
          [itemId]: result.suppliers,
        }));
        const plan = planPurchaseRequestPrefill({
          query: Object.fromEntries(searchParams.entries()),
          item: { itemId, defaultWarehouseId: item.defaultWarehouseId },
          suppliers: result.suppliers,
          today: today(timezone),
          defaultDate,
          lastOrders,
        });
        const line: Line = {
          ...makeLine(defaultDate),
          itemId,
          sku: item.sku,
          itemNameSnapshot: item.itemName || item.name || "",
          unitSnapshot: item.purchaseUnit || item.baseUnit,
          specificationSnapshot: item.specification || "",
          commodityId: item.category || "",
          targetWarehouseId: plan.values.targetWarehouseId,
          quantity: plan.values.quantity,
          supplierId: plan.values.supplierId,
          estimatedUnitPrice: plan.values.estimatedUnitPrice,
          currency: plan.values.currency || currency,
          needByDate: plan.values.needByDate,
          internalLineComment: plan.values.internalLineComment,
        };
        setLines([line]);
        setPrefill({ origin: plan.origin, intent: plan.intent, lineId: line.lineId, fields: plan.fields, supplierChoices: plan.supplierChoices });
      })
      .catch((error) => toast.error(copy(error.message || "供应商关系读取失败")));
  }, [items, loaded, searchParams, location.key]);
  const prefillChip = (line: Line, field: PrefillLineField) =>
    prefill && line.lineId === prefill.lineId ? (
      <PrefillSourceChip entry={prefill.fields[field]} current={line[field] ?? ""} testId={`prefill-source-${field}`} />
    ) : null;
  // Earlier PO prices for every catalog line, in one request. Never fills a price.
  const priceHistoryKeyOf = (line: Line) => line.sourceType === "catalog_item" ? priceHistoryKey({ itemId: line.itemId, unit: line.unitSnapshot, currency: line.currency || currency }) : "";
  const priceHistory = usePriceHistory(lines.map(priceHistoryKeyOf));
  const patchLine = (index: number, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  // A supplier with a recorded lead time moves the line's need-by date from
  // the form's default to today + lead time, so a new order is not due on the
  // day it is placed. A date the person changed is kept.
  const applyLeadTime = (index: number, supplier?: SupplierOption) => {
    const days = Number(supplier?.leadTimeDays);
    if (supplier?.leadTimeDays === null || supplier?.leadTimeDays === undefined || !Number.isInteger(days) || days < 0) return;
    const leadDate = addCalendarDays(today(timezone), days);
    setLines((current) =>
      current.map((line, i) => (i === index && line.needByDate === defaultDate ? { ...line, needByDate: leadDate } : line)),
    );
  };
  const selectItem = async (index: number, value: string) => {
    const item = items.find((row) => (row.itemId || row.id) === value);
    clearOverrideIssues(index);
    if (!item)
      return patchLine(index, {
        itemId: "",
        sku: "",
        supplierId: "",
        itemNameSnapshot: "",
        unitSnapshot: "",
        specificationSnapshot: "",
        commodityId: "",
      });
    const itemId = item.itemId || item.id || "";
    patchLine(index, {
      sourceType: "catalog_item",
      itemId,
      sku: item.sku,
      supplierId: "",
      itemNameSnapshot: item.itemName || item.name || "",
      unitSnapshot: item.purchaseUnit || item.baseUnit,
      specificationSnapshot: item.specification || "",
      commodityId: item.category || "",
      targetWarehouseId: item.defaultWarehouseId || "",
      estimatedUnitPrice: "",
      supplierOverride: null,
    });
    const result = await request<{ suppliers: SupplierOption[] }>(
      `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
    );
    setItemSuppliers((current) => ({ ...current, [itemId]: result.suppliers }));
    // Only one preferred source is filled in; when master data marks more
    // than one, the person picks (the same rule as the handoff prefill).
    const preferredSources = result.suppliers.filter((s) => s.preferred);
    const preferred = preferredSources.length === 1 ? preferredSources[0] : undefined;
    if (preferred) {
      patchLine(index, {
        supplierId: preferred.id,
        estimatedUnitPrice: preferred.referencePrice
          ? String(preferred.referencePrice)
          : "",
        currency: preferred.currency || currency,
      });
      applyLeadTime(index, preferred);
    }
  };
  const supplierOptions = (line: Line): SupplierOption[] =>
    line.sourceType === "non_catalog_item"
      ? suppliers
      : itemSuppliers[line.itemId || ""] || [];
  // A catalog line whose supplier is not the item's preferred one, while one
  // is preferred, asks why (shared/supplier-override-reasons.mjs). Nothing
  // else does. Master data can mark more than one source preferred; any of
  // them needs no reason, the same rule as the server.
  const preferredOf = (line: Line, options = supplierOptions(line)) =>
    line.sourceType === "catalog_item" ? options.filter((option) => option.preferred) : [];
  const preferredNames = (line: Line) =>
    preferredOf(line).map((option) => option.name || option.supplierName || option.id).join(", ");
  const needsReason = (line: Line) =>
    Boolean(line.supplierId) && overrideNeeded({ supplierId: line.supplierId, preferredIds: preferredOf(line).map((option) => option.id) });
  // A reason given while another supplier was preferred is asked again.
  const keepOverride = (line: Line, options: SupplierOption[]) => {
    const stamped = line.supplierOverride?.preferredSupplierId;
    if (!line.supplierOverride || !stamped) return line.supplierOverride || null;
    return preferredOf(line, options).some((option) => option.id === stamped) ? line.supplierOverride : null;
  };
  const hasOverrideIssue = (index: number) =>
    errors.some((error) => {
      const match = OVERRIDE_FIELD.exec(error.field || "");
      return Boolean(match) && Number(match?.[1]) === index;
    });
  // A refused reason belongs to the supplier it was asked for: a new supplier
  // or item drops it, so the picker follows only the preferred-supplier rule.
  const clearOverrideIssues = (index: number) =>
    setErrors((current) => {
      const kept = current.filter((error) => {
        const match = OVERRIDE_FIELD.exec(error.field || "");
        return !match || Number(match[1]) !== index;
      });
      return kept.length === current.length ? current : kept;
    });
  // A reason belongs to the supplier it was given for.
  const chooseSupplier = (index: number, supplierId: string) => {
    patchLine(index, { supplierId, supplierOverride: null });
    clearOverrideIssues(index);
    const line = lines[index];
    applyLeadTime(index, (itemSuppliers[line?.itemId || ""] || []).find((supplier) => supplier.id === supplierId));
  };
  const overrideIssues = (index: number) =>
    Object.fromEntries(errors.flatMap((error) => {
      const match = OVERRIDE_FIELD.exec(error.field || "");
      return match && Number(match[1]) === index ? [[match[2], error.code || (match[2] === "note" ? "NOTE_LENGTH" : "REASON_REQUIRED")]] : [];
    })) as { reasonCode?: string; note?: string };
  const total = useMemo(
    () =>
      lines.reduce(
        (sum, l) =>
          sum +
          (l.lineBasis === "amount"
            ? Number(l.estimatedAmount || 0)
            : Number(l.quantity || 0) * Number(l.estimatedUnitPrice || 0)),
        0,
      ),
    [lines],
  );
  const reset = () => {
    setEditing(null);
    setPrefill(null);
    setLines([makeLine(defaultDate)]);
    setErrors([]);
  };
  const openNewForm = () => {
    reset();
    setFormOpen(true);
  };
  // Back to the list; a link's form query is dropped so it does not reopen.
  const closeForm = () => {
    detailEdit.current = "";
    reset();
    setFormOpen(false);
    if (opensForm(searchParams)) setSearchParams({}, { replace: true });
  };
  const save = async (submit = false) => {
    setSaving(true);
    setErrors([]);
    try {
      // The same rule the server applies, so the person sees it before saving.
      const missingReasons: FieldError[] = lines.flatMap((line, index) =>
        needsReason(line)
          ? validateSupplierOverride(line.supplierOverride, true).issues.map((issue) => ({ field: `lines.${index}.supplierOverride.${issue.field}`, code: issue.code }))
          : [],
      );
      if (missingReasons.length) {
        setErrors(missingReasons);
        return;
      }
      const body = {
        departmentId,
        defaultCurrency: currency,
        defaultNeedByDate: defaultDate,
        lines: lines.map((l) => ({
          ...l,
          quantity: l.lineBasis === "quantity" ? Number(l.quantity) : null,
          estimatedUnitPrice:
            l.lineBasis === "quantity" ? Number(l.estimatedUnitPrice) : null,
          estimatedAmount:
            l.lineBasis === "amount"
              ? Number(l.estimatedAmount)
              : Number(l.quantity) * Number(l.estimatedUnitPrice),
          unitSnapshot: l.lineBasis === "amount" ? null : l.unitSnapshot,
          currency: l.currency || currency,
          // The server keeps a reason only where one is needed.
          supplierOverride: l.sourceType === "catalog_item" && l.supplierOverride?.reasonCode
            ? { reasonCode: l.supplierOverride.reasonCode, note: String(l.supplierOverride.note || "").trim() || null }
            : null,
        })),
      };
      // What became of each prefilled value: codes only, for the audit row.
      const prefilledLine = prefill && !editing ? lines.find((line) => line.lineId === prefill.lineId) : undefined;
      const suggestionTrail = prefill && !editing
        ? buildSuggestionTrail({
            origin: prefill.origin,
            prefills: Object.fromEntries(Object.entries(prefill.fields).map(([field, entry]) => [`line.${field}`, entry])),
            values: Object.fromEntries(Object.keys(prefill.fields).map((field) => [`line.${field}`, prefilledLine?.[field as PrefillLineField] ?? ""])),
          })
        : null;
      const pr = editing
        ? await request<PR>(
            `/api/procurement/requests/${editing.id}`,
            "PATCH",
            { ...body, expectedVersion: editing.version },
          )
        : await request<PR>("/api/procurement/requests", "POST", suggestionTrail ? { ...body, suggestionTrail } : body);
      if (submit)
        await request(`/api/procurement/requests/${pr.id}/submit`, "POST", {
          expectedVersion: pr.version,
        });
      closeForm();
      await load();
      toast.success(copy(submit ? "采购申请已提交" : "采购申请草稿已保存"));
    } catch (error: unknown) {
      const details = error instanceof ApiError ? error.details : [];
      setErrors(
        details.length
          ? details
          : [{ message: error instanceof Error ? error.message : "保存失败" }],
      );
      // The server asked for a reason the form did not: the item's preferred
      // supplier changed since the form read it. Read the sources again so
      // the picker shows, and say it in the interface language.
      const overrideErrors = (details as FieldError[]).flatMap((detail) => {
        const match = OVERRIDE_FIELD.exec(detail.field || "");
        return match ? [{ index: Number(match[1]), code: detail.code }] : [];
      });
      if (overrideErrors.length) {
        const first = overrideErrors[0];
        toast.error(`${copy("采购行")} ${first.index + 1}: ${supplierOverrideIssueText(first.code, language)}`);
        await reloadSuppliers([...new Set(overrideErrors.map(({ index }) => lines[index]?.itemId).filter(Boolean))] as string[]);
      } else {
        toast.error(copy(error instanceof Error ? error.message : "保存失败"));
      }
    } finally {
      setSaving(false);
    }
  };
  const readSuppliers = (itemIds: string[]) =>
    Promise.all(
      itemIds.map(
        async (itemId) =>
          [
            itemId,
            (
              await request<{ suppliers: SupplierOption[] }>(
                `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
              )
            ).suppliers,
          ] as const,
      ),
    );
  const reloadSuppliers = async (itemIds: string[]) => {
    if (!itemIds.length) return;
    try {
      const fresh: Record<string, SupplierOption[]> = Object.fromEntries(await readSuppliers(itemIds));
      setItemSuppliers((current) => ({ ...current, ...fresh }));
      setLines((current) =>
        current.map((line) =>
          line.itemId && fresh[line.itemId] ? { ...line, supplierOverride: keepOverride(line, fresh[line.itemId]) } : line,
        ),
      );
    } catch {
      // The picker still shows for the refused line (hasOverrideIssue).
    }
  };
  const act = async (pr: PR, action: string) => {
    try {
      const reason =
        action === "reject" ? window.prompt(copy("请输入拒绝原因")) || "" : "";
      if (action === "reject" && !reason) return;
      const result: any = await request(
        `/api/procurement/requests/${pr.id}/${action}`,
        "POST",
        { expectedVersion: pr.version, reason },
      );
      rememberDocumentNumbers("purchase_order", result.createdPurchaseOrders, (po: { id?: string; number?: string }) => [po.id, po.number]);
      if (result.createdPurchaseOrders?.[0])
        onNavigate?.("procurement:orders", {
          entityType: "purchase_order",
          entityId: result.createdPurchaseOrders[0].id,
        });
      await load();
    } catch (e: any) {
      toast.error(copy(e.message));
    }
  };
  const edit = async (pr: PR) => {
    const itemIds = [
      ...new Set(pr.lines.map((line) => line.itemId).filter(Boolean)),
    ] as string[];
    const payloads: Record<string, SupplierOption[]> = Object.fromEntries(await readSuppliers(itemIds));
    setItemSuppliers((current) => ({
      ...current,
      ...payloads,
    }));
    setEditing(pr);
    setDepartmentId(pr.departmentId);
    setCurrency(pr.defaultCurrency || "");
    setDefaultDate(pr.defaultNeedByDate || today(timezone));
    setLines(
      pr.lines.map((l) => ({
        ...l,
        quantity: String(l.quantity ?? ""),
        estimatedUnitPrice: String(l.estimatedUnitPrice ?? ""),
        estimatedAmount: String(l.estimatedAmount ?? ""),
        // A reason given while another supplier was preferred is asked again.
        supplierOverride: l.itemId && payloads[l.itemId] ? keepOverride(l, payloads[l.itemId]) : l.supplierOverride || null,
      })),
    );
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // An edit opened from a request's detail page belongs to that page: moving
  // to another request or to the list closes it (a link there that opens the
  // form still does).
  const focusedRequestId = focus?.entityType === "purchase_request" ? focus.entityId : "";
  useEffect(() => {
    if (!detailEdit.current || detailEdit.current === focusedRequestId) return;
    detailEdit.current = "";
    reset();
    setFormOpen(opensForm(searchParams));
  }, [focusedRequestId]);
  const editFromDetail = (pr: PR) => {
    detailEdit.current = pr.id;
    edit(pr).catch((error) => {
      detailEdit.current = "";
      toast.error(copy(error instanceof Error ? error.message : "供应商关系读取失败"));
    });
  };
  // Submits a saved draft as it is, the same command as the list's Submit.
  const submitDraft = async (pr: PR) => {
    setSubmitting(true);
    try {
      await request(`/api/procurement/requests/${encodeURIComponent(pr.id)}/submit`, "POST", { expectedVersion: pr.version });
      toast.success(copy("采购申请已提交"));
      await load();
    } catch (error: unknown) {
      toast.error(copy(error instanceof Error ? error.message : "保存失败"));
      // Changed elsewhere (a newer version or no longer a draft): show it as it is now.
      if (error instanceof ApiError && error.status === 409) await load().catch(() => undefined);
    } finally {
      setSubmitting(false);
    }
  };
  const requesterOf = (pr: PR) => pr.requesterName || pr.requester || pr.requesterId || "—";
  const suppliersOf = (pr: PR) =>
    [...new Set(pr.lines.map((line) => line.supplierSnapshot?.supplierName).filter(Boolean))].join(", ");
  const needByOf = (pr: PR) => pr.lines.map((line) => line.needByDate).filter(Boolean).sort()[0] || pr.defaultNeedByDate;
  const lineAmountOf = (line: Line) =>
    line.lineBasis === "amount" ? Number(line.estimatedAmount || 0) : Number(line.quantity || 0) * Number(line.estimatedUnitPrice || 0);
  const contains = (value: unknown, needle: string) => String(value || "").toLowerCase().includes(needle.trim().toLowerCase());
  const shownRows = rows.filter((pr) =>
    (!statusFilter || pr.status === statusFilter)
    && (!filters.number.trim() || contains(numberOf(pr), filters.number) || contains(pr.id, filters.number))
    && (!filters.item.trim() || pr.lines.some((line) => contains(line.sku, filters.item) || contains(line.itemNameSnapshot, filters.item)))
    && (!filters.requester.trim() || contains(requesterOf(pr), filters.requester)),
  );
  const resetFilters = () => {
    setFilters({ number: "", item: "", requester: "" });
    setStatusFilter("");
  };
  // Document numbers, not internal ids, in the file.
  const exportRequests = async () => {
    const orderNumbers = await resolveDocumentNumbers("purchase_order", shownRows.flatMap((pr) => pr.linkedPurchaseOrderIds || []));
    exportRowsToCsv("purchase-requests-export.csv", shownRows.map((pr) => ({
      [tr("requestNumber")]: numberOf(pr),
      [tr("item")]: pr.lines.map((line) => [line.sku, line.itemNameSnapshot].filter(Boolean).join(" ")).join("; "),
      [tr("supplier")]: suppliersOf(pr),
      [tr("requester")]: requesterOf(pr),
      [tr("needBy")]: needByOf(pr) || "",
      [tr("amount")]: pr.totalAmount ?? "",
      Currency: pr.defaultCurrency,
      [tr("status")]: statusLabel(pr.status),
      [tr("purchaseOrders")]: (pr.linkedPurchaseOrderIds || []).map((id) => orderNumbers.get(id) || id).join("; "),
    })), timezone);
  };
  if (loadError)
    return (
      <Card className="p-12 text-center">
        <h1 className="text-base font-semibold">{copy("采购申请数据加载失败")}</h1>
        <p className="mt-2 text-xs" style={{ color: A.sub }}>
          {copy(loadError)}
        </p>
        <button
          onClick={() => load().catch((error) => toast.error(copy(error.message)))}
          className="mt-3 text-sm text-blue-600"
        >{copy("重试")}</button>
      </Card>
    );
  const editingSelected = Boolean(selected && formOpen && editing?.id === selected.id);
  if (selected && !editingSelected)
    return (
      <div className="space-y-5 pb-16">
        <Card className="p-5">
          <button type="button" onClick={() => onNavigate?.("procurement:requests")} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline">
            <ArrowLeft size={13} />{copy("返回采购申请列表")}
          </button>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold" style={{ color: A.label }}>{numberOf(selected)}</h1>
                <StatusChip label={statusLabel(selected.status)} tone={statusToneOf(selected.status)} />
              </div>
              <p className="mt-1 text-xs" style={{ color: A.sub }}>
                {tr("requester")}: {requesterOf(selected)} · {tr("created")}: {dayText(selected.createdAt)} · v{selected.version}
              </p>
            </div>
            <div className="flex flex-col items-end gap-3">
              {selected.status === "draft" && canRevise && (
                <div className="flex flex-wrap items-center justify-end gap-2" data-testid="pr-detail-actions">
                  <button type="button" data-testid="pr-detail-edit" disabled={submitting} onClick={() => editFromDetail(selected)} className={listButtonClass.secondary}>{tr("edit")}</button>
                  <button type="button" data-testid="pr-detail-submit" disabled={submitting} onClick={() => void submitDraft(selected)} className={listButtonClass.primary}>{tr("submitForApproval")}</button>
                </div>
              )}
              <div className="text-right">
                <div className="text-[11px]" style={{ color: A.sub }}>{copy("预计总额")}</div>
                <strong className="text-lg tabular-nums" style={{ color: A.label }}>{amount(selected.totalAmount, selected.defaultCurrency)}</strong>
              </div>
            </div>
          </div>
        </Card>
        <ListCard title={tr("lines")}>
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[980px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  {[tr("item"), tr("supplier"), tr("quantityPrice"), tr("needBy"), copy("目标仓库或服务地点"), copy("行级内部备注")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{tr("amount")}</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((line, index) => (
                  <tr key={line.lineId} className={listRowClass} style={listRowStyle(index, selected.lines.length)}>
                    <td className={`${tdNameClass} max-w-[240px]`}>
                      <div className="truncate font-medium" style={{ color: A.label }}>{line.itemNameSnapshot || "—"}</div>
                      <div className="text-[11px]" style={{ color: A.sub }}>{line.sku || tr("nonCatalog")}</div>
                    </td>
                    <td className={tdNameClass}>
                      <div>{line.supplierSnapshot?.supplierName || line.supplierId || "—"}</div>
                      <SupplierOverrideFlag override={line.supplierOverride} testId="pr-line-supplier-override" />
                    </td>
                    <td className={tdNumericClass}>
                      {line.lineBasis === "quantity"
                        ? `${line.quantity} ${line.unitSnapshot || ""} × ${amount(line.estimatedUnitPrice, line.currency || selected.defaultCurrency)}`
                        : copy("金额 / 服务型")}
                    </td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{dayText(line.needByDate || selected.defaultNeedByDate)}</td>
                    <td className={tdNowrapClass}>{warehouseName(line.targetWarehouseId) || "—"}</td>
                    <td className={`${tdNameClass} max-w-[220px] truncate`} title={line.internalLineComment}>{line.internalLineComment || "—"}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{amount(line.estimatedAmount, line.currency || selected.defaultCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ListCard>
        <Card className="p-5">
          <h2 className="fc-section-title" style={{ color: A.label }}>{copy("关联采购订单")}</h2>
          {!selected.linkedPurchaseOrderIds?.length ? (
            <div className="py-8 text-center text-xs" style={{ color: A.sub }}>{copy("暂无关联采购订单")}</div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {selected.linkedPurchaseOrderIds.map((id) => (
                <EntityLink key={id} kind="purchase_order" id={id} className="text-sm text-blue-600" />
              ))}
            </div>
          )}
        </Card>
      </div>
    );
  if (!formOpen) {
    const count = (status: string) => rows.filter((row) => row.status === status).length;
    const statusLink = (status: string) => `/app/procurement/requests?status=${status}`;
    return (
      <div className="space-y-5 pb-16" data-testid="purchase-request-list-page">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <ActionableMetricCard label={tr("drafts")} value={String(count("draft"))} description={tr("draftsNote")} to={statusLink("draft")} icon={FileText} color={A.gray1} />
          <ActionableMetricCard label={tr("awaitingApproval")} value={String(count("submitted"))} description={tr("awaitingApprovalNote")} to={statusLink("submitted")} icon={ClipboardCheck} color={A.orange} />
          <ActionableMetricCard label={tr("readyForPo")} value={String(count("approved"))} description={tr("readyForPoNote")} to={statusLink("approved")} icon={CheckCircle2} color={A.blue} />
          <ActionableMetricCard label={tr("converted")} value={String(count("converted"))} description={tr("convertedNote")} to={statusLink("converted")} icon={Truck} color={A.purple} />
        </div>

        <ListSearchCard
          title={tr("searchTitle")}
          subtitle={tr("searchSubtitle")}
          actions={<>
            <ResetButton onClick={resetFilters} />
            <ExportButton onClick={exportRequests} />
            <PrimaryButton onClick={openNewForm} testId="pr-new">{copy("新建采购申请")}</PrimaryButton>
          </>}
        >
          <Field label={tr("requestNumber")}>
            <input value={filters.number} onChange={(event) => setFilters({ ...filters, number: event.target.value })} placeholder="PR-…" style={inputStyle} />
          </Field>
          <Field label={tr("itemOrSku")}>
            <input value={filters.item} onChange={(event) => setFilters({ ...filters, item: event.target.value })} placeholder={tr("itemPlaceholder")} style={inputStyle} />
          </Field>
          <Field label={tr("requester")}>
            <input value={filters.requester} onChange={(event) => setFilters({ ...filters, requester: event.target.value })} placeholder={tr("requesterPlaceholder")} style={inputStyle} />
          </Field>
          <Field label={tr("status")}>
            <select aria-label={tr("status")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={inputStyle}>
              <option value="">{tr("allStatuses")}</option>
              {PR_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
          </Field>
        </ListSearchCard>

        <ListCard title={tr("listTitle")} total={rows.length} shown={shownRows.length} testId="purchase-request-list">
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[1100px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("requestNumber")}</th>
                  {[tr("item"), tr("supplier"), tr("requester"), tr("needBy")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{tr("amount")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("status")}</th>
                  <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {!loaded && <ListStateRow colSpan={8} state="loading" />}
                {loaded && shownRows.length === 0 && (
                  rows.length === 0
                    ? <ListStateRow colSpan={8} state="empty" title={copy("暂无采购申请")} detail={copy("点击“新建采购申请”开始录入。")} />
                    : <ListStateRow colSpan={8} state="empty" title={tr("noMatch")} />
                )}
                {shownRows.map((pr, index) => {
                  const overrides = pr.lines.filter((line) => hasSupplierOverride(line.supplierOverride));
                  const suppliers = suppliersOf(pr);
                  return (
                    <tr key={pr.id} className={listRowClass} style={listRowStyle(index, shownRows.length)}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                        <EntityLink kind="purchase_request" id={pr.id} number={numberOf(pr)} className={tableLinkClass} />
                        {pr.createdAt && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{tr("created")} {dayText(pr.createdAt)}</div>}
                      </td>
                      <td className={`${tdNameClass} max-w-[240px]`}>
                        <div className="truncate font-medium" style={{ color: A.label }} title={pr.lines[0]?.itemNameSnapshot}>{pr.lines[0]?.itemNameSnapshot || "—"}</div>
                        <div className="text-[11px]" style={{ color: A.sub }}>
                          {[pr.lines[0]?.sku, pr.lines.length > 1 ? tr("moreLines").replace("{count}", String(pr.lines.length - 1)) : ""].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td className={`${tdNameClass} max-w-[200px] truncate`} title={suppliers}>{suppliers || <span style={{ color: A.gray2 }}>{tr("notChosen")}</span>}</td>
                      <td className={tdNowrapClass}>{requesterOf(pr)}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{dayText(needByOf(pr))}</td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{amount(pr.totalAmount, pr.defaultCurrency)}</td>
                      <td className={tdNameClass}>
                        <StatusChip label={statusLabel(pr.status)} tone={statusToneOf(pr.status)} />
                        <SupplierOverrideCount count={overrides.length} testId="pr-row-supplier-overrides" />
                        {/* Approve on this row skips the detail, so the row shows each reason too. */}
                        {overrides.length ? (
                          <div className="mt-1 flex max-w-[280px] flex-col items-start gap-1 whitespace-normal">
                            {overrides.map((line, lineIndex) => (
                              <SupplierOverrideFlag
                                key={line.lineId || lineIndex}
                                override={line.supplierOverride}
                                prefix={`${line.sku || line.itemNameSnapshot} · ${line.supplierSnapshot?.supplierName || line.supplierId}`}
                                testId="pr-row-supplier-override"
                              />
                            ))}
                          </div>
                        ) : null}
                        {pr.linkedPurchaseOrderIds?.length ? (
                          <div className="mt-1 flex flex-wrap gap-x-2 text-[11px]">
                            {pr.linkedPurchaseOrderIds.map((id) => <EntityLink key={id} kind="purchase_order" id={id} className="text-[11px] font-medium" />)}
                          </div>
                        ) : null}
                      </td>
                      <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                        <div className="flex items-center gap-1.5">
                          {pr.status === "draft" && (
                            <>
                              <button type="button" className={rowActionClass.primary} onClick={() => edit(pr)}>{copy("编辑")}</button>
                              <button type="button" className={rowActionClass.neutral} onClick={() => act(pr, "submit")}>{copy("提交")}</button>
                            </>
                          )}
                          {pr.status === "submitted" && (
                            <>
                              <button type="button" className={rowActionClass.primary} onClick={() => act(pr, "approve")}>{copy("批准")}</button>
                              <button type="button" className={rowActionClass.danger} onClick={() => act(pr, "reject")}>{copy("拒绝")}</button>
                              <button type="button" className={rowActionClass.neutral} onClick={() => act(pr, "withdraw")}>{copy("撤回")}</button>
                            </>
                          )}
                          {pr.status === "approved" && (
                            <button type="button" className={rowActionClass.primary} onClick={() => act(pr, "generate-purchase-orders")}>{copy("生成采购订单")}</button>
                          )}
                          {!["draft", "submitted", "approved"].includes(pr.status) && (
                            <EntityLink kind="purchase_request" id={pr.id} className={`${rowActionClass.neutral} !font-medium !text-slate-700 !no-underline`}>{tr("view")}</EntityLink>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ListCard>
      </div>
    );
  }
  return (
    <div className="space-y-5 pb-16" data-testid="purchase-request-form">
      <Card className="p-5">
        <button type="button" onClick={closeForm} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline">
          <ArrowLeft size={13} />{editingSelected ? tr("backToRequest") : copy("返回采购申请列表")}
        </button>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold" style={{ color: A.label }}>
              {editing ? `${copy("编辑采购申请")} ${numberOf(editing)}` : copy("新建采购申请")}
            </h2>
            <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("每一行均需明确物料或服务、供应商、金额、交付地点和需求日期。")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={copy("刷新主数据")}
              title={copy("刷新主数据")}
              onClick={() => load()}
              className={listButtonClass.secondary}
            >
              <RefreshCw size={13} />
            </button>
            <button type="button" onClick={closeForm} className={listButtonClass.secondary}>{copy("取消")}</button>
            <button
              type="button"
              disabled={saving}
              onClick={() => save(false)}
              className={listButtonClass.secondary}
            >{copy("保存草稿")}</button>
            <button
              type="button"
              disabled={saving}
              onClick={() => save(true)}
              className={listButtonClass.primary}
            >{copy("保存并提交")}</button>
          </div>
        </div>
        {prefill && !editing ? <PrefillBanner origin={prefill.origin} intent={prefill.intent} /> : null}
        {errors.length > 0 && (
          <div
            role="alert"
            className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700"
          >
            {errors.map((e, i) => {
              const override = OVERRIDE_FIELD.exec(e.field || "");
              return (
                <div key={i}>
                  {override
                    ? `${copy("采购行")} ${Number(override[1]) + 1}: ${supplierOverrideIssueText(e.code, language)}`
                    : copy(e.message || e.field)}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="fc-section-title mb-4" style={{ color: A.label }}>{tr("requestDetails")}</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={copy("申请人")}>
            <input
              aria-label={copy("申请人")}
              readOnly
              value={copy("由服务端当前用户确定")}
              style={{ ...inputStyle, background: A.gray6, color: A.sub }}
            />
          </Field>
          <Field label={copy("部门")}>
            <select
              aria-label={copy("部门")}
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              style={inputStyle}
            >
              {departments.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}
            </select>
          </Field>
          <Field label={copy("默认币种")}>
            <select
              aria-label={copy("默认币种")}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              style={inputStyle}
            >
              <option value="">{copy("选择币种")}</option>
              {orderedCurrencyCodes(workspaceCurrency, currencies.map((option) => option.id), currency).map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </Field>
          <Field label={copy("默认需求日期")}>
            <input
              aria-label={copy("默认需求日期")}
              type="date"
              value={defaultDate}
              onChange={(e) => setDefaultDate(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>
      </Card>

      <ListCard
        title={tr("lines")}
        right={<span className="text-sm font-semibold tabular-nums" style={{ color: A.label }}>{copy("预计总额")} {amount(total, currency)}</span>}
      >
        {lines.map((line, index) => (
          <div key={line.lineId} className="px-5 py-4" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
            <div className="mb-3 flex items-center gap-3">
              <span className="inline-flex h-6 items-center rounded-full bg-blue-50 px-2.5 text-xs font-semibold text-blue-700">{copy("采购行")} {index + 1}</span>
              <span className="ml-auto text-xs tabular-nums" style={{ color: A.sub }}>
                {tr("lineAmount")} <strong style={{ color: A.label }}>{amount(lineAmountOf(line), line.currency || currency)}</strong>
              </span>
              <button
                type="button"
                aria-label={`${copy("删除采购行")} ${index + 1}`}
                title={copy("删除采购行")}
                onClick={() => {
                  if (
                    lines.length > 1 &&
                    window.confirm(copy("确认删除该采购行？"))
                  )
                    setLines(lines.filter((_, i) => i !== index));
                }}
                className="rounded-md p-1 text-red-600 hover:bg-red-50 disabled:opacity-40"
                disabled={lines.length < 2}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Field label={copy("采购类型")}>
                <select
                  value={line.sourceType}
                  onChange={(e) => {
                    const sourceType = e.target.value as Line["sourceType"];
                    patchLine(index, {
                      ...makeLine(defaultDate),
                      lineId: line.lineId,
                      sourceType,
                      currency,
                    });
                  }}
                  style={inputStyle}
                >
                  <option value="catalog_item">{copy("目录物料")}</option>
                  <option value="non_catalog_item">{copy("其他（非目录物料）")}</option>
                </select>
              </Field>
              <Field label={copy("计价方式")}>
                <select
                  value={line.lineBasis}
                  onChange={(e) =>
                    patchLine(index, {
                      lineBasis: e.target.value as Line["lineBasis"],
                      quantity: "",
                      estimatedUnitPrice: "",
                      estimatedAmount: "",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="quantity">{copy("数量型")}</option>
                  <option value="amount">{copy("金额 / 服务型")}</option>
                </select>
              </Field>
              <div className="md:col-span-1 xl:col-span-2">
                <Field label="SKU / 其他">
                  {line.sourceType === "catalog_item" ? (
                    <select
                      aria-label={`SKU ${index + 1}`}
                      value={line.itemId || ""}
                      onChange={(e) => selectItem(index, e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">{copy("搜索或选择 SKU")}</option>
                      {items.map((i) => (
                        <option key={i.itemId || i.id} value={i.itemId || i.id}>
                          {i.sku} · {i.itemName || i.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input readOnly value={copy("非目录")} style={{ ...inputStyle, background: A.gray6, color: A.sub }} />
                  )}
                  {prefillChip(line, "itemId")}
                </Field>
              </div>
              <div className="md:col-span-3 xl:col-span-2">
                <Field label={copy("物料名称 / 描述")}>
                  <input
                    readOnly={line.sourceType === "catalog_item"}
                    value={line.itemNameSnapshot}
                    onChange={(e) =>
                      patchLine(index, { itemNameSnapshot: e.target.value })
                    }
                    style={line.sourceType === "catalog_item" ? { ...inputStyle, background: A.gray6 } : inputStyle}
                  />
                  {prefillChip(line, "itemNameSnapshot")}
                </Field>
              </div>
              <div className="md:col-span-3 xl:col-span-2">
                <Field label={tr("supplier")}>
                  <select
                    aria-label={`${tr("supplier")} ${index + 1}`}
                    value={line.supplierId}
                    onChange={(e) => chooseSupplier(index, e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">{copy("选择供应商")}</option>
                    {supplierOptions(line).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.preferred ? ` · ${tr("preferred")}` : ""}
                      </option>
                    ))}
                  </select>
                  {prefillChip(line, "supplierId")}
                  {prefill && !editing && line.lineId === prefill.lineId && line.itemId && line.itemId === prefill.fields.itemId?.value ? (
                    <SupplierChoices
                      choices={prefill.supplierChoices}
                      preferredOnly={prefill.fields.supplierId?.ref === "item_supplier:choose_preferred"}
                      selectedId={line.supplierId}
                      onChoose={(supplierId) => { if (supplierId !== line.supplierId) chooseSupplier(index, supplierId); }}
                    />
                  ) : null}
                  {needsReason(line) || (line.sourceType === "catalog_item" && hasOverrideIssue(index)) ? (
                    <SupplierOverrideReason
                      testId={`supplier-override-reason-${index + 1}`}
                      preferredName={preferredNames(line)}
                      preferredCount={preferredOf(line).length}
                      value={line.supplierOverride}
                      issues={overrideIssues(index)}
                      onChange={(supplierOverride) =>
                        patchLine(index, {
                          supplierOverride: {
                            ...supplierOverride,
                            missingReason: false,
                            preferredSupplierId: preferredOf(line)[0]?.id || null,
                            preferredSupplierIds: preferredOf(line).map((option) => option.id),
                            preferredSupplierName: preferredNames(line) || null,
                          },
                        })
                      }
                    />
                  ) : null}
                  {line.sourceType === "catalog_item" &&
                    line.itemId &&
                    supplierOptions(line).length === 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate?.("master-data:items", {
                            entityType: "item",
                            entityId: line.itemId,
                          })
                        }
                        className="mt-1 text-xs text-blue-600"
                      >{copy("维护 SKU 供应商")}</button>
                    )}
                </Field>
              </div>
              <div className="md:col-span-1 xl:col-span-2">
                <Field label={copy("品类")}>
                  {line.sourceType === "catalog_item" ? <input readOnly value={line.commodityId} style={{ ...inputStyle, background: A.gray6 }} /> : <select value={line.commodityId} onChange={(e) => patchLine(index, { commodityId: e.target.value })} style={inputStyle}><option value="">{copy("选择品类")}</option>{commodities.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}</select>}
                </Field>
              </div>
              <div className="md:col-span-2 xl:col-span-2">
                <Field label={copy("规格")}>
                  <input
                    readOnly={line.sourceType === "catalog_item"}
                    value={line.specificationSnapshot}
                    onChange={(e) =>
                      patchLine(index, {
                        specificationSnapshot: e.target.value,
                      })
                    }
                    style={line.sourceType === "catalog_item" ? { ...inputStyle, background: A.gray6 } : inputStyle}
                  />
                </Field>
              </div>
              {line.lineBasis === "quantity" && (
                <>
                  <Field label={copy("单位")}>
                    {line.sourceType === "catalog_item" ? <input readOnly value={line.unitSnapshot || ""} style={{ ...inputStyle, background: A.gray6 }} /> : <select value={line.unitSnapshot || ""} onChange={(e) => patchLine(index, { unitSnapshot: e.target.value })} style={inputStyle}><option value="">{copy("选择单位")}</option>{units.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}</select>}
                    {prefillChip(line, "unitSnapshot")}
                  </Field>
                  <Field label={copy("数量")}>
                    <input
                      type="number"
                      min="0"
                      value={line.quantity}
                      onChange={(e) =>
                        patchLine(index, { quantity: e.target.value })
                      }
                      style={inputStyle}
                    />
                    {prefillChip(line, "quantity")}
                  </Field>
                  <Field label={copy("预计单价")}>
                    <input
                      aria-label={`${copy("预计单价")} ${index + 1}`}
                      type="number"
                      min="0"
                      placeholder={copy("请输入")}
                      value={line.estimatedUnitPrice}
                      onChange={(e) =>
                        patchLine(index, {
                          estimatedUnitPrice: e.target.value,
                        })
                      }
                      style={inputStyle}
                    />
                    {prefillChip(line, "estimatedUnitPrice")}
                  </Field>
                </>
              )}
              {line.lineBasis === "amount" && (
                <div className="md:col-span-3 xl:col-span-3">
                  <Field label={copy("预计总金额")}>
                    <input
                      type="number"
                      min="0"
                      value={line.estimatedAmount}
                      onChange={(e) =>
                        patchLine(index, { estimatedAmount: e.target.value })
                      }
                      style={inputStyle}
                    />
                  </Field>
                </div>
              )}
              <div className="md:col-span-2 xl:col-span-2">
                <Field label={copy("目标仓库或服务地点")}>
                  <select
                    value={line.targetWarehouseId}
                    onChange={(e) =>
                      patchLine(index, { targetWarehouseId: e.target.value })
                    }
                    style={inputStyle}
                  >
                    <option value="">{copy("选择地点")}</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                  {prefillChip(line, "targetWarehouseId")}
                </Field>
              </div>
              <Field label={copy("需求日期")}>
                <input
                  type="date"
                  value={line.needByDate}
                  onChange={(e) =>
                    patchLine(index, { needByDate: e.target.value })
                  }
                  style={inputStyle}
                />
                {prefillChip(line, "needByDate")}
              </Field>
            </div>
            {/* Earlier PO prices for the item, beside the estimated unit price. Display only. */}
            {line.lineBasis === "quantity" && priceHistoryKeyOf(line) && (
              <div className="mt-3">
                <PriceHistoryFacts history={priceHistory.histories.get(priceHistoryKeyOf(line))} state={priceHistory.state} testId={`pr-line-price-history-${index + 1}`} />
              </div>
            )}
            <div className="mt-3">
              <Field label={copy("行级内部备注")}>
                <textarea
                  aria-label={`${copy("行级内部备注")} ${index + 1}`}
                  value={line.internalLineComment}
                  onChange={(e) =>
                    patchLine(index, { internalLineComment: e.target.value })
                  }
                  rows={2}
                  style={{ ...inputStyle, resize: "vertical" }}
                />
                {prefillChip(line, "internalLineComment")}
              </Field>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between px-5 py-3.5">
          <button
            type="button"
            onClick={() => setLines([...lines, makeLine(defaultDate)])}
            className={listButtonClass.secondary}
          >
            <Plus size={13} />{copy("新增采购行")}</button>
          <strong className="text-sm tabular-nums" style={{ color: A.label }}>{copy("预计总额")} {amount(total, currency)}
          </strong>
        </div>
      </ListCard>
    </div>
  );
}
