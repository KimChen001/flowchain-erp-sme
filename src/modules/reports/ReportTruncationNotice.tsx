import { AlertTriangle, Info } from "lucide-react";
import { A, Card } from "../../components/ui";
import type { GovernedReport } from "./governedReports";

type Sentence = (limit: string) => string;
type Entry = NonNullable<GovernedReport["truncatedSubjects"]>[number];

// Documents are read newest first; master data is read in name or SKU order.
// The server names a subject only on the dashboards whose figures it changes.
const SUBJECT_COPY: Record<string, { en: Sentence; zh: Sentence }> = {
  purchase_orders: { en: n => `Showing the latest ${n} purchase orders.`, zh: n => `仅显示最新的 ${n} 张采购订单。` },
  receipts: { en: n => `Showing the latest ${n} receipts.`, zh: n => `仅显示最新的 ${n} 张收货单。` },
  supplier_invoices: { en: n => `Showing the latest ${n} supplier invoices.`, zh: n => `仅显示最新的 ${n} 张采购发票。` },
  sales_orders: { en: n => `Showing the latest ${n} sales orders.`, zh: n => `仅显示最新的 ${n} 张销售订单。` },
  purchase_requests: { en: n => `Showing the latest ${n} purchase requests.`, zh: n => `仅显示最新的 ${n} 张采购申请。` },
  rfqs: { en: n => `Showing the latest ${n} RFQs.`, zh: n => `仅显示最新的 ${n} 张询价单。` },
  suppliers: { en: n => `Showing the first ${n} suppliers by name.`, zh: n => `仅显示按名称排序的前 ${n} 个供应商。` },
  customers: { en: n => `Showing the first ${n} customers by name.`, zh: n => `仅显示按名称排序的前 ${n} 个客户。` },
  items: { en: n => `Showing the first ${n} items by SKU.`, zh: n => `仅显示按 SKU 排序的前 ${n} 个物料。` },
  inventory_items: { en: n => `Showing the first ${n} inventory records by SKU.`, zh: n => `仅显示按 SKU 排序的前 ${n} 条库存记录。` },
};
const OTHER_SUBJECT: { en: Sentence; zh: Sentence } = { en: n => `Showing only ${n} records of one data set.`, zh: n => `一类数据仅显示 ${n} 条记录。` };
const COPY = {
  en: {
    heading: "Not every record is included", incomplete: "Totals may be incomplete.",
    listedHeading: "The table lists the latest records",
    // The figures count every order; only the table and download are cut.
    salesComplete: (total: string, limit: string) => `The figures count all ${total} sales orders. The details table and the download list the latest ${limit}.`,
    salesDemand: (limit: string) => `Open demand counts only those ${limit} orders.`,
  },
  zh: {
    heading: "部分记录未纳入报表", incomplete: "合计可能不完整。",
    listedHeading: "明细表仅列出最新记录",
    salesComplete: (total: string, limit: string) => `各项数据统计了全部 ${total} 张销售订单；明细表和导出仅列出最新的 ${limit} 张。`,
    salesDemand: (limit: string) => `未履约需求仅统计这 ${limit} 张订单。`,
  },
};

const sentence = (entry: Entry, key: "en" | "zh", count: Intl.NumberFormat) => {
  const limit = count.format(entry.limit);
  if (entry.subject === "sales_orders" && entry.figuresComplete && Number.isFinite(entry.total)) {
    return [COPY[key].salesComplete(count.format(Number(entry.total)), limit), entry.openDemandComplete === false ? COPY[key].salesDemand(limit) : ""].filter(Boolean).join(" ");
  }
  return `${(SUBJECT_COPY[entry.subject] || OTHER_SUBJECT)[key](limit)} ${COPY[key].incomplete}`;
};

export function ReportTruncationNotice({ subjects, language, locale }: { subjects: GovernedReport["truncatedSubjects"]; language: string; locale: string }) {
  if (!subjects?.length) return null;
  const key = language === "zh-CN" ? "zh" : "en";
  const count = new Intl.NumberFormat(locale);
  // Only the table is cut: an information note, not a warning.
  const listedOnly = subjects.every(entry => entry.figuresComplete && entry.openDemandComplete !== false);
  const Icon = listedOnly ? Info : AlertTriangle;
  return <Card className="p-3" data-testid="reports-truncation-notice" data-figures-complete={listedOnly ? "true" : "false"} role="status">
    <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: listedOnly ? A.blue : A.orange }}><Icon size={14} aria-hidden="true" />{listedOnly ? COPY[key].listedHeading : COPY[key].heading}</div>
    <ul className="mt-1 space-y-0.5 text-xs" style={{ color: A.sub }}>
      {subjects.map(entry => <li key={entry.subject}>{sentence(entry, key, count)}</li>)}
    </ul>
  </Card>;
}
