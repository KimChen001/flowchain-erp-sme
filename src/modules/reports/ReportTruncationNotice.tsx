import { AlertTriangle } from "lucide-react";
import { A, Card } from "../../components/ui";
import type { GovernedReport } from "./governedReports";

type Sentence = (limit: string) => string;

// Documents are read newest first; master data is read in name or SKU order.
const SUBJECT_COPY: Record<string, { en: Sentence; zh: Sentence }> = {
  purchase_orders: { en: n => `Showing the latest ${n} purchase orders.`, zh: n => `仅显示最新的 ${n} 张采购订单。` },
  receipts: { en: n => `Showing the latest ${n} receipts.`, zh: n => `仅显示最新的 ${n} 张收货单。` },
  supplier_invoices: { en: n => `Showing the latest ${n} supplier invoices.`, zh: n => `仅显示最新的 ${n} 张供应商发票。` },
  sales_orders: { en: n => `Showing the latest ${n} sales orders.`, zh: n => `仅显示最新的 ${n} 张销售订单。` },
  purchase_requests: { en: n => `Showing the latest ${n} purchase requests.`, zh: n => `仅显示最新的 ${n} 张采购申请。` },
  rfqs: { en: n => `Showing the latest ${n} RFQs.`, zh: n => `仅显示最新的 ${n} 张询价单。` },
  suppliers: { en: n => `Showing the first ${n} suppliers by name.`, zh: n => `仅显示按名称排序的前 ${n} 个供应商。` },
  items: { en: n => `Showing the first ${n} items by SKU.`, zh: n => `仅显示按 SKU 排序的前 ${n} 个物料。` },
  inventory_items: { en: n => `Showing the first ${n} inventory records by SKU.`, zh: n => `仅显示按 SKU 排序的前 ${n} 条库存记录。` },
};
const OTHER_SUBJECT: { en: Sentence; zh: Sentence } = { en: n => `Showing only ${n} records of one data set.`, zh: n => `一类数据仅显示 ${n} 条记录。` };
const COPY = {
  en: { heading: "Not every record is included", incomplete: "Totals may be incomplete." },
  zh: { heading: "部分记录未纳入报表", incomplete: "合计可能不完整。" },
};

export function ReportTruncationNotice({ subjects, language, locale }: { subjects: GovernedReport["truncatedSubjects"]; language: string; locale: string }) {
  if (!subjects?.length) return null;
  const key = language === "zh-CN" ? "zh" : "en";
  const count = new Intl.NumberFormat(locale);
  return <Card className="p-3" data-testid="reports-truncation-notice" role="status">
    <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: A.orange }}><AlertTriangle size={14} aria-hidden="true" />{COPY[key].heading}</div>
    <ul className="mt-1 space-y-0.5 text-xs" style={{ color: A.sub }}>
      {subjects.map(entry => <li key={entry.subject}>{(SUBJECT_COPY[entry.subject] || OTHER_SUBJECT)[key](count.format(entry.limit))} {COPY[key].incomplete}</li>)}
    </ul>
  </Card>;
}
