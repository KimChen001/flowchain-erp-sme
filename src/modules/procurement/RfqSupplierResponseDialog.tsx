import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, RefreshCw, Save, Send, X } from "lucide-react";
import { A, Card, Chip, Modal } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { procurementApi } from "./procurementApi";
import { useI18n } from "../../i18n/I18n";
import type {
  ProcurementRfqDocument,
  ProcurementRfqParticipant,
  ProcurementRfqQuotation,
  RfqResponseLineInput,
  RfqSupplierResponseCommandInput,
} from "./procurementTypes";

type EditorMode = "initial" | "append";
type EditableLine = RfqResponseLineInput & { selected: boolean };
type Attempt = { payloadHash: string; idempotencyKey: string };

const DECIMAL_PATTERN = /^\d+(?:\.\d{1,4})?$/;
const PARTICIPATION_LABELS: Record<string, readonly [string, string]> = {
  planned: ["计划参与", "Planned"],
  invited_internal: ["已内部邀请", "Invited internally"],
  response_recorded: ["已记录响应", "Response recorded"],
  declined: ["已拒绝", "Declined"],
  withdrawn: ["已撤回", "Withdrawn"],
  closed: ["已关闭", "Closed"],
};

function isPositive(value: string) {
  if (!DECIMAL_PATTERN.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0")) > 0n;
}

function isNonNegative(value: string) {
  if (!DECIMAL_PATTERN.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0")) >= 0n;
}

function dateInput(value?: string | null) {
  if (!value) return "";
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function commandError(error: unknown, tr: (zh: string, en: string) => string) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "RFQ_RESPONSE_VERSION_CONFLICT":
        return tr("报价已被其他操作更新，请重新加载最新版本后再继续。", "The quotation was updated elsewhere. Reload the latest revision before continuing.");
      case "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD":
        return tr("本次重试标识已对应其他内容，请修改后重新发起一次保存。", "This retry key belongs to a different payload. Change the input and save again.");
      case "COMMAND_EXECUTION_IN_PROGRESS":
        return tr("相同的保存请求仍在处理中，请稍候后重试。", "The same save request is still processing. Try again shortly.");
      case "RFQ_RESPONSE_CONCURRENCY_CONFLICT":
      case "RFQ_RESPONSE_AGGREGATE_EXISTS":
      case "RFQ_RESPONSE_REVISION_AUTHORITY_MISSING":
        return tr("报价数据已发生变化，请重新加载最新版本后再继续。", "The quotation data changed. Reload the latest revision before continuing.");
      case "RFQ_RESPONSE_WORKFLOW_CONFLICT":
      case "RFQ_PARTICIPATION_WORKFLOW_CONFLICT":
        return tr("当前 RFQ 或供应商参与状态不允许记录响应，请重新加载。", "The RFQ or supplier participation status does not allow a response. Reload the record.");
      case "RFQ_RESPONSE_SUBMITTED_INCOMPLETE":
        return tr("提交报价必须覆盖全部 RFQ 行项目。", "A submitted quotation must cover every RFQ line item.");
      case "RFQ_RESPONSE_DECIMAL_INVALID":
        return tr("数量或单价格式无效，请输入非负且最多四位小数的数值。", "A quantity or unit price is invalid. Enter a nonnegative value with no more than four decimal places.");
      case "SUPPLIER_NOT_FOUND":
      case "RFQ_NOT_FOUND":
        return tr("RFQ 或供应商在当前租户下不可用。", "The RFQ or supplier is unavailable in the current workspace.");
      default:
        if (error.status === 401) return tr("登录状态已失效，请重新登录后再试。", "Your session expired. Sign in and try again.");
        if (error.status === 403) return tr("当前用户没有执行此项报价操作的权限。", "You do not have permission to perform this quotation action.");
        if (error.status === 404) return tr("RFQ 或供应商在当前租户下不可用。", "The RFQ or supplier is unavailable in the current workspace.");
        if (error.status >= 500) return tr("报价服务暂时不可用，请稍后重试。", "The quotation service is temporarily unavailable. Try again later.");
        if (error.status === 422) return tr("报价输入未通过服务校验，请检查字段后再试。", "The quotation input failed validation. Review the fields and try again.");
        return tr("报价操作未完成，请检查后重试。", "The quotation action did not complete. Review the input and try again.");
    }
  }
  return error instanceof TypeError ? tr("无法连接到报价服务，请检查网络后重试。", "The quotation service could not be reached. Check your connection and try again.") : tr("报价操作未完成，请检查后重试。", "The quotation action did not complete. Review the input and try again.");
}

function latestQuotation(record: ProcurementRfqDocument, supplierId: string) {
  return record.quotations.find((quotation) => quotation.supplierId === supplierId) || null;
}

function initialLines(record: ProcurementRfqDocument, quotation: ProcurementRfqQuotation | null): EditableLine[] {
  const previous = new Map((quotation?.latestRevision?.lines || []).map((line) => [line.rfqLineId || "", line]));
  return record.lines.map((line) => {
    const prior = previous.get(line.id);
    return {
      rfqLineId: line.id,
      quantity: prior?.quantity ?? "",
      unitPrice: prior?.unitPrice ?? "",
      deliveryDate: dateInput(prior?.deliveryDate),
      selected: Boolean(prior),
    };
  });
}

export function RfqSupplierResponseDialog({
  open,
  record,
  participant,
  mode,
  canCreate,
  canRevise,
  onClose,
  onReload,
  onSuccess,
}: {
  open: boolean;
  record: ProcurementRfqDocument;
  participant: ProcurementRfqParticipant | null;
  mode: EditorMode;
  canCreate: boolean;
  canRevise: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
  onSuccess: () => Promise<void>;
}) {
  const { language } = useI18n();
  const tr = (zh: string, en: string) => language === "en-US" ? en : zh;
  const quotation = useMemo(
    () => participant ? latestQuotation(record, participant.supplierId) : null,
    [participant, record],
  );
  const [currency, setCurrency] = useState(quotation?.latestRevision?.currency || record.currency || "CNY");
  const [paymentTerms, setPaymentTerms] = useState(quotation?.latestRevision?.paymentTerms || "");
  const [validUntil, setValidUntil] = useState(dateInput(quotation?.latestRevision?.validity));
  const [deliveryDate, setDeliveryDate] = useState(dateInput(quotation?.latestRevision?.deliveryDate));
  const [lines, setLines] = useState<EditableLine[]>(() => initialLines(record, quotation));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const submittingRef = useRef(false);

  const updateLine = (lineId: string, field: keyof RfqResponseLineInput | "selected", value: string | boolean) => {
    setLines((current) => current.map((line) => line.rfqLineId === lineId ? { ...line, [field]: value } : line));
    setError(null);
  };

  const validate = (requestedMode: "draft" | "submitted") => {
    if (!participant) return tr("请选择一个有效的 RFQ 供应商参与记录。", "Select a valid RFQ supplier participation record.");
    if (!["open", "collecting_quotes"].includes(record.status || "")) return tr("当前 RFQ 状态不允许录入新的供应商响应。", "The current RFQ status does not allow new supplier responses.");
    const selected = lines.filter((line) => line.selected);
    if (selected.length === 0) return tr("至少录入一条 RFQ 行项目后才能保存草稿。", "Select at least one RFQ line item before saving a draft.");
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) return tr("币种必须是三位 ISO 4217 代码。", "Currency must be a three-letter ISO 4217 code.");
    for (const line of selected) {
      if (!isPositive(line.quantity)) return tr(`行 ${line.rfqLineId} 的报价数量必须是正数，最多四位小数。`, `Quoted quantity for line ${line.rfqLineId} must be positive with no more than four decimal places.`);
      if (!isNonNegative(line.unitPrice)) return tr(`行 ${line.rfqLineId} 的单价必须是非负数，最多四位小数。`, `Unit price for line ${line.rfqLineId} must be nonnegative with no more than four decimal places.`);
      if (line.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(line.deliveryDate)) return tr(`行 ${line.rfqLineId} 的交期格式无效。`, `Delivery date for line ${line.rfqLineId} is invalid.`);
    }
    if (requestedMode === "submitted" && selected.length !== record.lines.length) return tr("正式提交必须覆盖全部 RFQ 行项目。", "A submitted quotation must cover every RFQ line item.");
    return null;
  };

  const submit = async (requestedMode: "draft" | "submitted") => {
    if (submittingRef.current) return;
    const validation = validate(requestedMode);
    if (validation) { setError(validation); return; }
    if (!participant) return;
    const payloadWithoutKey = {
      supplierId: participant.supplierId,
      expectedVersion: mode === "append" ? quotation?.latestRevision?.revisionNumber || quotation?.revisionNumber || 0 : 0,
      submissionMode: requestedMode,
      currency: currency.trim().toUpperCase(),
      validUntil: validUntil || null,
      deliveryDate: deliveryDate || null,
      paymentTerms: paymentTerms.trim() || null,
      lines: lines.filter((line) => line.selected).map(({ selected: _selected, ...line }) => ({ ...line, deliveryDate: line.deliveryDate || null })),
    } satisfies Omit<RfqSupplierResponseCommandInput, "idempotencyKey">;
    const payloadHash = JSON.stringify(payloadWithoutKey);
    const attempt = attemptRef.current?.payloadHash === payloadHash
      ? attemptRef.current
      : { payloadHash, idempotencyKey: globalThis.crypto.randomUUID() };
    attemptRef.current = attempt;
    const payload: RfqSupplierResponseCommandInput = { ...payloadWithoutKey, idempotencyKey: attempt.idempotencyKey };
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      mode === "append"
        ? await procurementApi.appendRfqSupplierResponseRevision(record.id, participant.supplierId, payload)
        : await procurementApi.recordRfqSupplierResponse(record.id, payload);
      attemptRef.current = null;
      onClose();
      await onSuccess();
    } catch (reason) {
      setError(commandError(reason, tr));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const title = mode === "append" ? tr("新增报价 Revision", "Add quotation revision") : tr("录入供应商报价", "Record supplier quotation");
  const canSubmit = mode === "append" ? canRevise : canCreate;
  return (
    <Modal open={open} onClose={submitting ? () => undefined : onClose} title={title} subtitle={tr("内部采购记录；服务器负责 Decimal 金额与版本权威。", "Internal procurement record. The server controls exact decimal amounts and revision authority.")} width={900} footer={(
      <>
        <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold" style={{ color: A.sub }} disabled={submitting} onClick={onClose}><X size={15} />{tr("取消", "Cancel")}</button>
        <button type="button" data-testid="rfq-response-save-draft" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold" disabled={submitting || !canSubmit} onClick={() => void submit("draft")}><Save size={15} />{tr("保存草稿", "Save draft")}</button>
        <button type="button" data-testid="rfq-response-submit" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={submitting || !canSubmit} onClick={() => void submit("submitted")}><Send size={15} />{tr("记录并提交报价", "Record and submit quotation")}</button>
      </>
    )}>
      <div className="space-y-5" data-testid="rfq-supplier-response-editor">
        {!canSubmit && <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><AlertTriangle size={15} className="mt-0.5" />{tr("当前用户没有执行此项报价操作的权限。", "You do not have permission to perform this quotation action.")}</div>}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs" style={{ color: A.sub }}>RFQ</div><div className="mt-1 text-sm font-medium">{record.id}</div></div>
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs" style={{ color: A.sub }}>{tr("供应商", "Supplier")}</div><div className="mt-1 text-sm font-medium">{participant?.supplierName || participant?.supplierId || "—"}</div><div className="mt-1 text-[11px]" style={{ color: A.sub }}>{participant?.supplierId} · {(PARTICIPATION_LABELS[participant?.status || ""]?.[language === "en-US" ? 1 : 0]) || participant?.status || "—"}</div></div>
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs" style={{ color: A.sub }}>{tr("当前版本", "Current revision")}</div><div className="mt-1 text-sm font-medium">{mode === "append" ? `Revision ${quotation?.latestRevision?.revisionNumber || quotation?.revisionNumber || "—"}` : tr("尚未创建报价", "No quotation created")}</div></div>
        </div>
        {mode === "append" && <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">{tr("现有报价历史不会被修改，本次保存将创建新的报价版本。", "Existing quotation history will remain unchanged. Saving creates a new quotation revision.")}</div>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-semibold" style={{ color: A.sub }}>{tr("币种", "Currency")}<input aria-label={tr("币种", "Currency")} className="mt-1 h-9 w-full rounded-lg border px-2 text-sm uppercase" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
          <label className="text-xs font-semibold" style={{ color: A.sub }}>{tr("付款条款", "Payment terms")}<input aria-label={tr("付款条款", "Payment terms")} className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" placeholder={tr("例如 NET30", "For example, NET30")} value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} /></label>
          <label className="text-xs font-semibold" style={{ color: A.sub }}>{tr("报价有效期", "Quotation valid until")}<input aria-label={tr("报价有效期", "Quotation valid until")} type="date" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
          <label className="text-xs font-semibold">{tr("整体交付日期", "Overall delivery date")}<input aria-label={tr("整体交付日期", "Overall delivery date")} type="date" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></label>
        </div>
        <div className="space-y-1 text-xs" style={{ color: A.sub }}>
          <p>{tr("保存草稿不会记录为供应商已响应。", "Saving a draft does not mark the supplier as having responded.")}</p>
          <p>{tr("正式提交需要覆盖全部 RFQ 行项目。", "A formal submission must cover every RFQ line item.")}</p>
        </div>
        <Card className="overflow-hidden" data-testid="rfq-response-line-editor">
          <div className="border-b p-4"><h3 className="text-sm font-semibold">{tr("RFQ 行项目", "RFQ line items")}</h3><p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("RFQ 行 ID、SKU、物料和需求数量是只读源事实；只填写供应商报价字段。", "RFQ line ID, SKU, item, and required quantity are read-only source facts. Enter supplier quotation fields only.")}</p></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs"><thead className="bg-slate-50" style={{ color: A.sub }}><tr>{[tr("录入", "Include"), tr("RFQ 行 / SKU / 物料", "RFQ line / SKU / item"), tr("需求数量", "Required quantity"), tr("报价数量", "Quoted quantity"), tr("单价", "Unit price"), tr("行交期", "Line delivery date")].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{record.lines.map((line) => { const editable = lines.find((item) => item.rfqLineId === line.id); if (!editable) return null; return <tr className="border-t align-top" data-testid={`rfq-response-editor-line-${line.id}`} key={line.id}><td className="p-3"><input aria-label={`${tr("选择", "Select")} ${line.id}`} type="checkbox" checked={editable.selected} onChange={(event) => updateLine(line.id, "selected", event.target.checked)} /></td><td className="p-3"><div className="font-medium">{line.id}</div><div className="mt-1" style={{ color: A.sub }}>{line.sku || "—"} · {line.itemName || line.itemId || "—"}</div></td><td className="p-3 tabular-nums">{line.quantity ?? "—"} {line.unit || ""}</td><td className="p-3"><input aria-label={`${tr("报价数量", "Quoted quantity")} ${line.id}`} className="h-9 w-32 rounded-lg border px-2 tabular-nums" inputMode="decimal" value={editable.quantity} onChange={(event) => updateLine(line.id, "quantity", event.target.value)} placeholder="0.0000" /></td><td className="p-3"><input aria-label={`${tr("单价", "Unit price")} ${line.id}`} className="h-9 w-32 rounded-lg border px-2 tabular-nums" inputMode="decimal" value={editable.unitPrice} onChange={(event) => updateLine(line.id, "unitPrice", event.target.value)} placeholder="0.0000" /></td><td className="p-3"><input aria-label={`${tr("行交期", "Line delivery date")} ${line.id}`} type="date" className="h-9 rounded-lg border px-2" value={editable.deliveryDate || ""} onChange={(event) => updateLine(line.id, "deliveryDate", event.target.value)} /></td></tr>; })}</tbody></table></div>
        </Card>
        {error && <div className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800" data-testid="rfq-response-error"><div className="flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5" />{error}</div>{/重新加载|reload/i.test(error) && <button type="button" className="inline-flex items-center gap-2 font-semibold text-rose-800" onClick={async () => { await onReload(); onClose(); }}><RefreshCw size={14} />{tr("重新加载", "Reload")}</button>}</div>}
        {submitting && <div className="flex items-center gap-2 text-xs" style={{ color: A.sub }}><Check size={14} />{tr("正在等待服务器确认，成功后将重新读取 RFQ。", "Waiting for server confirmation. The RFQ will reload after a successful save.")}</div>}
      </div>
    </Modal>
  );
}
