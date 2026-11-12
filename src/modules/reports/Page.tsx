import { BiDashboard } from "./BiDashboard";
import { ReportLibraryV2 } from "./ReportLibraryV2";
import { OpenPurchaseOrdersPage } from "./OpenPurchaseOrdersPage";
import { SupplierPerformanceTable } from "../srm/supplierPerformance";
import type { DashboardView } from "./governedReports";
import { Link, useSearchParams } from "react-router";
import { useI18n } from "../../i18n/I18n";
import { A } from "../../components/ui";

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown }) => void;
type ReportsPanelProps = { onNavigate?: NavigateFn; initialView?: DashboardView | "library" };
export const REPORT_DATA_SOURCE_LABEL = "API / 当前数据范围";

// Procurement analytics has two views: the procurement dashboard (the
// default: the tab opens the charts, as the other analytics tabs do; owner
// 11/11) and the open purchase orders report (?view=orders, or a link that
// carries one of its filters, such as "?status=open" or "?scope=overdue").
// They are sub-tabs, the one shown marked as the current page.
const SUB_TABS = [
  { id: "analytics", to: "/app/reports/procurement", label: ["Dashboard", "分析看板"] },
  { id: "orders", to: "/app/reports/procurement?view=orders", label: ["Open purchase orders", "未结采购订单"] },
] as const;
// The open purchase orders report's own URL filters: a link with any of them
// opens that report.
const ORDER_PARAMS = ["status", "scope", "overdue", "from", "to", "supplier", "currency", "search", "sort", "direction", "hiddenColumns"];

export default function ReportsPanel({ onNavigate, initialView = "overview" }: ReportsPanelProps) {
  const [params] = useSearchParams();
  const { language } = useI18n();
  const openOrders = initialView === "procurement" && !params.has("savedView") && params.get("view") !== "analytics"
    && (params.get("view") === "orders" || ORDER_PARAMS.some(name => params.has(name)));
  if (initialView === "library") return <ReportLibraryV2 />;
  const current = openOrders ? "orders" : "analytics";
  return <div className="space-y-4">
    {initialView === "procurement" && <nav aria-label={language === "zh-CN" ? "采购分析视图" : "Procurement analytics views"} className="flex gap-1 border-b" style={{ borderColor: A.border }} data-testid="procurement-report-tabs">
      {SUB_TABS.map(tab => {
        const active = tab.id === current;
        return <Link key={tab.id} to={tab.to} aria-current={active ? "page" : undefined} className="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition hover:text-blue-700" style={{ borderColor: active ? A.blue : "transparent", color: active ? A.blue : A.gray1 }}>{tab.label[language === "zh-CN" ? 1 : 0]}</Link>;
      })}
    </nav>}
    {openOrders ? <OpenPurchaseOrdersPage /> : <BiDashboard view={initialView} onNavigate={onNavigate} afterInsights={initialView === "suppliers" ? <SupplierPerformanceTable datesFromPage /> : null} />}
  </div>;
}
