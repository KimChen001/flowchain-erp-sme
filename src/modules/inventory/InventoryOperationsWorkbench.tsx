import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip } from "../../components/ui";
import { createSecureClientMutationId } from "../../lib/client-id";

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
  inventoryBalanceId: string;
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
  return (
    <Chip
      label={value}
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
          reason instanceof Error ? reason.message : "库存操作入口读取失败",
        ),
      );
  }, [refresh]);
  if (error) return <Card className="p-8 text-sm text-red-600">{error}</Card>;
  if (!entry)
    return (
      <Card className="p-8 text-sm text-slate-500">
        正在读取正式库存操作数据...
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
  return enabled(entry) ? null : (
    <Card
      className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
      data-testid="inventory-operations-readonly"
    >
      库存操作 Beta 尚未由管理员启用；正式记录保持只读，所有交易动作均已关闭。
    </Card>
  );
}

function Landing({ entry }: { entry: Entry }) {
  return (
    <div className="space-y-4" data-testid="inventory-operations-landing">
      <div>
        <h2 className="text-lg font-semibold">库存操作</h2>
        <p className="mt-1 text-xs text-slate-500">
          正式 PostgreSQL 调拨、循环盘点与库存调整工作台。
        </p>
      </div>
      <ReadOnly entry={entry} />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          [
            "/app/inventory/transfers",
            "库存调拨",
            "原子式来源扣减与目标增加，支持安全冲销。",
          ],
          ["/app/inventory/counts", "循环盘点", "快照、盲盘、复核与差异过账。"],
          [
            "/app/inventory/adjustments",
            "库存调整",
            "受控原因、预览、过账与冲销。",
          ],
        ].map(([to, title, copy]) => (
          <Link
            key={to}
            to={to}
            className="rounded-xl border border-slate-200 bg-white p-5"
          >
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-2 text-xs leading-5 text-slate-500">{copy}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-blue-600">
              打开工作台 →
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
  const config = {
    transfer: {
      title: "库存调拨",
      url: "/api/inventory/transfers",
      key: "transfers",
      number: "transferNumber",
      newPath: "/app/inventory/transfers/new",
    },
    count: {
      title: "循环盘点",
      url: "/api/inventory/counts",
      key: "counts",
      number: "countNumber",
      newPath: "/app/inventory/counts/new",
    },
    adjustment: {
      title: "库存调整",
      url: "/api/inventory/adjustments",
      key: "adjustments",
      number: "adjustmentNumber",
      newPath: "/app/inventory/adjustments/new",
    },
  }[kind];
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    apiJson<any>(config.url).then((data) => setRows(data[config.key] || []));
  }, [config.url, config.key]);
  return (
    <div className="space-y-4" data-testid={`inventory-${kind}-list`}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{config.title}</h2>
        <Link className={button} to={config.newPath}>
          新建
        </Link>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr className="border-b">
              {["单号", "流程状态", "过账状态", "行数", "更新时间"].map(
                (label) => (
                  <th key={label} className="px-4 py-3 text-left">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b">
                <td className="px-4 py-3">
                  <Link
                    className="font-semibold text-blue-600"
                    to={`${config.url.replace("/api", "/app")}/${encodeURIComponent(row.id)}`}
                  >
                    {row[config.number]}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Status value={row.workflowStatus} />
                </td>
                <td className="px-4 py-3">
                  {row.postingStatus ? (
                    <Status value={row.postingStatus} />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{row.lineCount}</td>
                <td className="px-4 py-3">
                  {row.updatedAt?.slice(0, 19).replace("T", " ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="p-8 text-center text-sm text-slate-500">
            暂无正式记录
          </div>
        )}
      </Card>
    </div>
  );
}

function TransferCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const navigate = useNavigate(),
    [number, setNumber] = useState(`TR-${Date.now()}`),
    [lines, setLines] = useState<TransferLine[]>([
      {
        itemId: "",
        quantity: "1.0000",
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
          transferNumber: number,
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
      setError(reason instanceof Error ? reason.message : "创建失败");
    }
  };
  return (
    <div className="space-y-4" data-testid="transfer-create">
      <h2 className="text-lg font-semibold">新建库存调拨</h2>
      <ReadOnly entry={entry} />
      <Card className="space-y-4 p-5">
        <label className="grid gap-1 text-xs">
          调拨单号
          <input
            className={field}
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid gap-3 rounded-lg border p-4 md:grid-cols-6"
          >
            <label className="grid gap-1 text-xs">
              物料
              <select
                aria-label={`调拨物料 ${index + 1}`}
                className={field}
                value={line.itemId}
                onChange={(event) =>
                  update(index, { itemId: event.target.value })
                }
              >
                <option value="">请选择</option>
                {entry.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              数量
              <input
                aria-label={`调拨数量 ${index + 1}`}
                className={field}
                value={line.quantity}
                onChange={(event) =>
                  update(index, { quantity: event.target.value })
                }
              />
            </label>
            <label className="grid gap-1 text-xs">
              来源仓库
              <select
                aria-label={`来源仓库 ${index + 1}`}
                className={field}
                value={line.sourceWarehouseId}
                onChange={(event) =>
                  update(index, { sourceWarehouseId: event.target.value })
                }
              >
                <option value="">请选择</option>
                {entry.warehouses
                  .filter((row) => row.canOperate)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.code}
                    </option>
                  ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              来源库位
              <input
                aria-label={`来源库位 ${index + 1}`}
                className={field}
                value={line.sourceLocation}
                onChange={(event) =>
                  update(index, { sourceLocation: event.target.value })
                }
              />
            </label>
            <label className="grid gap-1 text-xs">
              目标仓库
              <select
                aria-label={`目标仓库 ${index + 1}`}
                className={field}
                value={line.destinationWarehouseId}
                onChange={(event) =>
                  update(index, { destinationWarehouseId: event.target.value })
                }
              >
                <option value="">请选择</option>
                {entry.warehouses
                  .filter((row) => row.canOperate)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.code}
                    </option>
                  ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              目标库位
              <input
                aria-label={`目标库位 ${index + 1}`}
                className={field}
                value={line.destinationLocation}
                onChange={(event) =>
                  update(index, { destinationLocation: event.target.value })
                }
              />
            </label>
            {lines.length > 1 && (
              <button
                className={secondary}
                onClick={() =>
                  setLines((rows) =>
                    rows.filter((_, rowIndex) => rowIndex !== index),
                  )
                }
              >
                删除行
              </button>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <button
            className={secondary}
            onClick={() =>
              setLines((rows) => [
                ...rows,
                {
                  itemId: "",
                  quantity: "1.0000",
                  sourceWarehouseId: "",
                  sourceLocation: "",
                  destinationWarehouseId: "",
                  destinationLocation: "",
                },
              ])
            }
          >
            添加行
          </button>
          <button
            data-testid="create-transfer"
            className={button}
            disabled={!enabled(entry)}
            onClick={() => void submit()}
          >
            保存草稿
          </button>
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

function CountCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const navigate = useNavigate(),
    [number, setNumber] = useState(`CC-${Date.now()}`),
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
          countNumber: number,
          warehouseId,
          blindCount: blind,
          balanceIds,
          idempotencyKey: key("count-create"),
        }),
      });
      navigate(`/app/inventory/counts/${encodeURIComponent(data.session.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    }
  };
  return (
    <div className="space-y-4" data-testid="count-create">
      <h2 className="text-lg font-semibold">新建循环盘点</h2>
      <ReadOnly entry={entry} />
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-1 text-xs">
            盘点单号
            <input
              className={field}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs">
            仓库
            <select
              aria-label="盘点仓库"
              className={field}
              value={warehouseId}
              onChange={(event) => {
                setWarehouseId(event.target.value);
                setBalanceIds([]);
              }}
            >
              <option value="">请选择</option>
              {entry.warehouses
                .filter((row) => row.canOperate)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code} · {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={blind}
              onChange={(event) => setBlind(event.target.checked)}
            />
            盲盘
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
                {row.sku} · {row.location} · 可用 {row.availableQuantity}
              </span>
            </label>
          ))}
        </div>
        <button
          data-testid="create-count"
          className={button}
          disabled={!enabled(entry)}
          onClick={() => void submit()}
        >
          建立盘点快照
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}

function AdjustmentCreate({ entry }: { entry: Entry; refresh: () => void }) {
  const navigate = useNavigate(),
    [number, setNumber] = useState(`ADJ-${Date.now()}`),
    [reasonCode, setReason] = useState("damage"),
    [notes, setNotes] = useState(""),
    [lines, setLines] = useState<AdjustmentLine[]>([
      { inventoryBalanceId: "", adjustmentQuantity: "-1.0000" },
    ]),
    [error, setError] = useState("");
  const submit = async () => {
    try {
      const data = await apiJson<any>("/api/inventory/adjustments", {
        method: "POST",
        body: JSON.stringify({
          adjustmentNumber: number,
          reasonCode,
          notes,
          idempotencyKey: key("adjust-create"),
          lines,
        }),
      });
      navigate(
        `/app/inventory/adjustments/${encodeURIComponent(data.adjustment.id)}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    }
  };
  return (
    <div className="space-y-4" data-testid="adjustment-create">
      <h2 className="text-lg font-semibold">新建库存调整</h2>
      <ReadOnly entry={entry} />
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-1 text-xs">
            调整单号
            <input
              className={field}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs">
            原因
            <select
              aria-label="调整原因"
              className={field}
              value={reasonCode}
              onChange={(event) => setReason(event.target.value)}
            >
              {[
                "damage",
                "shrinkage",
                "found_stock",
                "data_correction",
                "quality_disposition",
                "other",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            备注
            <input
              aria-label="调整备注"
              className={field}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid gap-3 rounded-lg border p-4 md:grid-cols-2"
          >
            <label className="grid gap-1 text-xs">
              库存余额
              <select
                aria-label={`调整余额 ${index + 1}`}
                className={field}
                value={line.inventoryBalanceId}
                onChange={(event) =>
                  setLines((rows) =>
                    rows.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, inventoryBalanceId: event.target.value }
                        : row,
                    ),
                  )
                }
              >
                <option value="">请选择</option>
                {entry.balances
                  .filter((row) => row.canOperate)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.sku} · {row.warehouseId} · {row.location} ·{" "}
                      {row.onHandQuantity}
                    </option>
                  ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              调整数量
              <input
                aria-label={`调整数量 ${index + 1}`}
                className={field}
                value={line.adjustmentQuantity}
                onChange={(event) =>
                  setLines((rows) =>
                    rows.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, adjustmentQuantity: event.target.value }
                        : row,
                    ),
                  )
                }
              />
            </label>
            <p className="text-xs text-amber-700 md:col-span-2">
              减少库存不会影响已预留数量；调整后 On Hand 不得低于 Reserved。
            </p>
          </div>
        ))}
        <button
          data-testid="create-adjustment"
          className={button}
          disabled={!enabled(entry)}
          onClick={() => void submit()}
        >
          保存草稿
        </button>
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
          reasonValue instanceof Error ? reasonValue.message : "读取失败",
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
      setError(reasonValue instanceof Error ? reasonValue.message : "操作失败");
    }
  };
  const runPreview = async (action: string) => {
    try {
      setPreview(
        await apiJson<any>(
          config.url.replace("/workbench", `/${action}-preview`),
          { method: "POST", body: JSON.stringify({ reason }) },
        ),
      );
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "预览失败");
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
        reasonValue instanceof Error ? reasonValue.message : "盘点录入失败",
      );
    }
  };
  if (!data)
    return (
      <Card className="p-8 text-sm text-slate-500">
        正在读取库存操作工作台...
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
          返回列表
        </Link>
      </div>
      <ReadOnly entry={entry} />
      {kind === "count" && (
        <Card className="p-5">
          <h3 className="mb-3 font-semibold">盘点录入</h3>
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
                    ? "盲盘隐藏"
                    : `记录 ${line.recordedOnHandQuantity}`}
                </span>
                <input
                  aria-label={`实盘数量 ${line.sku}`}
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
                    ? "差异待复核"
                    : `差异 ${line.varianceQuantity}`}
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
              保存盘点数量
            </button>
          )}
        </Card>
      )}
      <Card className="overflow-x-auto p-5">
        <h3 className="mb-3 font-semibold">业务行与库存影响</h3>
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b">
              {["SKU", "数量 / 调整", "来源 / 仓库", "目标 / 库位", "状态"].map(
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
                    ? `${line.source.warehouseId} / ${line.source.location}`
                    : line.warehouseId}
                </td>
                <td className="px-3 py-2">
                  {line.destination
                    ? `${line.destination.warehouseId} / ${line.destination.location}`
                    : line.location}
                </td>
                <td className="px-3 py-2">{line.varianceQuantity ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="space-y-3 p-5">
        <h3 className="font-semibold">可执行动作</h3>
        <div className="flex flex-wrap gap-2">
          {actions.canReady && (
            <button
              data-testid="operation-ready"
              className={button}
              onClick={() => void run("ready")}
            >
              Ready
            </button>
          )}
          {actions.canSubmit && (
            <button
              data-testid="count-submit"
              className={button}
              onClick={() => void run("submit")}
            >
              Submit
            </button>
          )}
          {actions.canReview && (
            <button
              data-testid="count-review"
              className={button}
              onClick={() => void run("review")}
            >
              Review
            </button>
          )}
          {actions.canPost && (
            <button
              data-testid="operation-preview-post"
              className={button}
              onClick={() => void runPreview("post")}
            >
              Post Preview
            </button>
          )}
          {actions.canReverse && (
            <button
              data-testid="operation-preview-reverse"
              className={button}
              onClick={() => void runPreview("reverse")}
            >
              Reverse Preview
            </button>
          )}
          {actions.canCancel && (
            <button
              className={secondary}
              onClick={() => void runPreview("cancel")}
            >
              Cancel
            </button>
          )}
        </div>
        <label className="grid max-w-lg gap-1 text-xs">
          操作原因
          <input
            aria-label="操作原因"
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
              {preview.allowed ? "Preview 允许执行" : "Preview 阻止执行"}
            </div>
            <div className="mt-2 text-xs">
              {preview.blockingIssues?.map((item: any) => item.code).join("、")}
            </div>
            {preview.allowed && (
              <button
                data-testid="confirm-inventory-operation"
                className={`${button} mt-3`}
                onClick={() =>
                  void run(
                    preview.normalizedPlan?.reason
                      ? "cancel"
                      : document.postingStatus === "posted"
                        ? "reverse"
                        : "post",
                  )
                }
              >
                确认执行
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
        <h3 className="font-semibold">Movement Evidence</h3>
        <div className="mt-3 space-y-2">
          {(data.movements || []).map((movement: any) => (
            <div
              key={movement.id}
              className="rounded-lg border p-3 text-xs"
              data-testid={`operation-movement-${movement.movementType}`}
            >
              <span className="font-semibold">{movement.movementType}</span>
              <span className="ml-3">
                {movement.warehouseId} · 入 {movement.quantityIn} · 出{" "}
                {movement.quantityOut}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 text-sm" data-testid="inventory-reconciliation">
          Reconciliation：<strong>{data.reconciliation?.status}</strong>
        </div>
      </Card>
    </div>
  );
}
