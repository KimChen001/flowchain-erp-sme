import { AlertCircle, ArrowRight, CheckCircle2, FileText, Filter, Link2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { A } from "../ui";
import { typography } from "../ui/typography";
import type { CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { fetchReviewFirstActionWorkflowV2, type ReviewActionDraft, type ReviewActionNavigationLink, type ReviewFirstActionWorkflowV2 as ReviewFirstActionWorkflowPayload } from "../../modules/action-drafts/actionWorkflow";

const filterOptions = [
  { key: "all", label: "全部" },
  { key: "waiting", label: "等待人工复核" },
  { key: "info", label: "需要补充信息" },
  { key: "high", label: "高优先级" },
  { key: "ai_response", label: "AI" },
  { key: "control_tower", label: "风险与异常" },
  { key: "reports_analytics", label: "Reports" },
  { key: "data_access_quality", label: "Data Access" },
  { key: "p2p", label: "P2P" },
  { key: "supplier_profile", label: "Supplier" },
  { key: "inventory_risk", label: "Inventory" },
  { key: "limited", label: "数据限制" },
];

const sourceLabels: Record<string, string> = {
  ai_response: "AI Response",
  control_tower: "风险与异常",
  reports_analytics: "Reports & Analytics",
  data_access_quality: "Data Access & Quality",
  purchase_request: "PR / RFQ / PO / GRN / Invoice",
  rfq_sourcing: "PR / RFQ / PO / GRN / Invoice",
  po_receiving_invoice: "PR / RFQ / PO / GRN / Invoice",
  supplier_profile: "Supplier Operational Profile",
  inventory_risk: "Inventory Risk",
};

function isHigh(priority = "") {
  return /P0|P1|高|high/i.test(priority);
}

function matchesFilter(draft: ReviewActionDraft, filter: string) {
  if (filter === "all") return true;
  if (filter === "waiting") return draft.status === "等待人工复核";
  if (filter === "info") return draft.status === "需要补充信息";
  if (filter === "high") return isHigh(draft.priority);
  if (filter === "limited") return draft.dataLimitations.length > 0 || draft.missingInformation.length > 0;
  if (filter === "p2p") return ["purchase_request", "rfq_sourcing", "po_receiving_invoice"].includes(draft.sourceCategory);
  return draft.sourceCategory === filter;
}

function focusFromLink(link: ReviewActionNavigationLink): CanonicalFocusTarget {
  return {
    entityType: link.entityType || "business_object",
    entityId: link.entityId || "",
  };
}

function transitionButtonLabel(to: string) {
  if (to === "等待人工复核") return "标记进入人工复核";
  if (to === "需要补充信息") return "要求补充信息";
  if (to === "已退回复核") return "退回复核";
  if (to === "已取消") return "取消草稿";
  if (to === "已标记人工处理") return "标记人工处理";
  return to;
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="rounded-lg border bg-white p-4" style={{ borderColor: A.border }}>
      <h3 className={`${typography.subsectionTitle} mb-3`} style={{ color: A.label }}>{title}</h3>
      {children}
    </section>
  );
}

function ListBlock({ items, empty = "暂无" }: { items: string[]; empty?: string }) {
  return (
    <div className="space-y-2">
      {items.length ? items.map((item) => (
        <div key={item} className="rounded-md px-3 py-2 text-[12px] leading-5" style={{ background: A.gray6, color: A.sub }}>{item}</div>
      )) : (
        <div className="rounded-md px-3 py-2 text-[12px]" style={{ background: A.gray6, color: A.gray2 }}>{empty}</div>
      )}
    </div>
  );
}

export function ReviewFirstActionWorkflowV2({
  onNavigate,
}: {
  onNavigate?: (moduleId: string, focusTarget?: CanonicalFocusTarget | null, options?: Record<string, unknown>) => void;
}) {
  const [workflow, setWorkflow] = useState<ReviewFirstActionWorkflowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [localStatuses, setLocalStatuses] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchReviewFirstActionWorkflowV2()
      .then((result) => {
        if (cancelled) return;
        setWorkflow(result);
        setSelectedId(result.drafts[0]?.id || "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "行动草稿加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const drafts = useMemo(() => (workflow?.drafts || []).map((draft) => ({
    ...draft,
    status: localStatuses[draft.id] || draft.status,
  })), [workflow?.drafts, localStatuses]);

  const filteredDrafts = useMemo(() => drafts.filter((draft) => matchesFilter(draft, filter)), [drafts, filter]);
  const selectedDraft = drafts.find((draft) => draft.id === selectedId) || filteredDrafts[0] || drafts[0] || null;

  function navigate(link: ReviewActionNavigationLink) {
    if (!onNavigate) return;
    onNavigate(link.moduleId, focusFromLink(link), {
      returnTo: "review-actions",
      entityLabel: link.entityLabel || link.label,
      source: "reviewFirstActionWorkflow",
      returnContext: { returnLabel: "返回 Review-first Action Workflow" },
    });
  }

  function transitionDraft(draft: ReviewActionDraft, to: string, reasonRequired: boolean) {
    if (reasonRequired && !reason.trim()) {
      setValidation("请填写原因后再更新草稿复核状态。");
      return;
    }
    setLocalStatuses((current) => ({ ...current, [draft.id]: to }));
    setValidation("");
    setReason("");
    toast.success("草稿复核状态已在当前页面更新", {
      description: "该操作不形成正式业务处理，也不会改变业务对象。",
    });
  }

  if (loading) {
    return <div className="rounded-lg border bg-white p-6 text-sm" style={{ borderColor: A.border, color: A.sub }}>正在读取行动草稿与人工复核...</div>;
  }

  if (error || !workflow) {
    return <div className="rounded-lg border bg-white p-6 text-sm" style={{ borderColor: "#ffd6d6", color: A.red }}>{error || "行动草稿暂不可用"}</div>;
  }

  const summary = [
    ["草稿总数", workflow.summary.totalDraftCount],
    ["等待人工复核", drafts.filter((draft) => draft.status === "等待人工复核").length],
    ["需要补充信息", drafts.filter((draft) => draft.status === "需要补充信息").length],
    ["已取消", drafts.filter((draft) => draft.status === "已取消").length],
    ["已标记人工处理", drafts.filter((draft) => draft.status === "已标记人工处理").length],
    ["高优先级", drafts.filter((draft) => isHigh(draft.priority)).length],
    ["数据限制事项", workflow.summary.dataLimitedCount],
    ["来源数量", workflow.summary.sourceCount],
    ["当前状态", workflow.summary.overallStatusLabel],
  ];

  return (
    <div data-testid="review-first-action-workflow-v2" className="space-y-5">
      <header className="rounded-lg border bg-white p-5" style={{ borderColor: A.border }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className={`${typography.metadata} mb-2 font-semibold`} style={{ color: A.blue }}>Review-first Action Workflow</div>
            <h1 className="text-2xl font-semibold" style={{ color: A.label }}>行动草稿与人工复核</h1>
            <p className="mt-2 max-w-3xl text-[13px] leading-6" style={{ color: A.sub }}>
              {workflow.dataScopeLabel} · 所有行动仅为草稿预览与人工复核，不形成正式业务处理。
            </p>
          </div>
          <div className="rounded-md px-3 py-2 text-[12px] leading-5" style={{ background: "#f0f6ff", color: A.blue }}>
            <ShieldCheck size={14} className="mr-1 inline" /> 草稿预览 · 人工确认 · 不外发 · 不写库存 · 不写财务凭证 · 不处理资金 · 不改基础资料
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="review-workflow-summary">
        {summary.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-white px-3 py-3" style={{ borderColor: A.border }}>
            <div className={typography.metadata} style={{ color: A.gray2 }}>{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums" style={{ color: A.label }}>{value}</div>
          </div>
        ))}
      </section>

      <Section title="Source Summary" testId="review-workflow-source-summary">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {workflow.sourceSummary.map((source) => (
            <div key={source.sourceCategory} className="rounded-lg border p-3" style={{ borderColor: A.border }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold" style={{ color: A.label }}>{source.sourceLabel}</div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>{source.topDraft}</div>
                </div>
                <button
                  type="button"
                  data-testid="review-workflow-nav-link"
                  onClick={() => source.navigationLinks[0] && navigate(source.navigationLinks[0])}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold"
                  title="跳转来源"
                  style={{ color: A.blue, background: "#eef4ff" }}
                >
                  <Link2 size={13} />{source.navigationLinks[0]?.label || "跳转来源"}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                <div><span style={{ color: A.gray2 }}>draft count</span><div className="font-semibold" style={{ color: A.label }}>{source.draftCount}</div></div>
                <div><span style={{ color: A.gray2 }}>high priority</span><div className="font-semibold" style={{ color: A.label }}>{source.highPriorityCount}</div></div>
                <div><span style={{ color: A.gray2 }}>data limitation</span><div className="font-semibold" style={{ color: A.label }}>{source.dataLimitationCount}</div></div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-2" data-testid="review-workflow-filters">
        <Filter size={14} style={{ color: A.gray2 }} />
        {filterOptions.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className="h-8 rounded-md px-3 text-[12px] font-semibold"
            style={filter === item.key ? { background: A.blue, color: A.white } : { background: A.white, color: A.gray1, border: `1px solid ${A.border}` }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.9fr)]">
        <Section title="Action Draft Inbox" testId="review-workflow-inbox">
          <div className="overflow-x-auto">
            <table className="min-w-[980px] w-full text-left text-[12px]">
              <thead style={{ color: A.gray2 }}>
                <tr className="border-b" style={{ borderColor: A.border }}>
                  {["优先级", "草稿编号", "草稿标题", "草稿类型", "来源", "目标业务对象", "当前状态", "负责人", "到期 / 年龄", "关键证据", "建议下一步", "操作"].map((label) => (
                    <th key={label} className="px-2 py-2 font-semibold">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredDrafts.map((draft) => (
                  <tr key={draft.id} className="border-b align-top" style={{ borderColor: A.border, background: selectedDraft?.id === draft.id ? "#f8fbff" : A.white }}>
                    <td className="px-2 py-3 font-semibold" style={{ color: isHigh(draft.priority) ? A.red : A.gray1 }}>{draft.priority}</td>
                    <td className="px-2 py-3 tabular-nums" style={{ color: A.label }}>{draft.draftNo}</td>
                    <td className="px-2 py-3 min-w-44 font-semibold" style={{ color: A.label }}>{draft.title}</td>
                    <td className="px-2 py-3" style={{ color: A.sub }}>{draft.draftTypeLabel}</td>
                    <td className="px-2 py-3" style={{ color: A.sub }}>{sourceLabels[draft.sourceCategory] || draft.sourceLabel}</td>
                    <td className="px-2 py-3" style={{ color: A.sub }}>{draft.targetEntityLabel}</td>
                    <td className="px-2 py-3"><span className="rounded-md px-2 py-1" style={{ background: "#eef4ff", color: A.blue }}>{draft.status}</span></td>
                    <td className="px-2 py-3" style={{ color: A.sub }}>{draft.owner}</td>
                    <td className="px-2 py-3" style={{ color: A.sub }}>{draft.dueLabel || draft.createdAtLabel}</td>
                    <td className="px-2 py-3 max-w-48" style={{ color: A.sub }}>{draft.keyEvidence[0] || "证据待复核"}</td>
                    <td className="px-2 py-3" style={{ color: A.sub }}>{draft.reviewActions[0]?.label || "人工复核"}</td>
                    <td className="px-2 py-3">
                      <button type="button" onClick={() => { setSelectedId(draft.id); setValidation(""); setReason(""); }} className="rounded-md px-2 py-1 font-semibold" style={{ background: A.blue, color: A.white }}>
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <aside data-testid="review-workflow-detail" className="space-y-4">
          {selectedDraft ? (
            <>
              <Section title="Draft Detail">
                <div className="space-y-3">
                  <div>
                    <div className={typography.metadata} style={{ color: A.gray2 }}>生命周期状态</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="rounded-md px-2 py-1 text-[12px] font-semibold" style={{ background: "#eef4ff", color: A.blue }}>{selectedDraft.status}</span>
                      <span className="text-[12px]" style={{ color: A.sub }}>{selectedDraft.draftNo} · {selectedDraft.draftTypeLabel}</span>
                    </div>
                  </div>
                  <div>
                    <div className={typography.metadata} style={{ color: A.gray2 }}>结论</div>
                    <p className="mt-1 text-[12px] leading-5" style={{ color: A.label }}>{selectedDraft.conclusion}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[12px]">
                    <div className="rounded-md px-3 py-2" style={{ background: A.gray6 }}>
                      <div style={{ color: A.gray2 }}>来源</div>
                      <div className="mt-1 font-semibold" style={{ color: A.label }}>{selectedDraft.sourceLabel}</div>
                    </div>
                    <div className="rounded-md px-3 py-2" style={{ background: A.gray6 }}>
                      <div style={{ color: A.gray2 }}>目标业务对象</div>
                      <div className="mt-1 font-semibold" style={{ color: A.label }}>{selectedDraft.targetEntityLabel}</div>
                    </div>
                  </div>
                </div>
              </Section>

              <Section title="关键证据"><ListBlock items={selectedDraft.keyEvidence} /></Section>
              <Section title="业务影响"><ListBlock items={selectedDraft.businessImpact} /></Section>
              <Section title="草稿内容预览">
                <div className="rounded-md px-3 py-3 text-[12px] leading-6" style={{ background: "#f0f6ff", color: A.label }}>
                  <FileText size={14} className="mr-1 inline" /> {selectedDraft.proposedDraftContent}
                </div>
              </Section>
              <Section title="复核清单"><ListBlock items={selectedDraft.reviewChecklist} /></Section>
              <Section title="缺失信息"><ListBlock items={selectedDraft.missingInformation} empty="当前未标记缺失信息" /></Section>
              <Section title="建议下一步">
                <ListBlock items={selectedDraft.reviewActions.map((action) => action.label)} />
              </Section>

              <Section title="可点击跳转">
                <div className="flex flex-wrap gap-2">
                  {selectedDraft.navigationLinks.map((link) => (
                    <button
                      key={`${link.moduleId}-${link.entityType}-${link.entityId}-${link.label}`}
                      type="button"
                      data-testid="review-workflow-nav-link"
                      onClick={() => navigate(link)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-semibold"
                      style={{ background: "#eef4ff", color: A.blue }}
                    >
                      {link.label}<ArrowRight size={13} />
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="数据限制"><ListBlock items={selectedDraft.dataLimitations.map((item) => `${item.label}：${item.description}`)} empty="当前草稿未标记数据限制" /></Section>

              <Section title="允许流转">
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {selectedDraft.allowedTransitions.length ? selectedDraft.allowedTransitions.map((transition) => (
                      <button
                        key={`${transition.from}-${transition.to}`}
                        type="button"
                        onClick={() => transitionDraft(selectedDraft, transition.to, transition.reasonRequired)}
                        className="rounded-md px-3 py-1.5 text-[12px] font-semibold"
                        style={{ background: transition.reasonRequired ? "#fff8f0" : "#eef4ff", color: transition.reasonRequired ? A.orange : A.blue }}
                      >
                        {transitionButtonLabel(transition.to)}
                      </button>
                    )) : (
                      <div className="text-[12px]" style={{ color: A.gray2 }}>当前状态不允许继续流转</div>
                    )}
                  </div>
                  <textarea
                    value={reason}
                    onChange={(event) => { setReason(event.target.value); setValidation(""); }}
                    placeholder="需要原因的流转请填写原因"
                    rows={3}
                    className="w-full rounded-md border px-3 py-2 text-[12px] outline-none"
                    style={{ borderColor: validation ? A.red : A.border, color: A.label }}
                  />
                  {validation && <div className="text-[12px] font-semibold" style={{ color: A.red }}><AlertCircle size={13} className="mr-1 inline" />{validation}</div>}
                </div>
              </Section>

              <Section title="需要原因的流转">
                <ListBlock items={workflow.lifecyclePolicy.reasonRequiredTransitions} />
              </Section>

              <Section title="边界说明">
                <ListBlock items={selectedDraft.boundaryLabels} />
              </Section>

              <Section title="审计预览">
                <div className="space-y-2">
                  {selectedDraft.auditTrailPreview.map((item) => (
                    <div key={item} className="flex gap-2 rounded-md px-3 py-2 text-[12px] leading-5" style={{ background: A.gray6, color: A.sub }}>
                      <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: A.green }} /> {item}
                    </div>
                  ))}
                </div>
              </Section>
            </>
          ) : (
            <Section title="Draft Detail">
              <div className="text-[12px]" style={{ color: A.gray2 }}>请选择一条行动草稿</div>
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}
