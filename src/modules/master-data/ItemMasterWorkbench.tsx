import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Package, Truck } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, KpiCard, inputStyle } from "../../components/ui";
import {
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
import { ResponsiveFilters } from "../../components/business/ResponsiveFilters";
import { useMasterDataWriteAccess } from "./writeAccess";
import { DataImportLink } from "./DataImportLink";
import { exportMasterDataCsv } from "./export";
import { NOT_PROVIDED, useMasterDataCopy } from "./masterDataCopy";

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
};
// Stored defaults are language-neutral: no category until one is chosen, and
// the unit code "pcs" (shown translated), so an English user never stores 件.
const empty: Partial<MasterItem> = {
  itemType: "material",
  category: "",
  baseUnit: "pcs",
  purchaseUnit: "pcs",
  status: "active",
  purchasable: true,
  inventoryItem: true,
};
const FLAG_LABELS: Record<string, { en: string; zh: string }> = {
  purchasable: { en: "Purchasable", zh: "可采购" },
  inventoryItem: { en: "Inventory item", zh: "库存物料" },
  batchManaged: { en: "Batch managed", zh: "批次管理" },
  serialManaged: { en: "Serial managed", zh: "序列号管理" },
  shelfLifeManaged: { en: "Shelf-life managed", zh: "保质期管理" },
};
const flagLabel = (key: string, language: string) => FLAG_LABELS[key]?.[language === "en-US" ? "en" : "zh"] || key;
// Item types and units are stored as codes; known ones are shown in the
// interface language and anything else as stored.
const ITEM_TYPE_LABELS: Record<string, string> = { material: "Material" };
const UNIT_LABELS: Record<string, { en: string; zh: string }> = { pcs: { en: "pcs", zh: "件" } };
// The reorder list reads a missing, zero or negative reorder point as none
// (server/domain/reorder-list.mjs), and the form saves 0 for an empty field.
const hasReorderPoint = (item: MasterItem) => item.reorderPoint > 0;
type SupplierName = { id: string; supplierCode?: string; supplierName?: string };

const fields: Array<[keyof MasterItem, string, string]> = [
  ["itemId", "物料 ID", "text"],
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
  ["minimumOrderQuantity", "最小订购量", "number"],
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
  // Creating and editing items needs master_data.item.manage.
  const canEdit = useMasterDataWriteAccess().items;
  const [items, setItems] = useState<MasterItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Supplier names for the preferred supplier column; ids when unavailable.
  const [suppliers, setSuppliers] = useState<Map<string, SupplierName>>(new Map());
  const [selected, setSelected] = useState<MasterItem | null>(null);
  const [editing, setEditing] = useState<Partial<MasterItem> | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
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
    load().catch((cause) => setError(cause.message));
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
          (!category || item.category === category),
      ),
    [items, query, status, type, category],
  );
  const distinct = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, locale));
  const types = useMemo(() => distinct(items.map((item) => item.itemType)), [items, locale]);
  const categories = useMemo(() => distinct(items.map((item) => item.category)), [items, locale]);
  const typeLabel = (code: string) => copy(ITEM_TYPE_LABELS[code] || code);
  const unitLabel = (code: string) => UNIT_LABELS[code]?.[language === "en-US" ? "en" : "zh"] || code;
  const supplierLabel = (id: string) => {
    if (!id) return NOT_PROVIDED;
    const supplier = suppliers.get(id);
    return supplier?.supplierName || supplier?.supplierCode || id;
  };
  const quantity = (value: number) => value.toLocaleString(locale);
  const statusLabel = (code: string) => copy(code === "active" ? "Active" : code === "inactive" ? "Inactive" : code);
  const activeCount = items.filter((item) => item.status === "active").length;
  const filtered = Boolean(query || status || type || category);
  const resetFilters = () => { setQuery(""); setStatus(""); setType(""); setCategory(""); };
  const save = async () => {
    if (!editing) return;
    try {
      const isNew = !selected;
      const url = isNew
        ? "/api/master-data/items"
        : `/api/master-data/items/${encodeURIComponent(selected.itemId)}`;
      const result = await apiJson<{ item: MasterItem }>(url, {
        method: isNew ? "POST" : "PATCH",
        body: JSON.stringify({
          ...editing,
          expectedVersion: selected?.version,
        }),
      });
      setSelected(result.item);
      setEditing(null);
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy("保存失败"));
    }
  };
  if (editing)
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">
              {selected ? `${copy("编辑")} ${selected.sku}` : copy("新建 SKU")}
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
          {fields.map(([key, label, inputType]) => (
            <Field key={key} label={copy(label)}>
              <input
                aria-label={copy(label)}
                disabled={Boolean(selected) && key === "itemId"}
                type={inputType}
                value={String(editing[key] ?? "")}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    [key]:
                      inputType === "number"
                        ? Number(event.target.value)
                        : event.target.value,
                  })
                }
                style={inputStyle}
              />
            </Field>
          ))}
          <Field label={copy("状态")}>
            <select
              value={editing.status}
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
              "batchManaged",
              "serialManaged",
              "shelfLifeManaged",
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
  if (selected)
    return (
      <Card className="p-5">
        <div className="flex justify-between">
          <div>
            <button
              className="text-xs text-blue-600"
              onClick={() => setSelected(null)}
            >
              {copy("← 返回 SKU 列表")}
            </button>
            <h2 className="mt-2 text-base font-semibold">
              {selected.sku} · {selected.itemName}
            </h2>
            <p className="text-xs" style={{ color: A.sub }}>
              {statusLabel(selected.status)} · v{selected.version}
            </p>
          </div>
          {canEdit && (
            <div className="fc-detail-actions">
            <button
              onClick={() => setEditing(selected)}
              className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
            >
              {copy("编辑 SKU")}
            </button>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {fields.map(([key, label]) => (
            <div key={key} className="rounded-lg bg-slate-50 p-3">
              <div className="text-[11px] text-slate-500">{copy(label)}</div>
              <div className="mt-1 text-xs font-medium">
                {key === "itemType" ? typeLabel(selected.itemType) : String(selected[key] ?? "—") || "—"}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-xs text-slate-500">
          {language === "en-US" ? "Created: " : "创建："}{selected.createdBy} · {selected.createdAt}
          <br />
          {language === "en-US" ? "Updated: " : "更新："}{selected.updatedBy} · {selected.updatedAt}
        </div>
      </Card>
    );
  // Laid out like the other list pages (purchase orders, sales orders):
  // item-level counts, a search card with labelled filters, then the list.
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label={copy("Items")} value={String(items.length)} sub={copy("{count} active", { count: activeCount })} icon={Package} color={A.blue} />
        <KpiCard label={copy("Inactive items")} value={String(items.length - activeCount)} sub={copy("Kept for history, not offered on new documents")} icon={CheckCircle2} color={A.gray1} />
        <KpiCard label={copy("No reorder point")} value={String(items.filter((item) => item.status === "active" && !hasReorderPoint(item)).length)} sub={copy("Active items the reorder list cannot check")} icon={AlertCircle} color={A.orange} />
        <KpiCard label={copy("No preferred supplier")} value={String(items.filter((item) => item.status === "active" && !item.defaultSupplierId).length)} sub={copy("Active items without a supplier to order from")} icon={Truck} color={A.purple} />
      </div>

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Item search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Search items by SKU, name, status, type and category.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={resetFilters} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
              {copy("Reset")}
            </button>
            <button type="button" onClick={() => exportMasterDataCsv("items", { items: shown.map((item) => ({ ...item, preferredSupplierName: item.defaultSupplierId ? supplierLabel(item.defaultSupplierId) : "" })) }, copy)} className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium" style={{ background: "#f0f6ff", color: A.blue }}>
              <FileSpreadsheet size={13} /> {copy("Export results")}
            </button>
            <DataImportLink type="items" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700" />
            {canEdit && (
              <button
                type="button"
                className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white"
                onClick={() => {
                  setSelected(null);
                  setEditing({ ...empty });
                }}
              >
                {copy("新建 SKU")}
              </button>
            )}
          </div>
        </div>
        <ResponsiveFilters
          className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4"
          activeCount={[status, type, category].filter(Boolean).length}
          onReset={resetFilters}
          leading={
            <Field label={copy("Search")}>
              <input aria-label={copy("搜索 SKU")} placeholder={copy("搜索 SKU 编码或物料名称")} value={query} onChange={(e) => setQuery(e.target.value)} style={inputStyle} />
            </Field>
          }
        >
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
        </ResponsiveFilters>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{copy("Item list")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{copy(items.length === 1 ? "1 item, {shown} shown" : "{total} items, {shown} shown", { total: items.length, shown: shown.length })}</div>
          </div>
        </div>
        {error && <p className="px-5 pt-3 text-xs text-red-600">{error}</p>}
        <div className={tableScrollClass}>
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
              {shown.map((item, index) => (
                <tr key={item.itemId} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < shown.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
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
                            setEditing(item);
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
      </Card>
    </div>
  );
}
