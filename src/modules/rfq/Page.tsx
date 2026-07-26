import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileDown, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { apiJson } from "../../lib/api-client";
import { exportRowsToCsv } from "../../lib/data-export";
import type { RfqRecord } from "../../types/scm";
import { A, Chip, RecoveryActions } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import CanonicalDownstreamPanel from "../../components/procurement/CanonicalDownstreamPanel";
import type { ActiveContext } from "../ai-assistant/Panel";
import {
  DetailFieldGrid,
  DetailSection,
} from "../../components/business/BusinessObjectDetail";
import {
  DocumentHeader,
  DocumentShell,
  statusTone,
} from "../../components/document/DocumentShell";
import {
  tableLinkClass,
  tableMinXlClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";

function displayStatus(status: string) {
  return status || "待确认";
}

export default function PurchasingRFQPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (moduleId: string) => void;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  if (!focus) return <CanonicalDownstreamPanel kind="rfqs" />;

  const [rfqs, setRfqs] = useState<RfqRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const records = await apiJson<RfqRecord[]>("/api/rfqs");
      setRfqs(records);
      setSelectedId((current) => records.some((item) => item.id === current) ? current : records[0]?.id || "");
    } catch {
      setRfqs([]);
      setSelectedId("");
      toast.error("RFQ 服务暂不可用", { description: "未返回任何本地或静态询价记录。" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (focus.entityType !== "rfq" || !focus.entityId) return;
    if (rfqs.some((item) => item.id === focus.entityId)) setSelectedId(focus.entityId);
  }, [focus.at, focus.entityId, focus.entityType, rfqs]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return rfqs;
    return rfqs.filter((item) => [item.id, item.title, item.category, item.status, item.sourceRequest, item.sourceSku]
      .some((value) => String(value || "").toLowerCase().includes(term)));
  }, [query, rfqs]);

  const selected = rfqs.find((item) => item.id === selectedId) || null;

  useEffect(() => {
    if (!selected) {
      onActiveContextChange?.(null);
      return;
    }
    onActiveContextChange?.({
      module: "procurement",
      entityType: "rfq",
      entityId: selected.id,
      entityLabel: selected.title || selected.id,
      view: "rfqs",
    });
    return () => onActiveContextChange?.(null);
  }, [onActiveContextChange, selected?.id, selected?.title]);

  const exportCsv = () => {
    exportRowsToCsv("procurement-rfq-export.csv", filtered.map((rfq) => ({
      RFQ编号: rfq.id,
      标题: rfq.title,
      品类: rfq.category,
      状态: rfq.status,
      来源申请: rfq.sourceRequest || "",
      来源SKU: rfq.sourceSku || "",
      需求数量: Number(rfq.quantity || 0),
      单位: rfq.unit || "",
      供应商数量: Number(rfq.suppliers || 0),
      报价响应数量: Number(rfq.quoted || 0),
      截止日期: rfq.due || "",
    })));
  };

  if (selected) {
    return (
      <DocumentShell
        title="RFQ / 寻源对象"
        documentNo={selected.id}
        moduleLabel="寻源 / RFx"
        status={displayStatus(selected.status)}
        statusTone={statusTone(displayStatus(selected.status))}
        subtitle={selected.title || selected.id}
        actions={<RecoveryActions actions={[
          { key: "list", label: "返回 RFQ 列表", onClick: () => setSelectedId(""), kind: "list" },
          { key: "procurement", label: "返回采购工作台", onClick: () => onNavigate?.("procurement"), kind: "module", tone: "subtle" },
        ]} />}
      >
        <DocumentHeader fields={[
          { label: "RFQ 编号", value: selected.id, tone: "info" },
          { label: "标题", value: selected.title || "未提供" },
          { label: "状态", value: displayStatus(selected.status), tone: statusTone(displayStatus(selected.status)) },
          { label: "报价截止日期", value: selected.due || "未提供" },
        ]} />
        <DetailSection title="PostgreSQL 权威记录" right={<Chip label="只读" color={A.blue} bg="#f0f6ff" />}>
          <DetailFieldGrid fields={[
            { label: "来源 PR", value: selected.sourceRequest || "未提供" },
            { label: "来源 SKU", value: selected.sourceSku || "未提供" },
            { label: "物料名称", value: selected.sourceName || "未提供" },
            { label: "需求数量", value: Number(selected.quantity || 0) },
            { label: "单位", value: selected.unit || "未提供" },
            { label: "供应商数量", value: Number(selected.suppliers || 0) },
            { label: "已响应供应商", value: Number(selected.quoted || 0) },
            { label: "授标供应商", value: selected.bestSupplier || "未授标" },
            { label: "最佳价格", value: Number(selected.bestPrice || 0) || "未提供" },
            { label: "关联 PO", value: selected.linkedPo || "未关联" },
          ]} />
        </DetailSection>
        <DetailSection title="数据限制">
          <p style={{ margin: 0, color: A.gray1, lineHeight: 1.6 }}>
            本视图仅展示 PostgreSQL procurement read model 返回的 RFQ 字段。报价明细、供应商产能、合同价格和推荐结果在权威模型完成前不会合成或补全。
          </p>
        </DetailSection>
      </DocumentShell>
    );
  }

  return (
    <section style={{ padding: 24 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, letterSpacing: 0 }}>RFQ</h1>
          <div style={{ color: A.gray1, marginTop: 4 }}>PostgreSQL procurement read model</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" title="刷新" onClick={() => void load()}><RefreshCw size={16} /></button>
          <button type="button" title="导出" onClick={exportCsv} disabled={filtered.length === 0}><FileDown size={16} /></button>
          <button type="button" title="返回采购工作台" onClick={() => onNavigate?.("procurement")}><ArrowLeft size={16} /></button>
        </div>
      </div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索 RFQ、标题、来源 PR 或 SKU"
        style={{ width: "min(100%, 480px)", padding: "9px 10px", marginBottom: 14 }}
      />
      <div className={tableScrollClass}>
        <table className={tableMinXlClass}>
          <thead><tr>
            <th className={thClass}>RFQ</th><th className={thClass}>标题</th><th className={thClass}>来源 PR</th>
            <th className={thClass}>响应</th><th className={thClass}>截止日期</th><th className={thClass}>状态</th><th className={thClass}>操作</th>
          </tr></thead>
          <tbody>
            {filtered.map((rfq) => <tr key={rfq.id}>
              <td className={tdIdClass}>{rfq.id}</td>
              <td className={tdNameClass}>{rfq.title || "未提供"}</td>
              <td className={tdNowrapClass}>{rfq.sourceRequest ? <BusinessEntityLink entityType="purchase_request" entityId={rfq.sourceRequest}>{rfq.sourceRequest}</BusinessEntityLink> : "未提供"}</td>
              <td className={tdNumericClass}>{Number(rfq.quoted || 0)}/{Number(rfq.suppliers || 0)}</td>
              <td className={tdNowrapClass}>{rfq.due || "未提供"}</td>
              <td className={tdNowrapClass}>{displayStatus(rfq.status)}</td>
              <td className={tdActionClass}><button type="button" className={tableLinkClass} onClick={() => setSelectedId(rfq.id)}>查看</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {!loading && filtered.length === 0 && <p style={{ color: A.gray1 }}>当前 PostgreSQL 工作区没有 RFQ 记录。</p>}
      {loading && <p style={{ color: A.gray1 }}>正在读取 RFQ...</p>}
    </section>
  );
}
