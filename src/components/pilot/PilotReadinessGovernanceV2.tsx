import { useMemo, useState } from "react";
import { ArrowRight, Bot, ClipboardCheck, DatabaseZap, FileCheck2, Gauge, History, Layers3, ListChecks, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import { typography } from "../../components/ui/typography";
import type { PilotNavigationLink, PilotReadinessGovernanceV2 as PilotPayload } from "../../modules/pilot-readiness/pilotReadinessGovernance";

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown }) => void;

const buttonClass = "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold";
const filterLabels = ["全部", "可进入试点观察", "需人工复核", "需补充数据", "需治理确认", "阻塞项", "观察项", "数据限制"] as const;

function focusFrom(link?: PilotNavigationLink | null) {
  if (!link?.entityType || !link.entityId) return null;
  return { entityType: link.entityType, entityId: link.entityId };
}

function returnContext() {
  return {
    sourceModule: "pilot-readiness",
    sourceRoute: "pilot-readiness",
    sourceLabel: "试点准备度",
    returnLabel: "返回试点准备度",
    originIntent: "pilotReadinessGovernance",
  };
}

function navigateWithContext(onNavigate: NavigateFn, link: PilotNavigationLink) {
  onNavigate(link.moduleId, focusFrom(link), {
    returnTo: "pilot-readiness",
    entityLabel: link.entityLabel || link.label,
    source: "pilotReadinessGovernance",
    returnContext: returnContext(),
  });
}

function LinkButton({ link, onNavigate, primary = false, label }: { link: PilotNavigationLink; onNavigate: NavigateFn; primary?: boolean; label?: string }) {
  return (
    <button type="button" onClick={() => navigateWithContext(onNavigate, link)} className={buttonClass}
      style={primary ? { background: A.blue, color: A.white } : { background: "#eef4ff", color: A.blue }}>
      {label || link.label}<ArrowRight size={13} />
    </button>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle?: string }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Icon size={16} />
        <h2 className={typography.sectionTitle} style={{ color: A.label }}>{title}</h2>
      </div>
      {subtitle && <div className="mt-1 text-[12px] leading-5" style={{ color: A.sub }}>{subtitle}</div>}
    </div>
  );
}

function MiniList({ items, limit = 4 }: { items?: string[]; limit?: number }) {
  const safe = Array.isArray(items) ? items.filter(Boolean) : [];
  return <span>{safe.slice(0, limit).join("、")}{safe.length > limit ? ` 等 ${safe.length} 项` : ""}</span>;
}

function Score({ value }: { value: number }) {
  const color = value >= 82 ? A.green : value >= 72 ? A.orange : A.red;
  return <span className="font-semibold tabular-nums" style={{ color }}>{value}</span>;
}

function SummaryCards({ payload }: { payload: PilotPayload }) {
  const rows = [
    ["综合准备度", `${payload.summary.overallReadinessScore}`],
    ["可观察模块", payload.summary.readyModuleCount],
    ["需复核模块", payload.summary.reviewNeededModuleCount],
    ["阻塞项", payload.summary.blockedItemCount],
    ["观察项", payload.summary.observationItemCount],
    ["数据准备度", payload.summary.dataReadinessScore],
    ["AI 准备度", payload.summary.aiReadinessScore],
    ["治理准备度", payload.summary.governanceReadinessScore],
    ["复核链路准备度", payload.summary.reviewWorkflowReadinessScore],
    ["协同准备度", payload.summary.collaborationReadinessScore],
    ["审计历史准备度", payload.summary.auditHistoryReadinessScore],
    ["试点复核草稿", payload.summary.pilotDraftCount],
    ["数据限制", payload.summary.dataLimitedCount],
    ["当前状态", payload.summary.readinessLabel],
  ] as const;
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {rows.map(([label, value]) => (
        <Card key={label} className="rounded-xl p-3">
          <div className="text-[11px]" style={{ color: A.sub }}>{label}</div>
          <div className="mt-1 truncate text-[18px] font-bold tabular-nums" style={{ color: A.label }}>{value}</div>
        </Card>
      ))}
    </section>
  );
}

function ProfileAndScope({ payload, onNavigate }: { payload: PilotPayload; onNavigate: NavigateFn }) {
  const profile = payload.readinessProfile;
  const scope = payload.pilotScope;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.9fr_1.1fr]">
      <Card className="rounded-xl p-4" data-testid="pilot-readiness-profile">
        <SectionHeader icon={ShieldCheck} title="Readiness Profile" subtitle="当前工作区的准备度模式、复核模式和只读原则。" />
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {[
            ["工作区名称", profile.workspaceName],
            ["业务范围", profile.businessScopeLabel],
            ["数据范围", profile.dataScopeLabel],
            ["准备度模式", profile.readinessModeLabel],
            ["复核模式", profile.reviewModeLabel],
            ["准备度原则", profile.readinessPrinciples.join("、")],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
              <div className="text-[11px]" style={{ color: A.gray2 }}>{label}</div>
              <div className="mt-1 text-[12px] font-semibold leading-5" style={{ color: A.label }}>{value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="rounded-xl p-4" data-testid="pilot-scope">
        <SectionHeader icon={Layers3} title="Pilot Scope" subtitle={scope.readinessSummary} />
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ScopeBlock title="包含模块" items={scope.includedModules} />
          <ScopeBlock title="包含业务对象" items={scope.includedBusinessObjects} />
          <ScopeBlock title="包含治理领域" items={scope.includedGovernanceAreas} />
          <ScopeBlock title="不包含的正式动作" items={scope.excludedActivities} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {scope.navigationLinks.slice(0, 4).map((link) => <LinkButton key={link.label} link={link} onNavigate={onNavigate} />)}
        </div>
      </Card>
    </div>
  );
}

function ScopeBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: A.border }}>
      <div className="text-[12px] font-semibold" style={{ color: A.label }}>{title}</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((item) => <Chip key={item} label={item} color={A.blue} bg="#eef4ff" />)}
      </div>
    </div>
  );
}

function filterCount(payload: PilotPayload, filter: string) {
  if (filter === "全部") return payload.moduleReadinessMatrix.length + payload.riskAndBlockerItems.length;
  if (["可进入试点观察", "需人工复核", "需补充数据", "需治理确认"].includes(filter)) {
    return payload.moduleReadinessMatrix.filter((item) => item.readinessStatus === filter).length;
  }
  if (filter === "阻塞项" || filter === "观察项") return payload.riskAndBlockerItems.filter((item) => item.severity === filter).length;
  if (filter === "数据限制") {
    return payload.moduleReadinessMatrix.filter((item) => item.dataLimitations?.length).length + payload.riskAndBlockerItems.filter((item) => item.dataLimitations?.length).length;
  }
  return 0;
}

function filterModules(items: Array<Record<string, any>>, filter: string) {
  if (filter === "全部") return items;
  if (["可进入试点观察", "需人工复核", "需补充数据", "需治理确认"].includes(filter)) return items.filter((item) => item.readinessStatus === filter);
  if (filter === "数据限制") return items.filter((item) => item.dataLimitations?.length);
  return [];
}

function filterRisks(items: Array<Record<string, any>>, filter: string) {
  if (filter === "全部") return items;
  if (filter === "阻塞项" || filter === "观察项") return items.filter((item) => item.severity === filter);
  if (filter === "需人工复核") return items.filter((item) => item.severity === "需复核");
  if (filter === "数据限制") return items.filter((item) => item.dataLimitations?.length);
  return [];
}

function ModuleMatrix({ payload, onNavigate }: { payload: PilotPayload; onNavigate: NavigateFn }) {
  const [filter, setFilter] = useState<string>("全部");
  const modules = useMemo(() => filterModules(payload.moduleReadinessMatrix, filter), [payload.moduleReadinessMatrix, filter]);
  const risks = useMemo(() => filterRisks(payload.riskAndBlockerItems, filter), [payload.riskAndBlockerItems, filter]);
  return (
    <Card className="rounded-xl p-4" data-testid="pilot-module-readiness">
      <SectionHeader icon={Gauge} title="Module Readiness Matrix" subtitle="筛选只影响模块准备度和阻塞 / 观察事项展示。" />
      <div className="mt-4 flex flex-wrap gap-2" data-testid="pilot-readiness-filters">
        {filterLabels.map((label) => {
          const active = filter === label;
          return (
            <button key={label} type="button" onClick={() => setFilter(label)}
              className="h-8 rounded-md px-3 text-[12px] font-semibold"
              style={active ? { background: A.blue, color: A.white } : { background: A.gray6, color: A.label }}>
              {label} {filterCount(payload, label)}
            </button>
          );
        })}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {modules.length === 0 && risks.length === 0 && (
          <div className="rounded-xl px-4 py-8 text-center text-sm xl:col-span-2" style={{ background: A.gray6, color: A.sub }}>
            当前分类暂无准备度事项，可切换全部或查看来源模块
          </div>
        )}
        {modules.map((item) => (
          <div key={item.id} className="rounded-xl border p-3" style={{ borderColor: A.border, background: "#fbfdff" }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip label={item.readinessStatus} color={item.readinessStatus === "可进入试点观察" ? A.green : A.orange} bg={item.readinessStatus === "可进入试点观察" ? "#ecfdf3" : "#fff7ed"} />
                  <span className="text-[11px]" style={{ color: A.gray2 }}>{item.moduleGroup}</span>
                </div>
                <div className="mt-2 text-[13px] font-semibold" style={{ color: A.label }}>{item.moduleLabel}</div>
              </div>
              <div className="text-[18px] font-bold"><Score value={item.readinessScore} /></div>
            </div>
            <div className="mt-2 text-[12px] leading-5" style={{ color: A.label }}>证据：<MiniList items={item.readinessEvidence} /></div>
            <div className="mt-1 text-[12px] leading-5" style={{ color: A.sub }}>需要复核：{item.requiredReview}</div>
            {item.blockers?.length > 0 && <div className="mt-1 text-[12px]" style={{ color: A.red }}>阻塞项：<MiniList items={item.blockers} /></div>}
            {item.observations?.length > 0 && <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>观察项：<MiniList items={item.observations} /></div>}
            <div className="mt-3 flex flex-wrap gap-2">
              {item.navigationLinks?.slice(0, 1).map((link: PilotNavigationLink) => <LinkButton key={link.label} link={link} onNavigate={onNavigate} />)}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5" data-testid="pilot-risk-items">
        <SectionHeader icon={ListChecks} title="Risk and Blocker Items" subtitle="阻塞项 / 需复核 / 观察项用于试点前复核排序。" />
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {risks.map((item) => (
            <div key={item.id} className="rounded-xl border p-3" style={{ borderColor: A.border }}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip label={item.severity} color={item.severity === "阻塞项" ? A.red : item.severity === "观察项" ? A.blue : A.orange} bg={item.severity === "阻塞项" ? "#fff1f0" : item.severity === "观察项" ? "#eef4ff" : "#fff7ed"} />
                <span className="text-[11px]" style={{ color: A.gray2 }}>{item.readinessArea}</span>
              </div>
              <div className="mt-2 text-[13px] font-semibold" style={{ color: A.label }}>{item.itemLabel}</div>
              <div className="mt-1 text-[12px] leading-5" style={{ color: A.sub }}>{item.sourceModule} · {item.ownerRole} · {item.dueLabel}</div>
              <div className="mt-2 text-[12px] leading-5" style={{ color: A.label }}>{item.impactSummary}</div>
              <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>需要动作：{item.requiredAction}</div>
              {item.navigationLinks?.[0] && <div className="mt-3"><LinkButton link={item.navigationLinks[0]} onNavigate={onNavigate} /></div>}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function AssessmentGrid({ title, icon, testId, items, render, subtitle }: { title: string; icon: LucideIcon; testId: string; items: Array<Record<string, any>>; render: (item: Record<string, any>) => React.ReactNode; subtitle?: string }) {
  return (
    <Card className="rounded-xl p-4" data-testid={testId}>
      <SectionHeader icon={icon} title={title} subtitle={subtitle} />
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((item) => render(item))}
      </div>
    </Card>
  );
}

function CompactAssessmentCard({ title, score, meta, body, detail, links, onNavigate }: { title: string; score?: number; meta?: string; body?: string; detail?: string[]; links?: PilotNavigationLink[]; onNavigate: NavigateFn }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: A.border }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold" style={{ color: A.label }}>{title}</div>
          {meta && <div className="mt-1 text-[12px]" style={{ color: A.sub }}>{meta}</div>}
        </div>
        {typeof score === "number" && <div className="text-[16px] font-bold"><Score value={score} /></div>}
      </div>
      {body && <div className="mt-2 text-[12px] leading-5" style={{ color: A.label }}>{body}</div>}
      {detail && detail.length > 0 && <div className="mt-2 text-[12px]" style={{ color: A.gray1 }}><MiniList items={detail} limit={5} /></div>}
      {links?.[0] && <div className="mt-3"><LinkButton link={links[0]} onNavigate={onNavigate} /></div>}
    </div>
  );
}

function ReadinessSections({ payload, onNavigate }: { payload: PilotPayload; onNavigate: NavigateFn }) {
  return (
    <div className="space-y-4">
      <AssessmentGrid title="Data Readiness Assessment" icon={DatabaseZap} testId="pilot-data-readiness" items={payload.dataReadinessAssessment}
        subtitle="字段映射、数据质量事项、采购证据、收货 / 发票关联和数据限制。"
        render={(item) => <CompactAssessmentCard key={item.id} title={item.assessmentLabel} score={item.readinessScore} meta={item.sourceModule} body={item.requiredReview}
          detail={[...(item.coveredObjects || []), ...(item.dataQualitySignals || []), ...(item.evidenceGaps || [])]} links={item.navigationLinks} onNavigate={onNavigate} />} />

      <AssessmentGrid title="AI Readiness Assessment" icon={Bot} testId="pilot-ai-readiness" items={payload.aiReadinessAssessment}
        subtitle="AI 只解释、组织证据、生成草稿预览，并跳转人工复核。"
        render={(item) => <CompactAssessmentCard key={item.id} title={item.assessmentLabel} score={item.readinessScore} meta={item.sourceModule} body={item.reviewBoundary}
          detail={[...(item.supportedQuestions || []), ...(item.evidenceCoverage || []), item.draftBoundary]} links={item.navigationLinks} onNavigate={onNavigate} />} />

      <AssessmentGrid title="Review Workflow Readiness" icon={ClipboardCheck} testId="pilot-review-workflow" items={payload.reviewWorkflowReadiness}
        render={(item) => <CompactAssessmentCard key={item.id} title={item.workflowLabel} score={item.readinessScore} meta={item.sourceModule} body={`状态：${(item.reviewStates || []).join("、")}`}
          detail={[...(item.coveredDraftTypes || []), ...(item.allowedTransitions || []), ...(item.boundaryLabels || [])]} links={item.navigationLinks} onNavigate={onNavigate} />} />

      <AssessmentGrid title="Collaboration Readiness" icon={Users} testId="pilot-collaboration-readiness" items={payload.collaborationReadiness}
        render={(item) => <CompactAssessmentCard key={item.id} title={item.collaborationLabel} score={item.readinessScore} meta={item.sourceModule} body={item.reviewBoundary}
          detail={[...(item.supportedDraftTypes || []), ...(item.audienceGroups || []), ...(item.channelPolicies || [])]} links={item.navigationLinks} onNavigate={onNavigate} />} />

      <AssessmentGrid title="Governance Readiness" icon={ShieldCheck} testId="pilot-governance-readiness" items={payload.governanceReadiness}
        render={(item) => <CompactAssessmentCard key={item.id} title={item.governanceLabel} score={item.readinessScore} meta={`${item.sourceModule} · ${item.governanceArea}`} body={item.blockerSummary}
          detail={[...(item.readinessEvidence || []), item.requiredReview]} links={item.navigationLinks} onNavigate={onNavigate} />} />

      <AssessmentGrid title="Audit History Readiness" icon={History} testId="pilot-audit-history-readiness" items={payload.auditHistoryReadiness}
        render={(item) => <CompactAssessmentCard key={item.id} title={item.historyLabel} score={item.readinessScore} meta={item.sourceModule} body={item.reviewBoundary}
          detail={[...(item.coveredHistoryTypes || []), item.timelineCoverage, item.navigationCoverage, item.dataLimitationCoverage]} links={item.navigationLinks} onNavigate={onNavigate} />} />
    </div>
  );
}

function ChecklistAndDrafts({ payload, onNavigate }: { payload: PilotPayload; onNavigate: NavigateFn }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.95fr_1.05fr]">
      <Card className="rounded-xl p-4" data-testid="pilot-review-checklist">
        <SectionHeader icon={FileCheck2} title="Pilot Review Checklist" subtitle="试点复核清单只用于人工复核排序。" />
        <div className="mt-4 space-y-2">
          {payload.pilotReviewChecklist.map((item) => (
            <div key={item.id} className="rounded-xl border p-3" style={{ borderColor: A.border }}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip label={item.status} color={item.status === "已具备观察条件" ? A.green : A.orange} bg={item.status === "已具备观察条件" ? "#ecfdf3" : "#fff7ed"} />
                <span className="text-[11px]" style={{ color: A.gray2 }}>{item.readinessArea}</span>
              </div>
              <div className="mt-2 text-[13px] font-semibold" style={{ color: A.label }}>{item.checklistLabel}</div>
              <div className="mt-1 text-[12px]" style={{ color: A.sub }}>{item.requiredReviewerRole} · {item.nextReviewStep}</div>
              <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>证据：<MiniList items={item.evidence} /></div>
              {item.navigationLinks?.[0] && <div className="mt-3"><LinkButton link={item.navigationLinks[0]} onNavigate={onNavigate} /></div>}
            </div>
          ))}
        </div>
      </Card>

      <Card className="rounded-xl p-4" data-testid="pilot-review-drafts">
        <SectionHeader icon={ListChecks} title="Pilot Review Drafts" subtitle="试点事项只生成复核草稿，不改变业务对象状态。" />
        <div className="mt-4 space-y-3">
          {payload.pilotReviewDrafts.map((item) => (
            <div key={item.id} className="rounded-xl border p-3" style={{ borderColor: A.border, background: "#fbfdff" }}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip label={item.status} color={A.blue} bg="#eef4ff" />
                <Chip label={item.priority} color={A.orange} bg="#fff7ed" />
                <span className="text-[11px]" style={{ color: A.gray2 }}>{item.readinessArea} · {item.ownerRole}</span>
              </div>
              <div className="mt-2 text-[13px] font-semibold" style={{ color: A.label }}>{item.title}</div>
              <div className="mt-2 text-[12px] leading-5" style={{ color: A.label }}>{item.conclusion}</div>
              <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>试点复核预览：{item.proposedPilotReviewPreview}</div>
              <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>关键证据：<MiniList items={item.keyEvidence} /></div>
              <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>复核清单：<MiniList items={item.reviewChecklist} /></div>
              <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>缺失信息：<MiniList items={item.missingInformation} /></div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={buttonClass} style={{ background: "#eef4ff", color: A.blue }}>预览试点草稿</button>
                <LinkButton link={item.navigationLinks?.[0] || { label: "进入人工复核", moduleId: "review-actions" }} onNavigate={onNavigate} label="进入人工复核" primary />
                <button type="button" className={buttonClass} style={{ background: A.gray6, color: A.label }}>标记仅内部留存</button>
                {item.navigationLinks?.[0] && <LinkButton link={item.navigationLinks[0]} onNavigate={onNavigate} label="打开来源模块" />}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function DataLimitations({ payload }: { payload: PilotPayload }) {
  return (
    <Card className="rounded-xl p-4" data-testid="pilot-data-limitations">
      <SectionHeader icon={DatabaseZap} title="Data Limitations" subtitle="集中展示影响试点准备度的当前工作区数据限制。" />
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {payload.dataLimitations.map((item, index) => (
          <div key={`${item.label}-${index}`} className="rounded-xl border p-3" style={{ borderColor: A.border }}>
            <div className="text-[13px] font-semibold" style={{ color: A.label }}>{item.label}</div>
            <div className="mt-2 text-[12px] leading-5" style={{ color: A.sub }}>{item.description}</div>
            {item.affectedModules?.length ? <div className="mt-2 text-[12px]" style={{ color: A.gray1 }}>影响模块：<MiniList items={item.affectedModules} /></div> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function PilotReadinessGovernanceV2({ payload, onNavigate }: { payload: PilotPayload; onNavigate: NavigateFn }) {
  return (
    <div className="space-y-4" data-testid="pilot-readiness-governance">
      <section className="rounded-2xl border p-5" style={{ background: A.white, borderColor: A.border }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Gauge size={20} style={{ color: A.blue }} />
              <h1 className="text-[24px] leading-8 font-bold tracking-normal" style={{ color: A.label }}>试点准备度</h1>
            </div>
            <div className="mt-2 text-[13px] leading-6" style={{ color: A.sub }}>
              当前工作区数据 · 当前仅展示试点准备度，试点事项只生成复核草稿，不改变业务对象状态，不形成正式业务处理。
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {["不启用真实外部系统", "数据不搬移", "不外发", "不写库存", "不写财务凭证", "不处理资金", "不改基础资料", "不覆盖当前工作区数据"].map((label) => (
                <Chip key={label} label={label} color={A.blue} bg="#eef4ff" />
              ))}
            </div>
          </div>
          <Chip label={payload.summary.readinessLabel} color={A.green} bg="#ecfdf3" />
        </div>
      </section>

      <SummaryCards payload={payload} />
      <ProfileAndScope payload={payload} onNavigate={onNavigate} />
      <ModuleMatrix payload={payload} onNavigate={onNavigate} />
      <ReadinessSections payload={payload} onNavigate={onNavigate} />
      <ChecklistAndDrafts payload={payload} onNavigate={onNavigate} />
      <DataLimitations payload={payload} />
    </div>
  );
}
