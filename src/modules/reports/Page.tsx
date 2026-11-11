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

// Procurement analytics has two views: the open purchase orders report (the
// default, which links such as "?status=open" and "?scope=overdue" open) and
// the procurement dashboard (?view=analytics, or a saved view). They are
// sub-tabs, the one shown marked as the current page.
const SUB_TABS = [
  { id: "orders", to: "/app/reports/procurement", label: ["Open purchase orders", "未结采购订单"] },
  { id: "analytics", to: "/app/reports/procurement?view=analytics", label: ["Dashboard", "分析看板"] },
] as const;

export default function ReportsPanel({ onNavigate, initialView = "overview" }: ReportsPanelProps) {
  const [params] = useSearchParams();
  const { language } = useI18n();
  const openOrders = initialView === "procurement" && params.get("view") !== "analytics" && !params.has("savedView");
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
