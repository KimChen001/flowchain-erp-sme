// Apache ECharts, with only the charts and components the report dashboards
// use, rendered as SVG so labels stay crisp and readable as page text.
import * as echarts from "echarts/core";
import { BarChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, RadarChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import { AriaComponent, CalendarComponent, GraphicComponent, GridComponent, LegendComponent, MarkLineComponent, RadarComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { LabelLayout, UniversalTransition } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, RadarChart, SankeyChart, ScatterChart, TreemapChart,
  AriaComponent, CalendarComponent, GraphicComponent, GridComponent, LegendComponent, MarkLineComponent, RadarComponent, TitleComponent, TooltipComponent, VisualMapComponent,
  LabelLayout, UniversalTransition, SVGRenderer,
]);

export { echarts };
