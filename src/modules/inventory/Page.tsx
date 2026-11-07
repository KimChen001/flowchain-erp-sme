import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertTriangle, Boxes, ListChecks, PackageOpen, Warehouse } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { formatDateTimeInTimeZone, formatQuantity } from "../../lib/format";
import { movementTypeLabel, statusCodeLabel } from "../../i18n/statusLabels";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useReorderListCopy } from "./reorderListCopy";

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
  movementType?: string;
  reason?: string | null;
  sourceDocumentId?: string;
  relatedGrnId?: string;
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

const COPY = {
  stockedItems: ["Stocked items", "有库存的物料"],
  stockedItemsNote: ["SKUs with a posted balance", "已过账余额的 SKU"],
  short: ["Need replenishment", "需补货"],
  shortNote: ["Below safety stock or at the reorder point", "低于安全库存或达到再订货点"],
  reserved: ["Reserved lines", "有预留的行"],
  reservedNote: ["Balances with stock held for orders", "为订单预留了库存的余额"],
  warehouses: ["Warehouses", "仓库"],
  warehousesNote: ["Warehouses holding stock you can see", "你可查看且有库存的仓库"],
  // The warnings page counts its own warnings rather than repeating the stock page's cards.
  belowSafety: ["Below safety stock", "低于安全库存"],
  belowSafetyNote: ["Available stock under the item's safety stock", "可用量低于物料的安全库存"],
  atReorderPoint: ["At the reorder point", "达到再订货点"],
  atReorderPointNote: ["Available stock at or below the reorder point", "可用量等于或低于再订货点"],
  noneAvailable: ["Nothing available", "无可用库存"],
  noneAvailableNote: ["Items with a warning and no stock available", "有预警且没有可用库存的物料"],
  searchBalances: ["Inventory search", "库存查询"],
  searchBalancesSubtitle: ["Only posted stock is shown. Search by SKU or item, warehouse and stock status.", "仅显示已过账的库存记录。可按 SKU 或物料、仓库和库存状态查询。"],
  searchWarnings: ["Warning search", "预警查询"],
  searchWarningsSubtitle: ["Stock below safety stock or at the reorder point, judged over every location of the item.", "按物料在所有库位的合计可用量，判断是否低于安全库存或达到再订货点。"],
  searchMovements: ["Movement search", "流水查询"],
  searchMovementsSubtitle: ["Posted receipts, shipments, transfers and adjustments.", "已过账的入库、出库、调拨和调整。"],
  searchLots: ["Lot search", "批次查询"],
  searchSerials: ["Serial number search", "序列号查询"],
  searchExceptions: ["Exception search", "异常查询"],
  searchTrackedSubtitle: ["Records appear once tracked stock is posted.", "启用追踪并完成过账后才会出现记录。"],
  search: ["Search", "搜索"],
  searchItem: ["SKU or item name", "SKU 或物料名称"],
  searchMovement: ["SKU, item or source document", "SKU、物料或来源单据"],
  searchRecord: ["Number, SKU or item", "编号、SKU 或物料"],
  warehouse: ["Warehouse", "仓库"],
  allWarehouses: ["All warehouses", "全部仓库"],
  stockStatus: ["Stock status", "库存状态"],
  allStock: ["All stock", "全部库存"],
  sufficient: ["Sufficient", "库存充足"],
  outOfStock: ["Out of stock", "缺货"],
  movementType: ["Movement type", "流水类型"],
  allTypes: ["All types", "全部类型"],
  status: ["Status", "状态"],
  allStatuses: ["All statuses", "全部状态"],
  balanceList: ["Inventory balance list", "库存余额列表"],
  warningList: ["Warning list", "预警列表"],
  movementList: ["Movement list", "库存流水列表"],
  lotList: ["Lot list", "批次列表"],
  serialList: ["Serial number list", "序列号列表"],
  exceptionList: ["Exception list", "异常列表"],
  skuItem: ["SKU / item", "SKU / 物料"],
  warehouseLocation: ["Warehouse / location", "仓库 / 库位"],
  onHand: ["On hand", "在手量"],
  reservedQty: ["Reserved", "预留量"],
  available: ["Available", "可用量"],
  safetyReorder: ["Safety stock / reorder point", "安全库存 / 再订货点"],
  actions: ["Actions", "操作"],
  details: ["Details", "详情"],
  type: ["Type", "类型"],
  source: ["Source document", "来源单据"],
  quantityIn: ["In", "入库"],
  quantityOut: ["Out", "出库"],
  date: ["Date", "日期"],
  lot: ["Lot", "批次"],
  quantity: ["Quantity", "数量"],
  expiry: ["Expiry date", "到期日"],
  serial: ["Serial number", "序列号"],
  exception: ["Exception", "异常单号"],
  impact: ["Quantity impact", "数量影响"],
  reason: ["Reason", "原因"],
  loadFailed: ["Inventory could not be loaded", "库存数据加载失败"],
  noMatch: ["Nothing matches these filters", "没有符合筛选条件的记录"],
  reorderList: ["Open the reorder list", "打开补货清单"],
  activeFilters: ["Filtered by", "当前筛选"],
  clearFilters: ["Clear filters", "清除筛选"],
  closeDetail: ["Close", "关闭"],
} as const;

// Built when the page renders, so the copy follows the interface language.
const emptyStateFor = (copy: (label: string) => string): Record<string, { title: string; description: string }> => ({
  overview: {
    title: copy("当前工作区暂无库存余额"),
    description: copy("尚未读取到当前用户有权查看的仓库库存余额。"),
  },
  movements: {
    title: copy("当前工作区暂无库存流水"),
    description: copy("库存余额可以由本地场景显式加载；只有正式入库、出库、调拨或调整过账后才会产生流水。"),
  },
  warnings: {
    title: copy("当前没有库存预警"),
    description: copy("当前可见库存余额未低于安全库存或再订货点。"),
  },
  lots: {
    title: copy("当前工作区暂无批次记录"),
    description: copy("只有启用批次管理并完成正式库存过账后才会出现批次记录。"),
  },
  serials: {
    title: copy("当前工作区暂无序列号记录"),
    description: copy("只有启用序列号管理并完成正式库存过账后才会出现序列号记录。"),
  },
  exceptions: {
    title: copy("当前没有库存异常"),
    description: copy("当前可见库存记录未产生需要处理的异常。"),
  },
});

function quantity(item: Item) {
  return Number(item.availableQuantity ?? item.onHandQuantity ?? 0);
}
function reorder(item: Item) {
  return Number(item.reorderPoint ?? item.safetyStock ?? 0);
}
// The safety stock and reorder point are one figure for the whole item, so
// they are set against the item's available stock over every location shown,
// as the reorder list sets them against the item's stock; a location's row is
// never judged on its own (65 EA over A-01 and an unlocated record is above a
// reorder point of 40, though each row alone is below it).
function availableBySku(items: Item[]) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.sku, (totals.get(item.sku) || 0) + quantity(item));
  return totals;
}
// Below the safety stock, or at or below the reorder point, as the reorder
// list and the assistant judge it. 0 means none is recorded.
function isShort(item: Item, totals: Map<string, number>) {
  const available = totals.get(item.sku) ?? quantity(item);
  const safetyStock = Number(item.safetyStock || 0);
  const reorderPoint = Number(item.reorderPoint || 0);
  return (safetyStock > 0 && available < safetyStock) || (reorderPoint > 0 && available <= reorderPoint);
}
const contains = (needle: string, ...values: unknown[]) =>
  !needle.trim() || values.some((value) => String(value ?? "").toLowerCase().includes(needle.trim().toLowerCase()));

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
  const copy = useWorkspaceCopy();
  const warehouseName = useWarehouseNames();
  const { language, locale, timezone } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const statusLabel = (code?: string) => (code ? statusCodeLabel(code, language) || copy(code) : "—");
  const reorderCopy = useReorderListCopy();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<any[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedSku, setSelectedSku] = useState(focus?.entityId || "");
  const [query, setQuery] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [stockStatus, setStockStatus] = useState("");
  const [movementType, setMovementType] = useState("");
  const [status, setStatus] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);
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
  const totals = useMemo(() => availableBySku(items), [items]);
  const base = useMemo(
    () => (view === "warnings" ? items.filter((item) => isShort(item, totals)) : rows),
    [items, rows, totals, view],
  );
  const stockStateOf = (item: Item) => quantity(item) <= 0 && Number(item.onHandQuantity ?? 0) <= 0 ? "out" : isShort(item, totals) ? "short" : "ok";
  const visible = base.filter((row: any) => {
    if (view === "overview" || view === "warnings") {
      const item = row as Item;
      return contains(query, item.sku, item.itemName, item.name)
        && (!warehouse || (item.warehouseId || item.defaultWarehouseId) === warehouse)
        && (!stockStatus || stockStateOf(item) === stockStatus);
    }
    if (view === "movements") {
      const movement = row as Movement;
      return contains(query, movement.sku, movement.itemName, movement.sourceDocumentId, movement.relatedGrnId)
        && (!warehouse || movement.warehouseId === warehouse)
        && (!movementType || movement.movementType === movementType);
    }
    return contains(query, row.lotId, row.lot, row.serialId, row.sn, row.id, row.sku, row.itemName)
      && (!status || row.status === status);
  });
  const selected =
    view === "overview" || view === "warnings"
      ? items.find(
          (row) => row.sku === selectedSku || row.itemId === selectedSku,
        )
      : null;
  useEffect(() => {
    if (selected && !focus?.entityId) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedSku]);
  // Each filter chip names one value, so its label is singular.
  const english = language === "en-US";
  const activeFilters = [
    { name: "relatedSalesOrderId", en: "Sales order", zh: "销售订单" },
    { name: "sourceDocumentId", en: "Source document", zh: "来源单据" },
    { name: "sourceDocumentLineId", en: "Source line", zh: "来源行" },
    { name: "postingBatchId", en: "Posting batch", zh: "过账批次" },
    { name: "sku", en: "SKU", zh: "SKU" },
    { name: "warehouseId", en: "Warehouse", zh: "仓库" },
    { name: "locationKey", en: "Location", zh: "库位" },
    { name: "movementType", en: "Movement type", zh: "流水类型" },
    { name: "itemId", en: "Item", zh: "物料" },
    { name: "status", en: "Status", zh: "状态" },
  ].flatMap(({ name, en, zh }) =>
    searchParams.get(name)
      ? [{ name, label: english ? en : zh, value: searchParams.get(name)! }]
      : [],
  );
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    supportedFilterNames.forEach((name) => next.delete(name));
    setSearchParams(next);
  };
  const reset = () => {
    setQuery("");
    setWarehouse("");
    setStockStatus("");
    setMovementType("");
    setStatus("");
    if (activeFilters.length) clearFilters();
  };
  const emptyState = emptyStateFor(copy)[view] || {
    title: copy("当前工作区暂无库存记录"),
    description: copy("页面不会用固定 SKU、批次、序列号或移动记录补足空数据。"),
  };
  const warehouseIds = [...new Set(rows.map((row: any) => row.warehouseId || row.defaultWarehouseId).filter(Boolean))] as string[];
  const movementTypes = [...new Set((rows as Movement[]).map((row) => row.movementType).filter(Boolean))] as string[];
  const statuses = [...new Set(rows.map((row: any) => row.status).filter(Boolean))] as string[];
  const balances = view === "overview" || view === "warnings";
  // Each warned SKU once, judged on its stock over every location shown, as the list judges it.
  const warningSkus = [...new Set(items.filter((item) => isShort(item, totals)).map((item) => item.sku))];
  const warningFacts = (sku: string) => {
    const item = items.find((row) => row.sku === sku) as Item;
    const available = totals.get(sku) ?? quantity(item);
    const safetyStock = Number(item.safetyStock || 0);
    const reorderPoint = Number(item.reorderPoint || 0);
    return { available, belowSafety: safetyStock > 0 && available < safetyStock, atReorderPoint: reorderPoint > 0 && available <= reorderPoint };
  };
  const count = (value: number) => (state === "ready" ? String(value) : "—");
  const stateRow = (colSpan: number) =>
    state === "loading" ? <ListStateRow colSpan={colSpan} state="loading" />
      : state === "error" ? <ListStateRow colSpan={colSpan} state="error" title={tr("loadFailed")} onRetry={load} />
        : visible.length === 0 ? (base.length === 0 && !activeFilters.length
          ? <ListStateRow colSpan={colSpan} state="empty" title={emptyState.title} detail={emptyState.description} />
          : <ListStateRow colSpan={colSpan} state="empty" title={tr("noMatch")} />)
          : null;
  const head = (labels: Array<[string, "left" | "right"]>) => (
    <thead>
      <tr style={listHeadRowStyle}>
        {labels.map(([label, align], index) => (
          <th
            key={label}
            className={`${align === "right" ? thRightClass : thClass} ${index === 0 ? "sticky left-0 z-20 bg-white" : ""}`}
            style={{ color: A.gray1 }}
          >
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );
  const searchTitle = { overview: "searchBalances", warnings: "searchWarnings", movements: "searchMovements", lots: "searchLots", serials: "searchSerials", exceptions: "searchExceptions" }[view] as keyof typeof COPY | undefined;
  const searchSubtitle = view === "overview" ? tr("searchBalancesSubtitle") : view === "warnings" ? tr("searchWarningsSubtitle") : view === "movements" ? tr("searchMovementsSubtitle") : tr("searchTrackedSubtitle");
  const listTitle = { overview: "balanceList", warnings: "warningList", movements: "movementList", lots: "lotList", serials: "serialList", exceptions: "exceptionList" }[view] as keyof typeof COPY | undefined;

  return (
    <div className="space-y-5">
      {view === "warnings" && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="inventory-warning-cards">
          <ActionableMetricCard label={tr("short")} value={count(warningSkus.length)} description={tr("shortNote")} to="/app/inventory/warnings" icon={AlertTriangle} color={A.orange} />
          <ActionableMetricCard label={tr("belowSafety")} value={count(warningSkus.filter((sku) => warningFacts(sku).belowSafety).length)} description={tr("belowSafetyNote")} to="/app/inventory/warnings" icon={PackageOpen} color={A.red} />
          <ActionableMetricCard label={tr("atReorderPoint")} value={count(warningSkus.filter((sku) => warningFacts(sku).atReorderPoint).length)} description={tr("atReorderPointNote")} to="/app/inventory/reorder" icon={Boxes} color={A.blue} />
          <ActionableMetricCard label={tr("noneAvailable")} value={count(warningSkus.filter((sku) => warningFacts(sku).available <= 0).length)} description={tr("noneAvailableNote")} to="/app/inventory/warnings" icon={Warehouse} color={A.gray1} />
        </div>
      )}
      {view === "overview" && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <ActionableMetricCard label={tr("stockedItems")} value={count(new Set(items.map((item) => item.sku)).size)} description={tr("stockedItemsNote")} to="/app/inventory/stock" icon={Boxes} color={A.blue} />
          <ActionableMetricCard label={tr("short")} value={count(new Set(items.filter((item) => isShort(item, totals)).map((item) => item.sku)).size)} description={tr("shortNote")} to="/app/inventory/warnings" icon={AlertTriangle} color={A.orange} />
          <ActionableMetricCard label={tr("reserved")} value={count(items.filter((item) => Number(item.reservedQuantity || 0) > 0).length)} description={tr("reservedNote")} to="/app/inventory/stock" icon={PackageOpen} color={A.purple} />
          <ActionableMetricCard label={tr("warehouses")} value={count(warehouseIds.length)} description={tr("warehousesNote")} to="/app/inventory/stock" icon={Warehouse} color={A.gray1} />
        </div>
      )}

      <ListSearchCard
        title={searchTitle ? tr(searchTitle) : tr("search")}
        subtitle={searchSubtitle}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={load} />
          {view === "warnings" && (
            <Link to="/app/inventory/reorder" data-testid="inventory-warnings-reorder-link" className={listButtonClass.export} title={reorderCopy("fromWarnings")}>
              <ListChecks size={13} />{tr("reorderList")}
            </Link>
          )}
        </>}
      >
        <Field label={tr("search")}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr(balances ? "searchItem" : view === "movements" ? "searchMovement" : "searchRecord")}
            style={inputStyle}
          />
        </Field>
        {(balances || view === "movements") && (
          <Field label={tr("warehouse")}>
            <select value={warehouse} onChange={(event) => setWarehouse(event.target.value)} style={inputStyle}>
              <option value="">{tr("allWarehouses")}</option>
              {warehouseIds.map((id) => <option key={id} value={id}>{warehouseName(id) || id}</option>)}
            </select>
          </Field>
        )}
        {balances && (
          <Field label={tr("stockStatus")}>
            <select value={stockStatus} onChange={(event) => setStockStatus(event.target.value)} style={inputStyle}>
              <option value="">{tr("allStock")}</option>
              <option value="short">{tr("short")}</option>
              <option value="out">{tr("outOfStock")}</option>
              <option value="ok">{tr("sufficient")}</option>
            </select>
          </Field>
        )}
        {view === "movements" && (
          <Field label={tr("movementType")}>
            <select value={movementType} onChange={(event) => setMovementType(event.target.value)} style={inputStyle}>
              <option value="">{tr("allTypes")}</option>
              {movementTypes.map((code) => <option key={code} value={code}>{movementTypeLabel(code, language)}</option>)}
            </select>
          </Field>
        )}
        {!balances && view !== "movements" && (
          <Field label={tr("status")}>
            <select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}>
              <option value="">{tr("allStatuses")}</option>
              {statuses.map((code) => <option key={code} value={code}>{statusLabel(code)}</option>)}
            </select>
          </Field>
        )}
        {activeFilters.length > 0 && (
          <div className="md:col-span-2 lg:col-span-4" data-testid="inventory-active-filters">
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
              <span className="font-semibold" style={{ color: A.sub }}>{tr("activeFilters")}</span>
              {activeFilters.map((filter) => (
                <Chip
                  key={filter.name}
                  label={`${filter.label}: ${filter.value}`}
                  color={A.blue}
                  bg="#eef5ff"
                />
              ))}
              <button type="button" className={`ml-auto ${listButtonClass.secondary}`} onClick={clearFilters}>
                {tr("clearFilters")}
              </button>
            </div>
          </div>
        )}
      </ListSearchCard>

      {selected && (
        <div ref={detailRef}>
          <Card className="p-5" data-testid="inventory-local-detail">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} color={isShort(selected, totals) ? A.orange : A.green} />
              <h3 className="fc-section-title" style={{ color: A.label }}>
                {copy("库存详情")} · <EntityLink kind="item" id={selected.itemId || selected.sku}>{selected.sku}</EntityLink>
                <span className="ml-2 font-normal" style={{ color: A.sub }}>{selected.itemName || selected.name || ""}</span>
              </h3>
              <button type="button" className={`ml-auto ${listButtonClass.secondary}`} onClick={() => setSelectedSku("")}>{tr("closeDetail")}</button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
              {([
                [tr("onHand"), `${formatQuantity(selected.onHandQuantity ?? "0")} ${unitLabel(selected.unit, language, Number(selected.onHandQuantity ?? 0))}`],
                [tr("reservedQty"), formatQuantity(selected.reservedQuantity ?? "0")],
                [tr("available"), view === "overview" ? formatQuantity(selected.availableQuantity ?? "0") : formatQuantity(quantity(selected))],
                [tr("safetyReorder"), `${formatQuantity(Number(selected.safetyStock || 0))} / ${formatQuantity(reorder(selected))}`],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                  <div style={{ color: A.sub }}>{label}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums" style={{ color: A.label }}>{value}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {listTitle && (
        <ListCard title={tr(listTitle)} total={state === "ready" ? base.length : undefined} shown={visible.length}>
          <div className={tableScrollClass}>
            {balances && (
              <table className={`w-full min-w-[1000px] text-left ${tableBodyTextClass}`}>
                {head([[tr("skuItem"), "left"], [tr("warehouseLocation"), "left"], [tr("onHand"), "right"], [tr("reservedQty"), "right"], [tr("available"), "right"], [tr("safetyReorder"), "right"], [tr("status"), "left"], [tr("actions"), "left"]])}
                <tbody>
                  {stateRow(8)}
                  {state === "ready" && (visible as Item[]).map((item, index) => {
                    const stock = stockStateOf(item);
                    return (
                      <tr
                        key={item.id || `${item.sku}-${item.warehouseId}-${item.locationKey}`}
                        data-testid={`inventory-item-${item.sku}`}
                        className={listRowClass}
                        style={listRowStyle(index, visible.length)}
                      >
                        <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                          <EntityLink kind="item" id={item.itemId || item.sku} className={tableLinkClass}>{item.sku}</EntityLink>
                          <div className="max-w-[220px] truncate text-[11px] font-normal" style={{ color: A.sub }}>{item.itemName || item.name || "—"}</div>
                        </td>
                        <td className={tdNameClass}>
                          {warehouseName(item.warehouseId || item.defaultWarehouseId) || "—"}
                          <div className="text-[11px]" style={{ color: A.sub }}>{item.location || item.locationKey || "—"}</div>
                        </td>
                        <td className={tdNumericRightClass}>{formatQuantity(item.onHandQuantity ?? "0")} {unitLabel(item.unit, language, Number(item.onHandQuantity ?? 0))}</td>
                        <td className={tdNumericRightClass}>{formatQuantity(item.reservedQuantity ?? "0")}</td>
                        <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>
                          {view === "overview" ? formatQuantity(item.availableQuantity ?? "0") : formatQuantity(quantity(item))}
                        </td>
                        <td className={tdNumericRightClass} style={{ color: A.sub }}>{formatQuantity(Number(item.safetyStock || 0))} / {formatQuantity(reorder(item))}</td>
                        <td className={tdNowrapClass}>
                          {/* Both pages say when stock is below safety stock or at the reorder point, as the warnings page lists it. */}
                          {stock === "out"
                            ? <StatusChip label={tr("outOfStock")} tone="danger" />
                            : stock === "short"
                              ? <StatusChip label={tr("short")} tone="warning" />
                              : <StatusChip label={tr("sufficient")} tone="success" />}
                        </td>
                        <td className={tdNowrapClass}>
                          <button type="button" className={rowActionClass.primary} onClick={() => setSelectedSku(item.sku)}>{tr("details")}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {view === "movements" && (
              <table className={`w-full min-w-[1000px] text-left ${tableBodyTextClass}`}>
                {head([[tr("type"), "left"], [tr("source"), "left"], [tr("skuItem"), "left"], [tr("warehouseLocation"), "left"], [tr("quantityIn"), "right"], [tr("quantityOut"), "right"], [tr("date"), "left"], [tr("status"), "left"]])}
                <tbody>
                  {stateRow(8)}
                  {state === "ready" && (visible as Movement[]).map((row, index) => (
                    <tr key={row.movementId || index} className={listRowClass} style={listRowStyle(index, visible.length)}>
                      {/* The movement's own id is an internal UUID; show what moved it instead. */}
                      <td className={`${tdNowrapClass} sticky left-0 z-10 bg-white font-medium`} style={{ color: A.label }}>{movementTypeLabel(row.movementType || "", language, row.reason)}</td>
                      <td className={tdNowrapClass}>
                        {row.relatedGrnId
                          ? <EntityLink kind="receiving_doc" id={row.relatedGrnId} className={tableLinkClass}>{row.relatedGrnId}</EntityLink>
                          : row.sourceDocumentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(row.sourceDocumentId) ? row.sourceDocumentId : <span style={{ color: A.gray2 }}>—</span>}
                      </td>
                      <td className={tdNameClass}>
                        <EntityLink kind="item" id={row.sku} className={tableLinkClass}>{row.sku}</EntityLink>
                        {row.itemName && <div className="max-w-[200px] truncate text-[11px]" style={{ color: A.sub }}>{row.itemName}</div>}
                      </td>
                      <td className={tdNameClass}>
                        {warehouseName(row.warehouseId) || "—"}
                        <div className="text-[11px]" style={{ color: A.sub }}>{row.location || "—"}</div>
                      </td>
                      <td className={tdNumericRightClass} style={{ color: Number(row.quantityIn || 0) ? "#0f766e" : A.gray2 }}>{Number(row.quantityIn || 0) ? formatQuantity(row.quantityIn) : "—"}</td>
                      <td className={tdNumericRightClass} style={{ color: Number(row.quantityOut || 0) ? A.label : A.gray2 }}>{Number(row.quantityOut || 0) ? formatQuantity(row.quantityOut) : "—"}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{formatDateTimeInTimeZone(row.date, locale, timezone)}</td>
                      <td className={tdNowrapClass}><StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view === "lots" && (
              <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`}>
                {head([[tr("lot"), "left"], [tr("skuItem"), "left"], [tr("warehouse"), "left"], [tr("quantity"), "right"], [tr("expiry"), "left"], [tr("status"), "left"]])}
                <tbody>
                  {stateRow(6)}
                  {state === "ready" && (visible as Lot[]).map((row, index) => (
                    <tr key={row.lotId || row.lot || index} className={listRowClass} style={listRowStyle(index, visible.length)}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>{row.lotId || row.lot || "—"}</td>
                      <td className={tdNameClass}>
                        <EntityLink kind="item" id={row.sku} className={tableLinkClass}>{row.sku}</EntityLink>
                        {row.itemName && <div className="text-[11px]" style={{ color: A.sub }}>{row.itemName}</div>}
                      </td>
                      <td className={tdNowrapClass}>{warehouseName(row.warehouseId) || "—"}</td>
                      <td className={tdNumericRightClass}>{formatQuantity(row.quantity ?? 0)}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{row.expiryDate ? String(row.expiryDate).slice(0, 10) : "—"}</td>
                      <td className={tdNowrapClass}><StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view === "serials" && (
              <table className={`w-full min-w-[760px] text-left ${tableBodyTextClass}`}>
                {head([[tr("serial"), "left"], [tr("skuItem"), "left"], [tr("warehouse"), "left"], [tr("status"), "left"]])}
                <tbody>
                  {stateRow(4)}
                  {state === "ready" && (visible as Serial[]).map((row, index) => (
                    <tr key={row.serialId || row.sn || index} className={listRowClass} style={listRowStyle(index, visible.length)}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>{row.serialId || row.sn || "—"}</td>
                      <td className={tdNameClass}><EntityLink kind="item" id={row.sku} className={tableLinkClass}>{row.sku}</EntityLink></td>
                      <td className={tdNowrapClass}>{warehouseName(row.warehouseId) || "—"}</td>
                      <td className={tdNowrapClass}><StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view === "exceptions" && (
              <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`}>
                {head([[tr("exception"), "left"], [tr("skuItem"), "left"], [tr("impact"), "right"], [tr("reason"), "left"], [tr("status"), "left"]])}
                <tbody>
                  {stateRow(5)}
                  {state === "ready" && (visible as InventoryException[]).map((row, index) => (
                    <tr key={row.id || index} className={listRowClass} style={listRowStyle(index, visible.length)}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>{row.id}</td>
                      <td className={tdNameClass}>
                        <EntityLink kind="item" id={row.sku} className={tableLinkClass}>{row.sku}</EntityLink>
                        {row.itemName && <div className="text-[11px]" style={{ color: A.sub }}>{row.itemName}</div>}
                      </td>
                      <td className={tdNumericRightClass}>{row.quantityImpact === undefined ? "—" : formatQuantity(row.quantityImpact)}</td>
                      <td className={`${tdNameClass} max-w-[320px] truncate`} title={row.reason ? copy(row.reason) : undefined}>{row.reason ? copy(row.reason) : "—"}</td>
                      <td className={tdNowrapClass}><StatusChip label={statusLabel(row.status)} tone={statusToneOf(row.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </ListCard>
      )}
    </div>
  );
}
