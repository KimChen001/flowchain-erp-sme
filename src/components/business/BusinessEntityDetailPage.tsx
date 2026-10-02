import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock3, FileText } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { AppRouteDefinition } from "../../app/routeRegistry";
import { apiJson } from "../../lib/api-client";
import { formatLocaleAmount } from "../../lib/format";
import { useI18n } from "../../i18n/I18n";
import { DELIVERY_NOTES } from "../../modules/sales/deliveryData";
import { SIGN_RECEIPTS } from "../../modules/sales/receiptData";
import { INVENTORY_ADJUSTMENTS } from "../../modules/inventory/adjustmentData";
import { A, Card, Chip, SectionHeader } from "../ui";
import { BusinessEntityLink } from "./BusinessEntityLink";
import { businessEntityCopy } from "./businessEntityCopy";
import { businessEntityRouteRegistry, type BusinessEntityType } from "./businessEntityRoutes";

type RecordValue = Record<string, unknown>;

// Field labels as [English, Chinese]. Display only; record keys and values are never translated.
const LABELS: Record<string, [string, string]> = {
  id: ["System ID", "系统 ID"], pr: ["Purchase request", "采购申请编号"], po: ["PO number", "PO 编号"], grn: ["GRN number", "GRN 编号"],
  invoice: ["Invoice number", "发票编号"], invoiceNumber: ["Invoice number", "发票编号"], matchId: ["Match number", "匹配号"],
  statementNo: ["Statement number", "对账单号"], settlementNo: ["Settlement number", "结算单号"], supplier: ["Supplier", "供应商"],
  supplierCode: ["Supplier code", "供应商编号"], code: ["Code", "编号"], name: ["Name", "名称"], type: ["Type", "类型"],
  created: ["Created", "创建日期"], createdAt: ["Created", "创建时间"], updatedAt: ["Last updated", "最近更新时间"],
  createdDate: ["Created", "创建日期"], confirmedDate: ["Confirmed", "确认日期"], settlementDate: ["Settlement date", "结算日期"],
  invoiceDate: ["Invoice date", "发票日期"], dueDate: ["Due date", "到期日期"], periodStart: ["Period start", "对账开始"],
  periodEnd: ["Period end", "对账结束"], currency: ["Currency", "币种"], defaultCurrency: ["Default currency", "默认币种"],
  status: ["Status", "状态"], matchStatus: ["Match status", "匹配状态"], settlementStatus: ["Settlement status", "结算状态"],
  owner: ["Owner", "负责人"], requester: ["Requester", "申请人"], buyer: ["Buyer", "采购负责人"],
  amount: ["Amount", "金额"], subtotal: ["Subtotal", "税前金额"], tax: ["Tax", "税额"], total: ["Total", "含税金额"],
  poAmount: ["PO amount", "PO 金额"], grnAmount: ["GRN amount", "GRN 金额"], invoiceAmount: ["Invoice amount", "发票金额"],
  orderedQuantity: ["Ordered quantity", "订购数量"], receivedQuantity: ["Received quantity", "收货数量"], invoiceQuantity: ["Invoiced quantity", "发票数量"],
  poUnitPrice: ["PO unit price", "PO 单价"], invoiceUnitPrice: ["Invoice unit price", "发票单价"], priceVariance: ["Price variance", "价格差异"],
  quantityVariance: ["Quantity variance", "数量差异"], taxVariance: ["Tax variance", "税额差异"], freightVariance: ["Freight variance", "运费差异"],
  totalVariance: ["Total variance", "总差异"], toleranceRule: ["Tolerance rule", "容差规则"], comments: ["Comments", "备注"], notes: ["Comments", "备注"],
  relatedPo: ["PO", "PO"], relatedGrn: ["GRN", "GRN"], reconciliationStatement: ["Statement", "对账单"], invoiceAmountTotal: ["Invoice amount", "发票金额"],
  creditAmount: ["Credit amount", "贷项金额"], adjustmentAmount: ["Adjustment amount", "调整金额"], actualSettlementAmount: ["Settled amount", "实际结算金额"],
  totalInvoiceAmount: ["Invoice amount", "发票金额"], totalPayableAmount: ["Payable amount", "应付金额"], totalPaidAmount: ["Paid amount", "已付金额"],
  totalAdjustmentAmount: ["Adjustment amount", "调整金额"], totalVarianceAmount: ["Variance amount", "差异金额"], openBalance: ["Open balance", "期初/未结余额"],
  dueAmount: ["Amount due", "到期应付"], overdueAmount: ["Overdue amount", "逾期金额"],
  label: ["Name", "名称"], rate: ["Rate", "税率"], taxType: ["Tax type", "税种"], region: ["Region", "地区"],
  isDefault: ["Default", "默认"], days: ["Days", "天数"], contact: ["Contact", "联系人"], phone: ["Phone", "电话"],
  email: ["Email", "邮箱"], address: ["Address", "地址"], paymentTerms: ["Payment terms", "付款条款"], creditStatus: ["Credit status", "信用状态"],
};

// Internal bookkeeping fields that are not business information.
const HIDDEN_KEYS = new Set(["lines", "history", "invoices", "sourceType", "parentId"]);

// Stored codes shown as labels. The stored value itself is never changed.
const VALUE_LABELS: Record<string, [string, string]> = {
  active: ["Active", "启用"], inactive: ["Inactive", "停用"], draft: ["Draft", "草稿"], archived: ["Archived", "已归档"],
  sales_tax: ["Sales tax", "销售税"], vat: ["VAT", "增值税"], exempt: ["Exempt", "免税"], warehouse: ["Warehouse", "仓库"], bin: ["Location", "库位"],
};
const CODE_KEYS = new Set(["status", "matchStatus", "settlementStatus", "taxType", "type", "creditStatus"]);

const COPY = {
  yes: ["Yes", "是"], no: ["No", "否"], loading: ["Loading {label}…", "正在读取 {label}…"], notFound: ["{label} {id} was not found", "未找到 {label} {id}"],
  notFoundHint: ["This number does not exist, so it is shown as missing instead of as a link.", "该编号不存在，已按缺失对象处理，没有伪装为可用链接。"],
  related: ["Related records", "关联业务对象"], back: ["Back to {label} {id}", "返回 {label} {id}"], details: ["Details", "业务信息"],
  lines: ["Lines", "行级明细"], comments: ["Comments", "备注"], noComments: ["No comments.", "暂无备注。"], history: ["History", "操作历史"],
  noHistory: ["No history recorded for this record.", "暂无操作记录。"], historyUpdate: ["Status updated", "业务状态更新"], system: ["System", "系统"],
} satisfies Record<string, [string, string]>;

const MONEY_KEYS = /amount|subtotal|tax|total|balance|price|spend/i;
// Whole words only: "count" must not match discountAmount or accountBalance.
const NON_MONEY_WORDS = new Set(["rate", "percent", "percentage", "ratio", "quantity", "qty", "count"]);
const keyWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).map((word) => word.toLowerCase());
const NON_MONEY_KEYS = { test: (key: string) => keyWords(key).some((word) => NON_MONEY_WORDS.has(word)) };
type FormatContext = { locale: string; currency: string; zh: boolean };

function formatValue(key: string, value: unknown, { locale, currency, zh }: FormatContext) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return (value ? COPY.yes : COPY.no)[zh ? 1 : 0];
  // A tax rate is stored as a fraction (0.0825); show it as a percent without losing digits.
  if (key === "rate" && typeof value === "number") return value.toLocaleString(locale, { style: "percent", maximumFractionDigits: 4 });
  if (typeof value === "string" && CODE_KEYS.has(key) && VALUE_LABELS[value]) return VALUE_LABELS[value][zh ? 1 : 0];
  // Money shows a symbol only when the record carries its own currency.
  if (typeof value === "number") return MONEY_KEYS.test(key) && !NON_MONEY_KEYS.test(key)
    ? formatLocaleAmount(value, currency, locale, { maximumFractionDigits: 2 })
    : value.toLocaleString(locale, { maximumFractionDigits: 6 });
  if (Array.isArray(value)) return value.join(zh ? "、" : ", ") || "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function syncRecord(entityType: BusinessEntityType, id: string): RecordValue | null {
  const candidates: Partial<Record<BusinessEntityType, RecordValue[]>> = {
    delivery_note: DELIVERY_NOTES as unknown as RecordValue[],
    sign_receipt: SIGN_RECEIPTS as unknown as RecordValue[],
    inventory_adjustment: INVENTORY_ADJUSTMENTS as unknown as RecordValue[],
  };
  const keys: Partial<Record<BusinessEntityType, string[]>> = {
    rfq: ["id"], purchase_order: ["po", "id"], receiving_doc: ["grn", "id"], supplier_invoice: ["invoiceNumber", "id"],
    three_way_match: ["matchId", "id"], reconciliation_statement: ["statementNo", "id"], settlement_document: ["settlementNo", "id"],
    supplier: ["code", "name"], item: ["sku", "id"], customer: ["code", "name"], delivery_note: ["deliveryNo", "id"],
    sign_receipt: ["receiptNo", "id"], inventory_adjustment: ["adjustmentNo", "id"], credit_memo: ["creditMemoNo", "id"],
  };
  return candidates[entityType]?.find((row) => (keys[entityType] || ["id"]).some((key) => String(row[key] || "") === id)) || null;
}

function relatedLinks(entityType: BusinessEntityType, record: RecordValue) {
  const links: Array<{ type: BusinessEntityType; id: string; label: string }> = [];
  const add = (type: BusinessEntityType, id: unknown, label: string) => { if (typeof id === "string" && id && id !== "—") links.push({ type, id, label }); };
  add("supplier", record.supplierCode || record.supplier, businessEntityRouteRegistry.supplier.label);
  add("purchase_order", record.relatedPo || record.po, businessEntityRouteRegistry.purchase_order.label);
  add("receiving_doc", record.relatedGrn || record.grn, businessEntityRouteRegistry.receiving_doc.label);
  add("supplier_invoice", record.invoiceNumber || record.invoice, businessEntityRouteRegistry.supplier_invoice.label);
  add("reconciliation_statement", record.reconciliationStatement, "对账单");
  return links.filter((link, index, rows) => rows.findIndex((candidate) => candidate.type === link.type && candidate.id === link.id) === index);
}

export function BusinessEntityDetailPage({ route }: { route: AppRouteDefinition }) {
  const location = useLocation();
  const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) || "");
  const entityType = route.entityType as BusinessEntityType;
  const [params] = useSearchParams();
  const { locale, language } = useI18n();
  const zh = language === "zh-CN";
  const text = (key: keyof typeof COPY, vars: Record<string, string> = {}) =>
    Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, value), COPY[key][zh ? 1 : 0]);
  const fieldLabel = (key: string) => LABELS[key]?.[zh ? 1 : 0] || key;
  const [record, setRecord] = useState<RecordValue | null>(() => syncRecord(entityType, id));
  const masterDetailEndpoints: Partial<Record<BusinessEntityType, { url: string; key: string }>> = {
    item: { url: `/api/master-data/items/${encodeURIComponent(id)}`, key: "item" },
    supplier: { url: `/api/master-data/suppliers/${encodeURIComponent(id)}`, key: "supplier" },
    customer: { url: `/api/master-data/customers/${encodeURIComponent(id)}`, key: "customer" },
    warehouse: { url: `/api/master-data/warehouses/${encodeURIComponent(id)}`, key: "warehouse" },
    bin: { url: `/api/master-data/bins/${encodeURIComponent(id)}`, key: "warehouse" },
    payment_term: { url: `/api/master-data/payment-terms/${encodeURIComponent(id)}`, key: "paymentTerm" },
    tax_code: { url: `/api/master-data/tax-codes/${encodeURIComponent(id)}`, key: "taxCode" },
  };
  const [loading, setLoading] = useState(entityType === "purchase_request" || entityType === "sales_order" || Boolean(masterDetailEndpoints[entityType]));

  useEffect(() => {
    let active = true;
    if (entityType === "purchase_request") {
      apiJson<RecordValue[]>("/api/purchase-requests").then((payload) => {
        if (active) setRecord(payload.find((row) => String(row.pr || row.id) === id) || null);
      }).finally(() => { if (active) setLoading(false); });
    } else if (entityType === "sales_order") {
      apiJson<{ orders: RecordValue[] }>("/api/sales-demand/orders").then((payload) => {
        if (active) setRecord(payload.orders.find((row) => String(row.orderNo || row.id) === id) || null);
      }).finally(() => { if (active) setLoading(false); });
    } else if (masterDetailEndpoints[entityType]) {
      const endpoint = masterDetailEndpoints[entityType]!;
      apiJson<RecordValue>(endpoint.url).then((payload) => {
        if (active) setRecord((payload[endpoint.key] as RecordValue) || null);
      }).catch(() => { if (active) setRecord(null); }).finally(() => { if (active) setLoading(false); });
    } else {
      setRecord(syncRecord(entityType, id));
      setLoading(false);
    }
    return () => { active = false; };
  }, [entityType, id]);

  const routeInfo = businessEntityRouteRegistry[entityType];
  const requestedReturnTo = params.get("returnTo") || "";
  const returnTo = requestedReturnTo.startsWith("/app/") ? requestedReturnTo : routeInfo.listPath;
  const returnLabel = businessEntityCopy(params.get("returnLabel") || routeInfo.returnLabel, language);
  const entityLabel = businessEntityCopy(routeInfo.label, language);
  const lines = useMemo(() => Array.isArray(record?.lines) ? record?.lines as RecordValue[] : [], [record]);
  const history = useMemo(() => Array.isArray(record?.history) ? record?.history as RecordValue[] : [], [record]);
  const fields = useMemo(() => record ? Object.entries(record).filter(([key, value]) => !HIDDEN_KEYS.has(key) && typeof value !== "object") : [], [record]);
  const links = useMemo(() => record ? relatedLinks(entityType, record) : [], [entityType, record]);
  const recordCurrency = String(record?.currency || record?.defaultCurrency || "");

  if (loading) return <Card className="p-8" data-testid="business-entity-detail"><div className="animate-pulse text-sm" style={{ color: A.gray1 }}>{text("loading", { label: entityLabel })}</div></Card>;
  if (!record) return <Card className="p-8" data-testid="business-entity-detail"><Link to={returnTo} className="text-sm text-blue-600 hover:underline">← {returnLabel}</Link><h2 className="mt-5 text-lg font-semibold">{text("notFound", { label: entityLabel, id })}</h2><p className="mt-2 text-sm" style={{ color: A.gray1 }}>{text("notFoundHint")}</p></Card>;

  return (
    <div className="space-y-4" data-testid="business-entity-detail" data-entity-type={entityType}>
      <Link to={returnTo} className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded"><ArrowLeft size={15} />{returnLabel}</Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className="fc-caption" style={{ color: A.gray2 }}>{entityLabel}</div><h1 className="mt-1 text-xl font-semibold tabular-nums" style={{ color: A.label }}>{id}</h1></div>
          <Chip label={formatValue("status", record.status || record.matchStatus || record.settlementStatus || "active", { locale, currency: recordCurrency, zh })} color={A.blue} bg="#f0f6ff" />
        </div>
      </Card>

      {links.length > 0 && <Card className="p-5"><SectionHeader title={text("related")} /><div className="flex flex-wrap gap-2">{links.map((link) => <BusinessEntityLink key={`${link.type}-${link.id}`} entityType={link.type} entityId={link.id} returnLabel={text("back", { label: entityLabel, id })} className="inline-flex rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs">{businessEntityCopy(link.label, language)} · {link.id}</BusinessEntityLink>)}</div></Card>}

      <Card className="p-5"><SectionHeader title={text("details")} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{fields.map(([key, value]) => <div key={key} className="rounded-lg p-3" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{fieldLabel(key)}</div><div className="mt-1 break-words text-sm font-medium" style={{ color: A.label }}>{formatValue(key, value, { locale, currency: recordCurrency, zh })}</div></div>)}</div></Card>

      {lines.length > 0 && <Card><div className="px-5 pt-5"><SectionHeader title={text("lines")} /></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs"><thead><tr style={{ borderBottom: `1px solid ${A.border}` }}>{Object.keys(lines[0]).slice(0, 10).map((key) => <th key={key} className="px-4 py-3 text-left font-semibold whitespace-nowrap" style={{ color: A.gray1 }}>{fieldLabel(key)}</th>)}</tr></thead><tbody>{lines.map((line, index) => <tr key={String(line.lineId || index)} style={{ borderBottom: `1px solid ${A.border}` }}>{Object.keys(lines[0]).slice(0, 10).map((key) => <td key={key} className="px-4 py-3 whitespace-nowrap" style={{ color: A.label }}>{formatValue(key, line[key], { locale, currency: String(line.currency || recordCurrency), zh })}</td>)}</tr>)}</tbody></table></div></Card>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5"><SectionHeader title={text("comments")} /><p className="text-sm leading-6" style={{ color: A.sub }}>{String(record.comments || record.notes || text("noComments"))}</p></Card>
        <Card className="p-5"><SectionHeader title={text("history")} />{history.length ? <div className="space-y-2">{history.map((item, index) => <div key={index} className="rounded-lg p-3 text-xs" style={{ background: A.gray6 }}><div className="font-semibold" style={{ color: A.label }}>{String(item.action || text("historyUpdate"))}</div><div className="mt-1" style={{ color: A.gray2 }}>{String(item.time || item.date || "—")} · {String(item.operator || record.owner || text("system"))}</div></div>)}</div> : <div className="rounded-lg p-3 text-xs" style={{ background: A.gray6, color: A.gray1 }}>{text("noHistory")}</div>}</Card>
      </div>
      <Link to={returnTo} className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:underline"><ArrowLeft size={15} />{returnLabel}</Link>
    </div>
  );
}
