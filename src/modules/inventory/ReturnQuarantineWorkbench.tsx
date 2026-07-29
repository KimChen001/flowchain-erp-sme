import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { apiJson } from "../../lib/api-client";
import { Card, Chip, A } from "../../components/ui";
import { createSecureClientMutationId } from "../../lib/client-id";

type Capability = { enabled?: boolean; reason?: string };
type SourceLine = {
  id: string;
  sku: string;
  itemName: string;
  quantity: string;
  unit?: string;
  warehouseIds: string[];
};
type SourceDocument = {
  id: string;
  documentType: string;
  documentNumber: string;
  contextDocumentType: string;
  contextDocumentId: string;
  partnerName?: string;
  lines: SourceLine[];
};
type EntryData = {
  capabilities: Record<string, Capability>;
  sources: Record<"customer_return" | "supplier_return", SourceDocument[]>;
  availableActions: {
    createCustomerReturn: boolean;
    createSupplierReturn: boolean;
  };
};
type BalanceOption = {
  id: string;
  balanceType: "available" | "quarantine";
  sku: string;
  itemName?: string;
  warehouseId: string;
  location: string;
  onHandQuantity: string;
  reservedQuantity?: string | null;
  availableQuantity?: string | null;
  quarantineQuantity?: string | null;
  unit?: string;
};

const field =
  "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 disabled:bg-slate-50";
const primary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40";
const secondary =
  "rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40";
const key = (prefix: string) => createSecureClientMutationId(prefix);
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const statusLabel: Record<string, string> = {
  draft: "草稿",
  submitted: "待授权",
  authorized: "已授权",
  partially_executed: "部分执行",
  executed: "已执行",
  approved: "已批准",
  rejected: "已拒绝",
  cancelled: "已取消",
  expired: "已过期",
  ready: "待过账",
  unposted: "未过账",
  posted: "已过账",
  reversed: "已冲销",
  customer_return: "客户退货",
  supplier_return: "供应商退货",
  customer_return_receipt: "客户退货收货",
  supplier_return_dispatch: "供应商退货出库",
  quarantine_release: "隔离库存释放",
  receive_to_quarantine: "收货至隔离库存",
  return_from_available: "从可用库存退回",
  return_from_quarantine: "从隔离库存退回",
  release_quarantine_to_available: "释放至可用库存",
};
const pretty = (value: unknown) =>
  statusLabel[String(value ?? "")] || String(value ?? "—");
const enabled = (capabilities: Record<string, Capability> = {}) => {
  const values = Object.values(capabilities);
  return values.length > 0 && values.every((capability) => capability?.enabled);
};

function Status({ value }: { value: string }) {
  const positive = ["approved", "posted", "executed", "ready"].includes(value);
  return (
    <Chip
      label={pretty(value)}
      color={positive ? A.green : A.blue}
      bg={positive ? "#edf9f2" : "#eef5ff"}
    />
  );
}

function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <Card className="p-8 text-sm text-red-700" data-testid="returns-error">
      <div>{message}</div>
      {retry ? (
        <button className={`${secondary} mt-4`} onClick={retry}>
          重试
        </button>
      ) : null}
    </Card>
  );
}

function Loading() {
  return (
    <Card className="p-8 text-sm text-slate-500" data-testid="returns-loading">
      正在读取正式 PostgreSQL 退货与隔离库存数据…
    </Card>
  );
}

function ReadOnly({
  capabilities,
}: {
  capabilities?: Record<string, Capability>;
}) {
  return capabilities && !enabled(capabilities) ? (
    <Card
      className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
      data-testid="returns-readonly"
    >
      退货与隔离库存 Beta 尚未启用。正式记录保持只读，创建、授权、过账和冲销动作均已关闭。
    </Card>
  ) : null;
}

function Preview({
  value,
  confirm,
  confirmLabel,
  busy,
}: {
  value: any;
  confirm?: () => void;
  confirmLabel?: string;
  busy?: boolean;
}) {
  const preview = value?.preview || value;
  if (!preview) return null;
  return (
    <Card className="space-y-3 border-blue-200 bg-blue-50 p-4" data-testid="return-preview">
      <div className="font-semibold">
        执行预览 · {preview.allowed ? "允许执行" : "存在阻断"}
      </div>
      {preview.blockingIssues?.map((issue: any) => (
        <div key={`${issue.code}-${issue.message}`} className="text-sm text-red-700">
          {issue.code} · {issue.message}
        </div>
      ))}
      {preview.warnings?.map((warning: any) => (
        <div key={`${warning.code}-${warning.message}`} className="text-sm text-amber-700">
          {warning.code} · {warning.message}
        </div>
      ))}
      {preview.balanceImpacts?.length ? (
        <div className="space-y-2 text-xs">
          {preview.balanceImpacts.map((impact: any, index: number) => (
            <div key={index} className="rounded-lg bg-white p-3">
              {impact.balanceType} · {impact.balanceId} ·{" "}
              {impact.onHandBefore} → {impact.onHandAfter}
              {impact.availableBefore != null
                ? ` · 可用 ${impact.availableBefore} → ${impact.availableAfter}`
                : ""}
            </div>
          ))}
        </div>
      ) : null}
      {confirm ? (
        <button
          className={primary}
          disabled={!preview.allowed || busy}
          onClick={confirm}
          data-testid="confirm-return-action"
        >
          {busy ? "正在执行…" : confirmLabel || "确认执行"}
        </button>
      ) : null}
    </Card>
  );
}

export default function ReturnQuarantineWorkbench() {
  const location = useLocation();
  const path = location.pathname;
  if (path === "/app/inventory/returns") return <Landing />;
  if (path === "/app/inventory/returns/requests/new") return <RequestCreate />;
  if (path === "/app/inventory/returns/requests")
    return <GovernanceList kind="requests" />;
  if (path === "/app/inventory/returns/authorizations")
    return <GovernanceList kind="authorizations" />;
  if (path === "/app/inventory/returns/postings")
    return <GovernanceList kind="postings" />;
  if (path === "/app/inventory/quarantine") return <QuarantineList />;
  const id = decodeURIComponent(path.split("/").filter(Boolean).at(-1) || "");
  if (path.startsWith("/app/inventory/returns/requests/"))
    return <RequestDetail id={id} />;
  if (path.startsWith("/app/inventory/returns/authorizations/"))
    return <AuthorizationDetail id={id} />;
  if (path.startsWith("/app/inventory/returns/postings/"))
    return <PostingDetail id={id} />;
  return <Landing />;
}

function Landing() {
  return (
    <div className="space-y-4" data-testid="returns-landing">
      <div>
        <h2 className="text-lg font-semibold">退货管理</h2>
        <p className="mt-1 text-xs text-slate-500">
          申请、授权、物理执行与隔离库存处置使用同一 PostgreSQL 证据链。
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          ["/app/inventory/returns/requests", "退货申请", "创建、提交并追踪客户或供应商退货申请。"],
          ["/app/inventory/returns/authorizations", "退货授权", "由经理复核数量与处置路径。"],
          ["/app/inventory/returns/postings", "退货执行", "预览、过账、逐行对账与安全冲销。"],
          ["/app/inventory/quarantine", "隔离库存", "与可用库存分开显示，不可预留。"],
        ].map(([to, title, copy]) => (
          <Link key={to} to={to} className="rounded-xl border border-slate-200 bg-white p-5">
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

function GovernanceList({
  kind,
}: {
  kind: "requests" | "authorizations" | "postings";
}) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const query = params.toString();
  useEffect(() => {
    setError("");
    setData(null);
    apiJson<any>(`/api/returns/${kind}${query ? `?${query}` : ""}`)
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "退货列表读取失败"),
      );
  }, [kind, query]);
  const setValue = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(name, value) : next.delete(name);
    if (name !== "page") next.set("page", "1");
    setParams(next);
  };
  if (error) return <ErrorState message={error} />;
  if (!data) return <Loading />;
  const rows = data[kind] || [];
  const config = {
    requests: {
      title: "退货申请",
      statusKey: "workflowStatus",
      statuses: ["", "draft", "submitted", "authorized", "executed", "cancelled", "rejected"],
    },
    authorizations: {
      title: "退货授权",
      statusKey: "workflowStatus",
      statuses: ["", "approved", "partially_executed", "executed", "cancelled", "expired"],
    },
    postings: {
      title: "退货执行",
      statusKey: "postingStatus",
      statuses: ["", "unposted", "posted", "reversed"],
    },
  }[kind];
  const page = Number(data.page || 1);
  const pages = Math.max(1, Math.ceil(Number(data.total || 0) / Number(data.pageSize || 20)));
  return (
    <div className="space-y-4" data-testid={`return-${kind}-list`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{config.title}</h2>
          <p className="mt-1 text-xs text-slate-500">共 {data.total} 条正式记录</p>
        </div>
        {kind === "requests" ? (
          <Link to="/app/inventory/returns/requests/new" className={primary}>
            新建退货申请
          </Link>
        ) : null}
      </div>
      <ReadOnly capabilities={data.capabilities} />
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-5">
          <input
            aria-label="搜索退货记录"
            className={field}
            placeholder="单号、伙伴、来源单据、SKU"
            value={params.get("q") || ""}
            onChange={(event) => setValue("q", event.target.value)}
          />
          <select
            aria-label="退货类型"
            className={field}
            value={params.get("returnType") || ""}
            onChange={(event) => setValue("returnType", event.target.value)}
          >
            <option value="">全部类型</option>
            <option value="customer_return">客户退货</option>
            <option value="supplier_return">供应商退货</option>
          </select>
          <select
            aria-label="流程状态"
            className={field}
            value={params.get(config.statusKey) || ""}
            onChange={(event) => setValue(config.statusKey, event.target.value)}
          >
            {config.statuses.map((value) => (
              <option key={value || "all"} value={value}>
                {value ? pretty(value) : "全部状态"}
              </option>
            ))}
          </select>
          <select
            aria-label="排序字段"
            className={field}
            value={params.get("sort") || "updatedAt"}
            onChange={(event) => setValue("sort", event.target.value)}
          >
            <option value="updatedAt">更新时间</option>
            <option value={kind === "requests" ? "requestNumber" : kind === "authorizations" ? "authorizationNumber" : "postingNumber"}>
              单号
            </option>
          </select>
          <select
            aria-label="排序方向"
            className={field}
            value={params.get("direction") || "desc"}
            onChange={(event) => setValue("direction", event.target.value)}
          >
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        {rows.length ? (
          <table className="w-full min-w-[920px] text-xs">
            <thead>
              <tr className="border-b">
                {["单号", "类型", "状态", "来源 / 关联", "行数", "仓库", "操作"].map((label) => (
                  <th key={label} className="px-4 py-3 text-left">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => {
                const number =
                  row.requestNumber || row.authorizationNumber || row.postingNumber;
                const id = row.id;
                const type = row.returnType || row.request?.returnType || row.postingType;
                const state = row.postingStatus || row.workflowStatus;
                const related =
                  row.sourceDocumentNumber ||
                  row.request?.requestNumber ||
                  row.authorization?.authorizationNumber;
                return (
                  <tr key={id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-semibold">{number}</td>
                    <td className="px-4 py-3">{pretty(type)}</td>
                    <td className="px-4 py-3"><Status value={state} /></td>
                    <td className="px-4 py-3">{related || "—"}</td>
                    <td className="px-4 py-3">{row.lineCount ?? row.lines?.length ?? row.postingCount ?? "—"}</td>
                    <td className="px-4 py-3">{row.warehouseId || row.warehouseIds?.join(", ") || "—"}</td>
                    <td className="px-4 py-3">
                      <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/${kind}/${id}`}>
                        打开工作台
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-10 text-center text-sm text-slate-500" data-testid="returns-empty">
            当前筛选范围没有正式记录。
          </div>
        )}
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span>第 {page} / {pages} 页</span>
        <div className="flex gap-2">
          <button className={secondary} disabled={page <= 1} onClick={() => setValue("page", String(page - 1))}>上一页</button>
          <button className={secondary} disabled={page >= pages} onClick={() => setValue("page", String(page + 1))}>下一页</button>
        </div>
      </div>
    </div>
  );
}

function RequestCreate() {
  const navigate = useNavigate();
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [error, setError] = useState("");
  const [returnType, setReturnType] = useState<"customer_return" | "supplier_return">("customer_return");
  const [sourceId, setSourceId] = useState("");
  const [selectedLines, setSelectedLines] = useState<string[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [requestNumber, setRequestNumber] = useState("");
  const [reasonCode, setReasonCode] = useState("damaged");
  const [reasonDetail, setReasonDetail] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiJson<EntryData>("/api/returns/entry-data")
      .then(setEntry)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "来源数据读取失败"));
  }, []);
  const sources = entry?.sources[returnType] || [];
  const source = sources.find((row) => row.id === sourceId);
  const payload = () => ({
    requestNumber,
    returnType,
    contextDocumentType: source?.contextDocumentType,
    contextDocumentId: source?.contextDocumentId || source?.id,
    reasonCode,
    reasonDetail,
    lines: selectedLines.map((id) => ({
      sourceDocumentLineId: id,
      requestedQuantity: quantities[id] || "",
      reasonCode,
    })),
  });
  const changeType = (value: "customer_return" | "supplier_return") => {
    setReturnType(value);
    setSourceId("");
    setSelectedLines([]);
    setQuantities({});
    setPreview(null);
  };
  const runPreview = async () => {
    setError("");
    try {
      setPreview(await apiJson("/api/returns/requests/preview", json("POST", payload())));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "预览失败");
    }
  };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result: any = await apiJson(
        "/api/returns/requests",
        json("POST", { ...payload(), idempotencyKey: key("create-return-request") }),
      );
      navigate(`/app/inventory/returns/requests/${result.entityId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };
  if (error && !entry) return <ErrorState message={error} />;
  if (!entry) return <Loading />;
  const canCreate =
    enabled(entry.capabilities) &&
    (returnType === "customer_return"
      ? entry.availableActions.createCustomerReturn
      : entry.availableActions.createSupplierReturn);
  return (
    <div className="space-y-4" data-testid="return-request-create">
      <div>
        <Link to="/app/inventory/returns/requests" className="text-sm font-semibold text-blue-600">← 返回退货申请</Link>
        <h2 className="mt-3 text-lg font-semibold">新建退货申请</h2>
      </div>
      <ReadOnly capabilities={entry.capabilities} />
      {error ? <ErrorState message={error} /> : null}
      <Card className="space-y-5 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>退货类型</span>
            <select aria-label="退货类型" className={`${field} w-full`} value={returnType} onChange={(event) => changeType(event.target.value as any)}>
              <option value="customer_return">客户退货</option>
              <option value="supplier_return">供应商退货</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>申请单号</span>
            <input aria-label="申请单号" className={`${field} w-full`} value={requestNumber} onChange={(event) => { setRequestNumber(event.target.value); setPreview(null); }} />
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <span>来源单据（必须明确选择）</span>
            <select aria-label="来源单据" className={`${field} w-full`} value={sourceId} onChange={(event) => { setSourceId(event.target.value); setSelectedLines([]); setQuantities({}); setPreview(null); }}>
              <option value="">请选择正式已过账来源单据</option>
              {sources.map((row) => <option key={row.id} value={row.id}>{row.documentNumber} · {row.partnerName || "未命名伙伴"}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>原因代码</span>
            <input aria-label="原因代码" className={`${field} w-full`} value={reasonCode} onChange={(event) => { setReasonCode(event.target.value); setPreview(null); }} />
          </label>
          <label className="space-y-1 text-sm">
            <span>原因说明</span>
            <input aria-label="原因说明" className={`${field} w-full`} value={reasonDetail} onChange={(event) => { setReasonDetail(event.target.value); setPreview(null); }} />
          </label>
        </div>
        <div>
          <h3 className="mb-2 font-semibold">来源行（必须逐行明确选择）</h3>
          {source ? (
            <div className="space-y-2">
              {source.lines.map((line) => {
                const checked = selectedLines.includes(line.id);
                return (
                  <div key={line.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[auto_1fr_180px] md:items-center">
                    <input
                      aria-label={`选择来源行 ${line.sku}`}
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        setSelectedLines((current) => event.target.checked ? [...current, line.id] : current.filter((id) => id !== line.id));
                        setPreview(null);
                      }}
                    />
                    <div className="text-sm">
                      <div className="font-semibold">{line.sku} · {line.itemName}</div>
                      <div className="text-xs text-slate-500">来源数量 {line.quantity} {line.unit} · 仓库 {line.warehouseIds.join(", ")}</div>
                    </div>
                    <input
                      aria-label={`申请数量 ${line.sku}`}
                      className={field}
                      disabled={!checked}
                      placeholder="申请数量"
                      value={quantities[line.id] || ""}
                      onChange={(event) => { setQuantities((current) => ({ ...current, [line.id]: event.target.value })); setPreview(null); }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">选择来源单据后显示可申请行；系统不会自动选择第一行。</div>
          )}
        </div>
        <button className={secondary} disabled={!canCreate} onClick={runPreview} data-testid="preview-return-request">预览申请</button>
      </Card>
      <Preview value={preview} confirm={create} confirmLabel="确认创建申请" busy={busy} />
    </div>
  );
}

function useWorkbench(url: string) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setData(null);
    setError("");
    apiJson<any>(url)
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "工作台读取失败"));
  }, [url, revision]);
  return { data, error, refresh: () => setRevision((value) => value + 1) };
}

function RequestDetail({ id }: { id: string }) {
  const { data, error, refresh } = useWorkbench(`/api/returns/requests/${encodeURIComponent(id)}/workbench`);
  const [preview, setPreview] = useState<any>(null);
  const [action, setAction] = useState("");
  const [authorizationNumber, setAuthorizationNumber] = useState("");
  const [authLines, setAuthLines] = useState<Record<string, { quantity: string; route: string }>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState message={error} retry={refresh} />;
  if (!data) return <Loading />;
  const request = data.request;
  const doPreview = async (nextAction: "submit" | "authorize" | "cancel") => {
    setAction(nextAction);
    const body =
      nextAction === "authorize"
        ? {
            authorizationNumber,
            lines: data.lines.map((line: any) => ({
              returnRequestLineId: line.id,
              authorizedQuantity: authLines[line.id]?.quantity || "",
              dispositionRoute: authLines[line.id]?.route || "",
            })),
          }
        : nextAction === "cancel"
          ? { reason }
          : {};
    const suffix =
      nextAction === "authorize" ? "authorization-preview" : `${nextAction}-preview`;
    try {
      setPreview(await apiJson(`/api/returns/requests/${id}/${suffix}`, json("POST", body)));
    } catch (cause) {
      setPreview({ allowed: false, blockingIssues: [{ code: "PREVIEW_FAILED", message: cause instanceof Error ? cause.message : "预览失败" }] });
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const body =
        action === "authorize"
          ? {
              expectedRequestVersion: request.version,
              authorizationNumber,
              expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
              idempotencyKey: key("authorize-return"),
              lines: data.lines.map((line: any) => ({
                returnRequestLineId: line.id,
                authorizedQuantity: authLines[line.id]?.quantity || "",
                dispositionRoute: authLines[line.id]?.route || "",
              })),
            }
          : action === "cancel"
            ? { expectedVersion: request.version, reason, idempotencyKey: key("cancel-return") }
            : { expectedVersion: request.version, idempotencyKey: key("submit-return") };
      await apiJson(`/api/returns/requests/${id}/${action === "authorize" ? "authorize" : action}`, json("POST", body));
      setPreview(null);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const routeOptions =
    request.workflowStatus === "executed"
      ? ["release_quarantine_to_available"]
      : request.returnType === "customer_return"
        ? ["receive_to_quarantine"]
        : ["return_from_available", "return_from_quarantine"];
  return (
    <div className="space-y-4" data-testid="return-request-workbench">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/app/inventory/returns/requests" className="text-sm font-semibold text-blue-600">← 返回退货申请</Link>
          <h2 className="mt-3 text-lg font-semibold">{request.requestNumber}</h2>
          <div className="mt-2 flex gap-2"><Status value={request.returnType} /><Status value={request.workflowStatus} /></div>
        </div>
        <div className="flex gap-2">
          <button className={secondary} disabled={!data.availableActions.submit} onClick={() => doPreview("submit")} data-testid="preview-submit-return">预览提交</button>
          <button className={secondary} disabled={!data.availableActions.cancel} onClick={() => doPreview("cancel")}>预览取消</button>
        </div>
      </div>
      <ReadOnly capabilities={data.capabilities} />
      {data.availableActions.blockingReasonCodes?.length ? (
        <Card className="p-4 text-xs text-amber-700">动作限制：{data.availableActions.blockingReasonCodes.join("、")}</Card>
      ) : null}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-xs">
          <thead><tr className="border-b">{["SKU", "物料", "来源行", "来源数量", "申请数量", "仓库"].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
          <tbody>{data.lines.map((line: any) => <tr key={line.id} className="border-b last:border-0"><td className="px-4 py-3 font-semibold">{line.sku}</td><td className="px-4 py-3">{line.itemName}</td><td className="px-4 py-3">{line.sourceDocumentLineId}</td><td className="px-4 py-3">{line.sourceQuantity}</td><td className="px-4 py-3">{line.requestedQuantity} {line.unit}</td><td className="px-4 py-3">{line.sourceWarehouseIds.join(", ")}</td></tr>)}</tbody>
        </table>
      </Card>
      {data.availableActions.authorize ? (
        <Card className="space-y-4 p-5" data-testid="return-authorization-form">
          <h3 className="font-semibold">{request.workflowStatus === "executed" ? "隔离库存释放授权" : "经理授权"}</h3>
          <input aria-label="授权单号" className={`${field} w-full`} placeholder="授权单号" value={authorizationNumber} onChange={(event) => { setAuthorizationNumber(event.target.value); setPreview(null); }} />
          {data.lines.map((line: any) => (
            <div key={line.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_180px_260px] md:items-center">
              <div className="text-sm"><strong>{line.sku}</strong><div className="text-xs text-slate-500">申请 {line.requestedQuantity} {line.unit}</div></div>
              <input aria-label={`授权数量 ${line.sku}`} className={field} placeholder="授权数量" value={authLines[line.id]?.quantity || ""} onChange={(event) => { setAuthLines((current) => ({ ...current, [line.id]: { quantity: event.target.value, route: current[line.id]?.route || "" } })); setPreview(null); }} />
              <select aria-label={`处置路径 ${line.sku}`} className={field} value={authLines[line.id]?.route || ""} onChange={(event) => { setAuthLines((current) => ({ ...current, [line.id]: { quantity: current[line.id]?.quantity || "", route: event.target.value } })); setPreview(null); }}>
                <option value="">请选择处置路径</option>
                {routeOptions.map((route) => <option key={route} value={route}>{pretty(route)}</option>)}
              </select>
            </div>
          ))}
          <button className={secondary} onClick={() => doPreview("authorize")} data-testid="preview-authorize-return">预览授权</button>
        </Card>
      ) : null}
      {action === "cancel" ? <input aria-label="取消原因" className={`${field} w-full`} placeholder="取消原因" value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
      <Preview value={preview} confirm={confirm} confirmLabel={action === "authorize" ? "确认授权" : action === "submit" ? "确认提交" : "确认取消"} busy={busy} />
      <RelatedAuthorizations rows={data.authorizations} />
      <Evidence rows={data.evidence} />
    </div>
  );
}

function RelatedAuthorizations({ rows }: { rows: any[] }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold">授权历史</h3>
      {rows.length ? <div className="space-y-2">{rows.map((row) => <Link key={row.id} to={`/app/inventory/returns/authorizations/${row.id}`} className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm"><span>{row.authorizationNumber}</span><Status value={row.workflowStatus} /></Link>)}</div> : <div className="text-sm text-slate-500">尚无授权记录。</div>}
    </Card>
  );
}

function AuthorizationDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data, error, refresh } = useWorkbench(`/api/returns/authorizations/${encodeURIComponent(id)}/workbench`);
  const [balances, setBalances] = useState<Record<string, { available: BalanceOption[]; quarantine: BalanceOption[] }>>({});
  const [lines, setLines] = useState<Record<string, any>>({});
  const [postingNumber, setPostingNumber] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    Promise.all(
      data.requestLines.map(async (line: any) => {
        const [available, quarantine] = await Promise.all([
          apiJson<any>(`/api/inventory/balances/select?includeZero=true&sku=${encodeURIComponent(line.sku)}`),
          apiJson<any>(`/api/inventory/quarantine-balances/select?includeZero=true&sku=${encodeURIComponent(line.sku)}`),
        ]);
        return [line.id, { available: available.options || [], quarantine: quarantine.options || [] }] as const;
      }),
    ).then((entries) => setBalances(Object.fromEntries(entries)));
  }, [data]);
  if (error) return <ErrorState message={error} retry={refresh} />;
  if (!data) return <Loading />;
  const auth = data.authorization;
  const requestLineById = Object.fromEntries(data.requestLines.map((line: any) => [line.id, line]));
  const postingLines = auth.lines.map((authLine: any) => {
    const input = lines[authLine.id] || {};
    return {
      returnAuthorizationLineId: authLine.id,
      quantity: input.quantity || "",
      ...(input.inventoryBalanceId ? { inventoryBalanceId: input.inventoryBalanceId } : {}),
      ...(input.quarantineBalanceId ? { quarantineBalanceId: input.quarantineBalanceId } : {}),
      ...(input.destinationInventoryBalanceId ? { destinationInventoryBalanceId: input.destinationInventoryBalanceId } : {}),
    };
  });
  const runPreview = async () => {
    setPreview(await apiJson(`/api/returns/authorizations/${id}/postings/preview`, json("POST", { lines: postingLines })));
  };
  const create = async () => {
    setBusy(true);
    try {
      const result: any = await apiJson(`/api/returns/authorizations/${id}/postings`, json("POST", {
        postingNumber,
        expectedAuthorizationVersion: auth.version,
        lines: postingLines,
        idempotencyKey: key("create-return-posting"),
      }));
      navigate(`/app/inventory/returns/postings/${result.entityId}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="return-authorization-workbench">
      <div>
        <Link to="/app/inventory/returns/authorizations" className="text-sm font-semibold text-blue-600">← 返回退货授权</Link>
        <h2 className="mt-3 text-lg font-semibold">{auth.authorizationNumber}</h2>
        <div className="mt-2 flex gap-2"><Status value={data.request.returnType} /><Status value={auth.workflowStatus} /></div>
      </div>
      <ReadOnly capabilities={data.capabilities} />
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/requests/${data.request.id}`}>来源申请 {data.request.requestNumber}</Link>
          <span>版本 {auth.version}</span>
        </div>
        {auth.lines.map((authLine: any) => {
          const requestLine: any = requestLineById[authLine.returnRequestLineId];
          const options = balances[requestLine.id] || { available: [], quarantine: [] };
          const value = lines[authLine.id] || {};
          const route = authLine.dispositionRoute;
          return (
            <div key={authLine.id} className="space-y-3 rounded-xl border p-4">
              <div className="text-sm font-semibold">{requestLine.sku} · {requestLine.itemName} · 授权 {authLine.authorizedQuantity} {requestLine.unit}</div>
              <div className="text-xs text-slate-500">{pretty(route)}；所有余额必须明确选择，系统不会默认第一条。</div>
              <div className="grid gap-3 md:grid-cols-3">
                <input aria-label={`执行数量 ${requestLine.sku}`} className={field} placeholder="执行数量" value={value.quantity || ""} onChange={(event) => { setLines((current) => ({ ...current, [authLine.id]: { ...current[authLine.id], quantity: event.target.value } })); setPreview(null); }} />
                {route === "return_from_available" ? (
                  <BalanceSelect label={`可用库存余额 ${requestLine.sku}`} value={value.inventoryBalanceId || ""} options={options.available} onChange={(selected) => { setLines((current) => ({ ...current, [authLine.id]: { quantity: current[authLine.id]?.quantity || "", inventoryBalanceId: selected } })); setPreview(null); }} />
                ) : (
                  <BalanceSelect label={`隔离库存余额 ${requestLine.sku}`} value={value.quarantineBalanceId || ""} options={options.quarantine} onChange={(selected) => { setLines((current) => ({ ...current, [authLine.id]: { ...current[authLine.id], quarantineBalanceId: selected } })); setPreview(null); }} />
                )}
                {route === "release_quarantine_to_available" ? (
                  <BalanceSelect label={`目标可用库存余额 ${requestLine.sku}`} value={value.destinationInventoryBalanceId || ""} options={options.available} onChange={(selected) => { setLines((current) => ({ ...current, [authLine.id]: { ...current[authLine.id], destinationInventoryBalanceId: selected } })); setPreview(null); }} />
                ) : null}
              </div>
            </div>
          );
        })}
        <input aria-label="执行单号" className={`${field} w-full`} placeholder="执行单号" value={postingNumber} onChange={(event) => { setPostingNumber(event.target.value); setPreview(null); }} />
        <button className={secondary} disabled={!data.capabilities?.["return-posting"]?.enabled || !["approved", "partially_executed"].includes(auth.workflowStatus)} onClick={runPreview} data-testid="preview-create-return-posting">预览执行草稿</button>
      </Card>
      <Preview value={preview} confirm={create} confirmLabel="确认创建执行单" busy={busy} />
      <Evidence rows={data.evidence} />
    </div>
  );
}

function BalanceSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: BalanceOption[];
  onChange: (value: string) => void;
}) {
  return (
    <select aria-label={label} className={field} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">请选择余额</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.warehouseId} / {option.location || "无库位"} · {option.balanceType === "available" ? `可用 ${option.availableQuantity}` : `隔离 ${option.quarantineQuantity}`}
        </option>
      ))}
    </select>
  );
}

function PostingDetail({ id }: { id: string }) {
  const { data, error, refresh } = useWorkbench(`/api/returns/postings/${encodeURIComponent(id)}/workbench`);
  const [preview, setPreview] = useState<any>(null);
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState message={error} retry={refresh} />;
  if (!data) return <Loading />;
  const posting = data.posting;
  const runPreview = async (next: "ready" | "post" | "reverse") => {
    setAction(next);
    setPreview(await apiJson(`/api/returns/postings/${id}/${next}-preview`, json("POST", {})));
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await apiJson(`/api/returns/postings/${id}/${action}`, json("POST", {
        expectedPostingVersion: posting.version,
        expectedAuthorizationVersion: data.returnAuthorization.version,
        expectedRequestVersion: data.returnRequest.version,
        ...(action === "reverse" ? { reason } : {}),
        idempotencyKey: key(`${action}-return-posting`),
      }));
      setPreview(null);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="return-posting-workbench">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/app/inventory/returns/postings" className="text-sm font-semibold text-blue-600">← 返回退货执行</Link>
          <h2 className="mt-3 text-lg font-semibold">{posting.postingNumber}</h2>
          <div className="mt-2 flex gap-2"><Status value={posting.postingType} /><Status value={posting.workflowStatus} /><Status value={posting.postingStatus} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={secondary} disabled={!data.availableActions.ready} onClick={() => runPreview("ready")}>预览就绪</button>
          <button className={secondary} disabled={!data.availableActions.post} onClick={() => runPreview("post")} data-testid="preview-post-return">预览过账</button>
          <button className={secondary} disabled={!data.availableActions.reverse} onClick={() => runPreview("reverse")} data-testid="preview-reverse-return">预览冲销</button>
        </div>
      </div>
      <ReadOnly capabilities={{ "return-posting": data.capability }} />
      <Card className="p-5">
        <div className="flex flex-wrap gap-4 text-sm">
          <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/requests/${data.returnRequest.id}`}>申请 {data.returnRequest.requestNumber}</Link>
          <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/authorizations/${data.returnAuthorization.id}`}>授权 {data.returnAuthorization.authorizationNumber}</Link>
          <span>Posting Batch {posting.postingBatchId || "尚未生成"}</span>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-xs">
          <thead><tr className="border-b">{["SKU", "数量", "处置路径", "来源余额", "目标余额", "仓库 / 库位"].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
          <tbody>{data.lines.map((line: any) => <tr key={line.id} className="border-b last:border-0"><td className="px-4 py-3 font-semibold">{line.sku}</td><td className="px-4 py-3">{line.quantity} {line.unit}</td><td className="px-4 py-3">{pretty(line.dispositionRoute)}</td><td className="px-4 py-3">{line.sourceBalanceId}</td><td className="px-4 py-3">{line.destinationBalanceId || "—"}</td><td className="px-4 py-3">{line.warehouseId} / {line.location || "无库位"}</td></tr>)}</tbody>
        </table>
      </Card>
      {action === "reverse" ? <input aria-label="冲销原因" className={`${field} w-full`} placeholder="必须填写冲销原因" value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
      <Preview value={preview} confirm={confirm} confirmLabel={action === "ready" ? "确认就绪" : action === "post" ? "确认过账" : "确认冲销"} busy={busy} />
      <Reconciliation value={data.reconciliation} />
      <Card className="p-5">
        <h3 className="mb-3 font-semibold">智能链接</h3>
        <div className="flex flex-wrap gap-2">{data.smartLinks?.map((link: any) => <Link key={link.id} className={secondary} to={link.path}>{link.label}</Link>)}</div>
      </Card>
      <Evidence rows={data.evidence?.audit || []} movements={data.evidence?.movements || []} />
    </div>
  );
}

function Reconciliation({ value }: { value: any }) {
  return (
    <Card className="p-5" data-testid="return-reconciliation">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">逐行对账</h3>
        <Status value={value?.status || "unavailable"} />
      </div>
      <p className="mt-2 text-xs text-slate-500">不同退货行独立核对，不允许通过总量正负抵消显示一致。</p>
      <div className="mt-4 space-y-3">
        {value?.lines?.map((line: any) => (
          <div key={line.postingLineId} className="rounded-xl border p-4" data-testid={`return-reconciliation-line-${line.postingLineId}`}>
            <div className="flex items-center justify-between text-sm font-semibold"><span>{line.sku} · {line.quantity}</span><Status value={line.status} /></div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {line.checks.map((check: any) => (
                <div key={check.rule} className="rounded-lg bg-slate-50 p-3 text-xs">
                  <div className="font-semibold">{check.rule} · {check.status}</div>
                  <div className="mt-1 text-slate-500">计算 {check.calculated || "—"} / 记录 {check.recorded || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Evidence({
  rows,
  movements = [],
}: {
  rows: any[];
  movements?: any[];
}) {
  return (
    <Card className="p-5" data-testid="return-evidence">
      <h3 className="mb-3 font-semibold">证据与操作日志</h3>
      {!rows.length && !movements.length ? <div className="text-sm text-slate-500">暂无证据记录。</div> : null}
      <div className="space-y-2">
        {rows.map((row) => <div key={row.id} className="rounded-lg bg-slate-50 p-3 text-xs"><strong>{row.action}</strong> · {row.actor?.name || row.actorId || "系统"} · {row.occurredAt || row.createdAt}<div className="mt-1 text-slate-500">{row.summary || row.metadata?.reason || "正式审计事件"}</div></div>)}
        {movements.map((row) => <div key={row.id} className="rounded-lg bg-blue-50 p-3 text-xs"><strong>{row.movementType}</strong> · Batch {row.postingBatchId}<div className="mt-1 text-slate-500">入 {row.quantityIn} / 出 {row.quantityOut} · {row.balanceType}:{row.balanceId}</div></div>)}
      </div>
    </Card>
  );
}

function QuarantineList() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const query = params.toString();
  useEffect(() => {
    setData(null);
    apiJson<any>(`/api/inventory/quarantine-balances${query ? `?${query}` : ""}`)
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "隔离库存读取失败"));
  }, [query]);
  const setValue = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(name, value) : next.delete(name);
    if (name !== "page") next.set("page", "1");
    setParams(next);
  };
  if (error) return <ErrorState message={error} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4" data-testid="quarantine-inventory-workbench">
      <div>
        <h2 className="text-lg font-semibold">隔离库存</h2>
        <p className="mt-1 text-xs text-slate-500">隔离数量与普通 Available Inventory 分开显示，不能预留或销售。</p>
      </div>
      <ReadOnly capabilities={{ "return-posting": data.capability }} />
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <input aria-label="隔离库存 SKU" className={field} placeholder="SKU" value={params.get("sku") || ""} onChange={(event) => setValue("sku", event.target.value)} />
          <input aria-label="隔离库存仓库" className={field} placeholder="仓库 ID" value={params.get("warehouseId") || ""} onChange={(event) => setValue("warehouseId", event.target.value)} />
          <select aria-label="隔离库存状态" className={field} value={params.get("status") || ""} onChange={(event) => setValue("status", event.target.value)}><option value="">全部状态</option><option value="active">有效</option></select>
          <select aria-label="每页条数" className={field} value={params.get("pageSize") || "20"} onChange={(event) => setValue("pageSize", event.target.value)}><option value="20">20 / 页</option><option value="50">50 / 页</option></select>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        {data.balances.length ? <table className="w-full min-w-[860px] text-xs"><thead><tr className="border-b">{["SKU", "物料", "仓库", "库位", "隔离数量", "可用数量", "可预留", "状态"].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead><tbody>{data.balances.map((row: any) => <tr key={row.id} className="border-b last:border-0"><td className="px-4 py-3 font-semibold">{row.sku}</td><td className="px-4 py-3">{row.itemName}</td><td className="px-4 py-3">{row.warehouseId}</td><td className="px-4 py-3">{row.location || "—"}</td><td className="px-4 py-3 font-semibold text-amber-700">{row.quarantineQuantity} {row.unit}</td><td className="px-4 py-3">—（独立库存类别）</td><td className="px-4 py-3">否</td><td className="px-4 py-3">{row.status || "active"}</td></tr>)}</tbody></table> : <div className="p-10 text-center text-sm text-slate-500">当前筛选范围没有隔离库存。</div>}
      </Card>
    </div>
  );
}
