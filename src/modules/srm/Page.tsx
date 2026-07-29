import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";

type Supplier = {
  id: string;
  supplierCode: string;
  supplierName: string;
  shortName: string;
  status: "draft" | "active" | "inactive";
  businessType: string;
  categories: string[];
  contactName: string;
  telephone: string;
  email: string;
  address: string;
  postalCode: string;
  deliveryCycleDays: number;
  defaultCurrency: string;
  paymentTermsId: string;
  settlementMethod: string;
  creditCode: string;
  taxIdentificationNumber: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  internalComment: string;
  version: number;
  updatedAt: string;
};
type Relationship = {
  relationshipId: string;
  itemId: string;
  supplierId: string;
  supplierSku: string;
  active: boolean;
  approved: boolean;
  preferred: boolean;
  leadTimeDays: number;
  minimumOrderQuantity: number;
  referencePrice: number;
  currency: string;
  version: number;
  item?: Item | null;
};
type Item = { itemId: string; sku: string; itemName: string; status: string };
const request = <T,>(url: string, method = "GET", body?: unknown) =>
  apiJson<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const empty = () => ({
  supplierCode: "",
  supplierName: "",
  shortName: "",
  status: "active",
  businessType: "",
  categories: "",
  contactName: "",
  telephone: "",
  email: "",
  address: "",
  postalCode: "",
  deliveryCycleDays: "",
  defaultCurrency: "CNY",
  paymentTermsId: "NET30",
  settlementMethod: "",
  creditCode: "",
  taxIdentificationNumber: "",
  bankName: "",
  bankAccountName: "",
  bankAccountNumber: "",
  internalComment: "",
});
const statusLabel = { draft: "草稿", active: "启用", inactive: "停用" };

function normalizeSupplier(value: Partial<Supplier> & Record<string, unknown>): Supplier {
  const text = (candidate: unknown, fallback = "") => String(candidate ?? "").trim() || fallback;
  const id = text(value.id || value.supplierCode || value.name || value.supplierName);
  const supplierName = text(value.supplierName || value.name, id);
  const rawStatus = text(value.status, "active");
  return {
    id,
    supplierCode: text(value.supplierCode, id),
    supplierName,
    shortName: text(value.shortName),
    status: (["draft", "active", "inactive"].includes(rawStatus) ? rawStatus : "active") as Supplier["status"],
    businessType: text(value.businessType),
    categories: Array.isArray(value.categories) ? value.categories.map((item) => text(item)).filter(Boolean) : [],
    contactName: text(value.contactName),
    telephone: text(value.telephone),
    email: text(value.email),
    address: text(value.address),
    postalCode: text(value.postalCode),
    deliveryCycleDays: Number(value.deliveryCycleDays || 0),
    defaultCurrency: text(value.defaultCurrency, "CNY"),
    paymentTermsId: text(value.paymentTermsId),
    settlementMethod: text(value.settlementMethod),
    creditCode: text(value.creditCode),
    taxIdentificationNumber: text(value.taxIdentificationNumber),
    bankName: text(value.bankName),
    bankAccountName: text(value.bankAccountName),
    bankAccountNumber: text(value.bankAccountNumber),
    internalComment: text(value.internalComment),
    version: Number(value.version || 1),
    updatedAt: text(value.updatedAt),
  };
}

export default function SupplierMasterPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  initialView?: string;
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (moduleId: string, focus?: unknown) => void;
  onActiveContextChange?: (context: any) => void;
}) {
  const [rows, setRows] = useState<Supplier[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [category, setCategory] = useState("");
  const [selected, setSelected] = useState<Supplier | null>(null),
    [editing, setEditing] = useState<Supplier | null>(null),
    [form, setForm] = useState<any>(empty()),
    [showForm, setShowForm] = useState(false),
    [fieldErrors, setFieldErrors] = useState<any[]>([]),
    [relationships, setRelationships] = useState<Relationship[]>([]),
    [items, setItems] = useState<Item[]>([]),
    [relationshipLimitation, setRelationshipLimitation] = useState(""),
    [relationForm, setRelationForm] = useState({
      itemId: "",
      preferred: false,
      approved: true,
      active: true,
      leadTimeDays: "",
      minimumOrderQuantity: "1",
      referencePrice: "",
      currency: "CNY",
    });
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request<{ suppliers: Supplier[] }>(
        `/api/master-data/suppliers?query=${encodeURIComponent(query)}&status=${status}&category=${encodeURIComponent(category)}`,
      );
      setRows((data.suppliers || []).map((supplier) => normalizeSupplier(supplier)));
    } catch (e: any) {
      setError(e.message || "供应商数据加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (focus?.entityType === "supplier" && focus.entityId)
      openDetail(focus.entityId);
  }, [focus?.at]);
  const categories = useMemo(
    () => [...new Set(rows.flatMap((r) => r.categories || []))],
    [rows],
  );
  const openDetail = async (id: string) => {
    try {
      const { supplier } = await request<{ supplier: Supplier }>(
        `/api/master-data/suppliers/${encodeURIComponent(id)}`,
      );
      const normalizedSupplier = normalizeSupplier(supplier);
      setSelected(normalizedSupplier);
      const [rels, catalog] = await Promise.allSettled([
        request<{ relationships: Relationship[] }>(
          `/api/master-data/suppliers/${encodeURIComponent(id)}/items`,
        ),
        request<{ items: Item[] }>("/api/master-data/items?purchasable=true"),
      ]);
      setRelationships(rels.status === "fulfilled" ? rels.value.relationships : []);
      setItems(catalog.status === "fulfilled" ? (catalog.value.items || []).map((item) => ({
        itemId: String(item.itemId || (item as any).id || item.sku || ""),
        sku: String(item.sku || ""),
        itemName: String(item.itemName || (item as any).name || item.sku || ""),
        status: String(item.status || "active"),
      })) : []);
      setRelationshipLimitation(
        rels.status === "rejected"
          ? rels.reason instanceof Error ? rels.reason.message : "供应商–SKU 关系暂不可用"
          : "",
      );
      onActiveContextChange?.({
        module: "srm",
        entityType: "supplier",
        entityId: normalizedSupplier.id,
        entityLabel: normalizedSupplier.supplierName,
      });
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const startCreate = () => {
    setEditing(null);
    setForm(empty());
    setFieldErrors([]);
    setShowForm(true);
  };
  const startEdit = (supplier: Supplier) => {
    setEditing(supplier);
    setForm({ ...supplier, categories: (supplier.categories || []).join(",") });
    setFieldErrors([]);
    setShowForm(true);
  };
  const save = async () => {
    setFieldErrors([]);
    try {
      const body: any = {
        ...form,
        categories: String(form.categories)
          .split(/[,，]/)
          .map((x: string) => x.trim())
          .filter(Boolean),
        deliveryCycleDays: Number(form.deliveryCycleDays || 0),
        expectedVersion: editing?.version,
      };
      if (editing && String(body.bankAccountNumber || "").startsWith("****"))
        delete body.bankAccountNumber;
      const result = editing
        ? await request<{ supplier: Supplier }>(
            `/api/master-data/suppliers/${editing.id}`,
            "PATCH",
            body,
          )
        : await request<{ supplier: Supplier }>(
            "/api/master-data/suppliers",
            "POST",
            body,
          );
      setShowForm(false);
      await load();
      await openDetail(result.supplier.id);
    } catch (e: unknown) {
      setFieldErrors(
        e instanceof ApiError && e.details.length
          ? e.details
          : [{ message: e instanceof Error ? e.message : "保存失败" }],
      );
    }
  };
  const toggle = async (supplier: Supplier) => {
    await request(`/api/master-data/suppliers/${supplier.id}`, "PATCH", {
      status: supplier.status === "active" ? "inactive" : "active",
      expectedVersion: supplier.version,
    });
    await load();
    if (selected?.id === supplier.id) await openDetail(supplier.id);
  };
  const addRelationship = async () => {
    if (!selected || !relationForm.itemId) return;
    try {
      await request(
        `/api/master-data/items/${relationForm.itemId}/suppliers`,
        "POST",
        {
          ...relationForm,
          supplierId: selected.id,
          leadTimeDays: Number(relationForm.leadTimeDays || 0),
          minimumOrderQuantity: Number(relationForm.minimumOrderQuantity || 1),
          referencePrice: Number(relationForm.referencePrice || 0),
        },
      );
      await openDetail(selected.id);
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const updateRelationship = async (
    relationship: Relationship,
    patch: Partial<Relationship>,
  ) => {
    if (!selected) return;
    try {
      await request(
        `/api/master-data/items/${relationship.itemId}/suppliers/${relationship.relationshipId}`,
        "PATCH",
        { ...patch, expectedVersion: relationship.version },
      );
      await openDetail(selected.id);
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  if (showForm)
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">
              {editing ? "编辑供应商" : "新增供应商"}
            </h1>
            <p className="text-xs" style={{ color: A.sub }}>
              维护基本资料、联系信息、财税与商业条款。
            </p>
          </div>
          <button onClick={() => setShowForm(false)}>取消</button>
        </div>
        {fieldErrors.length > 0 && (
          <div
            role="alert"
            className="mt-3 rounded bg-red-50 p-3 text-xs text-red-700"
          >
            {fieldErrors.map((e, i) => (
              <div key={i}>{e.message || e.field}</div>
            ))}
          </div>
        )}
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[
            ["supplierCode", "供应商编号"],
            ["supplierName", "供应商名称"],
            ["shortName", "简称"],
            ["businessType", "经营类型"],
            ["categories", "经营品类（逗号分隔）"],
            ["contactName", "联系人"],
            ["telephone", "联系电话"],
            ["email", "邮箱"],
            ["address", "地址"],
            ["postalCode", "邮编"],
            ["deliveryCycleDays", "送货周期（天）"],
            ["defaultCurrency", "默认币种"],
            ["paymentTermsId", "付款条款"],
            ["settlementMethod", "结算方式"],
            ["creditCode", "统一社会信用代码"],
            ["taxIdentificationNumber", "税号"],
            ["bankName", "银行"],
            ["bankAccountName", "户名"],
            ["bankAccountNumber", "银行账号"],
            ["internalComment", "内部备注"],
          ].map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                aria-label={label}
                value={form[key] ?? ""}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                style={inputStyle}
              />
            </Field>
          ))}
          <Field label="状态">
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              style={inputStyle}
            >
              <option value="draft">草稿</option>
              <option value="active">启用</option>
              <option value="inactive">停用</option>
            </select>
          </Field>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            onClick={save}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white"
          >
            保存供应商
          </button>
        </div>
      </Card>
    );
  if (selected)
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => {
              setSelected(null);
              onActiveContextChange?.(null);
            }}
          >
            返回供应商列表
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => startEdit(selected)}
              className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"
            >
              <Pencil size={14} />
              编辑
            </button>
            <button
              onClick={() => toggle(selected)}
              className="rounded border px-3 py-2 text-xs"
            >
              {selected.status === "active" ? "停用" : "启用"}
            </button>
          </div>
        </div>
        <Card className="p-5">
          <h1 className="text-lg font-semibold">{selected.supplierName}</h1>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            {selected.supplierCode} · {statusLabel[selected.status]}
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {[
              [
                "基本信息",
                `${selected.shortName || "-"} · ${selected.businessType || "-"} · ${(selected.categories || []).join("、") || "-"}`,
              ],
              [
                "联系与地址",
                `${selected.contactName || "-"} · ${selected.telephone || "-"} · ${selected.email || "-"} · ${selected.address || "-"}`,
              ],
              [
                "商业条款",
                `${selected.defaultCurrency} · ${selected.paymentTermsId} · ${selected.settlementMethod || "-"}`,
              ],
              [
                "财税与银行",
                `${selected.creditCode || "-"} · ${selected.taxIdentificationNumber || "-"} · ${selected.bankName || "-"} · ${selected.bankAccountNumber || "-"}`,
              ],
            ].map(([title, value]) => (
              <section key={title}>
                <h2 className="text-xs font-semibold">{title}</h2>
                <p className="mt-2 text-xs leading-5" style={{ color: A.sub }}>
                  {value}
                </p>
              </section>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">可供应物料</h2>
          {relationshipLimitation && <p role="alert" className="mt-2 text-xs text-amber-700">{relationshipLimitation}</p>}
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            <select
              aria-label="选择 SKU"
              value={relationForm.itemId}
              onChange={(e) =>
                setRelationForm({ ...relationForm, itemId: e.target.value })
              }
              style={inputStyle}
            >
              <option value="">选择 SKU</option>
              {items
                .filter(
                  (i) => !relationships.some((r) => r.itemId === i.itemId),
                )
                .map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {i.sku} · {i.itemName}
                  </option>
                ))}
            </select>
            <label className="text-xs">
              <input
                type="checkbox"
                checked={relationForm.preferred}
                onChange={(e) =>
                  setRelationForm({
                    ...relationForm,
                    preferred: e.target.checked,
                  })
                }
              />{" "}
              Preferred
            </label>
            <input
              aria-label="参考价格"
              placeholder="参考价格"
              value={relationForm.referencePrice}
              onChange={(e) =>
                setRelationForm({
                  ...relationForm,
                  referencePrice: e.target.value,
                })
              }
              style={inputStyle}
            />
            <button
              onClick={addRelationship}
              className="rounded bg-blue-600 px-3 py-2 text-xs text-white"
            >
              新增供应商关系
            </button>
          </div>
          {relationships.length === 0 ? (
            <div className="py-8 text-center text-xs" style={{ color: A.sub }}>
              暂无可供应物料
            </div>
          ) : (
            <table className="mt-3 w-full text-xs">
              <thead>
                <tr>
                  {[
                    "SKU",
                    "Preferred",
                    "Approved",
                    "Lead Time",
                    "MOQ",
                    "参考价",
                    "状态",
                    "操作",
                  ].map((h) => (
                    <th key={h} className="p-2 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {relationships.map((r) => (
                  <tr key={r.relationshipId} className="border-t">
                    <td className="p-2">
                      <EntityLink kind="item" id={r.itemId} className="text-blue-600">
                        {r.item?.sku || r.itemId} · {r.item?.itemName || ""}
                      </EntityLink>
                    </td>
                    <td className="p-2">{r.preferred ? "是" : "否"}</td>
                    <td className="p-2">{r.approved ? "是" : "否"}</td>
                    <td className="p-2">{r.leadTimeDays}</td>
                    <td className="p-2">{r.minimumOrderQuantity}</td>
                    <td className="p-2">
                      {r.currency} {r.referencePrice}
                    </td>
                    <td className="p-2">{r.active ? "启用" : "停用"}</td>
                    <td className="p-2 space-x-2">
                      {!r.preferred && (
                        <button
                          onClick={() =>
                            updateRelationship(r, { preferred: true })
                          }
                        >
                          设为首选
                        </button>
                      )}
                      <button
                        onClick={() =>
                          updateRelationship(r, { active: !r.active })
                        }
                      >
                        {r.active ? "停用" : "启用"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">采购记录</h2>
          <div className="py-8 text-center text-xs" style={{ color: A.sub }}>
            暂无采购交易记录
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">风险与异常</h2>
          <div className="py-8 text-center text-xs" style={{ color: A.sub }}>
            暂无风险或异常
          </div>
        </Card>
      </div>
    );
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">供应商</h1>
        <p className="text-xs" style={{ color: A.sub }}>
          维护供应商基本资料、商业条款和可供应物料关系。
        </p>
      </div>
      <Card className="p-4">
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-64 items-center gap-2 rounded border px-3">
            <Search size={14} />
            <input
              aria-label="搜索供应商"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="编号、名称或联系人"
              className="h-9 flex-1 outline-none"
            />
          </label>
          <select
            aria-label="状态筛选"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={inputStyle}
          >
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
            <option value="draft">草稿</option>
          </select>
          <select
            aria-label="经营品类筛选"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={inputStyle}
          >
            <option value="">全部品类</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button
            onClick={load}
            className="inline-flex items-center gap-1 rounded border px-3 text-xs"
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            onClick={startCreate}
            className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 text-xs text-white"
          >
            <Plus size={14} />
            新增供应商
          </button>
        </div>
      </Card>
      {error ? (
        <Card className="p-8 text-center">
          <div className="text-sm text-red-700">供应商数据加载失败</div>
          <button onClick={load} className="mt-3 text-xs text-blue-600">
            重试
          </button>
        </Card>
      ) : loading ? (
        <Card className="p-8 text-center text-xs">加载中</Card>
      ) : rows.length === 0 ? (
        <Card className="py-14 text-center text-sm" style={{ color: A.sub }}>
          暂无供应商
          <br />
          <span className="text-xs">点击“新增供应商”开始维护供应商资料。</span>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                {[
                  "供应商编号",
                  "供应商名称",
                  "联系人",
                  "联系电话",
                  "经营品类",
                  "默认币种",
                  "付款条款",
                  "送货周期",
                  "状态",
                  "更新时间",
                  "操作",
                ].map((h) => (
                  <th key={h} className="p-3 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-3">
                    <EntityLink kind="supplier" id={row.id} className="text-blue-600">
                      {row.supplierCode}
                    </EntityLink>
                  </td>
                  <td className="p-3">{row.supplierName}</td>
                  <td className="p-3">{row.contactName || "-"}</td>
                  <td className="p-3">{row.telephone || "-"}</td>
                  <td className="p-3">
                    {(row.categories || []).join("、") || "-"}
                  </td>
                  <td className="p-3">{row.defaultCurrency}</td>
                  <td className="p-3">{row.paymentTermsId}</td>
                  <td className="p-3">{row.deliveryCycleDays || "-"}</td>
                  <td className="p-3">{statusLabel[row.status]}</td>
                  <td className="p-3">{row.updatedAt?.slice(0, 10)}</td>
                  <td className="p-3 space-x-2">
                    <button onClick={() => startEdit(row)}>编辑</button>
                    <button onClick={() => toggle(row)}>
                      {row.status === "active" ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
