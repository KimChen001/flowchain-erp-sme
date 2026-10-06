import { useMemo } from "react";
import { ClipboardList, RotateCcw, Search } from "lucide-react";
import { A, Card, Chip, KpiCard, Modal, SectionHeader } from "../../components/ui";
import { useListRouteState } from "../../components/navigation/useListRouteState";
import { SALES_RETURNS } from "./returnData";
import { SALES_RETURN_ALL_STATUSES, SALES_RETURN_OPEN_STATUSES, SALES_RETURN_STATUSES, SALES_RETURN_TONE } from "./returnTypes";
import type { SalesReturnNote, SalesReturnStatus } from "./returnTypes";
import { useNavigate } from "react-router";
import { useReturnsCopy } from "../inventory/returnsCopy";

const statuses: string[] = [SALES_RETURN_ALL_STATUSES, ...SALES_RETURN_STATUSES];
const color = (status: SalesReturnStatus) => A[SALES_RETURN_TONE[status] || "blue"];
const returnListDefaults = { q: "", status: SALES_RETURN_ALL_STATUSES, page: "1", sort: "returnDate-desc" };

export default function SalesReturnPage() {
  const { copy, salesStatusLabel } = useReturnsCopy();
  const navigate = useNavigate();
  const { values, setValue, selectedId, setSelectedId } = useListRouteState({ moduleId: "sales", routeId: "sales:returns", defaults: returnListDefaults });
  const { q: search, status } = values;
  const selected = SALES_RETURNS.find((item) => item.id === selectedId) || null;
  const rows = useMemo(() => SALES_RETURNS.filter((item) => (!search.trim() || [item.returnNo, item.customer, item.salesOrderNo, item.deliveryNo, item.returnReason].some((value) => String(value || "").toLowerCase().includes(search.trim().toLowerCase()))) && (status === SALES_RETURN_ALL_STATUSES || item.status === status)), [search, status]);
  const details = (note: SalesReturnNote): Array<[string, string | number]> => [[copy("Return number"), note.returnNo], [copy("Customer"), note.customer], [copy("Sales order"), note.salesOrderNo], [copy("Delivery"), note.deliveryNo], [copy("Return date"), note.returnDate], [copy("Return reason"), note.returnReason], [copy("Processing status"), salesStatusLabel(note.status)], [copy("Receiving warehouse"), note.warehouse], [copy("Return quantity"), note.totalQuantity], [copy("Created by"), note.createdBy], [copy("Reviewed by"), note.reviewedBy || copy("Awaiting review")], [copy("Notes"), note.remarks || "—"]];
  return <div className="space-y-4" data-testid="sales-return-page">
    <div className="flex justify-end"><button className="fc-action-button fc-action-primary" onClick={() => navigate("/app/sales/returns/new")}>{copy("New sales return")}</button></div>
    <div className="grid grid-cols-2 gap-3"><KpiCard label={copy("Sales returns")} value={String(SALES_RETURNS.length)} icon={RotateCcw} color={A.blue} /><KpiCard label={copy("In progress")} value={String(SALES_RETURNS.filter((item) => SALES_RETURN_OPEN_STATUSES.includes(item.status)).length)} icon={ClipboardList} color={A.orange} /></div>
    <Card><div className="p-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${A.border}` }}><div className="h-9 px-3 rounded-lg flex items-center gap-2 min-w-[300px]" style={{ background: A.gray6 }}><Search size={13} /><input aria-label={copy("Search sales returns")} className="w-full bg-transparent outline-none fc-body" placeholder={copy("Search by return number, customer or order")} value={search} onChange={(event) => setValue("q", event.target.value)} /></div><select aria-label={copy("Return status")} className="h-9 rounded-lg px-3 fc-body" style={{ border: `1px solid ${A.border}` }} value={status} onChange={(event) => setValue("status", event.target.value)}>{statuses.map((item) => <option key={item} value={item}>{salesStatusLabel(item)}</option>)}</select><span className="ml-auto fc-caption" style={{ color: A.gray2 }}>{copy("{n} sales returns", { n: rows.length })}</span></div>
      {rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[1060px] text-xs"><thead><tr>{[copy("Return number"), copy("Customer"), copy("Sales order number"), copy("Delivery number"), copy("Return date"), copy("Return quantity"), copy("Return reason"), copy("Processing status"), copy("Actions")].map((item) => <th key={item} className="px-3 py-3 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{rows.map((item) => <tr key={item.id} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-3 font-semibold" style={{ color: A.blue }}>{item.returnNo}</td><td className="px-3 py-3 font-medium">{item.customer}</td><td className="px-3 py-3">{item.salesOrderNo}</td><td className="px-3 py-3">{item.deliveryNo}</td><td className="px-3 py-3">{item.returnDate}</td><td className="px-3 py-3">{item.totalQuantity}</td><td className="px-3 py-3">{item.returnReason}</td><td className="px-3 py-3"><Chip label={salesStatusLabel(item.status)} color={color(item.status)} bg={`${color(item.status)}16`} /></td><td className="px-3 py-3"><button onClick={() => setSelectedId(item.id)} className="px-2.5 py-1.5 rounded-md" style={{ background: A.gray6, color: A.blue }}>{copy("View details")}</button></td></tr>)}</tbody></table></div>
        : <div className="p-10 text-center fc-body" style={{ color: A.gray2 }} data-testid="sales-returns-empty">{SALES_RETURNS.length ? copy("No records match the current filters.") : copy("No sales returns are recorded here. Customer returns are requested under Inventory › Returns.")}</div>}
    </Card>
    <Modal open={Boolean(selected)} onClose={() => setSelectedId("")} title={copy("Sales return details")} subtitle={selected?.returnNo} width={1000}>
      {selected && <div className="space-y-5"><div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{details(selected).map(([label, value]) => <div key={label} className="p-3 rounded-lg" style={{ background: A.gray6 }}><div className="fc-caption" style={{ color: A.gray2 }}>{label}</div><div className="text-xs font-semibold mt-1">{value}</div></div>)}</div>
        <div><SectionHeader title={copy("Return lines")} /><div className="overflow-x-auto rounded-xl border" style={{ borderColor: A.border }}><table className="w-full text-xs"><thead><tr>{["SKU", copy("Item name"), copy("Shipped quantity"), copy("Return quantity"), copy("Received quantity"), copy("Unit"), copy("Condition"), copy("Notes")].map((item) => <th key={item} className="px-3 py-2 text-left" style={{ color: A.gray1 }}>{item}</th>)}</tr></thead><tbody>{selected.lines.map((line) => <tr key={line.sku} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-3 py-2" style={{ color: A.blue }}>{line.sku}</td><td className="px-3 py-2 font-medium">{line.itemName}</td><td className="px-3 py-2">{line.shippedQty}</td><td className="px-3 py-2">{line.returnQty}</td><td className="px-3 py-2">{line.receivedQty}</td><td className="px-3 py-2">{line.unit}</td><td className="px-3 py-2">{line.condition}</td><td className="px-3 py-2">{line.remarks || "—"}</td></tr>)}</tbody></table></div></div>
      </div>}
    </Modal>
  </div>;
}
