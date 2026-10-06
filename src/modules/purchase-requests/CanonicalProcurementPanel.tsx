import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useI18n } from "../../i18n/I18n";
import { formatLocaleAmount, todayInTimeZone } from "../../lib/format";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { orderedCurrencyCodes } from "../../lib/currencyOptions";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { tableLinkClass } from "../../components/ui/workbenchTable";
import { createClientTemporaryId } from "../../lib/client-id";
import { PrefillBanner, PrefillSourceChip } from "../../components/prefill/PrefillSource";
import { buildSuggestionTrail, planPurchaseRequestPrefill, type PrefillEntry, type PrefillOrigin, type SupplierChoice, type SupplierLastOrder } from "../../lib/prefill";
import { SupplierChoices } from "../../components/procurement/SupplierChoices";
import { SupplierOverrideCount, SupplierOverrideFlag, SupplierOverrideReason, supplierOverrideIssueText, type SupplierOverride } from "../../components/procurement/SupplierOverrideReason";
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
  id: string;
  status: string;
  version: number;
  requesterId: string;
  departmentId: string;
  defaultCurrency: string;
  defaultNeedByDate: string;
  totalAmount: number;
  lines: Line[];
  linkedPurchaseOrderIds?: string[];
};
type FieldError = { field?: string; code?: string; message?: string };
const OVERRIDE_FIELD = /^lines\.(\d+)\.supplierOverride\.(reasonCode|note)$/;
// The line fields a handoff (the assistant's purchase request draft) can fill.
type PrefillLineField = "itemId" | "supplierId" | "quantity" | "estimatedUnitPrice" | "targetWarehouseId" | "needByDate" | "internalLineComment";
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
  const [searchParams] = useSearchParams();
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
    [saving, setSaving] = useState(false);
  const currencyInitialized = useRef(false);
  const selected =
    focus?.entityType === "purchase_request"
      ? rows.find((row) => row.id === focus.entityId)
      : null;
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
    if (prefilled.current === handoff || !items.length) return;
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
  }, [items, searchParams, location.key]);
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
  const selectItem = async (index: number, value: string) => {
    const item = items.find((row) => (row.itemId || row.id) === value);
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
    const preferred = result.suppliers.find((s) => s.preferred);
    if (preferred)
      patchLine(index, {
        supplierId: preferred.id,
        estimatedUnitPrice: preferred.referencePrice
          ? String(preferred.referencePrice)
          : "",
        currency: preferred.currency || currency,
      });
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
      reset();
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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  if (selected)
    return (
      <div className="space-y-4 pb-16">
        <button onClick={() => onNavigate?.("procurement:requests")}>{copy("返回采购申请列表")}</button>
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-semibold">{selected.id}</h1>
              <p className="mt-1 text-xs" style={{ color: A.sub }}>
                {copy(selected.status)} · v{selected.version} · {selected.requesterId}
              </p>
            </div>
            <strong>
              {amount(selected.totalAmount, selected.defaultCurrency)}
            </strong>
          </div>
          <h2 className="mt-5 text-sm font-semibold">{copy("采购行")}</h2>
          <div className="mt-2 divide-y">
            {selected.lines.map((line) => (
              <div
                key={line.lineId}
                className="grid gap-2 py-3 text-xs md:grid-cols-6"
              >
                <span>{line.sku || "Other"}</span>
                <span>{line.itemNameSnapshot}</span>
                <span className="flex flex-col gap-1">
                  <span>{line.supplierSnapshot?.supplierName || line.supplierId}</span>
                  <SupplierOverrideFlag override={line.supplierOverride} testId="pr-line-supplier-override" />
                </span>
                <span>
                  {line.lineBasis === "quantity"
                    ? `${line.quantity} × ${amount(line.estimatedUnitPrice, line.currency || selected.defaultCurrency)}`
                    : amount(line.estimatedAmount, line.currency || selected.defaultCurrency)}
                </span>
                <span>{warehouseName(line.targetWarehouseId) || "-"}</span>
                <span>{line.internalLineComment || "-"}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{copy("关联采购订单")}</h2>
          {!selected.linkedPurchaseOrderIds?.length ? (
            <div className="py-8 text-center text-xs" style={{ color: A.sub }}>{copy("暂无关联采购订单")}</div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {selected.linkedPurchaseOrderIds.map((id) => (
                <EntityLink key={id} kind="purchase_order" id={id} className="text-sm text-blue-600">
                  {id}
                </EntityLink>
              ))}
            </div>
          )}
        </Card>
      </div>
    );
  return (
    <div className="space-y-4 pb-16">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              {editing ? `${copy("编辑采购申请")} ${editing.id}` : copy("新建采购申请")}
            </h2>
            <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("每一行均需明确物料或服务、供应商、金额、交付地点和需求日期。")}</p>
          </div>
          <div className="flex gap-2">
            <button
              aria-label={copy("刷新主数据")}
              title={copy("刷新主数据")}
              onClick={() => load()}
              className="rounded-md border p-2"
            >
              <RefreshCw size={15} />
            </button>
            <button
              disabled={saving}
              onClick={() => save(false)}
              className="rounded-md bg-slate-100 px-3 py-2 text-xs"
            >{copy("保存草稿")}</button>
            <button
              disabled={saving}
              onClick={() => save(true)}
              className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
            >{copy("保存并提交")}</button>
          </div>
        </div>
        {prefill && !editing ? <PrefillBanner origin={prefill.origin} intent={prefill.intent} /> : null}
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label={copy("申请人")}>
            <input
              aria-label={copy("申请人")}
              readOnly
              value={copy("由服务端当前用户确定")}
              style={{ ...inputStyle, background: A.gray6 }}
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
        {errors.length > 0 && (
          <div
            role="alert"
            className="mt-3 rounded-md bg-red-50 p-3 text-xs text-red-700"
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
        <div className="mt-4 space-y-3">
          {lines.map((line, index) => (
            <div key={line.lineId} className="rounded-md border p-3">
              <div className="mb-3 flex items-center justify-between">
                <strong className="text-xs">{copy("采购行")} {index + 1}</strong>
                <button
                  aria-label={`${copy("删除采购行")} ${index + 1}`}
                  title={copy("删除采购行")}
                  onClick={() => {
                    if (
                      lines.length > 1 &&
                      window.confirm(copy("确认删除该采购行？"))
                    )
                      setLines(lines.filter((_, i) => i !== index));
                  }}
                  className="p-1 text-red-600"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="grid gap-2 md:grid-cols-6">
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
                    <option value="non_catalog_item">{copy("Other / 非目录")}</option>
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
                <Field label="SKU / Other">
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
                    <span className="block py-2 text-xs">{copy("非目录")}</span>
                  )}
                  {prefillChip(line, "itemId")}
                </Field>
                <Field label={copy("供应商")}>
                  <select
                    aria-label={`${copy("供应商")} ${index + 1}`}
                    value={line.supplierId}
                    onChange={(e) =>
                      // A reason belongs to the supplier it was given for.
                      patchLine(index, { supplierId: e.target.value, supplierOverride: null })
                    }
                    style={inputStyle}
                  >
                    <option value="">{copy("选择供应商")}</option>
                    {supplierOptions(line).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.preferred ? " · Preferred" : ""}
                      </option>
                    ))}
                  </select>
                  {prefillChip(line, "supplierId")}
                  {prefill && !editing && line.lineId === prefill.lineId && line.itemId && line.itemId === prefill.fields.itemId?.value ? (
                    <SupplierChoices
                      choices={prefill.supplierChoices}
                      selectedId={line.supplierId}
                      onChoose={(supplierId) => patchLine(index, supplierId === line.supplierId ? {} : { supplierId, supplierOverride: null })}
                    />
                  ) : null}
                  {needsReason(line) || (line.sourceType === "catalog_item" && hasOverrideIssue(index)) ? (
                    <SupplierOverrideReason
                      testId={`supplier-override-reason-${index + 1}`}
                      preferredName={preferredNames(line)}
                      value={line.supplierOverride}
                      issues={overrideIssues(index)}
                      onChange={(supplierOverride) =>
                        patchLine(index, {
                          supplierOverride: {
                            ...supplierOverride,
                            preferredSupplierId: preferredOf(line)[0]?.id || null,
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
                <Field label={copy("物料名称 / 描述")}>
                  <input
                    readOnly={line.sourceType === "catalog_item"}
                    value={line.itemNameSnapshot}
                    onChange={(e) =>
                      patchLine(index, { itemNameSnapshot: e.target.value })
                    }
                    style={inputStyle}
                  />
                </Field>
                <Field label={copy("品类")}>
                  {line.sourceType === "catalog_item" ? <input readOnly value={line.commodityId} style={inputStyle} /> : <select value={line.commodityId} onChange={(e) => patchLine(index, { commodityId: e.target.value })} style={inputStyle}><option value="">{copy("选择品类")}</option>{commodities.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}</select>}
                </Field>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-6">
                {line.lineBasis === "quantity" && (
                  <>
                    <Field label={copy("单位")}>
                      {line.sourceType === "catalog_item" ? <input readOnly value={line.unitSnapshot || ""} style={inputStyle} /> : <select value={line.unitSnapshot || ""} onChange={(e) => patchLine(index, { unitSnapshot: e.target.value })} style={inputStyle}><option value="">{copy("选择单位")}</option>{units.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}</select>}
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
                )}
                <Field label={copy("规格")}>
                  <input
                    readOnly={line.sourceType === "catalog_item"}
                    value={line.specificationSnapshot}
                    onChange={(e) =>
                      patchLine(index, {
                        specificationSnapshot: e.target.value,
                      })
                    }
                    style={inputStyle}
                  />
                </Field>
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
                <div className="mt-2">
                  <PriceHistoryFacts history={priceHistory.histories.get(priceHistoryKeyOf(line))} state={priceHistory.state} testId={`pr-line-price-history-${index + 1}`} />
                </div>
              )}
              <Field label={copy("行级内部备注")}>
                <textarea
                  aria-label={`${copy("行级内部备注")} ${index + 1}`}
                  value={line.internalLineComment}
                  onChange={(e) =>
                    patchLine(index, { internalLineComment: e.target.value })
                  }
                  className="mt-2 min-h-16 w-full rounded-md border p-2 text-xs"
                />
                {prefillChip(line, "internalLineComment")}
              </Field>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={() => setLines([...lines, makeLine(defaultDate)])}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs"
          >
            <Plus size={14} />{copy("新增采购行")}</button>
          <strong className="text-sm">{copy("预计总额")} {amount(total, currency)}
          </strong>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-sm font-semibold">{copy("采购申请")}</h2>
          <span className="text-xs" style={{ color: A.sub }}>
            {rows.length} {copy("张")}</span>
        </div>
        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: A.sub }}>{copy("暂无采购申请")}<br />
            <span className="text-xs">{copy("点击“新建采购申请”开始录入。")}</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {["申请编号", "申请人", "状态", "金额", "操作"].map((h) => (
                    <th key={h} className="p-3 text-left">
                      {copy(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((pr) => (
                  <tr key={pr.id} className="border-t">
                    <td className="p-3">
                      <EntityLink kind="purchase_request" id={pr.id} className={tableLinkClass}>
                        {pr.id}
                      </EntityLink>
                    </td>
                    <td className="p-3">{pr.requesterId}</td>
                    <td className="p-3">
                      {copy(pr.status)}
                      <SupplierOverrideCount count={pr.lines.filter((line) => line.supplierOverride?.reasonCode).length} testId="pr-row-supplier-overrides" />
                      {/* Approve on this row skips the detail, so the row shows each reason too. */}
                      {pr.lines.some((line) => line.supplierOverride?.reasonCode) ? (
                        <div className="mt-1 flex flex-col items-start gap-1">
                          {pr.lines.filter((line) => line.supplierOverride?.reasonCode).map((line, lineIndex) => (
                            <SupplierOverrideFlag
                              key={line.lineId || lineIndex}
                              override={line.supplierOverride}
                              prefix={`${line.sku || line.itemNameSnapshot} · ${line.supplierSnapshot?.supplierName || line.supplierId}`}
                              testId="pr-row-supplier-override"
                            />
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="p-3">{amount(pr.totalAmount, pr.defaultCurrency)}</td>
                    <td className="p-3 space-x-2">
                      {pr.status === "draft" && (
                        <>
                          <button onClick={() => edit(pr)}>{copy("编辑")}</button>
                          <button onClick={() => act(pr, "submit")}>{copy("提交")}</button>
                        </>
                      )}
                      {pr.status === "submitted" && (
                        <>
                          <button onClick={() => act(pr, "approve")}>{copy("批准")}</button>
                          <button onClick={() => act(pr, "reject")}>{copy("拒绝")}</button>
                          <button onClick={() => act(pr, "withdraw")}>{copy("撤回")}</button>
                        </>
                      )}
                      {pr.status === "approved" && (
                        <button
                          onClick={() => act(pr, "generate-purchase-orders")}
                        >{copy("生成 Draft PO")}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
