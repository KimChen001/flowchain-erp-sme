import PurchasingRequests from "../purchase-requests/Page";
import PurchasingOrdersPage from "../purchasing/Page";
import { useI18n } from "../../i18n/I18n";
import { ProcurementEmptyState } from "./ProcurementEmptyState";
import { ProcurementWorkbench } from "./ProcurementWorkbench";
import { ProcurementDocumentDetailPage } from "./ProcurementDocumentDetailPage";
import { OrderFulfillmentLinesPage } from "./OrderFulfillmentLinesPage";
import { ReceivingListPage } from "./ReceivingListPage";
import { RfqListPage } from "./RfqListPage";
import { SupplierInvoiceListPage } from "./SupplierInvoiceListPage";
import { ThreeWayMatchListPage } from "./ThreeWayMatchListPage";
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

// English source copy with its Chinese translation.
const emptyViews: Record<string, { en: [string, string]; zh: [string, string] }> = {
  returns: {
    en: ["Purchase returns are not available yet", "Purchase returns are not connected to this workspace yet."],
    zh: ["采购退货工作台尚未接入", "退货与隔离库存 repository 基础已存在，但采购 canonical route 尚未接通。"],
  },
  contracts: {
    en: ["Purchase contracts are not available yet", "This workspace has no contract records to show."],
    zh: ["采购合同能力尚未接入", "当前没有 PostgreSQL 合同 runtime repository，页面不会返回静态合同。"],
  },
};
const noDataView = { en: ["There is nothing to show in this view yet", ""] as [string, string], zh: ["当前视图暂无数据", ""] as [string, string] };

export default function ProcurementPanel({ intent = null, view = "workbench", focus = null, onNavigate, onActiveContextChange }: ProcurementPanelProps) {
  const { language } = useI18n();
  if (!view || view === "workbench" || view === "overview") return <ProcurementWorkbench onNavigate={onNavigate} />;
  if (view === "requests") return <PurchasingRequests intent={intent} focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "orders") return <PurchasingOrdersPage focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "rfq") return <RfqListPage />;
  if (view === "receiving") return <ReceivingListPage />;
  if (view === "order-lines") return <OrderFulfillmentLinesPage />;
  if (view === "invoices") return <SupplierInvoiceListPage />;
  if (view === "match") return <ThreeWayMatchListPage />;
  if (view === "invoice-detail") return <ProcurementDocumentDetailPage kind="invoice" documentId={focus?.entityId || ""} />;
  if (view === "match-detail") return <ProcurementDocumentDetailPage kind="threeWayMatch" documentId={focus?.entityId || ""} />;
  const [title, description] = (emptyViews[view] || noDataView)[language === "en-US" ? "en" : "zh"];
  return <ProcurementEmptyState title={title} description={description} />;
}
