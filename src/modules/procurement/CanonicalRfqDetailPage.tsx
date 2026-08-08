import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { A, Card, Chip } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { procurementApi } from "./procurementApi";
import type { ProcurementQuotationRevision, ProcurementRfqDocument, ProcurementRfqQuotation } from "./procurementTypes";

type ReadState = "loading" | "loaded" | "notFound" | "unauthenticated" | "forbidden" | "error" | "network" | "malformed";

const RFQ_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  open: "开放",
  collecting_quotes: "收集报价",
  closed: "已关闭",
  cancelled: "已取消",
};

const QUOTATION_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  incomplete: "不完整",
  submitted: "已提交",
  shortlisted: "已入围",
  not_selected: "未中选",
  withdrawn: "已撤回",
};

const PARTICIPATION_STATUS_LABELS: Record<string, string> = {
  planned: "计划参与",
  invited_internal: "已内部邀请",
  response_recorded: "已记录响应",
  declined: "已拒绝",
  withdrawn: "已撤回",
  closed: "已关闭",
};

const RESPONSE_STATE_LABELS: Record<string, string> = {
  response_recorded: "已记录响应",
  no_response: "暂无响应",
  declined: "已拒绝",
  withdrawn: "已撤回",
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

function statusLabel(value: string | null | undefined, labels: Record<string, string>) {
  return value ? labels[value] || "未提供" : "未提供";
}

function number(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

function money(value: number | null | undefined, currency = "CNY") {
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
  return (
    <Card className="p-4" data-testid="rfq-related-evidence">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">相关证据</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>只展示当前 RFQ 上存在明确 ID 关系的记录。</p>
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
              {path ? <Link className="font-semibold text-blue-600" to={path}>打开记录</Link> : <span style={{ color: A.sub }}>当前只提供 ID 证据</span>}
            </div>
          );
        })}
        {record.relatedEvidence.length === 0 && <div className="py-5 text-center text-xs" style={{ color: A.sub }}>当前没有明确的相关记录。</div>}
      </div>
    </Card>
  );
}

function RevisionSummary({ revision, currency }: { revision: ProcurementQuotationRevision; currency: string }) {
  return (
    <div className="border-t py-2 first:border-t-0" data-testid={`rfq-revision-${revision.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Revision {revision.revisionNumber} · {revision.isLatest ? "当前版本" : "历史版本"}</span>
        <span>{statusLabel(revision.status, QUOTATION_STATUS_LABELS)} · {money(revision.quotedAmount, revision.currency || currency)}</span>
      </div>
      <div className="mt-1 text-[11px]" style={{ color: A.sub }}>
        {date(revision.submittedAt || revision.createdAt)} · {revision.source || "未提供来源"}
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
  const hasAuthority = quotation.authorityState === "revision_authoritative";
  return (
    <tr className="border-t align-top" data-testid={`rfq-quotation-${quotation.id}`}>
      <td className="p-3 font-medium">{quotation.id}</td>
      <td className="p-3"><div>{quotation.supplierName || quotation.supplierId || "未提供"}</div>{quotation.lines.length > 0 && <div className="mt-1 space-y-0.5 text-[11px]" style={{ color: A.sub }}>{quotation.lines.map((line) => <div key={line.id} data-testid={`rfq-quotation-line-${line.id}`}>{line.sku || line.itemName || line.itemId || line.id} · {number(line.quantity)} {line.unit || ""} · {money(line.unitPrice, quotation.currency || currency)}</div>)}</div>}</td>
      <td className="p-3">{hasAuthority ? statusLabel(quotation.status, QUOTATION_STATUS_LABELS) : "Revision 缺失"}</td>
      <td className="p-3 tabular-nums">{hasAuthority ? money(quotation.quotedAmount, quotation.currency || currency) : "不可用"}</td>
      <td className="p-3">{hasAuthority ? <><div>{date(quotation.submittedAt)}</div><div className="mt-1 text-[11px]" style={{ color: A.sub }}>交期：{quotation.deliveryDate || "未提供"}</div><div className="text-[11px]" style={{ color: A.sub }}>付款：{quotation.paymentTerms || "未提供"} · 有效期：{quotation.validity || "未提供"}</div></> : <div style={{ color: A.sub }}>无权威商业字段</div>}</td>
      <td className="p-3">
        {quotation.revisions.length === 0
          ? <div style={{ color: A.sub }}>尚无权威 Revision</div>
          : quotation.revisions.map((revision) => <RevisionSummary key={revision.id} revision={revision} currency={currency} />)}
      </td>
    </tr>
  );
}

function LoadedRfq({ record }: { record: ProcurementRfqDocument }) {
  return (
    <div className="space-y-4" data-testid="canonical-rfq-detail">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: A.sub }}>RFQ · {record.id}</div>
            <h1 className="mt-1 text-xl font-semibold">{record.title || record.id}</h1>
            {record.description && <p className="mt-2 text-sm" style={{ color: A.sub }}>{record.description}</p>}
          </div>
          <Chip label={statusLabel(record.status, RFQ_STATUS_LABELS)} color={A.blue} bg="#eff6ff" />
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["RFQ 编号", record.id],
            ["截止日期", record.dueDate || "—"],
            ["币种", record.currency || "—"],
            ["来源 PR", record.linkedPr || "—"],
            ["创建时间", date(record.createdAt)],
            ["更新时间", date(record.updatedAt)],
            ["已记录响应", `${record.suppliers.responseRecordedCount} / ${record.suppliers.participantCount}`],
            ["关联 PO", record.linkedPo || "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-slate-50 p-3">
              <dt className="text-xs" style={{ color: A.sub }}>{label}</dt>
              <dd className="mt-1 text-sm font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-lines">
        <div className="border-b p-4"><h2 className="text-sm font-semibold">RFQ 行项目</h2></div>
        {record.lines.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>当前 RFQ 没有权威行项目。</div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-slate-50" style={{ color: A.sub }}><tr>{["行 ID", "物料 / SKU", "数量", "单位", "目标 / 参考单价", "要求日期", "交付地点"].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
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
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">内部参与记录</h2><span className="text-xs" style={{ color: A.sub }}>{record.suppliers.invitedInternalCount} 家有内部邀请记录 · {record.suppliers.responseRecordedCount} 家已记录响应 · {record.suppliers.noResponseCount} 家尚无响应</span></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {record.suppliers.knownParticipants.map((supplier) => <div key={supplier.supplierId} className="rounded-lg border p-3 text-xs" data-testid={`rfq-participant-${supplier.supplierId}`}><div className="font-medium">{supplier.supplierName || "未提供名称"}</div><div className="mt-1" style={{ color: A.sub }}>{supplier.supplierId} · {statusLabel(supplier.status, PARTICIPATION_STATUS_LABELS)}</div><div className="mt-1 font-medium">{RESPONSE_STATE_LABELS[supplier.responseState] || "状态不可用"}</div></div>)}
          {record.suppliers.knownParticipants.length === 0 && <div className="rounded-lg bg-slate-50 p-4 text-xs" style={{ color: A.sub }}>当前 RFQ 没有权威供应商参与记录。</div>}
        </div>
        <p className="mt-3 text-xs" style={{ color: A.sub }}>参与状态来自 RFQ Supplier Participation；内部邀请时间仅表示内部记录，不代表邮件送达、Supplier Portal 账号或外部提交。</p>
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-quotations">
        <div className="flex items-center justify-between gap-3 border-b p-4"><h2 className="text-sm font-semibold">供应商报价</h2><span className="text-xs" style={{ color: A.sub }}>{record.quotations.length} 条报价 · latest 取最大 revisionNumber</span></div>
        {record.quotations.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>当前 RFQ 没有权威报价记录。</div> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-slate-50" style={{ color: A.sub }}><tr>{["报价 ID", "供应商", "状态", "报价总额", "提交时间", "Revision"].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>{record.quotations.map((quotation) => <QuotationRow key={quotation.id} quotation={quotation} currency={record.currency || "CNY"} />)}</tbody></table></div>}
      </Card>

      <Card className="p-4" data-testid="rfq-data-limitations">
        <div className="flex items-center gap-2"><TriangleAlert size={16} className="text-amber-600" /><h2 className="text-sm font-semibold">数据边界</h2></div>
        <ul className="mt-3 space-y-2 text-xs" style={{ color: A.sub }}>{record.limitations.map((limitation) => <li key={limitation}>· {limitation}</li>)}</ul>
      </Card>

      <RelatedEvidence record={record} />
    </div>
  );
}

export function CanonicalRfqDetailPage({ documentId }: { documentId: string }) {
  const navigate = useNavigate();
  const [record, setRecord] = useState<ProcurementRfqDocument | null>(null);
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

  if (state === "loaded" && record) return <LoadedRfq record={record} />;

  const messages: Record<Exclude<ReadState, "loading" | "loaded">, string> = {
    malformed: "RFQ 链接缺少有效编号。",
    notFound: "当前租户下找不到该 RFQ，或该记录不可见。",
    unauthenticated: "登录状态已失效，无法读取 RFQ。",
    forbidden: "当前用户没有查看该 RFQ 的权限。",
    error: "RFQ 暂时无法读取，请稍后重试。",
    network: "无法连接到 RFQ 服务，请检查网络后重试。",
  };

  return (
    <div className="space-y-4" data-testid="canonical-rfq-detail-state">
      <Card className="p-8 text-center">
        {state === "loading" ? <div className="text-sm" style={{ color: A.sub }}>正在读取 RFQ…</div> : <>
          <TriangleAlert className="mx-auto text-amber-600" size={30} />
          <div className="mt-3 text-sm font-semibold">{messages[state]}</div>
          {state !== "malformed" && <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><RefreshCw size={15} />重试</button>}
        </>}
      </Card>
      <button type="button" onClick={() => navigate("/app/procurement/rfq")} className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><ArrowLeft size={16} />返回 RFQ 列表</button>
    </div>
  );
}
