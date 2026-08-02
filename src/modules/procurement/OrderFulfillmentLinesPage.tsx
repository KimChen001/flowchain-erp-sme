import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { A, Card } from "../../components/ui";
import { apiJson } from "../../lib/api-client";
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
        currency: line.currency || order.currency || "CNY",
        receivingEvidence: receivingByPoLine.get(line.poLineId) || [],
        invoiceEvidence,
        varianceAmount: variance,
        status: fulfillmentStatus({ ordered, received, invoiced, variance }),
      };
    }),
  );
}

function quantity(value: number, unit: string) {
  return `${value.toLocaleString("zh-CN")} ${unit || ""}`.trim();
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency || "CNY",
    maximumFractionDigits: 2,
  }).format(value);
}

function statusTone(status: OrderFulfillmentLine["status"]) {
  if (status === "已完成") return "bg-emerald-50 text-emerald-700";
  if (status === "待收货") return "bg-slate-100 text-slate-700";
  if (status === "部分收货" || status === "已收待票")
    return "bg-amber-50 text-amber-800";
  return "bg-rose-50 text-rose-700";
}

function poStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    open: "待履约",
    approved: "已批准",
    issued: "已发出",
    sent: "已发送",
    partially_received: "部分收货",
    received: "已收货",
    fully_received: "已收货",
    closed: "已关闭",
    cancelled: "已取消",
  };
  return labels[status] || status || "—";
}

function SupplierDisplay({ row }: { row: OrderFulfillmentLine }) {
  if (!row.supplierId) return <>{row.supplier || "—"}</>;
  return (
    <BusinessEntityLink entityType="supplier" entityId={row.supplierId}>
      {row.supplier || row.supplierId}
    </BusinessEntityLink>
  );
}

function EvidenceLinks({ row, type }: { row: OrderFulfillmentLine; type: "receiving" | "invoice" }) {
  const ids = type === "receiving"
    ? unique(row.receivingEvidence.map((entry) => entry.document.grn).filter(Boolean))
    : unique(row.invoiceEvidence.map((entry) => entry.invoice.id).filter(Boolean));
  if (ids.length === 0)
    return <span className="text-xs" style={{ color: A.sub }}>—</span>;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
      {ids.map((id) => (
        <BusinessEntityLink
          key={id}
          entityType={type === "receiving" ? "receiving_doc" : "supplier_invoice"}
          entityId={id}
        >
          {id}
        </BusinessEntityLink>
      ))}
    </div>
  );
}

export function OrderFulfillmentLinesPage() {
  const [payload, setPayload] = useState<PurchaseOrderWorkbenchPayload>({});
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"open" | "all" | "exceptions">("open");

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
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (view === "open" && row.status === "已完成") return false;
      if (view === "exceptions" && row.varianceAmount === 0 && row.status !== "数量待复核") return false;
      if (!normalized) return true;
      return [row.poId, row.id, row.supplier, row.sku, row.itemName]
        .some((value) => value.toLowerCase().includes(normalized));
    });
  }, [query, rows, view]);

  const openCount = rows.filter((row) => row.status !== "已完成").length;
  const partialCount = rows.filter((row) => row.status === "部分收货").length;
  const receivedNotInvoicedCount = rows.filter((row) => row.receivedNotInvoiced > 0).length;
  const exceptionCount = rows.filter((row) => row.varianceAmount !== 0 || row.status === "数量待复核").length;

  return (
    <div className="space-y-4" data-testid="procurement-order-fulfillment-lines">
      <Card className="p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {[
              ["未完成订单行", openCount],
              ["部分收货", partialCount],
              ["已收未票", receivedNotInvoicedCount],
              ["需要复核", exceptionCount],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-2">
                <span style={{ color: A.sub }}>{label}</span>
                <strong className="text-sm tabular-nums">{value}</strong>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="relative min-w-[240px] flex-1">
            <Search className="absolute left-3 top-2.5" size={16} color={A.sub} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 PO、供应商、SKU 或物料"
              className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm"
            />
          </label>
          <select
            aria-label="履约视图"
            value={view}
            onChange={(event) => setView(event.target.value as typeof view)}
            className="rounded-lg border bg-white px-3 py-2 text-sm"
          >
            <option value="open">未完成履约</option>
            <option value="all">全部订单行</option>
            <option value="exceptions">需要复核</option>
          </select>
        </div>
      </Card>

      <Card className="overflow-hidden" data-testid="order-fulfillment-line-list">
        {state === "loading" ? (
          <div className="py-16 text-center text-sm" style={{ color: A.sub }}>正在读取订单履约明细…</div>
        ) : state === "error" ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">订单履约明细加载失败</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>{error}</div>
            <button type="button" onClick={() => void load()} className="mt-3 text-sm font-semibold text-blue-600">重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">当前工作区暂无采购订单行</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>不会使用固定 PO、收货或发票记录补足空数据。</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm font-semibold">当前筛选条件下没有订单行</div>
            <div className="mt-2 text-xs" style={{ color: A.sub }}>可以切换到“全部订单行”或清除搜索条件。</div>
          </div>
        ) : (
          <>
            <div className="hidden border-b border-slate-100 px-4 py-3 text-xs md:flex md:items-center md:justify-between">
              <div>
                <strong className="text-sm">采购订单行</strong>
                <span className="ml-2" style={{ color: A.sub }}>当前显示 {filtered.length} / {rows.length} 行</span>
              </div>
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-[1500px] w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50" style={{ color: A.sub }}>
                  <tr className="border-b border-slate-200">
                    <th className="w-[190px] whitespace-nowrap px-3 py-3 font-semibold">采购订单</th>
                    <th className="w-[60px] whitespace-nowrap px-3 py-3 font-semibold">行</th>
                    <th className="w-[150px] px-3 py-3 font-semibold">供应商</th>
                    <th className="w-[190px] px-3 py-3 font-semibold">物料 / SKU</th>
                    <th className="w-[95px] whitespace-nowrap px-3 py-3 font-semibold">PO 状态</th>
                    <th className="w-[120px] whitespace-nowrap px-3 py-3 text-right font-semibold">PO 行金额</th>
                    <th className="w-[95px] whitespace-nowrap px-3 py-3 text-right font-semibold">订购</th>
                    <th className="w-[95px] whitespace-nowrap px-3 py-3 text-right font-semibold">已收</th>
                    <th className="w-[95px] whitespace-nowrap px-3 py-3 text-right font-semibold">已开票</th>
                    <th className="w-[95px] whitespace-nowrap px-3 py-3 text-right font-semibold">待收</th>
                    <th className="w-[105px] whitespace-nowrap px-3 py-3 text-right font-semibold">已收未票</th>
                    <th className="w-[110px] whitespace-nowrap px-3 py-3 text-right font-semibold">金额差异</th>
                    <th className="w-[105px] whitespace-nowrap px-3 py-3 font-semibold">履约状态</th>
                    <th className="w-[170px] px-3 py-3 font-semibold">关联 GRN / Invoice</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((row, index) => (
                    <tr
                      key={row.id}
                      data-testid={`fulfillment-line-${row.id}`}
                      className={`align-middle transition-colors hover:bg-blue-50/50 ${index % 2 === 0 ? "bg-white" : "bg-slate-50/60"}`}
                    >
                      <td className="whitespace-nowrap px-3 py-3 font-semibold">
                        <BusinessEntityLink entityType="purchase_order" entityId={row.poId}>{row.poId}</BusinessEntityLink>
                      </td>
                      <td className="px-3 py-3 font-semibold tabular-nums" title={row.id}>{row.lineNumber}</td>
                      <td className="px-3 py-3"><SupplierDisplay row={row} /></td>
                      <td className="px-3 py-3">
                        <div className="font-medium">{row.itemName || "—"}</div>
                        <div className="mt-1 font-mono text-xs" style={{ color: A.sub }}>{row.sku || "—"}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">{poStatusLabel(row.poStatus)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{money(row.lineAmount, row.currency)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{quantity(row.orderedQuantity, row.unit)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{quantity(row.receivedQuantity, row.unit)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{quantity(row.invoicedQuantity, row.unit)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{quantity(row.remainingToReceive, row.unit)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{quantity(row.receivedNotInvoiced, row.unit)}</td>
                      <td className={`whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums ${row.varianceAmount !== 0 ? "text-rose-700" : ""}`}>
                        {money(row.varianceAmount, row.currency)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusTone(row.status)}`}>{row.status}</span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="grid grid-cols-[42px_1fr] gap-x-2 gap-y-1">
                          <span style={{ color: A.sub }}>GRN</span>
                          <EvidenceLinks row={row} type="receiving" />
                          <span style={{ color: A.sub }}>Invoice</span>
                          <EvidenceLinks row={row} type="invoice" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y md:hidden">
              {filtered.map((row) => (
                <article key={row.id} data-testid={`fulfillment-line-mobile-${row.id}`} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <BusinessEntityLink entityType="purchase_order" entityId={row.poId}>{row.poId}</BusinessEntityLink>
                      <div className="mt-1 text-xs font-medium">行 {row.lineNumber} · {row.itemName || row.sku}</div>
                      <div className="mt-1 break-words text-xs" style={{ color: A.sub }}>
                        <SupplierDisplay row={row} /> · {row.sku || "SKU 待补齐"} · {row.id}
                      </div>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusTone(row.status)}`}>{row.status}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
                    <div><div style={{ color: A.sub }}>订购</div><div className="mt-1 font-semibold">{quantity(row.orderedQuantity, row.unit)}</div></div>
                    <div><div style={{ color: A.sub }}>已收</div><div className="mt-1 font-semibold">{quantity(row.receivedQuantity, row.unit)}</div></div>
                    <div><div style={{ color: A.sub }}>已开票</div><div className="mt-1 font-semibold">{quantity(row.invoicedQuantity, row.unit)}</div></div>
                    <div><div style={{ color: A.sub }}>PO 行金额</div><div className="mt-1 font-semibold">{money(row.lineAmount, row.currency)}</div></div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                    <span>待收 <strong>{quantity(row.remainingToReceive, row.unit)}</strong></span>
                    <span>已收未票 <strong>{quantity(row.receivedNotInvoiced, row.unit)}</strong></span>
                    <span>金额差异 <strong className={row.varianceAmount !== 0 ? "text-rose-700" : ""}>{money(row.varianceAmount, row.currency)}</strong></span>
                  </div>
                  <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                    <div><div style={{ color: A.sub }}>收货证据</div><EvidenceLinks row={row} type="receiving" /></div>
                    <div><div style={{ color: A.sub }}>发票证据</div><EvidenceLinks row={row} type="invoice" /></div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
