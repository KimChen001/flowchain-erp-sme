import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FilePlus2, RefreshCw, Scale, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { A, Card } from "../../components/ui";
import { StatusChip, listHeadRowStyle, statusToneOf } from "../../components/ui/listLayout";
import { thClass, thRightClass } from "../../components/ui/workbenchTable";
import { ApiError } from "../../lib/api-client";
import { procurementApi } from "./procurementApi";
import { RfqSupplierResponseDialog } from "./RfqSupplierResponseDialog";
import { useI18n } from "../../i18n/I18n";
import { formatCalendarDay, formatDateTimeInTimeZone } from "../../lib/format";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useDocumentNumber } from "../../lib/documentNumbers";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { DocumentNumber } from "../../lib/documentNumbers";
import { BackToListLink } from "./BackToListLink";
import { rfqMoney, rfqQuantity } from "./rfqFormat";
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

// How a quotation revision was recorded, and how a related record relates to this RFQ.
const REVISION_SOURCE_LABELS: Labels = {
  internal_recording: ["内部录入", "Recorded internally"],
  local_demo_scenario: ["演练场景", "Walkthrough scenario"],
  local_walkthrough_scenario: ["演练场景", "Walkthrough scenario"],
};

const RELATION_LABELS: Labels = {
  canonical_record: ["本 RFQ", "This RFQ"],
  source_request: ["来源采购申请", "Source purchase request"],
  linked_po: ["关联采购订单", "Linked purchase order"],
  quotation: ["供应商报价", "Supplier quotation"],
};

// The server's data limitation notes (keyed by its text) in plain business
// language, [Chinese, English]. A note not listed is shown as sent.
const LIMITATION_LABELS: Labels = {
  "RFQ Supplier Participation 仅表达内部采购参与事实；invited_internal 不证明邮件送达、Supplier Portal 身份或外部登录。": [
    "供应商参与情况是内部采购记录：记录了邀请，不代表邮件已送达，也不代表供应商已开通门户账号或已登录。",
    "Supplier participation is an internal purchasing record. A recorded invitation does not mean an email was delivered or that the supplier has a portal account or has signed in.",
  ],
  "报价 latest authority 仅由最大 revisionNumber 决定；模型不维护 isLatest 标志或 current revision 指针。": [
    "每份报价以修订号最大的版本为当前版本。",
    "Each quotation's current version is the one with the highest revision number.",
  ],
  "Supplier Response 与 Append Revision HTTP 写入仅可通过内部授权命令内核；当前 RFQ 页面仍保持只读。": [
    "供应商响应和新的报价修订只能由有权限的同事录入；询价单本身在此页不能修改。",
    "Supplier responses and new quotation revisions can only be recorded by colleagues with permission. The RFQ itself cannot be changed on this page.",
  ],
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

// Quantities and amounts in the workspace number format, every digit of an
// exact decimal kept; no currency is assumed when none is sent.
const number = rfqQuantity;
const money = rfqMoney;

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Dates in the workspace locale: a calendar day (due, required, delivery,
// valid until) as that day ("Nov 5, 2026"); a recorded time (submitted) in
// the workspace timezone ("Oct 30, 2026, 8:30 AM"). Other text is shown as is.
function useRfqDates() {
  const { locale, timezone } = useI18n();
  const day = (value?: string | null) => (value ? formatCalendarDay(value, locale) : "—");
  const when = (value?: string | null) => (!value ? "—" : CALENDAR_DAY.test(value) ? day(value) : formatDateTimeInTimeZone(value, locale, timezone));
  return { day, when };
}

function RelatedEvidence({ record }: { record: ProcurementRfqDocument }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  return (
    <Card className="p-4" data-testid="rfq-related-evidence">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{tr("相关记录", "Related records")}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("与此 RFQ 直接关联的采购申请、采购订单和报价。", "Purchase requests, purchase orders and quotations linked to this RFQ.")}</p>
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
                <span className="font-medium">{item.type === "pr" ? <DocumentNumber type="purchase_request" id={item.id} number={item.label} /> : item.type === "po" ? <DocumentNumber type="purchase_order" id={item.id} number={item.label} /> : item.label}</span>
                <span className="ml-2" style={{ color: A.sub }}>{RELATION_LABELS[item.relation]?.[language === "en-US" ? 1 : 0] || item.relation}</span>
              </div>
              {path ? <Link className="font-semibold text-blue-600" to={path}>{tr("打开记录", "Open record")}</Link> : <span style={{ color: A.sub }}>{item.relation === "canonical_record" ? tr("当前页面", "This page") : item.relation === "quotation" ? tr("在上方报价中查看", "Shown in the quotations above") : tr("暂无详情页", "No page to open")}</span>}
            </div>
          );
        })}
        {record.relatedEvidence.length === 0 && <div className="py-5 text-center text-xs" style={{ color: A.sub }}>{tr("暂无关联记录。", "No linked records.")}</div>}
      </div>
    </Card>
  );
}

function RevisionSummary({ revision, currency }: { revision: ProcurementQuotationRevision; currency: string }) {
  const { language, locale } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const { when } = useRfqDates();
  return (
    <div className="border-t py-2 first:border-t-0 first:pt-0" data-testid={`rfq-revision-${revision.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{tr(`报价修订 ${revision.revisionNumber}`, `Quote revision ${revision.revisionNumber}`)} · {revision.isLatest ? tr("当前版本", "Current") : tr("历史版本", "Earlier")}</span>
        <span>{statusLabel(revision.status, QUOTATION_STATUS_LABELS, language)} · <span className="whitespace-nowrap tabular-nums">{money(revision.quotedAmount, revision.currency || currency, locale)}</span></span>
      </div>
      <div className="mt-1 text-[11px]" style={{ color: A.sub }}>
        <span className="whitespace-nowrap">{when(revision.submittedAt || revision.createdAt)}</span> · {revision.source ? REVISION_SOURCE_LABELS[revision.source]?.[language === "en-US" ? 1 : 0] || revision.source : tr("未提供来源", "Source not provided")}
      </div>
      {revision.lines.map((line) => (
        <div key={line.id} className="mt-1 text-[11px]" style={{ color: A.sub }} data-testid={`rfq-revision-line-${line.id}`}>
          {line.sku || line.itemName || line.itemId || line.id} · {number(line.quantity, locale)} {line.unit || ""} · {money(line.unitPrice, revision.currency || currency, locale)}
        </div>
      ))}
    </div>
  );
}

function QuotationRow({ quotation, currency }: { quotation: ProcurementRfqQuotation; currency: string }) {
  const { language, locale } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const hasAuthority = quotation.authorityState === "revision_authoritative";
  const { day, when } = useRfqDates();
  return (
    <tr className="border-t align-top" data-testid={`rfq-quotation-${quotation.id}`}>
      <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">{quotation.id}</td>
      <td className="px-4 py-3"><div>{quotation.supplierName || quotation.supplierId || tr("未提供", "Not provided")}</div>{quotation.lines.length > 0 && <div className="mt-1 space-y-0.5 text-[11px]" style={{ color: A.sub }}>{quotation.lines.map((line) => <div key={line.id} data-testid={`rfq-quotation-line-${line.id}`}>{line.sku || line.itemName || line.itemId || line.id} · {number(line.quantity, locale)} {line.unit || ""} · <span className="whitespace-nowrap">{money(line.unitPrice, quotation.currency || currency, locale)}</span></div>)}</div>}</td>
      <td className="px-4 py-3">{hasAuthority ? <StatusChip label={statusLabel(quotation.status, QUOTATION_STATUS_LABELS, language)} tone={statusToneOf(quotation.status)} /> : <StatusChip label={tr("缺少报价修订", "Quote revision missing")} tone="warning" />}</td>
      <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums">{hasAuthority ? money(quotation.quotedAmount, quotation.currency || currency, locale) : tr("不可用", "Unavailable")}</td>
      <td className="px-4 py-3">{hasAuthority ? <><div className="whitespace-nowrap">{when(quotation.submittedAt)}</div><div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("交期", "Delivery")}: <span className="whitespace-nowrap">{quotation.deliveryDate ? day(quotation.deliveryDate) : tr("未提供", "Not provided")}</span></div><div className="text-[11px]" style={{ color: A.sub }}>{tr("付款", "Payment")}: {quotation.paymentTerms || tr("未提供", "Not provided")} · {tr("有效期", "Valid until")}: <span className="whitespace-nowrap">{quotation.validity ? day(quotation.validity) : tr("未提供", "Not provided")}</span></div></> : <div style={{ color: A.sub }}>{tr("尚无可用的报价条款", "No quotation terms recorded")}</div>}</td>
      <td className="px-4 py-3">
        {quotation.revisions.length === 0
          ? <div style={{ color: A.sub }}>{tr("尚无报价修订", "No quote revision recorded")}</div>
          : quotation.revisions.map((revision) => <RevisionSummary key={revision.id} revision={revision} currency={currency} />)}
      </td>
    </tr>
  );
}

function LoadedRfq({ record, canCompare, canCreate, canRevise, notice, onReload, onSuccessReload }: { record: ProcurementRfqDocument; canCompare: boolean; canCreate: boolean; canRevise: boolean; notice: string | null; onReload: () => Promise<void>; onSuccessReload: () => Promise<void> }) {
  const { language, locale } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const { day, when } = useRfqDates();
  const warehouseName = useWarehouseNames();
  // Document numbers are shown; the ids stay in links and calls.
  const rfqNumber = record.number || record.id || "";
  const requestNumber = useDocumentNumber("purchase_request", record.linkedPr, record.prNumber);
  const orderNumber = useDocumentNumber("purchase_order", record.linkedPo, record.poNumber);
  // The breadcrumb names the RFQ by its number, not the id in the address.
  useDetailCrumb(rfqNumber);
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
      <BackToListLink list="rfq" />
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800" data-testid="rfq-response-notice">{notice}</div>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: A.sub }}>RFQ · {rfqNumber}</div>
            <h1 className="mt-1 text-xl font-semibold">{record.title || rfqNumber}</h1>
            {record.description && <p className="mt-2 text-sm" style={{ color: A.sub }}>{record.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip label={statusLabel(record.status, RFQ_STATUS_LABELS, language)} tone={statusToneOf(record.status)} />
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
            [tr("RFQ 编号", "RFQ number"), rfqNumber],
            [tr("截止日期", "Due date"), day(record.dueDate)],
            [tr("币种", "Currency"), record.currency || "—"],
            [tr("来源 PR", "Source purchase request"), requestNumber || "—"],
            [tr("创建时间", "Created at"), when(record.createdAt)],
            [tr("更新时间", "Updated at"), when(record.updatedAt)],
            [tr("已记录响应", "Responses recorded"), `${record.suppliers.responseRecordedCount} / ${record.suppliers.participantCount}`],
            [tr("关联 PO", "Linked purchase order"), orderNumber || "—"],
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
        {record.lines.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有行项目。", "This RFQ has no line items.")}</div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs">
            <thead><tr style={listHeadRowStyle}>{([[tr("行", "Line")], [tr("物料 / SKU", "Item / SKU")], [tr("数量", "Quantity"), "right"], [tr("单位", "Unit")], [tr("目标 / 参考单价", "Target / reference unit price"), "right"], [tr("要求日期", "Required date")], [tr("交付地点", "Delivery location")]] as const).map(([label, align]) => <th key={label} className={align === "right" ? thRightClass : thClass} style={{ color: A.gray1 }}>{label}</th>)}</tr></thead>
            <tbody>{record.lines.map((line, index) => <tr key={line.id} className="border-t align-top" data-testid={`rfq-line-${line.id}`}>
              <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums" title={line.id}>{tr(`第 ${index + 1} 行`, `Line ${index + 1}`)}</td>
              <td className="px-4 py-3"><div>{line.itemName || "—"}</div><div className="mt-1" style={{ color: A.sub }}>{line.sku || line.itemId || "—"}</div></td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{number(line.quantity, locale)}</td>
              <td className="px-4 py-3">{line.unit || "—"}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{money(line.targetUnitPrice, record.currency, locale)}</td>
              <td className="whitespace-nowrap px-4 py-3">{line.requiredDate ? day(line.requiredDate) : "—"}</td>
              <td className="px-4 py-3">{warehouseName(line.deliveryLocation) || "—"}</td>
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
            const actionLabel = quotation ? tr("新增报价修订", "Add quote revision") : tr("录入报价", "Record quotation");
            const allowed = quotation ? canRevise : canCreate;
            return <div key={supplier.supplierId} className="rounded-lg border p-3 text-xs" data-testid={`rfq-participant-${supplier.supplierId}`}><div className="flex items-start justify-between gap-2"><div><div className="font-medium">{supplier.supplierName || tr("未提供名称", "Name not provided")}</div><div className="mt-1" style={{ color: A.sub }}>{supplier.supplierId} · {statusLabel(supplier.status, PARTICIPATION_STATUS_LABELS, language)}</div></div>{!disabledByStatus && allowed && <button type="button" data-testid={`rfq-response-action-${supplier.supplierId}`} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-blue-200 px-2 py-1 font-semibold text-blue-700" onClick={() => openEditor(supplier)}><FilePlus2 size={13} />{actionLabel}</button>}</div><div className="mt-1 font-medium">{statusLabel(supplier.responseState, RESPONSE_STATE_LABELS, language)}</div>{quotation && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("当前报价修订", "Current quote revision")}: {quotation.latestRevision?.revisionNumber || quotation.revisionNumber || "—"} · {tr("历史报价修订只读", "Earlier quote revisions are read-only")}</div>}</div>;
          })}
          {record.suppliers.knownParticipants.length === 0 && <div className="rounded-lg bg-slate-50 p-4 text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有供应商参与记录。", "This RFQ has no supplier participation records.")}</div>}
        </div>
        <p className="mt-3 text-xs" style={{ color: A.sub }}>{tr("参与状态是内部采购记录；记录的邀请时间不代表邮件已送达、供应商已开通门户账号或已在外部提交报价。", "Participation status is an internal purchasing record. A recorded invitation time does not mean an email was delivered, the supplier has a portal account, or a quotation was submitted outside FlowChain.")}</p>
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-quotations">
        <div className="flex items-center justify-between gap-3 border-b p-4"><h2 className="text-sm font-semibold">{tr("供应商报价", "Supplier quotations")}</h2><span className="text-xs" style={{ color: A.sub }}>{tr(`${record.quotations.length} 条报价 · 以最新的报价修订为当前版本`, `${record.quotations.length} quotations · the latest quote revision is current`)}</span></div>
        {record.quotations.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有报价记录。", "This RFQ has no quotation records.")}</div> : <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-xs"><thead><tr style={listHeadRowStyle}>{([[tr("报价 ID", "Quotation ID")], [tr("供应商", "Supplier")], [tr("状态", "Status")], [tr("报价总额", "Quoted total"), "right"], [tr("提交时间", "Submitted at")], [tr("修订记录", "Revisions")]] as const).map(([label, align]) => <th key={label} className={align === "right" ? thRightClass : thClass} style={{ color: A.gray1 }}>{label}</th>)}</tr></thead><tbody>{record.quotations.map((quotation) => <QuotationRow key={quotation.id} quotation={quotation} currency={record.currency || ""} />)}</tbody></table></div>}
      </Card>

      <Card className="p-4" data-testid="rfq-data-limitations">
        <div className="flex items-center gap-2"><TriangleAlert size={16} className="text-amber-600" /><h2 className="text-sm font-semibold">{tr("记录说明", "About these records")}</h2></div>
        <ul className="mt-3 space-y-2 text-xs" style={{ color: A.sub }}>{record.limitations.map((limitation) => <li key={limitation}>· {LIMITATION_LABELS[limitation]?.[language === "en-US" ? 1 : 0] || limitation}</li>)}</ul>
      </Card>

      <RelatedEvidence record={record} />
      {editor && <RfqSupplierResponseDialog key={`${editor.mode}:${editor.supplier.supplierId}:${record.updatedAt || ""}`} open={Boolean(editor)} record={record} participant={editor.supplier} mode={editor.mode} canCreate={canCreate} canRevise={canRevise} onClose={() => setEditor(null)} onReload={onReload} onSuccess={onSuccessReload} />}
    </div>
  );
}

export function CanonicalRfqDetailPage({ documentId, effectivePermissionCodes, authorizationLoadState }: { documentId: string; effectivePermissionCodes: Set<string>; authorizationLoadState: "loading" | "ready" | "failed" }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
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

  if (state === "loaded" && record) return <LoadedRfq record={record} canCompare={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.prices.read")} canCreate={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_response.create")} canRevise={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_response.revise")} notice={successNotice} onReload={async () => { setSuccessNotice(null); await load(); }} onSuccessReload={async () => { setSuccessNotice(tr("报价已保存，已显示最新结果。", "Quotation saved. The latest result is shown.")); await load(); }} />;

  const messages: Record<Exclude<ReadState, "loading" | "loaded">, string> = {
    malformed: tr("RFQ 链接缺少有效编号。", "The RFQ link has no valid ID."),
    notFound: tr("当前工作区中找不到该 RFQ，或该记录不可见。", "This RFQ was not found in the current workspace or is not visible to you."),
    unauthenticated: tr("登录状态已失效，无法读取 RFQ。", "Your session has expired. Sign in to view this RFQ."),
    forbidden: tr("当前用户没有查看该 RFQ 的权限。", "You do not have permission to view this RFQ."),
    error: tr("RFQ 暂时无法读取，请稍后重试。", "The RFQ is temporarily unavailable. Try again later."),
    network: tr("无法连接到 RFQ 服务，请检查网络后重试。", "The RFQ service could not be reached. Check your connection and try again."),
  };

  return (
    <div className="space-y-4" data-testid="canonical-rfq-detail-state">
      <BackToListLink list="rfq" />
      <Card className="p-8 text-center">
        {state === "loading" ? <div className="text-sm" style={{ color: A.sub }}>{tr("正在读取 RFQ…", "Loading RFQ…")}</div> : <>
          <TriangleAlert className="mx-auto text-amber-600" size={30} />
          <div className="mt-3 text-sm font-semibold">{messages[state]}</div>
          {state !== "malformed" && <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><RefreshCw size={15} />{tr("重试", "Retry")}</button>}
        </>}
      </Card>
    </div>
  );
}
