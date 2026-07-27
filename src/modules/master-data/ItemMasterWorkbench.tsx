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
type SupplierOption = {
  id: string;
  supplierCode: string;
  supplierName: string;
  name?: string;
};
type ItemSupplierRelationship = {
  relationshipId: string;
  itemId: string;
  supplierId: string;
  supplierSku: string;
  active: boolean;
  approved: boolean;
  preferred: boolean;
  purchaseUnit: string;
  referencePrice: number;
  currency: string;
  leadTimeDays: number;
  minimumOrderQuantity: number;
  version: number;
  supplier: SupplierOption;
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
  const [relationships, setRelationships] = useState<
    ItemSupplierRelationship[]
  >([]);
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[]>([]);
  const [relationshipError, setRelationshipError] = useState("");
  const [relationshipForm, setRelationshipForm] = useState({
    supplierId: "",
    supplierSku: "",
    preferred: false,
    approved: true,
    active: true,
    leadTimeDays: "",
    minimumOrderQuantity: "1",
    referencePrice: "",
    currency: "CNY",
  });
  const load = async () => {
    const result = await apiJson<{ items: MasterItem[] }>(
      "/api/master-data/items?managed=true",
    );
    setItems(result.items);
  };
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, []);
  useEffect(() => {
    if (!focus?.entityId || focus.entityType !== "item" || !items.length)
      return;
    const key = focus.entityId.toLowerCase();
    const item = items.find((row) =>
      [row.itemId, row.sku].some((value) => value.toLowerCase() === key),
    );
    if (item) setSelected(item);
  }, [focus?.at, focus?.entityId, focus?.entityType, items]);
  useEffect(() => {
    if (!selected) {
      setRelationships([]);
      return;
    }
    Promise.all([
      apiJson<{ relationships: ItemSupplierRelationship[] }>(
        `/api/master-data/items/${encodeURIComponent(selected.itemId)}/suppliers`,
      ),
      apiJson<{ suppliers: SupplierOption[] }>(
        "/api/master-data/suppliers/select",
      ),
    ])
      .then(([relationshipPayload, supplierPayload]) => {
        setRelationships(relationshipPayload.relationships);
        setSupplierOptions(supplierPayload.suppliers);
        setRelationshipError("");
      })
      .catch((cause) =>
        setRelationshipError(
          cause instanceof Error ? cause.message : "SKU–供应商关系加载失败",
        ),
      );
  }, [selected?.itemId]);
  const shown = useMemo(
    () =>
      items.filter(
        (item) =>
          (!query ||
            `${item.sku} ${item.itemName}`
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
  const reloadRelationships = async () => {
    if (!selected) return;
    const payload = await apiJson<{
      relationships: ItemSupplierRelationship[];
    }>(
      `/api/master-data/items/${encodeURIComponent(selected.itemId)}/suppliers`,
    );
    setRelationships(payload.relationships);
  };
  const createRelationship = async () => {
    if (!selected || !relationshipForm.supplierId) return;
    try {
      await apiJson(
        `/api/master-data/items/${encodeURIComponent(selected.itemId)}/suppliers`,
        {
          method: "POST",
          body: JSON.stringify({
            ...relationshipForm,
            leadTimeDays: Number(relationshipForm.leadTimeDays || 0),
            minimumOrderQuantity: Number(
              relationshipForm.minimumOrderQuantity || 1,
            ),
            referencePrice: Number(relationshipForm.referencePrice || 0),
          }),
        },
      );
      setRelationshipForm((current) => ({
        ...current,
        supplierId: "",
        supplierSku: "",
        preferred: false,
        referencePrice: "",
      }));
      setRelationshipError("");
      await reloadRelationships();
    } catch (cause) {
      setRelationshipError(
        cause instanceof Error ? cause.message : "关系保存失败",
      );
    }
  };
  const updateRelationship = async (
    relationship: ItemSupplierRelationship,
    patch: Partial<ItemSupplierRelationship>,
  ) => {
    if (!selected) return;
    try {
      await apiJson(
        `/api/master-data/items/${encodeURIComponent(selected.itemId)}/suppliers/${encodeURIComponent(relationship.relationshipId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...patch,
            expectedVersion: relationship.version,
          }),
        },
      );
      setRelationshipError("");
      await reloadRelationships();
    } catch (cause) {
      setRelationshipError(
        cause instanceof Error ? cause.message : "关系更新失败",
      );
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
        <div className="mt-5 border-t pt-5">
          <h3 className="text-sm font-semibold">可采购供应商</h3>
          <p className="mt-1 text-xs text-slate-500">
            这里与供应商详情及采购申请共用同一 SKU–供应商关系。
          </p>
          {relationshipError && (
            <p role="alert" className="mt-3 text-xs text-red-600">
              {relationshipError}
            </p>
          )}
          <div className="mt-3 grid gap-2 md:grid-cols-4 lg:grid-cols-6">
            <select
              aria-label="关系供应商"
              value={relationshipForm.supplierId}
              onChange={(event) =>
                setRelationshipForm({
                  ...relationshipForm,
                  supplierId: event.target.value,
                })
              }
              style={inputStyle}
            >
              <option value="">选择启用供应商</option>
              {supplierOptions
                .filter(
                  (supplier) =>
                    !relationships.some(
                      (relationship) => relationship.supplierId === supplier.id,
                    ),
                )
                .map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.supplierCode} ·{" "}
                    {supplier.supplierName || supplier.name}
                  </option>
                ))}
            </select>
            <input
              aria-label="供应商物料编码"
              placeholder="供应商物料编码"
              value={relationshipForm.supplierSku}
              onChange={(event) =>
                setRelationshipForm({
                  ...relationshipForm,
                  supplierSku: event.target.value,
                })
              }
              style={inputStyle}
            />
            <input
              aria-label="关系 Lead Time"
              type="number"
              min="0"
              placeholder="Lead Time"
              value={relationshipForm.leadTimeDays}
              onChange={(event) =>
                setRelationshipForm({
                  ...relationshipForm,
                  leadTimeDays: event.target.value,
                })
              }
              style={inputStyle}
            />
            <input
              aria-label="关系 MOQ"
              type="number"
              min="1"
              placeholder="MOQ"
              value={relationshipForm.minimumOrderQuantity}
              onChange={(event) =>
                setRelationshipForm({
                  ...relationshipForm,
                  minimumOrderQuantity: event.target.value,
                })
              }
              style={inputStyle}
            />
            <input
              aria-label="关系参考价"
              type="number"
              min="0"
              placeholder="参考价"
              value={relationshipForm.referencePrice}
              onChange={(event) =>
                setRelationshipForm({
                  ...relationshipForm,
                  referencePrice: event.target.value,
                })
              }
              style={inputStyle}
            />
            <button
              disabled={!relationshipForm.supplierId}
              onClick={createRelationship}
              className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-50"
            >
              新增关系
            </button>
          </div>
          <label className="mt-2 inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={relationshipForm.preferred}
              onChange={(event) =>
                setRelationshipForm({
                  ...relationshipForm,
                  preferred: event.target.checked,
                })
              }
            />
            设为 Preferred Supplier
          </label>
          {relationships.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              暂无可采购供应商
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {[
                      "Supplier",
                      "供应商物料编码",
                      "Lead Time",
                      "MOQ",
                      "参考价",
                      "状态",
                      "操作",
                    ].map((label) => (
                      <th key={label} className="p-2 text-left">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {relationships.map((relationship) => (
                    <tr key={relationship.relationshipId} className="border-t">
                      <td className="p-2">
                        <EntityLink kind="supplier" id={relationship.supplierId} className="text-blue-600">
                          {relationship.supplier?.supplierCode ||
                            relationship.supplierId}{" "}
                          ·{" "}
                          {relationship.supplier?.supplierName ||
                            relationship.supplier?.name}
                        </EntityLink>
                        {relationship.preferred && (
                          <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">
                            Preferred
                          </span>
                        )}
                      </td>
                      <td className="p-2">{relationship.supplierSku || "-"}</td>
                      <td className="p-2">{relationship.leadTimeDays} 天</td>
                      <td className="p-2">
                        {relationship.minimumOrderQuantity}
                      </td>
                      <td className="p-2">
                        {relationship.currency} {relationship.referencePrice}
                      </td>
                      <td className="p-2">
                        {relationship.active && relationship.approved
                          ? "启用 · 已批准"
                          : relationship.active
                            ? "启用 · 待批准"
                            : "停用"}
                      </td>
                      <td className="p-2 space-x-2">
                        {!relationship.preferred && (
                          <button
                            onClick={() =>
                              updateRelationship(relationship, {
                                preferred: true,
                              })
                            }
                          >
                            设为首选
                          </button>
                        )}
                        <button
                          onClick={() =>
                            updateRelationship(relationship, {
                              active: !relationship.active,
                            })
                          }
                        >
                          {relationship.active ? "停用" : "启用"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
