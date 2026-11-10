import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericClass, thClass } from "../../components/ui/workbenchTable";
import { createSecureClientMutationId } from "../../lib/client-id";

import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useInventoryOperationsCopy } from "./inventoryOperationsCopy";
import { formatDateTimeInTimeZone, formatQuantity } from "../../lib/format";
import { unitLabel } from "../../i18n/unitLabels";
import { movementTypeLabel } from "../../i18n/statusLabels";
import { useI18n } from "../../i18n/I18n";
import { DataImportLink } from "../master-data/DataImportLink";
type Capability = { enabled: boolean; maturity?: string };
type Entry = {
  capabilities: Record<string, Capability>;
  warehouses: Array<{
    id: string;
    code: string;
    name: string;
    canOperate: boolean;
  }>;
  items: Array<{ id: string; sku: string; name: string; unit?: string }>;
  balances: Array<{
    id: string;
    itemId?: string;
    sku: string;
    itemName?: string;
    warehouseId: string;
    location: string;
    locationKey: string;
    onHandQuantity: string;
    reservedQuantity: string;
    availableQuantity: string;
    unit?: string;
    version: number;
    canOperate: boolean;
  }>;
};
type TransferLine = {
  itemId: string;
  quantity: string;
  sourceWarehouseId: string;
  sourceLocation: string;
  destinationWarehouseId: string;
  destinationLocation: string;
};
type AdjustmentLine = {
  mode: "existing" | "new";
  inventoryBalanceId: string;
  itemId: string;
  warehouseId: string;
  location: string;
  adjustmentQuantity: string;
};

const field =
  "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400";
// Create-form inputs fill their grid cell and may shrink, so a line's fields
// never run under each other.
const formField = `${field} w-full min-w-0`;
const formLabel = "grid min-w-0 gap-1 text-xs";
const button =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40";
const secondary =
  "rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-40";
const key = (prefix: string) => createSecureClientMutationId(prefix);
const enabled = (entry: Entry | null) =>
  Boolean(
    entry && Object.values(entry.capabilities).every((item) => item.enabled),
  );

function Status({ value }: { value: string }) {
  const { copy, inventoryCodeLabel } = useInventoryOperationsCopy();
  return (
    <Chip
      label={inventoryCodeLabel(value)}
      color={
        value === "posted" || value === "ready"
          ? A.green
          : value === "cancelled" || value === "reversed"
            ? A.orange
            : A.blue
      }
      bg={value === "posted" || value === "ready" ? "#edf9f2" : "#eef5ff"}
    />
  );
}

export default function InventoryOperationsWorkbench() {
  const { copy, inventoryCodeLabel, errorText } = useInventoryOperationsCopy();
  const location = useLocation(),
    navigate = useNavigate();
  const [entry, setEntry] = useState<Entry | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    apiJson<Entry>("/api/inventory/operations/entry-data")
      .then(setEntry)
      .catch((reason) =>
        setError(
          errorText(reason, "库存操作入口加载失败"),
        ),
      );
  }, [refresh]);
  if (error) return <Card className="p-8 text-sm text-red-600">{error}</Card>;
  if (!entry)
    return (
      <Card className="p-8 text-sm text-slate-500">
        {copy("正在读取正式库存操作数据…")}
      </Card>
    );
  const path = location.pathname,
    parts = path.split("/").filter(Boolean),
    id =
      parts[3] && !["new"].includes(parts[3])
        ? decodeURIComponent(parts[3])
        : "";
  const common = { entry, refresh: () => setRefresh((value) => value + 1) };
  if (path === "/app/inventory/operations") return <Landing entry={entry} />;
  if (path === "/app/inventory/transfers/new")
    return <TransferCreate {...common} />;
  if (path === "/app/inventory/counts/new") return <CountCreate {...common} />;
  if (path === "/app/inventory/adjustments/new")
    return <AdjustmentCreate {...common} />;
  if (id && path.startsWith("/app/inventory/transfers/"))
    return <OperationDetail kind="transfer" id={id} {...common} />;
  if (id && path.startsWith("/app/inventory/counts/"))
    return <OperationDetail kind="count" id={id} {...common} />;
  if (id && path.startsWith("/app/inventory/adjustments/"))
    return <OperationDetail kind="adjustment" id={id} {...common} />;
  if (path === "/app/inventory/transfers")
    return <OperationList kind="transfer" />;
  if (path === "/app/inventory/counts") return <OperationList kind="count" />;
  if (path === "/app/inventory/adjustments")
    return <OperationList kind="adjustment" />;
  navigate("/app/inventory/operations", { replace: true });
  return null;
}

function ReadOnly({ entry }: { entry: Entry }) {
  const { copy, inventoryCodeLabel } = useInventoryOperationsCopy();
  return enabled(entry) ? null : (
    <Card
      className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
      data-testid="inventory-operations-readonly"
    >
      {copy("库存操作（测试版）尚未由管理员启用；正式记录保持只读，所有交易动作均已关闭。")}
    </Card>
  );
}

function Landing({ entry }: { entry: Entry }) {
  const { copy, inventoryCodeLabel } = useInventoryOperationsCopy();
  return (
    <div className="space-y-4" data-testid="inventory-operations-landing">
      <p className="text-xs text-slate-500">{copy("在仓库之间调拨库存、做循环盘点、按原因调整库存数量。")}</p>
      <ReadOnly entry={entry} />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          [
            "/app/inventory/transfers",
            copy("库存调拨"),
            copy("把库存从一个仓库或库位移到另一个；过账后可以冲销。"),
          ],
          ["/app/inventory/counts", copy("循环盘点"), copy("按快照盲盘，复核后把差异过账到库存。")],
          [
            "/app/inventory/adjustments",
            copy("库存调整"),
            copy("选择原因修改库存数量；过账前可预览，过账后可冲销。"),
          ],
        ].map(([to, title, description]) => (
          <Link
            key={to}
            to={to}
            className="rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-blue-200 hover:bg-blue-50/30"
          >
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">{description}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-blue-600">
              {copy("打开工作台 →")}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function OperationList({
  kind,
}: {
  kind: "transfer" | "count" | "adjustment";
}) {
  const { copy, inventoryCodeLabel } = useInventoryOperationsCopy();
  const { language, locale, timezone } = useI18n();
  const say = (en: string, zh: string) => (language === "en-US" ? en : zh);
  const warehouseName = useWarehouseNames();
  // The page title (from the route) names the list; the cards below carry
  // the search and the list, as on the purchase order list.
  const config = {
    transfer: {
      search: say("Search transfers", "查询库存调拨"),
      list: say("Transfer list", "库存调拨列表"),
      context: say("From → to", "调出 → 调入"),
      newLabel: say("New transfer", "新建调拨"),
      url: "/api/inventory/transfers",
      key: "transfers",
      number: "transferNumber",
      newPath: "/app/inventory/transfers/new",
    },
    count: {
      search: say("Search counts", "查询循环盘点"),
      list: say("Count list", "循环盘点列表"),
      context: say("Warehouse", "仓库"),
      newLabel: say("New count", "新建盘点"),
      url: "/api/inventory/counts",
      key: "counts",
      number: "countNumber",
      newPath: "/app/inventory/counts/new",
    },
    adjustment: {
      search: say("Search adjustments", "查询库存调整"),
      list: say("Adjustment list", "库存调整列表"),
      context: say("Reason", "原因"),
      newLabel: say("New adjustment", "新建调整"),
      url: "/api/inventory/adjustments",
      key: "adjustments",
      number: "adjustmentNumber",
      newPath: "/app/inventory/adjustments/new",
    },
  }[kind];
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    setState("loading");
    // The 100 most recently changed records (the API's largest page).
    apiJson<any>(`${config.url}?pageSize=100`)
      .then((data) => {
        if (!active) return;
        const list = data[config.key] || [];
        setRows(list);
        setTotal(Number(data.total ?? list.length));
        setState("loaded");
      })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [config.url, config.key, reload]);
  const contextText = (row: any) =>
    kind === "adjustment" ? (row.reasonCode ? inventoryCodeLabel(row.reasonCode) : "—")
      : kind === "count" ? warehouseName(row.warehouseId) || "—"
        : `${(row.sourceWarehouses || []).map(warehouseName).join(", ") || "—"} → ${(row.destinationWarehouses || []).map(warehouseName).join(", ") || "—"}`;
  const skuText = (row: any) => {
    const skus: string[] = row.skus || [];
    return skus.length ? `${skus.slice(0, 3).join(", ")}${skus.length > 3 ? ` +${skus.length - 3}` : ""}` : "—";
  };
  // Workflow and posting statuses both filter: "Posted" is a posting status.
  const statuses = [...new Set(rows.flatMap((row) => [row.workflowStatus, row.postingStatus]).filter(Boolean))] as string[];
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) => {
    if (status && row.workflowStatus !== status && row.postingStatus !== status) return false;
    if (!needle) return true;
    const haystack = [row[config.number], ...(row.skus || []), row.reasonCode, contextText(row)].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  });
  const columns = [
    say("Number", "单号"),
    say("Workflow status", "流程状态"),
    ...(kind === "count" ? [] : [say("Posting status", "过账状态")]),
    config.context,
    say("SKUs", "物料"),
    say("Lines", "行数"),
    say("Updated", "更新时间"),
  ];
  const reset = () => {
    setQuery("");
    setStatus("");
  };
  return (
    <div className="space-y-5" data-testid={`inventory-${kind}-list`}>
      <ListSearchCard
        title={config.search}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => setReload((value) => value + 1)} />
          {kind === "adjustment" ? <DataImportLink type="opening-stock" className={listButtonClass.secondary} /> : null}
          <Link className={listButtonClass.primary} to={config.newPath} data-testid={`inventory-${kind}-new`}>
            <Plus size={13} />
            {config.newLabel}
          </Link>
        </>}
      >
        <Field label={say("Search", "搜索")}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={kind === "adjustment" ? say("Number, SKU or reason", "单号、SKU 或原因") : say("Number, SKU or warehouse", "单号、SKU 或仓库")}
            style={inputStyle}
            data-testid={`inventory-${kind}-search`}
          />
        </Field>
        <Field label={say("Status", "状态")}>
          <select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle} data-testid={`inventory-${kind}-status`}>
            <option value="">{say("All statuses", "全部状态")}</option>
            {statuses.map((code) => <option key={code} value={code}>{inventoryCodeLabel(code)}</option>)}
          </select>
        </Field>
      </ListSearchCard>
      <ListCard title={config.list} total={state === "loaded" ? total : undefined} shown={shown.length}>
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                {columns.map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {state === "loading" && <ListStateRow colSpan={columns.length} state="loading" />}
              {state === "error" && <ListStateRow colSpan={columns.length} state="error" title={say("The list could not be loaded", "列表加载失败")} detail={say("Try again in a moment.", "请稍后重试。")} onRetry={() => setReload((value) => value + 1)} />}
              {state === "loaded" && shown.length === 0 && (
                <ListStateRow colSpan={columns.length} state="empty" title={rows.length ? say("No records match these filters.", "没有符合条件的记录。") : copy("暂无正式记录")} />
              )}
              {state === "loaded" && shown.map((row, index) => (
                <tr key={row.id} className={listRowClass} style={listRowStyle(index, shown.length)}>
                  <td className={tdIdClass}>
                    <Link className={tableLinkClass} style={{ color: A.blue }} to={`${config.url.replace("/api", "/app")}/${encodeURIComponent(row.id)}`}>
                      {row[config.number]}
                    </Link>
                  </td>
                  <td className={tdNowrapClass}>
                    <Status value={row.workflowStatus} />
                  </td>
                  {kind !== "count" && (
                    <td className={tdNowrapClass}>
                      {row.postingStatus ? <Status value={row.postingStatus} /> : "—"}
                    </td>
                  )}
                  <td className={tdNameClass}>{contextText(row)}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }} title={(row.skus || []).join(", ")}>{skuText(row)}</td>
                  <td className={tdNumericClass}>{row.lineCount}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>
                    {row.updatedAt ? formatDateTimeInTimeZone(row.updatedAt, locale, timezone) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListCard>
    </div>
  );
}

function TransferCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, inventoryCodeLabel, errorText } = useInventoryOperationsCopy();
  const navigate = useNavigate(),
    [lines, setLines] = useState<TransferLine[]>([
      {
        itemId: "",
        quantity: "1",
        sourceWarehouseId: "",
        sourceLocation: "",
        destinationWarehouseId: "",
        destinationLocation: "",
      },
    ]),
    [error, setError] = useState("");
  const update = (index: number, patch: Partial<TransferLine>) =>
    setLines((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  const submit = async () => {
    try {
      const data = await apiJson<any>("/api/inventory/transfers", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: key("transfer-create"),
          lines: lines.map((line) => ({
            itemId: line.itemId,
            quantity: line.quantity,
            source: {
              warehouseId: line.sourceWarehouseId,
              location: line.sourceLocation,
            },
            destination: {
              warehouseId: line.destinationWarehouseId,
              location: line.destinationLocation,
            },
          })),
        }),
      });
      navigate(
        `/app/inventory/transfers/${encodeURIComponent(data.transfer.id)}`,
      );
    } catch (reason) {
      setError(errorText(reason, "创建失败"));
    }
  };
  const warehouseOptions = entry.warehouses
    .filter((row) => row.canOperate)
    .map((row) => (
      <option key={row.id} value={row.id}>
        {row.code} · {row.name}
      </option>
    ));
  // The page title comes from the module shell, so the form has no heading.
  return (
    <div className="space-y-4" data-testid="transfer-create">
      <ReadOnly entry={entry} />
      <Card className="space-y-4 p-5">
        {/* The server numbers the transfer (TR-YYYYMM-NNNN) when it is saved. */}
        <div className={`${formLabel} max-w-md`}>
          {copy("调拨单号")}
          <span
            className="flex h-10 items-center text-sm text-slate-500"
            data-testid="transfer-number-on-save"
          >
            {copy("Assigned when you save")}
          </span>
        </div>
        {lines.map((line, index) => (
          <div key={index} className="space-y-3 rounded-lg border p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className={`${formLabel} sm:col-span-2`}>
                {copy("物料")}
                <select
                  aria-label={copy("调拨物料 {n}", { n: index + 1 })}
                  className={formField}
                  value={line.itemId}
                  onChange={(event) =>
                    update(index, { itemId: event.target.value })
                  }
                >
                  <option value="">{copy("请选择")}</option>
                  {entry.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.sku} · {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={formLabel}>
                {copy("数量")}
                <input
                  aria-label={copy("调拨数量 {n}", { n: index + 1 })}
                  className={`${formField} text-right tabular-nums`}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) =>
                    update(index, { quantity: event.target.value })
                  }
                />
              </label>
              {lines.length > 1 && (
                <button
                  type="button"
                  className={`${secondary} h-10 self-end justify-self-start`}
                  onClick={() =>
                    setLines((rows) =>
                      rows.filter((_, rowIndex) => rowIndex !== index),
                    )
                  }
                >
                  {copy("删除行")}
                </button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className={formLabel}>
                {copy("来源仓库")}
                <select
                  aria-label={copy("来源仓库 {n}", { n: index + 1 })}
                  className={formField}
                  value={line.sourceWarehouseId}
                  onChange={(event) =>
                    update(index, { sourceWarehouseId: event.target.value })
                  }
                >
                  <option value="">{copy("请选择")}</option>
                  {warehouseOptions}
                </select>
              </label>
              <label className={formLabel}>
                {copy("来源库位")}
                <input
                  aria-label={copy("来源库位 {n}", { n: index + 1 })}
                  className={formField}
                  value={line.sourceLocation}
                  onChange={(event) =>
                    update(index, { sourceLocation: event.target.value })
                  }
                />
              </label>
              <label className={formLabel}>
                {copy("目标仓库")}
                <select
                  aria-label={copy("目标仓库 {n}", { n: index + 1 })}
                  className={formField}
                  value={line.destinationWarehouseId}
                  onChange={(event) =>
                    update(index, { destinationWarehouseId: event.target.value })
                  }
                >
                  <option value="">{copy("请选择")}</option>
                  {warehouseOptions}
                </select>
              </label>
              <label className={formLabel}>
                {copy("目标库位")}
                <input
                  aria-label={copy("目标库位 {n}", { n: index + 1 })}
                  className={formField}
                  value={line.destinationLocation}
                  onChange={(event) =>
                    update(index, { destinationLocation: event.target.value })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        <p className="text-xs text-slate-600">
          {copy("If the target location has no stock record yet, posting creates it.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={secondary}
            onClick={() =>
              setLines((rows) => [
                ...rows,
                {
                  itemId: "",
                  quantity: "1",
                  sourceWarehouseId: "",
                  sourceLocation: "",
                  destinationWarehouseId: "",
                  destinationLocation: "",
                },
              ])
            }
          >
            {copy("添加行")}
          </button>
          <button
            type="button"
            data-testid="create-transfer"
            className={button}
            disabled={!enabled(entry)}
            onClick={() => void submit()}
          >
            {copy("保存草稿")}
          </button>
          <CancelLink to="/app/inventory/transfers" />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}

// Leaves a new document without saving it, back to its list.
function CancelLink({ to }: { to: string }) {
  const { copy } = useInventoryOperationsCopy();
  return (
    <Link className={`${secondary} inline-flex items-center`} to={to}>
      {copy("Cancel")}
    </Link>
  );
}

function CountCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, inventoryCodeLabel, errorText } = useInventoryOperationsCopy();
  const { language } = useI18n();
  const navigate = useNavigate(),
    [warehouseId, setWarehouseId] = useState(""),
    [blind, setBlind] = useState(true),
    [balanceIds, setBalanceIds] = useState<string[]>([]),
    [error, setError] = useState("");
  const balances = entry.balances.filter(
    (row) => row.warehouseId === warehouseId && row.canOperate,
  );
  const submit = async () => {
    try {
      const data = await apiJson<any>("/api/inventory/counts", {
        method: "POST",
        body: JSON.stringify({
          warehouseId,
          blindCount: blind,
          balanceIds,
          idempotencyKey: key("count-create"),
        }),
      });
      navigate(`/app/inventory/counts/${encodeURIComponent(data.session.id)}`);
    } catch (reason) {
      setError(errorText(reason, "创建失败"));
    }
  };
  return (
    <div className="space-y-4" data-testid="count-create">
      <ReadOnly entry={entry} />
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          {/* The server numbers the count (CC-YYYYMM-NNNN) when it is saved. */}
          <div className={formLabel}>
            {copy("盘点单号")}
            <span
              className="flex h-10 items-center text-sm text-slate-500"
              data-testid="count-number-on-save"
            >
              {copy("Assigned when you save")}
            </span>
          </div>
          <label className={formLabel}>
            {copy("仓库")}
            <select
              aria-label={copy("盘点仓库")}
              className={formField}
              value={warehouseId}
              onChange={(event) => {
                setWarehouseId(event.target.value);
                setBalanceIds([]);
              }}
            >
              <option value="">{copy("请选择")}</option>
              {entry.warehouses
                .filter((row) => row.canOperate)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code} · {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex h-10 items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={blind}
              onChange={(event) => setBlind(event.target.checked)}
            />
            {copy("盲盘")}
          </label>
        </div>
        <div className="space-y-2">
          {balances.map((row) => (
            <label
              key={row.id}
              className="flex items-center gap-3 rounded-lg border p-3 text-sm"
            >
              <input
                type="checkbox"
                checked={balanceIds.includes(row.id)}
                onChange={(event) =>
                  setBalanceIds((ids) =>
                    event.target.checked
                      ? [...ids, row.id]
                      : ids.filter((id) => id !== row.id),
                  )
                }
              />
              <span>
                {row.sku} · {row.location} · {copy("可用 {n}", { n: `${formatQuantity(row.availableQuantity)}${row.unit ? ` ${unitLabel(row.unit, language, Number(row.availableQuantity))}` : ""}` })}
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="create-count"
            className={button}
            disabled={!enabled(entry)}
            onClick={() => void submit()}
          >
            {copy("建立盘点快照")}
          </button>
          <CancelLink to="/app/inventory/counts" />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}

// Opening stock and found stock may name an item, warehouse and location
// that has no stock record yet; posting creates the record. Every other
// reason adjusts an existing stock record.
const newRecordReasons = new Set(["opening_balance", "found_stock"]);
const blankAdjustmentLine = (reasonCode: string): AdjustmentLine => ({
  mode: reasonCode === "opening_balance" ? "new" : "existing",
  inventoryBalanceId: "",
  itemId: "",
  warehouseId: "",
  location: "",
  adjustmentQuantity:
    reasonCode === "opening_balance" || reasonCode === "found_stock"
      ? "1"
      : "-1",
});

function AdjustmentCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, inventoryCodeLabel, errorText } = useInventoryOperationsCopy();
  const warehouseName = useWarehouseNames();
  const { language } = useI18n();
  // A stored quantity as shown: grouped, trailing zeros dropped, with the
  // unit's label ("19,500 pcs", "19,500 件").
  const quantityText = (value: string, unit?: string) => `${formatQuantity(value)}${unit ? ` ${unitLabel(unit, language, Number(value))}` : ""}`;
  const navigate = useNavigate(),
    [reasonCode, setReasonCode] = useState("damage"),
    [notes, setNotes] = useState(""),
    [lines, setLines] = useState<AdjustmentLine[]>([
      blankAdjustmentLine("damage"),
    ]),
    [error, setError] = useState("");
  const update = (index: number, patch: Partial<AdjustmentLine>) =>
    setLines((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  const setReason = (value: string) => {
    setReasonCode(value);
    setLines((rows) =>
      rows.map((row) => {
        const mode: AdjustmentLine["mode"] =
          value === "opening_balance"
            ? "new"
            : newRecordReasons.has(value)
              ? row.mode
              : "existing";
        // An untouched default quantity follows the reason: opening and found
        // stock add, every other reason starts as a decrease.
        const untouched =
          row.adjustmentQuantity === "1" ||
          row.adjustmentQuantity === "-1";
        return {
          ...row,
          mode,
          adjustmentQuantity: untouched
            ? blankAdjustmentLine(value).adjustmentQuantity
            : row.adjustmentQuantity,
        };
      }),
    );
  };
  const operateWarehouses = entry.warehouses.filter((row) => row.canOperate);
  const existingRecord = (line: AdjustmentLine) => {
    const item = entry.items.find((row) => row.id === line.itemId);
    const locationKey = line.location.trim().toLowerCase();
    return item && line.warehouseId
      ? entry.balances.find(
          (row) =>
            row.sku === item.sku &&
            row.warehouseId === line.warehouseId &&
            row.locationKey === locationKey,
        )
      : undefined;
  };
  const submit = async () => {
    try {
      const data = await apiJson<any>("/api/inventory/adjustments", {
        method: "POST",
        body: JSON.stringify({
          reasonCode,
          notes,
          idempotencyKey: key("adjust-create"),
          lines: lines.map((line) =>
            line.mode === "new"
              ? {
                  itemId: line.itemId,
                  warehouseId: line.warehouseId,
                  location: line.location,
                  adjustmentQuantity: line.adjustmentQuantity,
                }
              : {
                  inventoryBalanceId: line.inventoryBalanceId,
                  adjustmentQuantity: line.adjustmentQuantity,
                },
          ),
        }),
      });
      navigate(
        `/app/inventory/adjustments/${encodeURIComponent(data.adjustment.id)}`,
      );
    } catch (reason) {
      setError(errorText(reason, "创建失败"));
    }
  };
  return (
    <div className="space-y-4" data-testid="adjustment-create">
      <ReadOnly entry={entry} />
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          {/* The server numbers the adjustment (ADJ-YYYYMM-NNNN) when it is saved. */}
          <div className={formLabel}>
            {copy("调整单号")}
            <span
              className="flex h-10 items-center text-sm text-slate-500"
              data-testid="adjustment-number-on-save"
            >
              {copy("Assigned when you save")}
            </span>
          </div>
          <label className={formLabel}>
            {copy("原因")}
            <select
              aria-label={copy("调整原因")}
              className={formField}
              value={reasonCode}
              onChange={(event) => setReason(event.target.value)}
            >
              {[
                "damage",
                "shrinkage",
                "found_stock",
                "data_correction",
                "quality_disposition",
                "opening_balance",
                "other",
              ].map((value) => (
                <option key={value} value={value}>{inventoryCodeLabel(value)}</option>
              ))}
            </select>
          </label>
          <label className={formLabel}>
            {copy("备注")}
            <input
              aria-label={copy("调整备注")}
              className={formField}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>
        {reasonCode === "opening_balance" && (
          <p
            className="text-xs text-slate-600"
            data-testid="adjustment-opening-hint"
          >
            {copy("Opening stock records what you already hold on go-live day. Posting creates the stock record. No cost is recorded.")}
          </p>
        )}
        {lines.map((line, index) => {
          const n = index + 1,
            match = line.mode === "new" ? existingRecord(line) : undefined,
            locations = [
              ...new Set(
                entry.balances
                  .filter(
                    (row) =>
                      row.warehouseId === line.warehouseId && row.location,
                  )
                  .map((row) => row.location),
              ),
            ];
          return (
            <div
              key={index}
              className="grid gap-3 rounded-lg border p-4 md:grid-cols-2 lg:grid-cols-4"
            >
              {reasonCode === "found_stock" && (
                <label className={`${formLabel} md:col-span-2`}>
                  {copy("Stock record for line {n}", { n })}
                  <select
                    aria-label={copy("Stock record for line {n}", { n })}
                    data-testid={`adjustment-line-mode-${n}`}
                    className={formField}
                    value={line.mode}
                    onChange={(event) =>
                      update(index, {
                        mode: event.target.value as AdjustmentLine["mode"],
                      })
                    }
                  >
                    <option value="existing">{copy("Existing stock record")}</option>
                    <option value="new">
                      {copy("Item at a location with no stock record")}
                    </option>
                  </select>
                </label>
              )}
              {line.mode === "existing" ? (
                <label className={`${formLabel} md:col-start-1 lg:col-span-3`}>
                  {copy("库存余额")}
                  <select
                    aria-label={copy("调整余额 {n}", { n })}
                    className={formField}
                    value={line.inventoryBalanceId}
                    onChange={(event) =>
                      update(index, { inventoryBalanceId: event.target.value })
                    }
                  >
                    <option value="">{copy("请选择")}</option>
                    {entry.balances
                      .filter((row) => row.canOperate)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.sku} · {warehouseName(row.warehouseId)} · {row.location} ·{" "}
                          {quantityText(row.onHandQuantity, row.unit)}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <div className="grid min-w-0 gap-3 sm:grid-cols-3 md:col-span-2 lg:col-span-3">
                  <label className={formLabel}>
                    {copy("物料")}
                    <select
                      aria-label={copy("Adjustment item {n}", { n })}
                      className={formField}
                      value={line.itemId}
                      onChange={(event) =>
                        update(index, { itemId: event.target.value })
                      }
                    >
                      <option value="">{copy("请选择")}</option>
                      {entry.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.sku} · {item.name}
                          {item.unit ? ` · ${unitLabel(item.unit, language)}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={formLabel}>
                    {copy("仓库")}
                    <select
                      aria-label={copy("Adjustment warehouse {n}", { n })}
                      className={formField}
                      value={line.warehouseId}
                      onChange={(event) =>
                        update(index, { warehouseId: event.target.value })
                      }
                    >
                      <option value="">{copy("请选择")}</option>
                      {operateWarehouses.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.code} · {row.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={formLabel}>
                    {copy("Location")}
                    <input
                      aria-label={copy("Adjustment location {n}", { n })}
                      className={formField}
                      list={`adjustment-locations-${n}`}
                      value={line.location}
                      onChange={(event) =>
                        update(index, { location: event.target.value })
                      }
                    />
                    <datalist id={`adjustment-locations-${n}`}>
                      {locations.map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  </label>
                </div>
              )}
              <label className={formLabel}>
                {copy("调整数量")}
                <input
                  aria-label={copy("调整数量 {n}", { n })}
                  inputMode="decimal"
                  className={`${formField} text-right tabular-nums`}
                  value={line.adjustmentQuantity}
                  onChange={(event) =>
                    update(index, { adjustmentQuantity: event.target.value })
                  }
                />
              </label>
              {match && reasonCode === "found_stock" && (
                <p
                  className="col-span-full text-xs text-amber-700"
                  data-testid={`adjustment-line-existing-${n}`}
                >
                  {copy("This item already has a stock record here. Choose it under Existing stock record.")}
                </p>
              )}
              {match && reasonCode === "opening_balance" && (
                <p
                  className="col-span-full text-xs text-amber-700"
                  data-testid={`adjustment-line-existing-${n}`}
                >
                  {Number(match.onHandQuantity) !== 0
                    ? copy(
                        "This item already holds {qty} here. Opening stock cannot be added on top of it. Choose another reason to correct it.",
                        {
                          qty: quantityText(match.onHandQuantity, match.unit),
                        },
                      )
                    : copy(
                        "This item already has a stock record here. Opening stock is refused if the record has any history. Choose another reason to correct it.",
                      )}
                </p>
              )}
              {line.mode === "existing" && (
                <p className="col-span-full text-xs text-amber-700">
                  {copy("减少库存不会影响已预留数量；调整后在库数量不得低于已预留数量。")}
                </p>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="create-adjustment"
            className={button}
            disabled={!enabled(entry)}
            onClick={() => void submit()}
          >
            {copy("保存草稿")}
          </button>
          <CancelLink to="/app/inventory/adjustments" />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}

function OperationDetail({
  kind,
  id,
  entry,
  refresh,
}: {
  kind: "transfer" | "count" | "adjustment";
  id: string;
  entry: Entry;
  refresh: () => void;
}) {
  const { copy, inventoryCodeLabel, errorText, issueText } =
    useInventoryOperationsCopy();
  const { language } = useI18n();
  const warehouseName = useWarehouseNames();
  const config = {
    transfer: {
      url: `/api/inventory/transfers/${encodeURIComponent(id)}/workbench`,
      doc: "transfer",
    },
    count: {
      url: `/api/inventory/counts/${encodeURIComponent(id)}/workbench`,
      doc: "session",
    },
    adjustment: {
      url: `/api/inventory/adjustments/${encodeURIComponent(id)}/workbench`,
      doc: "adjustment",
    },
  }[kind];
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [reason, setReason] = useState("Correction"),
    [counts, setCounts] = useState<Record<string, string>>({});
  const load = () =>
    apiJson<any>(config.url)
      .then((next) => {
        setData(next);
        setCounts(
          Object.fromEntries(
            (next.lines || []).map((line: any) => [
              line.id,
              line.countedQuantity || "",
            ]),
          ),
        );
      })
      .catch((reasonValue) =>
        setError(
          errorText(reasonValue, "加载失败"),
        ),
      );
  useEffect(() => {
    void load();
  }, [config.url]);
  const document = data?.[config.doc],
    version = document?.version;
  const actionBody = (action: string) =>
    kind === "transfer"
      ? {
          expectedTransferVersion: version,
          idempotencyKey: key(`transfer-${action}`),
          reason,
        }
      : kind === "count"
        ? {
            expectedSessionVersion: version,
            idempotencyKey: key(`count-${action}`),
            reason,
          }
        : {
            expectedAdjustmentVersion: version,
            idempotencyKey: key(`adjustment-${action}`),
            reason,
          };
  const run = async (action: string) => {
    try {
      await apiJson<any>(config.url.replace("/workbench", `/${action}`), {
        method: "POST",
        body: JSON.stringify(actionBody(action)),
      });
      setPreview(null);
      await load();
      refresh();
    } catch (reasonValue) {
      setError(errorText(reasonValue, "操作失败"));
    }
  };
  // The preview remembers which button opened it; confirming runs exactly
  // that operation.
  const runPreview = async (action: string) => {
    try {
      const plan = await apiJson<any>(
        config.url.replace("/workbench", `/${action}-preview`),
        { method: "POST", body: JSON.stringify({ reason }) },
      );
      setPreview({ ...plan, action });
    } catch (reasonValue) {
      setError(errorText(reasonValue, "预览失败"));
    }
  };
  const saveCounts = async () => {
    try {
      await apiJson<any>(config.url.replace("/workbench", ""), {
        method: "PATCH",
        body: JSON.stringify({
          expectedSessionVersion: version,
          idempotencyKey: key("count-enter"),
          counts: data.lines.map((line: any) => ({
            countLineId: line.id,
            countedQuantity: counts[line.id],
            expectedLineVersion: line.version,
          })),
        }),
      });
      await load();
    } catch (reasonValue) {
      setError(
        errorText(reasonValue, "盘点录入失败"),
      );
    }
  };
  if (!data)
    return (
      <Card className="p-8 text-sm text-slate-500">
        {copy("正在读取库存操作工作台…")}
      </Card>
    );
  const actions = data.availableActions || {},
    title =
      document.transferNumber ||
      document.countNumber ||
      document.adjustmentNumber;
  return (
    <div className="space-y-4" data-testid={`inventory-${kind}-workbench`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <div className="mt-2 flex gap-2">
            <Status value={document.workflowStatus} />
            {document.postingStatus && (
              <Status value={document.postingStatus} />
            )}
          </div>
        </div>
        <Link
          className={secondary}
          to={`/app/inventory/${kind === "transfer" ? "transfers" : kind === "count" ? "counts" : "adjustments"}`}
        >
          {copy("返回列表")}
        </Link>
      </div>
      <ReadOnly entry={entry} />
      {kind === "count" && (
        <Card className="p-5">
          <h3 className="mb-3 font-semibold">{copy("盘点录入")}</h3>
          <div className="space-y-2">
            {data.lines.map((line: any) => (
              <div
                key={line.id}
                className="grid items-center gap-3 rounded-lg border p-3 text-sm md:grid-cols-5"
              >
                <span>{line.sku}</span>
                <span>{line.location}</span>
                <span data-testid="count-recorded">
                  {line.recordedOnHandQuantity === null
                    ? copy("盲盘隐藏")
                    : copy("记录 {n}", { n: line.recordedOnHandQuantity })}
                </span>
                <input
                  aria-label={copy("实盘数量 {n}", { n: line.sku })}
                  className={field}
                  value={counts[line.id] || ""}
                  onChange={(event) =>
                    setCounts((value) => ({
                      ...value,
                      [line.id]: event.target.value,
                    }))
                  }
                />
                <span>
                  {line.varianceQuantity === null
                    ? copy("差异待复核")
                    : copy("差异 {n}", { n: line.varianceQuantity })}
                </span>
              </div>
            ))}
          </div>
          {actions.canEdit && (
            <button
              data-testid="save-counts"
              className={`${button} mt-3`}
              onClick={() => void saveCounts()}
            >
              {copy("保存盘点数量")}
            </button>
          )}
        </Card>
      )}
      <Card className="overflow-x-auto p-5">
        <h3 className="mb-3 font-semibold">{copy("业务行与库存影响")}</h3>
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b">
              {["SKU", copy("数量 / 调整"), copy("来源 / 仓库"), copy("目标 / 库位"), copy("状态")].map(
                (label) => (
                  <th key={label} className="px-3 py-2 text-left">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line: any) => (
              <tr key={line.id} className="border-b">
                <td className="px-3 py-2">{line.sku}</td>
                <td className="px-3 py-2">
                  {line.quantity ||
                    line.adjustmentQuantity ||
                    line.countedQuantity ||
                    "—"}
                </td>
                <td className="px-3 py-2">
                  {line.source
                    ? `${warehouseName(line.source.warehouseId)} / ${line.source.location}`
                    : warehouseName(line.warehouseId)}
                </td>
                <td className="px-3 py-2">
                  {line.destination
                    ? `${warehouseName(line.destination.warehouseId)} / ${line.destination.location}`
                    : line.location}
                  {kind === "adjustment" &&
                    !line.inventoryBalanceId &&
                    document.postingStatus === "unposted" &&
                    document.workflowStatus !== "cancelled" && (
                      <span className="ml-2" data-testid="adjustment-line-new-record">
                        <Chip
                          label={copy("New stock record")}
                          color={A.blue}
                          bg="#eef5ff"
                        />
                      </span>
                    )}
                </td>
                <td className="px-3 py-2">{line.varianceQuantity ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="space-y-3 p-5">
        <h3 className="font-semibold">{copy("可执行动作")}</h3>
        <div className="flex flex-wrap gap-2">
          {actions.canReady && (
            <button
              data-testid="operation-ready"
              className={button}
              onClick={() => void run("ready")}
            >
              {copy("Mark ready")}
            </button>
          )}
          {actions.canSubmit && (
            <button
              data-testid="count-submit"
              className={button}
              onClick={() => void run("submit")}
            >
              {copy("Submit")}
            </button>
          )}
          {actions.canReview && (
            <button
              data-testid="count-review"
              className={button}
              onClick={() => void run("review")}
            >
              {copy("Review")}
            </button>
          )}
          {actions.canPost && (
            <button
              data-testid="operation-preview-post"
              className={button}
              onClick={() => void runPreview("post")}
            >
              {copy("Preview posting")}
            </button>
          )}
          {actions.canReverse && (
            <button
              data-testid="operation-preview-reverse"
              className={button}
              onClick={() => void runPreview("reverse")}
            >
              {copy("Preview reversal")}
            </button>
          )}
          {actions.canCancel && (
            <button
              data-testid="operation-preview-cancel"
              className={secondary}
              onClick={() => void runPreview("cancel")}
            >
              {copy("Cancel")}
            </button>
          )}
        </div>
        <label className="grid max-w-lg gap-1 text-xs">
          {copy("操作原因")}
          <input
            aria-label={copy("操作原因")}
            className={field}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {preview && (
          <div
            data-testid="inventory-operation-preview"
            className={`rounded-lg p-4 text-sm ${preview.allowed ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}
          >
            <div>
              {preview.allowed ? copy("预览允许执行") : copy("预览阻止执行")}
            </div>
            <div className="mt-2 text-xs">
              {preview.blockingIssues
                ?.map((item: any) => issueText(item.code) || item.code)
                .join(", ")}
            </div>
            {preview.allowed && (
              <button
                data-testid="confirm-inventory-operation"
                className={`${button} mt-3`}
                onClick={() => void run(preview.action)}
              >
                {copy("确认执行")}
              </button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>
      <Card className="p-5">
        <h3 className="font-semibold">{copy("Movement evidence")}</h3>
        <div className="mt-3 space-y-2">
          {(data.movements || []).map((movement: any) => (
            <div
              key={movement.id}
              className="rounded-lg border p-3 text-xs"
              data-testid={`operation-movement-${movement.movementType}`}
            >
              <span className="font-semibold">{movementTypeLabel(movement.movementType, language)}</span>
              <span className="ml-3">
                {warehouseName(movement.warehouseId)} · {copy("入 {in} · 出 {out}", { in: formatQuantity(movement.quantityIn), out: formatQuantity(movement.quantityOut) })}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 text-sm" data-testid="inventory-reconciliation">
          {copy("Reconciliation：")}<strong>{data.reconciliation?.status ? inventoryCodeLabel(data.reconciliation.status) : "—"}</strong>
        </div>
      </Card>
    </div>
  );
}
