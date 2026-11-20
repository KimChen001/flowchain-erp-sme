import { useEffect, useMemo, useState } from "react";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { useLocation, useSearchParams } from "react-router";
import { useDetailBack } from "../../components/navigation/useDetailBack";
import { ListPager, usePagedRows } from "../procurement/listPaging";

const ITEM_PAGE_SIZE = 50;
import { AlertCircle, ArrowLeft, CheckCircle2, FileSpreadsheet, Package, Pencil, Plus, Truck } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { toast } from "sonner";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { RefreshButton, ResetButton, StatusChip, listButtonClass } from "../../components/ui/listLayout";
import {
  listTableCardsRef,
  tableBodyTextClass,
  tableLinkClass,
  tableScrollClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericRightClass,
  thClass,
  thRightClass,
} from "../../components/ui/workbenchTable";
import { EntityLink } from "../../components/business/EntityLink";
import { useMasterDataWriteAccess } from "./writeAccess";
import { DataImportLink } from "./DataImportLink";
import { exportMasterDataCsv } from "./export";
import { NOT_PROVIDED, useMasterDataCopy } from "./masterDataCopy";
import { useI18n } from "../../i18n/I18n";
import { unitLabel as sharedUnitLabel } from "../../i18n/unitLabels";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { apiErrorText } from "../../lib/apiErrorText";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { ItemStockAndOrders } from "./ItemStockAndOrders";
import { linkedFieldOptions, type LinkedOption } from "./linkedFieldOptions";

export type MasterItem = {
  itemId: string;
  sku: string;
  itemName: string;
  shortName: string;
  itemType: string;
  category: string;
  brand: string;
  specification: string;
  baseUnit: string;
  status: string;
  purchasable: boolean;
  inventoryItem: boolean;
  purchaseUnit: string;
  defaultWarehouseId: string;
  safetyStock: number;
  reorderPoint: number;
  orderUpToLevel: number | null;
  lotSize: number | null;
  minimumOrderQuantity: number;
  purchaseLeadTimeDays: number;
  defaultSupplierId: string;
  taxCodeId: string;
  barcode: string;
  manufacturerPartNumber: string;
  batchManaged: boolean;
  serialManaged: boolean;
  shelfLifeManaged: boolean;
  comments: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  // What someone recorded (null when nothing was); the fields above fill gaps
  // for display, such as pcs, an MOQ of 1 or zeros.
  recorded?: { unit: string | null; category: string | null; safetyStock: number | null; reorderPoint: number | null; orderUpToLevel?: number | null; lotSize?: number | null; minimumOrderQuantity: number | null; purchaseLeadTimeDays: number | null; purchaseUnit: string | null; itemType: string | null } | null;
};
// The edit form's values as typed: numbers stay text until saved, so an empty
// field is sent as null ("not recorded"), never 0.
type ItemDraft = Record<string, string | boolean>;
const NUMBER_FIELDS = ["safetyStock", "reorderPoint", "orderUpToLevel", "lotSize", "minimumOrderQuantity", "purchaseLeadTimeDays"];
const FLAG_FIELDS = ["purchasable", "inventoryItem", "batchManaged", "serialManaged", "shelfLifeManaged"];
// A new item starts with nothing made up: no unit, category or numbers until
// someone enters them (design audit L4-20: the unit defaulted to pcs).
const EMPTY_DRAFT: ItemDraft = { sku: "", itemName: "", shortName: "", itemType: "", category: "", brand: "", specification: "", baseUnit: "", purchaseUnit: "", defaultWarehouseId: "", taxCodeId: "", safetyStock: "", reorderPoint: "", orderUpToLevel: "", lotSize: "", minimumOrderQuantity: "", purchaseLeadTimeDays: "", barcode: "", manufacturerPartNumber: "", comments: "", status: "active", purchasable: true, inventoryItem: true, batchManaged: false, serialManaged: false, shelfLifeManaged: false };
// An item as the form edits it: the values someone recorded, read from
// `recorded`, not the display fill-ins (design audit L4-02).
function draftOf(item: MasterItem): ItemDraft {
  const recorded = item.recorded || null;
  const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
  return {
    ...EMPTY_DRAFT,
    sku: item.sku, itemName: item.itemName, shortName: item.shortName, brand: item.brand, specification: item.specification,
    itemType: recorded ? recorded.itemType || "" : item.itemType,
    category: recorded ? recorded.category || "" : item.category,
    baseUnit: recorded ? recorded.unit || "" : item.baseUnit,
    purchaseUnit: recorded ? recorded.purchaseUnit || "" : item.purchaseUnit,
    defaultWarehouseId: item.defaultWarehouseId, taxCodeId: item.taxCodeId, barcode: item.barcode, manufacturerPartNumber: item.manufacturerPartNumber, comments: item.comments,
    safetyStock: numberText(recorded ? recorded.safetyStock : item.safetyStock),
    reorderPoint: numberText(recorded ? recorded.reorderPoint : item.reorderPoint),
    orderUpToLevel: numberText(recorded?.orderUpToLevel ?? item.orderUpToLevel),
    lotSize: numberText(recorded?.lotSize ?? item.lotSize),
    minimumOrderQuantity: numberText(recorded ? recorded.minimumOrderQuantity : item.minimumOrderQuantity),
    purchaseLeadTimeDays: numberText(recorded ? recorded.purchaseLeadTimeDays : item.purchaseLeadTimeDays),
    status: item.status, purchasable: item.purchasable, inventoryItem: item.inventoryItem, batchManaged: item.batchManaged, serialManaged: item.serialManaged, shelfLifeManaged: item.shelfLifeManaged,
  };
}
// What a save sends: for a new item every field filled in; for an existing
// one only the fields changed, so changing the name writes nothing else (no
// pcs, no 0). An emptied number is sent as null.
export function itemSaveBody(draft: ItemDraft, initial: ItemDraft | null): Record<string, unknown> {
  const value = (key: string) => {
    const raw = draft[key];
    if (NUMBER_FIELDS.includes(key)) return String(raw ?? "").trim() === "" ? null : Number(raw);
    return typeof raw === "boolean" ? raw : String(raw ?? "").trim();
  };
  const keys = Object.keys(draft).filter((key) => (initial ? key !== "sku" && draft[key] !== initial[key] : FLAG_FIELDS.includes(key) || key === "status" || String(draft[key] ?? "").trim() !== ""));
  return Object.fromEntries(keys.map((key) => [key, value(key)]));
}
const FLAG_LABELS: Record<string, { en: string; zh: string }> = {
  purchasable: { en: "Purchasable", zh: "可采购" },
  inventoryItem: { en: "Inventory item", zh: "库存物料" },
};
const flagLabel = (key: string, language: string) => FLAG_LABELS[key]?.[language === "en-US" ? "en" : "zh"] || key;
// Item types and units are stored as codes; known ones are shown in the
// interface language and anything else as stored.
const ITEM_TYPE_LABELS: Record<string, string> = { material: "Material" };
// The reorder list reads a missing, zero or negative reorder point as none
// (server/domain/reorder-list.mjs); an emptied field is saved as none.
const hasReorderPoint = (item: MasterItem) => item.reorderPoint > 0;
type SupplierName = { id: string; supplierCode?: string; supplierName?: string };

// No item ID field: the server makes the id (design audit L4-20).
const fields: Array<[keyof MasterItem, string, string]> = [
  ["sku", "SKU 编码", "text"],
  ["itemName", "物料名称", "text"],
  ["shortName", "简称", "text"],
  ["itemType", "物料类型", "text"],
  ["category", "分类", "text"],
  ["brand", "品牌", "text"],
  ["specification", "规格型号", "text"],
  ["baseUnit", "基本单位", "text"],
  ["purchaseUnit", "采购单位", "text"],
  ["defaultWarehouseId", "默认仓库", "text"],
  ["taxCodeId", "税码", "text"],
  ["safetyStock", "安全库存", "number"],
  ["reorderPoint", "再订货点", "number"],
  // The (s, S) rule (design audit C3): empty, the reorder list assumes the
  // reorder point plus a week of demand.
  ["orderUpToLevel", "补货目标库存", "number"],
  ["lotSize", "订货批量", "number"],
  ["minimumOrderQuantity", "最小起订量", "number"],
  ["purchaseLeadTimeDays", "采购提前期（天）", "number"],
  ["barcode", "条码", "text"],
  ["manufacturerPartNumber", "制造商料号", "text"],
  ["comments", "管理备注", "text"],
];

function normalizeMasterItem(item: Partial<MasterItem> & Record<string, unknown>): MasterItem {
  const text = (value: unknown, fallback = "") => String(value ?? "").trim() || fallback;
  const number = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const itemId = text(item.itemId || item.id || item.sku);
  const sku = text(item.sku || itemId);
  const itemName = text(item.itemName || item.name || sku);
  const baseUnit = text(item.baseUnit || item.baseUom, "pcs");
  return {
    itemId,
    sku,
    itemName,
    shortName: text(item.shortName),
    itemType: text(item.itemType, "material"),
    category: text(item.category),
    brand: text(item.brand),
    specification: text(item.specification),
    baseUnit,
    status: text(item.status, "active"),
    purchasable: item.purchasable !== false,
    inventoryItem: item.inventoryItem !== false,
    purchaseUnit: text(item.purchaseUnit, baseUnit),
    defaultWarehouseId: text(item.defaultWarehouseId),
    safetyStock: number(item.safetyStock),
    reorderPoint: number(item.reorderPoint),
    orderUpToLevel: item.orderUpToLevel === null || item.orderUpToLevel === undefined || !Number.isFinite(Number(item.orderUpToLevel)) ? null : Number(item.orderUpToLevel),
    lotSize: item.lotSize === null || item.lotSize === undefined || !Number.isFinite(Number(item.lotSize)) ? null : Number(item.lotSize),
    minimumOrderQuantity: number(item.minimumOrderQuantity ?? item.moq, 1),
    purchaseLeadTimeDays: number(item.purchaseLeadTimeDays ?? item.leadTimeDays),
    defaultSupplierId: text(item.defaultSupplierId || item.preferredSupplierId),
    taxCodeId: text(item.taxCodeId),
    barcode: text(item.barcode),
    manufacturerPartNumber: text(item.manufacturerPartNumber),
    batchManaged: Boolean(item.batchManaged),
    serialManaged: Boolean(item.serialManaged),
    shelfLifeManaged: Boolean(item.shelfLifeManaged),
    comments: text(item.comments),
    version: number(item.version, 1),
    createdBy: text(item.createdBy, "system"),
    createdAt: text(item.createdAt),
    updatedBy: text(item.updatedBy, "system"),
    updatedAt: text(item.updatedAt),
    recorded: (item.recorded as MasterItem["recorded"]) || null,
  };
}

export default function ItemMasterWorkbench({
  focus,
  onNavigate,
}: {
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (routeId: string, focus?: unknown) => void;
}) {
  const { copy, language, locale } = useMasterDataCopy();
  const { formatDateTime, formatNumber } = useI18n();
  // Records written by an import or a seed name "system" as their author.
  const actorName = (value?: string | null) => (!value || value === "system" ? (language === "en-US" ? "System" : "系统") : value);
  const warehouseName = useWarehouseNames();
  // Creating and editing items needs master_data.item.manage.
  const canEdit = useMasterDataWriteAccess().items;
  const [items, setItems] = useState<MasterItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The warehouses and tax codes the form offers (null when they could not
  // load: the fields are then typed, as before).
  const [warehouseOptions, setWarehouseOptions] = useState<LinkedOption[] | null>([]);
  const [taxCodeOptions, setTaxCodeOptions] = useState<LinkedOption[] | null>([]);
  useEffect(() => {
    apiJson<{ warehouses?: Array<{ id: string; code?: string; name?: string; status?: string }> }>("/api/master-data/warehouses")
      .then((result) => setWarehouseOptions((result.warehouses || []).filter((row) => row.id && (row.status || "active") === "active").map((row) => ({ value: row.id, label: [row.code, row.name].filter(Boolean).join(" · ") || row.id }))))
      .catch(() => setWarehouseOptions(null));
    apiJson<{ taxCodes?: Array<{ code: string; name?: string; status?: string }> }>("/api/master-data/tax-codes")
      .then((result) => setTaxCodeOptions((result.taxCodes || []).filter((row) => row.code && (row.status || "active") === "active").map((row) => ({ value: row.code, label: [row.code, row.name].filter(Boolean).join(" · ") }))))
      .catch(() => setTaxCodeOptions(null));
  }, []);
  // Supplier names for the preferred supplier column; ids when unavailable.
  const [suppliers, setSuppliers] = useState<Map<string, SupplierName>>(new Map());
  const [selected, setSelected] = useState<MasterItem | null>(null);
  // The breadcrumb names the item by its SKU, as the list does, never its stored id.
  useDetailCrumb(selected ? `${selected.sku} · ${selected.itemName}` : null);
  // On the item's own page (/app/master-data/items/:id) the item is the page
  // title (H1); opened in place from the list it sits under the list's H1.
  const pathname = useLocation().pathname;
  const onDetailRoute = /^\/app\/master-data\/items\/[^/]+$/.test(pathname);
  const ItemTitle = onDetailRoute ? "h1" : "h2";
  const detailBack = useDetailBack("/app/master-data/items", ["Back to items", "返回 SKU 列表"], () => setSelected(null));
  // A failed request in the interface language, never the server's own words.
  const loadFailed = (cause: unknown) => apiErrorText(cause, language, ["Could not load items. Try again.", copy("Could not load items. Try again.")]);
  // The form's values and what they were when it opened (null for a new item).
  const [editing, setEditing] = useState<ItemDraft | null>(null);
  const [editingFrom, setEditingFrom] = useState<ItemDraft | null>(null);
  const startEditing = (item: MasterItem | null) => { const draft = item ? draftOf(item) : { ...EMPTY_DRAFT }; setEditing(draft); setEditingFrom(item ? draft : null); };
  const [query, setQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") || "";
  const gap = searchParams.get("gap") || "";
  const setParam = (name: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(name, value); else params.delete(name);
    setSearchParams(params, { replace: true });
  };
  const setStatus = (value: string) => setParam("status", value);
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    const result = await apiJson<{ items: MasterItem[] }>(
      "/api/master-data/items?managed=true",
    );
    setItems((result.items || []).map((item) => normalizeMasterItem(item)));
    setLoaded(true);
  };
  useEffect(() => {
    load().catch((cause) => setError(loadFailed(cause)));
    apiJson<{ suppliers?: SupplierName[] }>("/api/master-data/suppliers")
      .then((result) => setSuppliers(new Map((result.suppliers || []).map((row) => [row.id, row]))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!focus?.entityId || focus.entityType !== "item" || !items.length)
      return;
    const key = String(focus.entityId || "").toLowerCase();
    const item = items.find((row) =>
      [row.itemId, row.sku].some((value) => String(value || "").toLowerCase() === key),
    );
    if (item) setSelected(item);
  }, [focus?.at, focus?.entityId, focus?.entityType, items]);
  const shown = useMemo(
    () =>
      items.filter(
        (item) =>
          (!query ||
            `${item.sku || ""} ${item.itemName || ""}`
              .toLowerCase()
              .includes(query.toLowerCase())) &&
          (!status || item.status === status) &&
          (!type || item.itemType === type) &&
          (!category || item.category === category) &&
          (!gap || (item.status === "active" && (gap === "reorder" ? !hasReorderPoint(item) : gap === "supplier" ? !item.defaultSupplierId : true))),
      ),
    [items, query, status, type, category, gap],
  );
  // One page of the list is drawn, as on the other long lists; the search and
  // filters run over every item, and a new search starts at page 1.
  const paged = usePagedRows(shown, ITEM_PAGE_SIZE, [query, status, type, category, gap].join("|"));
  const distinct = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, locale));
  const types = useMemo(() => distinct(items.map((item) => item.itemType)), [items, locale]);
  const categories = useMemo(() => distinct(items.map((item) => item.category)), [items, locale]);
  const typeLabel = (code: string) => copy(ITEM_TYPE_LABELS[code] || code);
  // The shared unit words ("box" / "箱"); a unit not listed shows as stored.
  const unitLabel = (code: string) => sharedUnitLabel(code, language, 1);
  const supplierLabel = (id: string) => {
    if (!id) return NOT_PROVIDED;
    const supplier = suppliers.get(id);
    return supplier?.supplierName || supplier?.supplierCode || id;
  };
  const quantity = (value: number) => value.toLocaleString(locale);
  const statusLabel = (code: string) => copy(code === "active" ? "Active" : code === "inactive" ? "Inactive" : code);
  const activeCount = items.filter((item) => item.status === "active").length;
  const filtered = Boolean(query || status || type || category || gap);
  const resetFilters = () => {
    setQuery(""); setType(""); setCategory("");
    const params = new URLSearchParams(searchParams);
    params.delete("status"); params.delete("gap");
    setSearchParams(params, { replace: true });
  };
  const save = async () => {
    if (!editing) return;
    try {
      const isNew = !selected;
      const url = isNew
        ? "/api/master-data/items"
        : `/api/master-data/items/${encodeURIComponent(selected.itemId)}`;
      const result = await apiJson<{ item: MasterItem & { nameAlsoUsedBy?: Array<{ code: string }> } }>(url, {
        method: isNew ? "POST" : "PATCH",
        body: JSON.stringify({
          ...itemSaveBody(editing, isNew ? null : editingFrom),
          ...(isNew ? {} : { expectedVersion: selected?.version }),
        }),
      });
      // Saved either way; a name another item has is worth a second look (design audit L4-18).
      const same = result.item.nameAlsoUsedBy || [];
      if (same.length) toast.warning(copy("Another item already has this name: {codes}", { codes: same.map((row) => row.code).join(", ") }));
      setSelected(result.item);
      setEditing(null);
      setError("");
      await load();
    } catch (cause) {
      setError(apiErrorText(cause, language, ["Could not save the item. Check the fields and try again.", copy("Could not save the item. Check the fields and try again.")]));
    }
  };
  if (editing)
    return (
      <Card className="p-5">
        <FocusFirstField />
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">
              {selected ? `${copy("编辑")} ${selected.sku}` : copy("New item")}
            </h2>
            <p className="text-xs" style={{ color: A.sub }}>
              {copy("基础信息、采购库存属性与追踪属性")}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(null)}>{copy("取消")}</button>
            <button
              className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
              onClick={save}
            >
              {copy("保存")}
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {fields.map(([key, label, inputType]) => {
            // A field that names a warehouse or a tax code is chosen from the
            // workspace's own, not typed (the server wants the warehouse's id).
            const linked = key === "defaultWarehouseId" ? warehouseOptions : key === "taxCodeId" ? taxCodeOptions : null;
            if (linked) return (
              <Field key={key} label={copy(label)}>
                <select aria-label={copy(label)} data-testid={`item-field-${key}`} value={String(editing[key] ?? "")} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} style={inputStyle}>
                  <option value="">{copy("Not set")}</option>
                  {linkedFieldOptions(linked, String(editing[key] ?? "")).map((option) => <option key={option.value} value={option.value}>{option.unknown ? `${option.label} (${copy("not in the list")})` : option.label}</option>)}
                </select>
              </Field>
            );
            return (
            <Field key={key} label={copy(label)}>
              <input
                aria-label={copy(label)}
                // The SKU is locked once the item exists (design audit L4-20).
                disabled={Boolean(selected) && key === "sku"}
                title={selected && key === "sku" ? copy("The SKU cannot change once the item exists.") : undefined}
                type={inputType}
                value={String(editing[key] ?? "")}
                onChange={(event) => setEditing({ ...editing, [key]: event.target.value })}
                style={inputStyle}
              />
            </Field>
            );
          })}
          <Field label={copy("状态")}>
            <select
              value={String(editing.status)}
              onChange={(e) =>
                setEditing({ ...editing, status: e.target.value })
              }
              style={inputStyle}
            >
              <option value="active">{copy("启用")}</option>
              <option value="inactive">{copy("停用")}</option>
            </select>
          </Field>
          {(
            [
              "purchasable",
              "inventoryItem",
              // Batch, serial and shelf-life tracking are not built yet: no receipt,
              // shipment or count records a lot, serial or expiry date, so the
              // switches stay hidden and stored values are kept (design audit L3-13).
            ] as const
          ).map((key) => (
            <label key={key} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={Boolean(editing[key])}
                onChange={(e) =>
                  setEditing({ ...editing, [key]: e.target.checked })
                }
              />
              {flagLabel(key, language)}
            </label>
          ))}
        </div>
      </Card>
    );
  // A detail value as a person reads it: the type and unit labels, the
  // warehouse name and workspace-formatted numbers. Stored values are unchanged.
  const detailValue = (item: MasterItem, key: keyof MasterItem) => {
    const value = item[key];
    if (value === null || value === undefined || value === "") return NOT_PROVIDED;
    if (key === "itemType") return typeLabel(String(value));
    if (key === "baseUnit" || key === "purchaseUnit") return unitLabel(String(value));
    if (key === "defaultWarehouseId") return warehouseName(String(value)) || NOT_PROVIDED;
    if (typeof value === "number") return quantity(value);
    return String(value);
  };
  // Audit times in the workspace locale and timezone.
  const auditTime = (value: string) => {
    if (!value || Number.isNaN(new Date(value).getTime())) return NOT_PROVIDED;
    return formatDateTime(value);
  };
  // On an item's own address, wait for the item rather than drawing the list
  // and its empty counts first; an address that names no item shows the list.
  const routeKey = onDetailRoute ? decodeURIComponent(pathname.split("/").pop() || "").toLowerCase() : "";
  const routeNamesItem = !loaded || items.some((row) => [row.itemId, row.sku].some((value) => String(value || "").toLowerCase() === routeKey));
  if (!selected && onDetailRoute && !error && routeNamesItem)
    return <Card className="p-5" data-testid="item-detail-loading"><p className="text-sm" style={{ color: A.sub }}>{copy("Loading item…")}</p></Card>;
  if (selected)
    return (
      <div className="space-y-4">
      {/* Above the card, as on the other detail pages (BackToListLink). */}
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline max-sm:min-h-9"
        onClick={detailBack.back}
      >
        <ArrowLeft size={13} />{detailBack.label}
      </button>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ItemTitle className={onDetailRoute ? "fc-page-title" : "text-base font-semibold"} style={{ color: A.label }} data-testid="item-detail-title">
                {selected.sku} · {selected.itemName}
              </ItemTitle>
              <StatusChip label={statusLabel(selected.status)} tone={selected.status === "active" ? "success" : "neutral"} />
            </div>
            <p className="mt-1 text-xs" style={{ color: A.sub }} data-testid="item-detail-version">
              v{selected.version}
            </p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => startEditing(selected)}
              className={listButtonClass.secondary}
            >
              <Pencil size={13} />
              {copy("Edit item")}
            </button>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {fields.map(([key, label]) => (
            <div key={key} className="rounded-lg bg-slate-50 p-3">
              <div className="text-[11px] text-slate-500">{copy(label)}</div>
              <div className="mt-1 text-xs font-medium">
                {detailValue(selected, key)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-xs text-slate-500">
          {copy("Created: {by} · {at}", { by: actorName(selected.createdBy), at: auditTime(selected.createdAt) })}
          <br />
          {copy("Updated: {by} · {at}", { by: actorName(selected.updatedBy), at: auditTime(selected.updatedAt) })}
        </div>
      </Card>
      {/* Its stock per warehouse, latest movements and orders still to ship. */}
      <ItemStockAndOrders itemId={selected.itemId} sku={selected.sku} baseUnit={selected.baseUnit} />
      </div>
    );
  // Laid out like the other list pages (purchase orders, sales orders):
  // item-level counts, a search card with labelled filters, then the list.
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={copy("Items")} value={loaded ? String(items.length) : "—"} description={loaded ? copy("{count} active", { count: activeCount }) : NOT_PROVIDED} to="/app/master-data/items" icon={Package} color={A.blue} />
        <ActionableMetricCard label={copy("Inactive items")} value={loaded ? String(items.length - activeCount) : "—"} description={copy("Kept for history, not offered on new documents")} to="/app/master-data/items?status=inactive" icon={CheckCircle2} color={A.gray1} />
        <ActionableMetricCard label={copy("No reorder point")} value={loaded ? String(items.filter((item) => item.status === "active" && !hasReorderPoint(item)).length) : "—"} description={copy("Active items the reorder list cannot check")} to="/app/master-data/items?gap=reorder" icon={AlertCircle} color={A.orange} />
        <ActionableMetricCard label={copy("No preferred supplier")} value={loaded ? String(items.filter((item) => item.status === "active" && !item.defaultSupplierId).length) : "—"} description={copy("Active items without a supplier to order from")} to="/app/master-data/items?gap=supplier" icon={Truck} color={A.purple} />
      </div>

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Item search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Search items by SKU, name, status, type and category.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ResetButton onClick={resetFilters} />
            <RefreshButton onClick={() => { load().catch((cause) => setError(loadFailed(cause))); }} />
            <button type="button" onClick={() => exportMasterDataCsv("items", { items: shown.map((item) => ({ ...item, preferredSupplierName: item.defaultSupplierId ? supplierLabel(item.defaultSupplierId) : "" })) }, copy)} className={listButtonClass.export}>
              <FileSpreadsheet size={13} /> {copy("Export results")}
            </button>
            <DataImportLink type="items" className={listButtonClass.secondary} />
            {canEdit && (
              <button
                type="button"
                className={listButtonClass.primary}
                onClick={() => {
                  setSelected(null);
                  startEditing(null);
                }}
              >
                <Plus size={13} />{copy("New item")}
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
          <Field label={copy("Search")}>
            <input aria-label={copy("Search items")} placeholder={copy("搜索 SKU 编码或物料名称")} value={query} onChange={(e) => setQuery(e.target.value)} style={inputStyle} />
          </Field>
          <Field label={copy("Status")}>
            <select aria-label={copy("状态筛选")} value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              <option value="">{copy("全部状态")}</option>
              <option value="active">{copy("Active")}</option>
              <option value="inactive">{copy("Inactive")}</option>
            </select>
          </Field>
          <Field label={copy("Type")}>
            <select aria-label={copy("Filter by type")} value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
              <option value="">{copy("All types")}</option>
              {types.map((code) => <option key={code} value={code}>{typeLabel(code)}</option>)}
            </select>
          </Field>
          <Field label={copy("Category")}>
            <select aria-label={copy("Filter by category")} value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
              <option value="">{copy("All categories")}</option>
              {categories.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label={copy("Setup gap")}>
            <select aria-label={copy("Filter by setup gap")} value={gap} onChange={(e) => setParam("gap", e.target.value)} style={inputStyle}>
              <option value="">{copy("All items")}</option>
              <option value="reorder">{copy("No reorder point")}</option>
              <option value="supplier">{copy("No preferred supplier")}</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{copy("Item list")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{loaded ? copy(items.length === 1 ? "1 item, {shown} shown" : "{total} items, {shown} shown", { total: formatNumber(items.length), shown: formatNumber(paged.pageRows.length) }) : NOT_PROVIDED}</div>
          </div>
        </div>
        {error && <p className="px-5 pt-3 text-xs text-red-600">{error}</p>}
        <div className={tableScrollClass} ref={listTableCardsRef}>
          <table className={`w-full min-w-[1080px] text-left ${tableBodyTextClass}`} data-testid="item-list-table">
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>SKU</th>
                {["Item name", "Category", "Unit"].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                {/* The long header wraps to two lines, as on the inventory balances page. */}
                <th className={`${thRightClass} !whitespace-normal w-[130px]`} style={{ color: A.gray1 }}>{copy("Safety stock / reorder point")}</th>
                {["MOQ", "Lead time"].map((label) => <th key={label} className={thRightClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                <th className={thClass} style={{ color: A.gray1 }}>{copy("Preferred supplier")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("Status")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{copy("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {loaded && !error && shown.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>
                    {filtered ? copy("No items match these filters") : (
                      <>
                        <span className="font-semibold" style={{ color: A.label }}>{copy("暂无物料资料")}</span>
                        <br />
                        <span className="text-xs">{copy("Create an item or import a file of items to get started.")}</span>
                      </>
                    )}
                  </td>
                </tr>
              )}
              {paged.pageRows.map((item, index) => (
                <tr key={item.itemId} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < paged.pageRows.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                    <EntityLink kind="item" id={item.itemId} className={tableLinkClass}>
                      {item.sku}
                    </EntityLink>
                  </td>
                  <td className={`${tdNameClass} max-w-[260px]`} title={item.specification ? `${item.itemName} · ${item.specification}` : item.itemName}>
                    <div className="truncate font-medium" style={{ color: A.label }}>{item.itemName}</div>
                    {item.specification && <div className="truncate text-[11px]" style={{ color: A.sub }}>{item.specification}</div>}
                  </td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{item.category || copy("Uncategorized")}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{unitLabel(item.baseUnit)}</td>
                  <td className={tdNumericRightClass}>
                    {quantity(item.safetyStock)} / {hasReorderPoint(item) ? quantity(item.reorderPoint) : <span title={copy("Not set: the reorder list does not check this item")} style={{ color: A.gray2 }}>{NOT_PROVIDED}</span>}
                  </td>
                  <td className={tdNumericRightClass}>{quantity(item.minimumOrderQuantity)}</td>
                  <td className={tdNumericRightClass}>{item.purchaseLeadTimeDays > 0 ? copy("{count} days", { count: quantity(item.purchaseLeadTimeDays) }) : <span style={{ color: A.gray2 }}>{NOT_PROVIDED}</span>}</td>
                  <td className={`${tdNameClass} max-w-[200px] truncate`}>
                    {item.defaultSupplierId
                      ? <EntityLink kind="supplier" id={item.defaultSupplierId} className={tableLinkClass}>{supplierLabel(item.defaultSupplierId)}</EntityLink>
                      : <span style={{ color: A.gray2 }}>{NOT_PROVIDED}</span>}
                  </td>
                  <td className={tdNowrapClass}>
                    {item.status === "active"
                      ? <Chip label={statusLabel(item.status)} color={A.green} bg="#f0faf4" />
                      : <Chip label={statusLabel(item.status)} color={A.gray1} bg={A.gray6} />}
                  </td>
                  <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => setSelected(item)} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">
                        {copy("View")}
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium"
                          onClick={() => {
                            setSelected(item);
                            startEditing(item);
                          }}
                        >
                          {copy("编辑")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListPager page={paged.page} pageSize={ITEM_PAGE_SIZE} total={shown.length} onPage={paged.setPage} testId="item-list-pager" />
      </Card>
    </div>
  );
}
