import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AlertTriangle, Boxes, RefreshCw } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";

type Item = {
  id?: string;
  itemId?: string;
  sku: string;
  itemName?: string;
  name?: string;
  category?: string;
  availableQuantity?: number | string;
  onHandQuantity?: number | string;
  reservedQuantity?: number | string;
  safetyStock?: number | string;
  reorderPoint?: number | string;
  status?: string;
  riskLevel?: string;
  defaultWarehouseId?: string;
  warehouseId?: string;
  location?: string;
  locationKey?: string;
  unit?: string;
};
type Lot = {
  lotId?: string;
  lot?: string;
  sku: string;
  itemName?: string;
  quantity?: number;
  expiryDate?: string;
  status?: string;
  warehouseId?: string;
};
type Serial = {
  serialId?: string;
  sn?: string;
  sku: string;
  status?: string;
  warehouseId?: string;
};
type Movement = {
  movementId?: string;
  sku?: string;
  itemName?: string;
  warehouseId?: string;
  location?: string;
  quantityIn?: string | number;
  quantityOut?: string | number;
  adjustmentQty?: string | number;
  date?: string;
  sourceDocument?: string;
  status?: string;
};
type InventoryException = {
  id: string;
  sku?: string;
  itemName?: string;
  quantityImpact?: number;
  status?: string;
  reason?: string;
};
type Focus = {
  entityType: string;
  entityId: string;
  entityLabel?: string;
} | null;

const endpointFor: Record<string, { url: string; key: string }> = {
  overview: { url: "/api/inventory/balances", key: "balances" },
  warnings: { url: "/api/inventory/balances", key: "balances" },
  lots: { url: "/api/inventory/lots", key: "lots" },
  serials: { url: "/api/inventory/serials", key: "serials" },
  movements: { url: "/api/inventory/movements", key: "movements" },
  exceptions: { url: "/api/inventory/exceptions", key: "exceptions" },
};

const emptyStateFor: Record<string, { title: string; description: string }> = {
  overview: {
    title: "当前工作区暂无库存余额",
    description: "尚未读取到当前用户有权查看的仓库库存余额。",
  },
  movements: {
    title: "当前工作区暂无库存流水",
    description: "库存余额可以由本地场景显式加载；只有正式入库、出库、调拨或调整过账后才会产生流水。",
  },
  warnings: {
    title: "当前没有库存预警",
    description: "当前可见库存余额未低于安全库存或再订货点。",
  },
  lots: {
    title: "当前工作区暂无批次记录",
    description: "只有启用批次管理并完成正式库存过账后才会出现批次记录。",
  },
  serials: {
    title: "当前工作区暂无序列号记录",
    description: "只有启用序列号管理并完成正式库存过账后才会出现序列号记录。",
  },
  exceptions: {
    title: "当前没有库存异常",
    description: "当前可见库存记录未产生需要处理的异常。",
  },
};

function quantity(item: Item) {
  return Number(item.availableQuantity ?? item.onHandQuantity ?? 0);
}
function reorder(item: Item) {
  return Number(item.reorderPoint ?? item.safetyStock ?? 0);
}
function isShort(item: Item) {
  return quantity(item) < reorder(item);
}

export default function InventoryPage({
  initialView = "overview",
  focus,
}: {
  initialView?: string;
  focus?: Focus;
  onNavigate?: (...args: any[]) => void;
  onActiveContextChange?: (...args: any[]) => void;
  onReviewActionDraft?: (...args: any[]) => void;
}) {
  const view = endpointFor[initialView] ? initialView : "empty";
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedSku, setSelectedSku] = useState(focus?.entityId || "");
  const supportedFilterNames =
    view === "movements"
      ? [
          "relatedSalesOrderId",
          "sourceDocumentId",
          "sourceDocumentLineId",
          "postingBatchId",
          "sku",
          "warehouseId",
          "locationKey",
          "movementType",
          "page",
          "pageSize",
          "sort",
          "direction",
        ]
      : view === "overview"
        ? [
            "itemId",
            "sku",
            "warehouseId",
            "locationKey",
            "status",
            "page",
            "pageSize",
            "sort",
            "direction",
          ]
        : [];
  const queryString = supportedFilterNames
    .reduce((next, name) => {
      const value = searchParams.get(name);
      if (value) next.set(name, value);
      return next;
    }, new URLSearchParams())
    .toString();
  const load = () => {
    const endpoint = endpointFor[view];
    if (!endpoint) {
      setRows([]);
      setState("ready");
      return;
    }
    setState("loading");
    apiJson<Record<string, any[]>>(
      `${endpoint.url}${queryString ? `?${queryString}` : ""}`,
    )
      .then((payload) => {
        setRows(
          Array.isArray(payload[endpoint.key]) ? payload[endpoint.key] : [],
        );
        setState("ready");
      })
      .catch(() => setState("error"));
  };
  useEffect(load, [view, queryString]);
  useEffect(() => {
    if (focus?.entityId) setSelectedSku(focus.entityId);
  }, [focus?.entityId]);
  const items = rows as Item[];
  const visible = useMemo(
    () => (view === "warnings" ? items.filter(isShort) : rows),
    [items, rows, view],
  );
  const selected =
    view === "overview" || view === "warnings"
      ? items.find(
          (row) => row.sku === selectedSku || row.itemId === selectedSku,
        )
      : null;
  const activeFilters = [
    ["relatedSalesOrderId", "销售订单"],
    ["sourceDocumentId", "来源单据"],
    ["sourceDocumentLineId", "来源行"],
    ["postingBatchId", "Posting Batch"],
    ["sku", "SKU"],
    ["warehouseId", "仓库"],
    ["locationKey", "库位"],
    ["movementType", "流水类型"],
    ["itemId", "物料"],
    ["status", "状态"],
  ].flatMap(([name, label]) =>
    searchParams.get(name)
      ? [{ name, label, value: searchParams.get(name)! }]
      : [],
  );
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    supportedFilterNames.forEach((name) => next.delete(name));
    setSearchParams(next);
  };
  const emptyState = emptyStateFor[view] || {
    title: "当前工作区暂无库存记录",
    description: "页面不会用固定 SKU、批次、序列号或移动记录补足空数据。",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">库存管理</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>
            仅显示库存运行时仓库中的正式记录；没有记录时保持为空。
          </p>
        </div>
        <button
          onClick={load}
          aria-label="刷新库存"
          className="rounded-md p-2"
          style={{ color: A.blue }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {activeFilters.length > 0 && (
        <Card className="p-4" data-testid="inventory-active-filters">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold">当前筛选：</span>
            {activeFilters.map((filter) => (
              <Chip
                key={filter.name}
                label={`${filter.label}：${filter.value}`}
                color={A.blue}
                bg="#eef5ff"
              />
            ))}
            <button
              type="button"
              className="ml-auto rounded-md px-3 py-1.5 font-semibold"
              style={{ background: A.gray6, color: A.label }}
              onClick={clearFilters}
            >
              清除筛选
            </button>
          </div>
        </Card>
      )}
      {state === "loading" && (
        <Card className="p-8 text-sm" style={{ color: A.sub }}>
          正在读取库存运行时数据...
        </Card>
      )}
      {state === "error" && (
        <Card className="p-8 text-sm" style={{ color: A.red }}>
          库存数据读取失败。请检查运行时服务后重试。
        </Card>
      )}
      {state === "ready" && visible.length === 0 && (
        <Card className="p-10 text-center">
          <Boxes className="mx-auto mb-3" size={28} color={A.gray2} />
          <div className="text-sm font-semibold">{emptyState.title}</div>
          <p className="mt-2 text-xs" style={{ color: A.sub }}>
            {emptyState.description}
          </p>
        </Card>
      )}
      {state === "ready" &&
        visible.length > 0 &&
        (view === "overview" || view === "warnings") && (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  {[
                    "SKU / 物料",
                    "仓库 / 库位",
                    "在手量",
                    "预留量",
                    "可用量",
                    "安全库存 / 再订货点",
                    "状态",
                    "操作",
                  ].map((h) => (
                    <th key={h} className="px-4 py-3 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(visible as Item[]).map((item) => (
                  <tr
                    key={
                      item.id ||
                      `${item.sku}-${item.warehouseId}-${item.locationKey}`
                    }
                    data-testid={`inventory-item-${item.sku}`}
                    style={{ borderBottom: `1px solid ${A.border}` }}
                  >
                    <td className="px-4 py-3">
                      <EntityLink
                        kind="item"
                        id={item.itemId || item.sku}
                        className="text-xs"
                      >
                        {item.sku}
                      </EntityLink>
                      <div className="mt-1" style={{ color: A.sub }}>
                        {item.itemName || item.name || "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {item.warehouseId || item.defaultWarehouseId || "—"}
                      <div className="mt-1" style={{ color: A.sub }}>
                        {item.location || item.locationKey || "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {view === "overview"
                        ? item.onHandQuantity || "0.0000"
                        : Number(item.onHandQuantity || 0)}{" "}
                      {item.unit || ""}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {view === "overview"
                        ? item.reservedQuantity || "0.0000"
                        : Number(item.reservedQuantity || 0)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {view === "overview"
                        ? item.availableQuantity || "0.0000"
                        : quantity(item)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {Number(item.safetyStock || 0)} / {reorder(item)}
                    </td>
                    <td className="px-4 py-3">
                      {view === "warnings" && isShort(item) ? (
                        <Chip label="需补货" color={A.orange} bg="#fff7e8" />
                      ) : (
                        <Chip
                          label={item.status || "正常"}
                          color={A.green}
                          bg="#edf9f2"
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-md px-3 py-1.5 font-semibold"
                          style={{ background: A.gray6, color: A.label }}
                          onClick={() => setSelectedSku(item.sku)}
                        >
                          库存详情
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      {state === "ready" && visible.length > 0 && view === "lots" && (
        <SimpleTable
          headers={["批次", "SKU", "物料", "数量", "到期日", "状态"]}
          rows={(visible as Lot[]).map((row) => [
            row.lotId || row.lot,
            <EntityLink kind="item" id={row.sku}>
              {row.sku}
            </EntityLink>,
            row.itemName,
            row.quantity,
            row.expiryDate,
            row.status,
          ])}
        />
      )}
      {state === "ready" && visible.length > 0 && view === "serials" && (
        <SimpleTable
          headers={["序列号", "SKU", "仓库", "状态"]}
          rows={(visible as Serial[]).map((row) => [
            row.serialId || row.sn,
            <EntityLink kind="item" id={row.sku}>
              {row.sku}
            </EntityLink>,
            row.warehouseId,
            row.status,
          ])}
        />
      )}
      {state === "ready" && visible.length > 0 && view === "movements" && (
        <SimpleTable
          headers={[
            "移动单号",
            "SKU",
            "仓库 / 库位",
            "入库",
            "出库",
            "日期",
            "状态",
          ]}
          rows={(visible as Movement[]).map((row) => [
            row.movementId,
            <EntityLink kind="item" id={row.sku}>
              {row.sku}
            </EntityLink>,
            `${row.warehouseId || "—"} / ${row.location || "—"}`,
            row.quantityIn,
            row.quantityOut,
            row.date,
            row.status,
          ])}
        />
      )}
      {state === "ready" && visible.length > 0 && view === "exceptions" && (
        <SimpleTable
          headers={["异常单号", "SKU", "物料", "数量影响", "原因", "状态"]}
          rows={(visible as InventoryException[]).map((row) => [
            row.id,
            <EntityLink kind="item" id={row.sku}>
              {row.sku}
            </EntityLink>,
            row.itemName,
            row.quantityImpact,
            row.reason,
            row.status,
          ])}
        />
      )}
      {selected && (
        <Card className="p-4" data-testid="inventory-local-detail">
          <div className="flex items-center gap-2">
            <AlertTriangle
              size={15}
              color={
                view === "warnings" && isShort(selected) ? A.orange : A.green
              }
            />
            <h3 className="text-sm font-semibold">库存详情 · {selected.sku}</h3>
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <span>
              在手：
              {view === "overview"
                ? selected.onHandQuantity || "0.0000"
                : Number(selected.onHandQuantity || 0)}
            </span>
            <span>
              预留：
              {view === "overview"
                ? selected.reservedQuantity || "0.0000"
                : Number(selected.reservedQuantity || 0)}
            </span>
            <span>
              可用：
              {view === "overview"
                ? selected.availableQuantity || "0.0000"
                : quantity(selected)}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: any[][] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr style={{ borderBottom: `1px solid ${A.border}` }}>
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${A.border}` }}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3">
                  {cell ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
