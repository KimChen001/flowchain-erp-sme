import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useRouteAvailability } from "../../../app/routeAvailability";
import { ApiError, apiJson } from "../../../lib/api-client";
import { useI18n } from "../../../i18n/I18n";
import { usePermissionSet } from "../../../lib/usePermissionSet";
import { listButtonClass } from "../../../components/ui/listLayout";
import { useConfirm } from "../../../components/ui/ConfirmDialog";
import { typography } from "../../../components/ui/typography";
import { procurementErrorCode, procurementErrorText } from "../../procurement/procurementErrors";

// A secondary header button: the list button height, with a border so it
// shows on the page background beside the supplier invoice entry button.
export const poSecondaryButtonClass = `inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 ${typography.denseButton} text-slate-700 hover:bg-slate-50 disabled:opacity-50`;

type WorkflowAction = "submit" | "approve" | "reject" | "issue" | "cancel" | "close";

// Mirrors the server's PO command table: the actions each status allows and
// the permission each needs. The server still checks both on every command.
const ACTIONS_BY_STATUS: Record<string, WorkflowAction[]> = {
  draft: ["submit", "cancel"],
  pending_approval: ["approve", "reject", "cancel"],
  approved: ["issue", "cancel"],
  // Closing ends an order the supplier will not finish; received goods stay.
  issued: ["close"],
  partially_received: ["close"],
};
const PERMISSION: Record<WorkflowAction, (status: string) => string> = {
  submit: () => "procurement.purchase_order.revise",
  approve: () => "procurement.purchase_order.approve",
  reject: () => "procurement.purchase_order.reject",
  issue: () => "procurement.purchase_order.revise",
  cancel: (status) => (status === "draft" ? "procurement.purchase_order.revise" : "procurement.purchase_order.reject"),
  close: () => "procurement.purchase_order.reject",
};

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  submit: ["Submit for approval", "提交审批"],
  approve: ["Approve", "批准"],
  reject: ["Reject", "驳回"],
  // "Issued" / 已下达, the PO status this sets; the next action and note use the same words.
  issue: ["Mark as issued", "标记为已下达"],
  cancel: ["Cancel PO", "取消采购订单"],
  close: ["Close PO", "关闭采购订单"],
  closeTitle: ["Close this purchase order?", "关闭该采购订单？"],
  closeBody: ["The remaining quantity will not be received. Goods already received stay in stock.", "剩余数量将不再收货；已收货物仍保留在库存中。"],
  closeReason: ["Why is it closed?", "关闭原因"],
  rejectTitle: ["Reject this purchase order?", "驳回该采购订单？"],
  rejectBody: ["The order will not be approved.", "该订单将不会被批准。"],
  rejectReason: ["Why is it rejected?", "驳回原因"],
  cancelTitle: ["Cancel this purchase order?", "取消该采购订单？"],
  cancelBody: ["Nothing will be ordered or received on it.", "取消后不会再按此订单采购或收货。"],
  cancelReason: ["Why is it cancelled?", "取消原因"],
  goBack: ["Go back", "返回"],
  done: ["Purchase order updated", "采购订单已更新"],
  // What was done, with the order's number ({po}), in the words of the status it now has.
  doneSubmit: ["Submitted {po} for approval", "已提交审批 {po}"],
  doneApprove: ["Approved {po}", "已批准 {po}"],
  doneReject: ["Rejected {po}", "已驳回 {po}"],
  doneIssue: ["Issued {po}", "已下达 {po}"],
  doneCancel: ["Cancelled {po}", "已取消 {po}"],
  doneClose: ["Closed {po}", "已关闭 {po}"],
  failed: ["The purchase order could not be updated", "采购订单更新失败"],
  issueNote: ["Print or save the PO document and send it yourself, then mark it issued.", "请打印或另存采购订单文件并自行发送，然后标记为已下达。"],
  receive: ["Receive", "收货"],
  receiveNote: ["Record goods that arrived against this PO.", "登记该采购订单的到货。"],
  changed: ["This purchase order was changed elsewhere, so nothing was done. It has been reloaded; check it and try again.", "该采购订单已在别处被更改，本次操作未执行。页面已重新加载，请核对后重试。"],
  billNote: ["Supplier invoices are paid only after the three-way match.", "采购发票须在三单匹配后才能付款。"],
};

// The step that moves the order forward is the page's one primary button.
const PRIMARY_ACTIONS = new Set<WorkflowAction>(["submit", "approve", "issue"]);

// The server refuses a command sent with an older version or for a status the
// PO has left; both mean the page shows an order that changed elsewhere.
const STALE_CODES = new Set(["SYNC_VERSION_CONFLICT", "PURCHASE_ORDER_WORKFLOW_CONFLICT"]);


export function PurchaseOrderWorkflowActions({
  poId,
  number,
  status,
  version,
  onChanged,
  showNote = true,
}: {
  poId: string;
  // The number the order shows (PO-202611-0009), for the message after an action.
  number?: string;
  status: string;
  version?: number;
  onChanged: () => void;
  // Off when the page shows the action notes on a line of their own.
  showNote?: boolean;
}) {
  const { language } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const permissions = usePermissionSet();
  const [busy, setBusy] = useState<WorkflowAction | "">("");
  const confirmDialog = useConfirm();

  const actions = (ACTIONS_BY_STATUS[status] || []).filter((action) => permissions?.has(PERMISSION[action](status)));
  if (!Number.isInteger(version) || !actions.length) return null;

  const run = async (action: WorkflowAction) => {
    let reason = "";
    if (action === "reject" || action === "cancel" || action === "close") {
      const answer = await confirmDialog.prompt({
        title: tr(`${action}Title`),
        description: tr(`${action}Body`),
        field: { label: tr(`${action}Reason`) },
        confirmLabel: tr(action),
        cancelLabel: tr("goBack"),
        tone: "danger",
      });
      if (answer === null || !answer) return;
      reason = answer;
    }
    setBusy(action);
    try {
      await apiJson(`/api/procurement/orders/${encodeURIComponent(poId)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: version, reason }),
      });
      // "Issued PO-202611-0009"; the general message when the number is not known.
      const doneKey = `done${action[0].toUpperCase()}${action.slice(1)}`;
      toast.success(number && COPY[doneKey] ? tr(doneKey).replace("{po}", number) : tr("done"));
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && STALE_CODES.has(error.code || "")) {
        // Show the current order rather than leave buttons for a stale one.
        toast.error(tr("changed"));
        onChanged();
      } else {
        toast.error(tr("failed"), { description: <span title={procurementErrorCode(error)}>{procurementErrorText(error, language, ["Try again in a moment.", "请稍后重试。"])}</span> });
      }
    } finally {
      setBusy("");
    }
  };

  return (
    <div data-testid="po-workflow-actions" className="flex flex-wrap items-center gap-2">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          data-testid={`po-action-${action}`}
          disabled={Boolean(busy)}
          onClick={() => void run(action)}
          className={PRIMARY_ACTIONS.has(action) ? listButtonClass.primary : poSecondaryButtonClass}
        >
          {tr(action)}
        </button>
      ))}
      {showNote && actions.includes("issue") && <span className="text-[11px] text-slate-500">{tr("issueNote")}</span>}
      {confirmDialog.element}
    </div>
  );
}

// Receiving starts from an issued or partially received PO. The receipt form
// is gated by the receiving posting capability; the server checks
// receiving.prepare, warehouse scope and open quantities again.
const RECEIVE_STATUSES = new Set(["issued", "partially_received"]);
// Statuses in which a supplier invoice can be recorded: it can arrive before
// the goods (it then waits for the receipt) or after them.
export const BILLABLE_PO_STATUSES = new Set(["approved", "issued", "partially_received", "received", "fully_received", "closed"]);

export const receiveOrderPath = (poId: string) => `/app/procurement/receiving/new?po=${encodeURIComponent(poId)}`;
export const recordBillPath = (poId: string) => `/app/procurement/bills/new?po=${encodeURIComponent(poId)}`;

// Whether this user may receive against, or record a supplier invoice for, a
// PO in a given status: the rules of the detail page's Receive and Record
// supplier invoice buttons, for the PO list's row menu. The server checks
// both again.
export function usePurchaseOrderEntryRules() {
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  return {
    canReceive: (status: string) => RECEIVE_STATUSES.has(status) && Boolean(permissions?.has("receiving.prepare")) && canOpenRoute("procurement:receiving:new"),
    canRecordBill: (status: string) => BILLABLE_PO_STATUSES.has(status) && Boolean(permissions?.has("finance.supplier_invoice.create")) && canOpenRoute("procurement:bill-new"),
  };
}

export function PurchaseOrderReceiveAction({ poId, status, showNote = true }: { poId: string; status: string; showNote?: boolean }) {
  const { language } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const rules = usePurchaseOrderEntryRules();
  const navigate = useNavigate();
  if (!rules.canReceive(status)) return null;
  return (
    <div data-testid="po-receive-action" className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="po-action-receive"
        onClick={() => navigate(receiveOrderPath(poId))}
        className={listButtonClass.primary}
      >
        {tr("receive")}
      </button>
      {showNote && <span className="text-[11px] text-slate-500">{tr("receiveNote")}</span>}
    </div>
  );
}

// The notes for the actions the PO header shows, in the order of its buttons,
// for a page that shows them under the buttons instead of between them. Same
// conditions as the buttons; billable is whether a supplier invoice can be
// recorded for the order's status. nothingToInvoice: every line is already
// invoiced, so the page shows no supplier invoice entry and no note for it.
export function usePurchaseOrderActionNotes({ status, version, nothingToInvoice = false }: { status: string; version?: number; nothingToInvoice?: boolean }) {
  const { language } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const permissions = usePermissionSet();
  const rules = usePurchaseOrderEntryRules();
  const notes: string[] = [];
  if (rules.canReceive(status)) notes.push(tr("receiveNote"));
  if (Number.isInteger(version) && (ACTIONS_BY_STATUS[status] || []).includes("issue") && permissions?.has(PERMISSION.issue(status))) notes.push(tr("issueNote"));
  if (rules.canRecordBill(status) && !nothingToInvoice) notes.push(tr("billNote"));
  return notes;
}
