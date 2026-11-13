import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, inputStyle, useConfirm } from "../../components/ui";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { FormActionBar, FormHeader, FormLineCard, FormSection, focusFirstInvalid, formGridClass, useFormCopy } from "../../components/ui/formLayout";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle } from "../../components/ui/listLayout";
import { listTableCardsRef, tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericClass, thClass } from "../../components/ui/workbenchTable";
import { createSecureClientMutationId } from "../../lib/client-id";

import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useInventoryOperationsCopy } from "./inventoryOperationsCopy";
import { formatDateTimeInTimeZone, formatQuantity } from "../../lib/format";
import { unitLabel } from "../../i18n/unitLabels";
import { movementTypeLabel } from "../../i18n/statusLabels";
import { useI18n } from "../../i18n/I18n";
import { DataImportLink } from "../master-data/DataImportLink";
import { ListPager, usePagedRows } from "../procurement/listPaging";

// Lines and movements on a document page, 50 at a time.
const DETAIL_PAGE_SIZE = 50;
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
type Balance = Entry["balances"][number];
// A location of a warehouse kept in Warehouses (GET /api/master-data/warehouses/:id/bins).
type Bin = { id: string; code: string; name?: string; status?: string };
// The target location menu's "New location…": the location is typed in.
const NEW_LOCATION = "__new_location__";
type TransferLine = {
  itemId: string;
  quantity: string;
  sourceWarehouseId: string;
  // The stock record the stock leaves: the item at one location of the
  // source warehouse. Its location is what the server is sent.
  sourceBalanceId: string;
  destinationWarehouseId: string;
  // A known location of the target warehouse, "" for no location, or
  // NEW_LOCATION for the one typed in newLocation.
  destinationLocation: string;
  newLocation: string;
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
const button =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40";
const key = (prefix: string) => createSecureClientMutationId(prefix);
const enabled = (entry: Entry | null) =>
  Boolean(
    entry && Object.values(entry.capabilities).every((item) => item.enabled),
  );

function Status({ value }: { value: string }) {
  const { inventoryCodeLabel } = useInventoryOperationsCopy();
  return (
    <Chip
      label={inventoryCodeLabel(value)}
      color={
        value === "posted"
          ? A.green
          : value === "cancelled" || value === "reversed"
            ? A.orange
            : A.blue
      }
      bg={value === "posted" ? "#edf9f2" : value === "cancelled" || value === "reversed" ? "#fff7ed" : "#eef5ff"}
    />
  );
}

// The one status a document shows: its posting once posted or reversed,
// otherwise its workflow step (draft, ready, submitted, cancelled).
const documentStatus = (row: { workflowStatus?: string; postingStatus?: string | null }) =>
  row.postingStatus === "posted" || row.postingStatus === "reversed" ? row.postingStatus : row.workflowStatus || "";

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
  // The filter offers the statuses the list shows, one per document.
  const statuses = [...new Set(rows.map((row) => documentStatus(row)).filter(Boolean))] as string[];
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) => {
    if (status && documentStatus(row) !== status) return false;
    if (!needle) return true;
    const haystack = [row[config.number], ...(row.skus || []), row.reasonCode, contextText(row)].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  });
  const columns = [
    say("Number", "单号"),
    say("Status", "状态"),
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
                    <Status value={documentStatus(row)} />
                  </td>
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

// The transfer, count and adjustment create forms follow the entry form
// standard (components/ui/formLayout.tsx). Their rules are the server's own
// (inventory-operations-command-service.mjs), checked when Save is clicked.
// A message is keyed by its field: "warehouseId", "lines.0.itemId".
type Issues = Record<string, string>;
type Say = (en: string, zh: string) => string;

// English and Chinese for the copy these forms add.
function useSay(): Say {
  const { language } = useI18n();
  return (en, zh) => (language === "en-US" ? en : zh);
}

// A quantity as the server reads it (outboundDecimalUnits): a blank box is
// 0, a decimal with at most four decimal places that count is a number of
// 1/10000 units, and anything else is null.
function quantityUnits(value: string): bigint | null {
  const raw = value.trim() || "0";
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  if (/[1-9]/.test(fraction.slice(4))) return null;
  const units = BigInt(whole) * 10000n + BigInt((fraction.slice(0, 4) + "0000").slice(0, 4));
  return raw.startsWith("-") ? -units : units;
}

const quantityFormatIssue = (say: Say) =>
  say("Enter a number with up to four decimal places.", "请输入最多四位小数的数量。");

// 1/10000 units as the server's fixed four-place decimal ("44.0000").
function unitsText(value: bigint) {
  const sign = value < 0n ? "-" : "";
  const size = value < 0n ? -value : value;
  return `${sign}${size / 10000n}.${String(size % 10000n).padStart(4, "0")}`;
}
const unitsOf = (value: string | null | undefined) => quantityUnits(String(value ?? "")) ?? 0n;

// The action bar's message: what has no field of its own, "Check the
// highlighted fields." after field messages, and a refusal from the server.
function formMessage(fieldIssues: boolean, formIssues: string[], error: string, checkFields: string) {
  if (!fieldIssues && !formIssues.length && !error) return null;
  return (
    <>
      {formIssues.map((text) => <div key={text}>{text}</div>)}
      {fieldIssues && <div>{checkFields}</div>}
      {error && <div>{error}</div>}
    </>
  );
}

// Help text under a field or a line, in the Field hint's grey.
const helpTextClass = "text-[12px] leading-[18px]";

// A new line starts from the operator's one warehouse when there is only one;
// with several, both warehouses are left to choose.
const blankTransferLine = (warehouseId = ""): TransferLine => ({
  itemId: "",
  quantity: "1",
  sourceWarehouseId: warehouseId,
  sourceBalanceId: "",
  destinationWarehouseId: warehouseId,
  destinationLocation: "",
  newLocation: "",
});

// The stock records a line can take the item from: the item at a location of
// the source warehouse with stock available to move.
function sourceBalancesFor(entry: Entry, warehouseId: string, itemId: string) {
  const item = entry.items.find((row) => row.id === itemId);
  if (!warehouseId || !item) return [];
  return entry.balances.filter(
    (row) =>
      row.canOperate &&
      row.warehouseId === warehouseId &&
      (row.itemId ? row.itemId === item.id : row.sku === item.sku) &&
      unitsOf(row.availableQuantity) > 0n,
  );
}

// The location a line sends the stock to, as typed or chosen.
const targetLocationOf = (line: TransferLine) =>
  line.destinationLocation === NEW_LOCATION ? line.newLocation : line.destinationLocation;

// What the server refuses a transfer line without: an item, a quantity above
// 0, and a target other than the source (the same warehouse and location,
// the location compared without case or outer spaces). The server saves a
// draft without either warehouse, but posting takes the stock from a stock
// record of the source warehouse and puts it in the target warehouse, so the
// form asks for both warehouses and the source location before saving.
function transferIssues(entry: Entry, lines: TransferLine[], say: Say): Issues {
  const issues: Issues = {};
  const place = (warehouseId: string, location: string) =>
    `${warehouseId.trim()}|${location.trim().toLowerCase()}`;
  lines.forEach((line, index) => {
    const at = `lines.${index}`;
    if (!line.sourceWarehouseId)
      issues[`${at}.sourceWarehouseId`] = say("Choose the warehouse the stock leaves.", "请选择调出仓库。");
    if (!line.itemId.trim()) issues[`${at}.itemId`] = say("Choose an item.", "请选择物料。");
    const source = entry.balances.find((row) => row.id === line.sourceBalanceId);
    if (line.sourceWarehouseId && line.itemId && !source)
      issues[`${at}.sourceBalanceId`] = sourceBalancesFor(entry, line.sourceWarehouseId, line.itemId).length
        ? say("Choose the location the stock leaves.", "请选择调出库位。")
        : say("This item has no stock available in this warehouse.", "此物料在该仓库没有可用库存。");
    const units = quantityUnits(line.quantity);
    if (units === null) issues[`${at}.quantity`] = quantityFormatIssue(say);
    else if (units <= 0n) issues[`${at}.quantity`] = say("Enter a quantity above 0.", "请输入大于 0 的数量。");
    if (!line.destinationWarehouseId)
      issues[`${at}.destinationWarehouseId`] = say("Choose the warehouse the stock goes to.", "请选择调入仓库。");
    if (line.destinationLocation === NEW_LOCATION && !line.newLocation.trim())
      issues[`${at}.newLocation`] = say("Enter the new location.", "请输入新库位。");
    else if (
      source &&
      line.destinationWarehouseId &&
      place(line.sourceWarehouseId, source.location) === place(line.destinationWarehouseId, targetLocationOf(line))
    )
      issues[`${at}.destinationLocation`] = say(
        "Choose a target location that differs from the source.",
        "请选择与调出库位不同的调入库位。",
      );
  });
  return issues;
}

function TransferCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, errorText } = useInventoryOperationsCopy();
  const { language } = useI18n();
  const say = useSay();
  const formCopy = useFormCopy();
  const warehouseName = useWarehouseNames();
  const operateWarehouses = entry.warehouses.filter((row) => row.canOperate);
  const onlyWarehouse = operateWarehouses.length === 1 ? operateWarehouses[0].id : "";
  const navigate = useNavigate(),
    formRef = useRef<HTMLDivElement>(null),
    [lines, setLines] = useState<TransferLine[]>([blankTransferLine(onlyWarehouse)]),
    // A save was refused: the messages show, and go as each field is fixed.
    [checked, setChecked] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    // The kept locations of each target warehouse, read once it is chosen.
    [bins, setBins] = useState<Record<string, Bin[]>>({}),
    binsAsked = useRef(new Set<string>());
  const targetWarehouses = [...new Set(lines.map((line) => line.destinationWarehouseId).filter(Boolean))].join("|");
  useEffect(() => {
    for (const warehouseId of targetWarehouses.split("|").filter(Boolean)) {
      if (binsAsked.current.has(warehouseId)) continue;
      binsAsked.current.add(warehouseId);
      apiJson<{ bins?: Bin[] }>(`/api/master-data/warehouses/${encodeURIComponent(warehouseId)}/bins`)
        .then((result) => setBins((current) => ({ ...current, [warehouseId]: result.bins || [] })))
        // Without the bins, the menu still offers the locations that hold stock.
        .catch(() => setBins((current) => ({ ...current, [warehouseId]: [] })));
    }
  }, [targetWarehouses]);
  const issues = transferIssues(entry, lines, say);
  const shown: Issues = checked ? issues : {};
  const quantityText = (value: bigint | string, unit?: string) => {
    const text = typeof value === "bigint" ? unitsText(value) : value;
    return `${formatQuantity(text)}${unit ? ` ${unitLabel(unit, language, Number(text))}` : ""}`;
  };
  // A changed source warehouse keeps the item only when it has stock there;
  // a source location is chosen for the person when the item has only one.
  const settle = (line: TransferLine, patch: Partial<TransferLine>): TransferLine => {
    let next = { ...line, ...patch };
    if ("sourceWarehouseId" in patch && next.itemId && !sourceBalancesFor(entry, next.sourceWarehouseId, next.itemId).length)
      next = { ...next, itemId: "" };
    if ("sourceWarehouseId" in patch || "itemId" in patch) {
      const options = sourceBalancesFor(entry, next.sourceWarehouseId, next.itemId);
      next = {
        ...next,
        sourceBalanceId: options.length === 1 ? options[0].id : options.some((row) => row.id === next.sourceBalanceId) ? next.sourceBalanceId : "",
      };
    }
    if ("destinationWarehouseId" in patch && patch.destinationWarehouseId !== line.destinationWarehouseId)
      next = { ...next, destinationLocation: "", newLocation: "" };
    return next;
  };
  const update = (index: number, patch: Partial<TransferLine>) =>
    setLines((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? settle(row, patch) : row,
      ),
    );
  // The items a line can move: those with stock available in its source
  // warehouse (or, before one is chosen, in any warehouse the person
  // operates), each with what is available.
  const itemOptions = (warehouseId: string) => {
    const totals = new Map<string, { units: bigint; unit?: string }>();
    for (const row of entry.balances) {
      if (!row.canOperate || (warehouseId && row.warehouseId !== warehouseId)) continue;
      const available = unitsOf(row.availableQuantity);
      if (available <= 0n) continue;
      const item = entry.items.find((candidate) => (row.itemId ? candidate.id === row.itemId : candidate.sku === row.sku));
      if (!item) continue;
      const total = totals.get(item.id) || { units: 0n, unit: row.unit || item.unit };
      total.units += available;
      totals.set(item.id, total);
    }
    return entry.items
      .filter((item) => totals.has(item.id))
      .map((item) => ({ item, available: totals.get(item.id)! }));
  };
  // The target warehouse's locations: those kept in Warehouses and those
  // that already hold stock, each once.
  const targetLocations = (warehouseId: string) => {
    const known = new Map<string, { value: string; label: string }>();
    for (const bin of bins[warehouseId] || []) {
      const code = String(bin.code || "").trim();
      if (!code || bin.status === "inactive") continue;
      known.set(code.toLowerCase(), { value: code, label: bin.name && bin.name.trim() !== code ? `${code} · ${bin.name.trim()}` : code });
    }
    for (const row of entry.balances) {
      const location = row.location.trim();
      if (row.warehouseId !== warehouseId || !location || known.has(location.toLowerCase())) continue;
      known.set(location.toLowerCase(), { value: location, label: location });
    }
    return [...known.values()].sort((a, b) => a.value.localeCompare(b.value));
  };
  const submit = async () => {
    if (saving) return;
    setChecked(true);
    setError("");
    if (Object.keys(issues).length) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setSaving(true);
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
              location: entry.balances.find((row) => row.id === line.sourceBalanceId)?.location || "",
            },
            destination: {
              warehouseId: line.destinationWarehouseId,
              location: targetLocationOf(line).trim(),
            },
          })),
        }),
      });
      toast.success(say(`Transfer ${data.transfer.transferNumber} saved as a draft.`, `调拨单 ${data.transfer.transferNumber} 已保存为草稿。`));
      navigate(
        `/app/inventory/transfers/${encodeURIComponent(data.transfer.id)}`,
      );
    } catch (reason) {
      setError(errorText(reason, "创建失败"));
    } finally {
      setSaving(false);
    }
  };
  const warehouseOptions = operateWarehouses.map((row) => (
    <option key={row.id} value={row.id}>
      {row.code} · {row.name}
    </option>
  ));
  // The page's h1 (from the module shell) names the form, so the header has
  // no title.
  return (
    <div ref={formRef} className="space-y-5" data-testid="transfer-create">
      <FocusFirstField />
      <ReadOnly entry={entry} />
      <FormHeader intro={say("Saved as a draft. Stock moves when the transfer is posted.", "保存为草稿，过账后库存才会移动。")}>
        {/* The server numbers the transfer (TR-YYYYMM-NNNN) when it is saved. */}
        <p className="mt-3 text-xs" style={{ color: A.sub }} data-testid="transfer-number-on-save">
          {say("Transfer number: assigned when you save", "调拨单号：保存时自动生成")}
        </p>
      </FormHeader>
      <FormSection
        title={say("Lines", "调拨行")}
        description={copy("If the target location has no stock record yet, posting creates it.")}
      >
        <div className="space-y-3">
          {lines.map((line, index) => {
            const n = index + 1,
              at = `lines.${index}`;
            const items = itemOptions(line.sourceWarehouseId);
            const sources = sourceBalancesFor(entry, line.sourceWarehouseId, line.itemId);
            const source = entry.balances.find((row) => row.id === line.sourceBalanceId);
            const targets = line.destinationWarehouseId ? targetLocations(line.destinationWarehouseId) : [];
            const quantity = quantityUnits(line.quantity);
            return (
              <FormLineCard
                key={index}
                label={say(`Line ${n}`, `第 ${n} 行`)}
                remove={{
                  label: say(`Remove line ${n}`, `删除第 ${n} 行`),
                  disabled: lines.length < 2,
                  onClick: () =>
                    setLines((rows) =>
                      rows.length < 2 ? rows : rows.filter((_, rowIndex) => rowIndex !== index),
                    ),
                }}
                testId={`transfer-line-${n}`}
              >
                <div className={formGridClass}>
                  <Field label={copy("来源仓库")} required error={shown[`${at}.sourceWarehouseId`]}>
                    <select
                      aria-label={copy("来源仓库 {n}", { n })}
                      style={inputStyle}
                      value={line.sourceWarehouseId}
                      onChange={(event) =>
                        update(index, { sourceWarehouseId: event.target.value })
                      }
                    >
                      <option value="">{copy("请选择")}</option>
                      {warehouseOptions}
                    </select>
                  </Field>
                  <div className="md:col-span-2">
                    <Field
                      label={copy("物料")} required error={shown[`${at}.itemId`]}
                      hint={line.sourceWarehouseId ? undefined : say("Items with stock in any of your warehouses. Choose the source warehouse to see its own.", "列出你所有仓库中有库存的物料；选择调出仓库后只列该仓库的物料。")}
                    >
                      <select
                        aria-label={copy("调拨物料 {n}", { n })}
                        style={inputStyle}
                        value={line.itemId}
                        onChange={(event) =>
                          update(index, { itemId: event.target.value })
                        }
                      >
                        <option value="">
                          {items.length ? copy("请选择") : say("No stock to move in this warehouse", "此仓库没有可调拨的库存")}
                        </option>
                        {items.map(({ item, available }) => (
                          <option key={item.id} value={item.id}>
                            {item.sku} · {item.name} · {say(`${quantityText(available.units, available.unit)} available`, `可用 ${quantityText(available.units, available.unit)}`)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field
                    label={copy("数量")} required error={shown[`${at}.quantity`]}
                    hint={source ? say(`${quantityText(source.availableQuantity, source.unit)} available here`, `此库位可用 ${quantityText(source.availableQuantity, source.unit)}`) : undefined}
                  >
                    {/* Quantities are typed left-aligned, as on every entry form. */}
                    <input
                      aria-label={copy("调拨数量 {n}", { n })}
                      className="tabular-nums"
                      style={inputStyle}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) =>
                        update(index, { quantity: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={copy("来源库位")} required error={shown[`${at}.sourceBalanceId`]}>
                    <select
                      aria-label={copy("来源库位 {n}", { n })}
                      style={inputStyle}
                      value={line.sourceBalanceId}
                      onChange={(event) =>
                        update(index, { sourceBalanceId: event.target.value })
                      }
                    >
                      <option value="">
                        {!line.sourceWarehouseId || !line.itemId ? say("Choose the warehouse and item first", "请先选择仓库和物料") : copy("请选择")}
                      </option>
                      {sources.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.location || say("No location", "无库位")} · {say(`${quantityText(row.availableQuantity, row.unit)} available`, `可用 ${quantityText(row.availableQuantity, row.unit)}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={copy("目标仓库")} required error={shown[`${at}.destinationWarehouseId`]}>
                    <select
                      aria-label={copy("目标仓库 {n}", { n })}
                      style={inputStyle}
                      value={line.destinationWarehouseId}
                      onChange={(event) =>
                        update(index, { destinationWarehouseId: event.target.value })
                      }
                    >
                      <option value="">{copy("请选择")}</option>
                      {warehouseOptions}
                    </select>
                  </Field>
                  <Field label={copy("目标库位")} error={shown[`${at}.destinationLocation`]}>
                    <select
                      aria-label={copy("目标库位 {n}", { n })}
                      style={inputStyle}
                      value={line.destinationLocation}
                      onChange={(event) =>
                        update(index, { destinationLocation: event.target.value })
                      }
                    >
                      <option value="">{say("No location", "不指定库位")}</option>
                      {targets.map((row) => (
                        <option key={row.value} value={row.value}>{row.label}</option>
                      ))}
                      <option value={NEW_LOCATION}>{say("New location…", "新库位…")}</option>
                    </select>
                  </Field>
                  {line.destinationLocation === NEW_LOCATION && (
                    <Field
                      label={say("New location", "新库位")} required error={shown[`${at}.newLocation`]}
                      hint={line.destinationWarehouseId ? say(`A location ${warehouseName(line.destinationWarehouseId)} does not have yet. Posting creates its stock record.`, `${warehouseName(line.destinationWarehouseId)} 还没有的库位；过账时创建库存记录。`) : undefined}
                    >
                      <input
                        aria-label={say(`New location ${n}`, `新库位 ${n}`)}
                        style={inputStyle}
                        value={line.newLocation}
                        onChange={(event) =>
                          update(index, { newLocation: event.target.value })
                        }
                      />
                    </Field>
                  )}
                </div>
                {source && quantity !== null && quantity > unitsOf(source.availableQuantity) && (
                  <p className="mt-3 text-xs text-amber-700" data-testid={`transfer-line-above-available-${n}`}>
                    {say(
                      `More than the ${quantityText(source.availableQuantity, source.unit)} available at this location. Posting is refused until the stock is there.`,
                      `超过此库位可用的 ${quantityText(source.availableQuantity, source.unit)}；库存不足时无法过账。`,
                    )}
                  </p>
                )}
              </FormLineCard>
            );
          })}
          <button
            type="button"
            className={listButtonClass.secondary}
            data-testid="transfer-add-line"
            onClick={() => setLines((rows) => [...rows, blankTransferLine(onlyWarehouse)])}
          >
            <Plus size={13} />
            {copy("添加行")}
          </button>
        </div>
      </FormSection>
      <FormActionBar
        onCancel={() => navigate("/app/inventory/transfers")}
        submit={{ label: copy("保存草稿"), onClick: () => void submit(), busy: saving, disabled: !enabled(entry), testId: "create-transfer" }}
        message={formMessage(Object.keys(shown).length > 0, [], error, formCopy("checkFields"))}
        messageTestId="transfer-create-errors"
      />
    </div>
  );
}

function CountCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, errorText } = useInventoryOperationsCopy();
  const { language } = useI18n();
  const say = useSay();
  const formCopy = useFormCopy();
  const blindHintId = useId();
  const navigate = useNavigate(),
    formRef = useRef<HTMLDivElement>(null),
    [warehouseId, setWarehouseId] = useState(""),
    [blind, setBlind] = useState(true),
    [balanceIds, setBalanceIds] = useState<string[]>([]),
    // A save was refused: the messages show, and go as each field is fixed.
    [checked, setChecked] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const balances = entry.balances.filter(
    (row) => row.warehouseId === warehouseId && row.canOperate,
  );
  // What the server refuses a count without: a warehouse, and at least one
  // of its stock records. The records are a list, not a field, so their
  // message is about the whole form.
  const issues: Issues = warehouseId
    ? {}
    : { warehouseId: say("Choose the warehouse to count.", "请选择盘点仓库。") };
  const formIssues =
    warehouseId && !balanceIds.length
      ? [say("Tick at least one stock record to count.", "请至少勾选一条要盘点的库存记录。")]
      : [];
  const shown: Issues = checked ? issues : {};
  const submit = async () => {
    if (saving) return;
    setChecked(true);
    setError("");
    if (Object.keys(issues).length || formIssues.length) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setSaving(true);
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
      toast.success(say(`Count ${data.session.countNumber} started.`, `盘点 ${data.session.countNumber} 已建立。`));
      navigate(`/app/inventory/counts/${encodeURIComponent(data.session.id)}`);
    } catch (reason) {
      setError(errorText(reason, "创建失败"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div ref={formRef} className="space-y-5" data-testid="count-create">
      <FocusFirstField />
      <ReadOnly entry={entry} />
      <FormHeader intro={say("Takes a snapshot of the recorded quantities of the stock records you tick. Counters then enter what they find.", "为勾选的库存记录建立账面数量快照，盘点人随后录入实盘数量。")}>
        {/* The server numbers the count (CC-YYYYMM-NNNN) when it is saved. */}
        <p className="mt-3 text-xs" style={{ color: A.sub }} data-testid="count-number-on-save">
          {say("Count number: assigned when you save", "盘点单号：保存时自动生成")}
        </p>
      </FormHeader>
      <FormSection title={say("Count details", "盘点信息")}>
        <div className={formGridClass}>
          <Field label={copy("仓库")} required error={shown.warehouseId}>
            <select
              aria-label={copy("盘点仓库")}
              style={inputStyle}
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
          </Field>
          {/* A checkbox names itself; the top padding lines it up with the
              select beside it, under that field's label. */}
          <div className="space-y-1.5 md:pt-[26px]">
            <label className="flex min-h-[37px] items-center gap-2 text-sm" style={{ color: A.label }}>
              <input
                type="checkbox"
                aria-describedby={blindHintId}
                checked={blind}
                onChange={(event) => setBlind(event.target.checked)}
              />
              {copy("盲盘")}
            </label>
            <p id={blindHintId} className={helpTextClass} style={{ color: A.gray2 }}>
              {say("Counters do not see the recorded quantity.", "盘点人看不到账面数量。")}
            </p>
          </div>
        </div>
      </FormSection>
      <FormSection title={say("Stock records to count", "要盘点的库存记录")}>
        {!warehouseId ? (
          <p className="text-sm" style={{ color: A.sub }}>
            {say("Choose a warehouse to see its stock records.", "选择仓库后显示其库存记录。")}
          </p>
        ) : !balances.length ? (
          <p className="text-sm" style={{ color: A.sub }}>
            {say("This warehouse has no stock records you can count.", "此仓库没有可盘点的库存记录。")}
          </p>
        ) : (
          <div className="space-y-2" data-testid="count-create-balances">
            {balances.map((row) => (
              <label
                key={row.id}
                className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                style={{ borderColor: A.border }}
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
        )}
      </FormSection>
      <FormActionBar
        onCancel={() => navigate("/app/inventory/counts")}
        submit={{ label: copy("建立盘点快照"), onClick: () => void submit(), busy: saving, disabled: !enabled(entry), testId: "create-count" }}
        message={formMessage(Object.keys(shown).length > 0, checked ? formIssues : [], error, formCopy("checkFields"))}
        messageTestId="count-create-errors"
      />
    </div>
  );
}

// Opening stock and found stock may name an item, warehouse and location
// that has no stock record yet; posting creates the record. Every other
// reason adjusts an existing stock record.
const newRecordReasons = new Set(["opening_balance", "found_stock"]);
// A new adjustment starts neutral: no reason and no quantity, so nothing is
// recorded as damage or as a decrease that the person did not choose.
const ADJUSTMENT_REASONS = ["damage", "shrinkage", "found_stock", "data_correction", "quality_disposition", "opening_balance", "other"];
const blankAdjustmentLine = (reasonCode: string): AdjustmentLine => ({
  mode: reasonCode === "opening_balance" ? "new" : "existing",
  inventoryBalanceId: "",
  itemId: "",
  warehouseId: "",
  location: "",
  adjustmentQuantity: "",
});

// Which way each reason usually moves stock, said under the quantity. The
// server takes either sign for these reasons (opening stock and a new stock
// record excepted), so this is help, not a rule.
const quantityHint = (reasonCode: string, say: Say) =>
  ["damage", "shrinkage", "quality_disposition"].includes(reasonCode)
    ? say("Stock removed: enter a negative number, such as -2.", "减少库存：请填负数，例如 -2。")
    : ["found_stock", "opening_balance"].includes(reasonCode)
      ? say("Stock added: enter a positive number.", "增加库存：请填正数。")
      : say("A positive number adds stock, a negative number removes it.", "正数增加库存，负数减少库存。");

// What the server refuses an adjustment without: a reason, and a note when
// the reason is Other; on each line a stock record, or for a location with
// no stock record an item and a warehouse; and a quantity that is not 0,
// above 0 for opening stock and for a location with no stock record.
function adjustmentIssues(reasonCode: string, notes: string, lines: AdjustmentLine[], say: Say): Issues {
  const issues: Issues = {};
  if (!reasonCode) issues.reasonCode = say("Choose a reason.", "请选择调整原因。");
  if (reasonCode === "other" && !notes.trim())
    issues.notes = say('Enter a note. The reason "Other" needs one.', "原因为“其他”时请填写备注。");
  lines.forEach((line, index) => {
    const at = `lines.${index}`;
    if (line.mode === "existing") {
      if (!line.inventoryBalanceId.trim()) issues[`${at}.inventoryBalanceId`] = say("Choose an inventory balance.", "请选择库存余额。");
    } else {
      if (!line.itemId.trim()) issues[`${at}.itemId`] = say("Choose an item.", "请选择物料。");
      if (!line.warehouseId.trim()) issues[`${at}.warehouseId`] = say("Choose a warehouse.", "请选择仓库。");
    }
    const units = quantityUnits(line.adjustmentQuantity);
    if (!line.adjustmentQuantity.trim())
      issues[`${at}.adjustmentQuantity`] = say("Enter the change in stock: a positive number adds, a negative number removes.", "请输入库存变化：正数增加，负数减少。");
    else if (units === null) issues[`${at}.adjustmentQuantity`] = quantityFormatIssue(say);
    else if (units === 0n)
      issues[`${at}.adjustmentQuantity`] = say("Enter a quantity other than 0. A decrease is negative, such as -1.", "调整数量不能为 0；减少库存请填负数，例如 -1。");
    else if (units < 0n && reasonCode === "opening_balance")
      issues[`${at}.adjustmentQuantity`] = say("Opening stock must be above 0.", "期初库存数量必须大于 0。");
    else if (units < 0n && line.mode === "new")
      issues[`${at}.adjustmentQuantity`] = say("Stock added at a location with no stock record must be above 0.", "在没有库存记录的库位新增库存，数量必须大于 0。");
  });
  return issues;
}

function AdjustmentCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, inventoryCodeLabel, errorText } = useInventoryOperationsCopy();
  const warehouseName = useWarehouseNames();
  const { language } = useI18n();
  const say = useSay();
  const formCopy = useFormCopy();
  // A stored quantity as shown: grouped, trailing zeros dropped, with the
  // unit's label ("19,500 pcs", "19,500 件").
  const quantityText = (value: string, unit?: string) => `${formatQuantity(value)}${unit ? ` ${unitLabel(unit, language, Number(value))}` : ""}`;
  const navigate = useNavigate(),
    formRef = useRef<HTMLDivElement>(null),
    [reasonCode, setReasonCode] = useState(""),
    [notes, setNotes] = useState(""),
    [lines, setLines] = useState<AdjustmentLine[]>([
      blankAdjustmentLine(""),
    ]),
    // A save was refused: the messages show, and go as each field is fixed.
    [checked, setChecked] = useState(false),
    // The server's refusals that name a field, until that line changes.
    [serverIssues, setServerIssues] = useState<Issues>({}),
    [focusRequest, setFocusRequest] = useState(0),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const issues = adjustmentIssues(reasonCode, notes, lines, say);
  const shown: Issues = checked ? { ...issues, ...serverIssues } : {};
  // After a refusal that names a field, once its message is drawn.
  useEffect(() => {
    if (focusRequest) focusFirstInvalid(formRef.current);
  }, [focusRequest]);
  const update = (index: number, patch: Partial<AdjustmentLine>) => {
    setLines((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
    setServerIssues((current) => {
      const kept = Object.entries(current).filter(([field]) => !field.startsWith(`lines.${index}.`));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  };
  const setReason = (value: string) => {
    setReasonCode(value);
    setServerIssues({});
    setLines((rows) =>
      rows.map((row) => {
        const mode: AdjustmentLine["mode"] =
          value === "opening_balance"
            ? "new"
            : newRecordReasons.has(value)
              ? row.mode
              : "existing";
        // The quantity stays as typed; the hint under it says which way the
        // reason usually moves stock.
        return { ...row, mode };
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
  // Opening stock refused because the stock record already holds stock or
  // has history: the lines that name that record, else every new-record line.
  const openingConflictFields = () => {
    const newLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.mode === "new");
    const matched = newLines.filter(({ line }) => existingRecord(line));
    return (matched.length ? matched : newLines).map(({ index }) => `lines.${index}.location`);
  };
  const submit = async () => {
    if (saving) return;
    setChecked(true);
    setError("");
    setServerIssues({});
    if (Object.keys(issues).length) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setSaving(true);
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
      toast.success(say(`Adjustment ${data.adjustment.adjustmentNumber} saved as a draft.`, `调整单 ${data.adjustment.adjustmentNumber} 已保存为草稿。`));
      navigate(
        `/app/inventory/adjustments/${encodeURIComponent(data.adjustment.id)}`,
      );
    } catch (reason) {
      const message = errorText(reason, "创建失败");
      const code = (reason as { code?: unknown } | null)?.code;
      const fields = code === "ADJUSTMENT_OPENING_BALANCE_EXISTS" ? openingConflictFields() : [];
      if (fields.length) {
        setServerIssues(Object.fromEntries(fields.map((field) => [field, message])));
        setFocusRequest((value) => value + 1);
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <div ref={formRef} className="space-y-5" data-testid="adjustment-create">
      <FocusFirstField />
      <ReadOnly entry={entry} />
      <FormHeader intro={say("Saved as a draft. Stock changes when the adjustment is posted.", "保存为草稿，过账后库存数量才会变化。")}>
        {/* The server numbers the adjustment (ADJ-YYYYMM-NNNN) when it is saved. */}
        <p className="mt-3 text-xs" style={{ color: A.sub }} data-testid="adjustment-number-on-save">
          {say("Adjustment number: assigned when you save", "调整单号：保存时自动生成")}
        </p>
      </FormHeader>
      <FormSection title={say("Adjustment details", "调整信息")}>
        <div className={formGridClass}>
          <Field label={copy("原因")} required error={shown.reasonCode}>
            <select
              aria-label={copy("调整原因")}
              style={inputStyle}
              value={reasonCode}
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="">{copy("请选择")}</option>
              {ADJUSTMENT_REASONS.map((value) => (
                <option key={value} value={value}>{inventoryCodeLabel(value)}</option>
              ))}
            </select>
          </Field>
          {/* Needed only for the reason Other, so it is not starred; its
              message says so. */}
          <div className="lg:col-span-2">
            <Field label={copy("备注")} error={shown.notes}>
              <input
                aria-label={copy("调整备注")}
                aria-required={reasonCode === "other"}
                style={inputStyle}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>
        </div>
        {reasonCode === "opening_balance" && (
          <p
            className="mt-3 text-xs"
            style={{ color: A.sub }}
            data-testid="adjustment-opening-hint"
          >
            {copy("Opening stock records what you already hold on go-live day. Posting creates the stock record. No cost is recorded.")}
          </p>
        )}
      </FormSection>
      <FormSection title={say("Lines", "调整行")}>
        <div className="space-y-3">
          {lines.map((line, index) => {
            const n = index + 1,
              at = `lines.${index}`,
              match = line.mode === "new" ? existingRecord(line) : undefined,
              // The stock record this line changes, when it names one.
              chosen = line.mode === "existing" ? entry.balances.find((row) => row.id === line.inventoryBalanceId) : match,
              change = quantityUnits(line.adjustmentQuantity),
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
              <FormLineCard key={index} label={say(`Line ${n}`, `第 ${n} 行`)} testId={`adjustment-line-${n}`}>
                <div className={formGridClass}>
                  {reasonCode === "found_stock" && (
                    <div className="md:col-span-2">
                      <Field label={say("Stock record", "库存记录")}>
                        <select
                          aria-label={copy("Stock record for line {n}", { n })}
                          data-testid={`adjustment-line-mode-${n}`}
                          style={inputStyle}
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
                      </Field>
                    </div>
                  )}
                  {line.mode === "existing" ? (
                    <div className="md:col-span-2 md:col-start-1 lg:col-span-3">
                      <Field label={copy("库存余额")} required error={shown[`${at}.inventoryBalanceId`]}>
                        <select
                          aria-label={copy("调整余额 {n}", { n })}
                          style={inputStyle}
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
                      </Field>
                    </div>
                  ) : (
                    <>
                      <div className="md:col-start-1">
                        <Field label={copy("物料")} required error={shown[`${at}.itemId`]}>
                          <select
                            aria-label={copy("Adjustment item {n}", { n })}
                            style={inputStyle}
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
                        </Field>
                      </div>
                      <Field label={copy("仓库")} required error={shown[`${at}.warehouseId`]}>
                        <select
                          aria-label={copy("Adjustment warehouse {n}", { n })}
                          style={inputStyle}
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
                      </Field>
                      <Field label={copy("Location")} error={shown[`${at}.location`]}>
                        <input
                          aria-label={copy("Adjustment location {n}", { n })}
                          style={inputStyle}
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
                      </Field>
                    </>
                  )}
                  <Field label={copy("调整数量")} required error={shown[`${at}.adjustmentQuantity`]} hint={quantityHint(reasonCode, say)}>
                    {/* Quantities are typed left-aligned, as on every entry form. */}
                    <input
                      aria-label={copy("调整数量 {n}", { n })}
                      inputMode="decimal"
                      className="tabular-nums"
                      style={inputStyle}
                      value={line.adjustmentQuantity}
                      onChange={(event) =>
                        update(index, { adjustmentQuantity: event.target.value })
                      }
                    />
                  </Field>
                </div>
                {/* The stock change this line makes, before it is saved. */}
                {chosen && change !== null && change !== 0n && (
                  <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs tabular-nums" style={{ color: A.label }} data-testid={`adjustment-line-change-${n}`}>
                    <span style={{ color: A.sub }}>{say("On hand", "在库")}</span>
                    {quantityText(chosen.onHandQuantity, chosen.unit)}
                    <ArrowRight size={12} aria-label={say("after posting", "过账后")} />
                    <strong>{quantityText(unitsText(unitsOf(chosen.onHandQuantity) + change), chosen.unit)}</strong>
                  </p>
                )}
                {match && reasonCode === "found_stock" && (
                  <p
                    className="mt-3 text-xs text-amber-700"
                    data-testid={`adjustment-line-existing-${n}`}
                  >
                    {copy("This item already has a stock record here. Choose it under Existing stock record.")}
                  </p>
                )}
                {match && reasonCode === "opening_balance" && (
                  <p
                    className="mt-3 text-xs text-amber-700"
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
                  <p
                    className={`mt-3 ${helpTextClass}`}
                    style={{ color: A.gray2 }}
                    data-testid={`adjustment-line-reserved-${n}`}
                  >
                    {copy("减少库存不会影响已预留数量；调整后在库数量不得低于已预留数量。")}
                  </p>
                )}
              </FormLineCard>
            );
          })}
        </div>
      </FormSection>
      <FormActionBar
        onCancel={() => navigate("/app/inventory/adjustments")}
        submit={{ label: copy("保存草稿"), onClick: () => void submit(), busy: saving, disabled: !enabled(entry), testId: "create-adjustment" }}
        message={formMessage(Object.keys(shown).length > 0, [], error, formCopy("checkFields"))}
        messageTestId="adjustment-create-errors"
      />
    </div>
  );
}

// A refusal a posting, reversal or cancellation preview gives, in the page's
// own words. Any other code reads as the general message, never the code.
const PLAN_ISSUES: Record<string, [string, string]> = {
  ADJUSTMENT_BELOW_RESERVED_NOT_SAFE: ["This would take a stock record below what is available or reserved.", "调整后库存会低于可用量或已预留数量。"],
  ADJUSTMENT_NET_ZERO_NOT_ALLOWED: ["The lines for one stock record add up to no change.", "同一库存记录的调整行合计为零。"],
  ADJUSTMENT_NEGATIVE_INVENTORY: ["Opening stock and stock at a new location must be above 0.", "期初库存和新库位的库存必须大于 0。"],
  ADJUSTMENT_INVALID_STATE: ["Only an adjustment marked ready can be posted. Refresh the page.", "只有已就绪的调整单可以过账，请刷新页面。"],
  ADJUSTMENT_REVERSAL_NOT_SAFE: ["Reversing would take a stock record below what is available or reserved.", "冲销后库存会低于可用量或已预留数量。"],
  ADJUSTMENT_ALREADY_REVERSED: ["This adjustment is already reversed.", "此调整单已冲销。"],
  TRANSFER_SOURCE_BALANCE_NOT_FOUND: ["The source location holds no stock of this item.", "调出库位没有此物料的库存。"],
  TRANSFER_INSUFFICIENT_AVAILABLE: ["The source location does not have enough stock available.", "调出库位的可用库存不足。"],
  TRANSFER_INVALID_ROUTE: ["Each line needs a target that differs from its source and a quantity above 0.", "每行的调入位置须与调出位置不同，数量须大于 0。"],
  TRANSFER_REVERSAL_NOT_SAFE: ["Reversing would take a stock record below what is available or reserved.", "冲销后库存会低于可用量或已预留数量。"],
  TRANSFER_ALREADY_REVERSED: ["This transfer is already reversed.", "此调拨单已冲销。"],
  COUNT_BALANCE_CHANGED: ["Stock changed after the snapshot was taken. Start a new count.", "快照后库存已变化，请重新建立盘点。"],
  COUNT_BELOW_RESERVED_NOT_SAFE: ["The counted quantity is below what is reserved.", "实盘数量低于已预留数量。"],
  COUNT_REVIEW_REQUIRED: ["Review the count before posting it.", "过账前请先复核盘点。"],
  COUNT_LINE_INCOMPLETE: ["Enter a counted quantity on every line.", "请为每一行录入实盘数量。"],
  COUNT_REVERSAL_UNSUPPORTED: ["A posted count cannot be reversed. Post an adjustment instead.", "已过账的盘点不能冲销，请改用库存调整。"],
};

type PlanImpact = {
  balanceId: string | null;
  createsBalance?: boolean;
  onHandBefore: string;
  onHandAfter: string;
  lineIds?: string[];
  legIds?: string[];
};
type PlanFact = { lineId?: string; legId?: string; balanceId?: string | null; sku?: string; warehouseId?: string; location?: string; unit?: string };
type Plan = { allowed: boolean; blockingIssues?: Array<{ code?: string }>; balanceImpacts?: PlanImpact[]; movementFacts?: PlanFact[] };

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
  const { language, locale, timezone, formatNumber } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const warehouseName = useWarehouseNames();
  const dialog = useConfirm();
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
  // The document's name in a sentence: "adjustment ADJ-…", "调整单 ADJ-…".
  const noun = {
    transfer: say("transfer", "调拨单"),
    count: say("count", "盘点"),
    adjustment: say("adjustment", "调整单"),
  }[kind];
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    // The action under way, so its button waits and the others too.
    [busy, setBusy] = useState(""),
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
  const title: string =
    document?.transferNumber ||
    document?.countNumber ||
    document?.adjustmentNumber ||
    "";
  // The breadcrumb names the document by its number, not "…workbench".
  useDetailCrumb(title || null);
  // Only a cancellation and a reversal carry a reason; the server asks for
  // one there and nowhere else.
  const actionBody = (action: string, reason?: string) => ({
    ...(kind === "transfer"
      ? { expectedTransferVersion: version }
      : kind === "count"
        ? { expectedSessionVersion: version }
        : { expectedAdjustmentVersion: version }),
    idempotencyKey: key(`${kind}-${action}`),
    ...(reason ? { reason } : {}),
  });
  const done = (action: string) =>
    ({
      ready: say(`${title} is ready to post.`, `${title} 已就绪，可以过账。`),
      submit: say(`${title} submitted for review.`, `${title} 已提交复核。`),
      review: say(`${title} reviewed.`, `${title} 已复核。`),
      post: say(`${title} posted. Stock is updated.`, `${title} 已过账，库存已更新。`),
      reverse: say(`${title} reversed. Stock is back as before.`, `${title} 已冲销，库存已恢复。`),
      cancel: say(`${title} cancelled.`, `${title} 已取消。`),
    })[action] || say("Done.", "已完成。");
  const run = async (action: string, reason?: string) => {
    setBusy(action);
    setError("");
    try {
      await apiJson<any>(config.url.replace("/workbench", `/${action}`), {
        method: "POST",
        body: JSON.stringify(actionBody(action, reason)),
      });
      toast.success(done(action));
      await load();
      refresh();
    } catch (reasonValue) {
      setError(errorText(reasonValue, "操作失败"));
    } finally {
      setBusy("");
    }
  };
  // The stock records an action changes, each before → after, from the
  // server's own plan for it.
  const planText = (plan: Plan) =>
    (plan.blockingIssues || [])
      .map((item) => issueText(item.code) || (item.code && PLAN_ISSUES[item.code] ? say(...PLAN_ISSUES[item.code]) : ""))
      .filter((text, index, all) => text && all.indexOf(text) === index)
      .join(" ") || say("This can't be done now. Refresh the page and try again.", "目前无法执行，请刷新页面后重试。");
  const stockChange = (plan: Plan) => {
    const facts = plan.movementFacts || [];
    const rows = (plan.balanceImpacts || []).map((impact, index) => {
      const fact =
        facts.find((row) => impact.balanceId && row.balanceId === impact.balanceId) ||
        facts.find((row) => (impact.legIds?.length ? impact.legIds.includes(row.legId || "") : impact.lineIds?.includes(row.lineId || "")));
      const balance = entry.balances.find((row) => row.id === impact.balanceId);
      const sku = fact?.sku || balance?.sku || "—";
      const unit = fact?.unit || balance?.unit;
      return {
        key: `${impact.balanceId || "new"}-${index}`,
        sku,
        place: placeOf(fact?.warehouseId || balance?.warehouseId, fact?.location ?? balance?.location),
        before: quantityText(impact.onHandBefore, unit),
        after: quantityText(impact.onHandAfter, unit),
        creates: Boolean(impact.createsBalance),
      };
    });
    if (!rows.length) return null;
    return (
      <ul className="mt-3 space-y-2" data-testid="inventory-operation-stock-change">
        {rows.map((row) => (
          <li key={row.key} className="rounded-lg px-3 py-2" style={{ background: A.gray6 }} data-testid="inventory-operation-stock-change-row">
            <div className="text-xs" style={{ color: A.sub }}>
              <span className="font-semibold" style={{ color: A.label }}>{row.sku}</span> · {row.place}
              {row.creates && <> · {say("new stock record", "新库存记录")}</>}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-sm tabular-nums" style={{ color: A.label }}>
              <span style={{ color: A.sub }}>{say("On hand", "在库")}</span>
              {row.before}
              <ArrowRight size={13} aria-label={say("becomes", "变为")} />
              <strong>{row.after}</strong>
            </div>
          </li>
        ))}
      </ul>
    );
  };
  const readPlan = async (action: string) => {
    try {
      return await apiJson<Plan>(config.url.replace("/workbench", `/${action}-preview`), { method: "POST", body: JSON.stringify({}) });
    } catch (reasonValue) {
      setError(errorText(reasonValue, "预览失败"));
      return null;
    }
  };
  // Posting is one step: the button reads the server's plan, the dialog shows
  // the stock each line changes, and Post confirms it.
  const post = async () => {
    setBusy("post");
    setError("");
    const plan = await readPlan("post");
    setBusy("");
    if (!plan) return;
    if (!plan.allowed) {
      setError(planText(plan));
      return;
    }
    const confirmed = await dialog.confirm({
      title: say(`Post ${noun} ${title}?`, `过账${noun} ${title}？`),
      description: (
        <>
          <p>{say("The stock changes now. You can reverse the posting later.", "过账后库存立即变化，之后可以冲销。")}</p>
          {stockChange(plan)}
        </>
      ),
      confirmLabel: say("Post", "过账"),
      testId: "inventory-operation-confirm",
    });
    if (confirmed) await run("post");
  };
  const reverse = async () => {
    setBusy("reverse");
    setError("");
    const plan = await readPlan("reverse");
    setBusy("");
    if (!plan) return;
    if (!plan.allowed) {
      setError(planText(plan));
      return;
    }
    const reason = await dialog.prompt({
      title: say(`Reverse ${noun} ${title}?`, `冲销${noun} ${title}？`),
      description: (
        <>
          <p>{say("The stock goes back to what it was before the posting.", "库存将恢复到过账前的数量。")}</p>
          {stockChange(plan)}
        </>
      ),
      confirmLabel: say("Reverse", "冲销"),
      cancelLabel: say("Back", "返回"),
      tone: "danger",
      field: { label: say("Reason for the reversal", "冲销原因") },
      testId: "inventory-operation-confirm",
    });
    if (reason !== null) await run("reverse", reason);
  };
  const cancel = async () => {
    const reason = await dialog.prompt({
      title: say(`Cancel ${noun} ${title}?`, `取消${noun} ${title}？`),
      description: say("It is kept, marked cancelled, and can't be posted. Stock does not change.", "单据保留并标记为已取消，不能再过账；库存不变。"),
      confirmLabel: say(`Cancel ${noun}`, `取消${noun}`),
      cancelLabel: say("Back", "返回"),
      tone: "danger",
      field: { label: say("Reason for cancelling", "取消原因") },
      testId: "inventory-operation-confirm",
    });
    if (reason !== null) await run("cancel", reason);
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
      toast.success(say("Counted quantities saved.", "实盘数量已保存。"));
      await load();
    } catch (reasonValue) {
      setError(
        errorText(reasonValue, "盘点录入失败"),
      );
    }
  };
  // A document can hold hundreds of lines (opening stock): the lines and,
  // when opened, the movements draw 50 at a time.
  const linePage = usePagedRows<any>(data?.lines || [], DETAIL_PAGE_SIZE, id);
  const movementPage = usePagedRows<any>(data?.movements || [], DETAIL_PAGE_SIZE, id);
  const [movementsOpen, setMovementsOpen] = useState(false);
  const quantityText = (value: unknown, unit?: string | null) =>
    value === null || value === undefined || value === ""
      ? "—"
      : `${formatQuantity(String(value))}${unit ? ` ${unitLabel(unit, language, Number(value))}` : ""}`;
  function placeOf(warehouseId?: string | null, location?: string | null) {
    return [warehouseName(warehouseId || "") || "", location || ""].filter(Boolean).join(" / ") || "—";
  }
  if (!data)
    return (
      <Card className="p-8 text-sm text-slate-500">
        {error || copy("正在读取库存操作工作台…")}
      </Card>
    );
  const actions = data.availableActions || {};
  const lines: any[] = data.lines || [];
  const movements: any[] = data.movements || [];
  // Adjustment and count lines each name one place; when every line names the
  // same one, it is said once in the facts instead of on every row.
  const places = new Set(lines.map((line) => placeOf(line.warehouseId, line.location)));
  const samePlace = kind !== "transfer" && lines.length > 1 && places.size === 1 ? [...places][0] : "";
  const units = new Set(lines.map((line) => line.unit || ""));
  const total = kind === "adjustment" && units.size === 1
    ? lines.reduce((sum, line) => sum + Number(line.adjustmentQuantity || 0), 0)
    : null;
  const facts: Array<[string, string]> = [
    [say("Lines", "行数"), formatNumber(lines.length)],
    ...(document.reasonCode ? [[say("Reason", "原因"), inventoryCodeLabel(document.reasonCode)] as [string, string]] : []),
    ...(total !== null ? [[say("Total quantity", "合计数量"), quantityText(total, [...units][0])] as [string, string]] : []),
    ...(samePlace ? [[say("Warehouse / location", "仓库 / 库位"), samePlace] as [string, string]] : []),
    [say("Posted", "过账时间"), document.postedAt ? formatDateTimeInTimeZone(document.postedAt, locale, timezone) : say("Not posted", "未过账")],
    ...(document.notes ? [[say("Notes", "备注"), String(document.notes)] as [string, string]] : []),
  ];
  const itemCell = (line: any) => (
    <td className="px-3 py-2">
      <div className="font-medium" style={{ color: A.label }}>{line.sku}</div>
      {line.itemName && <div className="max-w-[260px] truncate text-[11px]" style={{ color: A.sub }}>{line.itemName}</div>}
    </td>
  );
  const heads = kind === "transfer"
    ? [say("SKU / item", "物料"), say("Quantity", "数量"), say("From", "调出"), say("To", "调入")]
    : kind === "count"
      ? [say("SKU / item", "物料"), ...(samePlace ? [] : [say("Location", "库位")]), say("Counted", "实盘数量"), say("Variance", "差异")]
      : [say("SKU / item", "物料"), say("Quantity", "数量"), ...(samePlace ? [] : [say("Warehouse / location", "仓库 / 库位")])];
  const anyAction = ["canReady", "canSubmit", "canReview", "canPost", "canReverse", "canCancel"].some((name) => actions[name]);
  // Stock moves only when the document is posted: before that it has no
  // movements and nothing to reconcile, so that card is left out.
  const posted = document.postingStatus === "posted" || document.postingStatus === "reversed";
  // A posting of many lines (opening stock: hundreds) reads as one line per
  // kind of movement, with the list folded behind "Show movements". A small
  // document, even posted and reversed, keeps its list open.
  const MOVEMENT_FOLD_AFTER = 20;
  const movementsFolded = movements.length > MOVEMENT_FOLD_AFTER && !movementsOpen;
  const movementKinds = [...movements.reduce((groups: Map<string, { count: number; in: number; out: number }>, movement: any) => {
    const group = groups.get(movement.movementType) || { count: 0, in: 0, out: 0 };
    group.count += 1;
    group.in += Number(movement.quantityIn || 0);
    group.out += Number(movement.quantityOut || 0);
    return groups.set(movement.movementType, group);
  }, new Map()).entries()];
  const actionButton = (name: string, label: string, onClick: () => void, testId: string, primary = true) => (
    <button
      type="button"
      data-testid={testId}
      className={primary ? listButtonClass.primary : listButtonClass.secondary}
      disabled={Boolean(busy)}
      onClick={onClick}
    >
      {busy === name ? say("Working…", "处理中…") : label}
    </button>
  );
  return (
    <div className="space-y-4" data-testid={`inventory-${kind}-workbench`}>
      {dialog.element}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="fc-page-title" style={{ color: A.label }}>{title}</h1>
          <div className="mt-2 flex gap-2">
            <Status value={documentStatus(document)} />
          </div>
        </div>
        <Link
          className={listButtonClass.secondary}
          to={`/app/inventory/${kind === "transfer" ? "transfers" : kind === "count" ? "counts" : "adjustments"}`}
        >
          {copy("返回列表")}
        </Link>
      </div>
      <ReadOnly entry={entry} />
      <Card className="p-5" data-testid="inventory-operation-facts">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs lg:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label} className={label === say("Notes", "备注") ? "col-span-2" : ""}>
              <dt style={{ color: A.sub }}>{label}</dt>
              <dd className="mt-1 font-medium" style={{ color: A.label }}>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {kind === "count" && (
        <Card className="p-5">
          <h2 className="fc-section-title mb-3" style={{ color: A.label }}>{copy("盘点录入")}</h2>
          <div className="space-y-2">
            {lines.map((line: any) => (
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
      <Card className="p-0" data-testid="inventory-operation-lines">
        <h2 className="fc-section-title px-5 pt-5 pb-3" style={{ color: A.label }}>{copy("业务行与库存影响")}</h2>
        {/* On a phone each line is a card (listTableCardsRef), not a cut-off table. */}
        <div className="overflow-x-auto px-2 pb-2" ref={listTableCardsRef}>
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b">
                {heads.map((label) => (
                  <th key={label} className="whitespace-nowrap px-3 py-2 text-left font-medium" style={{ color: A.sub }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linePage.pageRows.map((line: any) => (
                <tr key={line.id} className="border-b last:border-b-0" data-testid="inventory-operation-line">
                  {itemCell(line)}
                  {kind === "transfer" && (
                    <>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{quantityText(line.quantity, line.unit)}</td>
                      <td className="px-3 py-2">{line.source ? placeOf(line.source.warehouseId, line.source.location) : placeOf(line.warehouseId, line.location)}</td>
                      <td className="px-3 py-2">{line.destination ? placeOf(line.destination.warehouseId, line.destination.location) : "—"}</td>
                    </>
                  )}
                  {kind === "count" && (
                    <>
                      {!samePlace && <td className="px-3 py-2">{placeOf(line.warehouseId, line.location)}</td>}
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{quantityText(line.countedQuantity, line.unit)}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{line.varianceQuantity === null || line.varianceQuantity === undefined ? "—" : quantityText(line.varianceQuantity, line.unit)}</td>
                    </>
                  )}
                  {kind === "adjustment" && (
                    <>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                        {quantityText(line.adjustmentQuantity ?? line.quantity, line.unit)}
                        {!line.inventoryBalanceId &&
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
                      {!samePlace && <td className="px-3 py-2">{placeOf(line.warehouseId, line.location)}</td>}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lines.length > DETAIL_PAGE_SIZE && <ListPager page={linePage.page} pageSize={DETAIL_PAGE_SIZE} total={lines.length} onPage={linePage.setPage} testId="inventory-operation-line-pager" />}
      </Card>
      {(anyAction || error) && (
        <Card className="space-y-3 p-5" data-testid="inventory-operation-actions">
          <h2 className="fc-section-title" style={{ color: A.label }}>{copy("可执行动作")}</h2>
          {actions.canPost && (
            <p className="text-xs" style={{ color: A.sub }}>
              {say("Post shows the stock each line changes, before and after, for you to confirm.", "过账前会列出每行库存的变化（之前 → 之后），确认后才过账。")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {actions.canReady && actionButton("ready", copy("Mark ready"), () => void run("ready"), "operation-ready")}
            {actions.canSubmit && actionButton("submit", copy("Submit"), () => void run("submit"), "count-submit")}
            {actions.canReview && actionButton("review", copy("Review"), () => void run("review"), "count-review")}
            {actions.canPost && actionButton("post", say(`Post ${noun}`, `过账${noun}`), () => void post(), "operation-post")}
            {actions.canReverse && actionButton("reverse", say(`Reverse ${noun}`, `冲销${noun}`), () => void reverse(), "operation-reverse", false)}
            {actions.canCancel && actionButton("cancel", say(`Cancel ${noun}`, `取消${noun}`), () => void cancel(), "operation-cancel", false)}
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600" data-testid="inventory-operation-error">
              {error}
            </p>
          )}
        </Card>
      )}
      {(posted || movements.length > 0) && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Movement evidence")}</h2>
            {movements.length > MOVEMENT_FOLD_AFTER && (
              <button type="button" className="text-xs font-medium text-blue-600" aria-expanded={!movementsFolded} data-testid="operation-movements-toggle" onClick={() => setMovementsOpen((open) => !open)}>
                {movementsFolded ? say(`Show ${formatNumber(movements.length)} movements`, `显示 ${formatNumber(movements.length)} 条流水`) : say("Hide movements", "收起流水")}
              </button>
            )}
          </div>
          {movementsFolded ? (
            <ul className="mt-3 space-y-1 text-xs" data-testid="operation-movements-summary">
              {movementKinds.map(([type, group]) => (
                <li key={type}>
                  <span className="font-semibold">{movementTypeLabel(type, language)}</span>
                  <span className="ml-3" style={{ color: A.sub }}>
                    {say(`${formatNumber(group.count)} movements`, `${formatNumber(group.count)} 条`)} · {copy("入 {in} · 出 {out}", { in: formatQuantity(String(group.in)), out: formatQuantity(String(group.out)) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 space-y-2">
              {(movements.length > MOVEMENT_FOLD_AFTER ? movementPage.pageRows : movements).map((movement: any) => (
                <div
                  key={movement.id}
                  className="rounded-lg border p-3 text-xs"
                  data-testid={`operation-movement-${movement.movementType}`}
                >
                  <span className="font-semibold">{movementTypeLabel(movement.movementType, language)}</span>
                  <span className="ml-3">
                    {movement.sku ? `${movement.sku} · ` : ""}{warehouseName(movement.warehouseId)} · {copy("入 {in} · 出 {out}", { in: formatQuantity(movement.quantityIn), out: formatQuantity(movement.quantityOut) })}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!movementsFolded && movements.length > DETAIL_PAGE_SIZE && <ListPager page={movementPage.page} pageSize={DETAIL_PAGE_SIZE} total={movements.length} onPage={movementPage.setPage} testId="inventory-operation-movement-pager" />}
          {posted && (
            <div className="mt-4 text-sm" data-testid="inventory-reconciliation">
              {copy("Reconciliation：")}<strong>{data.reconciliation?.status ? inventoryCodeLabel(data.reconciliation.status) : "—"}</strong>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
