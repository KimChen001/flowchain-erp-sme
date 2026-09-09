import { useMemo, useState, type ReactNode } from "react";
import { A, Card, Chip, RecoveryActions } from "../../components/ui";
import {
  BusinessObjectDetailModal,
  CompactKpiStrip,
  DataLimitationsPanel,
  DetailFieldGrid,
  DetailSection,
  EvidenceSummaryPanel,
  ReviewActionPanel,
} from "../../components/business/BusinessObjectDetail";
import type { SupplierSrmRow } from "../../domain/srm/helpers";
import { fmt } from "../../lib/format";
import type { CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { grnLinesOf } from "../../domain/receiving/helpers";
import { poLinesOf, toNumber } from "../../domain/purchasing/helpers";
import { scoreStyle, supplierScoreSnapshot } from "./scoring";
import { workspaceCopy } from "../../i18n/workspaceCopy";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

type SrmTabTarget = "overview" | "master" | "performance" | "certification" | "sourcing" | "contracts";
type NavigateFn = (moduleId: string, focusTarget?: CanonicalFocusTarget | null, options?: { returnTo?: string; entityLabel?: string; source?: string }) => void;

function statusStyle(status: string) {
  if (["低", "正常", "已认证", "启用", "已匹配", "自动匹配", "已入库", "已付款"].includes(status)) return { color: A.green, bg: "#f0faf4" };
  if (["高", "需复核", "整改中", "异常处理", "存在差异", "差异待处理", "缺少收货"].includes(status)) return { color: A.red, bg: "#fff1f0" };
  return { color: A.orange, bg: "#fff8f0" };
}

function compactText(value: unknown, fallback = "待补齐") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function NavigationButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-md px-2 text-[11px] font-semibold"
      style={{ background: "#f0f6ff", color: A.blue }}
    >
      {typeof children === "string" ? copy(children) : children}
    </button>
  );
}

function SimpleTable<T>({
  columns,
  rows,
  emptyText = "暂无相关记录",
}: {
  columns: Array<{ key: string; label: string; render: (row: T, index: number) => ReactNode; align?: "left" | "right" | "center" }>;
  rows: T[];
  emptyText?: string;
}) {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`${column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left"} px-3 py-2 font-medium whitespace-nowrap`}
                  style={{ color: A.gray1 }}
                >
                  {copy(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center" style={{ color: A.gray2 }}>{copy(emptyText)}</td>
              </tr>
            ) : rows.map((row, index) => (
              <tr key={index} style={{ borderBottom: index < rows.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`${column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left"} px-3 py-2 whitespace-nowrap`}
                    style={{ color: A.label }}
                  >
                    {column.render(row, index)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function SupplierDetailModal({
  row,
  onClose,
  onOpenTab,
  onNavigate,
}: {
  row: SupplierSrmRow | null;
  onClose: () => void;
  onOpenTab?: (tab: SrmTabTarget) => void;
  onNavigate?: NavigateFn;
}) {
  const [previewMessage, setPreviewMessage] = useState("");
  const score = row ? supplierScoreSnapshot(row) : null;
  const overallStyle = score ? scoreStyle(score.overall) : { color: A.gray1, bg: A.gray6, label: "待复核" };

  const uninvoicedRows = useMemo(() => {
    if (!row) return [];
    return row.relatedPurchaseOrders.flatMap((po) => poLinesOf(po).map((line) => {
      const invoiceQty = row.relatedInvoices.flatMap((invoice) => invoice.lines)
        .filter((invoiceLine) => invoiceLine.poLine === line.poLineId)
        .reduce((sum, invoiceLine) => sum + toNumber(invoiceLine.quantity), 0);
      const receivedQty = toNumber(line.quantityReceived);
      const uninvoicedQty = Math.max(0, receivedQty - invoiceQty);
      return {
        po: po.po,
        poLine: line.poLineId,
        sku: line.sku,
        receivedQty,
        invoiceQty,
        uninvoicedQty,
        amount: uninvoicedQty * toNumber(line.unitPrice),
        risk: uninvoicedQty > 0 ? "已收未票风险" : "低风险",
        action: uninvoicedQty > 0 ? "人工复核未开票金额" : "保持观察",
      };
    })).filter((item) => item.uninvoicedQty > 0 || item.receivedQty > 0);
  }, [row]);

  if (!row || !score) return null;

  const firstRfq = row.relatedRfqs[0];
  const firstPo = row.relatedPurchaseOrders[0];
  const firstGrn = row.relatedReceivingDocs[0];
  const firstInvoice = row.relatedInvoices[0];
  const primarySku = row.relatedPurchaseOrders.flatMap((po) => poLinesOf(po)).map((line) => line.sku).find(Boolean)
    || row.relatedInvoices.flatMap((invoice) => invoice.lines).map((line) => line.sku).find(Boolean)
    || "待补齐";

  function go(moduleId: string, focusTarget?: CanonicalFocusTarget | null, entityLabel?: string) {
    if (!onNavigate) {
      setPreviewMessage("当前入口已记录来源上下文，请从顶部导航进入相关业务对象。");
      return;
    }
    onNavigate(moduleId, focusTarget || null, { returnTo: "srm:master", entityLabel, source: "supplierProfile" });
  }

  function preview(label: string, detail: string) {
    setPreviewMessage(`${label}已生成：${detail}`);
  }

  const returnActions = [
    { key: "supplier-list", label: "返回供应商列表", onClick: () => { onOpenTab?.("master"); onClose(); }, kind: "list" as const, tone: "primary" as const },
    { key: "srm", label: "返回 SRM 工作台", onClick: () => { onOpenTab?.("overview"); onClose(); }, kind: "module" as const },
    { key: "procurement", label: "返回采购工作台", onClick: () => go("procurement"), kind: "module" as const },
    { key: "rfq", label: "返回相关 RFQ", onClick: () => firstRfq ? go("procurement:rfq", { entityType: "rfq", entityId: firstRfq.id }, firstRfq.id) : setPreviewMessage("当前供应商暂无可跳转 RFQ。"), kind: "previous" as const },
    { key: "po", label: "返回相关 PO", onClick: () => firstPo ? go("procurement:orders", { entityType: "purchase_order", entityId: firstPo.po }, firstPo.po) : setPreviewMessage("当前供应商暂无可跳转 PO。"), kind: "previous" as const },
    { key: "grn", label: "返回相关收货记录", onClick: () => firstGrn ? go("procurement:receiving", { entityType: "receiving_doc", entityId: firstGrn.grn }, firstGrn.grn) : setPreviewMessage("当前供应商暂无可跳转收货记录。"), kind: "previous" as const },
    { key: "invoice", label: "返回相关发票记录", onClick: () => firstInvoice ? go("procurement:invoices", { entityType: "supplier_invoice", entityId: firstInvoice.invoiceNumber }, firstInvoice.invoiceNumber) : setPreviewMessage("当前供应商暂无可跳转发票记录。"), kind: "previous" as const },
    { key: "evidence", label: "返回证据链", onClick: () => setPreviewMessage("已定位到供应商证据链，当前证据仅供内部复核。"), kind: "previous" as const },
    { key: "previous", label: "返回上一级", onClick: onClose, kind: "previous" as const },
  ];

  const p2pFields = [
    { label: "RFQ 数量", value: row.p2pSummary.rfqCount },
    { label: "已响应报价数", value: row.p2pSummary.quoteCount },
    { label: "报价响应率", value: percent(row.p2pSummary.quoteResponseRate), tone: row.p2pSummary.quoteResponseRate < 90 ? "warning" as const : "good" as const },
    { label: "PO 数量", value: row.p2pSummary.poCount },
    { label: "Open PO 数量", value: row.p2pSummary.openPoCount, tone: row.p2pSummary.openPoCount ? "info" as const : "good" as const },
    { label: "PO 总金额", value: fmt(row.p2pSummary.poTotalAmount) },
    { label: "未收数量", value: row.p2pSummary.unreceivedQty, tone: row.p2pSummary.unreceivedQty ? "warning" as const : "good" as const },
    { label: "已收数量", value: row.p2pSummary.receivedQty },
    { label: "收货异常数", value: row.p2pSummary.receivingExceptionCount, tone: row.p2pSummary.receivingExceptionCount ? "warning" as const : "good" as const },
    { label: "Invoice 数量", value: row.p2pSummary.invoiceCount },
    { label: "发票差异数", value: row.p2pSummary.invoiceVarianceCount, tone: row.p2pSummary.invoiceVarianceCount ? "warning" as const : "good" as const },
    { label: "未开票金额", value: fmt(row.p2pSummary.uninvoicedAmount), tone: row.p2pSummary.uninvoicedAmount ? "warning" as const : "good" as const },
    { label: "已收未票金额", value: fmt(row.p2pSummary.receivedNotInvoicedAmount), tone: row.p2pSummary.receivedNotInvoicedAmount ? "warning" as const : "good" as const },
    { label: "三单匹配异常数", value: row.p2pSummary.matchExceptionCount, tone: row.p2pSummary.matchExceptionCount ? "warning" as const : "good" as const },
    { label: "最近交易日期", value: row.p2pSummary.latestTransactionDate },
  ];

  return (
    <BusinessObjectDetailModal
      open={Boolean(row)}
      onClose={onClose}
      title={copy("Supplier Operational Profile / 供应商运营档案")}
      subtitle={`${row.supplier.code} · ${row.supplier.name} · ${row.category}`}
      width={1360}
    >
      <div className="space-y-4">
        <RecoveryActions actions={returnActions} />

        <div className="flex flex-wrap items-center gap-2">
          <Chip label={row.operationalStatus} color={statusStyle(row.operationalStatus).color} bg={statusStyle(row.operationalStatus).bg} />
          <Chip label={`风险等级 ${row.supplier.riskStatus}`} color={statusStyle(row.supplier.riskStatus).color} bg={statusStyle(row.supplier.riskStatus).bg} />
          <Chip label={`仅内部复核评分 ${score.overall}`} color={overallStyle.color} bg={overallStyle.bg} />
        </div>

        <CompactKpiStrip items={[
          { label: "当前风险等级", value: row.supplier.riskStatus, tone: row.supplier.riskStatus === "高" ? "danger" : row.supplier.riskStatus === "中" ? "warning" : "good" },
          { label: "未完成 PO", value: `${row.p2pSummary.openPoCount} 单`, tone: row.p2pSummary.openPoCount ? "info" : "good" },
          { label: "发票差异", value: `${row.p2pSummary.invoiceVarianceCount} 张`, tone: row.p2pSummary.invoiceVarianceCount ? "warning" : "good" },
          { label: "已收未票金额", value: fmt(row.p2pSummary.receivedNotInvoicedAmount), tone: row.p2pSummary.receivedNotInvoicedAmount ? "warning" : "good" },
        ]} />

        <DetailSection title={copy("概览")}>
          <DetailFieldGrid fields={[
            { label: "Supplier ID", value: row.supplier.code },
            { label: "Supplier Name", value: row.supplier.name },
            { label: "状态", value: row.operationalStatus },
            { label: "供应商类型 / 品类", value: `${row.flag === "整改" ? "整改关注" : row.flag} / ${row.category}` },
            { label: "主要物料 / SKU", value: primarySku },
            { label: "主要联系人", value: row.supplier.contact },
            { label: "采购负责人", value: row.buyerOwner },
            { label: "付款条款，只读", value: row.supplier.paymentTerms },
            { label: "币种", value: row.supplier.currency },
            { label: "最近 RFQ", value: firstRfq?.id || "待补齐" },
            { label: "最近 PO", value: firstPo?.po || "待补齐" },
            { label: "最近收货", value: firstGrn?.grn || "待补齐" },
            { label: "最近发票", value: firstInvoice?.invoiceNumber || "待补齐" },
            { label: "当前风险等级", value: row.supplier.riskStatus, tone: row.supplier.riskStatus === "高" ? "danger" : row.supplier.riskStatus === "中" ? "warning" : "good" },
            { label: "当前下一步", value: row.nextAction, tone: "info" },
          ]} />
        </DetailSection>

        <DetailSection title="P2P Summary">
          <DetailFieldGrid fields={p2pFields} />
        </DetailSection>

        <DetailSection title={copy("相关 RFQ / Quote")}>
          <SimpleTable
            rows={row.relatedRfqs}
            columns={[
              { key: "rfq", label: "RFQ 编号", render: (rfq) => rfq.id },
              { key: "source", label: "来源 PR", render: (rfq) => `PR-${rfq.id.replace("RFQ-", "")}` },
              { key: "category", label: "品类 / SKU", render: (rfq) => `${rfq.category} / ${primarySku}` },
              { key: "quoteStatus", label: "报价状态", render: (rfq) => rfq.status },
              { key: "quoteTotal", label: "报价总额", render: (rfq) => fmt(rfq.bestPrice * Math.max(1, rfq.quoted) * 1000) },
              { key: "leadTime", label: "交期", render: (rfq, index) => `${10 + index * 2} 天` },
              { key: "moq", label: "MOQ", render: (_rfq, index) => `${100 + index * 50}` },
              { key: "terms", label: "付款条款", render: () => row.supplier.paymentTerms },
              { key: "recommendation", label: "推荐结果", render: (rfq) => rfq.bestSupplier === row.supplier.name ? "入选授标建议草稿" : "待比较" },
              { key: "award", label: "是否入选授标建议草稿", render: (rfq) => rfq.bestSupplier === row.supplier.name ? "是" : "待复核" },
              { key: "risk", label: "风险提示", render: (rfq) => rfq.quoted < rfq.suppliers ? "报价样本未满" : "低风险" },
              { key: "action", label: "操作", render: (rfq) => (
                <div className="flex gap-1.5">
                  <NavigationButton onClick={() => go("procurement:rfq", { entityType: "rfq", entityId: rfq.id }, rfq.id)}>{copy("查看 RFQ")}</NavigationButton>
                  <NavigationButton onClick={() => go("procurement:rfq", { entityType: "rfq", entityId: rfq.id }, rfq.id)}>{copy("查看报价比较")}</NavigationButton>
                  <NavigationButton onClick={() => preview("授标建议草稿", "仅打开内部复核草稿，不生成正式 PO。")}>{copy("查看授标建议草稿")}</NavigationButton>
                </div>
              ) },
            ]}
          />
        </DetailSection>

        <DetailSection title={copy("相关 PO")}>
          <SimpleTable
            rows={row.relatedPurchaseOrders}
            columns={[
              { key: "po", label: "PO 编号", render: (po) => po.po },
              { key: "pr", label: "来源 PR", render: (po) => compactText(po.sourceRequest) },
              { key: "rfq", label: "来源 RFQ", render: (po) => compactText(po.sourceRfq) },
              { key: "status", label: "PO 状态", render: (po) => <Chip label={po.status} color={statusStyle(po.status).color} bg={statusStyle(po.status).bg} /> },
              { key: "amount", label: "PO 金额", render: (po) => fmt(po.amount), align: "right" },
              { key: "eta", label: "ETA / 预计到货", render: (po) => po.eta },
              { key: "receipt", label: "收货状态", render: (po) => po.received > 0 ? "部分或完成收货" : "待收货" },
              { key: "invoice", label: "发票状态", render: (po) => row.relatedInvoices.some((invoice) => invoice.relatedPo === po.po) ? "已有关联发票" : "未开票" },
              { key: "match", label: "三单匹配状态", render: (po) => {
                const invoice = row.relatedInvoices.find((item) => item.relatedPo === po.po);
                return invoice?.matchStatus || "待匹配";
              } },
              { key: "next", label: "当前下一步", render: (po) => po.received < po.items ? "跟进收货证据" : "复核发票匹配" },
              { key: "action", label: "操作", render: (po) => (
                <div className="flex gap-1.5">
                  <NavigationButton onClick={() => go("procurement:orders", { entityType: "purchase_order", entityId: po.po }, po.po)}>{copy("查看 PO")}</NavigationButton>
                  <NavigationButton onClick={() => go("procurement:orders", { entityType: "purchase_order", entityId: po.po }, po.po)}>{copy("查看 PO Line")}</NavigationButton>
                  <NavigationButton onClick={() => go("procurement:receiving", { entityType: "receiving_doc", entityId: row.relatedReceivingDocs.find((doc) => doc.po === po.po)?.grn || "" }, po.po)}>{copy("查看收货记录")}</NavigationButton>
                  <NavigationButton onClick={() => go("procurement:invoices", { entityType: "supplier_invoice", entityId: row.relatedInvoices.find((invoice) => invoice.relatedPo === po.po)?.invoiceNumber || "" }, po.po)}>{copy("查看发票记录")}</NavigationButton>
                  <NavigationButton onClick={() => go("procurement:match")}>{copy("查看三单匹配")}</NavigationButton>
                </div>
              ) },
            ]}
          />
        </DetailSection>

        <DetailSection title={copy("收货 / GRN 表现")}>
          <DetailFieldGrid fields={[
            { label: "准时收货率", value: percent(row.p2pSummary.onTimeReceiptRate), tone: row.p2pSummary.onTimeReceiptRate < 90 ? "warning" : "good" },
            { label: "异常收货数", value: row.p2pSummary.receivingExceptionCount, tone: row.p2pSummary.receivingExceptionCount ? "warning" : "good" },
            { label: "拒收数量", value: row.p2pSummary.rejectedQty, tone: row.p2pSummary.rejectedQty ? "warning" : "good" },
            { label: "最近一次异常", value: row.relatedReceivingDocs.find((doc) => doc.status === "异常处理" || doc.failed > 0)?.grn || "暂无异常" },
            { label: "需要人工复核的问题", value: row.p2pSummary.receivingExceptionCount ? "质检异常与发票匹配影响" : "暂无明显问题" },
          ]} />
          <div className="mt-3">
            <SimpleTable
              rows={row.relatedReceivingDocs.flatMap((grn) => grnLinesOf(grn).map((line) => ({ grn, line })))}
              columns={[
                { key: "grn", label: "GRN / Receipt 编号", render: ({ grn }) => grn.grn },
                { key: "line", label: "GRN Line", render: ({ line }, index) => compactText(line.grnLineId, `GRN Line ${index + 1}`) },
                { key: "po", label: "PO 编号", render: ({ grn }) => grn.po },
                { key: "poLine", label: "PO Line", render: ({ line }) => compactText(line.poLineId) },
                { key: "sku", label: "SKU", render: ({ line }) => line.sku },
                { key: "received", label: "收货数量", render: ({ line }) => line.receivedQty, align: "right" },
                { key: "rejected", label: "拒收数量", render: ({ line }) => line.rejectedQty, align: "right" },
                { key: "date", label: "收货日期", render: ({ grn }) => grn.arrived },
                { key: "receiver", label: "Receiver", render: ({ grn }) => compactText(grn.receiver) },
                { key: "status", label: "收货状态", render: ({ grn }) => grn.status },
                { key: "qc", label: "质检 / 异常状态", render: ({ grn, line }) => line.rejectedQty > 0 || grn.failed > 0 ? "质检异常" : grn.status === "质检中" ? "质检中" : "通过" },
                { key: "impact", label: "是否影响发票匹配", render: ({ grn }) => row.relatedInvoices.some((invoice) => invoice.relatedGrn === grn.grn) ? "影响发票匹配" : "待发票匹配" },
                { key: "note", label: "行级备注", render: ({ line }) => line.rejectedQty > 0 ? "拒收需人工复核" : "只读收货证据" },
              ]}
            />
          </div>
        </DetailSection>

        <DetailSection title={copy("发票 / 三单匹配")}>
          <DetailFieldGrid fields={[
            { label: "发票数量", value: row.p2pSummary.invoiceCount },
            { label: "发票总额", value: fmt(row.p2pSummary.invoiceTotalAmount) },
            { label: "差异发票数", value: row.p2pSummary.invoiceVarianceCount, tone: row.p2pSummary.invoiceVarianceCount ? "warning" : "good" },
            { label: "价格差异金额", value: fmt(row.p2pSummary.priceVarianceAmount), tone: row.p2pSummary.priceVarianceAmount ? "warning" : "good" },
            { label: "数量差异金额", value: fmt(row.p2pSummary.quantityVarianceAmount), tone: row.p2pSummary.quantityVarianceAmount ? "warning" : "good" },
            { label: "已收未票金额", value: fmt(row.p2pSummary.receivedNotInvoicedAmount), tone: row.p2pSummary.receivedNotInvoicedAmount ? "warning" : "good" },
            { label: "未开票金额", value: fmt(row.p2pSummary.uninvoicedAmount), tone: row.p2pSummary.uninvoicedAmount ? "warning" : "good" },
          ]} />
          <div className="mt-3">
            <SimpleTable
              rows={row.relatedInvoices.flatMap((invoice) => invoice.lines.map((line) => ({ invoice, line })))}
              columns={[
                { key: "invoice", label: "Invoice 编号", render: ({ invoice }) => invoice.invoiceNumber },
                { key: "invoiceLine", label: "Invoice Line", render: ({ line }) => line.lineId },
                { key: "po", label: "PO 编号", render: ({ invoice }) => invoice.relatedPo },
                { key: "poLine", label: "PO Line", render: ({ line }) => compactText(line.poLine) },
                { key: "grnLine", label: "GRN Line", render: ({ line }) => compactText(line.grnLine) },
                { key: "sku", label: "SKU", render: ({ line }) => line.sku },
                { key: "amount", label: "发票金额", render: ({ line }) => fmt(line.lineSubtotal), align: "right" },
                { key: "tax", label: "税额", render: ({ line }) => fmt(line.taxAmount), align: "right" },
                { key: "total", label: "总额", render: ({ line }) => fmt(line.lineTotal), align: "right" },
                { key: "match", label: "匹配状态", render: ({ invoice }) => invoice.matchStatus },
                { key: "varianceType", label: "差异类型", render: ({ line, invoice }) => line.varianceType || invoice.varianceType },
                { key: "variance", label: "差异金额", render: ({ line, invoice }) => fmt(line.varianceAmount ?? invoice.varianceAmount), align: "right" },
                { key: "due", label: "到期日", render: ({ invoice }) => invoice.dueDate },
                { key: "risk", label: "当前风险", render: ({ line, invoice }) => (line.varianceType || invoice.varianceType) === "无差异" ? "低风险" : "需人工复核" },
                { key: "action", label: "建议处理", render: ({ line, invoice }) => (line.varianceType || invoice.varianceType) === "无差异" ? "留存匹配证据" : "复核差异说明草稿" },
              ]}
            />
          </div>
        </DetailSection>

        <DetailSection title={copy("已收未票 / 未开票风险")}>
          <SimpleTable
            rows={uninvoicedRows}
            columns={[
              { key: "po", label: "PO 编号", render: (item) => item.po },
              { key: "poLine", label: "PO Line", render: (item) => item.poLine },
              { key: "sku", label: "SKU", render: (item) => item.sku },
              { key: "received", label: "已收数量", render: (item) => item.receivedQty, align: "right" },
              { key: "invoice", label: "已开票数量", render: (item) => item.invoiceQty, align: "right" },
              { key: "open", label: "未开票数量", render: (item) => item.uninvoicedQty, align: "right" },
              { key: "amount", label: "已收未票金额", render: (item) => fmt(item.amount), align: "right" },
              { key: "risk", label: "已收未票风险", render: (item) => item.risk },
              { key: "action", label: "建议动作", render: (item) => item.action },
            ]}
          />
        </DetailSection>

        <DetailSection title={copy("风险信号")}>
          <SimpleTable
            rows={row.riskSignals}
            columns={[
              { key: "name", label: "风险名称", render: (item) => item.name },
              { key: "level", label: "风险等级", render: (item) => <Chip label={item.level} color={statusStyle(item.level).color} bg={statusStyle(item.level).bg} /> },
              { key: "evidence", label: "证据来源", render: (item) => item.evidence },
              { key: "impact", label: "业务影响", render: (item) => item.impact },
              { key: "action", label: "建议动作", render: (item) => item.action },
              { key: "limitation", label: "数据限制", render: (item) => item.limitation },
            ]}
          />
        </DetailSection>

        <DetailSection title={copy("绩效指标")}>
          <DetailFieldGrid fields={[
            { label: "RFQ 响应率", value: percent(row.p2pSummary.quoteResponseRate), tone: row.p2pSummary.quoteResponseRate < 90 ? "warning" : "good" },
            { label: "平均报价交期", value: row.relatedRfqs.length ? `${Math.round(12 + row.relatedRfqs.length)} 天` : "待补齐" },
            { label: "平均付款条款", value: row.supplier.paymentTerms },
            { label: "PO 完成率", value: row.p2pSummary.poCount ? percent(((row.p2pSummary.poCount - row.p2pSummary.openPoCount) / row.p2pSummary.poCount) * 100) : "100%" },
            { label: "准时到货率", value: percent(row.p2pSummary.onTimeReceiptRate), tone: row.p2pSummary.onTimeReceiptRate < 90 ? "warning" : "good" },
            { label: "收货异常率", value: percent(row.p2pSummary.receivingExceptionRate), tone: row.p2pSummary.receivingExceptionRate ? "warning" : "good" },
            { label: "发票匹配率", value: percent(row.p2pSummary.invoiceMatchRate), tone: row.p2pSummary.invoiceMatchRate < 90 ? "warning" : "good" },
            { label: "差异金额", value: fmt(row.p2pSummary.priceVarianceAmount + row.p2pSummary.quantityVarianceAmount), tone: row.p2pSummary.priceVarianceAmount + row.p2pSummary.quantityVarianceAmount ? "warning" : "good" },
            { label: "已收未票金额", value: fmt(row.p2pSummary.receivedNotInvoicedAmount), tone: row.p2pSummary.receivedNotInvoicedAmount ? "warning" : "good" },
            { label: "最近交易活跃度", value: row.p2pSummary.latestTransactionDate },
            { label: "供应商运营评分", value: `${score.overall} / 内部复核`, tone: score.overall < 65 ? "danger" : score.overall < 85 ? "warning" : "good" },
          ]} />
          <div className="mt-3 rounded-lg p-3 text-[11px] leading-5" style={{ background: A.white, color: A.sub }}>
            {copy("当前评分仅用于内部复核，不会自动影响供应商状态，不会改写供应商资料，也不会触发外部通知。")}
          </div>
        </DetailSection>

        <DetailSection title={copy("联系人与地址，只读")}>
          <DetailFieldGrid fields={[
            { label: "联系人姓名", value: row.supplier.contact },
            { label: "职务", value: "销售 / 客户经理" },
            { label: "邮箱", value: row.supplier.email },
            { label: "电话", value: row.supplier.phone },
            { label: "地址", value: row.supplier.phone.startsWith("021") ? "上海市供应商登记地址" : row.supplier.phone.startsWith("0755") || row.supplier.phone.startsWith("020") || row.supplier.phone.startsWith("0757") ? "华南供应商登记地址" : "华东供应商登记地址" },
            { label: "供应地点", value: row.relatedReceivingDocs[0]?.warehouse || "待补齐" },
            { label: "主要品类", value: row.category },
          ]} />
        </DetailSection>

        <DetailSection title={copy("证书 / 合规占位，只读")}>
          <SimpleTable
            rows={[
              { name: "营业执照", date: "2026-12-31", status: row.supplier.certificationStatus, complete: row.supplier.certificationStatus === "已认证" ? "完整" : "待补齐", missing: row.supplier.certificationStatus === "已认证" ? "无" : "证照影像与年审日期" },
              { name: "质量体系认证", date: "2026-09-30", status: row.supplier.certificationStatus === "整改中" ? "需复核" : "有效", complete: row.supplier.certificationStatus === "已认证" ? "完整" : "部分缺失", missing: row.supplier.certificationStatus === "已认证" ? "无" : "质量体系文件" },
            ]}
            columns={[
              { key: "name", label: "证书名称", render: (item) => item.name },
              { key: "date", label: "到期日期", render: (item) => item.date },
              { key: "status", label: "状态", render: (item) => item.status },
              { key: "complete", label: "数据是否完整", render: (item) => item.complete },
              { key: "missing", label: "需要补充的信息", render: (item) => item.missing },
            ]}
          />
        </DetailSection>

        <DetailSection title={copy("评论与附件")}>
          <div className="grid grid-cols-3 gap-3 text-[11px] leading-5" style={{ color: A.sub }}>
            <div className="rounded-lg p-3" style={{ background: A.white }}>采购负责人备注：{row.nextAction}。</div>
            <div className="rounded-lg p-3" style={{ background: A.white }}>{copy("附件占位：报价比较、收货异常说明、发票差异说明均以只读引用展示。")}</div>
            <div className="rounded-lg p-3" style={{ background: A.white }}>{copy("协同边界：当前仅生成内部草稿或预览。")}</div>
          </div>
        </DetailSection>

        <DetailSection title={copy("历史记录")}>
          <SimpleTable
            rows={[
              { time: row.p2pSummary.latestTransactionDate, event: "读取最近交易证据", owner: row.buyerOwner, note: "RFQ / PO / GRN / Invoice 运营证据已汇总" },
              { time: "当前视图", event: "生成运营档案预览", owner: "系统辅助", note: "仅用于内部复核和下一步判断" },
            ]}
            columns={[
              { key: "time", label: "时间", render: (item) => item.time },
              { key: "event", label: "事件", render: (item) => item.event },
              { key: "owner", label: "负责人", render: (item) => item.owner },
              { key: "note", label: "备注", render: (item) => item.note },
            ]}
          />
        </DetailSection>

        <EvidenceSummaryPanel groups={[
          { label: "相关 RFQ / Quote", value: `${row.p2pSummary.rfqCount} 个 RFQ，报价响应率 ${percent(row.p2pSummary.quoteResponseRate)}` },
          { label: "相关 PO", value: `${row.p2pSummary.poCount} 张 PO，未完成 ${row.p2pSummary.openPoCount} 张` },
          { label: "GRN / 收货证据", value: `${row.relatedReceivingDocs.length} 条收货记录，异常 ${row.p2pSummary.receivingExceptionCount} 条`, tone: row.p2pSummary.receivingExceptionCount ? "warning" : "good" },
          { label: "Invoice / 三单匹配", value: `${row.p2pSummary.invoiceCount} 张发票，匹配异常 ${row.p2pSummary.matchExceptionCount} 条`, tone: row.p2pSummary.matchExceptionCount ? "warning" : "good" },
          { label: "AI 协同解释", value: `结论：${row.nextAction}；关键证据来自 RFQ、PO、GRN、Invoice 与差异金额；建议先人工复核。`, tone: "info" },
          { label: "可点击跳转", value: "使用顶部返回路径或表格内查看按钮进入相关业务对象。", tone: "info" },
        ]} />

        <DataLimitationsPanel
          items={[
            "workspace_scope",
            "partial_contact_certification",
            "read_only_supplier_profile",
            "internal_review_score",
            "no_accounting_entry",
          ]}
          labelFor={(item) => ({
            workspace_scope: "当前仅基于工作区内 Supplier、RFQ、PO、GRN 和发票记录判断。",
            partial_contact_certification: "部分联系人、地址、证书和历史履约记录可能尚未完整读取。",
            read_only_supplier_profile: "当前只读展示供应商资料、付款条款和联系方式，不外发通知。",
            internal_review_score: "风险信号和运营评分仅用于内部复核，不会自动改变供应商状态。",
            no_accounting_entry: "已收未票、未开票和差异金额仅用于采购与财务协同可见性，不形成会计分录。",
          } as Record<string, string>)[item] || item}
        />

        <DetailSection title={copy("内部草稿动作")}>
          <div className="grid grid-cols-4 gap-2">
            <button type="button" onClick={() => preview("内部复核备注草稿", "仅保存为负责人复核前的说明，不改业务记录。")} className="h-9 rounded-lg text-xs font-semibold" style={{ background: "#f0f6ff", color: A.blue }}>{copy("生成内部复核备注草稿")}</button>
            <button type="button" onClick={() => preview("供应商风险说明草稿", "只解释证据和影响，不发布风险评级。")} className="h-9 rounded-lg text-xs font-semibold" style={{ background: "#fff8f0", color: A.orange }}>{copy("生成供应商风险说明草稿")}</button>
            <button type="button" onClick={() => preview("供应商沟通草稿", "仅用于内部预览，不会外发。")} className="h-9 rounded-lg text-xs font-semibold" style={{ background: A.gray6, color: A.label }}>{copy("生成供应商沟通草稿")}</button>
            <button type="button" onClick={() => preview("需人工复核预览", "只标记复核建议，不改变当前状态。")} className="h-9 rounded-lg text-xs font-semibold" style={{ background: "#f0faf4", color: A.green }}>{copy("标记需人工复核预览")}</button>
          </div>
          {previewMessage && (
            <div className="mt-3 rounded-lg px-3 py-2 text-[11px] leading-5" style={{ background: A.white, color: A.green }}>
              {previewMessage}
            </div>
          )}
        </DetailSection>

        <ReviewActionPanel objectLabel={`供应商 ${row.supplier.code}`} />
      </div>
    </BusinessObjectDetailModal>
  );
}
