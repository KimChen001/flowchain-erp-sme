import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, FilePlus2, RefreshCw, Scale, TriangleAlert } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { A, Card, Chip } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { procurementApi } from "./procurementApi";
import { RfqSupplierResponseDialog } from "./RfqSupplierResponseDialog";
import { useI18n } from "../../i18n/I18n";
import type { ProcurementQuotationRevision, ProcurementRfqDocument, ProcurementRfqQuotation } from "./procurementTypes";

type ReadState = "loading" | "loaded" | "notFound" | "unauthenticated" | "forbidden" | "error" | "network" | "malformed";

type Labels = Record<string, readonly [string, string]>;
type Tr = (zh: string, en: string) => string;

const RFQ_STATUS_LABELS: Labels = {
  draft: ["草稿", "Draft"],
  open: ["开放", "Open"],
  collecting_quotes: ["收集报价", "Collecting quotes"],
  closed: ["已关闭", "Closed"],
  cancelled: ["已取消", "Cancelled"],
};

const QUOTATION_STATUS_LABELS: Labels = {
  draft: ["草稿", "Draft"],
  incomplete: ["不完整", "Incomplete"],
  submitted: ["已提交", "Submitted"],
  shortlisted: ["已入围", "Shortlisted"],
  not_selected: ["未中选", "Not selected"],
  withdrawn: ["已撤回", "Withdrawn"],
};

const PARTICIPATION_STATUS_LABELS: Labels = {
  planned: ["计划参与", "Planned"],
  invited_internal: ["已内部邀请", "Invited internally"],
  response_recorded: ["已记录响应", "Response recorded"],
  declined: ["已拒绝", "Declined"],
  withdrawn: ["已撤回", "Withdrawn"],
  closed: ["已关闭", "Closed"],
};

const RESPONSE_STATE_LABELS: Labels = {
  response_recorded: ["已记录响应", "Response recorded"],
  no_response: ["暂无响应", "No response"],
  declined: ["已拒绝", "Declined"],
  withdrawn: ["已撤回", "Withdrawn"],
};

const LIMITATION_ENGLISH: Record<string, string> = {
  "RFQ Supplier Participation 仅表达内部采购参与事实；invited_internal 不证明邮件送达、Supplier Portal 身份或外部登录。": "RFQ Supplier Participation represents an internal procurement fact only. invited_internal does not prove email delivery, supplier portal identity, or external login.",
  "报价 latest authority 仅由最大 revisionNumber 决定；模型不维护 isLatest 标志或 current revision 指针。": "The highest revisionNumber alone determines the authoritative quotation revision. The model does not maintain an isLatest flag or current-revision pointer.",
  "Supplier Response 与 Append Revision HTTP 写入仅可通过内部授权命令内核；当前 RFQ 页面仍保持只读。": "Supplier response and append-revision writes use the authorized internal command kernel. The RFQ page itself remains read-only.",
};

function failureState(error: unknown): Exclude<ReadState, "loading" | "loaded" | "malformed"> {
  if (error instanceof ApiError) {
    if (error.status === 404) return "notFound";
    if (error.status === 401) return "unauthenticated";
    if (error.status === 403) return "forbidden";
    return "error";
  }
  return error instanceof TypeError ? "network" : "error";
}

function statusLabel(value: string | null | undefined, labels: Labels, language: string) {
  const label = value ? labels[value] : null;
  return label ? label[language === "en-US" ? 1 : 0] : language === "en-US" ? "Not provided" : "未提供";
}

function exactDisplay(value: string, minimumFractionDigits = 0) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, rawFraction = ""] = value.split(".");
  const fraction = rawFraction.replace(/0+$/, "").padEnd(minimumFractionDigits, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function number(value: number | string | null | undefined) {
  if (typeof value === "string") return exactDisplay(value) || "—";
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

function money(value: number | string | null | undefined, currency = "CNY") {
  if (typeof value === "string") {
    const formatted = exactDisplay(value, 2);
    if (!formatted) return "—";
    const symbols: Record<string, string> = { CNY: "¥", USD: "US$", EUR: "€", GBP: "£", JPY: "JP¥" };
    return symbols[currency] ? `${symbols[currency]}${formatted}` : `${formatted} ${currency}`;
  }
  if (value == null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${number(value)} ${currency}`;
  }
}

function date(value?: string | null) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toISOString().replace("T", " ").replace("Z", " UTC");
}

function RelatedEvidence({ record }: { record: ProcurementRfqDocument }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  return (
    <Card className="p-4" data-testid="rfq-related-evidence">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{tr("相关证据", "Related evidence")}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("只展示当前 RFQ 上存在明确 ID 关系的记录。", "Only records with an explicit ID relationship to this RFQ are shown.")}</p>
        </div>
        <ExternalLink size={16} style={{ color: A.sub }} />
      </div>
      <div className="mt-3 divide-y">
        {record.relatedEvidence.map((item) => {
          const path = item.type === "pr"
            ? `/app/procurement/requests/${encodeURIComponent(item.id)}`
            : item.type === "po"
              ? `/app/procurement/orders/${encodeURIComponent(item.id)}`
              : "";
          return (
            <div key={`${item.type}:${item.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
              <div>
                <span className="font-medium">{item.label}</span>
                <span className="ml-2" style={{ color: A.sub }}>{item.relation}</span>
              </div>
              {path ? <Link className="font-semibold text-blue-600" to={path}>{tr("打开记录", "Open record")}</Link> : <span style={{ color: A.sub }}>{tr("当前只提供 ID 证据", "ID evidence only")}</span>}
            </div>
          );
        })}
        {record.relatedEvidence.length === 0 && <div className="py-5 text-center text-xs" style={{ color: A.sub }}>{tr("当前没有明确的相关记录。", "No explicitly related records were found.")}</div>}
      </div>
    </Card>
  );
}

function RevisionSummary({ revision, currency }: { revision: ProcurementQuotationRevision; currency: string }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  return (
    <div className="border-t py-2 first:border-t-0" data-testid={`rfq-revision-${revision.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Revision {revision.revisionNumber} · {revision.isLatest ? tr("当前版本", "Current") : tr("历史版本", "Historical")}</span>
        <span>{statusLabel(revision.status, QUOTATION_STATUS_LABELS, language)} · {money(revision.quotedAmount, revision.currency || currency)}</span>
      </div>
      <div className="mt-1 text-[11px]" style={{ color: A.sub }}>
        {date(revision.submittedAt || revision.createdAt)} · {revision.source || tr("未提供来源", "Source not provided")}
      </div>
      {revision.lines.map((line) => (
        <div key={line.id} className="mt-1 text-[11px]" style={{ color: A.sub }} data-testid={`rfq-revision-line-${line.id}`}>
          {line.sku || line.itemName || line.itemId || line.id} · {number(line.quantity)} {line.unit || ""} · {money(line.unitPrice, revision.currency || currency)}
        </div>
      ))}
    </div>
  );
}

function QuotationRow({ quotation, currency }: { quotation: ProcurementRfqQuotation; currency: string }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const hasAuthority = quotation.authorityState === "revision_authoritative";
  return (
    <tr className="border-t align-top" data-testid={`rfq-quotation-${quotation.id}`}>
      <td className="p-3 font-medium">{quotation.id}</td>
      <td className="p-3"><div>{quotation.supplierName || quotation.supplierId || tr("未提供", "Not provided")}</div>{quotation.lines.length > 0 && <div className="mt-1 space-y-0.5 text-[11px]" style={{ color: A.sub }}>{quotation.lines.map((line) => <div key={line.id} data-testid={`rfq-quotation-line-${line.id}`}>{line.sku || line.itemName || line.itemId || line.id} · {number(line.quantity)} {line.unit || ""} · {money(line.unitPrice, quotation.currency || currency)}</div>)}</div>}</td>
      <td className="p-3">{hasAuthority ? statusLabel(quotation.status, QUOTATION_STATUS_LABELS, language) : tr("Revision 缺失", "Revision missing")}</td>
      <td className="p-3 tabular-nums">{hasAuthority ? money(quotation.quotedAmount, quotation.currency || currency) : tr("不可用", "Unavailable")}</td>
      <td className="p-3">{hasAuthority ? <><div>{date(quotation.submittedAt)}</div><div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("交期", "Delivery")}: {quotation.deliveryDate || tr("未提供", "Not provided")}</div><div className="text-[11px]" style={{ color: A.sub }}>{tr("付款", "Payment")}: {quotation.paymentTerms || tr("未提供", "Not provided")} · {tr("有效期", "Valid until")}: {quotation.validity || tr("未提供", "Not provided")}</div></> : <div style={{ color: A.sub }}>{tr("无权威商业字段", "No authoritative commercial fields")}</div>}</td>
      <td className="p-3">
        {quotation.revisions.length === 0
          ? <div style={{ color: A.sub }}>{tr("尚无权威 Revision", "No authoritative revision")}</div>
          : quotation.revisions.map((revision) => <RevisionSummary key={revision.id} revision={revision} currency={currency} />)}
      </td>
    </tr>
  );
}

function LoadedRfq({ record, canCompare, canCreate, canRevise, notice, onReload, onSuccessReload }: { record: ProcurementRfqDocument; canCompare: boolean; canCreate: boolean; canRevise: boolean; notice: string | null; onReload: () => Promise<void>; onSuccessReload: () => Promise<void> }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const [editor, setEditor] = useState<{ supplier: typeof record.suppliers.knownParticipants[number]; mode: "initial" | "append" } | null>(null);
  const quotationFor = (supplierId: string) => record.quotations.find((quotation) => quotation.supplierId === supplierId) || null;
  const responseWorkflowOpen = ["open", "collecting_quotes"].includes(record.status || "");
  const openEditor = (supplier: typeof record.suppliers.knownParticipants[number]) => {
    const quotation = quotationFor(supplier.supplierId);
    if (!responseWorkflowOpen || ["declined", "withdrawn", "closed"].includes(supplier.status || "")) return;
    if (quotation) {
      if (!quotation.latestRevision || !canRevise) return;
      setEditor({ supplier, mode: "append" });
    } else if (canCreate) {
      setEditor({ supplier, mode: "initial" });
    }
  };
  return (
    <div className="space-y-4" data-testid="canonical-rfq-detail">
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800" data-testid="rfq-response-notice">{notice}</div>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: A.sub }}>RFQ · {record.id}</div>
            <h1 className="mt-1 text-xl font-semibold">{record.title || record.id}</h1>
            {record.description && <p className="mt-2 text-sm" style={{ color: A.sub }}>{record.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip label={statusLabel(record.status, RFQ_STATUS_LABELS, language)} color={A.blue} bg="#eff6ff" />
            {canCompare && <Link
              className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700"
              data-testid="rfq-comparison-link"
              to={`/app/procurement/rfq/${encodeURIComponent(record.id || "")}/comparison`}
            >
              <Scale size={15} />{tr("比较供应商报价", "Compare supplier quotations")}
            </Link>}
          </div>
          {!responseWorkflowOpen && <span className="text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 状态不允许录入新的供应商响应。", "The current RFQ status does not allow new supplier responses.")}</span>}
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [tr("RFQ 编号", "RFQ ID"), record.id],
            [tr("截止日期", "Due date"), record.dueDate || "—"],
            [tr("币种", "Currency"), record.currency || "—"],
            [tr("来源 PR", "Source purchase request"), record.linkedPr || "—"],
            [tr("创建时间", "Created at"), date(record.createdAt)],
            [tr("更新时间", "Updated at"), date(record.updatedAt)],
            [tr("已记录响应", "Responses recorded"), `${record.suppliers.responseRecordedCount} / ${record.suppliers.participantCount}`],
            [tr("关联 PO", "Linked purchase order"), record.linkedPo || "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-slate-50 p-3">
              <dt className="text-xs" style={{ color: A.sub }}>{label}</dt>
              <dd className="mt-1 text-sm font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-lines">
        <div className="border-b p-4"><h2 className="text-sm font-semibold">{tr("RFQ 行项目", "RFQ line items")}</h2></div>
        {record.lines.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有权威行项目。", "This RFQ has no authoritative line items.")}</div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-slate-50" style={{ color: A.sub }}><tr>{[tr("行 ID", "Line ID"), tr("物料 / SKU", "Item / SKU"), tr("数量", "Quantity"), tr("单位", "Unit"), tr("目标 / 参考单价", "Target / reference unit price"), tr("要求日期", "Required date"), tr("交付地点", "Delivery location")].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{record.lines.map((line) => <tr key={line.id} className="border-t" data-testid={`rfq-line-${line.id}`}>
              <td className="p-3 font-medium">{line.id}</td>
              <td className="p-3"><div>{line.itemName || "—"}</div><div className="mt-1" style={{ color: A.sub }}>{line.sku || line.itemId || "—"}</div></td>
              <td className="p-3 tabular-nums">{number(line.quantity)}</td>
              <td className="p-3">{line.unit || "—"}</td>
              <td className="p-3 tabular-nums">{money(line.targetUnitPrice, record.currency)}</td>
              <td className="p-3">{line.requiredDate || "—"}</td>
              <td className="p-3">{line.deliveryLocation || "—"}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </Card>

      <Card className="p-4" data-testid="rfq-suppliers">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{tr("内部参与记录", "Internal participation records")}</h2><span className="text-xs" style={{ color: A.sub }}>{tr(`${record.suppliers.invitedInternalCount} 家有内部邀请记录 · ${record.suppliers.responseRecordedCount} 家已记录响应 · ${record.suppliers.noResponseCount} 家尚无响应`, `${record.suppliers.invitedInternalCount} internally invited · ${record.suppliers.responseRecordedCount} responses recorded · ${record.suppliers.noResponseCount} awaiting response`)}</span></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {record.suppliers.knownParticipants.map((supplier) => {
            const quotation = quotationFor(supplier.supplierId);
            const disabledByStatus = !responseWorkflowOpen || ["declined", "withdrawn", "closed"].includes(supplier.status || "");
            const actionLabel = quotation ? tr("新增 Revision", "Add revision") : tr("录入报价", "Record quotation");
            const allowed = quotation ? canRevise : canCreate;
            return <div key={supplier.supplierId} className="rounded-lg border p-3 text-xs" data-testid={`rfq-participant-${supplier.supplierId}`}><div className="flex items-start justify-between gap-2"><div><div className="font-medium">{supplier.supplierName || tr("未提供名称", "Name not provided")}</div><div className="mt-1" style={{ color: A.sub }}>{supplier.supplierId} · {statusLabel(supplier.status, PARTICIPATION_STATUS_LABELS, language)}</div></div>{!disabledByStatus && allowed && <button type="button" data-testid={`rfq-response-action-${supplier.supplierId}`} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-blue-200 px-2 py-1 font-semibold text-blue-700" onClick={() => openEditor(supplier)}><FilePlus2 size={13} />{actionLabel}</button>}</div><div className="mt-1 font-medium">{statusLabel(supplier.responseState, RESPONSE_STATE_LABELS, language)}</div>{quotation && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("当前 Revision", "Current revision")}: {quotation.latestRevision?.revisionNumber || quotation.revisionNumber || "—"} · {tr("历史版本只读", "Historical revisions are read-only")}</div>}</div>;
          })}
          {record.suppliers.knownParticipants.length === 0 && <div className="rounded-lg bg-slate-50 p-4 text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有权威供应商参与记录。", "This RFQ has no authoritative supplier participation records.")}</div>}
        </div>
        <p className="mt-3 text-xs" style={{ color: A.sub }}>{tr("参与状态来自 RFQ Supplier Participation；内部邀请时间仅表示内部记录，不代表邮件送达、Supplier Portal 账号或外部提交。", "Participation status comes from RFQ Supplier Participation. An internal invitation timestamp does not prove email delivery, a supplier portal account, or an external submission.")}</p>
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-quotations">
        <div className="flex items-center justify-between gap-3 border-b p-4"><h2 className="text-sm font-semibold">{tr("供应商报价", "Supplier quotations")}</h2><span className="text-xs" style={{ color: A.sub }}>{tr(`${record.quotations.length} 条报价 · latest 取最大 revisionNumber`, `${record.quotations.length} quotations · latest uses the highest revision number`)}</span></div>
        {record.quotations.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有权威报价记录。", "This RFQ has no authoritative quotation records.")}</div> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-slate-50" style={{ color: A.sub }}><tr>{[tr("报价 ID", "Quotation ID"), tr("供应商", "Supplier"), tr("状态", "Status"), tr("报价总额", "Quoted total"), tr("提交时间", "Submitted at"), "Revision"].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>{record.quotations.map((quotation) => <QuotationRow key={quotation.id} quotation={quotation} currency={record.currency || "CNY"} />)}</tbody></table></div>}
      </Card>

      <Card className="p-4" data-testid="rfq-data-limitations">
        <div className="flex items-center gap-2"><TriangleAlert size={16} className="text-amber-600" /><h2 className="text-sm font-semibold">{tr("数据边界", "Data boundaries")}</h2></div>
        <ul className="mt-3 space-y-2 text-xs" style={{ color: A.sub }}>{record.limitations.map((limitation) => <li key={limitation}>· {language === "en-US" ? LIMITATION_ENGLISH[limitation] || limitation : limitation}</li>)}</ul>
      </Card>

      <RelatedEvidence record={record} />
      {editor && <RfqSupplierResponseDialog key={`${editor.mode}:${editor.supplier.supplierId}:${record.updatedAt || ""}`} open={Boolean(editor)} record={record} participant={editor.supplier} mode={editor.mode} canCreate={canCreate} canRevise={canRevise} onClose={() => setEditor(null)} onReload={onReload} onSuccess={onSuccessReload} />}
    </div>
  );
}

export function CanonicalRfqDetailPage({ documentId, effectivePermissionCodes, authorizationLoadState }: { documentId: string; effectivePermissionCodes: Set<string>; authorizationLoadState: "loading" | "ready" | "failed" }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const navigate = useNavigate();
  const [record, setRecord] = useState<ProcurementRfqDocument | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [state, setState] = useState<ReadState>(documentId.trim() ? "loading" : "malformed");

  const load = useCallback(async () => {
    if (!documentId.trim()) {
      setState("malformed");
      return;
    }
    setState("loading");
    setRecord(null);
    try {
      setRecord(await procurementApi.getRfqDocument(documentId));
      setState("loaded");
    } catch (error) {
      setState(failureState(error));
    }
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSuccessNotice(null); }, [documentId]);

  if (state === "loaded" && record) return <LoadedRfq record={record} canCompare={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.prices.read")} canCreate={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_response.create")} canRevise={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_response.revise")} notice={successNotice} onReload={async () => { setSuccessNotice(null); await load(); }} onSuccessReload={async () => { setSuccessNotice(tr("报价已保存，正在读取服务器权威结果。", "Quotation saved. Loading the authoritative server result.")); await load(); }} />;

  const messages: Record<Exclude<ReadState, "loading" | "loaded">, string> = {
    malformed: tr("RFQ 链接缺少有效编号。", "The RFQ link has no valid ID."),
    notFound: tr("当前租户下找不到该 RFQ，或该记录不可见。", "This RFQ was not found in the current workspace or is not visible to you."),
    unauthenticated: tr("登录状态已失效，无法读取 RFQ。", "Your session has expired. Sign in to view this RFQ."),
    forbidden: tr("当前用户没有查看该 RFQ 的权限。", "You do not have permission to view this RFQ."),
    error: tr("RFQ 暂时无法读取，请稍后重试。", "The RFQ is temporarily unavailable. Try again later."),
    network: tr("无法连接到 RFQ 服务，请检查网络后重试。", "The RFQ service could not be reached. Check your connection and try again."),
  };

  return (
    <div className="space-y-4" data-testid="canonical-rfq-detail-state">
      <Card className="p-8 text-center">
        {state === "loading" ? <div className="text-sm" style={{ color: A.sub }}>{tr("正在读取 RFQ…", "Loading RFQ…")}</div> : <>
          <TriangleAlert className="mx-auto text-amber-600" size={30} />
          <div className="mt-3 text-sm font-semibold">{messages[state]}</div>
          {state !== "malformed" && <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><RefreshCw size={15} />{tr("重试", "Retry")}</button>}
        </>}
      </Card>
      <button type="button" onClick={() => navigate("/app/procurement/rfq")} className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><ArrowLeft size={16} />{tr("返回 RFQ 列表", "Back to RFQ list")}</button>
    </div>
  );
}
