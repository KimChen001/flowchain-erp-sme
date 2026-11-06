import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AlertTriangle, ClipboardList, FileClock, Truck } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, type StatusTone } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { POStatusPill } from "../purchasing/components/POStatusPill";
import { apiJson } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { formatLocaleAmount } from "../../lib/format";
import type {
  PurchaseOrder,
  PurchaseOrderLine,
  ReceivingDoc,
  ReceivingDocLine,
  SupplierInvoice,
  SupplierInvoiceLine,
} from "../../types/scm";

type PurchaseOrderWorkbenchPayload = {
  purchaseOrders?: PurchaseOrder[];
  receivingDocs?: ReceivingDoc[];
  supplierInvoices?: SupplierInvoice[];
};

type ReceivingEvidence = { document: ReceivingDoc; line: ReceivingDocLine };
type InvoiceEvidence = { invoice: SupplierInvoice; line: SupplierInvoiceLine };

export type OrderFulfillmentLine = {
  id: string;
  lineNumber: number;
  poId: string;
  // The order's document number (its id for orders made before numbering).
  poNumber: string;
  poStatus: string;
  supplier: string;
  supplierId?: string;
  sku: string;
  itemName: string;
  unit: string;
  orderedQuantity: number;
  receivedQuantity: number;
  invoicedQuantity: number;
  remainingToReceive: number;
  receivedNotInvoiced: number;
  lineAmount: number;
  currency: string;
  receivingEvidence: ReceivingEvidence[];
  invoiceEvidence: InvoiceEvidence[];
  varianceAmount: number;
  status: "待收货" | "部分收货" | "已收待票" | "已完成" | "数量待复核" | "发票差异";
};

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function fulfillmentStatus(input: {
  ordered: number;
  received: number;
  invoiced: number;
  variance: number;
}) {
  if (input.received > input.ordered || input.invoiced > input.received)
    return "数量待复核" as const;
  if (input.received <= 0) return "待收货" as const;
  if (input.received < input.ordered) return "部分收货" as const;
  if (input.invoiced < input.received) return "已收待票" as const;
  if (input.variance !== 0) return "发票差异" as const;
  return "已完成" as const;
}

export function buildOrderFulfillmentLines(
  payload: PurchaseOrderWorkbenchPayload,
): OrderFulfillmentLine[] {
  const receivingByPoLine = new Map<string, ReceivingEvidence[]>();
  for (const document of payload.receivingDocs || []) {
    for (const line of document.lines || []) {
      if (!line.poLineId) continue;
      receivingByPoLine.set(line.poLineId, [
        ...(receivingByPoLine.get(line.poLineId) || []),
        { document, line },
      ]);
    }
  }

  const invoicesByPoLine = new Map<string, InvoiceEvidence[]>();
  for (const invoice of payload.supplierInvoices || []) {
    for (const line of invoice.lines || []) {
      if (!line.poLine) continue;
      invoicesByPoLine.set(line.poLine, [
        ...(invoicesByPoLine.get(line.poLine) || []),
        { invoice, line },
      ]);
    }
  }

  return (payload.purchaseOrders || []).flatMap((order) =>
    (order.lines || []).map((line: PurchaseOrderLine, index) => {
      const ordered = number(line.quantityOrdered);
      const received = number(line.quantityReceived);
      const invoiceEvidence = invoicesByPoLine.get(line.poLineId) || [];
      const invoiced = invoiceEvidence.reduce(
        (sum, evidence) => sum + number(evidence.line.quantity),
        0,
      );
      const variance = invoiceEvidence.reduce(
        (sum, evidence) => sum + number(evidence.line.varianceAmount),
        0,
      );
      return {
        id: line.poLineId,
        lineNumber: index + 1,
        poId: order.po,
        poNumber: order.number || order.orderNumber || order.po,
        poStatus: order.status,
        supplier: order.supplier,
        supplierId: order.supplierId,
        sku: line.sku,
        itemName: line.itemName,
        unit: line.unit,
        orderedQuantity: ordered,
        receivedQuantity: received,
        invoicedQuantity: invoiced,
        remainingToReceive: Math.max(ordered - received, 0),
        receivedNotInvoiced: Math.max(received - invoiced, 0),
        lineAmount: number(line.unitPrice) * ordered,
        currency: line.currency || order.currency || "",
        receivingEvidence: receivingByPoLine.get(line.poLineId) || [],
        invoiceEvidence,
        varianceAmount: variance,
        status: fulfillmentStatus({ ordered, received, invoiced, variance }),
      };
    }),
  );
}

function quantity(value: number, unit: string, locale: string) {
  return `${value.toLocaleString(locale)} ${unit || ""}`.trim();
}

function money(value: number, currency: string, locale: string) {
  return formatLocaleAmount(value, currency, locale, { maximumFractionDigits: 2 });
}

// Brand tones, as on the purchase order list: blue while goods are on the
// way, orange while a received line waits for its invoice, red when a person
// must review, teal once done.
const FULFILLMENT_TONE: Record<OrderFulfillmentLine["status"], StatusTone> = {
  "待收货": "info",
  "部分收货": "info",
  "已收待票": "warning",
  "数量待复核": "danger",
  "发票差异": "danger",
  "已完成": "success",
};

const isClosedPo = (row: OrderFulfillmentLine) => ["cancelled", "closed", "已取消", "已关闭"].includes(row.poStatus);
const needsReview = (row: OrderFulfillmentLine) => row.varianceAmount !== 0 || row.status === "数量待复核";

// The views the metric cards and the view filter share, kept in the address.
const VIEWS = ["open", "partial", "uninvoiced", "exceptions", "all"] as const;
type View = (typeof VIEWS)[number];
const inView: Record<View, (row: OrderFulfillmentLine) => boolean> = {
  open: (row) => row.status !== "已完成" && !isClosedPo(row),
  partial: (row) => row.status === "部分收货",
  uninvoiced: (row) => row.receivedNotInvoiced > 0,
  exceptions: needsReview,
  all: () => true,
};

function SupplierDisplay({ row }: { row: OrderFulfillmentLine }) {
  if (!row.supplierId) return <>{row.supplier || "—"}</>;
  return (
    <BusinessEntityLink entityType="supplier" entityId={row.supplierId} className="!font-normal">
      {row.supplier || row.supplierId}
    </BusinessEntityLink>
  );
}

function EvidenceLinks({ row, type }: { row: OrderFulfillmentLine; type: "receiving" | "invoice" }) {
  const ids = type === "receiving"
    ? unique(row.receivingEvidence.map((entry) => entry.document.grn).filter(Boolean))
    : unique(row.invoiceEvidence.map((entry) => entry.invoice.id).filter(Boolean));
  if (ids.length === 0)
    return <span style={{ color: A.gray2 }}>—</span>;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
      {ids.map((id) => (
        <BusinessEntityLink
          key={id}
          entityType={type === "receiving" ? "receiving_doc" : "supplier_invoice"}
          entityId={id}
          className="!font-medium"
        >
          {id}
        </BusinessEntityLink>
      ))}
    </div>
  );
}

export function OrderFulfillmentLinesPage() {
  const copy = useWorkspaceCopy();
  const { locale, language } = useI18n();
  const say = (en: string, zh: string) => (language === "en-US" ? en : zh);
  const [payload, setPayload] = useState<PurchaseOrderWorkbenchPayload>({});
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [supplier, setSupplier] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("view") as View | null;
  const view: View = requestedView && VIEWS.includes(requestedView) ? requestedView : "open";
  const setView = (next: View) => {
    const params = new URLSearchParams(searchParams);
    if (next === "open") params.delete("view"); else params.set("view", next);
    setSearchParams(params, { replace: true });
  };

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setPayload(await apiJson<PurchaseOrderWorkbenchPayload>("/api/purchase-orders-workbench"));
      setState("loaded");
    } catch (nextError) {
      setPayload({});
      setError(nextError instanceof Error ? nextError.message : "采购订单履约数据不可用");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => buildOrderFulfillmentLines(payload), [payload]);
  const suppliers = useMemo(() => unique(rows.map((row) => row.supplier).filter(Boolean)).sort(), [rows]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (!inView[view](row)) return false;
      if (supplier && row.supplier !== supplier) return false;
      if (!normalized) return true;
      return [row.poNumber, row.poId, row.id, row.supplier, row.sku, row.itemName]
        .some((value) => String(value || "").toLowerCase().includes(normalized));
    });
  }, [query, rows, supplier, view]);

  const count = (next: View) => (state === "loaded" ? String(rows.filter(inView[next]).length) : "—");
  const reset = () => {
    setQuery("");
    setSupplier("");
    setView("open");
  };
  const columns = 10;
  const headClass = `${thClass} !px-3 align-bottom`;
  // Number headers wrap ("Received, not invoiced"), so the columns are as wide as their numbers.
  const headRightClass = `${thRightClass} !px-3 !whitespace-normal align-bottom max-w-[96px] leading-tight`;
  const cellClass = "px-3 py-3 whitespace-nowrap";
  const numberClass = "px-3 py-3 whitespace-nowrap text-right tabular-nums";

  return (
    <div className="space-y-5" data-testid="procurement-order-fulfillment-lines">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={say("Open order lines", "未完成订单行")} value={count("open")} description={say("Lines still to receive or invoice", "仍待收货或开票的订单行")} to="/app/procurement/order-lines" icon={ClipboardList} color={A.blue} />
        <ActionableMetricCard label={say("Partially received", "部分收货")} value={count("partial")} description={say("Some quantity has arrived", "已到货一部分")} to="/app/procurement/order-lines?view=partial" icon={Truck} color={A.purple} />
        <ActionableMetricCard label={say("Received, not invoiced", "已收未票")} value={count("uninvoiced")} description={say("Waiting for the supplier invoice", "等待供应商发票")} to="/app/procurement/order-lines?view=uninvoiced" icon={FileClock} color={A.orange} />
        <ActionableMetricCard label={say("Review required", "需要复核")} value={count("exceptions")} description={say("Quantity or amount does not match", "数量或金额对不上")} to="/app/procurement/order-lines?view=exceptions" icon={AlertTriangle} color={A.red} />
      </div>

      <ListSearchCard
        title={say("Order line search", "订单行查询")}
        subtitle={say(
          "Each purchase order line with what was received and invoiced against it. Select a number to open the order, receipt or invoice.",
          "每条采购订单行的收货和开票情况。点击编号可打开订单、收货单或发票。",
        )}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => void load()} />
        </>}
      >
        <Field label={say("Search", "搜索")}>
          <input
            aria-label={say("Search order lines", "搜索订单行")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy("搜索 PO、供应商、SKU 或物料")}
            style={inputStyle}
          />
        </Field>
        <Field label={say("View", "视图")}>
          <select aria-label={copy("履约视图")} value={view} onChange={(event) => setView(event.target.value as View)} style={inputStyle}>
            <option value="open">{copy("未完成履约")}</option>
            <option value="partial">{say("Partially received", "部分收货")}</option>
            <option value="uninvoiced">{say("Received, not invoiced", "已收未票")}</option>
            <option value="exceptions">{copy("需要复核")}</option>
            <option value="all">{copy("全部订单行")}</option>
          </select>
        </Field>
        <Field label={say("Supplier", "供应商")}>
          <select aria-label={say("Supplier filter", "供应商筛选")} value={supplier} onChange={(event) => setSupplier(event.target.value)} style={inputStyle}>
            <option value="">{say("All suppliers", "全部供应商")}</option>
            {suppliers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
      </ListSearchCard>

      <ListCard
        title={copy("采购订单行")}
        total={state === "loaded" ? rows.length : undefined}
        shown={filtered.length}
        testId="order-fulfillment-line-list"
      >
        <div className={`hidden md:block ${tableScrollClass}`}>
          <table className={`w-full min-w-[1100px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${headClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{copy("采购订单")}</th>
                <th className={headClass} style={{ color: A.gray1 }}>{copy("物料 / SKU")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("PO 行金额")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("订购")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("已收")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("已开票")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("待收")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("已收未票")}</th>
                <th className={headRightClass} style={{ color: A.gray1 }}>{copy("金额差异")}</th>
                <th className={`${headClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{say("Status and documents", "履约状态与单据")}</th>
              </tr>
            </thead>
            <tbody>
              {state === "loading" && <ListStateRow colSpan={columns} state="loading" />}
              {state === "error" && <ListStateRow colSpan={columns} state="error" title={copy("订单履约明细加载失败")} detail={copy(error)} onRetry={() => void load()} />}
              {state === "loaded" && rows.length === 0 && (
                <ListStateRow colSpan={columns} state="empty" title={copy("当前工作区暂无采购订单行")} detail={copy("不会使用固定 PO、收货或发票记录补足空数据。")} />
              )}
              {state === "loaded" && rows.length > 0 && filtered.length === 0 && (
                <ListStateRow colSpan={columns} state="empty" title={copy("当前筛选条件下没有订单行")} detail={say("Choose All order lines or clear the search.", "可以切换到“全部订单行”或清除搜索条件。")} />
              )}
              {state === "loaded" && filtered.map((row, index) => (
                <tr key={row.id} data-testid={`fulfillment-line-${row.id}`} className={listRowClass} style={listRowStyle(index, filtered.length)}>
                  <td className={`${cellClass} sticky left-0 z-10 max-w-[210px] bg-white`} title={row.id}>
                    <BusinessEntityLink entityType="purchase_order" entityId={row.poId} number={row.poNumber} className={tableLinkClass} />
                    <div className="truncate text-[11px]"><SupplierDisplay row={row} /></div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                      <span style={{ color: A.gray2 }}>{say(`Line ${row.lineNumber}`, `第 ${row.lineNumber} 行`)}</span>
                      <POStatusPill status={row.poStatus} />
                    </div>
                  </td>
                  <td className={`${cellClass} max-w-[200px]`}>
                    <div className="truncate font-medium" style={{ color: A.label }} title={row.itemName || undefined}>{row.itemName || "—"}</div>
                    <div className="font-mono text-[11px]" style={{ color: A.sub }}>{row.sku || "—"}</div>
                  </td>
                  <td className={numberClass}>{money(row.lineAmount, row.currency, locale)}</td>
                  <td className={`${numberClass} font-semibold`} style={{ color: A.label }}>{quantity(row.orderedQuantity, row.unit, locale)}</td>
                  <td className={numberClass}>{quantity(row.receivedQuantity, row.unit, locale)}</td>
                  <td className={numberClass}>{quantity(row.invoicedQuantity, row.unit, locale)}</td>
                  <td className={numberClass} style={{ color: row.remainingToReceive > 0 ? A.label : A.gray2 }}>{quantity(row.remainingToReceive, row.unit, locale)}</td>
                  <td className={`${numberClass}${row.receivedNotInvoiced > 0 ? " font-semibold text-amber-700" : ""}`} style={row.receivedNotInvoiced > 0 ? undefined : { color: A.gray2 }}>{quantity(row.receivedNotInvoiced, row.unit, locale)}</td>
                  <td className={`${numberClass}${row.varianceAmount !== 0 ? " font-semibold text-red-700" : ""}`} style={row.varianceAmount !== 0 ? undefined : { color: A.gray2 }}>{money(row.varianceAmount, row.currency, locale)}</td>
                  <td className={`${cellClass} sticky right-0 z-10 min-w-[170px] bg-white`}>
                    <StatusChip label={copy(row.status)} tone={FULFILLMENT_TONE[row.status]} />
                    <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
                      <span style={{ color: A.sub }}>{say("Receipt", "收货")}</span>
                      <EvidenceLinks row={row} type="receiving" />
                      <span style={{ color: A.sub }}>{say("Invoice", "发票")}</span>
                      <EvidenceLinks row={row} type="invoice" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y md:hidden">
          {state === "loading" && <div className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>{copy("正在读取订单履约明细…")}</div>}
          {state === "loaded" && filtered.map((row) => (
            <article key={row.id} data-testid={`fulfillment-line-mobile-${row.id}`} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <BusinessEntityLink entityType="purchase_order" entityId={row.poId} number={row.poNumber} />
                  <div className="mt-1 text-xs font-medium">{say(`Line ${row.lineNumber}`, `第 ${row.lineNumber} 行`)} · {row.itemName || row.sku}</div>
                  <div className="mt-1 break-words text-xs" style={{ color: A.sub }}>
                    <SupplierDisplay row={row} /> · {row.sku || copy("SKU 待补齐")}
                  </div>
                </div>
                <StatusChip label={copy(row.status)} tone={FULFILLMENT_TONE[row.status]} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
                <div><div style={{ color: A.sub }}>{copy("订购")}</div><div className="mt-1 font-semibold">{quantity(row.orderedQuantity, row.unit, locale)}</div></div>
                <div><div style={{ color: A.sub }}>{copy("已收")}</div><div className="mt-1 font-semibold">{quantity(row.receivedQuantity, row.unit, locale)}</div></div>
                <div><div style={{ color: A.sub }}>{copy("已开票")}</div><div className="mt-1 font-semibold">{quantity(row.invoicedQuantity, row.unit, locale)}</div></div>
                <div><div style={{ color: A.sub }}>{copy("PO 行金额")}</div><div className="mt-1 font-semibold">{money(row.lineAmount, row.currency, locale)}</div></div>
              </div>
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <span>{copy("待收")} <strong>{quantity(row.remainingToReceive, row.unit, locale)}</strong></span>
                <span>{copy("已收未票")} <strong>{quantity(row.receivedNotInvoiced, row.unit, locale)}</strong></span>
                <span>{copy("金额差异")} <strong className={row.varianceAmount !== 0 ? "text-red-700" : ""}>{money(row.varianceAmount, row.currency, locale)}</strong></span>
              </div>
              <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div><div style={{ color: A.sub }}>{copy("收货证据")}</div><EvidenceLinks row={row} type="receiving" /></div>
                <div><div style={{ color: A.sub }}>{copy("发票证据")}</div><EvidenceLinks row={row} type="invoice" /></div>
              </div>
            </article>
          ))}
          {state === "loaded" && filtered.length === 0 && (
            <div className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>
              {/* Worded apart from the table's state rows, so a page reads one of each. */}
              {rows.length === 0 ? say("No purchase order lines yet", "暂无采购订单行") : say("No lines match these filters", "没有符合条件的订单行")}
            </div>
          )}
        </div>
      </ListCard>
    </div>
  );
}
