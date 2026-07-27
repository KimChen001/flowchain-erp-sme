import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { apiJson } from "../../lib/api-client";
import { Card } from "../ui";
export default function CanonicalDownstreamPanel({
  kind,
}: {
  kind: "orders" | "rfqs";
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [purchaseRequests, setPurchaseRequests] = useState<any[]>([]);
  const [sourcePrId, setSourcePrId] = useState(searchParams.get("sourcePrId") || "");
  const [title, setTitle] = useState(searchParams.get("title") || "");
  const [dueDate, setDueDate] = useState(searchParams.get("due") || "");
  const [supplierIds, setSupplierIds] = useState(searchParams.get("suppliers") || "");
  const [creating, setCreating] = useState(false);
  const createMode = kind === "rfqs" && searchParams.get("mode") === "create";
  const load = () =>
    apiJson<any[]>(`/api/procurement/${kind}`)
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!createMode) return;
    apiJson<any[]>("/api/procurement/requests")
      .then((items) => {
        const approved = items.filter((item) => item.status === "approved");
        setPurchaseRequests(approved);
        setSourcePrId((current) => current || approved[0]?.id || "");
      })
      .catch(() => setPurchaseRequests([]));
  }, [createMode]);
  const act = async (row: any, action: string) => {
    try {
      await apiJson(`/api/procurement/${kind}/${row.id}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flowchain-user": "procurement-manager",
        },
        body: JSON.stringify({ expectedVersion: row.version }),
      });
      await load();
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const createRfq = async () => {
    const source = purchaseRequests.find((item) => item.id === sourcePrId);
    if (!source) {
      toast.error("请选择已批准采购申请");
      return;
    }
    setCreating(true);
    try {
      await apiJson(`/api/procurement/requests/${encodeURIComponent(sourcePrId)}/rfqs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-flowchain-user": "procurement-manager" },
        body: JSON.stringify({
          expectedVersion: source.version,
          title: title || `询价 ${sourcePrId}`,
          dueDate,
          invitedSupplierIds: supplierIds.split(",").map((item) => item.trim()).filter(Boolean),
        }),
      });
      toast.success("RFQ 正式草稿已创建");
      setSearchParams({});
      await load();
    } catch (error: any) {
      toast.error(error.message || "RFQ 草稿创建失败");
    } finally {
      setCreating(false);
    }
  };
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">
        {kind === "orders" ? "真实采购订单" : "真实询价单"}
      </h2>
      {createMode && (
        <section data-testid="formal-rfq-draft-form" className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="text-xs font-semibold text-blue-800">创建正式 RFQ 草稿</div>
          <div className="mt-1 text-[11px] text-blue-700">AI 仅预填字段；保存将进入正式 RFQ 工作流，并由真实业务动作记录审计。</div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <label className="text-xs">来源采购申请
              <select className="mt-1 w-full rounded border bg-white p-2" value={sourcePrId} onChange={(event) => setSourcePrId(event.target.value)}>
                <option value="">请选择已批准 PR</option>
                {purchaseRequests.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
            <label className="text-xs">RFQ 标题<input className="mt-1 w-full rounded border bg-white p-2" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="text-xs">报价截止日期<input type="date" className="mt-1 w-full rounded border bg-white p-2" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
            <label className="text-xs">候选供应商 ID（逗号分隔）<input className="mt-1 w-full rounded border bg-white p-2" value={supplierIds} onChange={(event) => setSupplierIds(event.target.value)} /></label>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" disabled={!sourcePrId || creating} onClick={() => void createRfq()}>{creating ? "创建中" : "保存 RFQ 草稿"}</button>
            <button type="button" className="rounded bg-white px-3 py-2 text-xs font-semibold text-slate-600" onClick={() => setSearchParams({})}>取消</button>
          </div>
        </section>
      )}
      <div className="mt-3 space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap gap-2 rounded-lg border p-3 text-xs"
          >
            <b>{r.id}</b>
            <span>
              {r.status} · v{r.version}
            </span>
            <span>来源 PR：{r.sourcePrId}</span>
            <span className="ml-auto">{r.currency}</span>
            {kind === "orders" && r.status === "draft" && (
              <button onClick={() => act(r, "submit")}>提交审批</button>
            )}
            {kind === "orders" && r.status === "pending_approval" && (
              <>
                <button onClick={() => act(r, "approve")}>批准</button>
                <button onClick={() => act(r, "cancel")}>取消</button>
              </>
            )}
            {kind === "orders" && r.status === "approved" && (
              <button onClick={() => act(r, "issue")}>下达</button>
            )}
            {kind === "rfqs" && r.status === "draft" && (
              <>
                <button onClick={() => act(r, "open")}>开启询价</button>
                <button onClick={() => act(r, "cancel")}>取消</button>
              </>
            )}
          </div>
        ))}
      </div>
      {kind === "rfqs" && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs">
          尚未录入供应商报价
        </div>
      )}
    </Card>
  );
}
