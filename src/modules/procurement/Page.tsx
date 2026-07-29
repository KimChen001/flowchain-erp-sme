import PurchasingRequests from "../purchase-requests/Page";
import PurchasingOrdersPage from "../purchasing/Page";
import { ProcurementEmptyState } from "./ProcurementEmptyState";
import { ProcurementWorkbench } from "./ProcurementWorkbench";
import { ReceivingListPage } from "./ReceivingListPage";
import { RfqListPage } from "./RfqListPage";
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
  invoices: ["供应商发票列表尚未接入", "可从采购订单详情查看已关联发票事实；canonical 发票列表仍需后续接通。"],
  match: ["三单匹配列表尚未接入", "当前真实 PO、GRN 与 Invoice 比对请从采购订单详情查看；此路由不再显示虚假的无记录结论。"],
  returns: ["采购退货工作台尚未接入", "退货与隔离库存 repository 基础已存在，但采购 canonical route 尚未接通。"],
  contracts: ["采购合同能力尚未接入", "当前没有 PostgreSQL 合同 runtime repository，页面不会返回静态合同。"],
};

export default function ProcurementPanel({ intent = null, view = "workbench", focus = null, onNavigate, onActiveContextChange }: ProcurementPanelProps) {
  if (!view || view === "workbench" || view === "overview") return <ProcurementWorkbench onNavigate={onNavigate} />;
  if (view === "requests") return <PurchasingRequests intent={intent} focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "orders") return <PurchasingOrdersPage focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "rfq") return <RfqListPage />;
  if (view === "receiving") return <ReceivingListPage />;
  const [title, description] = emptyViews[view] || ["当前视图暂无数据", ""];
  return <ProcurementEmptyState title={title} description={description} />;
}
