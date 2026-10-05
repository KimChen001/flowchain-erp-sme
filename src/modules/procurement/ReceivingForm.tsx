import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";
import { dateTimeInputInTimeZone, dateTimeInputToIso } from "../../lib/format";
import { receivingApi, type ReceivablePurchaseOrder, type ReceiptInput, type ReceivingWarehouse } from "./receivingApi";
import { PrefillSourceChip } from "../../components/prefill/PrefillSource";
import { buildSuggestionTrail, type PrefillEntry } from "../../lib/prefill";

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  titleNew: ["Receive purchase order", "采购订单收货"],
  titleEdit: ["Edit receipt draft", "编辑收货草稿"],
  intro: ["Record what arrived. Accepted quantity goes to stock when the receipt is posted; rejected quantity stays out of stock.", "登记本次到货。收货单过账后，合格数量计入库存；拒收数量不入库。"],
  loading: ["Loading the purchase order…", "正在读取采购订单…"],
  loadFailed: ["The purchase order could not be loaded for receiving.", "无法读取可收货的采购订单。"],
  retry: ["Retry", "重试"],
  missingPo: ["Open this form from a purchase order.", "请从采购订单进入收货。"],
  notReceivable: ["This purchase order cannot be received in its current status.", "该采购订单当前状态不可收货。"],
  purchaseOrder: ["Purchase order", "采购订单"],
  supplier: ["Supplier", "供应商"],
  warehouse: ["Receiving warehouse", "收货仓库"],
  selectWarehouse: ["Select a warehouse", "选择仓库"],
  noWarehouse: ["You have no warehouse you can receive into. Ask an administrator for warehouse access.", "您没有可收货的仓库权限，请联系管理员。"],
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
  saveDraft: ["Save draft", "保存草稿"],
  saveSubmit: ["Save and submit for posting", "保存并提交过账"],
  saving: ["Saving…", "正在保存…"],
  cancel: ["Cancel", "取消"],
  lineRequired: ["Select at least one line to receive.", "请至少选择一行收货。"],
  acceptedPositive: ["Accepted quantity must be greater than zero.", "合格数量必须大于零。"],
  overReceipt: ["Accepted quantity is more than the open quantity on the purchase order.", "合格数量超过采购订单未收数量。"],
  invalidQuantity: ["Enter a number with up to four decimal places.", "请输入最多四位小数的数量。"],
  reasonRequired: ["Enter a reason for the rejected quantity.", "请填写拒收原因。"],
  warehouseRequired: ["Select the receiving warehouse.", "请选择收货仓库。"],
  arrivalRequired: ["Enter the arrival time.", "请填写到货时间。"],
  failed: ["The receipt could not be saved.", "收货单保存失败。"],
  versionConflict: ["The receipt changed since it was loaded. Reload and try again.", "收货单已被修改，请刷新后重试。"],
  permissionDenied: ["Your role cannot prepare receipts.", "您的角色无权准备收货单。"],
  warehouseDenied: ["You cannot receive into this warehouse.", "您无权在该仓库收货。"],
  capability: ["Receiving is not enabled for this workspace.", "当前工作区未启用收货过账。"],
  immutable: ["This receipt was already submitted or posted and can no longer be edited.", "该收货单已提交或过账，无法再编辑。"],
};

type Detail = {
  receivingDocument: { id: string; documentNumber: string; workflowStatus: string; postingStatus: string; version: number; arrivedAt?: string | null; warehouse?: { id?: string } | null };
  purchaseOrder: { id: string };
  lines: Array<{ poLineId: string; acceptedQuantity: string; rejectedQuantity: string; rejectionReason?: string | null; location?: string }>;
};
type LineState = { include: boolean; accepted: string; rejected: string; reason: string; location: string };

const QUANTITY = /^\d+(?:\.\d{1,4})?$/;
// Four-decimal quantities compared as integers of 1/10000, as the server does.
const units = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 10000n + BigInt((fraction + "0000").slice(0, 4));
};

export function ReceivingForm({ mode, purchaseOrderId = "", receiptId = "" }: { mode: "new" | "edit"; purchaseOrderId?: string; receiptId?: string }) {
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
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState("");
  const [saving, setSaving] = useState<"" | "draft" | "submit">("");
  // One key per form: a resend after a lost response replays the same receipt.
  const [createKey] = useState(() => createSecureClientMutationId("receipt"));
  // What a new receipt was prefilled with, and from where (docs/ai-prefill-autocomplete-design.md, J4).
  const [prefill, setPrefill] = useState<{ warehouseId?: PrefillEntry; arrivedAt?: PrefillEntry; accepted: Record<string, string> } | null>(null);
  const [createdId, setCreatedId] = useState("");

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

  const validation = useMemo(() => {
    const found: string[] = [];
    if (!po) return found;
    const chosen = po.lines.filter((line) => lines[line.id]?.include);
    if (!chosen.length) found.push("lineRequired");
    for (const line of chosen) {
      const value = lines[line.id];
      if (!QUANTITY.test(value.accepted.trim()) || !QUANTITY.test((value.rejected.trim() || "0"))) { found.push("invalidQuantity"); continue; }
      if (units(value.accepted.trim()) <= 0n) found.push("acceptedPositive");
      if (units(value.accepted.trim()) > units(line.remainingQuantity)) found.push("overReceipt");
      if (units(value.rejected.trim() || "0") > 0n && !value.reason.trim()) found.push("reasonRequired");
    }
    if (!warehouseId) found.push("warehouseRequired");
    if (!dateTimeInputToIso(arrivedAt, timezone)) found.push("arrivalRequired");
    return [...new Set(found)];
  }, [arrivedAt, lines, po, timezone, warehouseId]);

  const serverMessage = (error: unknown) => {
    if (!(error instanceof ApiError)) return tr("failed");
    const byCode: Record<string, string> = {
      RECEIVING_OVER_RECEIPT: tr("overReceipt"), RECEIVING_REJECTION_REASON_REQUIRED: tr("reasonRequired"),
      SYNC_VERSION_CONFLICT: tr("versionConflict"), RECEIVING_IMMUTABLE: tr("immutable"), RECEIVING_WORKFLOW_CONFLICT: tr("immutable"),
      AUTHORIZATION_PERMISSION_DENIED: tr("permissionDenied"), WAREHOUSE_SCOPE_DENIED: tr("warehouseDenied"),
      CAPABILITY_NOT_AVAILABLE: tr("capability"), RECEIVING_PURCHASE_ORDER_NOT_RECEIVABLE: tr("notReceivable"),
    };
    return byCode[error.code || ""] || `${tr("failed")} ${error.message}`;
  };

  async function save(submit: boolean) {
    setErrors(validation);
    if (validation.length || !po) return;
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
      setErrors([]);
      setServerError(serverMessage(error));
    } finally {
      setSaving("");
    }
  }

  if (state === "loading") return <Card className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: A.sub }}><Loader2 className="animate-spin" size={16} />{tr("loading")}</Card>;
  if (state === "error" || !po) return (
    <Card className="py-16 text-center" data-testid="receiving-form-error">
      <div className="text-sm font-semibold">{purchaseOrderId || mode === "edit" ? tr("loadFailed") : tr("missingPo")}</div>
      {(purchaseOrderId || mode === "edit") && <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">{tr("retry")}</button>}
    </Card>
  );

  const inputClass = "w-full rounded-lg border px-2 py-1.5 text-sm";
  return (
    <div className="space-y-4" data-testid="receiving-form">
      <Card className="p-4">
        <div className="text-sm font-semibold">{tr(mode === "new" ? "titleNew" : "titleEdit")}{draft?.documentNumber ? ` · ${draft.documentNumber}` : ""}</div>
        <div className="mt-1 text-xs" style={{ color: A.sub }}>{tr("intro")}</div>
        <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt style={{ color: A.sub }}>{tr("purchaseOrder")}</dt><dd className="mt-1 font-medium">{po.id}</dd></div>
          <div><dt style={{ color: A.sub }}>{tr("supplier")}</dt><dd className="mt-1 font-medium">{po.supplierName || "—"}</dd></div>
          <label className="block"><span style={{ color: A.sub }}>{tr("warehouse")} *</span>
            <select aria-label={tr("warehouse")} value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} className={`${inputClass} mt-1`}>
              <option value="">{tr("selectWarehouse")}</option>
              {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}
            </select>
            <PrefillSourceChip entry={prefill?.warehouseId} current={warehouseId} testId="receiving-prefill-warehouse" />
          </label>
          <label className="block"><span style={{ color: A.sub }}>{tr("arrivedAt")} *</span>
            <input aria-label={tr("arrivedAt")} type="datetime-local" value={arrivedAt} onChange={(event) => setArrivedAt(event.target.value)} className={`${inputClass} mt-1`} />
            <span className="mt-1 block text-[11px]" style={{ color: A.sub }}>{tr("timezone")}: {timezone}</span>
            <PrefillSourceChip entry={prefill?.arrivedAt} current={arrivedAt} testId="receiving-prefill-arrival" />
          </label>
        </dl>
        {!po.receivable && <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{tr("notReceivable")}</div>}
        {!warehouses.length && <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{tr("noWarehouse")}</div>}
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="bg-gray-50 text-xs" style={{ color: A.sub }}>
            <tr>{["include", "sku", "item", "ordered", "received", "remaining", "accepted", "rejected", "rejectionReason", "location"].map((key) => <th key={key} className="px-3 py-2 font-medium">{tr(key)}{key === "accepted" && prefill ? <span data-testid="receiving-prefill-accepted" className="block text-[11px] font-normal" style={{ color: A.blue }}>{tr("acceptedHint")}</span> : null}</th>)}</tr>
          </thead>
          <tbody>
            {po.lines.map((line) => {
              const value = lines[line.id];
              const open = units(line.remainingQuantity) > 0n;
              const quantity = (text: string) => `${formatNumber(Number(text))}${line.unit ? ` ${line.unit}` : ""}`;
              return (
                <tr key={line.id} className="border-t align-top" data-testid="receiving-form-line">
                  <td className="px-3 py-2"><input type="checkbox" aria-label={`${tr("include")} ${line.sku}`} checked={Boolean(value?.include)} disabled={!open} onChange={(event) => update(line.id, { include: event.target.checked })} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{line.sku}</td>
                  <td className="px-3 py-2">{line.itemName}</td>
                  <td className="px-3 py-2 tabular-nums">{quantity(line.orderedQuantity)}</td>
                  <td className="px-3 py-2 tabular-nums">{quantity(line.receivedQuantity)}</td>
                  <td className="px-3 py-2 tabular-nums font-semibold">{quantity(line.remainingQuantity)}</td>
                  <td className="px-3 py-2"><input aria-label={`${tr("accepted")} ${line.sku}`} inputMode="decimal" value={value?.accepted || ""} disabled={!value?.include} onChange={(event) => update(line.id, { accepted: event.target.value })} className={`${inputClass} w-24`} /></td>
                  <td className="px-3 py-2"><input aria-label={`${tr("rejected")} ${line.sku}`} inputMode="decimal" value={value?.rejected || ""} disabled={!value?.include} onChange={(event) => update(line.id, { rejected: event.target.value })} className={`${inputClass} w-24`} /></td>
                  <td className="px-3 py-2"><input aria-label={`${tr("rejectionReason")} ${line.sku}`} value={value?.reason || ""} disabled={!value?.include} onChange={(event) => update(line.id, { reason: event.target.value })} className={inputClass} /></td>
                  <td className="px-3 py-2"><input aria-label={`${tr("location")} ${line.sku}`} value={value?.location || ""} disabled={!value?.include} onChange={(event) => update(line.id, { location: event.target.value })} className={`${inputClass} w-28`} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card className="space-y-3 p-4">
        <label className="block text-xs"><span style={{ color: A.sub }}>{tr("note")}</span>
          <textarea aria-label={tr("note")} value={note} onChange={(event) => setNote(event.target.value)} rows={2} className={`${inputClass} mt-1`} />
        </label>
        {(errors.length > 0 || serverError) && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" data-testid="receiving-form-errors">
            {errors.map((key) => <div key={key}>{tr(key)}</div>)}
            {serverError && <div>{serverError}</div>}
          </div>
        )}
        {/* Left-aligned so the floating assistant button never covers them. */}
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="receiving-form-submit" disabled={Boolean(saving) || !po.receivable} onClick={() => { setServerError(""); void save(true); }} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving === "submit" ? tr("saving") : tr("saveSubmit")}</button>
          <button type="button" data-testid="receiving-form-save" disabled={Boolean(saving) || !po.receivable} onClick={() => { setServerError(""); void save(false); }} className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50">{saving === "draft" ? tr("saving") : tr("saveDraft")}</button>
          <button type="button" onClick={() => navigate(-1)} className="rounded-lg border px-3 py-2 text-xs font-semibold">{tr("cancel")}</button>
        </div>
      </Card>
    </div>
  );
}
