import { AlertTriangle, ArrowLeft, GitBranch, Link2, ListTree, RotateCcw } from "lucide-react";
import { A, Card, Chip, SectionHeader } from "../ui";
import type { CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";

export type EvidenceGraphNode = {
  id: string;
  type: string;
  label: string;
  moduleId?: string;
  status?: string;
  riskLevel?: string;
  riskLabel?: string;
  summary?: string;
  route?: string;
  dataLimitations?: string[];
};

export type EvidenceGraphResponse = {
  anchor?: EvidenceGraphNode;
  nodes?: EvidenceGraphNode[];
  edges?: Array<{ from: string; to: string; relationLabel?: string; summary?: string }>;
  primaryPath?: Array<{ nodeId: string; label: string; moduleId?: string; route?: string }>;
  relatedRecords?: Record<string, Array<Partial<EvidenceGraphNode> & { route?: string }>>;
  riskSignals?: Array<{ type?: string; label?: string; severity?: string; summary?: string; affectedNodes?: string[] }>;
  navigationHints?: Array<{ label?: string; moduleId?: string; entityId?: string; entityType?: string; route?: string }>;
  dataLimitations?: string[];
  summary?: { nodeCount?: number; edgeCount?: number; riskSignalCount?: number; anchorLabel?: string; topRiskLabel?: string };
};

export type EvidenceReturnContext = {
  sourceModule: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
  sourceLabel?: string;
  sourceRoute?: string;
  returnLabel?: string;
  originIntent?: string;
};

export type EvidenceNavigate = (
  moduleId: string,
  focusTarget?: CanonicalFocusTarget | null,
  options?: {
    returnTo?: string;
    entityLabel?: string;
    source?: string;
    returnContext?: EvidenceReturnContext | null;
  }
) => void;

const typeLabels: Record<string, string> = {
  customer_order: "客户订单",
  sales_order: "客户订单",
  inventory_availability: "库存可用量",
  inventory_item: "SKU",
  sku: "SKU",
  item: "SKU",
  purchase_request: "采购申请",
  rfq: "RFx",
  purchase_order: "采购订单",
  receiving_doc: "收货单",
  supplier: "供应商",
  supplier_invoice: "供应商发票",
  exception_case: "异常工单",
  data_limit: "数据限制",
  today_work_item: "今日风险事项",
};

const relatedLabels: Record<string, string> = {
  salesOrders: "客户订单",
  items: "物料资料",
  inventoryItems: "库存余额",
  inventoryAvailability: "SKU / 库存",
  purchaseRequests: "采购申请",
  rfqs: "RFx",
  purchaseOrders: "采购订单",
  receivingDocs: "收货单",
  suppliers: "供应商",
  invoices: "供应商发票",
  exceptionCases: "异常工单",
  dataLimitations: "数据限制",
};

const limitationLabels: Record<string, string> = {
  missing_inventory_allocation: "当前工作区缺少完整库存分配记录",
  missing_purchase_order_links: "当前工作区缺少完整采购订单关联",
  missing_receiving_records: "当前工作区缺少完整收货记录",
  missing_supplier_risk_records: "当前工作区缺少完整供应商风险记录",
  missing_supplier_records: "当前工作区缺少完整供应商资料",
  missing_daily_demand_history: "当前工作区缺少完整日需求历史",
  current_workspace_data_limited: "当前数据范围有限，需人工复核",
  record_not_found: "未找到对应业务记录。",
  warehouse_runtime_not_connected: "仓库运行时关系尚未接入证据图",
  bin_runtime_not_connected: "库位运行时关系尚未接入证据图",
  receipt_runtime_has_no_records: "当前工作区暂无可关联的收货记录",
  invoice_runtime_has_no_records: "当前工作区暂无可关联的发票记录",
};

// English display copy for this panel. Record labels and summaries from the API
// go through the shared workspace copy; stored values are never rewritten.
const english: Record<string, string> = {
  "客户订单": "Customer order", "库存可用量": "Inventory availability", "采购申请": "Purchase request", "采购订单": "Purchase order",
  "收货单": "Receiving document", "供应商": "Supplier", "供应商发票": "Supplier invoice", "异常工单": "Exception case",
  "数据限制": "Data limitations", "今日风险事项": "Today's risk item", "物料资料": "Items", "库存余额": "Inventory balance",
  "SKU / 库存": "SKU / inventory", "业务记录": "Business record",
  "当前工作区缺少完整库存分配记录": "This workspace has incomplete inventory allocation records.",
  "当前工作区缺少完整采购订单关联": "This workspace has incomplete purchase order links.",
  "当前工作区缺少完整收货记录": "This workspace has incomplete receiving records.",
  "当前工作区缺少完整供应商风险记录": "This workspace has incomplete supplier risk records.",
  "当前工作区缺少完整供应商资料": "This workspace has incomplete supplier records.",
  "当前工作区缺少完整日需求历史": "This workspace has incomplete daily demand history.",
  "当前数据范围有限，需人工复核": "Data in this workspace is limited. Review manually.",
  "未找到对应业务记录。": "No matching business record was found.",
  "仓库运行时关系尚未接入证据图": "Warehouse relationships are not in the evidence graph yet.",
  "库位运行时关系尚未接入证据图": "Location relationships are not in the evidence graph yet.",
  "当前工作区暂无可关联的收货记录": "No receiving records in this workspace can be linked.",
  "当前工作区暂无可关联的发票记录": "No invoice records in this workspace can be linked.",
  "需复核": "Needs review", "查看": "View", "证据链锚点": "Evidence anchor", "请选择业务对象": "Select a business record",
  "来源：": "Source: ", "返回上一级": "Back", "返回来源对象": "Back to source record", "返回列表": "Back to list",
  "主证据链": "Primary evidence path", "{count} 个节点": "{count} nodes", "相关记录": "Related records", "可跳转": "Linked",
  "当前仅显示工作区内可追溯的关联摘要，需人工复核。": "Only related records traceable in this workspace are shown. Review manually.",
  "风险信号": "Risk signals", "{count} 条": "{count}", "高风险": "High risk", "需关注": "Watch",
  "当前未读取到高风险信号，仍需结合业务记录人工复核。": "No high-risk signals were found. Still review the business records.",
  "人工复核": "Manual review", "导航提示": "Navigation", "刷新": "Refresh",
  "已找到 {count} 个可跳转业务记录。": "Found {count} linked business records.", "当前没有更多可跳转记录。": "No more linked records.",
  "正在读取证据链...": "Loading evidence...", "低库存": "Low stock", "缺货": "Out of stock", "阻塞": "Blocked", "异常": "Exception",
  "当前暂未读取到完整证据链，请返回客户订单列表或切换业务对象后重试。": "The evidence path could not be loaded. Go back to customer orders or choose another record and try again.",
};

function useEvidenceCopy() {
  const { language } = useI18n();
  return (label: string, vars: Record<string, string | number> = {}) => {
    // The evidence graph API phrases an unsummarised risk as "<record> 需要复核。".
    const review = language === "en-US" ? /^(.+) 需要复核。$/.exec(label) : null;
    const text = review ? `${review[1]} needs review.` : language === "en-US" ? english[label] || workspaceCopy(label, language) : label;
    return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);
  };
}

function typeLabel(type = "") {
  return typeLabels[type] || "业务记录";
}

function limitationLabel(code = "") {
  return limitationLabels[code] || code || "当前数据范围有限，需人工复核";
}

function riskTone(risk = "") {
  if (/blocked|high|高|阻塞|异常|差异/.test(risk)) return { color: A.red, bg: "#fff1f0" };
  if (/medium|中|关注|待|缺/.test(risk)) return { color: A.orange, bg: "#fff8f0" };
  return { color: A.green, bg: "#f0faf4" };
}

function targetForNode(node: Partial<EvidenceGraphNode>) {
  const type = node.type || "";
  if (type === "customer_order" || type === "sales_order") return { moduleId: "sales", entityType: "sales_order" };
  if (type === "inventory_availability" || type === "inventory_item" || type === "sku" || type === "item") return { moduleId: "inventory", entityType: "inventory_item" };
  if (type === "purchase_request") return { moduleId: "procurement:requests", entityType: "purchase_request" };
  if (type === "rfq") return { moduleId: "procurement:rfq", entityType: "rfq" };
  if (type === "purchase_order") return { moduleId: "procurement:orders", entityType: "purchase_order" };
  if (type === "receiving_doc") return { moduleId: "procurement:receiving", entityType: "receiving_doc" };
  if (type === "supplier") return { moduleId: "srm:master", entityType: "supplier" };
  if (type === "supplier_invoice") return { moduleId: "finance:invoices", entityType: "supplier_invoice" };
  if (type === "exception_case") return { moduleId: "exception-cases", entityType: "exception_case" };
  return { moduleId: node.moduleId || "", entityType: type };
}

function nodeById(nodes: EvidenceGraphNode[], id = "") {
  return nodes.find((node) => node.id === id || node.label === id) || null;
}

function EvidenceNodeCard({
  node,
  onNavigate,
  returnContext,
  returnTo,
}: {
  node: EvidenceGraphNode;
  onNavigate?: EvidenceNavigate;
  returnContext?: EvidenceReturnContext | null;
  returnTo?: string;
}) {
  const t = useEvidenceCopy();
  const target = targetForNode(node);
  const risk = riskTone(`${node.riskLevel || ""} ${node.riskLabel || ""} ${node.status || ""}`);
  const clickable = Boolean(onNavigate && target.moduleId && node.id);
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="fc-caption font-semibold" style={{ color: A.gray2 }}>{t(typeLabel(node.type))}</div>
          <div className="mt-0.5 truncate text-xs font-semibold tabular-nums" style={{ color: clickable ? A.blue : A.label }}>{node.label ? t(node.label) : node.id}</div>
        </div>
        {(node.riskLabel || node.status) && <Chip label={t(node.riskLabel || node.status || "需复核")} color={risk.color} bg={risk.bg} />}
      </div>
      {node.summary && <div className="mt-2 line-clamp-2 text-[11px] leading-5" style={{ color: A.sub }}>{t(node.summary)}</div>}
      {clickable && <div className="mt-2 text-[11px] font-semibold" style={{ color: A.blue }}>{t("查看")}</div>}
    </>
  );
  return clickable ? (
    <button
      type="button"
      onClick={() => onNavigate?.(target.moduleId, { entityType: target.entityType, entityId: node.id }, {
        returnTo,
        entityLabel: node.label,
        source: "evidenceGraph",
        returnContext,
      })}
      className="rounded-xl p-3 text-left"
      style={{ background: A.white, boxShadow: `0 0 0 0.5px ${A.border}` }}
    >
      {body}
    </button>
  ) : (
    <div className="rounded-xl p-3" style={{ background: A.white, boxShadow: `0 0 0 0.5px ${A.border}` }}>{body}</div>
  );
}

export function ReturnPathBar({
  anchor,
  sourceLabel,
  onBack,
  onReturnSource,
  onReturnList,
}: {
  anchor?: EvidenceGraphNode | null;
  sourceLabel?: string;
  onBack?: () => void;
  onReturnSource?: () => void;
  onReturnList?: () => void;
}) {
  const t = useEvidenceCopy();
  return (
    <Card className="p-3" data-testid="return-path-bar">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold" style={{ color: A.blue }}>{t("证据链锚点")}</div>
          <div className="mt-0.5 truncate text-sm font-semibold" style={{ color: A.label }}>
            {anchor ? `${t(typeLabel(anchor.type))} / ${anchor.label ? t(anchor.label) : anchor.id}` : t("请选择业务对象")}
          </div>
          {sourceLabel && <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{t("来源：")}{t(sourceLabel)}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onBack} className="h-8 rounded-lg px-3 text-[12px] font-semibold inline-flex items-center gap-1.5" style={{ background: A.gray6, color: A.label }}>
            <ArrowLeft size={13} /> {t("返回上一级")}
          </button>
          {onReturnSource && (
            <button type="button" onClick={onReturnSource} className="h-8 rounded-lg px-3 text-[12px] font-semibold inline-flex items-center gap-1.5" style={{ background: "#f0f6ff", color: A.blue }}>
              <ArrowLeft size={13} /> {t("返回来源对象")}
            </button>
          )}
          <button type="button" onClick={onReturnList} className="h-8 rounded-lg px-3 text-[12px] font-semibold inline-flex items-center gap-1.5" style={{ background: A.gray6, color: A.gray1 }}>
            <ListTree size={13} /> {t("返回列表")}
          </button>
        </div>
      </div>
    </Card>
  );
}

export function EvidencePrimaryPath({
  graph,
  onNavigate,
  returnContext,
  returnTo,
}: {
  graph: EvidenceGraphResponse;
  onNavigate?: EvidenceNavigate;
  returnContext?: EvidenceReturnContext | null;
  returnTo?: string;
}) {
  const t = useEvidenceCopy();
  const nodes = graph.nodes || [];
  const pathNodes = (graph.primaryPath || [])
    .map((item) => nodeById(nodes, item.nodeId) || nodes.find((node) => node.label === item.label))
    .filter(Boolean) as EvidenceGraphNode[];
  const visible = pathNodes.length ? pathNodes : nodes.slice(0, 6);
  return (
    <Card className="p-4" data-testid="evidence-primary-path">
      <SectionHeader title={t("主证据链")} right={<Chip label={t("{count} 个节点", { count: visible.length })} color={A.blue} bg="#f0f6ff" />} />
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
        {visible.map((node, index) => (
          <div key={`${node.type}-${node.id}`} className="grid grid-cols-[1fr_20px] gap-2">
            <EvidenceNodeCard node={node} onNavigate={onNavigate} returnContext={returnContext} returnTo={returnTo} />
            {index < visible.length - 1 && <div className="hidden items-center justify-center lg:flex"><GitBranch size={14} style={{ color: A.gray2 }} /></div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function RelatedRecordsPanel({
  graph,
  onNavigate,
  returnContext,
  returnTo,
}: {
  graph: EvidenceGraphResponse;
  onNavigate?: EvidenceNavigate;
  returnContext?: EvidenceReturnContext | null;
  returnTo?: string;
}) {
  const t = useEvidenceCopy();
  const groups = graph.relatedRecords || {};
  const entries = Object.entries(groups)
    .map(([key, rows]) => [relatedLabels[key] || key, rows] as const)
    .filter(([, rows]) => Array.isArray(rows) && rows.length);
  return (
    <Card className="p-4" data-testid="evidence-related-records">
      <SectionHeader title={t("相关记录")} right={<Chip label={t("可跳转")} color={A.green} bg="#f0faf4" />} />
      <div className="space-y-4">
        {entries.length ? entries.map(([label, rows]) => (
          <div key={label}>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: A.gray1 }}><Link2 size={12} /> {t(label)}</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {rows.map((row) => (
                <EvidenceNodeCard
                  key={`${label}-${row.id}-${row.label}`}
                  node={{ id: String(row.id || row.label || ""), type: String(row.type || guessTypeFromGroup(label)), label: String(row.label || row.id || ""), status: row.status, riskLevel: row.riskLevel, riskLabel: row.riskLabel, route: row.route }}
                  onNavigate={onNavigate}
                  returnContext={returnContext}
                  returnTo={returnTo}
                />
              ))}
            </div>
          </div>
        )) : (
          <div className="rounded-lg px-3 py-2 text-[11px]" style={{ background: A.gray6, color: A.sub }}>{t("当前仅显示工作区内可追溯的关联摘要，需人工复核。")}</div>
        )}
      </div>
    </Card>
  );
}

function guessTypeFromGroup(label: string) {
  if (label.includes("客户订单")) return "customer_order";
  if (label.includes("SKU") || label.includes("库存")) return "inventory_availability";
  if (label.includes("采购申请")) return "purchase_request";
  if (label.includes("RFx")) return "rfq";
  if (label.includes("采购订单")) return "purchase_order";
  if (label.includes("收货")) return "receiving_doc";
  if (label.includes("供应商发票")) return "supplier_invoice";
  if (label.includes("供应商")) return "supplier";
  if (label.includes("异常")) return "exception_case";
  return "data_limit";
}

export function RiskSignalsPanel({ graph }: { graph: EvidenceGraphResponse }) {
  const t = useEvidenceCopy();
  const signals = graph.riskSignals || [];
  return (
    <Card className="p-4" data-testid="evidence-risk-signals">
      <SectionHeader title={t("风险信号")} right={<Chip label={t("{count} 条", { count: signals.length })} color={signals.length ? A.orange : A.green} bg={signals.length ? "#fff8f0" : "#f0faf4"} />} />
      <div className="space-y-2">
        {signals.length ? signals.map((signal, index) => {
          const tone = riskTone(`${signal.severity || ""} ${signal.label || ""}`);
          return (
            <div key={`${signal.label}-${index}`} className="rounded-lg p-3" style={{ background: A.gray6 }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: tone.color }}><AlertTriangle size={13} /> {t(signal.label || "需复核")}</div>
                <Chip label={t(signal.severity === "high" ? "高风险" : "需关注")} color={tone.color} bg={tone.bg} />
              </div>
              {signal.summary && <div className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>{t(signal.summary)}</div>}
            </div>
          );
        }) : (
          <div className="rounded-lg px-3 py-2 text-[11px]" style={{ background: A.gray6, color: A.sub }}>{t("当前未读取到高风险信号，仍需结合业务记录人工复核。")}</div>
        )}
      </div>
    </Card>
  );
}

export function DataLimitationsPanel({ items }: { items: string[] }) {
  const t = useEvidenceCopy();
  const visible = items.length ? items : ["current_workspace_data_limited"];
  return (
    <Card className="p-4" data-testid="evidence-data-limitations">
      <SectionHeader title={t("数据限制")} right={<Chip label={t("人工复核")} color={A.orange} bg="#fff8f0" />} />
      <div className="flex flex-wrap gap-2">
        {visible.map((item) => (
          <span key={item} className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: A.gray6, color: A.orange }}>
            {t(limitationLabel(item))}
          </span>
        ))}
      </div>
    </Card>
  );
}

export function NavigationHintsPanel({ graph, onRetry }: { graph: EvidenceGraphResponse; onRetry?: () => void }) {
  const t = useEvidenceCopy();
  const hints = graph.navigationHints || [];
  return (
    <Card className="p-4" data-testid="evidence-navigation-hints">
      <SectionHeader title={t("导航提示")} right={<button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: A.blue }}><RotateCcw size={12} /> {t("刷新")}</button>} />
      <div className="text-[11px] leading-5" style={{ color: A.sub }}>
        {hints.length ? t("已找到 {count} 个可跳转业务记录。", { count: hints.length }) : t("当前没有更多可跳转记录。")}
      </div>
    </Card>
  );
}

export default function EvidenceGraphPanel({
  graph,
  loading,
  error,
  onNavigate,
  onRetry,
  onBack,
  onReturnSource,
  onReturnList,
  sourceLabel,
  returnContext,
  returnTo,
  showReturnPath = true,
  showNavigationHints = true,
}: {
  graph: EvidenceGraphResponse | null;
  loading?: boolean;
  error?: string;
  onNavigate?: EvidenceNavigate;
  onRetry?: () => void;
  onBack?: () => void;
  onReturnSource?: () => void;
  onReturnList?: () => void;
  sourceLabel?: string;
  returnContext?: EvidenceReturnContext | null;
  returnTo?: string;
  showReturnPath?: boolean;
  showNavigationHints?: boolean;
}) {
  const t = useEvidenceCopy();
  if (loading) {
    return <Card className="p-6 text-sm" style={{ color: A.sub }}>{t("正在读取证据链...")}</Card>;
  }
  if (error || !graph) {
    return (
      <div className="space-y-3">
        {showReturnPath && <ReturnPathBar anchor={null} sourceLabel={sourceLabel} onBack={onBack} onReturnSource={onReturnSource} onReturnList={onReturnList} />}
        <Card className="p-6 text-sm leading-6" style={{ color: A.orange }}>
          {t(error || "当前暂未读取到完整证据链，请返回客户订单列表或切换业务对象后重试。")}
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="evidence-graph-panel">
      {showReturnPath && <ReturnPathBar anchor={graph.anchor || null} sourceLabel={sourceLabel} onBack={onBack} onReturnSource={onReturnSource} onReturnList={onReturnList} />}
      <EvidencePrimaryPath graph={graph} onNavigate={onNavigate} returnContext={returnContext} returnTo={returnTo} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <RelatedRecordsPanel graph={graph} onNavigate={onNavigate} returnContext={returnContext} returnTo={returnTo} />
        <div className="space-y-4">
          <RiskSignalsPanel graph={graph} />
          <DataLimitationsPanel items={graph.dataLimitations || []} />
          {showNavigationHints && <NavigationHintsPanel graph={graph} onRetry={onRetry} />}
        </div>
      </div>
    </div>
  );
}
