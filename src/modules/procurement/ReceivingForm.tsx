import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { FieldError, FormActionBar, FormHeader, FormLineCard, FormSection, RequiredMark, focusFirstInvalid, formGridClass, invalidProps, useFormCopy } from "../../components/ui/formLayout";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";
import { dateTimeInputInTimeZone, dateTimeInputToIso } from "../../lib/format";
import { receivingApi, type ReceivableLine, type ReceivablePurchaseOrder, type ReceiptInput, type ReceivingWarehouse } from "./receivingApi";
import { PrefillSourceChip } from "../../components/prefill/PrefillSource";
import { buildSuggestionTrail, type PrefillEntry } from "../../lib/prefill";
import { ReceivablePurchaseOrderChooser } from "./ReceivablePurchaseOrderChooser";
import { DocumentNumber } from "../../lib/documentNumbers";
import { procurementErrorCode, procurementErrorText } from "./procurementErrors";
import { useMediaQuery } from "./listPaging";
import { unitLabel } from "../../i18n/unitLabels";

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  titleNew: ["Receive purchase order", "采购订单收货"],
  titleEdit: ["Edit receipt draft", "编辑收货草稿"],
  intro: ["Record what arrived. Accepted quantity goes to stock when the receipt is posted; rejected quantity stays out of stock.", "登记本次到货。收货单过账后，合格数量计入库存；拒收数量不入库。"],
  numberOnSave: ["The receipt number is assigned when you save.", "收货单号在保存时自动生成。"],
  details: ["Receipt details", "收货信息"],
  linesTitle: ["Lines to receive", "收货明细"],
  linesIntro: ["Tick the lines that arrived. A rejected quantity needs a reason.", "勾选本次到货的行。有拒收数量时需填写拒收原因。"],
  loading: ["Loading the purchase order…", "正在读取采购订单…"],
  loadFailed: ["The purchase order could not be loaded for receiving.", "可收货的采购订单加载失败。"],
  retry: ["Retry", "重试"],
  notReceivable: ["This purchase order cannot be received in its current status.", "该采购订单当前状态不可收货。"],
  purchaseOrder: ["Purchase order", "采购订单"],
  supplier: ["Supplier", "供应商"],
  warehouse: ["Receiving warehouse", "收货仓库"],
  selectWarehouse: ["Select a warehouse", "选择仓库"],
  noWarehouse: ["You have no warehouse you can receive into. Ask an administrator for warehouse access.", "你没有可收货的仓库权限，请联系管理员。"],
  arrivedAt: ["Arrival time", "到货时间"],
  timezone: ["Workspace time zone", "工作区时区"],
  note: ["Note", "备注"],
  include: ["Receive", "收货"],
  sku: ["SKU", "SKU"],
  item: ["Item", "物料"],
  ordered: ["Ordered", "订购"],
  received: ["Received", "已收"],
  remaining: ["Open", "未收"],
  accepted: ["Accepted", "合格"],
  acceptedHint: ["Starts at the quantity still to receive", "默认为待收数量"],
  rejected: ["Rejected", "拒收"],
  rejectionReason: ["Rejection reason", "拒收原因"],
  location: ["Location", "库位"],
  locationStocked: ["Where this item is stocked", "该物料现有库位"],
  locationNew: ["New location in this warehouse", "此仓库的新库位"],
  saveDraft: ["Save draft", "保存草稿"],
  // Submitting does not post: the receipt page then offers Post receipt.
  saveSubmit: ["Save and submit", "保存并提交"],
  lineLabel: ["Line {n}", "第 {n} 行"],
  lineRequired: ["Select at least one line to receive.", "请至少选择一行收货。"],
  acceptedPositive: ["Accepted quantity must be greater than zero.", "合格数量必须大于零。"],
  overReceipt: ["Accepted quantity is more than the open quantity on the purchase order.", "合格数量超过采购订单未收数量。"],
  invalidQuantity: ["Enter a number with up to four decimal places.", "请输入最多四位小数的数量。"],
  reasonRequired: ["Enter a reason for the rejected quantity.", "请填写拒收原因。"],
  warehouseRequired: ["Select the receiving warehouse.", "请选择收货仓库。"],
  arrivalRequired: ["Enter the arrival time.", "请填写到货时间。"],
  failed: ["The receipt could not be saved.", "收货单保存失败。"],
  versionConflict: ["The receipt changed since it was loaded. Reload and try again.", "收货单已被修改，请刷新后重试。"],
  permissionDenied: ["Your role cannot prepare receipts.", "你的角色无权准备收货单。"],
  warehouseDenied: ["You cannot receive into this warehouse.", "你无权在该仓库收货。"],
  capability: ["Receiving is not enabled for this workspace.", "当前工作区未启用收货过账。"],
  immutable: ["This receipt was already submitted or posted and can no longer be edited.", "该收货单已提交或过账，无法再编辑。"],
};

type Detail = {
  receivingDocument: { id: string; documentNumber: string; workflowStatus: string; postingStatus: string; version: number; arrivedAt?: string | null; warehouse?: { id?: string } | null };
  purchaseOrder: { id: string };
  lines: Array<{ poLineId: string; acceptedQuantity: string; rejectedQuantity: string; rejectionReason?: string | null; location?: string }>;
};
type LineState = { include: boolean; accepted: string; rejected: string; reason: string; location: string };
// A line's messages, as COPY keys, by field.
type LineIssues = { accepted?: string; rejected?: string; reason?: string };

const QUANTITY = /^\d+(?:\.\d{1,4})?$/;
// The location holding most of the item in the warehouse, so a receipt adds to
// that stock record instead of starting one without a location.
const stockedLocation = (line: ReceivableLine, warehouseId: string) => line.stockLocations?.find((row) => row.warehouseId === warehouseId)?.location || "";
// Four-decimal quantities compared as integers of 1/10000, as the server does.
const units = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 10000n + BigInt((fraction + "0000").slice(0, 4));
};

type ReceivingFormProps = { mode: "new" | "edit"; purchaseOrderId?: string; receiptId?: string };

// A new receipt opened without an order shows the orders that can be received
// now; choosing one opens the form. Each order or receipt gets a form of its
// own, so its state and its create key never carry over to another.
export function ReceivingForm({ mode, purchaseOrderId = "", receiptId = "" }: ReceivingFormProps) {
  if (mode === "new" && !purchaseOrderId) return <ReceivablePurchaseOrderChooser />;
  return <ReceivingFormBody key={`${mode}:${purchaseOrderId}:${receiptId}`} mode={mode} purchaseOrderId={purchaseOrderId} receiptId={receiptId} />;
}

function ReceivingFormBody({ mode, purchaseOrderId = "", receiptId = "" }: ReceivingFormProps) {
  const { language, timezone, formatNumber } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const navigate = useNavigate();
  const [po, setPo] = useState<ReceivablePurchaseOrder | null>(null);
  const [warehouses, setWarehouses] = useState<ReceivingWarehouse[]>([]);
  const [draft, setDraft] = useState<Detail["receivingDocument"] | null>(null);
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [warehouseId, setWarehouseId] = useState("");
  const [arrivedAt, setArrivedAt] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // A save was refused: the messages show, and go as each field is fixed.
  const [checked, setChecked] = useState(false);
  const formCopy = useFormCopy();
  const formRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const [serverError, setServerError] = useState("");
  // The failed request's code, in the message's tooltip for support.
  const [serverErrorCode, setServerErrorCode] = useState<string | undefined>();
  const [saving, setSaving] = useState<"" | "draft" | "submit">("");
  // One key per form: a resend after a lost response replays the same receipt.
  const [createKey] = useState(() => createSecureClientMutationId("receipt"));
  // What a new receipt was prefilled with, and from where (docs/ai-prefill-autocomplete-design.md, J4).
  const [prefill, setPrefill] = useState<{ warehouseId?: PrefillEntry; arrivedAt?: PrefillEntry; accepted: Record<string, string> } | null>(null);
  const [createdId, setCreatedId] = useState("");
  // Below 768 px each line is a card with its fields stacked; wider screens
  // keep the table. Only one is drawn, so every field keeps one name.
  const phone = useMediaQuery("(max-width: 767.98px)");

  const load = useCallback(async () => {
    setState("loading");
    try {
      let detail: Detail | null = null;
      let poId = purchaseOrderId;
      if (mode === "edit") {
        detail = await apiJson<Detail>(`/api/procurement/receiving/${encodeURIComponent(receiptId)}`);
        poId = detail.purchaseOrder.id;
      }
      if (!poId) { setState("error"); return; }
      const [receivable, profile] = await Promise.all([
        receivingApi.receivableLines(poId),
        // The user's default warehouse, the fallback for a new receipt.
        mode === "new" ? apiJson<{ defaultWarehouseId?: string | null }>("/api/me/profile").catch(() => null) : Promise.resolve(null),
      ]);
      const existing = new Map((detail?.lines || []).map((line) => [line.poLineId, line]));
      setPo(receivable.purchaseOrder);
      setWarehouses(receivable.warehouses);
      setDraft(detail?.receivingDocument || null);
      setLines(Object.fromEntries(receivable.purchaseOrder.lines.map((line) => {
        const saved = existing.get(line.id);
        return [line.id, saved
          ? { include: true, accepted: String(Number(saved.acceptedQuantity)), rejected: String(Number(saved.rejectedQuantity)), reason: saved.rejectionReason || "", location: saved.location || "" }
          : { include: mode === "new" && units(line.remainingQuantity) > 0n, accepted: mode === "new" ? String(Number(line.remainingQuantity)) : "", rejected: "0", reason: "", location: "" }];
      })));
      // The saved warehouse; for a new receipt, the purchase order's, else the
      // user's default, else the only one the user may receive into.
      const usable = (id?: string | null) => Boolean(id) && receivable.warehouses.some((row) => row.id === id);
      const saved = detail?.receivingDocument.warehouse?.id || "";
      const fromPo = receivable.purchaseOrder.defaultWarehouseId || "";
      const fromUser = profile?.defaultWarehouseId || "";
      const [chosen, ref] = usable(saved) ? [saved, ""]
        : usable(fromPo) ? [fromPo, "purchase_order:warehouse"]
          : usable(fromUser) ? [fromUser, "user:default_warehouse"]
            : receivable.warehouses.length === 1 ? [receivable.warehouses[0].id, "workspace:only_warehouse"] : ["", ""];
      setWarehouseId(chosen);
      if (mode === "new") setLines((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => {
        const line = receivable.purchaseOrder.lines.find((row) => row.id === id);
        return [id, line ? { ...value, location: stockedLocation(line, chosen) } : value];
      })));
      const arrival = dateTimeInputInTimeZone(detail?.receivingDocument.arrivedAt ? new Date(detail.receivingDocument.arrivedAt) : new Date(), timezone);
      setArrivedAt(arrival);
      setPrefill(mode === "new" ? {
        ...(chosen && ref ? { warehouseId: { source: "default", ref, value: chosen } } : {}),
        arrivedAt: { source: "default", ref: "clock:now", value: arrival },
        accepted: Object.fromEntries(receivable.purchaseOrder.lines.filter((line) => units(line.remainingQuantity) > 0n).map((line) => [line.id, String(Number(line.remainingQuantity))])),
      } : null);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [mode, purchaseOrderId, receiptId, timezone]);

  useEffect(() => { void load(); }, [load]);

  const update = (lineId: string, patch: Partial<LineState>) => setLines((current) => ({ ...current, [lineId]: { ...current[lineId], ...patch } }));
  // A location left empty or still on the old warehouse's stocked location
  // follows the new warehouse; one the person typed stays.
  const changeWarehouse = (next: string) => {
    if (po) setLines((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => {
      const line = po.lines.find((row) => row.id === id);
      const untouched = line && (!value.location.trim() || value.location === stockedLocation(line, warehouseId));
      return [id, line && untouched ? { ...value, location: stockedLocation(line, next) } : value];
    })));
    setWarehouseId(next);
  };
  const knownLocations = warehouses.find((row) => row.id === warehouseId)?.locations || [];

  // The receipt's rules, each message under its field: `form` holds what
  // has no field (no line chosen).
  const validation = useMemo(() => {
    const form: string[] = [];
    const header: { warehouse?: string; arrival?: string } = {};
    const byLine: Record<string, LineIssues> = {};
    if (!po) return { form, header, byLine, count: 0 };
    const chosen = po.lines.filter((line) => lines[line.id]?.include);
    if (!chosen.length) form.push("lineRequired");
    for (const line of chosen) {
      const value = lines[line.id];
      const accepted = value.accepted.trim();
      const rejected = value.rejected.trim() || "0";
      const issue: LineIssues = {};
      if (!QUANTITY.test(accepted)) issue.accepted = "invalidQuantity";
      else if (units(accepted) <= 0n) issue.accepted = "acceptedPositive";
      else if (units(accepted) > units(line.remainingQuantity)) issue.accepted = "overReceipt";
      if (!QUANTITY.test(rejected)) issue.rejected = "invalidQuantity";
      else if (units(rejected) > 0n && !value.reason.trim()) issue.reason = "reasonRequired";
      if (Object.keys(issue).length) byLine[line.id] = issue;
    }
    if (!warehouseId) header.warehouse = "warehouseRequired";
    if (!dateTimeInputToIso(arrivedAt, timezone)) header.arrival = "arrivalRequired";
    return { form, header, byLine, count: form.length + Object.keys(header).length + Object.keys(byLine).length };
  }, [arrivedAt, lines, po, timezone, warehouseId]);
  const shown = checked ? validation : { form: [] as string[], header: {} as typeof validation.header, byLine: {} as Record<string, LineIssues>, count: 0 };

  const serverMessage = (error: unknown) => {
    if (!(error instanceof ApiError)) return tr("failed");
    const byCode: Record<string, string> = {
      RECEIVING_OVER_RECEIPT: tr("overReceipt"), RECEIVING_REJECTION_REASON_REQUIRED: tr("reasonRequired"),
      SYNC_VERSION_CONFLICT: tr("versionConflict"), RECEIVING_IMMUTABLE: tr("immutable"), RECEIVING_WORKFLOW_CONFLICT: tr("immutable"),
      AUTHORIZATION_PERMISSION_DENIED: tr("permissionDenied"), WAREHOUSE_SCOPE_DENIED: tr("warehouseDenied"),
      CAPABILITY_NOT_AVAILABLE: tr("capability"), RECEIVING_PURCHASE_ORDER_NOT_RECEIVABLE: tr("notReceivable"),
    };
    return byCode[error.code || ""] || `${tr("failed")} ${procurementErrorText(error, language, ["Try again in a moment.", "请稍后重试。"])}`;
  };

  async function save(submit: boolean) {
    setChecked(true);
    if (validation.count || !po) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const input: ReceiptInput = {
      warehouseId,
      arrivedAt: dateTimeInputToIso(arrivedAt, timezone),
      note: note.trim(),
      lines: po.lines.filter((line) => lines[line.id]?.include).map((line) => ({
        purchaseOrderLineId: line.id,
        acceptedQuantity: lines[line.id].accepted.trim(),
        rejectedQuantity: lines[line.id].rejected.trim() || "0",
        rejectionReason: lines[line.id].reason.trim(),
        location: lines[line.id].location.trim(),
      })),
    };
    setSaving(submit ? "submit" : "draft");
    try {
      const id = draft?.id || createdId;
      // A new receipt says which prefilled values were kept: codes only.
      const suggestionTrail = !id && prefill ? buildSuggestionTrail({
        origin: "form",
        prefills: {
          ...(prefill.warehouseId ? { warehouseId: prefill.warehouseId } : {}),
          ...(prefill.arrivedAt ? { arrivedAt: prefill.arrivedAt } : {}),
          ...Object.fromEntries(po.lines.map((line, index) => [line.id, index] as const).filter(([lineId]) => prefill.accepted[lineId] !== undefined).slice(0, 30)
            .map(([lineId, index]) => [`line${index + 1}.acceptedQuantity`, { source: "record" as const, ref: "purchase_order:remaining", value: prefill.accepted[lineId] }])),
        },
        values: {
          warehouseId, arrivedAt,
          ...Object.fromEntries(po.lines.map((line, index) => [`line${index + 1}.acceptedQuantity`, lines[line.id]?.include ? lines[line.id].accepted.trim() : ""])),
        },
      }) : null;
      const saved = id
        ? await receivingApi.revise(id, input, draft?.version ?? 0, createSecureClientMutationId("receipt-revise"))
        : await receivingApi.create(po.id, suggestionTrail ? { ...input, suggestionTrail } : input, createKey);
      setCreatedId(saved.entityId);
      setDraft({ ...(draft || { warehouse: null, arrivedAt: null }), ...saved.receivingDocument });
      if (submit) await receivingApi.submit(saved.entityId, saved.receivingDocument.version, createSecureClientMutationId("receipt-submit"));
      navigate(`/app/procurement/receiving/${encodeURIComponent(saved.entityId)}`);
    } catch (error) {
      setServerError(serverMessage(error));
      setServerErrorCode(procurementErrorCode(error));
    } finally {
      setSaving("");
    }
  }

  if (state === "loading") return <Card className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: A.sub }}><Loader2 className="animate-spin" size={16} />{tr("loading")}</Card>;
  if (state === "error" || !po) return (
    <Card className="py-16 text-center" data-testid="receiving-form-error">
      <div className="text-sm font-semibold">{tr("loadFailed")}</div>
      <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">{tr("retry")}</button>
    </Card>
  );

  // The lines table's inputs keep a fixed width each, so the text columns
  // (SKU, quantities) get the room and never wrap; on a card they take the
  // card's width.
  const cellInputClass = "rounded-lg border px-2 py-1.5 text-sm";
  // A message under a table input wraps instead of widening its column.
  const cellErrorClass = "max-w-40";
  // Each line's controls, drawn in the table or on a card. The names stay
  // "Accepted SKU" and so on, whichever is drawn.
  const lineViews = po.lines.map((line, index) => {
    const value = lines[line.id];
    const open = units(line.remainingQuantity) > 0n;
    const quantity = (text: string) => `${formatNumber(Number(text))}${line.unit ? ` ${unitLabel(line.unit, language, Number(text))}` : ""}`;
    const issue = shown.byLine[line.id] || {};
    const errorId = (field: keyof LineIssues) => `${idBase}-${field}-${index}`;
    const fieldId = (field: string) => `${idBase}-${field}-input-${index}`;
    const rejected = value?.rejected.trim() || "0";
    const rejectsSome = Boolean(value?.include) && QUANTITY.test(rejected) && units(rejected) > 0n;
    const error = (field: keyof LineIssues, className: string) => issue[field] ? <FieldError id={errorId(field)} className={className}>{tr(issue[field]!)}</FieldError> : null;
    return {
      line, index, quantity, fieldId,
      includeBox: (size: string) => <input type="checkbox" aria-label={`${tr("include")} ${line.sku}`} checked={Boolean(value?.include)} disabled={!open} onChange={(event) => update(line.id, { include: event.target.checked })} className={`${size} cursor-pointer`} />,
      acceptedInput: (width: string, errorClass = "") => <>
        <input id={fieldId("accepted")} aria-label={`${tr("accepted")} ${line.sku}`} aria-required={Boolean(value?.include)} {...invalidProps(errorId("accepted"), issue.accepted)} inputMode="decimal" value={value?.accepted || ""} disabled={!value?.include} onChange={(event) => update(line.id, { accepted: event.target.value })} className={`${cellInputClass} ${width}`} />
        {error("accepted", errorClass)}
      </>,
      rejectedInput: (width: string, errorClass = "") => <>
        <input id={fieldId("rejected")} aria-label={`${tr("rejected")} ${line.sku}`} {...invalidProps(errorId("rejected"), issue.rejected)} inputMode="decimal" value={value?.rejected || ""} disabled={!value?.include} onChange={(event) => update(line.id, { rejected: event.target.value })} className={`${cellInputClass} ${width}`} />
        {error("rejected", errorClass)}
      </>,
      reasonInput: (width: string, errorClass = "") => <>
        <input id={fieldId("reason")} aria-label={`${tr("rejectionReason")} ${line.sku}`} aria-required={rejectsSome} {...invalidProps(errorId("reason"), issue.reason)} value={value?.reason || ""} disabled={!value?.include} onChange={(event) => update(line.id, { reason: event.target.value })} className={`${cellInputClass} ${width}`} />
        {error("reason", errorClass)}
      </>,
      locationInput: (width: string) => <>
        <input id={fieldId("location")} aria-label={`${tr("location")} ${line.sku}`} list="receiving-locations" value={value?.location || ""} disabled={!value?.include} onChange={(event) => update(line.id, { location: event.target.value })} className={`${cellInputClass} ${width}`} />
        {value?.include && value.location.trim() ? (
          value.location.trim().toLowerCase() === stockedLocation(line, warehouseId).toLowerCase()
            ? <span data-testid="receiving-location-stocked" className="mt-1 block text-[11px]" style={{ color: A.blue }}>{tr("locationStocked")}</span>
            : !knownLocations.some((known) => known.toLowerCase() === value.location.trim().toLowerCase())
              ? <span data-testid="receiving-location-new" className="mt-1 block text-[11px]" style={{ color: A.sub }}>{tr("locationNew")}</span>
              : null
        ) : null}
      </>,
    };
  });
  // A card's field: its label above the control.
  const cardField = (id: string, label: ReactNode, control: ReactNode) => (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[13px] font-semibold leading-5" style={{ color: A.sub }}>{label}</label>
      {control}
    </div>
  );
  const fieldIssues = Object.keys(shown.header).length + Object.keys(shown.byLine).length > 0;
  const message = shown.form.length || fieldIssues || serverError ? (
    <>
      {shown.form.map((key) => <div key={key}>{tr(key)}</div>)}
      {fieldIssues && <div>{formCopy("checkFields")}</div>}
      {serverError && <div title={serverErrorCode}>{serverError}</div>}
    </>
  ) : null;
  return (
    <div ref={formRef} className="space-y-5" data-testid="receiving-form">
      <FocusFirstField />
      <FormHeader title={`${tr(mode === "new" ? "titleNew" : "titleEdit")}${draft?.documentNumber ? ` · ${draft.documentNumber}` : ""}`} intro={tr("intro")}>
        {/* The server numbers a new receipt (GRN-YYYYMM-NNNN) when it is saved. */}
        {mode === "new" && <div className="mt-1 text-xs" style={{ color: A.sub }} data-testid="receiving-number-on-save">{tr("numberOnSave")}</div>}
        <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt style={{ color: A.sub }}>{tr("purchaseOrder")}</dt><dd className="mt-1 font-medium"><DocumentNumber type="purchase_order" id={po.id} number={po.number} /></dd></div>
          <div><dt style={{ color: A.sub }}>{tr("supplier")}</dt><dd className="mt-1 font-medium">{po.supplierName || "—"}</dd></div>
        </dl>
        {!po.receivable && <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{tr("notReceivable")}</div>}
        {!warehouses.length && <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{tr("noWarehouse")}</div>}
      </FormHeader>

      <FormSection title={tr("details")}>
        <div className={formGridClass}>
          <Field label={tr("warehouse")} required error={shown.header.warehouse ? tr(shown.header.warehouse) : null}>
            <select aria-label={tr("warehouse")} value={warehouseId} onChange={(event) => changeWarehouse(event.target.value)} style={inputStyle}>
              <option value="">{tr("selectWarehouse")}</option>
              {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}
            </select>
            <PrefillSourceChip entry={prefill?.warehouseId} current={warehouseId} testId="receiving-prefill-warehouse" />
          </Field>
          <Field label={tr("arrivedAt")} required error={shown.header.arrival ? tr(shown.header.arrival) : null}>
            <input aria-label={tr("arrivedAt")} type="datetime-local" value={arrivedAt} onChange={(event) => setArrivedAt(event.target.value)} style={inputStyle} />
            <span className="block text-[11px]" style={{ color: A.sub }}>{tr("timezone")}: {timezone}</span>
            <PrefillSourceChip entry={prefill?.arrivedAt} current={arrivedAt} testId="receiving-prefill-arrival" />
          </Field>
          <div className="md:col-span-2">
            <Field label={tr("note")}>
              <textarea aria-label={tr("note")} value={note} onChange={(event) => setNote(event.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
            </Field>
          </div>
        </div>
      </FormSection>

      <FormSection title={tr("linesTitle")} description={tr("linesIntro")}>
        {phone ? (
          // A phone: one card per line. The item, then ordered / received /
          // open, then the Receive box, then Accepted and Rejected, then the
          // reason and the location, each with its label above it.
          <div className="space-y-3" data-testid="receiving-form-cards">
            {prefill ? <p data-testid="receiving-prefill-accepted" className="text-[12px] leading-[18px]" style={{ color: A.blue }}>{tr("acceptedHint")}</p> : null}
            {lineViews.map((view) => (
              <FormLineCard key={view.line.id} label={tr("lineLabel").replace("{n}", String(view.index + 1))} testId="receiving-form-line">
                <div className="text-sm font-semibold" style={{ color: A.label }}>{view.line.itemName}</div>
                <div className="font-mono text-xs" style={{ color: A.sub }}>{view.line.sku}</div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  {([["ordered", view.line.orderedQuantity], ["received", view.line.receivedQuantity], ["remaining", view.line.remainingQuantity]] as const).map(([key, amount]) => (
                    <div key={key}><dt style={{ color: A.sub }}>{tr(key)}</dt><dd className={`mt-0.5 tabular-nums${key === "remaining" ? " font-semibold" : ""}`} style={{ color: A.label }}>{view.quantity(amount)}</dd></div>
                  ))}
                </dl>
                <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium" style={{ color: A.label }}>
                  {view.includeBox("h-5 w-5")}
                  <span>{tr("include")}</span>
                </label>
                <div className="mt-2 space-y-3">
                  {cardField(view.fieldId("accepted"), <>{tr("accepted")} <RequiredMark /></>, view.acceptedInput("w-full"))}
                  {cardField(view.fieldId("rejected"), tr("rejected"), view.rejectedInput("w-full"))}
                  {cardField(view.fieldId("reason"), tr("rejectionReason"), view.reasonInput("w-full"))}
                  {cardField(view.fieldId("location"), tr("location"), view.locationInput("w-full"))}
                </div>
              </FormLineCard>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: A.border }}>
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="bg-gray-50 text-xs" style={{ color: A.sub }}>
                <tr>{["include", "sku", "item", "ordered", "received", "remaining", "accepted", "rejected", "rejectionReason", "location"].map((key) => <th key={key} className={`whitespace-nowrap px-3 py-2 font-medium${key === "accepted" ? " min-w-32" : key === "item" ? " min-w-28" : ""}`}>{tr(key)}{key === "accepted" ? <> <RequiredMark /></> : null}{key === "accepted" && prefill ? <span data-testid="receiving-prefill-accepted" className="block max-w-32 whitespace-normal text-[11px] font-normal" style={{ color: A.blue }}>{tr("acceptedHint")}</span> : null}</th>)}</tr>
              </thead>
              <tbody>
                {lineViews.map((view) => (
                  <tr key={view.line.id} className="border-t align-top" data-testid="receiving-form-line">
                    {/* The box sits in a 24 px target. */}
                    <td className="whitespace-nowrap px-2 py-1"><label className="inline-flex h-7 w-7 cursor-pointer items-center justify-center">{view.includeBox("h-4 w-4")}</label></td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{view.line.sku}</td>
                    <td className="px-3 py-2">{view.line.itemName}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{view.quantity(view.line.orderedQuantity)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{view.quantity(view.line.receivedQuantity)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums font-semibold">{view.quantity(view.line.remainingQuantity)}</td>
                    <td className="px-3 py-2">{view.acceptedInput("w-24", cellErrorClass)}</td>
                    <td className="px-3 py-2">{view.rejectedInput("w-24", cellErrorClass)}</td>
                    <td className="px-3 py-2">{view.reasonInput("w-40", cellErrorClass)}</td>
                    <td className="px-3 py-2">{view.locationInput("w-28")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <datalist id="receiving-locations">{knownLocations.map((location) => <option key={location} value={location} />)}</datalist>
      </FormSection>

      <FormActionBar
        onCancel={() => navigate(-1)}
        draft={{ label: tr("saveDraft"), onClick: () => { setServerError(""); void save(false); }, busy: saving === "draft", disabled: !po.receivable, testId: "receiving-form-save" }}
        submit={{ label: tr("saveSubmit"), onClick: () => { setServerError(""); void save(true); }, busy: saving === "submit", disabled: !po.receivable, testId: "receiving-form-submit" }}
        message={message}
        messageTestId="receiving-form-errors"
      />
    </div>
  );
}
