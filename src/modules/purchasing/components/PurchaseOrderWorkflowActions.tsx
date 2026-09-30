import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useRouteAvailability } from "../../../app/routeAvailability";
import { apiJson } from "../../../lib/api-client";
import { useI18n } from "../../../i18n/I18n";

type WorkflowAction = "submit" | "approve" | "reject" | "issue" | "cancel";

// Mirrors the server's PO command table: the actions each status allows and
// the permission each needs. The server still checks both on every command.
const ACTIONS_BY_STATUS: Record<string, WorkflowAction[]> = {
  draft: ["submit", "cancel"],
  pending_approval: ["approve", "reject", "cancel"],
  approved: ["issue", "cancel"],
};
const PERMISSION: Record<WorkflowAction, (status: string) => string> = {
  submit: () => "procurement.purchase_order.revise",
  approve: () => "procurement.purchase_order.approve",
  reject: () => "procurement.purchase_order.reject",
  issue: () => "procurement.purchase_order.revise",
  cancel: (status) => (status === "draft" ? "procurement.purchase_order.revise" : "procurement.purchase_order.reject"),
};

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  submit: ["Submit for approval", "提交审批"],
  approve: ["Approve", "批准"],
  reject: ["Reject", "驳回"],
  issue: ["Mark as issued to supplier", "标记为已下达供应商"],
  cancel: ["Cancel PO", "取消采购订单"],
  rejectReason: ["Why is this purchase order rejected?", "请输入驳回原因"],
  cancelReason: ["Why is this purchase order cancelled?", "请输入取消原因"],
  done: ["Purchase order updated", "采购订单已更新"],
  failed: ["The purchase order could not be updated", "采购订单更新失败"],
  issueNote: ["Issuing records that you sent the PO to the supplier; FlowChain does not send it.", "下达仅记录已将采购订单发送给供应商；FlowChain 不会代为发送。"],
  receive: ["Receive", "收货"],
  receiveNote: ["Record goods that arrived against this PO.", "登记该采购订单的到货。"],
};

// The effective permission codes of the signed-in user; empty when they
// cannot be read, so no command is offered.
function usePermissionSet() {
  const [permissions, setPermissions] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    apiJson<{ effectivePermissions?: string[] }>("/api/authorization/context")
      .then((context) => { if (alive) setPermissions(new Set(context.effectivePermissions || [])); })
      .catch(() => { if (alive) setPermissions(new Set()); });
    return () => { alive = false; };
  }, []);
  return permissions;
}

export function PurchaseOrderWorkflowActions({
  poId,
  status,
  version,
  onChanged,
}: {
  poId: string;
  status: string;
  version?: number;
  onChanged: () => void;
}) {
  const { language } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const permissions = usePermissionSet();
  const [busy, setBusy] = useState<WorkflowAction | "">("");

  const actions = (ACTIONS_BY_STATUS[status] || []).filter((action) => permissions?.has(PERMISSION[action](status)));
  if (!Number.isInteger(version) || !actions.length) return null;

  const run = async (action: WorkflowAction) => {
    let reason = "";
    if (action === "reject" || action === "cancel") {
      reason = window.prompt(tr(action === "reject" ? "rejectReason" : "cancelReason"))?.trim() || "";
      if (!reason) return;
    }
    setBusy(action);
    try {
      await apiJson(`/api/procurement/orders/${encodeURIComponent(poId)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: version, reason }),
      });
      toast.success(tr("done"));
      onChanged();
    } catch (error) {
      toast.error(tr("failed"), { description: error instanceof Error ? error.message : undefined });
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
          className={action === "approve" || action === "submit" || action === "issue"
            ? "rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            : "rounded-lg border px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"}
        >
          {tr(action)}
        </button>
      ))}
      {actions.includes("issue") && <span className="text-[11px] text-slate-500">{tr("issueNote")}</span>}
    </div>
  );
}

// Receiving starts from an issued or partially received PO. The receipt form
// is gated by the receiving posting capability; the server checks
// receiving.prepare, warehouse scope and open quantities again.
const RECEIVE_STATUSES = new Set(["issued", "partially_received"]);

export function PurchaseOrderReceiveAction({ poId, status }: { poId: string; status: string }) {
  const { language } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  const navigate = useNavigate();
  if (!RECEIVE_STATUSES.has(status) || !permissions?.has("receiving.prepare") || !canOpenRoute("procurement:receiving:new")) return null;
  return (
    <div data-testid="po-receive-action" className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="po-action-receive"
        onClick={() => navigate(`/app/procurement/receiving/new?po=${encodeURIComponent(poId)}`)}
        className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white"
      >
        {tr("receive")}
      </button>
      <span className="text-[11px] text-slate-500">{tr("receiveNote")}</span>
    </div>
  );
}
