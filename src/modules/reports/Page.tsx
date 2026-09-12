import { BiDashboard } from "./BiDashboard";
import { ReportLibraryV2 } from "./ReportLibraryV2";
import { OpenPurchaseOrdersPage } from "./OpenPurchaseOrdersPage";
import type { DashboardView } from "./governedReports";
import { Link, useSearchParams } from "react-router";
import { useI18n } from "../../i18n/I18n";

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown }) => void;
type ReportsPanelProps = { onNavigate?: NavigateFn; initialView?: DashboardView | "library" };
export const REPORT_DATA_SOURCE_LABEL = "API / 当前数据范围";

export default function ReportsPanel({ onNavigate, initialView = "overview" }: ReportsPanelProps) {
  const [params] = useSearchParams();
  const { language } = useI18n();
  const openOrders = initialView === "procurement" && params.get("view") !== "analytics" && !params.has("savedView");
  if (initialView === "library") return <ReportLibraryV2 />;
  return <div className="space-y-4">
    {["overview", "procurement"].includes(initialView) && <nav aria-label={language === "en-US" ? "Purchase order reports" : "采购订单报表"} className="flex flex-wrap gap-4 text-sm">
      <Link className="font-semibold text-blue-600 hover:underline" to="/app/reports/procurement">{language === "en-US" ? "Open purchase orders" : "未完成采购订单"}</Link>
      <Link className="font-semibold text-blue-600 hover:underline" to="/app/reports/procurement?view=analytics">{language === "en-US" ? "Procurement analytics" : "采购分析"}</Link>
    </nav>}
    {openOrders ? <OpenPurchaseOrdersPage /> : <BiDashboard view={initialView} onNavigate={onNavigate} />}
  </div>;
}
