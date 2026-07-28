import PurchasingRequests from "../purchase-requests/Page";
import PurchasingOrdersPage from "../purchasing/Page";
import { ProcurementEmptyState } from "./ProcurementEmptyState";
import { ProcurementWorkbench } from "./ProcurementWorkbench";
import type { ProcurementFocus, ProcurementNavigate } from "./procurementTypes";
import type { PurchaseIntent } from "../../types/scm";
import type { ActiveContext } from "../ai-assistant/Panel";

type ProcurementPanelProps = {
  intent?: PurchaseIntent | null;
  view?: string;
  focus?: ProcurementFocus;
  onNavigate?: ProcurementNavigate;
  onActiveContextChange?: (context: ActiveContext | null) => void;
  onOpenRfq?: () => void;
};

const emptyViews: Record<string, [string, string]> = {
  rfq: ["暂无询价单", "采购申请需要询价时，记录将显示在这里。"],
  receiving: ["暂无采购收货记录", "采购订单收货后，记录将显示在这里。"],
  invoices: ["暂无供应商发票", "供应商发票录入后，记录将显示在这里。"],
  match: ["暂无匹配记录", "收货与发票数据完整后可进行三单匹配。"],
  returns: ["暂无采购退货记录", "采购退货发生后，记录将显示在这里。"],
  contracts: ["暂无采购合同", "当前未接通合同 runtime repository。"],
};

export default function ProcurementPanel({ intent = null, view = "workbench", focus = null, onNavigate, onActiveContextChange }: ProcurementPanelProps) {
  if (!view || view === "workbench" || view === "overview") return <ProcurementWorkbench onNavigate={onNavigate} />;
  if (view === "requests") return <PurchasingRequests intent={intent} focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "orders") return <PurchasingOrdersPage focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  const [title, description] = emptyViews[view] || ["当前视图暂无数据", ""];
  return <ProcurementEmptyState title={title} description={description} />;
}
