import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Ban, ExternalLink, FilePlus2, Play, RefreshCw, Scale, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { A, Card, useConfirm } from "../../components/ui";
import { StatusChip, listHeadRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { thClass, thRightClass } from "../../components/ui/workbenchTable";
import { ApiError } from "../../lib/api-client";
import { apiErrorText } from "../../lib/apiErrorText";
import { listButtonClass } from "../../components/ui/listLayout";
import { procurementApi } from "./procurementApi";
import { RfqSupplierResponseDialog } from "./RfqSupplierResponseDialog";
import { useI18n } from "../../i18n/I18n";
import { formatCalendarDay, formatDateTimeInTimeZone } from "../../lib/format";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useDocumentNumber } from "../../lib/documentNumbers";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { DocumentNumber } from "../../lib/documentNumbers";
import { BackToListLink } from "./BackToListLink";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { OverviewFieldGrid } from "../../components/document/DocumentShell";
import { rfqMoney, rfqQuantity } from "./rfqFormat";
import { RfqNoOrderNote } from "./RfqNoOrderNote";
import type { ProcurementQuotationRevision, ProcurementRfqDocument, ProcurementRfqQuotation } from "./procurementTypes";

type ReadState = "loading" | "loaded" | "notFound" | "unauthenticated" | "forbidden" | "error" | "network" | "malformed";

type Labels = Record<string, readonly [string, string]>;
type Tr = (zh: string, en: string) => string;

const RFQ_STATUS_LABELS: Labels = {
  draft: ["草稿", "Draft"],
  open: ["未结", "Open"],
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
  canonical_record: ["本询价单", "This RFQ"],
  source_request: ["来源采购申请", "Source PR"],
  linked_po: ["关联采购订单", "Linked purchase order"],
  quotation: ["供应商报价", "Supplier quotation"],
};

// The server's data limitation notes (keyed by its text) in plain business
// language, [Chinese, English]. A note not listed is shown as sent.
const LIMITATION_LABELS: Labels = {
  // The notes the read model adds for some RFQs only (design audit L16).
  "当前读取 contract 没有 RFQ owner/requester 的独立权限字段。": [
    "询价单没有单独的负责人或申请人权限。",
    "The RFQ has no separate owner or requester permission.",
  ],
  "RFQ 状态不是当前状态目录的 canonical 值，已按不可用状态返回。": [
    "该询价单的状态不是 FlowChain 当前使用的状态，按不可用显示。",
    "This RFQ's status is not one FlowChain uses now, so it shows as unavailable.",
  ],
  "存在报价但缺少 RFQ Supplier Participation 的兼容记录；参与事实仍需后续内部命令补齐。": [
    "有供应商报了价，但没有记录邀请该供应商参与。",
    "A supplier has a quote, but no invitation to this RFQ is recorded for it.",
  ],
  "存在没有 Revision 的兼容报价聚合；其旧表头商业字段不是当前报价权威，已按不可用返回。": [
    "有报价没有修订记录，其价格不作为当前报价显示。",
    "A quote has no revision on record, so its prices are not shown as the current quote."
  ],
  "RFQ Supplier Participation 仅表达内部采购参与事实；invited_internal 不证明邮件送达、Supplier Portal 身份或外部登录。": [
    "供应商参与情况是内部采购记录：记录了邀请，不代表邮件已送达，也不代表供应商已开通门户账号或已登录。",
    "Supplier participation is an internal purchasing record. A recorded invitation does not mean an email was delivered or that the supplier has a portal account or has signed in.",
  ],
  "报价 latest authority 仅由最大 revisionNumber 决定；模型不维护 isLatest 标志或 current revision 指针。": [
    "每份报价以修订号最大的版本为当前版本。",
    "Each quotation's current version is the one with the highest revision number.",
  ],
  // The key is the server's text (db-procurement-read-repository.mjs), word for word.
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
          <h2 className="fc-section-title" style={{ color: A.label }}>{tr("相关记录", "Related records")}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("与此询价单直接关联的采购申请、采购订单和报价。", "Purchase requests, purchase orders and quotations linked to this RFQ.")}</p>
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

const CANCELLABLE_RFQ = ["draft", "open", "collecting_quotes"];

function LoadedRfq({ record, canCompare, canCreate, canRevise, canTransition, notice, onReload, onSuccessReload, onTransitioned }: { record: ProcurementRfqDocument; canCompare: boolean; canCreate: boolean; canRevise: boolean; canTransition: boolean; notice: string | null; onReload: () => Promise<void>; onSuccessReload: () => Promise<void>; onTransitioned: (action: "open" | "cancel") => Promise<void> }) {
  const { language, locale } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  // Open a draft RFQ, or cancel one that is not closed (design audit L1-01,
  // A7): before this the desktop had no way to move an RFQ, so a request with
  // an RFQ could never be ordered.
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState<"open" | "cancel" | null>(null);
  const [transitionError, setTransitionError] = useState("");
  const canOpen = canTransition && record.status === "draft";
  const canCancel = canTransition && CANCELLABLE_RFQ.includes(record.status || "");
  const transition = async (action: "open" | "cancel") => {
    const number = record.number || record.id || "";
    const sure = action === "open"
      ? await confirmDialog.confirm({ title: tr(`开启询价单 ${number}？`, `Open RFQ ${number}?`), description: tr("受邀供应商会在 FlowChain 中标记为已邀请，之后可以录入报价。系统不会向供应商发送任何内容。", "Its invited suppliers are marked invited in FlowChain, and their quotes can then be recorded. Nothing is sent to the suppliers."), confirmLabel: tr("开启询价", "Open RFQ") })
      : await confirmDialog.confirm({ title: tr(`取消询价单 ${number}？`, `Cancel RFQ ${number}?`), description: tr("已录入的报价会保留在记录中。取消后，对应的采购申请可以生成采购订单。", "Its recorded quotes stay on record. Its purchase request can then be turned into a purchase order."), confirmLabel: tr("取消询价单", "Cancel RFQ"), cancelLabel: tr("保留询价单", "Keep RFQ"), tone: "danger" });
    if (!sure) return;
    setBusy(action);
    setTransitionError("");
    try {
      const version = Number(record.version ?? 0);
      await procurementApi.transitionRfq(record.id || "", action, { expectedVersion: version, idempotencyKey: `desktop.rfq.${action}:${record.id}:v${version}` });
      await onTransitioned(action);
    } catch (error) {
      setTransitionError(apiErrorText(error, language, ["The RFQ could not be updated. Reload it and try again.", "询价单更新失败，请重新加载后再试。"]));
    } finally {
      setBusy(null);
    }
  };
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
      {confirmDialog.element}
      <BackToListLink list="rfq" />
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800" data-testid="rfq-response-notice">{notice}{record.status === "cancelled" && record.linkedPr ? <> <Link to={`/app/procurement/requests/${encodeURIComponent(record.linkedPr)}`} className="font-semibold underline" data-testid="rfq-request-link">{tr("打开采购申请", "Open the purchase request")}</Link></> : null}</div>}
      {transitionError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert" data-testid="rfq-transition-error">{transitionError}</div>}
      <RfqNoOrderNote />
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {/* The status beside the title, as on every detail page (design audit U-17). */}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="fc-page-title">{record.title || rfqNumber}</h1>
              <StatusChip label={statusLabel(record.status, RFQ_STATUS_LABELS, language)} tone={statusToneOf(record.status)} testId="rfq-status" />
            </div>
            {/* What the record is, under its title, as DocumentShell writes it. */}
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{tr("询价单", "RFQ")} · <span className="font-semibold tabular-nums" style={{ color: A.blue }}>{rfqNumber}</span></div>
            {record.description && <p className="mt-2 text-sm" style={{ color: A.sub }}>{record.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canOpen && <button type="button" disabled={busy !== null} onClick={() => void transition("open")} className={listButtonClass.primary} data-testid="rfq-open-button"><Play size={14} />{tr("开启询价", "Open RFQ")}</button>}
            {canCancel && <button type="button" disabled={busy !== null} onClick={() => void transition("cancel")} className={listButtonClass.danger} data-testid="rfq-cancel-button"><Ban size={14} />{tr("取消询价单", "Cancel RFQ")}</button>}
            {canCompare && <Link
              className={listButtonClass.secondary}
              data-testid="rfq-comparison-link"
              to={`/app/procurement/rfq/${encodeURIComponent(record.id || "")}/comparison`}
            >
              <Scale size={13} />{tr("比较供应商报价", "Compare supplier quotations")}
            </Link>}
          </div>
          {!responseWorkflowOpen && <span className="text-xs" style={{ color: A.sub }}>{tr("当前询价单状态不允许录入新的供应商响应。", "The current RFQ status does not allow new supplier responses.")}</span>}
        </div>
        <OverviewFieldGrid className="mt-5" fields={([
            [tr("询价单编号", "RFQ number"), rfqNumber],
            [tr("截止日期", "Due date"), day(record.dueDate)],
            [tr("币种", "Currency"), record.currency || "—"],
            // The request and order open from here (design audit U-18).
            [tr("来源采购申请", "Source PR"), record.linkedPr ? <BusinessEntityLink entityType="purchase_request" entityId={record.linkedPr} number={requestNumber || undefined} /> : "—"],
            [tr("创建时间", "Created at"), when(record.createdAt)],
            [tr("更新时间", "Updated at"), when(record.updatedAt)],
            [tr("已记录响应", "Responses recorded"), `${record.suppliers.responseRecordedCount} / ${record.suppliers.participantCount}`],
            [tr("关联 PO", "Linked purchase order"), record.linkedPo ? <BusinessEntityLink entityType="purchase_order" entityId={record.linkedPo} number={orderNumber || undefined} /> : "—"],
          ] as Array<[string, ReactNode]>).map(([label, value]) => ({ label, value }))} />
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-lines">
        <div className="border-b p-4"><h2 className="fc-section-title" style={{ color: A.label }}>{tr("询价单行项目", "RFQ line items")}</h2></div>
        {record.lines.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前询价单没有行项目。", "This RFQ has no line items.")}</div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs">
            <thead><tr style={listHeadRowStyle}>{([[tr("行", "Line")], [tr("物料 / SKU", "Item / SKU")], [tr("数量", "Quantity"), "right"], [tr("单位", "Unit")], [tr("目标 / 参考单价", "Target / reference unit price"), "right"], [tr("需求日期", "Need by")], [tr("交付地点", "Delivery location")]] as const).map(([label, align]) => <th key={label} className={align === "right" ? thRightClass : thClass} style={{ color: A.gray1 }}>{label}</th>)}</tr></thead>
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
        <div className="flex items-center justify-between gap-3"><h2 className="fc-section-title" style={{ color: A.label }}>{tr("内部参与记录", "Internal participation records")}</h2><span className="text-xs" style={{ color: A.sub }}>{tr(`${record.suppliers.invitedInternalCount} 家有内部邀请记录 · ${record.suppliers.responseRecordedCount} 家已记录响应 · ${record.suppliers.noResponseCount} 家尚无响应`, `${record.suppliers.invitedInternalCount} internally invited · ${record.suppliers.responseRecordedCount} responses recorded · ${record.suppliers.noResponseCount} awaiting response`)}</span></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {record.suppliers.knownParticipants.map((supplier) => {
            const quotation = quotationFor(supplier.supplierId);
            const disabledByStatus = !responseWorkflowOpen || ["declined", "withdrawn", "closed"].includes(supplier.status || "");
            const actionLabel = quotation ? tr("新增报价修订", "Add quote revision") : tr("录入报价", "Record quotation");
            const allowed = quotation ? canRevise : canCreate;
            return <div key={supplier.supplierId} className="rounded-lg border p-3 text-xs" data-testid={`rfq-participant-${supplier.supplierId}`}><div className="flex items-start justify-between gap-2"><div><div className="font-medium">{supplier.supplierName || tr("未提供名称", "Name not provided")}</div><div className="mt-1" style={{ color: A.sub }}>{statusLabel(supplier.status, PARTICIPATION_STATUS_LABELS, language)}</div></div>{!disabledByStatus && allowed && <button type="button" data-testid={`rfq-response-action-${supplier.supplierId}`} className={`${rowActionClass.primary} shrink-0 gap-1`} onClick={() => openEditor(supplier)}><FilePlus2 size={13} />{actionLabel}</button>}</div><div className="mt-1 font-medium">{statusLabel(supplier.responseState, RESPONSE_STATE_LABELS, language)}</div>{quotation && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("当前报价修订", "Current quote revision")}: {quotation.latestRevision?.revisionNumber || quotation.revisionNumber || "—"} · {tr("历史报价修订只读", "Earlier quote revisions are read-only")}</div>}</div>;
          })}
          {record.suppliers.knownParticipants.length === 0 && <div className="rounded-lg bg-slate-50 p-4 text-xs" style={{ color: A.sub }}>{tr("当前询价单没有供应商参与记录。", "This RFQ has no supplier participation records.")}</div>}
        </div>
        <p className="mt-3 text-xs" style={{ color: A.sub }}>{tr("参与状态是内部采购记录；记录的邀请时间不代表邮件已送达、供应商已开通门户账号或已在外部提交报价。", "Participation status is an internal purchasing record. A recorded invitation time does not mean an email was delivered, the supplier has a portal account, or a quotation was submitted outside FlowChain.")}</p>
      </Card>

      <Card className="overflow-hidden" data-testid="rfq-quotations">
        <div className="flex items-center justify-between gap-3 border-b p-4"><h2 className="fc-section-title" style={{ color: A.label }}>{tr("供应商报价", "Supplier quotations")}</h2><span className="text-xs" style={{ color: A.sub }}>{tr(`${record.quotations.length} 条报价 · 以最新的报价修订为当前版本`, `${record.quotations.length} quotations · the latest quote revision is current`)}</span></div>
        {record.quotations.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前询价单没有报价记录。", "This RFQ has no quotation records.")}</div> : <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-xs"><thead><tr style={listHeadRowStyle}>{([[tr("报价 ID", "Quotation ID")], [tr("供应商", "Supplier")], [tr("状态", "Status")], [tr("报价总额", "Quoted total"), "right"], [tr("提交时间", "Submitted at")], [tr("修订记录", "Revisions")]] as const).map(([label, align]) => <th key={label} className={align === "right" ? thRightClass : thClass} style={{ color: A.gray1 }}>{label}</th>)}</tr></thead><tbody>{record.quotations.map((quotation) => <QuotationRow key={quotation.id} quotation={quotation} currency={record.currency || ""} />)}</tbody></table></div>}
      </Card>

      <Card className="p-4" data-testid="rfq-data-limitations">
        <div className="flex items-center gap-2"><TriangleAlert size={16} className="text-amber-600" /><h2 className="fc-section-title" style={{ color: A.label }}>{tr("记录说明", "About these records")}</h2></div>
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

  // Opening and cancelling need the RFQ commands' permission (procurement.purchase_order.revise).
  const canTransition = authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.purchase_order.revise");
  const transitioned = async (action: "open" | "cancel") => {
    setSuccessNotice(action === "open"
      ? tr("询价单已开启。受邀供应商在 FlowChain 中标记为已邀请，系统不会向他们发送任何内容。", "RFQ opened. Its invited suppliers are marked invited in FlowChain; nothing is sent to them.")
      : tr("询价单已取消，对应的采购申请现在可以生成采购订单。", "RFQ cancelled. Its purchase request can now be turned into a purchase order."));
    await load();
  };
  if (state === "loaded" && record) return <LoadedRfq record={record} canCompare={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.prices.read")} canCreate={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_response.create")} canRevise={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_response.revise")} canTransition={canTransition} notice={successNotice} onReload={async () => { setSuccessNotice(null); await load(); }} onSuccessReload={async () => { setSuccessNotice(tr("报价已保存，已显示最新结果。", "Quotation saved. The latest result is shown.")); await load(); }} onTransitioned={transitioned} />;

  const messages: Record<Exclude<ReadState, "loading" | "loaded">, string> = {
    malformed: tr("询价单链接缺少有效编号。", "The RFQ link has no valid ID."),
    notFound: tr("当前工作区中找不到该询价单，或该记录不可见。", "This RFQ was not found in the current workspace or is not visible to you."),
    unauthenticated: tr("登录状态已失效，询价单加载失败。", "Your session has expired. Sign in to view this RFQ."),
    forbidden: tr("当前用户没有查看该询价单的权限。", "You do not have permission to view this RFQ."),
    error: tr("询价单加载失败，请稍后重试。", "The RFQ is temporarily unavailable. Try again later."),
    network: tr("无法连接到询价单服务，请检查网络后重试。", "The RFQ service could not be reached. Check your connection and try again."),
  };

  return (
    <div className="space-y-4" data-testid="canonical-rfq-detail-state">
      <BackToListLink list="rfq" />
      <Card className="p-8 text-center">
        {state === "loading" ? <div className="text-sm" style={{ color: A.sub }}>{tr("正在读取询价单…", "Loading RFQ…")}</div> : <>
          <TriangleAlert className="mx-auto text-amber-600" size={30} />
          <div className="mt-3 text-sm font-semibold">{messages[state]}</div>
          {state !== "malformed" && <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><RefreshCw size={15} />{tr("重试", "Retry")}</button>}
        </>}
      </Card>
    </div>
  );
}
