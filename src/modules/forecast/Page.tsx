import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Area, ComposedChart, Line, LineChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { AlertTriangle, CheckCircle2, FileCheck2, FileSpreadsheet, GitBranch, Loader2, ShoppingCart, Sparkles } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { exportRowsToCsv } from "../../lib/data-export";
import { fmt } from "../../lib/format";
import { A, AppleTooltip, Card, Chip, Field, inputStyle, SectionHeader } from "../../components/ui";
import { tableBodyTextClass, tdClass, tdNumericClass, tdWideClass, tdWideNumericClass, thClass, thWideClass } from "../../components/ui/workbenchTable";
import { FORECAST_SKUS, supplierData } from "../../data/empty-business-state";
import { METHOD_LABEL, applyForecastScenario, demandDiagnostics, formatDemandSeries, formatEta, mapeGrade, parseDemandSeries, runForecast, type Method } from "../../domain/forecast";
import { forecastProcurementProfileForSku } from "../../domain/forecast/purchase-request";
import { buildMrpBomEvidence, buildMrpBomSourceSummary, buildMrpScheduleEvidence, selectMrpRow, type MrpPlan } from "../../domain/mrp";
import { typography } from "../../components/ui/typography";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";

type PlanningViewId = "cockpit" | "demand" | "mrp" | "replenishment" | "parameters";

export const planningWorkbenchViews: Array<{ id: PlanningViewId; routeId: string; label: string; purpose: string }> = [
  { id: "cockpit", routeId: "forecast:cockpit", label: "计划驾驶舱", purpose: "计划优先级驾驶舱" },
  { id: "demand", routeId: "forecast:demand", label: "需求预测", purpose: "需求预测质量" },
  { id: "mrp", routeId: "forecast:mrp", label: "MRP 计划", purpose: "物料需求计划" },
  { id: "replenishment", routeId: "forecast:replenishment", label: "补货工作台", purpose: "补货草稿复核" },
  { id: "parameters", routeId: "forecast:parameters", label: "计划参数", purpose: "只读计划参数" },
];

function normalizePlanningView(view?: string): PlanningViewId {
  if (view === "demand" || view === "mrp" || view === "replenishment" || view === "parameters") return view;
  return "cockpit";
}

const MONTHS_24 = Array.from({ length: 24 }, (_, index) => {
  const totalIdx = 2026 * 12 + 4 - (23 - index);
  return `${String(Math.floor(totalIdx / 12)).slice(-2)}/${(totalIdx % 12) + 1}月`;
});

const FUTURE_LABEL = (index: number) => {
  const totalIdx = 2026 * 12 + 5 + index;
  return `${String(Math.floor(totalIdx / 12)).slice(-2)}/${(totalIdx % 12) + 1}月`;
};

type SavedForecastPlan = {
  id: string;
  sku: string;
  name: string;
  unit?: string;
  method: Method;
  metrics: { mape?: number; rmse?: number };
  procurementSuggestion?: { supplier?: string; quantity?: number; amount?: number } | null;
};

function supplierRecommendation(name: string) {
  const supplier = supplierData.find((item) => item.name === name);
  if (!supplier) return { score: 68, grade: "待评估", note: "缺少完整供应商绩效，建议人工复核。", color: A.orange };
  const gradeScore = supplier.grade === "S" ? 100 : supplier.grade === "A" ? 88 : supplier.grade === "B" ? 72 : 60;
  const trendScore = supplier.trend === "up" ? 5 : supplier.trend === "down" ? -8 : 0;
  const score = Math.round(supplier.ontime * 0.38 + supplier.quality * 0.42 + gradeScore * 0.16 + trendScore);
  const color = score >= 92 ? A.green : score >= 84 ? A.blue : score >= 74 ? A.orange : A.red;
  const grade = score >= 92 ? "优先推荐" : score >= 84 ? "可推荐" : score >= 74 ? "需复核" : "高风险";
  return { score, grade, color, note: `准时率 ${supplier.ontime}% · 质量 ${supplier.quality}% · ${supplier.grade} 级供应商` };
}

function StatusPill({ status }: { status: string }) {
  const color = status === "不足" || status === "加急" ? A.red : status === "预警" || status === "推迟/取消" ? A.orange : status === "释放" ? A.blue : A.green;
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ color, background: `${color}16` }}>{status}</span>;
}

function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    toast.warning("暂无可导出的数据");
    return;
  }
  exportRowsToCsv(filename, rows);
  toast.success("导出文件已生成");
}

export default function ForecastPanel({ initialView, onNavigate, onReviewActionDraft }: { initialView?: string; onNavigate?: (target: string) => void; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void }) {
  const activePlanningView = normalizePlanningView(initialView);
  const [skuIdx, setSkuIdx] = useState(0);
  const baseSku = FORECAST_SKUS[skuIdx];
  const [historyText, setHistoryText] = useState(() => formatDemandSeries(baseSku.history));
  const [useCustomHistory, setUseCustomHistory] = useState(false);
  const [savedPlans, setSavedPlans] = useState<SavedForecastPlan[]>([]);
  const [mrpPlan, setMrpPlan] = useState<MrpPlan | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [generatingRequest, setGeneratingRequest] = useState(false);
  const [lastGeneratedRequest, setLastGeneratedRequest] = useState("");
  const [method, setMethod] = useState<Method>("hw");
  const [horizon, setHorizon] = useState(6);
  const [scenario, setScenario] = useState<"base" | "opt" | "pess">("base");
  const [promoLift, setPromoLift] = useState(0);
  const [serviceLevel, setServiceLevel] = useState<50 | 80 | 85 | 90 | 95 | 97 | 98 | 99 | 99.5>(95);
  const [leadTimeDays, setLeadTimeDays] = useState(14);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [committed, setCommitted] = useState(false);

  const parsedHistory = useMemo(() => parseDemandSeries(historyText), [historyText]);
  const effectiveHistory = useCustomHistory && parsedHistory.length >= 6 ? parsedHistory.slice(-36) : baseSku.history;
  const sku = useMemo(() => ({ ...baseSku, history: effectiveHistory }), [baseSku, effectiveHistory]);
  const diag = useMemo(() => demandDiagnostics(sku.history), [sku.history]);

  useEffect(() => {
    setHistoryText(formatDemandSeries(baseSku.history));
    setUseCustomHistory(false);
  }, [baseSku]);

  useEffect(() => {
    apiJson<SavedForecastPlan[]>("/api/forecast-plans").then(setSavedPlans).catch(() => setSavedPlans([]));
  }, [committed]);

  useEffect(() => {
    let alive = true;
    apiJson<MrpPlan>("/api/mrp-plan?periods=6").then((data) => { if (alive) setMrpPlan(data); }).catch(() => setMrpPlan(null));
    return () => { alive = false; };
  }, [committed]);

  const result = useMemo(() => runForecast(sku.history, method, { alpha: 0.4, beta: 0.15, gamma: 0.25, season: 12 }, horizon), [sku, method, horizon]);
  const benchmark = useMemo(() => (["naive", "sma", "ses", "holt", "hw"] as Method[]).map((m) => {
    const r = runForecast(sku.history, m, { alpha: 0.4, beta: 0.15, gamma: 0.25, season: 12 }, horizon);
    return { method: m, mape: r.mape, rmse: r.rmse };
  }).sort((a, b) => a.mape - b.mape), [sku, horizon]);
  const adjustedForecast = useMemo(() => applyForecastScenario(result.forecast, scenario, promoLift), [result.forecast, scenario, promoLift]);
  const historyData = useMemo(() => sku.history.map((actual, index) => ({ month: MONTHS_24[index], actual, fitted: result.fitted[index] ?? null })), [sku, result]);
  const forecastChart = useMemo(() => adjustedForecast.map((forecast, index) => {
    const lower = Math.max(0, forecast - 1.96 * result.rmse);
    const upper = forecast + 1.96 * result.rmse;
    return { month: FUTURE_LABEL(index), forecast, lower, upper, bandHeight: upper - lower };
  }), [result, adjustedForecast]);
  const yDomain = useMemo(() => {
    const values = [...historyData.flatMap((d) => [d.actual, d.fitted ?? d.actual]), ...forecastChart.flatMap((d) => [d.lower, d.upper])];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return [Math.max(0, Math.floor((lo - (hi - lo) * 0.1) / 10) * 10), Math.ceil((hi + (hi - lo) * 0.1) / 10) * 10];
  }, [historyData, forecastChart]);
  const reconciliation = useMemo(() => {
    let inv = sku.onHand;
    return adjustedForecast.map((demand, index) => {
      const inbound = index === 0 ? sku.open : 0;
      inv = inv + inbound - demand;
      const gap = inv < 0 ? -inv : 0;
      const cover = demand > 0 ? (inv + demand) / demand : 0;
      return { month: FUTURE_LABEL(index), demand: Math.round(demand), inbound, ending: Math.round(inv), gap: Math.round(gap), cover, risk: inv < 0 ? "高" : cover < 1.2 ? "中" : "低" };
    });
  }, [sku, adjustedForecast]);

  const peakGap = Math.max(0, ...reconciliation.map((r) => r.gap));
  const firstStockoutIndex = reconciliation.findIndex((r) => r.risk === "高");
  const stockoutMonths = reconciliation.filter((r) => r.risk === "高").length;
  const procurementProfile = forecastProcurementProfileForSku(sku.sku, []);
  const currentMrpRow = selectMrpRow(mrpPlan, sku.sku);
  const safetyFactor = serviceLevel >= 98 ? 1.18 : serviceLevel >= 95 ? 1.1 : 1.05;
  const recommendedQty = peakGap > 0 ? Math.ceil(peakGap * safetyFactor) : 0;
  const recommendedAmount = recommendedQty * procurementProfile.unitPrice;
  const purchasePriority = firstStockoutIndex >= 0 && firstStockoutIndex <= 1 ? "高" : stockoutMonths > 0 ? "中" : "低";
  const executableRecommendedQty = Number(currentMrpRow?.totalPlannedReceipt || 0) > 0 ? Number(currentMrpRow?.totalPlannedReceipt || 0) : recommendedQty;
  const executableRecommendedAmount = executableRecommendedQty * procurementProfile.unitPrice;
  const executablePriority = currentMrpRow?.exception === "加急" ? "高" : purchasePriority;
  const fallbackSafetyStock = Math.max(0, Math.round(sku.onHand * 0.35));
  const mrpBomSourceSummary = buildMrpBomSourceSummary(currentMrpRow, sku.unit);
  const mrpScheduleEvidence = buildMrpScheduleEvidence(currentMrpRow);
  const mrpBomEvidence = buildMrpBomEvidence(currentMrpRow);
  const supplierScore = supplierRecommendation(procurementProfile.supplier);
  const backendMrpExceptions = (mrpPlan?.exceptions || []).filter((item) => item.sku === sku.sku).slice(0, 2).map((item) => ({
    type: `MRP ${item.type}`,
    title: `${item.period} ${item.name} 计划例外`,
    body: item.action,
    metric: `${Number(item.quantity || 0).toLocaleString()} ${sku.unit}`,
    color: item.type === "加急" ? A.red : item.type === "释放" ? A.blue : A.orange,
  }));
  const mrpExceptions = [
    ...backendMrpExceptions,
    ...(firstStockoutIndex >= 0 ? [{ type: "加急释放", title: `${reconciliation[firstStockoutIndex]?.month} 出现首个净缺口`, body: "预计期末库存转负，需先打开草稿审阅并复核供应商交期。", metric: `${recommendedQty.toLocaleString()} ${sku.unit}`, color: A.red }] : []),
    ...(Math.abs(result.trackingSignal) > 4 ? [{ type: "预测偏差", title: `Tracking Signal ${result.trackingSignal.toFixed(1)}`, body: "模型存在系统性偏差，释放采购前建议复核需求来源。", metric: `MAPE ${result.mape.toFixed(1)}%`, color: A.orange }] : []),
  ].slice(0, 4);

  useEffect(() => { setLastGeneratedRequest(""); }, [sku.sku, method, horizon, scenario, promoLift, serviceLevel, leadTimeDays, peakGap]);

  function runEngine() {
    setRunning(true);
    setProgress(0);
    let p = 0;
    const step = () => {
      p += 24;
      if (p >= 100) {
        setProgress(100);
        setRunning(false);
        toast.success(`${METHOD_LABEL[method]} 已收敛`, { description: `MAPE ${result.mape.toFixed(1)}% · RMSE ${result.rmse.toFixed(0)}` });
      } else {
        setProgress(p);
        setTimeout(step, 90);
      }
    };
    setTimeout(step, 60);
  }

  function forecastDraftRequest(): ActionDraftPreviewRequest {
    const reason = currentMrpRow ? `MRP 净需求计划建议入库 ${executableRecommendedQty.toLocaleString()} ${sku.unit}，例外 ${currentMrpRow.exception}` : `预测净缺口 ${peakGap.toLocaleString()} ${sku.unit}，服务水平 ${serviceLevel}%`;
    return {
      type: "purchase_request_draft",
      title: `${sku.sku} 预测采购申请草稿预览`,
      source: currentMrpRow ? "mrp-assisted-forecast" : "forecast",
      originEvidence: [
        { type: "forecast_plan", id: sku.sku, label: `${sku.sku} ${sku.name}`, status: `${METHOD_LABEL[method]} · MAPE ${result.mape.toFixed(1)}%`, summary: `峰值净缺口 ${peakGap.toLocaleString()} ${sku.unit}，建议 ${executableRecommendedQty.toLocaleString()} ${sku.unit}。` },
        ...(currentMrpRow ? [{ type: "mrp_plan", id: currentMrpRow.sku, label: `${currentMrpRow.sku} MRP 净需求计划`, status: currentMrpRow.exception, summary: `计划入库 ${currentMrpRow.totalPlannedReceipt.toLocaleString()} ${currentMrpRow.unit}，最大净需求 ${currentMrpRow.maxNetRequirement.toLocaleString()}。` }] : []),
        ...(mrpBomSourceSummary ? [{ type: "bom_source", id: currentMrpRow?.sku || sku.sku, label: "BOM 来源证据", summary: mrpBomSourceSummary }] : []),
        { type: "supplier_master", id: procurementProfile.supplier, label: procurementProfile.supplier, status: supplierScore.grade, summary: supplierScore.note },
      ],
      payload: { itemIdOrSku: sku.sku, itemName: sku.name, quantity: executableRecommendedQty, unit: sku.unit, requestedDeliveryDate: formatEta(leadTimeDays), reason, supplierIdOrName: procurementProfile.supplier, supplierSuggestion: { supplierName: procurementProfile.supplier }, severity: executablePriority, forecastBasis: { method, mape: result.mape, peakGap, stockoutMonths }, mrpEvidence: currentMrpRow ? { sku: currentMrpRow.sku, exception: currentMrpRow.exception, totalPlannedReceipt: currentMrpRow.totalPlannedReceipt, bomSourceSummary: mrpBomSourceSummary, schedule: mrpScheduleEvidence, bom: mrpBomEvidence } : undefined },
    };
  }

  function mrpReleaseDraftRequest(): ActionDraftPreviewRequest | null {
    if (!currentMrpRow || currentMrpRow.totalPlannedReceipt <= 0) return null;
    const request = forecastDraftRequest();
    return { ...request, title: `${currentMrpRow.sku} MRP 计划释放 PR 草稿预览`, source: "mrp_plan_release_preview", payload: { ...request.payload, quantity: currentMrpRow.totalPlannedReceipt, reason: `MRP 计划订单释放：${currentMrpRow.exception}，计划入库 ${currentMrpRow.totalPlannedReceipt.toLocaleString()} ${currentMrpRow.unit}。` } };
  }

  function openDraftPreview(request: ActionDraftPreviewRequest | null) {
    if (!request) {
      toast("当前没有可释放的 MRP 计划", { description: "净需求计划未产生计划订单释放。" });
      return;
    }
    if (!onReviewActionDraft) {
      toast.error("草稿预览暂不可用", { description: "Planning 仍保持 preview-only，不会创建采购申请。" });
      return;
    }
    setGeneratingRequest(true);
    onReviewActionDraft(request);
    const draftId = `DRAFT-MRP-${sku.sku}-${Date.now().toString().slice(-6)}`;
    setLastGeneratedRequest(draftId);
    setGeneratingRequest(false);
    toast.success("已打开 PR 草稿预览", { description: "未创建采购申请业务记录。" });
  }

  function createRequestFromForecast() { openDraftPreview(forecastDraftRequest()); }
  function releaseMrpAsPr() { openDraftPreview(mrpReleaseDraftRequest()); }

  async function saveForecastPlan() {
    setSavingPlan(true);
    try {
      const plan = await apiJson<SavedForecastPlan>("/api/forecast-plans", {
        method: "POST",
        body: JSON.stringify({ sku: sku.sku, name: sku.name, unit: sku.unit, method, horizon, metrics: { mape: Number(result.mape.toFixed(2)), rmse: Number(result.rmse.toFixed(2)) }, procurementSuggestion: { supplier: procurementProfile.supplier, quantity: recommendedQty, amount: recommendedAmount } }),
      });
      setSavedPlans((prev) => [plan, ...prev].slice(0, 8));
      setCommitted(true);
      toast.success("预测方案已保存", { description: `${plan.id} · ${sku.sku}` });
    } catch {
      toast.error("保存失败，请检查 API 服务");
    } finally {
      setSavingPlan(false);
    }
  }

  function exportForecastResultCsv() { exportCsv("forecast-result-export.csv", [...historyData.map((row) => ({ 月份: row.month, 实际需求: row.actual, 拟合: row.fitted })), ...forecastChart.map((row) => ({ 月份: row.month, 预测: Math.round(row.forecast), 下限: Math.round(row.lower), 上限: Math.round(row.upper) }))]); }
  function exportReconciliationCsv() { exportCsv("forecast-reconciliation-export.csv", reconciliation.map((row) => ({ 月份: row.month, 预测需求: row.demand, 计划入库: row.inbound, 期末库存: row.ending, 缺口: row.gap, 覆盖月数: row.cover.toFixed(1), 风险: row.risk }))); }
  function exportBenchmarkCsv() { exportCsv("forecast-benchmark-export.csv", benchmark.map((row, index) => ({ 排名: index + 1, 方法: METHOD_LABEL[row.method], MAPE: row.mape, RMSE: row.rmse }))); }
  function exportSavedPlansCsv() { exportCsv("forecast-saved-plans-export.csv", savedPlans.map((plan) => ({ ID: plan.id, SKU: plan.sku, 方法: METHOD_LABEL[plan.method], MAPE: plan.metrics?.mape, 建议供应商: plan.procurementSuggestion?.supplier, 建议数量: plan.procurementSuggestion?.quantity }))); }
  function exportMrpExceptionsCsv() { exportCsv("mrp-exceptions-export.csv", (mrpPlan?.exceptions || []).map((exception) => ({ SKU: exception.sku, 物料: exception.name, 期间: exception.period, 异常类型: exception.type, 数量: exception.quantity, 建议动作: exception.action }))); }
  function exportMrpPlannedOrdersCsv() { exportCsv("mrp-planned-orders-export.csv", currentMrpRow?.schedule.map((line) => ({ SKU: currentMrpRow.sku, 品名: currentMrpRow.name, 期间: line.period, 需求: line.grossRequirement, 计划收货: line.scheduledReceipt, 计划释放: line.plannedRelease, 预计库存: line.projectedAvailable, 净需求: line.netRequirement, 异常: line.exception, BOM来源摘要: line.dependentDemandSources?.length ? line.dependentDemandSources.map((source) => `${source.parentName || source.parent}:${source.demand}`).join(" | ") : mrpBomSourceSummary })) || []); }

  const viewMeta = planningWorkbenchViews.find((view) => view.id === activePlanningView) || planningWorkbenchViews[0];
  const totalForecastDemand = reconciliation.reduce((sum, row) => sum + row.demand, 0);
  const planningKpis = [
    { label: "MRP 例外", value: mrpExceptions.length ? `${mrpExceptions.length}` : "0", sub: currentMrpRow?.exception || "正常", color: mrpExceptions.length ? A.orange : A.green },
    { label: "缺货风险", value: `${stockoutMonths}`, sub: "未来月份", color: stockoutMonths ? A.red : A.green },
    { label: "预测误差", value: `${result.mape.toFixed(1)}%`, sub: `RMSE ${result.rmse.toFixed(0)}`, color: result.mape > 20 ? A.orange : A.green },
    { label: "草稿建议", value: executableRecommendedQty > 0 ? `${executableRecommendedQty.toLocaleString()}` : "0", sub: sku.unit, color: executableRecommendedQty > 0 ? A.blue : A.gray1 },
  ];

  const ViewShell = ({ children }: { children: ReactNode }) => (
    <div className="space-y-5" data-planning-view={activePlanningView} data-route-id={`forecast:${activePlanningView}`}>
      <div>
        <div className={typography.pageTitle} style={{ color: A.label }}>{viewMeta.label}</div>
        <p className={typography.body} style={{ color: A.sub }}>{viewMeta.purpose}</p>
      </div>
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#f0f6ff", color: A.blue }}><FileCheck2 size={17} /></div>
          <div className="min-w-0">
            <div className={typography.subsectionTitle} style={{ color: A.label }}>计划使用边界</div>
            <p className={`${typography.compactMetadata} mt-1 max-w-5xl`} style={{ color: A.sub }}>
              当前物料需求计划基于工作区内的商品、库存、采购、销售需求与供应商记录，以及当前配置和 BOM 展开生成只读计划证据；计划入库和计划释放仅用于人工审阅采购建议。系统只会生成采购申请草稿，需人工复核后才能继续处理，不会自动创建采购订单。
            </p>
          </div>
        </div>
      </Card>
      <Card className="p-3">
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="fc-caption font-semibold uppercase tracking-widest px-2 shrink-0" style={{ color: A.gray2 }}>SKU</span>
          {FORECAST_SKUS.map((item, index) => (
            <button key={item.sku} onClick={() => { setSkuIdx(index); setCommitted(false); }}
              className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-all"
              style={skuIdx === index ? { background: "#f0f6ff", color: A.blue, boxShadow: `0 0 0 1px ${A.blue}30` } : { background: "transparent", color: A.gray1 }}>
              <span style={{ color: skuIdx === index ? A.blue : A.gray2 }}>{item.sku}</span><span className="ml-2">{item.name}</span>
            </button>
          ))}
        </div>
      </Card>
      {children}
    </div>
  );

  const PlanningKpiGrid = () => (
    <div className="grid grid-cols-4 gap-3">
      {planningKpis.map((item) => (
        <Card key={item.label} className="p-4">
          <div className={typography.compactMetadata} style={{ color: A.gray2 }}>{item.label}</div>
          <div className="mt-2 text-xl font-semibold tabular-nums" style={{ color: item.color }}>{item.value}</div>
          <div className={`${typography.compactMetadata} mt-1`} style={{ color: A.sub }}>{item.sub}</div>
        </Card>
      ))}
    </div>
  );

  const DemandForecastView = () => (
    <ViewShell>
      <PlanningKpiGrid />
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-5">
          <SectionHeader title="预测引擎" />
          <Field label="算法"><select value={method} onChange={(event) => setMethod(event.target.value as Method)} style={inputStyle}>{(["naive", "sma", "ses", "holt", "hw"] as Method[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
          <Field label="预测期"><input type="number" min={3} max={12} value={horizon} onChange={(event) => setHorizon(Math.max(3, Math.min(12, Number(event.target.value) || 6)))} style={inputStyle} /></Field>
          <button onClick={runEngine} disabled={running} className="w-full mt-3 text-xs py-2.5 rounded-xl font-medium text-white flex items-center justify-center gap-1.5" style={{ background: A.blue, opacity: running ? 0.6 : 1 }}>
            {running ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{running ? `运算中… ${progress}%` : "运行预测引擎"}
          </button>
        </Card>
        <Card className="col-span-2 p-5">
          <SectionHeader title="历史需求输入" />
          <textarea value={historyText} onChange={(event) => setHistoryText(event.target.value)} className="w-full h-24 rounded-xl p-3 text-xs outline-none resize-none" style={{ background: A.gray6, color: A.label, border: "0.5px solid rgba(0,0,0,0.08)" }} />
          <div className="flex items-center justify-between mt-3">
            <span className="fc-caption" style={{ color: parsedHistory.length >= 6 ? A.green : A.orange }}>已识别 {parsedHistory.length} 个历史点 · CoV {diag.cov.toFixed(2)}</span>
            <button onClick={() => { if (parsedHistory.length < 6) return toast.error("历史数据不足"); setUseCustomHistory(true); setCommitted(false); }} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: A.blue }}>应用输入数据</button>
          </div>
        </Card>
      </div>
      <Card className="p-5">
        <SectionHeader title={`${sku.sku} · 需求预测曲线`} right={<button onClick={exportForecastResultCsv} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}><FileSpreadsheet size={11} /> 导出当前结果</button>} />
        <div className="grid grid-cols-2 gap-3">
          <ResponsiveContainer width="100%" height={220}><LineChart data={historyData}><CartesianGrid strokeDasharray="0" stroke="rgba(0,0,0,0.05)" vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 10, fill: A.gray2, fontFamily: "Inter" }} axisLine={false} tickLine={false} interval={2} /><YAxis domain={yDomain} tick={{ fontSize: 11, fill: A.gray2, fontFamily: "Inter" }} axisLine={false} tickLine={false} width={42} /><Tooltip content={<AppleTooltip />} /><Line type="monotone" dataKey="actual" name="实际" stroke={A.blue} strokeWidth={2} dot={false} isAnimationActive={false} /><Line type="monotone" dataKey="fitted" name="拟合" stroke={A.green} strokeWidth={1.5} strokeDasharray="3 3" dot={false} connectNulls isAnimationActive={false} /></LineChart></ResponsiveContainer>
          <ResponsiveContainer width="100%" height={220}><ComposedChart data={forecastChart}><CartesianGrid strokeDasharray="0" stroke="rgba(0,0,0,0.05)" vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 10, fill: A.gray2, fontFamily: "Inter" }} axisLine={false} tickLine={false} /><YAxis domain={yDomain} tick={{ fontSize: 11, fill: A.gray2, fontFamily: "Inter" }} axisLine={false} tickLine={false} width={42} /><Tooltip content={<AppleTooltip />} /><Area type="monotone" dataKey="bandHeight" stroke="none" fill={A.orange} fillOpacity={0.08} isAnimationActive={false} /><Line type="monotone" dataKey="forecast" name="预测" stroke={A.orange} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} /></ComposedChart></ResponsiveContainer>
        </div>
      </Card>
      <Card className="p-5">
        <SectionHeader title="模型对比 (Champion / Challenger)" right={<button onClick={exportBenchmarkCsv} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}><FileSpreadsheet size={11} /> 导出模型对比</button>} />
        <div className="grid grid-cols-5 gap-2">{benchmark.map((row, index) => <div key={row.method} className="rounded-xl p-3" style={{ background: index === 0 ? "#f0faf4" : A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>#{index + 1} {METHOD_LABEL[row.method]}</div><div className="text-sm font-semibold mt-1" style={{ color: index === 0 ? A.green : A.label }}>MAPE {row.mape.toFixed(1)}%</div><div className="fc-caption mt-1" style={{ color: A.sub }}>RMSE {row.rmse.toFixed(0)}</div></div>)}</div>
      </Card>
      <Card>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}><div><h2 className="text-sm font-semibold" style={{ color: A.label }}>需求 - 供给对账 (S&OP)</h2><p className="text-[11px] mt-0.5" style={{ color: A.sub }}>作为需求预测的下方输入证据，不作为主 CTA。</p></div><button onClick={saveForecastPlan} disabled={savingPlan} className="text-xs px-4 py-2 rounded-xl font-medium text-white flex items-center gap-1.5" style={{ background: committed ? A.green : A.blue, opacity: savingPlan ? 0.7 : 1 }}>{savingPlan ? <Loader2 size={12} className="animate-spin" /> : <FileCheck2 size={12} />}{committed ? "已保存方案" : "保存共识预测方案"}</button></div>
        <ReconciliationTable compact />
      </Card>
    </ViewShell>
  );

  const ReconciliationTable = ({ compact = false }: { compact?: boolean }) => (
    <table className={`w-full ${tableBodyTextClass}`}>
      <thead><tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>{(compact ? ["月份", "预测需求", "计划入库", "期末库存", "缺口", "风险"] : ["月份", "预测需求", "计划入库", "期末库存", "缺口", "风险", "建议"]).map((h) => <th key={h} className={thWideClass} style={{ color: A.gray1 }}>{h}</th>)}</tr></thead>
      <tbody>{reconciliation.map((row, index) => <tr key={row.month} className="hover:bg-blue-50/40 transition-colors" style={{ borderBottom: index < reconciliation.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}><td className={`${tdWideClass} font-medium`}>{row.month}</td><td className={tdWideNumericClass}>{row.demand.toLocaleString()}</td><td className={tdWideNumericClass}>{row.inbound > 0 ? `+${row.inbound.toLocaleString()}` : "—"}</td><td className={tdWideNumericClass}>{row.ending.toLocaleString()}</td><td className={tdWideNumericClass}>{row.gap > 0 ? row.gap.toLocaleString() : "—"}</td><td className={tdWideClass}><StatusPill status={row.risk === "高" ? "不足" : row.risk === "中" ? "预警" : "正常"} /></td>{!compact && <td className={tdWideClass}>{row.risk === "高" ? `准备草稿 +${Math.ceil(row.gap * 1.1).toLocaleString()}` : row.risk === "中" ? "提前复核" : "观察"}</td>}</tr>)}</tbody>
    </table>
  );

  const MrpPlanView = () => (
    <ViewShell>
      <PlanningKpiGrid />
      <Card className="p-5">
        <SectionHeader title="MRP 例外消息" right={<button onClick={exportMrpExceptionsCsv} className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}><FileSpreadsheet size={11} /> 导出例外</button>} />
        {mrpExceptions.length ? <div className="grid grid-cols-3 gap-3">{mrpExceptions.map((item) => <div key={item.title} className="rounded-xl p-3" style={{ background: A.gray6 }}><div className="flex items-center justify-between mb-2"><span className="fc-caption font-semibold" style={{ color: item.color }}>{item.type}</span><span className="fc-caption font-semibold tabular-nums" style={{ color: item.color }}>{item.metric}</span></div><div className="text-xs font-semibold" style={{ color: A.label }}>{item.title}</div><div className="fc-caption leading-4 mt-1" style={{ color: A.sub }}>{item.body}</div></div>)}</div> : <div className="text-xs py-6 text-center" style={{ color: A.gray2 }}>当前预测、库存和供应商评分未触发 MRP 例外消息。</div>}
      </Card>
      <Card>
        <div className="px-5 py-4 flex items-start justify-between gap-3" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          <div><h2 className="text-sm font-semibold" style={{ color: A.label }}>MRP 净需求计划</h2><p className="text-[11px] mt-0.5" style={{ color: A.sub }}>{currentMrpRow ? `${currentMrpRow.sku} · 毛需求、库存余额、计划收货、净需求、计划入库、计划释放、BOM 和需求来源证据` : "等待 MRP 接口返回计划结果"}</p><p className={`${typography.compactMetadata} mt-1 max-w-3xl`} style={{ color: A.gray2 }}>计划释放只表示审阅节奏，不会自动下发 PR/PO。{mrpBomSourceSummary ? `BOM 证据：${mrpBomSourceSummary}。` : "当前行未识别到 BOM 相关需求来源。"}</p></div>
          <div className="flex items-center gap-2"><button onClick={exportMrpPlannedOrdersCsv} className="h-10 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5" style={{ background: A.gray6, color: A.blue }}><FileSpreadsheet size={13} /> 导出当前结果</button><button onClick={releaseMrpAsPr} disabled={generatingRequest || !currentMrpRow || currentMrpRow.totalPlannedReceipt <= 0 || Boolean(lastGeneratedRequest)} className="h-10 px-3 rounded-lg text-xs font-semibold text-white flex items-center gap-1.5 disabled:cursor-not-allowed" style={{ background: lastGeneratedRequest ? A.green : currentMrpRow && currentMrpRow.totalPlannedReceipt > 0 ? A.purple : A.gray3, opacity: generatingRequest ? 0.7 : 1 }}>{generatingRequest ? <Loader2 size={13} className="animate-spin" /> : lastGeneratedRequest ? <CheckCircle2 size={13} /> : <GitBranch size={13} />}{lastGeneratedRequest ? `已预览 ${lastGeneratedRequest}` : "预览 PR 草稿"}</button></div>
        </div>
        {currentMrpRow ? <table className={`w-full ${tableBodyTextClass}`}><thead><tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>{["周期", "毛需求", "独立/BOM", "计划到货", "预计可用", "净需求", "计划入库", "计划释放", "例外"].map((h) => <th key={h} className={thClass} style={{ color: A.gray1 }}>{h}</th>)}</tr></thead><tbody>{currentMrpRow.schedule.map((line, index) => { const exceptionColor = line.exception === "加急" ? A.red : line.exception === "释放" ? A.blue : line.exception === "推迟/取消" ? A.orange : A.green; return <tr key={line.period} className="hover:bg-blue-50/40 transition-colors" style={{ borderBottom: index < currentMrpRow.schedule.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}><td className={`${tdClass} font-medium`} style={{ color: A.label }}>{line.period}</td><td className={tdNumericClass}>{line.grossRequirement.toLocaleString()}</td><td className={`${tdNumericClass} min-w-[190px]`}><div>{line.independentDemand.toLocaleString()} / {line.dependentDemand.toLocaleString()}</div></td><td className={tdNumericClass}>{line.scheduledReceipt > 0 ? `+${line.scheduledReceipt.toLocaleString()}` : "—"}</td><td className={tdNumericClass}>{line.projectedAvailable.toLocaleString()}</td><td className={tdNumericClass}>{line.netRequirement > 0 ? line.netRequirement.toLocaleString() : "—"}</td><td className={tdNumericClass}>{line.plannedReceipt > 0 ? line.plannedReceipt.toLocaleString() : "—"}</td><td className={tdClass}>{line.plannedRelease > 0 ? `${line.plannedReleasePeriod} · ${line.plannedRelease.toLocaleString()}` : "—"}</td><td className={tdClass}><Chip label={line.exception} color={exceptionColor} bg={`${exceptionColor}16`} /></td></tr>; })}</tbody></table> : <div className="py-10 text-center text-xs" style={{ color: A.gray2 }}>MRP 计划暂不可用。</div>}
      </Card>
    </ViewShell>
  );

  const ReplenishmentWorkbenchView = () => (
    <ViewShell>
      <PlanningKpiGrid />
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div><SectionHeader title="补货建议转草稿" right={<span className="fc-caption px-2 py-0.5 rounded-full font-medium" style={{ background: "#f0f6ff", color: A.blue }}>仅预览动作草稿</span>} /><p className="text-xs leading-5 max-w-3xl" style={{ color: A.sub }}>基于峰值净缺口、服务水平、MRP 净需求和提前期形成采购草稿建议；这里不会直接创建采购申请业务记录。</p></div>
          <button onClick={createRequestFromForecast} disabled={generatingRequest || executableRecommendedQty <= 0 || Boolean(lastGeneratedRequest)} className="h-9 px-4 rounded-lg text-xs font-semibold text-white flex items-center gap-1.5 disabled:cursor-not-allowed" style={{ background: lastGeneratedRequest ? A.green : executableRecommendedQty > 0 ? A.blue : A.gray3, opacity: generatingRequest ? 0.7 : 1 }}>{generatingRequest ? <Loader2 size={13} className="animate-spin" /> : lastGeneratedRequest ? <CheckCircle2 size={13} /> : <ShoppingCart size={13} />}{lastGeneratedRequest ? `已预览 ${lastGeneratedRequest}` : "预览 PR 草稿"}</button>
        </div>
        <div className="grid grid-cols-7 gap-2 mt-4">{[{ label: currentMrpRow ? "MRP 建议量" : "建议采购量", value: executableRecommendedQty > 0 ? `${executableRecommendedQty.toLocaleString()} ${sku.unit}` : "0", color: executableRecommendedQty > 0 ? A.red : A.green }, { label: "峰值净缺口", value: `${peakGap.toLocaleString()} ${sku.unit}`, color: peakGap > 0 ? A.red : A.green }, { label: "推荐供应商", value: procurementProfile.supplier, color: A.blue }, { label: "采购负责人", value: procurementProfile.buyer, color: A.label }, { label: "预估金额", value: fmt(executableRecommendedAmount), color: A.purple }, { label: "优先级", value: executablePriority, color: executablePriority === "高" ? A.red : executablePriority === "中" ? A.orange : A.green }, { label: "预计到货", value: formatEta(leadTimeDays), color: A.label }].map((item) => <div key={item.label} className="rounded-xl p-3" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{item.label}</div><div className="text-xs font-semibold mt-1 truncate" style={{ color: item.color }}>{item.value}</div></div>)}</div>
        <div className="mt-3 rounded-xl px-3 py-2 text-[11px] leading-5" style={{ background: "#f0f6ff", color: A.sub }}><span className="font-semibold" style={{ color: supplierScore.color }}>供应商推荐依据：</span>{supplierScore.note}</div>
      </Card>
      <Card><div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}><div><h2 className="text-sm font-semibold" style={{ color: A.label }}>需求 - 供给对账</h2><p className="text-[11px] mt-0.5" style={{ color: A.sub }}>用于解释建议数量，保存计划仍按 legacy mutation guard 管控。</p></div><button onClick={exportReconciliationCsv} className="text-xs px-3 py-2 rounded-xl font-medium flex items-center gap-1.5" style={{ background: A.gray6, color: A.blue }}><FileSpreadsheet size={12} /> 导出</button></div><ReconciliationTable /></Card>
    </ViewShell>
  );

  const PlanningParametersView = () => (
    <ViewShell>
      <PlanningKpiGrid />
      <Card className="p-5">
        <SectionHeader title="SKU 计划参数与静态假设" right={<span className="fc-caption px-2 py-0.5 rounded-full font-medium" style={{ background: "#fff8f0", color: A.orange }}>只读计划假设</span>} />
        <div className="grid grid-cols-4 gap-3">{[{ label: "采购提前期", value: currentMrpRow ? `${currentMrpRow.leadTimePeriods} 期` : `${leadTimeDays} 天`, detail: "MRP 只读计划参数 / 预测界面假设" }, { label: "MOQ", value: currentMrpRow ? `${currentMrpRow.moq} ${sku.unit}` : "—", detail: "最小采购批量" }, { label: "批量倍数", value: currentMrpRow ? `${currentMrpRow.batchMultiple}` : "—", detail: "批量倍数" }, { label: "安全库存", value: `${(currentMrpRow?.safetyStock || fallbackSafetyStock).toLocaleString()} ${sku.unit}`, detail: "安全库存 / 最低库存" }, { label: "再订货点", value: `${Math.round((currentMrpRow?.safetyStock || fallbackSafetyStock) * 1.15).toLocaleString()} ${sku.unit}`, detail: "Alpha 只读假设" }, { label: "优先供应商", value: procurementProfile.supplier, detail: supplierScore.grade }, { label: "采购负责人", value: procurementProfile.buyer, detail: "采购负责人假设" }, { label: "单位成本", value: fmt(procurementProfile.unitPrice), detail: "用于草稿金额估算" }].map((item) => <div key={item.label} className="rounded-xl p-4" style={{ background: A.gray6 }}><div className={typography.compactMetadata} style={{ color: A.gray2 }}>{item.label}</div><div className="mt-2 text-sm font-semibold truncate" style={{ color: A.label }}>{item.value}</div><div className={`${typography.compactMetadata} mt-1`} style={{ color: A.sub }}>{item.detail}</div></div>)}</div>
      </Card>
      <Card className="p-5"><SectionHeader title="BOM 与需求来源证据" /><div className="grid grid-cols-3 gap-3">{(currentMrpRow?.bomSources || []).slice(0, 6).map((source, index) => <div key={`${source.parent}-${index}`} className="rounded-xl p-3" style={{ background: A.gray6 }}><div className="text-xs font-semibold" style={{ color: A.label }}>{source.parentName || source.parent}</div><div className="fc-caption mt-1" style={{ color: A.sub }}>贡献需求 {Number(source.demand || 0).toLocaleString()} · qty/parent {source.qtyPer}</div></div>)}{!currentMrpRow?.bomSources?.length && <div className="text-xs py-6" style={{ color: A.gray2 }}>当前 SKU 没有可展示的 BOM 来源。</div>}</div></Card>
    </ViewShell>
  );

  const PlanningCockpitView = () => (
    <ViewShell>
      <PlanningKpiGrid />
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-5"><SectionHeader title="计划风险摘要" /><div className="space-y-3">{[{ label: "今天最需要处理", value: peakGap > 0 ? `${sku.sku} 缺口 ${peakGap.toLocaleString()} ${sku.unit}` : "当前供需平衡", color: peakGap > 0 ? A.red : A.green }, { label: "预测质量", value: `MAPE ${result.mape.toFixed(1)}% · ${mapeGrade(result.mape).grade}`, color: mapeGrade(result.mape).color }, { label: "MRP 例外", value: currentMrpRow?.exception || "正常", color: currentMrpRow?.exception === "加急" ? A.red : currentMrpRow?.exception === "释放" ? A.blue : A.green }].map((item) => <div key={item.label} className="rounded-xl p-3" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{item.label}</div><div className="text-sm font-semibold mt-1" style={{ color: item.color }}>{item.value}</div></div>)}</div></Card>
        <Card className="col-span-2 p-5"><SectionHeader title="重点 MRP 例外" />{mrpExceptions.length ? <div className="space-y-2">{mrpExceptions.slice(0, 3).map((item) => <div key={item.title} className="rounded-xl p-3 flex items-start justify-between gap-3" style={{ background: A.gray6 }}><div><div className="text-xs font-semibold" style={{ color: A.label }}>{item.title}</div><div className="fc-caption leading-4 mt-1" style={{ color: A.sub }}>{item.body}</div></div><div className="text-xs font-semibold tabular-nums" style={{ color: item.color }}>{item.metric}</div></div>)}</div> : <div className="text-xs py-8 text-center" style={{ color: A.gray2 }}>没有高优先级 MRP 例外。</div>}</Card>
      </div>
      <div className="grid grid-cols-3 gap-3">{[{ title: "需求预测", body: `未来 ${horizon} 月需求 ${totalForecastDemand.toLocaleString()} ${sku.unit}，MAPE ${result.mape.toFixed(1)}%。`, cta: "查看需求预测", target: "forecast:demand" }, { title: "MRP 计划", body: currentMrpRow ? `计划入库 ${currentMrpRow.totalPlannedReceipt.toLocaleString()} ${sku.unit}，最大净需求 ${currentMrpRow.maxNetRequirement.toLocaleString()}。` : "MRP 数据加载中。", cta: "查看 MRP 计划", target: "forecast:mrp" }, { title: "补货工作台", body: executableRecommendedQty > 0 ? `建议准备 ${executableRecommendedQty.toLocaleString()} ${sku.unit} 草稿，金额 ${fmt(executableRecommendedAmount)}。` : "当前无需准备补货草稿。", cta: "打开补货工作台", target: "forecast:replenishment" }].map((item) => <Card key={item.title} className="p-5"><div className={typography.sectionTitle} style={{ color: A.label }}>{item.title}</div><p className={`${typography.body} mt-2`} style={{ color: A.sub }}>{item.body}</p><button type="button" onClick={() => onNavigate?.(item.target)} className={`${typography.compactMetadata} mt-4 text-left hover:underline disabled:cursor-not-allowed`} style={{ color: A.blue }} disabled={!onNavigate}>{item.cta}</button></Card>)}</div>
    </ViewShell>
  );

  if (activePlanningView === "demand") return <DemandForecastView />;
  if (activePlanningView === "mrp") return <MrpPlanView />;
  if (activePlanningView === "replenishment") return <ReplenishmentWorkbenchView />;
  if (activePlanningView === "parameters") return <PlanningParametersView />;
  return <PlanningCockpitView />;
}
