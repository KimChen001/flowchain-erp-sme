import PurchasingRequests from "../purchase-requests/Page";
import PurchasingOrdersPage from "../purchasing/Page";
import { useI18n } from "../../i18n/I18n";
import { ProcurementEmptyState } from "./ProcurementEmptyState";
import { ProcurementWorkbench } from "./ProcurementWorkbench";
import { ProcurementDocumentDetailPage } from "./ProcurementDocumentDetailPage";
import { OrderFulfillmentLinesPage } from "./OrderFulfillmentLinesPage";
import { useLocation, useSearchParams } from "react-router";
import { ReceivingListPage } from "./ReceivingListPage";
import { ReceivingForm } from "./ReceivingForm";
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
    en: ["Supplier returns are not handled here", "Supplier returns are requested under Inventory › Returns."],
    zh: ["此处不处理供应商退货", "供应商退货请在“库存管理 › 退货管理”中申请。"],
  },
  contracts: {
    en: ["Purchase contracts are not available yet", "This workspace has no contract records to show."],
    zh: ["采购合同能力尚未接入", "当前没有 PostgreSQL 合同 runtime repository，页面不会返回静态合同。"],
  },
};
const noDataView = { en: ["There is nothing to show in this view yet", ""] as [string, string], zh: ["当前视图暂无数据", ""] as [string, string] };

// /app/procurement/receiving/new?po=<id> and /app/procurement/receiving/<id>/edit.
function ReceivingFormRoute({ mode }: { mode: "new" | "edit" }) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const receiptId = mode === "edit" ? decodeURIComponent(pathname.match(/\/receiving\/([^/]+)\/edit$/)?.[1] || "") : "";
  return <ReceivingForm mode={mode} purchaseOrderId={params.get("po") || ""} receiptId={receiptId} />;
}

export default function ProcurementPanel({ intent = null, view = "workbench", focus = null, onNavigate, onActiveContextChange }: ProcurementPanelProps) {
  const { language } = useI18n();
  if (!view || view === "workbench" || view === "overview") return <ProcurementWorkbench onNavigate={onNavigate} />;
  if (view === "requests") return <PurchasingRequests intent={intent} focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "orders") return <PurchasingOrdersPage focus={focus} onNavigate={onNavigate} onActiveContextChange={onActiveContextChange} />;
  if (view === "rfq") return <RfqListPage />;
  if (view === "receiving") return <ReceivingListPage />;
  if (view === "receiving-new") return <ReceivingFormRoute mode="new" />;
  if (view === "receiving-edit") return <ReceivingFormRoute mode="edit" />;
  if (view === "order-lines") return <OrderFulfillmentLinesPage />;
  if (view === "invoices") return <SupplierInvoiceListPage />;
  if (view === "match") return <ThreeWayMatchListPage />;
  if (view === "invoice-detail") return <ProcurementDocumentDetailPage kind="invoice" documentId={focus?.entityId || ""} />;
  if (view === "match-detail") return <ProcurementDocumentDetailPage kind="threeWayMatch" documentId={focus?.entityId || ""} />;
  const [title, description] = (emptyViews[view] || noDataView)[language === "en-US" ? "en" : "zh"];
  return <ProcurementEmptyState title={title} description={description} />;
}
