import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, PackageCheck, Printer, Search, Truck } from "lucide-react";
import { A, Card, Chip, KpiCard, Modal, SectionHeader } from "../../components/ui";
import { useListRouteState } from "../../components/navigation/useListRouteState";
import PrintLayoutEditor from "../print-layout/PrintLayoutEditor";
import { adaptDeliveryNote } from "../print-layout/printDataAdapters";
import { DELIVERY_NOTES, deliveryCustomers } from "./deliveryData";
import type { DeliveryNote, DeliveryStatus } from "./deliveryTypes";
import { useNavigate } from "react-router";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";

const statuses: Array<"全部" | DeliveryStatus> = ["全部", "待拣货", "待发货", "运输中", "已送达", "已签收", "异常"];
const statusColor = (status: DeliveryStatus) => status === "异常" ? A.red : status === "已签收" ? A.green : status === "运输中" || status === "已送达" ? A.blue : A.orange;
const deliveryListDefaults = { q: "", status: "全部", customer: "全部客户", sort: "default", page: "1" };
const PAGE_SIZE = 3;

export default function DeliveryPage() {
  const navigate = useNavigate();
  const [printNote, setPrintNote] = useState<DeliveryNote | null>(null);
  const { values, setValue, selectedId, setSelectedId } = useListRouteState({ moduleId: "sales", routeId: "sales:delivery", defaults: deliveryListDefaults });
  const { q: search, status, customer, sort } = values;
  const filteredRows = useMemo(() => DELIVERY_NOTES.filter((note) => {
    const query = search.trim().toLowerCase();
    return (!query || [note.deliveryNo, note.salesOrderNo, note.customerName, note.warehouse].some((value) => String(value || "").toLowerCase().includes(query)))
      && (status === "全部" || note.status === status) && (customer === "全部客户" || note.customerName === customer);
  }).sort((left, right) => sort === "deliveryDate-asc" ? left.deliveryDate.localeCompare(right.deliveryDate) : sort === "deliveryDate-desc" ? right.deliveryDate.localeCompare(left.deliveryDate) : sort === "customer-asc" ? left.customerName.localeCompare(right.customerName, "zh-CN") : 0), [customer, search, sort, status]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Number(values.page) || 1));
  const rows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = DELIVERY_NOTES.find((note) => note.id === selectedId) || null;
  const counts = (values: DeliveryStatus[]) => DELIVERY_NOTES.filter((note) => values.includes(note.status)).length;

  return (
    <div className="space-y-4" data-testid="delivery-page">
      <div className="flex justify-end"><button className="fc-action-button fc-action-primary" onClick={() => navigate("/app/sales/deliveries/new")}>新建发货单</button></div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="待发货" value={String(counts(["待拣货", "待发货"]))} icon={PackageCheck} color={A.orange} />
        <KpiCard label="运输中" value={String(counts(["运输中", "已送达"]))} icon={Truck} color={A.blue} />
        <KpiCard label="已签收" value={String(counts(["已签收"]))} icon={CheckCircle2} color={A.green} />
        <KpiCard label="异常" value={String(counts(["异常"]))} icon={AlertTriangle} color={A.red} />
      </div>
      <Card>
        <div className="p-4 flex flex-wrap items-center gap-2" style={{ borderBottom: `1px solid ${A.border}` }}>
          <div className="h-9 px-3 rounded-lg flex items-center gap-2 min-w-[260px]" style={{ background: A.gray6 }}><Search size={13} style={{ color: A.gray2 }} /><input aria-label="搜索发货单" value={search} onChange={(event) => setValue("q", event.target.value)} placeholder="搜索发货单号、销售订单、客户" className="bg-transparent outline-none fc-body w-full" /></div>
          <select aria-label="发货状态" value={status} onChange={(event) => setValue("status", event.target.value)} className="h-9 rounded-lg px-3 fc-body" style={{ border: `1px solid ${A.border}` }}>{statuses.map((item) => <option key={item}>{item}</option>)}</select>
          <select aria-label="客户筛选" value={customer} onChange={(event) => setValue("customer", event.target.value)} className="h-9 rounded-lg px-3 fc-body" style={{ border: `1px solid ${A.border}` }}><option>全部客户</option>{deliveryCustomers.map((item) => <option key={item}>{item}</option>)}</select>
          <select aria-label="发货排序" value={sort} onChange={(event) => setValue("sort", event.target.value)} className="h-9 rounded-lg px-3 fc-body" style={{ border: `1px solid ${A.border}` }}><option value="default">默认顺序</option><option value="deliveryDate-desc">发货日期降序</option><option value="deliveryDate-asc">发货日期升序</option><option value="customer-asc">客户名称</option></select>
          <span className="ml-auto fc-caption" data-testid="delivery-result-count" style={{ color: A.gray2 }}>{filteredRows.length} 张发货单</span>
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[1060px] text-xs">
          <thead><tr style={{ borderBottom: `1px solid ${A.border}` }}>{["发货单号", "销售订单号", "发货日期", "客户", "仓库", "发货数量", "物流状态", "预计到达", "操作"].map((header) => <th key={header} className="px-3 py-3 text-left font-semibold" style={{ color: A.gray1 }}>{header}</th>)}</tr></thead>
          <tbody>{rows.map((note) => <tr key={note.id} data-testid={`delivery-row-${note.deliveryNo}`} style={{ borderBottom: `1px solid ${A.border}` }}>
            <td className="px-3 py-3 font-semibold"><BusinessEntityLink entityType="delivery_note" entityId={note.deliveryNo}>{note.deliveryNo}</BusinessEntityLink></td><td className="px-3 py-3"><BusinessEntityLink entityType="sales_order" entityId={note.salesOrderNo}>{note.salesOrderNo}</BusinessEntityLink></td><td className="px-3 py-3">{note.deliveryDate}</td>
            <td className="px-3 py-3 font-medium">{note.customerName}</td><td className="px-3 py-3">{note.warehouse}</td><td className="px-3 py-3 tabular-nums">{note.totalQuantity.toLocaleString()}</td>
            <td className="px-3 py-3"><Chip label={note.status} color={statusColor(note.status)} bg={`${statusColor(note.status)}16`} /></td><td className="px-3 py-3">{note.expectedArrivalDate || "—"}</td>
            <td className="px-3 py-3"><div className="flex gap-2"><button onClick={() => setSelectedId(note.id)} className="px-2.5 py-1.5 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>查看详情</button><button aria-label={`打印发货单 ${note.deliveryNo}`} onClick={() => setPrintNote(note)} className="px-2.5 py-1.5 rounded-md font-medium flex items-center gap-1" style={{ background: "#f0f6ff", color: A.blue }}><Printer size={12} />打印</button></div></td>
          </tr>)}</tbody>
        </table></div>
        <div className="flex items-center justify-end gap-2 p-3"><button className="fc-action-button fc-action-secondary" disabled={page <= 1} onClick={() => setValue("page", String(page - 1))}>上一页</button><span className="fc-caption">第 {page} / {pageCount} 页</span><button className="fc-action-button fc-action-secondary" disabled={page >= pageCount} onClick={() => setValue("page", String(page + 1))}>下一页</button></div>
      </Card>
      <Modal open={Boolean(selected)} onClose={() => setSelectedId("")} title="发货单详情" subtitle={selected?.deliveryNo} width={1080} footer={selected && <><button onClick={() => setSelectedId("")} className="px-3 py-2 rounded-lg text-xs" style={{ background: A.white }}>关闭</button><button onClick={() => setPrintNote(selected)} className="px-3 py-2 rounded-lg text-xs text-white flex items-center gap-1" style={{ background: A.blue }}><Printer size={13} />打印发货单</button></>}>
        {selected && <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[["发货单号", selected.deliveryNo], ["销售订单", selected.salesOrderNo], ["发货日期", selected.deliveryDate], ["状态", selected.status], ["客户", selected.customerName], ["仓库", selected.warehouse], ["物流公司", selected.logisticsCompany || "—"], ["预计到达", selected.expectedArrivalDate || "—"], ["司机", selected.driver || "—"], ["联系电话", selected.driverPhone || "—"], ["车辆", selected.vehicleNo || "—"], ["箱数", selected.cartonCount ?? "—"]].map(([label, value]) => <div key={label} className="rounded-lg p-3" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{label}</div><div className="text-xs font-semibold mt-1" style={{ color: A.label }}>{value}</div></div>)}</div>
          <div><SectionHeader title="商品明细" /><div className="overflow-x-auto rounded-xl border" style={{ borderColor: A.border }}><table className="w-full text-xs"><thead><tr>{["SKU", "商品名称", "订单数量", "发货数量", "单位", "批次", "箱数", "备注"].map((item) => <th key={item} className="px-3 py-2 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{selected.lines.map((line) => <tr key={line.sku} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-2" style={{ color: A.blue }}>{line.sku}</td><td className="px-3 py-2 font-medium">{line.itemName}</td><td className="px-3 py-2">{line.orderedQty}</td><td className="px-3 py-2">{line.shippedQty}</td><td className="px-3 py-2">{line.unit}</td><td className="px-3 py-2">{line.batchNo || "—"}</td><td className="px-3 py-2">{line.cartonCount || "—"}</td><td className="px-3 py-2">{line.remarks || "—"}</td></tr>)}</tbody></table></div></div>
          <div className="grid lg:grid-cols-3 gap-3"><Card className="p-4"><SectionHeader title="关联单据" /><div className="text-xs leading-6" style={{ color: A.sub }}><div>销售订单：<span style={{ color: A.blue }}>{selected.salesOrderNo}</span></div><div>库存流水：IM-{selected.deliveryNo.slice(-7)}</div><div>签收单：{selected.status === "已签收" ? "SR-2026-0710-001" : "待生成"}</div></div></Card><Card className="p-4"><SectionHeader title="操作记录" /><div className="text-xs leading-6" style={{ color: A.sub }}><div>{selected.deliveryDate} · {selected.createdBy} 创建</div><div>{selected.reviewedBy ? `${selected.reviewedBy} 审核` : "等待审核"}</div></div></Card><Card className="p-4"><SectionHeader title="业务分析" /><div className="text-xs leading-5" style={{ color: selected.status === "异常" ? A.red : A.sub }}>{selected.status === "异常" ? selected.remarks : "当前发货记录无阻断风险。风险分析作为次级信息，不影响单据主体。"}</div></Card></div>
        </div>}
      </Modal>
      {printNote && <PrintLayoutEditor open documentType="delivery_note" documentNo={printNote.deliveryNo} data={adaptDeliveryNote(printNote)} onClose={() => setPrintNote(null)} />}
    </div>
  );
}
