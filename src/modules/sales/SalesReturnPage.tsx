import { useMemo } from "react";
import { ClipboardList, PackageOpen, RotateCcw, Search } from "lucide-react";
import { A, Card, Chip, KpiCard, Modal, SectionHeader } from "../../components/ui";
import { useListRouteState } from "../../components/navigation/useListRouteState";
import { SALES_RETURNS } from "./returnData";
import type { SalesReturnNote, SalesReturnStatus } from "./returnTypes";
import { useNavigate } from "react-router";

const statuses: Array<"全部" | SalesReturnStatus> = ["全部", "草稿", "待审核", "待收货", "处理中", "已完成", "已驳回"];
const color = (status: SalesReturnStatus) => status === "已完成" ? A.green : status === "已驳回" ? A.red : status === "处理中" || status === "待收货" ? A.orange : A.blue;
const returnListDefaults = { q: "", status: "全部", page: "1", sort: "returnDate-desc" };

export default function SalesReturnPage() {
  const navigate = useNavigate();
  const { values, setValue, selectedId, setSelectedId } = useListRouteState({ moduleId: "sales", routeId: "sales:returns", defaults: returnListDefaults });
  const { q: search, status } = values;
  const selected = SALES_RETURNS.find((item) => item.id === selectedId) || null;
  const rows = useMemo(() => SALES_RETURNS.filter((item) => (!search.trim() || [item.returnNo, item.customer, item.salesOrderNo, item.deliveryNo, item.returnReason].some((value) => String(value || "").toLowerCase().includes(search.trim().toLowerCase()))) && (status === "全部" || item.status === status)), [search, status]);
  return <div className="space-y-4" data-testid="sales-return-page">
    <div className="flex justify-end"><button className="fc-action-button fc-action-primary" onClick={() => navigate("/app/sales/returns/new")}>新建退货单</button></div>
    <div className="grid grid-cols-3 gap-3"><KpiCard label="退货单" value={String(SALES_RETURNS.length)} icon={RotateCcw} color={A.blue} /><KpiCard label="处理中" value={String(SALES_RETURNS.filter((item) => ["待审核", "待收货", "处理中"].includes(item.status)).length)} icon={ClipboardList} color={A.orange} /><KpiCard label="退货数量" value={String(SALES_RETURNS.reduce((sum, item) => sum + item.totalQuantity, 0))} icon={PackageOpen} color={A.purple} /></div>
    <Card><div className="p-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${A.border}` }}><div className="h-9 px-3 rounded-lg flex items-center gap-2 min-w-[300px]" style={{ background: A.gray6 }}><Search size={13} /><input aria-label="搜索销售退货单" className="w-full bg-transparent outline-none fc-body" placeholder="搜索退货单号、客户、订单" value={search} onChange={(event) => setValue("q", event.target.value)} /></div><select aria-label="退货状态" className="h-9 rounded-lg px-3 fc-body" style={{ border: `1px solid ${A.border}` }} value={status} onChange={(event) => setValue("status", event.target.value)}>{statuses.map((item) => <option key={item}>{item}</option>)}</select><span className="ml-auto fc-caption" style={{ color: A.gray2 }}>{rows.length} 张退货单</span></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[1060px] text-xs"><thead><tr>{["退货单号", "客户", "销售订单号", "发货单号", "退货日期", "退货数量", "退货原因", "处理状态", "操作"].map((item) => <th key={item} className="px-3 py-3 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{rows.map((item) => <tr key={item.id} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-3 font-semibold" style={{ color: A.blue }}>{item.returnNo}</td><td className="px-3 py-3 font-medium">{item.customer}</td><td className="px-3 py-3">{item.salesOrderNo}</td><td className="px-3 py-3">{item.deliveryNo}</td><td className="px-3 py-3">{item.returnDate}</td><td className="px-3 py-3">{item.totalQuantity}</td><td className="px-3 py-3">{item.returnReason}</td><td className="px-3 py-3"><Chip label={item.status} color={color(item.status)} bg={`${color(item.status)}16`} /></td><td className="px-3 py-3"><button onClick={() => setSelectedId(item.id)} className="px-2.5 py-1.5 rounded-md" style={{ background: A.gray6, color: A.blue }}>查看详情</button></td></tr>)}</tbody></table></div>
    </Card>
    <Modal open={Boolean(selected)} onClose={() => setSelectedId("")} title="销售退货单详情" subtitle={selected?.returnNo} width={1000}>
      {selected && <div className="space-y-5"><div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[["退货单号", selected.returnNo], ["客户", selected.customer], ["销售订单", selected.salesOrderNo], ["发货单", selected.deliveryNo], ["退货日期", selected.returnDate], ["退货原因", selected.returnReason], ["处理状态", selected.status], ["收货仓库", selected.warehouse], ["退货数量", selected.totalQuantity], ["创建人", selected.createdBy], ["审核人", selected.reviewedBy || "待审核"], ["备注", selected.remarks || "—"]].map(([label, value]) => <div key={label} className="p-3 rounded-lg" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{label}</div><div className="text-xs font-semibold mt-1">{value}</div></div>)}</div>
        <div><SectionHeader title="退货明细" /><div className="overflow-x-auto rounded-xl border" style={{ borderColor: A.border }}><table className="w-full text-xs"><thead><tr>{["SKU", "商品名称", "原发货数", "退货数量", "已收数量", "单位", "货况", "备注"].map((item) => <th key={item} className="px-3 py-2 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{selected.lines.map((line) => <tr key={line.sku} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-2" style={{ color: A.blue }}>{line.sku}</td><td className="px-3 py-2 font-medium">{line.itemName}</td><td className="px-3 py-2">{line.shippedQty}</td><td className="px-3 py-2">{line.returnQty}</td><td className="px-3 py-2">{line.receivedQty}</td><td className="px-3 py-2">{line.unit}</td><td className="px-3 py-2">{line.condition}</td><td className="px-3 py-2">{line.remarks || "—"}</td></tr>)}</tbody></table></div></div>
      </div>}
    </Modal>
  </div>;
}
