import { Suspense, lazy } from "react";
import { isUnavailableProductRoute } from "../../../../../shared/unavailable-product-routes.mjs";
import { A } from "../../../../components/ui";
import { chartHeight } from "./chartLayout";
import { cardStyle, usePartCopy, type Navigate } from "./partKit";
import type { ChartProps } from "./types";

const ChartCanvas = lazy(() => import("./ChartCanvas"));
const BASE_HEIGHT = 200;

// A chart in the report dashboards' look. "View in Reports" opens the report
// it summarises.
export function ChartPart({ props, language, onNavigate }: { props: ChartProps; language?: string; onNavigate?: Navigate }) {
  const copy = usePartCopy(language);
  // A money chart always names its one currency; without it nothing is drawn.
  if (props.unit === "money" && !props.currency) return null;
  const label = props.title || copy.t("ai.v2.chart");
  const HEIGHT = chartHeight(props, BASE_HEIGHT);
  const report = props.reportRoute && onNavigate && !isUnavailableProductRoute(props.reportRoute.moduleId) ? props.reportRoute : null;
  return (
    <figure data-testid="ai-v2-chart" lang={copy.language} className="space-y-2 rounded-xl p-3" style={cardStyle}>
      {props.title ? <figcaption className="text-[13px] font-semibold" style={{ color: A.label }}>{props.title}</figcaption> : null}
      <Suspense fallback={<div role="status" className="flex items-center justify-center text-[13px]" style={{ height: HEIGHT, color: A.sub }}>{copy.t("ai.v2.chartLoading")}</div>}>
        <ChartCanvas props={props} language={copy.language} label={label} height={HEIGHT} />
      </Suspense>
      {report ? <button type="button" data-testid="ai-v2-view-in-reports" onClick={() => onNavigate?.(report.moduleId, null, { returnTo: "ai", source: "ai", query: report.query })} className="text-[13px] font-medium hover:underline" style={{ color: A.blue }}>{copy.t("ai.v2.viewInReports")}</button> : null}
    </figure>
  );
}
