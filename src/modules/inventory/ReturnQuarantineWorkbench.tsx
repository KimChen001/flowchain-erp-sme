import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { apiJson } from "../../lib/api-client";
import { Card, Chip, A } from "../../components/ui";
import { createSecureClientMutationId } from "../../lib/client-id";
import { useReturnsCopy } from "./returnsCopy";

import { useWarehouseNames } from "../../lib/useWarehouseNames";
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
const enabled = (capabilities: Record<string, Capability> = {}) => {
  const values = Object.values(capabilities);
  return values.length > 0 && values.every((capability) => capability?.enabled);
};

function Status({ value }: { value: string }) {
  const { codeLabel } = useReturnsCopy();
  const positive = ["approved", "posted", "executed", "ready"].includes(value);
  return (
    <Chip
      label={codeLabel(value)}
      color={positive ? A.green : A.blue}
      bg={positive ? "#edf9f2" : "#eef5ff"}
    />
  );
}

// The error and the fallback text are kept untranslated so the message
// follows the active language, which can arrive after the request failed.
type Failure = { reason: unknown; fallback: string };

function ErrorState({
  failure,
  retry,
}: {
  failure: Failure;
  retry?: () => void;
}) {
  const { copy, errorText } = useReturnsCopy();
  return (
    <Card className="p-8 text-sm text-red-700" data-testid="returns-error">
      <div>{errorText(failure.reason, failure.fallback)}</div>
      {retry ? (
        <button className={`${secondary} mt-4`} onClick={retry}>
          {copy("Retry")}
        </button>
      ) : null}
    </Card>
  );
}

function Loading() {
  const { copy } = useReturnsCopy();
  return (
    <Card className="p-8 text-sm text-slate-500" data-testid="returns-loading">
      {copy("Loading returns and quarantine records…")}
    </Card>
  );
}

function ReadOnly({
  capabilities,
}: {
  capabilities?: Record<string, Capability>;
}) {
  const { copy } = useReturnsCopy();
  return capabilities && !enabled(capabilities) ? (
    <Card
      className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
      data-testid="returns-readonly"
    >
      {copy("Returns and quarantine are not enabled yet. Records are read only, and create, authorize, post and reverse actions are off.")}
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
  const { copy, codeLabel, issueText } = useReturnsCopy();
  const preview = value?.preview || value;
  if (!preview) return null;
  return (
    <Card className="space-y-3 border-blue-200 bg-blue-50 p-4" data-testid="return-preview">
      <div className="font-semibold">
        {copy("Preview · {result}", { result: preview.allowed ? copy("Allowed") : copy("Blocked") })}
      </div>
      {preview.blockingIssues?.map((issue: any) => (
        <div key={`${issue.code}-${issue.message}`} className="text-sm text-red-700">
          <div>{issueText(issue, "The action is blocked.")}</div>
          <div className="text-xs opacity-70">{issue.code}</div>
        </div>
      ))}
      {preview.warnings?.map((warning: any) => (
        <div key={`${warning.code}-${warning.message}`} className="text-sm text-amber-700">
          <div>{issueText(warning, "Check this before you continue.")}</div>
          <div className="text-xs opacity-70">{warning.code}</div>
        </div>
      ))}
      {preview.balanceImpacts?.length ? (
        <div className="space-y-2 text-xs">
          {preview.balanceImpacts.map((impact: any, index: number) => (
            <div key={index} className="rounded-lg bg-white p-3">
              {codeLabel(impact.balanceType)} · {impact.balanceId} ·{" "}
              {impact.onHandBefore} → {impact.onHandAfter}
              {impact.availableBefore != null
                ? ` · ${copy("Available {before} → {after}", { before: impact.availableBefore, after: impact.availableAfter })}`
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
          {busy ? copy("Working…") : confirmLabel || copy("Confirm")}
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
  const { copy } = useReturnsCopy();
  return (
    <div className="space-y-4" data-testid="returns-landing">
      <div>
        <h2 className="text-lg font-semibold">{copy("Returns")}</h2>
        <p className="mt-1 text-xs text-slate-500">
          {copy("Requests, authorizations, physical execution and quarantine disposition share one evidence trail.")}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          ["/app/inventory/returns/requests", copy("Return requests"), copy("Create, submit and track customer or supplier return requests.")],
          ["/app/inventory/returns/authorizations", copy("Return authorizations"), copy("A manager reviews quantities and disposition routes.")],
          ["/app/inventory/returns/postings", copy("Return execution"), copy("Preview, post, reconcile line by line and reverse safely.")],
          ["/app/inventory/quarantine", copy("Quarantined inventory"), copy("Shown apart from available inventory and cannot be reserved.")],
        ].map(([to, title, description]) => (
          <Link key={to} to={to} className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-2 text-xs leading-5 text-slate-500">{description}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-blue-600">
              {copy("Open workbench →")}
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
  const { copy, codeLabel } = useReturnsCopy();
  const warehouseName = useWarehouseNames();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<Failure | null>(null);
  const query = params.toString();
  useEffect(() => {
    setError(null);
    setData(null);
    apiJson<any>(`/api/returns/${kind}${query ? `?${query}` : ""}`)
      .then(setData)
      .catch((reason) =>
        setError({ reason, fallback: "Could not load returns" }),
      );
  }, [kind, query]);
  const setValue = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(name, value) : next.delete(name);
    if (name !== "page") next.set("page", "1");
    setParams(next);
  };
  if (error) return <ErrorState failure={error} />;
  if (!data) return <Loading />;
  const rows = data[kind] || [];
  const config = {
    requests: {
      title: copy("Return requests"),
      statusKey: "workflowStatus",
      statuses: ["", "draft", "submitted", "authorized", "executed", "cancelled", "rejected"],
    },
    authorizations: {
      title: copy("Return authorizations"),
      statusKey: "workflowStatus",
      statuses: ["", "approved", "partially_executed", "executed", "cancelled", "expired"],
    },
    postings: {
      title: copy("Return execution"),
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
          <p className="mt-1 text-xs text-slate-500">{copy("{n} records", { n: data.total })}</p>
        </div>
        {kind === "requests" ? (
          <Link to="/app/inventory/returns/requests/new" className={primary}>
            {copy("New return request")}
          </Link>
        ) : null}
      </div>
      <ReadOnly capabilities={data.capabilities} />
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-5">
          <input
            aria-label={copy("Search returns")}
            className={field}
            placeholder={copy("Number, partner, source document, SKU")}
            value={params.get("q") || ""}
            onChange={(event) => setValue("q", event.target.value)}
          />
          <select
            aria-label={copy("Return type")}
            className={field}
            value={params.get("returnType") || ""}
            onChange={(event) => setValue("returnType", event.target.value)}
          >
            <option value="">{copy("All types")}</option>
            <option value="customer_return">{codeLabel("customer_return")}</option>
            <option value="supplier_return">{codeLabel("supplier_return")}</option>
          </select>
          <select
            aria-label={copy("Workflow status")}
            className={field}
            value={params.get(config.statusKey) || ""}
            onChange={(event) => setValue(config.statusKey, event.target.value)}
          >
            {config.statuses.map((value) => (
              <option key={value || "all"} value={value}>
                {value ? codeLabel(value) : copy("All statuses")}
              </option>
            ))}
          </select>
          <select
            aria-label={copy("Sort by")}
            className={field}
            value={params.get("sort") || "updatedAt"}
            onChange={(event) => setValue("sort", event.target.value)}
          >
            <option value="updatedAt">{copy("Updated")}</option>
            <option value={kind === "requests" ? "requestNumber" : kind === "authorizations" ? "authorizationNumber" : "postingNumber"}>
              {copy("Number")}
            </option>
          </select>
          <select
            aria-label={copy("Sort direction")}
            className={field}
            value={params.get("direction") || "desc"}
            onChange={(event) => setValue("direction", event.target.value)}
          >
            <option value="desc">{copy("Descending")}</option>
            <option value="asc">{copy("Ascending")}</option>
          </select>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        {rows.length ? (
          <table className="w-full min-w-[920px] text-xs">
            <thead>
              <tr className="border-b">
                {[copy("Number"), copy("Type"), copy("Status"), copy("Source / related"), copy("Lines"), copy("Warehouse"), copy("Actions")].map((label) => (
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
                    <td className="px-4 py-3">{codeLabel(type)}</td>
                    <td className="px-4 py-3"><Status value={state} /></td>
                    <td className="px-4 py-3">{related || "—"}</td>
                    <td className="px-4 py-3">{row.lineCount ?? row.lines?.length ?? row.postingCount ?? "—"}</td>
                    <td className="px-4 py-3">{row.warehouseId ? warehouseName(row.warehouseId) : row.warehouseIds?.map(warehouseName).join(", ") || "—"}</td>
                    <td className="px-4 py-3">
                      <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/${kind}/${id}`}>
                        {copy("Open workbench")}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-10 text-center text-sm text-slate-500" data-testid="returns-empty">
            {copy("No records match the current filters.")}
          </div>
        )}
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span>{copy("Page {page} of {pages}", { page, pages })}</span>
        <div className="flex gap-2">
          <button className={secondary} disabled={page <= 1} onClick={() => setValue("page", String(page - 1))}>{copy("Previous")}</button>
          <button className={secondary} disabled={page >= pages} onClick={() => setValue("page", String(page + 1))}>{copy("Next")}</button>
        </div>
      </div>
    </div>
  );
}

function RequestCreate() {
  const { copy, codeLabel } = useReturnsCopy();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [error, setError] = useState<Failure | null>(null);
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
      .catch((reason) => setError({ reason, fallback: "Could not load source documents" }));
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
    setError(null);
    try {
      setPreview(await apiJson("/api/returns/requests/preview", json("POST", payload())));
    } catch (reason) {
      setError({ reason, fallback: "Could not load the preview" });
    }
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result: any = await apiJson(
        "/api/returns/requests",
        json("POST", { ...payload(), idempotencyKey: key("create-return-request") }),
      );
      navigate(`/app/inventory/returns/requests/${result.entityId}`);
    } catch (reason) {
      setError({ reason, fallback: "Could not create the request" });
    } finally {
      setBusy(false);
    }
  };
  if (error && !entry) return <ErrorState failure={error} />;
  if (!entry) return <Loading />;
  const canCreate =
    enabled(entry.capabilities) &&
    (returnType === "customer_return"
      ? entry.availableActions.createCustomerReturn
      : entry.availableActions.createSupplierReturn);
  return (
    <div className="space-y-4" data-testid="return-request-create">
      <div>
        <Link to="/app/inventory/returns/requests" className="text-sm font-semibold text-blue-600">{copy("← Back to return requests")}</Link>
        <h2 className="mt-3 text-lg font-semibold">{copy("New return request")}</h2>
      </div>
      <ReadOnly capabilities={entry.capabilities} />
      {error ? <ErrorState failure={error} /> : null}
      <Card className="space-y-5 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>{copy("Return type")}</span>
            <select aria-label={copy("Return type")} className={`${field} w-full`} value={returnType} onChange={(event) => changeType(event.target.value as any)}>
              <option value="customer_return">{codeLabel("customer_return")}</option>
              <option value="supplier_return">{codeLabel("supplier_return")}</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>{copy("Request number")}</span>
            <input aria-label={copy("Request number")} className={`${field} w-full`} value={requestNumber} onChange={(event) => { setRequestNumber(event.target.value); setPreview(null); }} />
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <span>{copy("Source document (choose one)")}</span>
            <select aria-label={copy("Source document")} className={`${field} w-full`} value={sourceId} onChange={(event) => { setSourceId(event.target.value); setSelectedLines([]); setQuantities({}); setPreview(null); }}>
              <option value="">{copy("Select a posted source document")}</option>
              {sources.map((row) => <option key={row.id} value={row.id}>{row.documentNumber} · {row.partnerName || copy("Unnamed partner")}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>{copy("Reason code")}</span>
            <input aria-label={copy("Reason code")} className={`${field} w-full`} value={reasonCode} onChange={(event) => { setReasonCode(event.target.value); setPreview(null); }} />
          </label>
          <label className="space-y-1 text-sm">
            <span>{copy("Reason details")}</span>
            <input aria-label={copy("Reason details")} className={`${field} w-full`} value={reasonDetail} onChange={(event) => { setReasonDetail(event.target.value); setPreview(null); }} />
          </label>
        </div>
        <div>
          <h3 className="mb-2 font-semibold">{copy("Source lines (choose each line)")}</h3>
          {source ? (
            <div className="space-y-2">
              {source.lines.map((line) => {
                const checked = selectedLines.includes(line.id);
                return (
                  <div key={line.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[auto_1fr_180px] md:items-center">
                    <input
                      aria-label={copy("Select source line {sku}", { sku: line.sku })}
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        setSelectedLines((current) => event.target.checked ? [...current, line.id] : current.filter((id) => id !== line.id));
                        setPreview(null);
                      }}
                    />
                    <div className="text-sm">
                      <div className="font-semibold">{line.sku} · {line.itemName}</div>
                      <div className="text-xs text-slate-500">{copy("Source quantity {quantity} {unit} · warehouse {warehouses}", { quantity: line.quantity, unit: line.unit, warehouses: line.warehouseIds.join(", ") })}</div>
                    </div>
                    <input
                      aria-label={copy("Requested quantity {sku}", { sku: line.sku })}
                      className={field}
                      disabled={!checked}
                      placeholder={copy("Requested quantity")}
                      value={quantities[line.id] || ""}
                      onChange={(event) => { setQuantities((current) => ({ ...current, [line.id]: event.target.value })); setPreview(null); }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">{copy("Choose a source document to see its lines. No line is selected for you.")}</div>
          )}
        </div>
        <button className={secondary} disabled={!canCreate} onClick={runPreview} data-testid="preview-return-request">{copy("Preview request")}</button>
      </Card>
      <Preview value={preview} confirm={create} confirmLabel={copy("Confirm request")} busy={busy} />
    </div>
  );
}

function useWorkbench(url: string) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setData(null);
    setError(null);
    apiJson<any>(url)
      .then(setData)
      .catch((reason) => setError({ reason, fallback: "Could not load the workbench" }));
  }, [url, revision]);
  return { data, error, refresh: () => setRevision((value) => value + 1) };
}

function RequestDetail({ id }: { id: string }) {
  const { copy, codeLabel, errorText, errorLabel, listSeparator } = useReturnsCopy();
  const { data, error, refresh } = useWorkbench(`/api/returns/requests/${encodeURIComponent(id)}/workbench`);
  const [preview, setPreview] = useState<any>(null);
  const [action, setAction] = useState("");
  const [authorizationNumber, setAuthorizationNumber] = useState("");
  const [authLines, setAuthLines] = useState<Record<string, { quantity: string; route: string }>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState failure={error} retry={refresh} />;
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
      setPreview({ allowed: false, blockingIssues: [{ code: "PREVIEW_FAILED", message: errorText(cause, "Could not load the preview"), localized: true }] });
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
          <Link to="/app/inventory/returns/requests" className="text-sm font-semibold text-blue-600">{copy("← Back to return requests")}</Link>
          <h2 className="mt-3 text-lg font-semibold">{request.requestNumber}</h2>
          <div className="mt-2 flex gap-2"><Status value={request.returnType} /><Status value={request.workflowStatus} /></div>
        </div>
        <div className="flex gap-2">
          <button className={secondary} disabled={!data.availableActions.submit} onClick={() => doPreview("submit")} data-testid="preview-submit-return">{copy("Preview submit")}</button>
          <button className={secondary} disabled={!data.availableActions.cancel} onClick={() => doPreview("cancel")}>{copy("Preview cancellation")}</button>
        </div>
      </div>
      <ReadOnly capabilities={data.capabilities} />
      {data.availableActions.blockingReasonCodes?.length ? (
        <Card className="p-4 text-xs text-amber-700">{copy("Action limits: {codes}", { codes: data.availableActions.blockingReasonCodes.map(errorLabel).join(listSeparator) })}</Card>
      ) : null}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-xs">
          <thead><tr className="border-b">{["SKU", copy("Item"), copy("Source line"), copy("Source quantity"), copy("Requested quantity"), copy("Warehouse")].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
          <tbody>{data.lines.map((line: any) => <tr key={line.id} className="border-b last:border-0"><td className="px-4 py-3 font-semibold">{line.sku}</td><td className="px-4 py-3">{line.itemName}</td><td className="px-4 py-3">{line.sourceDocumentLineId}</td><td className="px-4 py-3">{line.sourceQuantity}</td><td className="px-4 py-3">{line.requestedQuantity} {line.unit}</td><td className="px-4 py-3">{line.sourceWarehouseIds.join(", ")}</td></tr>)}</tbody>
        </table>
      </Card>
      {data.availableActions.authorize ? (
        <Card className="space-y-4 p-5" data-testid="return-authorization-form">
          <h3 className="font-semibold">{request.workflowStatus === "executed" ? copy("Quarantine release authorization") : copy("Manager authorization")}</h3>
          <input aria-label={copy("Authorization number")} className={`${field} w-full`} placeholder={copy("Authorization number")} value={authorizationNumber} onChange={(event) => { setAuthorizationNumber(event.target.value); setPreview(null); }} />
          {data.lines.map((line: any) => (
            <div key={line.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_180px_260px] md:items-center">
              <div className="text-sm"><strong>{line.sku}</strong><div className="text-xs text-slate-500">{copy("Requested {quantity} {unit}", { quantity: line.requestedQuantity, unit: line.unit })}</div></div>
              <input aria-label={copy("Authorized quantity {sku}", { sku: line.sku })} className={field} placeholder={copy("Authorized quantity")} value={authLines[line.id]?.quantity || ""} onChange={(event) => { setAuthLines((current) => ({ ...current, [line.id]: { quantity: event.target.value, route: current[line.id]?.route || "" } })); setPreview(null); }} />
              <select aria-label={copy("Disposition route {sku}", { sku: line.sku })} className={field} value={authLines[line.id]?.route || ""} onChange={(event) => { setAuthLines((current) => ({ ...current, [line.id]: { quantity: current[line.id]?.quantity || "", route: event.target.value } })); setPreview(null); }}>
                <option value="">{copy("Select a disposition route")}</option>
                {routeOptions.map((route) => <option key={route} value={route}>{codeLabel(route)}</option>)}
              </select>
            </div>
          ))}
          <button className={secondary} onClick={() => doPreview("authorize")} data-testid="preview-authorize-return">{copy("Preview authorization")}</button>
        </Card>
      ) : null}
      {action === "cancel" ? <input aria-label={copy("Cancellation reason")} className={`${field} w-full`} placeholder={copy("Cancellation reason")} value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
      <Preview value={preview} confirm={confirm} confirmLabel={action === "authorize" ? copy("Confirm authorization") : action === "submit" ? copy("Confirm submit") : copy("Confirm cancellation")} busy={busy} />
      <RelatedAuthorizations rows={data.authorizations} />
      <Evidence rows={data.evidence} />
    </div>
  );
}

function RelatedAuthorizations({ rows }: { rows: any[] }) {
  const { copy } = useReturnsCopy();
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold">{copy("Authorization history")}</h3>
      {rows.length ? <div className="space-y-2">{rows.map((row) => <Link key={row.id} to={`/app/inventory/returns/authorizations/${row.id}`} className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm"><span>{row.authorizationNumber}</span><Status value={row.workflowStatus} /></Link>)}</div> : <div className="text-sm text-slate-500">{copy("No authorizations yet.")}</div>}
    </Card>
  );
}

function AuthorizationDetail({ id }: { id: string }) {
  const { copy, codeLabel } = useReturnsCopy();
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
  if (error) return <ErrorState failure={error} retry={refresh} />;
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
        <Link to="/app/inventory/returns/authorizations" className="text-sm font-semibold text-blue-600">{copy("← Back to return authorizations")}</Link>
        <h2 className="mt-3 text-lg font-semibold">{auth.authorizationNumber}</h2>
        <div className="mt-2 flex gap-2"><Status value={data.request.returnType} /><Status value={auth.workflowStatus} /></div>
      </div>
      <ReadOnly capabilities={data.capabilities} />
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/requests/${data.request.id}`}>{copy("Source request {number}", { number: data.request.requestNumber })}</Link>
          <span>{copy("Version {n}", { n: auth.version })}</span>
        </div>
        {auth.lines.map((authLine: any) => {
          const requestLine: any = requestLineById[authLine.returnRequestLineId];
          const options = balances[requestLine.id] || { available: [], quarantine: [] };
          const value = lines[authLine.id] || {};
          const route = authLine.dispositionRoute;
          return (
            <div key={authLine.id} className="space-y-3 rounded-xl border p-4">
              <div className="text-sm font-semibold">{requestLine.sku} · {requestLine.itemName} · {copy("Authorized {quantity} {unit}", { quantity: authLine.authorizedQuantity, unit: requestLine.unit })}</div>
              <div className="text-xs text-slate-500">{copy("{route}; choose every balance. None is selected for you.", { route: codeLabel(route) })}</div>
              <div className="grid gap-3 md:grid-cols-3">
                <input aria-label={copy("Posting quantity {sku}", { sku: requestLine.sku })} className={field} placeholder={copy("Posting quantity")} value={value.quantity || ""} onChange={(event) => { setLines((current) => ({ ...current, [authLine.id]: { ...current[authLine.id], quantity: event.target.value } })); setPreview(null); }} />
                {route === "return_from_available" ? (
                  <BalanceSelect label={copy("Available balance {sku}", { sku: requestLine.sku })} value={value.inventoryBalanceId || ""} options={options.available} onChange={(selected) => { setLines((current) => ({ ...current, [authLine.id]: { quantity: current[authLine.id]?.quantity || "", inventoryBalanceId: selected } })); setPreview(null); }} />
                ) : (
                  <BalanceSelect label={copy("Quarantine balance {sku}", { sku: requestLine.sku })} value={value.quarantineBalanceId || ""} options={options.quarantine} onChange={(selected) => { setLines((current) => ({ ...current, [authLine.id]: { ...current[authLine.id], quarantineBalanceId: selected } })); setPreview(null); }} />
                )}
                {route === "release_quarantine_to_available" ? (
                  <BalanceSelect label={copy("Destination available balance {sku}", { sku: requestLine.sku })} value={value.destinationInventoryBalanceId || ""} options={options.available} onChange={(selected) => { setLines((current) => ({ ...current, [authLine.id]: { ...current[authLine.id], destinationInventoryBalanceId: selected } })); setPreview(null); }} />
                ) : null}
              </div>
            </div>
          );
        })}
        <input aria-label={copy("Posting number")} className={`${field} w-full`} placeholder={copy("Posting number")} value={postingNumber} onChange={(event) => { setPostingNumber(event.target.value); setPreview(null); }} />
        <button className={secondary} disabled={!data.capabilities?.["return-posting"]?.enabled || !["approved", "partially_executed"].includes(auth.workflowStatus)} onClick={runPreview} data-testid="preview-create-return-posting">{copy("Preview posting draft")}</button>
      </Card>
      <Preview value={preview} confirm={create} confirmLabel={copy("Create posting draft")} busy={busy} />
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
  const { copy } = useReturnsCopy();
  const warehouseName = useWarehouseNames();
  return (
    <select aria-label={label} className={field} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{copy("Select a balance")}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {warehouseName(option.warehouseId)} / {option.location || copy("No location")} · {option.balanceType === "available" ? copy("Available {quantity}", { quantity: option.availableQuantity }) : copy("Quarantine {quantity}", { quantity: option.quarantineQuantity })}
        </option>
      ))}
    </select>
  );
}

function PostingDetail({ id }: { id: string }) {
  const { copy, codeLabel, linkLabel } = useReturnsCopy();
  const warehouseName = useWarehouseNames();
  const { data, error, refresh } = useWorkbench(`/api/returns/postings/${encodeURIComponent(id)}/workbench`);
  const [preview, setPreview] = useState<any>(null);
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState failure={error} retry={refresh} />;
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
          <Link to="/app/inventory/returns/postings" className="text-sm font-semibold text-blue-600">{copy("← Back to return execution")}</Link>
          <h2 className="mt-3 text-lg font-semibold">{posting.postingNumber}</h2>
          <div className="mt-2 flex gap-2"><Status value={posting.postingType} /><Status value={posting.workflowStatus} /><Status value={posting.postingStatus} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={secondary} disabled={!data.availableActions.ready} onClick={() => runPreview("ready")}>{copy("Preview ready")}</button>
          <button className={secondary} disabled={!data.availableActions.post} onClick={() => runPreview("post")} data-testid="preview-post-return">{copy("Preview posting")}</button>
          <button className={secondary} disabled={!data.availableActions.reverse} onClick={() => runPreview("reverse")} data-testid="preview-reverse-return">{copy("Preview reversal")}</button>
        </div>
      </div>
      <ReadOnly capabilities={{ "return-posting": data.capability }} />
      <Card className="p-5">
        <div className="flex flex-wrap gap-4 text-sm">
          <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/requests/${data.returnRequest.id}`}>{copy("Request {number}", { number: data.returnRequest.requestNumber })}</Link>
          <Link className="font-semibold text-blue-600" to={`/app/inventory/returns/authorizations/${data.returnAuthorization.id}`}>{copy("Authorization {number}", { number: data.returnAuthorization.authorizationNumber })}</Link>
          <span>{copy("Batch {id}", { id: posting.postingBatchId || copy("Not created yet") })}</span>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-xs">
          <thead><tr className="border-b">{["SKU", copy("Quantity"), copy("Disposition route"), copy("Source balance"), copy("Destination balance"), copy("Warehouse / location")].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
          <tbody>{data.lines.map((line: any) => <tr key={line.id} className="border-b last:border-0"><td className="px-4 py-3 font-semibold">{line.sku}</td><td className="px-4 py-3">{line.quantity} {line.unit}</td><td className="px-4 py-3">{codeLabel(line.dispositionRoute)}</td><td className="px-4 py-3">{line.sourceBalanceId}</td><td className="px-4 py-3">{line.destinationBalanceId || "—"}</td><td className="px-4 py-3">{warehouseName(line.warehouseId)} / {line.location || copy("No location")}</td></tr>)}</tbody>
        </table>
      </Card>
      {action === "reverse" ? <input aria-label={copy("Reversal reason")} className={`${field} w-full`} placeholder={copy("Reversal reason (required)")} value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
      <Preview value={preview} confirm={confirm} confirmLabel={action === "ready" ? copy("Confirm ready") : action === "post" ? copy("Confirm posting") : copy("Confirm reversal")} busy={busy} />
      <Reconciliation value={data.reconciliation} />
      <Card className="p-5">
        <h3 className="mb-3 font-semibold">{copy("Related records")}</h3>
        <div className="flex flex-wrap gap-2">{data.smartLinks?.map((link: any) => <Link key={link.id} className={secondary} to={link.path}>{linkLabel(link)}</Link>)}</div>
      </Card>
      <Evidence rows={data.evidence?.audit || []} movements={data.evidence?.movements || []} />
    </div>
  );
}

function Reconciliation({ value }: { value: any }) {
  const { copy, codeLabel, ruleLabel } = useReturnsCopy();
  return (
    <Card className="p-5" data-testid="return-reconciliation">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{copy("Line reconciliation")}</h3>
        <Status value={value?.status || "unavailable"} />
      </div>
      <p className="mt-2 text-xs text-slate-500">{copy("Each return line is checked on its own. Lines never offset each other to show a match.")}</p>
      <div className="mt-4 space-y-3">
        {value?.lines?.map((line: any) => (
          <div key={line.postingLineId} className="rounded-xl border p-4" data-testid={`return-reconciliation-line-${line.postingLineId}`}>
            <div className="flex items-center justify-between text-sm font-semibold"><span>{line.sku} · {line.quantity}</span><Status value={line.status} /></div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {line.checks.map((check: any) => (
                <div key={check.rule} className="rounded-lg bg-slate-50 p-3 text-xs">
                  <div className="font-semibold">{ruleLabel(check.rule)} · {codeLabel(check.status)}</div>
                  <div className="mt-1 break-all text-slate-400">{check.rule}</div>
                  <div className="mt-1 text-slate-500">{copy("Calculated {calculated} / recorded {recorded}", { calculated: check.calculated || "—", recorded: check.recorded || "—" })}</div>
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
  const { copy, codeLabel } = useReturnsCopy();
  return (
    <Card className="p-5" data-testid="return-evidence">
      <h3 className="mb-3 font-semibold">{copy("Evidence and activity log")}</h3>
      {!rows.length && !movements.length ? <div className="text-sm text-slate-500">{copy("No evidence yet.")}</div> : null}
      <div className="space-y-2">
        {rows.map((row) => <div key={row.id} className="rounded-lg bg-slate-50 p-3 text-xs"><strong>{codeLabel(row.action)}</strong> · {row.actor?.name || row.actorId || copy("System")} · {row.occurredAt || row.createdAt}<div className="mt-1 text-slate-500">{row.summary || row.metadata?.reason || copy("Audit event")}</div></div>)}
        {movements.map((row) => <div key={row.id} className="rounded-lg bg-blue-50 p-3 text-xs"><strong>{codeLabel(row.movementType)}</strong> <span className="text-slate-400">{row.movementType}</span> · {copy("Batch {id}", { id: row.postingBatchId })}<div className="mt-1 text-slate-500">{copy("In {in} / out {out}", { in: row.quantityIn, out: row.quantityOut })} · {codeLabel(row.balanceType)}:{row.balanceId}</div></div>)}
      </div>
    </Card>
  );
}

function QuarantineList() {
  const { copy, codeLabel } = useReturnsCopy();
  const warehouseName = useWarehouseNames();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<Failure | null>(null);
  const query = params.toString();
  useEffect(() => {
    setData(null);
    apiJson<any>(`/api/inventory/quarantine-balances${query ? `?${query}` : ""}`)
      .then(setData)
      .catch((reason) => setError({ reason, fallback: "Could not load quarantine inventory" }));
  }, [query]);
  const setValue = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(name, value) : next.delete(name);
    if (name !== "page") next.set("page", "1");
    setParams(next);
  };
  if (error) return <ErrorState failure={error} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4" data-testid="quarantine-inventory-workbench">
      <div>
        <h2 className="text-lg font-semibold">{copy("Quarantined inventory")}</h2>
        <p className="mt-1 text-xs text-slate-500">{copy("Quarantined quantities are shown apart from available inventory and cannot be reserved or sold.")}</p>
      </div>
      <ReadOnly capabilities={{ "return-posting": data.capability }} />
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <input aria-label={copy("Quarantine SKU")} className={field} placeholder="SKU" value={params.get("sku") || ""} onChange={(event) => setValue("sku", event.target.value)} />
          <input aria-label={copy("Quarantine warehouse")} className={field} placeholder={copy("Warehouse ID")} value={params.get("warehouseId") || ""} onChange={(event) => setValue("warehouseId", event.target.value)} />
          <select aria-label={copy("Quarantine status")} className={field} value={params.get("status") || ""} onChange={(event) => setValue("status", event.target.value)}><option value="">{copy("All statuses")}</option><option value="active">{codeLabel("active")}</option></select>
          <select aria-label={copy("Rows per page")} className={field} value={params.get("pageSize") || "20"} onChange={(event) => setValue("pageSize", event.target.value)}><option value="20">{copy("{n} / page", { n: 20 })}</option><option value="50">{copy("{n} / page", { n: 50 })}</option></select>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        {data.balances.length ? <table className="w-full min-w-[860px] text-xs"><thead><tr className="border-b">{["SKU", copy("Item"), copy("Warehouse"), copy("Location"), copy("Quarantine quantity"), copy("Available quantity"), copy("Reservable"), copy("Status")].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead><tbody>{data.balances.map((row: any) => <tr key={row.id} className="border-b last:border-0"><td className="px-4 py-3 font-semibold">{row.sku}</td><td className="px-4 py-3">{row.itemName}</td><td className="px-4 py-3">{warehouseName(row.warehouseId)}</td><td className="px-4 py-3">{row.location || "—"}</td><td className="px-4 py-3 font-semibold text-amber-700">{row.quarantineQuantity} {row.unit}</td><td className="px-4 py-3">{copy("— (separate stock type)")}</td><td className="px-4 py-3">{copy("No")}</td><td className="px-4 py-3">{codeLabel(row.status || "active")}</td></tr>)}</tbody></table> : <div className="p-10 text-center text-sm text-slate-500">{copy("No quarantined inventory matches the current filters.")}</div>}
      </Card>
    </div>
  );
}
