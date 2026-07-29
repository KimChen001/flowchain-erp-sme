import { useEffect, useMemo, useState } from "react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";

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
const empty: Partial<MasterItem> = {
  itemType: "material",
  category: "未分类",
  baseUnit: "件",
  purchaseUnit: "件",
  status: "active",
  purchasable: true,
  inventoryItem: true,
};
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
    category: text(item.category, "未分类"),
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
  const [items, setItems] = useState<MasterItem[]>([]);
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
  };
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
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
      setError(cause instanceof Error ? cause.message : "保存失败");
    }
  };
  if (editing)
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">
              {selected ? `编辑 ${selected.sku}` : "新建 SKU"}
            </h2>
            <p className="text-xs" style={{ color: A.sub }}>
              基础信息、采购库存属性与追踪属性
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(null)}>取消</button>
            <button
              className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
              onClick={save}
            >
              保存
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {fields.map(([key, label, inputType]) => (
            <Field key={key} label={label}>
              <input
                aria-label={label}
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
          <Field label="状态">
            <select
              value={editing.status}
              onChange={(e) =>
                setEditing({ ...editing, status: e.target.value })
              }
              style={inputStyle}
            >
              <option value="active">启用</option>
              <option value="inactive">停用</option>
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
              {key}
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
              ← 返回 SKU 列表
            </button>
            <h2 className="mt-2 text-base font-semibold">
              {selected.sku} · {selected.itemName}
            </h2>
            <p className="text-xs" style={{ color: A.sub }}>
              {selected.status} · v{selected.version}
            </p>
          </div>
          <button
            onClick={() => setEditing(selected)}
            className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
          >
            编辑 SKU
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {fields.map(([key, label]) => (
            <div key={key} className="rounded-lg bg-slate-50 p-3">
              <div className="text-[11px] text-slate-500">{label}</div>
              <div className="mt-1 text-xs font-medium">
                {String(selected[key] ?? "—") || "—"}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-xs text-slate-500">
          创建：{selected.createdBy} · {selected.createdAt}
          <br />
          更新：{selected.updatedBy} · {selected.updatedAt}
        </div>
      </Card>
    );
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="搜索 SKU"
          placeholder="搜索 SKU 编码或物料名称"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={inputStyle}
        />
        <select
          aria-label="状态筛选"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={inputStyle}
        >
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="inactive">停用</option>
        </select>
        <input
          placeholder="物料类型"
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={inputStyle}
        />
        <input
          placeholder="分类"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={inputStyle}
        />
        <button
          className="ml-auto rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
          onClick={() => {
            setSelected(null);
            setEditing({ ...empty });
          }}
        >
          新建 SKU
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      <div className="mt-3 overflow-auto">
        {!error && shown.length === 0 && (
          <div className="p-10 text-center">
            <h2 className="font-semibold">暂无物料资料</h2>
            <p className="mt-2 text-sm text-slate-500">可以新建物料、使用 Structured Intake，或在本地运行 pilot:setup:demo。</p>
          </div>
        )}
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">SKU</th>
              <th>物料名称</th>
              <th>类型</th>
              <th>分类</th>
              <th>单位</th>
              <th>规格</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr className="border-b" key={item.itemId}>
                <td className="p-2">
                  <EntityLink kind="item" id={item.itemId} className="text-blue-600">
                    {item.sku}
                  </EntityLink>
                </td>
                <td>{item.itemName}</td>
                <td>{item.itemType}</td>
                <td>{item.category}</td>
                <td>{item.baseUnit}</td>
                <td>{item.specification}</td>
                <td>{item.status}</td>
                <td>
                  <button
                    className="text-blue-600"
                    onClick={() => {
                      setSelected(item);
                      setEditing(item);
                    }}
                  >
                    编辑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
