import { useMemo, useState } from "react";
import { ArrowRight, Bot, ClipboardCheck, DatabaseZap, FileClock, FileText, History, Layers3, Settings, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import { typography } from "../../components/ui/typography";
import type { AuditIntegrationHistoryV2 as AuditPayload, AuditNavigationLink, AuditTimelineItem } from "../../modules/audit-history/auditIntegrationHistory";

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown }) => void;

const buttonClass = "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold";

const filterLabels = [
  ["all", "全部"],
  ["ai_suggestion", "AI 建议"],
  ["drafts", "草稿复核"],
  ["collaboration_draft", "协同草稿"],
  ["data_quality", "数据质量"],
  ["setup_config", "设置治理"],
  ["role_permission", "角色权限"],
  ["workspace_boundary", "工作区边界"],
  ["objects", "业务对象"],
  ["review", "待人工复核"],
  ["limited", "数据限制"],
] as const;

function focusFrom(link?: Pick<AuditNavigationLink, "entityType" | "entityId"> | null) {
  if (!link?.entityType || !link.entityId) return null;
  return { entityType: link.entityType, entityId: link.entityId };
}

function returnContext() {
  return {
    sourceModule: "audit-history",
    sourceRoute: "audit-history",
    sourceLabel: "业务审计与历史",
    returnLabel: "返回业务审计与历史",
    originIntent: "auditIntegrationHistory",
  };
}

function navigateWithContext(onNavigate: NavigateFn, link: AuditNavigationLink) {
  onNavigate(link.moduleId, focusFrom(link), {
    returnTo: "audit-history",
    entityLabel: link.entityLabel || link.label,
    source: "auditIntegrationHistory",
    returnContext: returnContext(),
  });
}

function LinkButton({ link, onNavigate, primary = false }: { link: AuditNavigationLink; onNavigate: NavigateFn; primary?: boolean }) {
  return (
    <button type="button" onClick={() => navigateWithContext(onNavigate, link)} className={buttonClass}
      style={primary ? { background: A.blue, color: A.white } : { background: "#eef4ff", color: A.blue }}>
      {link.label}<ArrowRight size={13} />
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

function MiniList({ items, limit = 3 }: { items?: string[]; limit?: number }) {
  const safe = Array.isArray(items) ? items.filter(Boolean) : [];
  return <span>{safe.slice(0, limit).join("、")}{safe.length > limit ? ` 等 ${safe.length} 项` : ""}</span>;
}

function SummaryCards({ payload }: { payload: AuditPayload }) {
  const rows = [
    ["历史总数", payload.summary.totalHistoryCount],
    ["AI 建议历史", payload.summary.aiHistoryCount],
    ["行动草稿历史", payload.summary.actionDraftHistoryCount],
    ["协同草稿历史", payload.summary.collaborationHistoryCount],
    ["数据质量历史", payload.summary.dataQualityHistoryCount],
    ["设置治理历史", payload.summary.setupGovernanceHistoryCount],
    ["角色权限历史", payload.summary.rolePermissionHistoryCount],
    ["工作区边界历史", payload.summary.boundaryHistoryCount],
    ["业务对象历史", payload.summary.businessObjectHistoryCount],
    ["待人工复核", payload.summary.reviewRequiredCount],
    ["数据限制", payload.summary.dataLimitedCount],
    ["当前状态", payload.summary.readinessLabel],
  ] as const;
  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
      {rows.map(([label, value]) => (
        <Card key={label} className="rounded-xl p-3">
          <div className="text-[11px]" style={{ color: A.sub }}>{label}</div>
          <div className="mt-1 truncate text-[20px] font-bold tabular-nums" style={{ color: A.label }}>{value}</div>
        </Card>
      ))}
    </section>
  );
}

function HistoryProfile({ payload }: { payload: AuditPayload }) {
  const profile = payload.historyProfile;
  const rows = [
    ["工作区名称", profile.workspaceName],
    ["业务范围", profile.businessScopeLabel],
    ["数据范围", profile.dataScopeLabel],
    ["历史模式", profile.historyModeLabel],
    ["复核模式", profile.reviewModeLabel],
    ["历史原则", profile.historyPrinciples.join("、")],
  ] as const;
  return (
    <Card className="rounded-xl p-4" data-testid="audit-history-profile">
      <SectionHeader icon={ShieldCheck} title="历史概览" subtitle="当前工作区内的只读历史、复核痕迹和来源说明。" />
      <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
            <div className="text-[11px]" style={{ color: A.gray2 }}>{label}</div>
            <div className="mt-1 text-[12px] font-semibold leading-5" style={{ color: A.label }}>{value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function filterCount(payload: AuditPayload, filter: string) {
  if (filter === "all") return payload.timeline.length;
  if (filter === "drafts") return payload.timeline.filter((item) => item.category === "action_draft").length;
  if (filter === "objects") return payload.timeline.filter((item) => ["procurement_object", "supplier_object", "inventory_object", "finance_review"].includes(item.category)).length;
  if (filter === "review") return payload.timeline.filter((item) => item.reviewRequired).length;
  if (filter === "limited") return payload.timeline.filter((item) => item.dataLimited).length;
  return payload.timeline.filter((item) => item.category === filter).length;
}

function applyFilter(items: AuditTimelineItem[], filter: string) {
  if (filter === "all") return items;
  if (filter === "drafts") return items.filter((item) => item.category === "action_draft");
  if (filter === "objects") return items.filter((item) => ["procurement_object", "supplier_object", "inventory_object", "finance_review"].includes(item.category));
  if (filter === "review") return items.filter((item) => item.reviewRequired);
  if (filter === "limited") return items.filter((item) => item.dataLimited);
  return items.filter((item) => item.category === filter);
}

function Timeline({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  const [filter, setFilter] = useState<string>("all");
  const rows = useMemo(() => applyFilter(payload.timeline, filter), [payload.timeline, filter]);
  return (
    <Card className="rounded-xl p-4" data-testid="audit-history-timeline">
      <SectionHeader icon={History} title="历史时间线" subtitle="筛选只影响当前时间线展示，不改变业务对象状态。" />
      <div className="mt-4 flex flex-wrap gap-2" data-testid="audit-history-filters">
        {filterLabels.map(([key, label]) => {
          const active = filter === key;
          return (
            <button key={key} type="button" onClick={() => setFilter(key)}
              className="h-8 rounded-md px-3 text-[12px] font-semibold"
              style={active ? { background: A.blue, color: A.white } : { background: A.gray6, color: A.label }}>
              {label} {filterCount(payload, key)}
            </button>
          );
        })}
      </div>
      <div className="mt-4 space-y-3">
        {rows.length === 0 && (
          <div className="rounded-xl px-4 py-8 text-center text-sm" style={{ background: A.gray6, color: A.sub }}>
            当前分类暂无历史记录，可切换全部或查看来源模块
          </div>
        )}
        {rows.map((item) => (
          <div key={item.id} className="rounded-xl border p-3" style={{ borderColor: A.border, background: "#fbfdff" }}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip label={item.categoryLabel} color={A.blue} bg="#eef4ff" />
                  <span className="text-[11px]" style={{ color: A.gray2 }}>{item.occurredAtLabel}</span>
                  {item.reviewRequired && <Chip label="待人工复核" color={A.orange} bg="#fff7ed" />}
                  {item.dataLimited && <Chip label="数据限制" color={A.red} bg="#fff1f0" />}
                </div>
                <div className="mt-2 text-[13px] font-semibold" style={{ color: A.label }}>{item.title}</div>
                <div className="mt-1 text-[12px] leading-5" style={{ color: A.sub }}>
                  {item.sourceModule} · {item.sourceObjectLabel} · {item.targetObjectLabel} · {item.actorRoleLabel}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {item.navigationLinks.slice(0, 1).map((link) => <LinkButton key={`${item.id}-${link.label}`} link={link} onNavigate={onNavigate} />)}
              </div>
            </div>
            <div className="mt-2 text-[12px] leading-5" style={{ color: A.label }}>{item.summary}</div>
            <div className="mt-2 text-[12px]" style={{ color: A.gray1 }}>关键证据：<MiniList items={item.keyEvidence} limit={4} /></div>
            <div className="mt-1 text-[12px]" style={{ color: A.gray1 }}>边界说明：<MiniList items={item.boundaryLabels} limit={5} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function CompactGrid({ title, icon, testId, children, subtitle }: { title: string; icon: LucideIcon; testId: string; children: React.ReactNode; subtitle?: string }) {
  return (
    <Card className="rounded-xl p-4" data-testid={testId}>
      <SectionHeader icon={icon} title={title} subtitle={subtitle} />
      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">{children}</div>
    </Card>
  );
}

function HistoryCard({ title, meta, body, detail, links, onNavigate }: { title: string; meta?: string; body?: string; detail?: string[]; links?: AuditNavigationLink[]; onNavigate: NavigateFn }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: A.border }}>
      <div className="text-[13px] font-semibold" style={{ color: A.label }}>{title}</div>
      {meta && <div className="mt-1 text-[12px]" style={{ color: A.sub }}>{meta}</div>}
      {body && <div className="mt-2 text-[12px] leading-5" style={{ color: A.label }}>{body}</div>}
      {detail && detail.length > 0 && <div className="mt-2 text-[12px]" style={{ color: A.gray1 }}><MiniList items={detail} limit={4} /></div>}
      {links?.[0] && <div className="mt-3"><LinkButton link={links[0]} onNavigate={onNavigate} /></div>}
    </div>
  );
}

function AiHistory({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <CompactGrid title="AI 建议历史" icon={Bot} testId="ai-suggestion-history" subtitle="AI 建议、关键证据、业务影响、数据限制和复核边界。">
      {payload.aiSuggestionHistory.slice(0, 6).map((item) => (
        <HistoryCard key={item.id} title={item.suggestionLabel} meta={`${item.categoryLabel} · ${item.sourceModule}`} body={item.conclusion}
          detail={["关键证据", ...item.evidenceSummary, "业务影响", item.businessImpact, "数据限制", item.dataLimitations?.[0]?.label || "当前无额外限制", "复核边界", item.reviewBoundary]}
          links={item.navigationLinks} onNavigate={onNavigate} />
      ))}
    </CompactGrid>
  );
}

function DraftHistory({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <CompactGrid title="草稿复核历史" icon={ClipboardCheck} testId="review-draft-history" subtitle="行动草稿、配置复核草稿、权限复核草稿、边界复核草稿。">
      {payload.reviewDraftHistory.filter((item) => /行动草稿|配置复核草稿|权限复核草稿|边界复核草稿/.test(`${item.draftTypeLabel} ${item.draftLabel}`)).slice(0, 8).map((item) => (
        <HistoryCard key={item.id} title={item.draftLabel} meta={`${item.draftTypeLabel} · ${item.sourceModule} · ${item.status}`} body={item.conclusion}
          detail={item.reviewChecklist} links={item.navigationLinks} onNavigate={onNavigate} />
      ))}
    </CompactGrid>
  );
}

function CollaborationHistory({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <CompactGrid title="协同草稿历史" icon={FileText} testId="collaboration-draft-history" subtitle="内部协同备注、供应商沟通草稿、财务复核说明、数据质量说明等。">
      {payload.collaborationDraftHistory.slice(0, 8).map((item) => (
        <HistoryCard key={item.id} title={item.draftLabel} meta={`${item.collaborationTypeLabel} · ${item.audienceLabel}`} body={item.messagePurpose}
          detail={["关键证据", ...item.keyEvidence, "边界说明", ...(item.boundaryLabels || [])]} links={item.navigationLinks} onNavigate={onNavigate} />
      ))}
    </CompactGrid>
  );
}

function DataHistory({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <CompactGrid title="数据接入历史" icon={DatabaseZap} testId="data-access-history" subtitle="字段映射、数据质量事项、数据补齐、证据缺口和下游影响。">
      {payload.dataAccessHistory.slice(0, 8).map((item) => (
        <HistoryCard key={item.id} title={item.historyLabel} meta={`${item.dataObjectLabel} · ${item.issueTypeLabel}`} body={item.suggestedReview}
          detail={["影响模块", ...(item.affectedModules || []), "影响洞察", ...(item.affectedInsights || []), "数据限制", item.dataLimitations?.[0]?.label || "当前无额外限制"]}
          links={item.navigationLinks} onNavigate={onNavigate} />
      ))}
    </CompactGrid>
  );
}

function GovernanceHistory({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <Card className="rounded-xl p-4" data-testid="settings-role-boundary-history">
      <SectionHeader icon={Settings} title="设置与权限历史" subtitle="工作区配置历史、角色权限历史、工作区边界历史。" />
      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-3">
        {payload.settingsGovernanceHistory.slice(0, 4).map((item) => (
          <HistoryCard key={item.id} title={item.historyLabel} meta={`${item.governanceTypeLabel} · ${item.status}`} body={item.conclusion}
            detail={item.reviewChecklist} links={item.navigationLinks} onNavigate={onNavigate} />
        ))}
        {payload.rolePermissionHistory.slice(0, 4).map((item) => (
          <HistoryCard key={item.id} title={item.historyLabel} meta={`${item.roleLabel} · ${item.permissionAreaLabel}`} body={item.restrictedScopes?.join("；")}
            detail={["可见对象", ...(item.visibleObjects || []), "复核范围", ...(item.reviewScopes || [])]} links={item.navigationLinks} onNavigate={onNavigate} />
        ))}
        {payload.boundaryReviewHistory.slice(0, 4).map((item) => (
          <HistoryCard key={item.id} title={item.historyLabel} meta={`${item.boundaryScopeLabel} · ${item.ownerRoleLabel}`} body={item.boundarySummary}
            detail={["影响对象", ...(item.affectedObjects || []), "复核清单", ...(item.reviewChecklist || [])]} links={item.navigationLinks} onNavigate={onNavigate} />
        ))}
      </div>
    </Card>
  );
}

function ObjectHistory({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <Card className="rounded-xl p-4" data-testid="business-object-history">
      <SectionHeader icon={Layers3} title="业务对象历史" subtitle="PR、RFQ、PO、GRN、Invoice、Supplier Operational Profile、SKU 和草稿对象的证据用途。" />
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[1080px] text-left">
          <thead style={{ background: "#fbfdff" }}>
            <tr>{["业务对象", "对象类型", "来源模块", "关联模块", "证据用途", "AI 用途", "复核用途", "协同用途", "最新信号", "跳转"].map((header) => (
              <th key={header} className="px-3 py-3 text-[12px] font-semibold" style={{ color: A.gray1 }}>{header}</th>
            ))}</tr>
          </thead>
          <tbody>
            {payload.businessObjectHistory.map((item, index) => (
              <tr key={item.id} style={{ borderTop: index ? `1px solid ${A.border}` : "none" }}>
                <td className="px-3 py-3 text-[13px] font-semibold" style={{ color: A.label }}>{item.objectLabel}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}>{item.objectTypeLabel}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}>{item.sourceModule}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}><MiniList items={item.relatedModules} /></td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}>{item.evidenceUse}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}>{item.aiUse}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}>{item.reviewUse}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.sub }}>{item.collaborationUse}</td>
                <td className="px-3 py-3 text-[12px]" style={{ color: A.blue }}>{item.latestSignalLabel}</td>
                <td className="px-3 py-3">{item.navigationLinks?.[0] && <LinkButton link={item.navigationLinks[0]} onNavigate={onNavigate} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DataLimitations({ payload }: { payload: AuditPayload }) {
  return (
    <Card className="rounded-xl p-4" data-testid="audit-history-data-limitations">
      <SectionHeader icon={FileClock} title="数据限制" subtitle="集中展示当前历史中心受到的数据范围和证据限制。" />
      <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {payload.dataLimitations.map((item, index) => (
          <div key={`${item.label}-${index}`} className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
            <div className="text-[12px] font-semibold" style={{ color: A.label }}>{item.label}</div>
            <div className="mt-1 text-[12px] leading-5" style={{ color: A.sub }}>{item.description || "需要人工复核。"}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AuditIntegrationHistoryV2({ payload, onNavigate }: { payload: AuditPayload; onNavigate: NavigateFn }) {
  return (
    <div className="space-y-4" data-testid="audit-integration-history">
      <section>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[24px] leading-8 font-bold tracking-normal" style={{ color: A.label }}>业务审计与历史</h1>
          <Chip label="当前工作区数据" color={A.green} bg="#ecfdf5" />
          <Chip label="只读历史" color={A.blue} bg="#eef4ff" />
        </div>
        <div className="mt-2 max-w-5xl rounded-md px-3 py-2 text-[13px] leading-5" style={{ background: "#eef4ff", color: A.blue }}>
          当前仅展示只读历史，不改变业务对象状态，不形成正式业务处理，不外发，不写库存，不写财务凭证，不处理资金，不改基础资料，不覆盖当前工作区数据。
        </div>
      </section>
      <SummaryCards payload={payload} />
      <HistoryProfile payload={payload} />
      <Timeline payload={payload} onNavigate={onNavigate} />
      <AiHistory payload={payload} onNavigate={onNavigate} />
      <DraftHistory payload={payload} onNavigate={onNavigate} />
      <CollaborationHistory payload={payload} onNavigate={onNavigate} />
      <DataHistory payload={payload} onNavigate={onNavigate} />
      <GovernanceHistory payload={payload} onNavigate={onNavigate} />
      <ObjectHistory payload={payload} onNavigate={onNavigate} />
      <DataLimitations payload={payload} />
    </div>
  );
}
