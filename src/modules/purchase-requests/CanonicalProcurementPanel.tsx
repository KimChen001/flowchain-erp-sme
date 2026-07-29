import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { tableLinkClass } from "../../components/ui/workbenchTable";
import { createClientTemporaryId } from "../../lib/client-id";

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
type FieldError = { field?: string; message?: string };
const today = () => new Date().toISOString().slice(0, 10);
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
  currency: "CNY",
  targetWarehouseId: "",
  needByDate: date,
  serviceStartDate: "",
  serviceEndDate: "",
  internalLineComment: "",
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
  const [searchParams] = useSearchParams();
  const prefilled = useRef(false);
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
    [currency, setCurrency] = useState("CNY"),
    [defaultDate, setDefaultDate] = useState(today()),
    [lines, setLines] = useState<Line[]>([makeLine()]),
    [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<PR | null>(null),
    [errors, setErrors] = useState<FieldError[]>([]),
    [saving, setSaving] = useState(false);
  const selected =
    focus?.entityType === "purchase_request"
      ? rows.find((row) => row.id === focus.entityId)
      : null;
  const load = async () => {
    try {
      const [prs, catalog, selector, departmentSelector, currencySelector, unitSelector, commoditySelector, warehouseSelector] = await Promise.all([
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
    load().catch((e) => toast.error(e.message));
  }, []);
  useEffect(() => {
    if (prefilled.current || !items.length) return;
    const requestedItem = searchParams.get("itemId") || searchParams.get("sku");
    if (!requestedItem) return;
    const item = items.find(
      (row) =>
        (row.itemId || row.id) === requestedItem || row.sku === requestedItem,
    );
    if (!item) return;
    prefilled.current = true;
    const itemId = item.itemId || item.id || "";
    const quantity = String(
      Math.max(1, Number(searchParams.get("quantity") || 1)),
    );
    request<{ suppliers: SupplierOption[] }>(
      `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
    )
      .then((result) => {
        setItemSuppliers((current) => ({
          ...current,
          [itemId]: result.suppliers,
        }));
        const preferred =
          result.suppliers.find((s) => s.preferred) || result.suppliers[0];
        setLines([
          {
            ...makeLine(defaultDate),
            itemId,
            sku: item.sku,
            itemNameSnapshot: item.itemName || item.name || "",
            unitSnapshot: item.purchaseUnit || item.baseUnit,
            specificationSnapshot: item.specification || "",
            commodityId: item.category || "",
            targetWarehouseId: item.defaultWarehouseId || "",
            quantity,
            supplierId: preferred?.id || "",
            estimatedUnitPrice: preferred?.referencePrice
              ? String(preferred.referencePrice)
              : "",
            currency: preferred?.currency || currency,
            internalLineComment:
              "由库存补货入口预填；保存前请人工复核数量、供应商和需求日期。",
          },
        ]);
      })
      .catch((error) => toast.error(error.message || "供应商关系读取失败"));
  }, [items, searchParams]);
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
    setLines([makeLine(defaultDate)]);
    setErrors([]);
  };
  const save = async (submit = false) => {
    setSaving(true);
    setErrors([]);
    try {
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
        })),
      };
      const pr = editing
        ? await request<PR>(
            `/api/procurement/requests/${editing.id}`,
            "PATCH",
            { ...body, expectedVersion: editing.version },
          )
        : await request<PR>("/api/procurement/requests", "POST", body);
      if (submit)
        await request(`/api/procurement/requests/${pr.id}/submit`, "POST", {
          expectedVersion: pr.version,
        });
      reset();
      await load();
      toast.success(submit ? "采购申请已提交" : "采购申请草稿已保存");
    } catch (error: unknown) {
      const details = error instanceof ApiError ? error.details : [];
      setErrors(
        details.length
          ? details
          : [{ message: error instanceof Error ? error.message : "保存失败" }],
      );
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const act = async (pr: PR, action: string) => {
    try {
      const reason =
        action === "reject" ? window.prompt("请输入拒绝原因") || "" : "";
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
      toast.error(e.message);
    }
  };
  const edit = async (pr: PR) => {
    const itemIds = [
      ...new Set(pr.lines.map((line) => line.itemId).filter(Boolean)),
    ] as string[];
    const payloads = await Promise.all(
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
    setItemSuppliers((current) => ({
      ...current,
      ...Object.fromEntries(payloads),
    }));
    setEditing(pr);
    setDepartmentId(pr.departmentId);
    setCurrency(pr.defaultCurrency || "CNY");
    setDefaultDate(pr.defaultNeedByDate || today());
    setLines(
      pr.lines.map((l) => ({
        ...l,
        quantity: String(l.quantity ?? ""),
        estimatedUnitPrice: String(l.estimatedUnitPrice ?? ""),
        estimatedAmount: String(l.estimatedAmount ?? ""),
      })),
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  if (loadError)
    return (
      <Card className="p-12 text-center">
        <h1 className="text-base font-semibold">采购申请数据加载失败</h1>
        <p className="mt-2 text-xs" style={{ color: A.sub }}>
          {loadError}
        </p>
        <button
          onClick={() => load().catch((error) => toast.error(error.message))}
          className="mt-3 text-sm text-blue-600"
        >
          重试
        </button>
      </Card>
    );
  if (selected)
    return (
      <div className="space-y-4 pb-16">
        <button onClick={() => onNavigate?.("procurement:requests")}>
          返回采购申请列表
        </button>
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-semibold">{selected.id}</h1>
              <p className="mt-1 text-xs" style={{ color: A.sub }}>
                {selected.status} · v{selected.version} · {selected.requesterId}
              </p>
            </div>
            <strong>
              {selected.defaultCurrency} {selected.totalAmount}
            </strong>
          </div>
          <h2 className="mt-5 text-sm font-semibold">采购行</h2>
          <div className="mt-2 divide-y">
            {selected.lines.map((line) => (
              <div
                key={line.lineId}
                className="grid gap-2 py-3 text-xs md:grid-cols-6"
              >
                <span>{line.sku || "Other"}</span>
                <span>{line.itemNameSnapshot}</span>
                <span>
                  {line.supplierSnapshot?.supplierName || line.supplierId}
                </span>
                <span>
                  {line.lineBasis === "quantity"
                    ? `${line.quantity} × ${line.estimatedUnitPrice}`
                    : line.estimatedAmount}
                </span>
                <span>{line.targetWarehouseId}</span>
                <span>{line.internalLineComment || "-"}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">关联采购订单</h2>
          {!selected.linkedPurchaseOrderIds?.length ? (
            <div className="py-8 text-center text-xs" style={{ color: A.sub }}>
              暂无关联采购订单
            </div>
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
              {editing ? `编辑采购申请 ${editing.id}` : "新建采购申请"}
            </h2>
            <p className="mt-1 text-xs" style={{ color: A.sub }}>
              每一行均需明确物料或服务、供应商、金额、交付地点和需求日期。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              aria-label="刷新主数据"
              title="刷新主数据"
              onClick={() => load()}
              className="rounded-md border p-2"
            >
              <RefreshCw size={15} />
            </button>
            <button
              disabled={saving}
              onClick={() => save(false)}
              className="rounded-md bg-slate-100 px-3 py-2 text-xs"
            >
              保存草稿
            </button>
            <button
              disabled={saving}
              onClick={() => save(true)}
              className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white"
            >
              保存并提交
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label="申请人">
            <input
              aria-label="申请人"
              readOnly
              value="由服务端当前用户确定"
              style={{ ...inputStyle, background: A.gray6 }}
            />
          </Field>
          <Field label="部门">
            <select
              aria-label="部门"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              style={inputStyle}
            >
              {departments.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="默认币种">
            <select
              aria-label="默认币种"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              style={inputStyle}
            >
              {currencies.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="默认需求日期">
            <input
              aria-label="默认需求日期"
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
            {errors.map((e, i) => (
              <div key={i}>{e.message || e.field}</div>
            ))}
          </div>
        )}
        <div className="mt-4 space-y-3">
          {lines.map((line, index) => (
            <div key={line.lineId} className="rounded-md border p-3">
              <div className="mb-3 flex items-center justify-between">
                <strong className="text-xs">采购行 {index + 1}</strong>
                <button
                  aria-label={`删除采购行 ${index + 1}`}
                  title="删除采购行"
                  onClick={() => {
                    if (
                      lines.length > 1 &&
                      window.confirm("确认删除该采购行？")
                    )
                      setLines(lines.filter((_, i) => i !== index));
                  }}
                  className="p-1 text-red-600"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="grid gap-2 md:grid-cols-6">
                <Field label="采购类型">
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
                    <option value="catalog_item">目录物料</option>
                    <option value="non_catalog_item">Other / 非目录</option>
                  </select>
                </Field>
                <Field label="计价方式">
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
                    <option value="quantity">数量型</option>
                    <option value="amount">金额 / 服务型</option>
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
                      <option value="">搜索或选择 SKU</option>
                      {items.map((i) => (
                        <option key={i.itemId || i.id} value={i.itemId || i.id}>
                          {i.sku} · {i.itemName || i.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="block py-2 text-xs">非目录</span>
                  )}
                </Field>
                <Field label="供应商">
                  <select
                    aria-label={`供应商 ${index + 1}`}
                    value={line.supplierId}
                    onChange={(e) =>
                      patchLine(index, { supplierId: e.target.value })
                    }
                    style={inputStyle}
                  >
                    <option value="">选择供应商</option>
                    {supplierOptions(line).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.preferred ? " · Preferred" : ""}
                      </option>
                    ))}
                  </select>
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
                      >
                        维护 SKU 供应商
                      </button>
                    )}
                </Field>
                <Field label="物料名称 / 描述">
                  <input
                    readOnly={line.sourceType === "catalog_item"}
                    value={line.itemNameSnapshot}
                    onChange={(e) =>
                      patchLine(index, { itemNameSnapshot: e.target.value })
                    }
                    style={inputStyle}
                  />
                </Field>
                <Field label="品类">
                  {line.sourceType === "catalog_item" ? <input readOnly value={line.commodityId} style={inputStyle} /> : <select value={line.commodityId} onChange={(e) => patchLine(index, { commodityId: e.target.value })} style={inputStyle}><option value="">选择品类</option>{commodities.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}
                </Field>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-6">
                {line.lineBasis === "quantity" && (
                  <>
                    <Field label="单位">
                      {line.sourceType === "catalog_item" ? <input readOnly value={line.unitSnapshot || ""} style={inputStyle} /> : <select value={line.unitSnapshot || ""} onChange={(e) => patchLine(index, { unitSnapshot: e.target.value })} style={inputStyle}><option value="">选择单位</option>{units.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}
                    </Field>
                    <Field label="数量">
                      <input
                        type="number"
                        min="0"
                        value={line.quantity}
                        onChange={(e) =>
                          patchLine(index, { quantity: e.target.value })
                        }
                        style={inputStyle}
                      />
                    </Field>
                    <Field label="预计单价">
                      <input
                        aria-label={`预计单价 ${index + 1}`}
                        type="number"
                        min="0"
                        placeholder="请输入"
                        value={line.estimatedUnitPrice}
                        onChange={(e) =>
                          patchLine(index, {
                            estimatedUnitPrice: e.target.value,
                          })
                        }
                        style={inputStyle}
                      />
                    </Field>
                  </>
                )}
                {line.lineBasis === "amount" && (
                  <Field label="预计总金额">
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
                <Field label="规格">
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
                <Field label="目标仓库或服务地点">
                  <select
                    value={line.targetWarehouseId}
                    onChange={(e) =>
                      patchLine(index, { targetWarehouseId: e.target.value })
                    }
                    style={inputStyle}
                  >
                    <option value="">选择地点</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="需求日期">
                  <input
                    type="date"
                    value={line.needByDate}
                    onChange={(e) =>
                      patchLine(index, { needByDate: e.target.value })
                    }
                    style={inputStyle}
                  />
                </Field>
              </div>
              <Field label="行级内部备注">
                <textarea
                  aria-label={`行级内部备注 ${index + 1}`}
                  value={line.internalLineComment}
                  onChange={(e) =>
                    patchLine(index, { internalLineComment: e.target.value })
                  }
                  className="mt-2 min-h-16 w-full rounded-md border p-2 text-xs"
                />
              </Field>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={() => setLines([...lines, makeLine(defaultDate)])}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs"
          >
            <Plus size={14} />
            新增采购行
          </button>
          <strong className="text-sm">
            预计总额 {currency} {total.toFixed(2)}
          </strong>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-sm font-semibold">采购申请</h2>
          <span className="text-xs" style={{ color: A.sub }}>
            {rows.length} 张
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: A.sub }}>
            暂无采购申请
            <br />
            <span className="text-xs">点击“新建采购申请”开始录入。</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {["申请编号", "申请人", "状态", "金额", "操作"].map((h) => (
                    <th key={h} className="p-3 text-left">
                      {h}
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
                    <td className="p-3">{pr.status}</td>
                    <td className="p-3">{pr.totalAmount}</td>
                    <td className="p-3 space-x-2">
                      {pr.status === "draft" && (
                        <>
                          <button onClick={() => edit(pr)}>编辑</button>
                          <button onClick={() => act(pr, "submit")}>
                            提交
                          </button>
                        </>
                      )}
                      {pr.status === "submitted" && (
                        <>
                          <button onClick={() => act(pr, "approve")}>
                            批准
                          </button>
                          <button onClick={() => act(pr, "reject")}>
                            拒绝
                          </button>
                          <button onClick={() => act(pr, "withdraw")}>
                            撤回
                          </button>
                        </>
                      )}
                      {pr.status === "approved" && (
                        <button
                          onClick={() => act(pr, "generate-purchase-orders")}
                        >
                          生成 Draft PO
                        </button>
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
