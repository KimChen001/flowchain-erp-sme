import { useMemo, useState } from "react";
import { AlertCircle, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fmt } from "../../../lib/format";
import { OWNERS, SKU_CATALOG, SUPPLIER_LIST } from "../../../data/empty-business-state";
import type { POStatus, PurchaseOrder, PurchaseOrderDraft } from "../../../types/scm";
import { A, Field, inputStyle, Modal } from "../../../components/ui";

export function NewPOModal({ open, onClose, onCreate }: {
  open: boolean; onClose: () => void;
  onCreate: (po: PurchaseOrderDraft) => Promise<PurchaseOrder>;
}) {
  const [supplier, setSupplier] = useState(SUPPLIER_LIST[0]);
  const [owner, setOwner] = useState(OWNERS[0]);
  const [priority, setPriority] = useState<"高" | "中" | "低">("中");
  const [eta, setEta] = useState("6月03日");
  const [lines, setLines] = useState<{ sku: string; qty: number }[]>([{ sku: SKU_CATALOG[0].sku, qty: 10 }]);
  const [submitting, setSubmitting] = useState(false);

  const total = useMemo(() => lines.reduce((s, l) => {
    const c = SKU_CATALOG.find((x) => x.sku === l.sku);
    return s + (c ? c.price * l.qty : 0);
  }, 0), [lines]);

  function addLine() { setLines([...lines, { sku: SKU_CATALOG[0].sku, qty: 1 }]); }
  function removeLine(i: number) { setLines(lines.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, patch: Partial<{ sku: string; qty: number }>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }

  function reset() {
    setSupplier(SUPPLIER_LIST[0]); setOwner(OWNERS[0]); setPriority("中");
    setEta("6月03日"); setLines([{ sku: SKU_CATALOG[0].sku, qty: 10 }]);
  }

  async function submit(asDraft: boolean) {
    if (lines.length === 0) { toast.error("请至少添加一行物料"); return; }
    if (lines.some((l) => l.qty <= 0)) { toast.error("数量必须大于 0"); return; }
    setSubmitting(true);
    try {
      const po = {
        supplier, owner, priority, eta,
        amount: total,
        items: lines.length,
        received: 0,
        status: (asDraft ? "草稿" : "待审批") as POStatus,
        paid: false,
      };
      const created = await onCreate(po);
      reset();
      onClose();
      toast.success(asDraft ? `${created.po} 已保存为草稿` : `${created.po} 已提交审批`, {
        description: `${supplier} · ${fmt(total)} · ${lines.length} 行物料`,
      });
    } catch (error) {
      toast.error("采购订单保存失败", { description: error instanceof Error ? error.message : "请确认 API 服务正在运行" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={720}
      title="新建采购订单" subtitle="填写供应商、明细行与到期日，系统将自动生成 PO 编号"
      footer={
        <>
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg font-medium"
            style={{ background: A.white, color: A.label, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.1)" }}>取消</button>
          <button onClick={() => submit(true)} disabled={submitting}
            className="text-xs px-3 py-1.5 rounded-lg font-medium"
            style={{ background: A.gray5, color: A.label }}>存为草稿</button>
          <button onClick={() => submit(false)} disabled={submitting}
            className="text-xs px-3 py-1.5 rounded-lg font-medium text-white flex items-center gap-1.5"
            style={{ background: A.blue, opacity: submitting ? 0.6 : 1 }}>
            {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            提交审批
          </button>
        </>
      }>
      <div className="grid grid-cols-2 gap-4 mb-5">
        <Field label="供应商 *">
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)} style={inputStyle}>
            {SUPPLIER_LIST.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="负责人 *">
          <select value={owner} onChange={(e) => setOwner(e.target.value)} style={inputStyle}>
            {OWNERS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="期望到货日 *">
          <input value={eta} onChange={(e) => setEta(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="优先级">
          <div className="flex gap-1.5">
            {(["高", "中", "低"] as const).map((p) => (
              <button key={p} onClick={() => setPriority(p)}
                className="flex-1 text-xs py-2 rounded-lg font-medium transition-colors"
                style={{
                  background: priority === p ? (p === "高" ? "#fff1f0" : p === "中" ? "#fff8f0" : A.gray6) : A.white,
                  color: priority === p ? (p === "高" ? A.red : p === "中" ? A.orange : A.gray1) : A.gray1,
                  boxShadow: `0 0 0 0.5px ${priority === p ? (p === "高" ? A.red : p === "中" ? A.orange : A.gray3) : A.gray4}`,
                }}>{p}</button>
            ))}
          </div>
        </Field>
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold" style={{ color: A.label }}>明细行 ({lines.length})</span>
        <button onClick={addLine} className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-md font-medium"
          style={{ background: "#f0f6ff", color: A.blue }}>
          <Plus size={11} /> 添加物料
        </button>
      </div>

      <div className="rounded-xl overflow-hidden" style={{ border: `0.5px solid ${A.gray4}` }}>
        <table className="w-full text-xs">
          <thead style={{ background: A.gray6 }}>
            <tr>
              {["物料", "单价", "数量", "小计", ""].map((h) => (
                <th key={h} className="text-left px-3 py-2 font-medium" style={{ color: A.gray1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const c = SKU_CATALOG.find((x) => x.sku === l.sku)!;
              return (
                <tr key={i} style={{ borderTop: "0.5px solid rgba(0,0,0,0.05)" }}>
                  <td className="px-3 py-2">
                    <select value={l.sku} onChange={(e) => updateLine(i, { sku: e.target.value })}
                      style={{ ...inputStyle, padding: "5px 6px", border: "none", background: "transparent" }}>
                      {SKU_CATALOG.map((x) => <option key={x.sku} value={x.sku}>{x.sku} · {x.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 tabular-nums" style={{ color: A.sub }}>¥{c.price.toLocaleString()}</td>
                  <td className="px-3 py-2 w-24">
                    <input type="number" min={1} value={l.qty}
                      onChange={(e) => updateLine(i, { qty: Math.max(1, parseInt(e.target.value) || 0) })}
                      style={{ ...inputStyle, padding: "4px 8px" }} />
                  </td>
                  <td className="px-3 py-2 tabular-nums font-medium" style={{ color: A.label }}>
                    ¥{(c.price * l.qty).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 w-10">
                    <button onClick={() => removeLine(i)} disabled={lines.length === 1}
                      className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-red-50 transition-colors"
                      style={{ color: lines.length === 1 ? A.gray3 : A.red }}>
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 px-2">
        <span className="text-xs" style={{ color: A.sub }}>
          合计 {lines.length} 行 · 数量 {lines.reduce((s, l) => s + l.qty, 0)}
        </span>
        <div className="text-right">
          <div className="fc-caption" style={{ color: A.gray2 }}>订单总额</div>
          <div className="text-xl font-semibold tracking-tight" style={{ color: A.blue }}>{fmt(total)}</div>
        </div>
      </div>

      {total > 1500000 && (
        <div className="mt-4 rounded-xl p-3 flex gap-3" style={{ background: "#fff8f0" }}>
          <AlertCircle size={14} style={{ color: A.orange }} className="shrink-0 mt-0.5" />
          <div className="text-[11px]" style={{ color: A.label }}>
            订单金额超过 {fmt(1500000)}，需财务总监会签且附 ≥ 2 家比价记录。
            <span style={{ color: A.orange }}>提交后将进入二级审批流。</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
