import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { FormActionBar, FormHeader, FormLineCard, FormSection, focusFirstInvalid, formGridClass, useFormCopy } from "../../components/ui/formLayout";
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

const blankTransferLine = (): TransferLine => ({
  itemId: "",
  quantity: "1",
  sourceWarehouseId: "",
  sourceLocation: "",
  destinationWarehouseId: "",
  destinationLocation: "",
});

// What the server refuses a transfer line without: an item, a quantity
// above 0, and a target other than the source (the same warehouse and
// location, the location compared without case or outer spaces). The server
// does not require either warehouse when the draft is saved.
function transferIssues(lines: TransferLine[], say: Say): Issues {
  const issues: Issues = {};
  const place = (warehouseId: string, location: string) =>
    `${warehouseId.trim()}|${location.trim().toLowerCase()}`;
  lines.forEach((line, index) => {
    const at = `lines.${index}`;
    if (!line.itemId.trim()) issues[`${at}.itemId`] = say("Choose an item.", "请选择物料。");
    const units = quantityUnits(line.quantity);
    if (units === null) issues[`${at}.quantity`] = quantityFormatIssue(say);
    else if (units <= 0n) issues[`${at}.quantity`] = say("Enter a quantity above 0.", "请输入大于 0 的数量。");
    if (place(line.sourceWarehouseId, line.sourceLocation) === place(line.destinationWarehouseId, line.destinationLocation))
      issues[`${at}.destinationWarehouseId`] = say(
        "Choose a target warehouse or location that differs from the source.",
        "请选择与来源不同的目标仓库或库位。",
      );
  });
  return issues;
}

function TransferCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const { copy, errorText } = useInventoryOperationsCopy();
  const say = useSay();
  const formCopy = useFormCopy();
  const navigate = useNavigate(),
    formRef = useRef<HTMLDivElement>(null),
    [lines, setLines] = useState<TransferLine[]>([blankTransferLine()]),
    // A save was refused: the messages show, and go as each field is fixed.
    [checked, setChecked] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const issues = transferIssues(lines, say);
  const shown: Issues = checked ? issues : {};
  const update = (index: number, patch: Partial<TransferLine>) =>
    setLines((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
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
    } finally {
      setSaving(false);
    }
  };
  const warehouseOptions = entry.warehouses
    .filter((row) => row.canOperate)
    .map((row) => (
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
                  <div className="md:col-span-2">
                    <Field label={copy("物料")} required error={shown[`${at}.itemId`]}>
                      <select
                        aria-label={copy("调拨物料 {n}", { n })}
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
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label={copy("数量")} required error={shown[`${at}.quantity`]}>
                    <input
                      aria-label={copy("调拨数量 {n}", { n })}
                      className="text-right tabular-nums"
                      style={inputStyle}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) =>
                        update(index, { quantity: event.target.value })
                      }
                    />
                  </Field>
                  <div className="md:col-start-1">
                    <Field label={copy("来源仓库")}>
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
                  </div>
                  <Field label={copy("来源库位")}>
                    <input
                      aria-label={copy("来源库位 {n}", { n })}
                      style={inputStyle}
                      value={line.sourceLocation}
                      onChange={(event) =>
                        update(index, { sourceLocation: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={copy("目标仓库")} error={shown[`${at}.destinationWarehouseId`]}>
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
                  <Field label={copy("目标库位")}>
                    <input
                      aria-label={copy("目标库位 {n}", { n })}
                      style={inputStyle}
                      value={line.destinationLocation}
                      onChange={(event) =>
                        update(index, { destinationLocation: event.target.value })
                      }
                    />
                  </Field>
                </div>
              </FormLineCard>
            );
          })}
          <button
            type="button"
            className={listButtonClass.secondary}
            data-testid="transfer-add-line"
            onClick={() => setLines((rows) => [...rows, blankTransferLine()])}
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

// What the server refuses an adjustment without: a note when the reason is
// Other; on each line a stock record, or for a location with no stock
// record an item and a warehouse; and a quantity that is not 0, above 0
// for opening stock and for a location with no stock record.
function adjustmentIssues(reasonCode: string, notes: string, lines: AdjustmentLine[], say: Say): Issues {
  const issues: Issues = {};
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
    if (units === null) issues[`${at}.adjustmentQuantity`] = quantityFormatIssue(say);
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
    [reasonCode, setReasonCode] = useState("damage"),
    [notes, setNotes] = useState(""),
    [lines, setLines] = useState<AdjustmentLine[]>([
      blankAdjustmentLine("damage"),
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
          <Field label={copy("原因")} required>
            <select
              aria-label={copy("调整原因")}
              style={inputStyle}
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
                  <Field label={copy("调整数量")} required error={shown[`${at}.adjustmentQuantity`]}>
                    <input
                      aria-label={copy("调整数量 {n}", { n })}
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      style={inputStyle}
                      value={line.adjustmentQuantity}
                      onChange={(event) =>
                        update(index, { adjustmentQuantity: event.target.value })
                      }
                    />
                  </Field>
                </div>
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
  // A document can hold hundreds of lines (opening stock): the lines and,
  // when opened, the movements draw 50 at a time.
  const linePage = usePagedRows<any>(data?.lines || [], DETAIL_PAGE_SIZE, id);
  const movementPage = usePagedRows<any>(data?.movements || [], DETAIL_PAGE_SIZE, id);
  const [movementsOpen, setMovementsOpen] = useState(false);
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
  const lines: any[] = data.lines || [];
  const movements: any[] = data.movements || [];
  const quantityText = (value: unknown, unit?: string | null) =>
    value === null || value === undefined || value === ""
      ? "—"
      : `${formatQuantity(String(value))}${unit ? ` ${unitLabel(unit, language, Number(value))}` : ""}`;
  const placeOf = (warehouseId?: string | null, location?: string | null) =>
    [warehouseName(warehouseId || "") || "", location || ""].filter(Boolean).join(" / ") || "—";
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
  return (
    <div className="space-y-4" data-testid={`inventory-${kind}-workbench`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="fc-page-title" style={{ color: A.label }}>{title}</h1>
          <div className="mt-2 flex gap-2">
            <Status value={documentStatus(document)} />
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
        <div className="overflow-x-auto px-2 pb-2">
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
      {(anyAction || preview || error) && (
        <Card className="space-y-3 p-5">
          <h2 className="fc-section-title" style={{ color: A.label }}>{copy("可执行动作")}</h2>
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
          {anyAction && (
            <label className="grid max-w-lg gap-1 text-xs">
              {copy("操作原因")}
              <input
                aria-label={copy("操作原因")}
                className={field}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
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
      )}
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
        <div className="mt-4 text-sm" data-testid="inventory-reconciliation">
          {copy("Reconciliation：")}<strong>{data.reconciliation?.status ? inventoryCodeLabel(data.reconciliation.status) : "—"}</strong>
        </div>
      </Card>
    </div>
  );
}
