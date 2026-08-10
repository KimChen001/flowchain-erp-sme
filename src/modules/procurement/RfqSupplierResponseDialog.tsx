import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, RefreshCw, Save, Send, X } from "lucide-react";
import { A, Card, Chip, Modal } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { procurementApi } from "./procurementApi";
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
const PARTICIPATION_LABELS: Record<string, string> = {
  planned: "计划参与",
  invited_internal: "已内部邀请",
  response_recorded: "已记录响应",
  declined: "已拒绝",
  withdrawn: "已撤回",
  closed: "已关闭",
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

function commandError(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "RFQ_RESPONSE_VERSION_CONFLICT":
        return "报价已被其他操作更新，请重新加载最新版本后再继续。";
      case "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD":
        return "本次重试标识已对应其他内容，请修改后重新发起一次保存。";
      case "COMMAND_EXECUTION_IN_PROGRESS":
        return "相同的保存请求仍在处理中，请稍候后重试。";
      case "RFQ_RESPONSE_CONCURRENCY_CONFLICT":
      case "RFQ_RESPONSE_AGGREGATE_EXISTS":
      case "RFQ_RESPONSE_REVISION_AUTHORITY_MISSING":
        return "报价数据已发生变化，请重新加载最新版本后再继续。";
      case "RFQ_RESPONSE_WORKFLOW_CONFLICT":
      case "RFQ_PARTICIPATION_WORKFLOW_CONFLICT":
        return "当前 RFQ 或供应商参与状态不允许记录响应，请重新加载。";
      case "RFQ_RESPONSE_SUBMITTED_INCOMPLETE":
        return "提交报价必须覆盖全部 RFQ 行项目。";
      case "RFQ_RESPONSE_DECIMAL_INVALID":
        return "数量或单价格式无效，请输入非负且最多四位小数的数值。";
      case "SUPPLIER_NOT_FOUND":
      case "RFQ_NOT_FOUND":
        return "RFQ 或供应商在当前租户下不可用。";
      default:
        if (error.status === 401) return "登录状态已失效，请重新登录后再试。";
        if (error.status === 403) return "当前用户没有执行此项报价操作的权限。";
        if (error.status === 404) return "RFQ 或供应商在当前租户下不可用。";
        if (error.status >= 500) return "报价服务暂时不可用，请稍后重试。";
        if (error.status === 422) return "报价输入未通过服务校验，请检查字段后再试。";
        return "报价操作未完成，请检查后重试。";
    }
  }
  return error instanceof TypeError ? "无法连接到报价服务，请检查网络后重试。" : "报价操作未完成，请检查后重试。";
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
      quantity: prior?.quantity == null ? "" : String(prior.quantity),
      unitPrice: prior?.unitPrice == null ? "" : String(prior.unitPrice),
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
  const quotation = useMemo(
    () => participant ? latestQuotation(record, participant.supplierId) : null,
    [participant, record],
  );
  const [currency, setCurrency] = useState(quotation?.latestRevision?.currency || record.currency || "CNY");
  const [paymentTerms, setPaymentTerms] = useState(quotation?.latestRevision?.paymentTerms || "");
  const [validUntil, setValidUntil] = useState(dateInput(quotation?.latestRevision?.validity));
  const [deliveryDate, setDeliveryDate] = useState(dateInput(quotation?.latestRevision?.deliveryDate));
  const [lines, setLines] = useState<EditableLine[]>(() => initialLines(record, quotation));
  const [submissionMode, setSubmissionMode] = useState<"draft" | "submitted">("draft");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const submittingRef = useRef(false);

  const updateLine = (lineId: string, field: keyof RfqResponseLineInput | "selected", value: string | boolean) => {
    setLines((current) => current.map((line) => line.rfqLineId === lineId ? { ...line, [field]: value } : line));
    setError(null);
  };

  const validate = (requestedMode: "draft" | "submitted") => {
    if (!participant) return "请选择一个有效的 RFQ 供应商参与记录。";
    if (!["open", "collecting_quotes"].includes(record.status || "")) return "当前 RFQ 状态不允许录入新的供应商响应。";
    const selected = lines.filter((line) => line.selected);
    if (selected.length === 0) return "至少录入一条 RFQ 行项目后才能保存草稿。";
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) return "币种必须是三位 ISO 4217 代码。";
    for (const line of selected) {
      if (!isPositive(line.quantity)) return `行 ${line.rfqLineId} 的报价数量必须是正数，最多四位小数。`;
      if (!isNonNegative(line.unitPrice)) return `行 ${line.rfqLineId} 的单价必须是非负数，最多四位小数。`;
      if (line.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(line.deliveryDate)) return `行 ${line.rfqLineId} 的交期格式无效。`;
    }
    if (requestedMode === "submitted" && selected.length !== record.lines.length) return "正式提交必须覆盖全部 RFQ 行项目。";
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
      setError(commandError(reason));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const title = mode === "append" ? "新增报价 Revision" : "录入供应商报价";
  const canSubmit = mode === "append" ? canRevise : canCreate;
  return (
    <Modal open={open} onClose={submitting ? () => undefined : onClose} title={title} subtitle="内部采购记录；服务器负责 Decimal 金额与版本权威。" width={900} footer={(
      <>
        <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold" style={{ color: A.sub }} disabled={submitting} onClick={onClose}><X size={15} />取消</button>
        <button type="button" data-testid="rfq-response-save-draft" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold" disabled={submitting || !canSubmit} onClick={() => { setSubmissionMode("draft"); void submit("draft"); }}><Save size={15} />保存草稿</button>
        <button type="button" data-testid="rfq-response-submit" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={submitting || !canSubmit} onClick={() => { setSubmissionMode("submitted"); void submit("submitted"); }}><Send size={15} />记录并提交报价</button>
      </>
    )}>
      <div className="space-y-5" data-testid="rfq-supplier-response-editor">
        {!canSubmit && <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><AlertTriangle size={15} className="mt-0.5" />当前用户没有执行此项报价操作的权限。</div>}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs" style={{ color: A.sub }}>RFQ</div><div className="mt-1 text-sm font-medium">{record.id}</div></div>
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs" style={{ color: A.sub }}>供应商</div><div className="mt-1 text-sm font-medium">{participant?.supplierName || participant?.supplierId || "—"}</div><div className="mt-1 text-[11px]" style={{ color: A.sub }}>{participant?.supplierId} · {PARTICIPATION_LABELS[participant?.status || ""] || participant?.status || "—"}</div></div>
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs" style={{ color: A.sub }}>当前版本</div><div className="mt-1 text-sm font-medium">{mode === "append" ? `Revision ${quotation?.latestRevision?.revisionNumber || quotation?.revisionNumber || "—"}` : "尚未创建报价"}</div></div>
        </div>
        {mode === "append" && <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">现有报价历史不会被修改，本次保存将创建新的报价版本。</div>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-semibold" style={{ color: A.sub }}>提交模式<select aria-label="提交模式" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" value={submissionMode} onChange={(event) => setSubmissionMode(event.target.value as "draft" | "submitted")}><option value="draft">草稿</option><option value="submitted">正式提交</option></select></label>
          <label className="text-xs font-semibold" style={{ color: A.sub }}>币种<input aria-label="币种" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm uppercase" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
          <label className="text-xs font-semibold" style={{ color: A.sub }}>付款条款<input aria-label="付款条款" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" placeholder="例如 NET30" value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} /></label>
          <label className="text-xs font-semibold" style={{ color: A.sub }}>报价有效期<input aria-label="报价有效期" type="date" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
          <label className="text-xs font-semibold">整体交付日期<input aria-label="整体交付日期" type="date" className="mt-1 h-9 w-full rounded-lg border px-2 text-sm" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></label>
        </div>
        <Card className="overflow-hidden" data-testid="rfq-response-line-editor">
          <div className="border-b p-4"><h3 className="text-sm font-semibold">RFQ 行项目</h3><p className="mt-1 text-xs" style={{ color: A.sub }}>RFQ 行 ID、SKU、物料和需求数量是只读源事实；只填写供应商报价字段。</p></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs"><thead className="bg-slate-50" style={{ color: A.sub }}><tr>{["录入", "RFQ 行 / SKU / 物料", "需求数量", "报价数量", "单价", "行交期"].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{record.lines.map((line) => { const editable = lines.find((item) => item.rfqLineId === line.id); if (!editable) return null; return <tr className="border-t align-top" data-testid={`rfq-response-editor-line-${line.id}`} key={line.id}><td className="p-3"><input aria-label={`选择 ${line.id}`} type="checkbox" checked={editable.selected} onChange={(event) => updateLine(line.id, "selected", event.target.checked)} /></td><td className="p-3"><div className="font-medium">{line.id}</div><div className="mt-1" style={{ color: A.sub }}>{line.sku || "—"} · {line.itemName || line.itemId || "—"}</div></td><td className="p-3 tabular-nums">{line.quantity ?? "—"} {line.unit || ""}</td><td className="p-3"><input aria-label={`报价数量 ${line.id}`} className="h-9 w-32 rounded-lg border px-2 tabular-nums" inputMode="decimal" value={editable.quantity} onChange={(event) => updateLine(line.id, "quantity", event.target.value)} placeholder="0.0000" /></td><td className="p-3"><input aria-label={`单价 ${line.id}`} className="h-9 w-32 rounded-lg border px-2 tabular-nums" inputMode="decimal" value={editable.unitPrice} onChange={(event) => updateLine(line.id, "unitPrice", event.target.value)} placeholder="0.0000" /></td><td className="p-3"><input aria-label={`行交期 ${line.id}`} type="date" className="h-9 rounded-lg border px-2" value={editable.deliveryDate || ""} onChange={(event) => updateLine(line.id, "deliveryDate", event.target.value)} /></td></tr>; })}</tbody></table></div>
        </Card>
        {error && <div className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800" data-testid="rfq-response-error"><div className="flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5" />{error}</div>{error.includes("重新加载") && <button type="button" className="inline-flex items-center gap-2 font-semibold text-rose-800" onClick={async () => { await onReload(); onClose(); }}><RefreshCw size={14} />重新加载</button>}</div>}
        {submitting && <div className="flex items-center gap-2 text-xs" style={{ color: A.sub }}><Check size={14} />正在等待服务器确认，成功后将重新读取 RFQ。</div>}
      </div>
    </Modal>
  );
}
