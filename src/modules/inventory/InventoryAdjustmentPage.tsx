import { useMemo } from "react";
import { CheckCircle2, ClipboardList, FileEdit, Search } from "lucide-react";
import { A, Card, Chip, KpiCard, Modal, SectionHeader } from "../../components/ui";
import { useListRouteState } from "../../components/navigation/useListRouteState";
import { INVENTORY_ADJUSTMENTS } from "./adjustmentData";
import type { InventoryAdjustment, InventoryAdjustmentStatus } from "./adjustmentTypes";
import { useNavigate } from "react-router";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";

const statuses: Array<"全部" | InventoryAdjustmentStatus> = ["全部", "草稿", "待审核", "已审核", "已驳回"];
const color = (status: InventoryAdjustmentStatus) => status === "已审核" ? A.green : status === "已驳回" ? A.red : status === "待审核" ? A.orange : A.blue;
const totalAdjustment = (item: InventoryAdjustment) => item.lines.reduce((sum, line) => sum + line.adjustmentQty, 0);
const adjustmentListDefaults = { q: "", status: "全部", page: "1", sort: "createdAt-desc" };

export default function InventoryAdjustmentPage() {
  const navigate = useNavigate();
  const { values, setValue, selectedId, setSelectedId } = useListRouteState({ moduleId: "inventory", routeId: "inventory:adjustments", defaults: adjustmentListDefaults });
  const { q: search, status } = values;
  const selected = INVENTORY_ADJUSTMENTS.find((item) => item.id === selectedId) || null;
  const rows = useMemo(() => INVENTORY_ADJUSTMENTS.filter((item) => (!search.trim() || [item.adjustmentNo, item.warehouse, item.adjustmentType, item.reason].some((value) => String(value || "").toLowerCase().includes(search.trim().toLowerCase()))) && (status === "全部" || item.status === status)), [search, status]);
  return <div className="space-y-4" data-testid="inventory-adjustment-page">
    <div className="flex justify-end"><button className="fc-action-button fc-action-primary" onClick={() => navigate("/app/inventory/adjustments/new")}>新建调整单</button></div>
    <div className="grid grid-cols-3 gap-3"><KpiCard label="调整单" value={String(INVENTORY_ADJUSTMENTS.length)} icon={ClipboardList} color={A.blue} /><KpiCard label="待审核" value={String(INVENTORY_ADJUSTMENTS.filter((item) => item.status === "待审核").length)} icon={FileEdit} color={A.orange} /><KpiCard label="已审核" value={String(INVENTORY_ADJUSTMENTS.filter((item) => item.status === "已审核").length)} icon={CheckCircle2} color={A.green} /></div>
    <Card><div className="p-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${A.border}` }}><div className="h-9 px-3 min-w-[300px] flex items-center gap-2 rounded-lg" style={{ background: A.gray6 }}><Search size={13} /><input aria-label="搜索库存调整单" className="w-full bg-transparent outline-none fc-body" placeholder="搜索调整单号、仓库、原因" value={search} onChange={(event) => setValue("q", event.target.value)} /></div><select aria-label="调整单状态" className="h-9 px-3 rounded-lg fc-body" style={{ border: `1px solid ${A.border}` }} value={status} onChange={(event) => setValue("status", event.target.value)}>{statuses.map((item) => <option key={item}>{item}</option>)}</select><span className="ml-auto fc-caption" style={{ color: A.gray2 }}>{rows.length} 张调整单</span></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-xs"><thead><tr>{["调整单号", "仓库", "调整类型", "调整数量", "原因", "状态", "创建时间", "创建人", "操作"].map((item) => <th key={item} className="px-3 py-3 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{rows.map((item) => <tr key={item.id} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-3 font-semibold"><BusinessEntityLink entityType="inventory_adjustment" entityId={item.adjustmentNo}>{item.adjustmentNo}</BusinessEntityLink></td><td className="px-3 py-3">{item.warehouse}</td><td className="px-3 py-3">{item.adjustmentType}</td><td className="px-3 py-3 font-semibold" style={{ color: totalAdjustment(item) < 0 ? A.red : A.green }}>{totalAdjustment(item) > 0 ? "+" : ""}{totalAdjustment(item)}</td><td className="px-3 py-3">{item.reason}</td><td className="px-3 py-3"><Chip label={item.status} color={color(item.status)} bg={`${color(item.status)}16`} /></td><td className="px-3 py-3">{item.createdAt}</td><td className="px-3 py-3">{item.createdBy}</td><td className="px-3 py-3"><button onClick={() => setSelectedId(item.id)} className="px-2.5 py-1.5 rounded-md" style={{ background: A.gray6, color: A.blue }}>快速预览</button></td></tr>)}</tbody></table></div>
    </Card>
    <Modal open={Boolean(selected)} onClose={() => setSelectedId("")} title="库存调整单详情" subtitle={selected?.adjustmentNo} width={1000}>
      {selected && <div className="space-y-5"><div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[["调整单号", selected.adjustmentNo], ["仓库", selected.warehouse], ["调整类型", selected.adjustmentType], ["状态", selected.status], ["原因", selected.reason], ["创建人", selected.createdBy], ["创建时间", selected.createdAt], ["审核人", selected.reviewedBy || "待审核"], ["审核时间", selected.reviewedAt || "—"], ["关联库存流水", selected.movementNo || "待审核后生成"], ["备注", selected.remarks || "—"]].map(([label, value]) => <div key={label} className="p-3 rounded-lg" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{label}</div><div className="text-xs font-semibold mt-1">{value}</div></div>)}</div>
        <div><SectionHeader title="调整明细" /><div className="overflow-x-auto rounded-xl border" style={{ borderColor: A.border }}><table className="w-full text-xs"><thead><tr>{["SKU", "商品名称", "调整前数量", "调整数量", "调整后数量", "单位", "原因", "备注"].map((item) => <th key={item} className="px-3 py-2 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{selected.lines.map((line) => <tr key={line.sku} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-2" style={{ color: A.blue }}>{line.sku}</td><td className="px-3 py-2 font-medium">{line.itemName}</td><td className="px-3 py-2">{line.beforeQty}</td><td className="px-3 py-2 font-semibold" style={{ color: line.adjustmentQty < 0 ? A.red : A.green }}>{line.adjustmentQty > 0 ? "+" : ""}{line.adjustmentQty}</td><td className="px-3 py-2">{line.afterQty}</td><td className="px-3 py-2">{line.unit}</td><td className="px-3 py-2">{line.reason || "—"}</td><td className="px-3 py-2">{line.remarks || "—"}</td></tr>)}</tbody></table></div></div>
      </div>}
    </Modal>
  </div>;
}
