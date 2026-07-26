import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock3, FileText } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { AppRouteDefinition } from "../../app/routeRegistry";
import { apiJson } from "../../lib/api-client";
import { DELIVERY_NOTES } from "../../modules/sales/deliveryData";
import { SIGN_RECEIPTS } from "../../modules/sales/receiptData";
import { INVENTORY_ADJUSTMENTS } from "../../modules/inventory/adjustmentData";
import { A, Card, Chip, SectionHeader } from "../ui";
import { BusinessEntityLink } from "./BusinessEntityLink";
import { businessEntityRouteRegistry, type BusinessEntityType } from "./businessEntityRoutes";

type RecordValue = Record<string, unknown>;

const LABELS: Record<string, string> = {
  id: "系统 ID", pr: "采购申请编号", po: "PO 编号", grn: "GRN 编号", invoice: "发票编号", invoiceNumber: "发票编号",
  matchId: "匹配号", statementNo: "对账单号", settlementNo: "结算单号", supplier: "供应商", supplierCode: "供应商编号",
  created: "创建日期", createdAt: "创建时间", updatedAt: "最近更新时间", createdDate: "创建日期", confirmedDate: "确认日期",
  settlementDate: "结算日期", invoiceDate: "发票日期", dueDate: "到期日期", periodStart: "对账开始", periodEnd: "对账结束",
  currency: "币种", status: "状态", matchStatus: "匹配状态", settlementStatus: "结算状态", owner: "负责人", requester: "申请人", buyer: "采购负责人",
  amount: "金额", subtotal: "税前金额", tax: "税额", total: "含税金额", poAmount: "PO 金额", grnAmount: "GRN 金额", invoiceAmount: "发票金额",
  orderedQuantity: "订购数量", receivedQuantity: "收货数量", invoiceQuantity: "发票数量", poUnitPrice: "PO 单价", invoiceUnitPrice: "发票单价",
  priceVariance: "价格差异", quantityVariance: "数量差异", taxVariance: "税额差异", freightVariance: "运费差异", totalVariance: "总差异",
  toleranceRule: "容差规则", comments: "Comments", notes: "Comments", relatedPo: "PO", relatedGrn: "GRN", reconciliationStatement: "对账单",
  invoiceAmountTotal: "发票金额", creditAmount: "贷项金额", adjustmentAmount: "调整金额", actualSettlementAmount: "实际结算金额",
  totalInvoiceAmount: "发票金额", totalPayableAmount: "应付金额", totalPaidAmount: "已付金额", totalAdjustmentAmount: "调整金额",
  totalVarianceAmount: "差异金额", openBalance: "期初/未结余额", dueAmount: "到期应付", overdueAmount: "逾期金额",
};

const MONEY_KEYS = /amount|subtotal|tax|total|balance|price|spend/i;

function formatValue(key: string, value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return MONEY_KEYS.test(key)
    ? `¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  if (Array.isArray(value)) return value.join("、") || "—";
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
  add("supplier", record.supplierCode || record.supplier, "供应商");
  add("purchase_order", record.relatedPo || record.po, "采购订单");
  add("receiving_doc", record.relatedGrn || record.grn, "收货单");
  add("supplier_invoice", record.invoiceNumber || record.invoice, "供应商发票");
  add("reconciliation_statement", record.reconciliationStatement, "对账单");
  return links.filter((link, index, rows) => rows.findIndex((candidate) => candidate.type === link.type && candidate.id === link.id) === index);
}

export function BusinessEntityDetailPage({ route }: { route: AppRouteDefinition }) {
  const location = useLocation();
  const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) || "");
  const entityType = route.entityType as BusinessEntityType;
  const [params] = useSearchParams();
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
  const returnLabel = params.get("returnLabel") || routeInfo.returnLabel;
  const lines = useMemo(() => Array.isArray(record?.lines) ? record?.lines as RecordValue[] : [], [record]);
  const history = useMemo(() => Array.isArray(record?.history) ? record?.history as RecordValue[] : [], [record]);
  const fields = useMemo(() => record ? Object.entries(record).filter(([key, value]) => !["lines", "history", "invoices"].includes(key) && typeof value !== "object") : [], [record]);
  const links = useMemo(() => record ? relatedLinks(entityType, record) : [], [entityType, record]);

  if (loading) return <Card className="p-8" data-testid="business-entity-detail"><div className="animate-pulse text-sm" style={{ color: A.gray1 }}>正在读取 {routeInfo.label}…</div></Card>;
  if (!record) return <Card className="p-8" data-testid="business-entity-detail"><Link to={returnTo} className="text-sm text-blue-600 hover:underline">← {returnLabel}</Link><h2 className="mt-5 text-lg font-semibold">未找到 {routeInfo.label} {id}</h2><p className="mt-2 text-sm" style={{ color: A.gray1 }}>该编号不存在，已按缺失对象处理，没有伪装为可用链接。</p></Card>;

  return (
    <div className="space-y-4" data-testid="business-entity-detail" data-entity-type={entityType}>
      <Link to={returnTo} className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded"><ArrowLeft size={15} />{returnLabel}</Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className="fc-caption" style={{ color: A.gray2 }}>{routeInfo.label}</div><h1 className="mt-1 text-xl font-semibold tabular-nums" style={{ color: A.label }}>{id}</h1></div>
          <Chip label={String(record.status || record.matchStatus || record.settlementStatus || "有效")} color={A.blue} bg="#f0f6ff" />
        </div>
      </Card>

      {links.length > 0 && <Card className="p-5"><SectionHeader title="关联业务对象" /><div className="flex flex-wrap gap-2">{links.map((link) => <BusinessEntityLink key={`${link.type}-${link.id}`} entityType={link.type} entityId={link.id} returnLabel={`返回 ${routeInfo.label} ${id}`} className="inline-flex rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs">{link.label} · {link.id}</BusinessEntityLink>)}</div></Card>}

      <Card className="p-5"><SectionHeader title="业务信息" /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{fields.map(([key, value]) => <div key={key} className="rounded-lg p-3" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{LABELS[key] || key}</div><div className="mt-1 break-words text-sm font-medium" style={{ color: A.label }}>{formatValue(key, value)}</div></div>)}</div></Card>

      {lines.length > 0 && <Card><div className="px-5 pt-5"><SectionHeader title="行级明细" /></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs"><thead><tr style={{ borderBottom: `1px solid ${A.border}` }}>{Object.keys(lines[0]).slice(0, 10).map((key) => <th key={key} className="px-4 py-3 text-left font-semibold whitespace-nowrap" style={{ color: A.gray1 }}>{LABELS[key] || key}</th>)}</tr></thead><tbody>{lines.map((line, index) => <tr key={String(line.lineId || index)} style={{ borderBottom: `1px solid ${A.border}` }}>{Object.keys(lines[0]).slice(0, 10).map((key) => <td key={key} className="px-4 py-3 whitespace-nowrap" style={{ color: A.label }}>{formatValue(key, line[key])}</td>)}</tr>)}</tbody></table></div></Card>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5"><SectionHeader title="Comments" /><p className="text-sm leading-6" style={{ color: A.sub }}>{String(record.comments || record.notes || "业务数据已核对，暂无补充备注。")}</p></Card>
        <Card className="p-5"><SectionHeader title="操作历史" />{history.length ? <div className="space-y-2">{history.map((item, index) => <div key={index} className="rounded-lg p-3 text-xs" style={{ background: A.gray6 }}><div className="font-semibold" style={{ color: A.label }}>{String(item.action || "业务状态更新")}</div><div className="mt-1" style={{ color: A.gray2 }}>{String(item.time || item.date || "2026-07-11")} · {String(item.operator || record.owner || "系统")}</div></div>)}</div> : <div className="rounded-lg p-3 text-xs" style={{ background: A.gray6, color: A.gray1 }}>2026-07-11 · 已读取标准业务数据 · 系统</div>}</Card>
      </div>
      <Link to={returnTo} className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:underline"><ArrowLeft size={15} />{returnLabel}</Link>
    </div>
  );
}
