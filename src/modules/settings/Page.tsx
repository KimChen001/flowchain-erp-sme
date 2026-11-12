import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, Search, ShieldCheck, X } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { A, Card, RecoveryActions } from '../../components/ui';
import { BusinessEntityLink } from '../../components/business/BusinessEntityLink';
import { businessEntityRouteRegistry, type BusinessEntityType } from '../../components/business/businessEntityRoutes';
import { fetchAiWorkspaceStatus, fetchSettingsAudit, fetchSettingsRuntime, saveSettingsSection, type AiWorkspaceStatus, type SettingsAuditEntry, type SettingsRuntime } from './settingsRuntime';
import WorkspaceSettings from './WorkspaceSettings';
import { isTranslationKey, useI18n } from '../../i18n/I18n';
import { auditEntityIdText, auditEntityLabel, auditSummaryText } from '../../i18n/auditSummaries';
import { roleLabel } from '../../../shared/roles.mjs';
import CustomFieldsSettings from './CustomFieldsSettings';
import { DOCUMENT_NUMBER_PREFIX_PATTERN, DOCUMENT_NUMBER_TYPES, formatDocumentNumber, numberingPeriod } from '../../../shared/document-numbering.mjs';

type View = keyof SettingsRuntime | 'audit';
type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null) => void;
type Translate = ReturnType<typeof useI18n>['t'];
type TranslationKey = Parameters<Translate>[0];

// Seeded labels are stored per tenant in Chinese, so known ids are shown
// through the dictionary and anything a tenant added keeps its own label.
function labelFor(t: Translate, prefix: 'settings.module' | 'settings.capability' | 'settings.policy', id: string, stored: string) {
  const key = `${prefix}.${id}`;
  return isTranslationKey(key) ? t(key) : stored;
}

// Role codes stored on module rows, by name.
const roleNames = (roles: string[], language: string) => roles.map((role) => roleLabel(role, language)).join(language === 'en-US' ? ', ' : '、');

// Audit modules and actions are stored codes ("ai_skill", "today_priorities");
// they are shown as words, with the code kept as a tooltip.
const AUDIT_MODULES: Record<string, [string, string]> = {
  settings: ['Settings', '设置'], ai: ['AI assistant', 'AI 助手'], ai_skill: ['AI assistant', 'AI 助手'], procurement: ['Purchasing', '采购'],
  purchasing: ['Purchasing', '采购'], receiving: ['Receiving', '收货'], inventory: ['Inventory', '库存'], sales: ['Sales', '销售'],
  finance: ['Payables & receivables', '应付与应收'], master_data: ['Master data', '基础资料'], 'master-data': ['Master data', '基础资料'],
  contracts: ['Contracts', '合同'], reports: ['Reports', '报表'], auth: ['Sign-in', '登录'], workspace: ['Workspace', '工作区'],
  ai_assistant: ['AI assistant', 'AI 助手'], 'ai-assistant': ['AI assistant', 'AI 助手'], 'ai-retrieval': ['AI assistant', 'AI 助手'],
  srm: ['Suppliers', '供应商'], procurement_receiving: ['Receiving', '收货'], sales_outbound: ['Sales', '销售'], returns: ['Returns', '退货'],
  overview: ['Today', '今日'], 'action-drafts': ['Action drafts', '行动草稿'], 'user-data': ['Data import', '数据导入'], imports: ['Data import', '数据导入'],
  'universal-intake': ['Data import', '数据导入'], evidence: ['Evidence', '证据链'], notifications: ['Notifications', '通知'], 'exception-cases': ['Exception cases', '异常工单'], system: ['System', '系统'],
};
// What an audit row records, by its stored action code, for the row's
// tooltip. A code not listed reads as words in English and has no tooltip in
// Chinese; the row's summary already says what happened.
const AUDIT_ACTIONS: Record<string, [string, string]> = {
  session_created: ['Signed in', '已登录'], sign_in_link_requested: ['Sign-in link requested', '已申请登录链接'],
  sign_in_link_consumed: ['Sign-in link used', '已使用登录链接'], session_logout: ['Signed out', '已退出登录'], sessions_revoked: ['Signed-in sessions ended', '已结束登录会话'],
  profile_settings_updated: ['Profile updated', '已更新个人资料'], workspace_settings_updated: ['Workspace settings updated', '已更新工作区设置'],
  authorization_legacy_role_backfilled: ['Role assignments backfilled', '已补录角色分配'],
  create: ['Created', '已创建'], tier_change: ['Supplier tier changed', '已更改供应商分级'], owner_change: ['Supplier owner changed', '已更改供应商负责人'],
  purchase_request_created: ['Purchase request created', '已创建采购申请'], purchase_request_updated: ['Purchase request updated', '已更新采购申请'],
  purchase_order_approve: ['Purchase order approved', '已批准采购订单'], purchase_order_issue: ['Purchase order issued', '已下达采购订单'],
  purchase_order_promised_dates_revised: ['Promised dates revised', '已修改承诺交期'],
  receiving_posted: ['Receipt posted', '收货单已过账'], receiving_reversed: ['Receipt reversed', '收货单已冲销'],
  supplier_invoice_created: ['Supplier invoice created', '已创建采购发票'], supplier_invoice_submitted: ['Supplier invoice submitted', '已提交采购发票'],
  supplier_invoice_matched: ['Supplier invoice matched', '采购发票已匹配'], supplier_invoice_approved: ['Supplier invoice approved', '已批准采购发票'],
  customer_invoice_created: ['Customer invoice created', '已创建销售发票'],
  inventory_adjustment_created: ['Inventory adjustment created', '已创建库存调整单'], inventory_adjustment_ready: ['Inventory adjustment ready', '库存调整单已就绪'],
  inventory_adjustment_posted: ['Inventory adjustment posted', '库存调整单已过账'], inventory_adjustment_reversed: ['Inventory adjustment reversed', '库存调整单已冲销'],
  stock_transfer_created: ['Stock transfer created', '已创建库存调拨'], stock_transfer_posted: ['Stock transfer posted', '库存调拨已过账'],
  cycle_count_created: ['Cycle count created', '已创建循环盘点'], cycle_count_posted: ['Cycle count posted', '循环盘点已过账'],
  create_sales_order_draft: ['Sales order draft created', '销售订单草稿已创建'], revise_sales_order_draft: ['Sales order draft revised', '销售订单草稿已修改'],
  confirm_sales_order: ['Sales order confirmed', '销售订单已确认'], hold_sales_order: ['Sales order put on hold', '销售订单已暂停'],
  resume_sales_order: ['Sales order resumed', '销售订单已恢复'], sales_order_cancelled: ['Sales order cancelled', '销售订单已取消'],
  sales_inventory_reserved: ['Stock reserved for a sales order', '已为销售订单预留库存'], sales_reservation_released: ['Stock reservation released', '已释放库存预留'],
  shipment_draft_created: ['Shipment created', '发货单已创建'], shipment_draft_cancelled: ['Shipment cancelled', '发货单已取消'],
  sales_shipment_posted: ['Shipment posted', '发货单已过账'], sales_shipment_reversed: ['Shipment reversed', '发货单已冲销'],
  contract_created: ['Contract created', '已创建合同'], contract_updated: ['Contract updated', '已更新合同'], contract_activated: ['Contract activated', '合同已生效'],
  contract_terminated: ['Contract terminated', '合同已终止'], contract_renewed: ['Contract renewal started', '已开始续签合同'],
  ai_skill_answered: ['Assistant answered', '助手已回答'], ai_tool_invoked: ['Assistant read workspace data', '助手已读取工作区数据'],
  import_batch_committed: ['Data import committed', '数据导入已提交'], user_import_committed: ['Users imported', '已导入用户'],
};
const ACRONYMS: Record<string, string> = { ai: 'AI', po: 'PO', pr: 'PR', rfq: 'RFQ', grn: 'GRN', sku: 'SKU', id: 'ID' };
const humanizeCode = (code: string) => {
  const words = String(code || '').split(/[_.:-]+/).filter(Boolean).map((word) => ACRONYMS[word.toLowerCase()] || word);
  const text = words.join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
};

const AI_LEVELS = ['allow', 'review_required', 'draft_only', 'deny'] as const;
const splitRoles = (value: string) => value.split(/[、,，]\s*/).map((role) => role.trim()).filter(Boolean);

const sectionDescriptions: Record<View, { en: string; zh: string }> = {
  company: { en: 'Basic information for this workspace.', zh: '维护当前业务空间的基础信息。' },
  roles: { en: 'Manage members, roles and whether they are active.', zh: '管理访问成员、角色和启用状态。' },
  numbering: { en: 'Each document FlowChain issues is numbered prefix-year-month-sequence when it is saved. Set the prefixes here.', zh: 'FlowChain 开出的每张单据在保存时按“前缀-年月-流水号”自动编号。可在此设置前缀。' },
  review: { en: 'Purchase order approval, supplier follow-up email and invoice matching tolerances are in effect. The other review settings are not in effect yet.', zh: '采购订单审批、供应商催货邮件和发票匹配容差已生效；其他复核设置尚未生效。' },
  modules: { en: 'Choose enabled modules, their order, the default entry and which roles see them.', zh: '配置启用模块、顺序、默认入口和角色可见性。' },
  ai: { en: 'Set each AI capability to allowed, allowed after review, or not allowed.', zh: '按能力设置允许、复核或禁止等级。' },
  audit: { en: 'Search recorded settings and business audit entries.', zh: '检索真实设置与业务审计记录。' },
  advanced: { en: 'Controlled security, export and display parameters.', zh: '维护安全、导出和显示类受控参数。' },
};

// Sections that nothing reads yet (see OPERATIONAL_SETTINGS_IN_EFFECT in
// server/domain/workspace-settings-contract.mjs). They are shown read-only so
// saving never reports success for a setting that changes nothing. In the AI
// section only the AI features switch is in effect; its capability levels
// stay read-only.
const NOT_IN_EFFECT_SECTIONS: View[] = ['modules', 'advanced'];

const TOLERANCE_FIELDS = [
  { key: 'quantityTolerance', label: 'settings.tolerance.quantity', help: 'settings.tolerance.quantityHelp' },
  { key: 'pricePercentageTolerance', label: 'settings.tolerance.pricePercentage', help: 'settings.tolerance.pricePercentageHelp' },
  { key: 'priceAbsoluteTolerance', label: 'settings.tolerance.priceAbsolute', help: 'settings.tolerance.priceAbsoluteHelp' },
  { key: 'amountTolerance', label: 'settings.tolerance.amount', help: 'settings.tolerance.amountHelp' },
] as const;
type ToleranceKey = (typeof TOLERANCE_FIELDS)[number]['key'];

// Mirrors the server check: 0 or more, at most four decimal places, and the
// percentage no higher than 100.
function toleranceError(key: ToleranceKey, value: string | undefined): TranslationKey | null {
  const raw = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(raw)) return key === 'pricePercentageTolerance' ? 'settings.tolerance.percentInvalid' : 'settings.tolerance.invalid';
  if (key === 'pricePercentageTolerance' && Number(raw) > 100) return 'settings.tolerance.percentInvalid';
  return null;
}

function NotInEffect({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return <div data-testid="settings-not-in-effect">
    <div role="note" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><span className="font-semibold">{t('settings.notInEffect')}</span> · {t('settings.notInEffectDetail')}</div>
    <fieldset disabled className="opacity-70">{children}</fieldset>
  </div>;
}

const fieldClass = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

function Header({ view, dirty, saving, invalid, onSave, onCancel }: { view: View; dirty?: boolean; saving?: boolean; invalid?: boolean; onSave?: () => void; onCancel?: () => void }) {
  const { t, language } = useI18n();
  const key = ({ company: 'settings.company', roles: 'settings.roles', numbering: 'settings.numbering', review: 'settings.review', modules: 'settings.modules', ai: 'settings.ai', audit: 'settings.audit', advanced: 'settings.advanced' } as const)[view];
  const title = t(key);
  const description = sectionDescriptions[view][language === 'en-US' ? 'en' : 'zh'];
  return <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
    <p className="max-w-3xl text-sm" style={{ color: A.sub }} data-section-title={title}>{description}</p>
    {onSave && <div className="flex gap-2">{dirty && <button onClick={onCancel} disabled={saving} className={`${buttonClass} border border-slate-200 bg-white`}>{t('settings.cancel')}</button>}<button data-testid="settings-save" disabled={!dirty || saving || invalid} onClick={onSave} className={`${buttonClass} text-white`} style={{ background: A.blue }}><Save size={15} />{saving ? t('settings.saving') : dirty ? t('settings.save') : t('settings.saved')}</button></div>}
  </div>;
}

// Document numbers (shared/document-numbering.mjs): PREFIX-YYYYMM-NNNN per
// workspace, type and month, assigned when a document is saved. Only the
// prefix is a setting; a type not numbered yet says so.
function Numbering({ value, onChange, timezone }: { value: SettingsRuntime['numbering']; onChange: (v: SettingsRuntime['numbering']) => void; timezone?: string }) {
  const { t, language } = useI18n();
  const say = (en: string, zh: string) => (language === 'en-US' ? en : zh);
  const period = numberingPeriod(new Date(), timezone);
  const update = (id: string, prefix: string) => onChange({ rules: value.rules.map(rule => rule.id === id ? { ...rule, prefix } : rule) });
  const prefixes = value.rules.map(rule => rule.prefix.toUpperCase());
  const byRule = new Map<string, (typeof DOCUMENT_NUMBER_TYPES)[number]>(DOCUMENT_NUMBER_TYPES.map(entry => [entry.ruleId, entry]));
  return <div className="space-y-3" data-testid="settings-numbering-rules">
    <div role="note" className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-900">
      {say('Numbers are assigned by FlowChain when a document is saved and cannot be edited. The sequence restarts each month (workspace time) and grows past four digits when needed. Existing documents keep their numbers; a changed prefix applies to new documents. Supplier invoices keep the supplier\'s own invoice number.', '单据保存时由 FlowChain 自动编号，不能手动修改。流水号每月（按工作区时间）重新开始，超过四位时自动增加位数。已有单据保留原编号；修改前缀只影响之后新建的单据。采购发票沿用供应商自己的发票号。')}
    </div>
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead><tr className="border-b border-slate-100 text-xs" style={{ color: A.gray1 }}>
          <th className="px-4 py-3 font-medium">{t('settings.document')}</th>
          <th className="px-4 py-3 font-medium">{t('settings.prefix')}</th>
          <th className="px-4 py-3 font-medium">{say('Format this month', '本月编号格式')}</th>
          <th className="px-4 py-3 font-medium">{say('Status', '状态')}</th>
        </tr></thead>
        <tbody>{value.rules.map((rule, index) => {
          const entry = byRule.get(rule.id);
          const conflict = prefixes.indexOf(prefixes[index]) !== index;
          const invalid = !DOCUMENT_NUMBER_PREFIX_PATTERN.test(rule.prefix.toUpperCase());
          return <tr key={rule.id} className="border-t border-slate-100" data-testid={`settings-numbering-rule-${rule.id}`}>
            <td className="px-4 py-3 font-medium" style={{ color: A.label }}>{entry ? say(entry.document, entry.zh) : rule.document}</td>
            <td className="px-4 py-3">
              <input aria-label={say(`Prefix for ${entry?.document || rule.document}`, `${entry?.zh || rule.document}前缀`)} className={`${fieldClass} w-28 font-mono uppercase`} value={rule.prefix} onChange={e => update(rule.id, e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase())} />
              {conflict && <span className="mt-1 block text-xs text-red-600">{t('settings.conflict')}</span>}
              {invalid && <span className="mt-1 block text-xs text-red-600">{say('1 to 8 letters or digits.', '1 到 8 位字母或数字。')}</span>}
            </td>
            <td className="px-4 py-3 font-mono text-xs" style={{ color: A.gray1 }}>{invalid ? '—' : formatDocumentNumber(rule.prefix.toUpperCase(), period, 1)}</td>
            <td className="px-4 py-3">{entry?.applied
              ? <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">{t('settings.inEffect')}</span>
              : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600" title={say('This document type keeps its current numbers until its numbering is switched over.', '此类单据切换编号规则前，暂时沿用现有编号方式。')}>{t('settings.notInEffect')}</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

// Stored risk level codes by name.
const RISK_LEVELS: Record<string, [string, string]> = { low: ['Low', '低'], medium: ['Medium', '中'], high: ['High', '高'], critical: ['Critical', '严重'] };

function Review({ value, onChange }: { value: SettingsRuntime['review']; onChange: (v: SettingsRuntime['review']) => void }) {
  const { t, language } = useI18n();
  const separator = language === 'en-US' ? ', ' : '、';
  const riskNames = value.riskLevels.map((level) => RISK_LEVELS[level]?.[language === 'en-US' ? 0 : 1] || level).join(separator);
  const reviewerNames = roleNames(value.reviewerRoles, language);
  const [amount, setAmount] = useState(120000); const requires = value.enabled && amount >= value.amountThreshold;
  const approvesPo = value.approvedRequestApprovesPurchaseOrder !== false;
  const supplierEmail = value.supplierFollowUpEmail === true;
  return <div className="space-y-6"><section data-testid="settings-review-po-approval" className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-medium" style={{ color: A.label }}>{t('settings.poApproval')}</h2><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{t('settings.inEffect')}</span></div>
    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" data-testid="settings-approved-request-approves-po" className="mt-1" checked={approvesPo} onChange={e => onChange({ ...value, approvedRequestApprovesPurchaseOrder: e.target.checked })} /><span><span style={{ color: A.label }}>{t('settings.approvedRequestApprovesPo')}</span><span className="mt-1 block" style={{ color: A.sub }}>{t(approvesPo ? 'settings.approvedRequestApprovesPoOn' : 'settings.approvedRequestApprovesPoOff')}</span></span></label>
  </section>
  <section data-testid="settings-review-supplier-email" className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-medium" style={{ color: A.label }}>{t('settings.supplierEmail')}</h2><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{t('settings.inEffect')}</span></div>
    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" data-testid="settings-supplier-email" className="mt-1" checked={supplierEmail} onChange={e => onChange({ ...value, supplierFollowUpEmail: e.target.checked })} /><span><span style={{ color: A.label }}>{t('settings.supplierEmailToggle')}</span><span className="mt-1 block" style={{ color: A.sub }}>{t(supplierEmail ? 'settings.supplierEmailOn' : 'settings.supplierEmailOff')}</span></span></label>
  </section>
  <section data-testid="settings-review-tolerances" className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-medium" style={{ color: A.label }}>{t('settings.matchingTolerances')}</h2><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{t('settings.inEffect')}</span></div>
    <p className="mt-1 text-sm" style={{ color: A.sub }}>{t('settings.matchingTolerancesHelp')}</p>
    <div className="mt-4 grid gap-4 md:grid-cols-2">{TOLERANCE_FIELDS.map(field => { const error = toleranceError(field.key, value[field.key]); const inputId = `settings-${field.key}`; const helpId = `${inputId}-help`; return <div key={field.key} className="text-sm"><label htmlFor={inputId}>{t(field.label)}</label><input id={inputId} inputMode="decimal" aria-invalid={Boolean(error)} aria-describedby={helpId} className={`${fieldClass} mt-1 ${error ? 'border-red-400' : ''}`} value={value[field.key] ?? ''} onChange={e => onChange({ ...value, [field.key]: e.target.value })} /><span id={helpId} className={`mt-1 block text-xs ${error ? 'text-red-600' : 'text-slate-500'}`}>{error ? t(error) : t(field.help)}</span></div>; })}</div>
  </section>
  <section><h2 className="text-lg mb-3 font-medium" style={{ color: A.label }}>{t('settings.otherReviewSettings')}</h2><NotInEffect><div className="grid gap-5 lg:grid-cols-[1fr_320px]"><div className="grid gap-4 md:grid-cols-2">
    <label className="text-sm">{t('settings.amountThreshold')}<input type="number" className={`${fieldClass} mt-1`} value={value.amountThreshold} onChange={e => onChange({ ...value, amountThreshold: Number(e.target.value) })} /></label>
    <label className="text-sm">{t('settings.inventoryTolerance')}<input type="number" className={`${fieldClass} mt-1`} value={value.inventoryTolerancePercent} onChange={e => onChange({ ...value, inventoryTolerancePercent: Number(e.target.value) })} /></label>
    <div className="text-sm">{t('settings.riskLevels')}<div className={`${fieldClass} mt-1 bg-slate-50`}>{riskNames || t('settings.none')}</div></div>
    <div className="text-sm">{t('settings.reviewerRoles')}<div className={`${fieldClass} mt-1 bg-slate-50`} title={value.reviewerRoles.join(', ')}>{reviewerNames || t('settings.none')}</div></div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />{t('settings.enableReview')}</label>
    <div className="md:col-span-2"><div className="mb-2 text-sm font-medium">{t('settings.reviewPolicyList')}</div><div className="grid gap-2">{(value.policies || []).map(policy => <label key={policy.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm"><input type="checkbox" checked={policy.enabled} onChange={e => onChange({ ...value, policies: value.policies.map(row => row.id === policy.id ? { ...row, enabled: e.target.checked } : row) })} />{labelFor(t, 'settings.policy', policy.id, policy.name)}</label>)}</div></div>
  </div><div className="rounded-xl bg-slate-50 p-4"><div className="font-medium">{t('settings.policySimulation')}</div><label className="mt-3 block text-xs">{t('settings.simulatedAmount')}<input type="number" className={`${fieldClass} mt-1`} value={amount} onChange={e => setAmount(Number(e.target.value))} /></label><div className={`mt-3 rounded-lg p-3 text-sm ${requires ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>{requires ? t('settings.reviewRequired', { roles: reviewerNames }) : t('settings.standardFlow')}</div></div></div></NotInEffect></section></div>;
}

function Modules({ value, onChange }: { value: SettingsRuntime['modules']; onChange: (v: SettingsRuntime['modules']) => void }) {
  const { t, language } = useI18n();
  const sorted = [...value.items].sort((a, b) => a.order - b.order);
  const update = (id: string, patch: Partial<(typeof value.items)[number]>) => onChange({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) });
  const move = (index: number, delta: number) => { const next = [...sorted]; const target = index + delta; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onChange({ ...value, items: next.map((item, i) => ({ ...item, order: i + 1 })) }); };
  return <div className="grid gap-5 lg:grid-cols-[1fr_260px]"><div className="space-y-2">{sorted.map((item, index) => <div key={item.id} className="grid items-center gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[32px_1fr_160px_110px]">
    <div className="flex flex-col"><button className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100" aria-label={t('settings.moveUp')} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100" aria-label={t('settings.moveDown')} onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div><div className="min-w-0"><div className="font-medium" style={{ color: A.label }} data-testid={`settings-module-name-${item.id}`}>{labelFor(t, 'settings.module', item.id, item.label)}</div><div className="mt-1 text-xs" style={{ color: A.sub }} title={item.roles.join(', ')} aria-label={t('settings.visibleRoles', { module: labelFor(t, 'settings.module', item.id, item.label) })}>{t('settings.visibleTo', { roles: roleNames(item.roles, language) || t('settings.none') })}</div></div>
    <label className="text-sm"><input type="radio" name="default-module" checked={value.defaultModule === item.id} onChange={() => onChange({ ...value, defaultModule: item.id })} /> {t('settings.setDefault')}</label>
    <label className="text-sm"><input type="checkbox" checked={item.enabled} disabled={['overview', 'settings'].includes(item.id)} onChange={e => update(item.id, { enabled: e.target.checked })} /> {item.enabled ? t('settings.enabled') : t('settings.disabled')}</label>
  </div>)}</div><div className="rounded-xl bg-slate-900 p-4 text-white"><div className="text-xs text-slate-400">{t('settings.sidebarPreview')}</div><div className="mt-3 space-y-1">{sorted.filter(x => x.enabled).map(x => <div key={x.id} className={`rounded-lg px-3 py-2 text-sm ${x.id === value.defaultModule ? 'bg-blue-600' : 'bg-slate-800'}`}>{labelFor(t, 'settings.module', x.id, x.label)}</div>)}</div></div></div>;
}

// The AI features switch, in effect: off by default; on, the assistant may call
// the configured model until this month's spend reaches the cap.
function AiModelSwitch({ value, onChange }: { value: SettingsRuntime['ai']; onChange: (v: SettingsRuntime['ai']) => void }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<AiWorkspaceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { fetchAiWorkspaceStatus().then(setStatus).catch(() => setFailed(true)); }, []);
  const money = (amount: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount);
  return <section data-testid="settings-ai-model" className="mb-5 space-y-3 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-medium" style={{ color: A.label }}>{t('settings.aiModel')}</h2><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">{t('settings.inEffect')}</span></div>
    <p className="text-sm text-slate-600">{t('settings.aiModelHelp')}</p>
    <label className="flex items-center gap-2 text-sm font-medium"><input id="settings-ai-model-toggle" type="checkbox" checked={value.modelAssistEnabled === true} onChange={e => onChange({ ...value, modelAssistEnabled: e.target.checked })} />{t('settings.aiModelToggle')}</label>
    <p className="text-xs text-slate-500">{t('settings.aiModelData')}</p>
    <div role="status" data-testid="settings-ai-model-status" className="text-xs text-slate-600">
      {failed ? t('settings.aiModelStatusFailed')
        : !status ? null
          : !status.providerConfigured ? t('settings.aiModelNoProvider')
            : !status.optInRequired ? t('settings.aiModelNotRequired')
              : <>{t('settings.aiModelUsage', { cost: money(status.costUsd), cap: money(status.capUsd), calls: status.calls })}{status.status === 'over_cap' ? <span className="ml-2 text-amber-700">{t('settings.aiModelOverCap')}</span> : null}</>}
    </div>
  </section>;
}

function AiGovernance({ value, onChange }: { value: SettingsRuntime['ai']; onChange: (v: SettingsRuntime['ai']) => void }) {
  const { t } = useI18n();
  // Option values are the stored level codes; only the labels are translated.
  return <><div className="space-y-2">{value.capabilities.map(cap => <div key={cap.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4"><div className="font-medium" title={`${t('settings.capabilityId')}: ${cap.id}`}>{labelFor(t, 'settings.capability', cap.id, cap.label)}</div><select aria-label={labelFor(t, 'settings.capability', cap.id, cap.label)} className={`${fieldClass} max-w-[220px]`} value={cap.level} onChange={e => onChange({ ...value, capabilities: value.capabilities.map(x => x.id === cap.id ? { ...x, level: e.target.value } : x) })}>{AI_LEVELS.map(level => <option key={level} value={level}>{t(`settings.level.${level}` as TranslationKey)}</option>)}</select></div>)}</div><div className="mt-4 flex flex-wrap gap-6 rounded-xl bg-slate-50 p-4 text-sm"><label><input type="checkbox" checked={value.evidenceRequired} onChange={e => onChange({ ...value, evidenceRequired: e.target.checked })} /> {t('settings.evidenceRequired')}</label><label>{t('settings.retentionDays')} <input type="number" className="ml-2 w-24 rounded border px-2 py-1" value={value.retainDays} onChange={e => onChange({ ...value, retainDays: Number(e.target.value) })} /></label></div></>;
}

function Advanced({ value, onChange }: { value: SettingsRuntime['advanced']; onChange: (v: SettingsRuntime['advanced']) => void }) {
  const { t } = useI18n();
  return <div className="grid gap-4 md:grid-cols-2"><label className="text-sm">{t('settings.sessionTimeout')}<input type="number" className={`${fieldClass} mt-1`} value={value.sessionTimeoutMinutes} onChange={e => onChange({ ...value, sessionTimeoutMinutes: Number(e.target.value) })} /></label><label className="text-sm">{t('settings.exportLimit')}<input type="number" className={`${fieldClass} mt-1`} value={value.exportLimit} onChange={e => onChange({ ...value, exportLimit: Number(e.target.value) })} /></label><label className="text-sm">{t('settings.dateFormat')}<select className={`${fieldClass} mt-1`} value={value.dateFormat} onChange={e => onChange({ ...value, dateFormat: e.target.value })}><option>YYYY-MM-DD</option><option>DD/MM/YYYY</option><option>MM/DD/YYYY</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.negativeInventoryBlocked} onChange={e => onChange({ ...value, negativeInventoryBlocked: e.target.checked })} />{t('settings.blockNegative')}</label><label className="text-sm md:col-span-2">{t('settings.maintenanceNotice')}<textarea rows={3} className={`${fieldClass} mt-1`} value={value.maintenanceNotice} onChange={e => onChange({ ...value, maintenanceNotice: e.target.value })} /></label></div>;
}

function Audit() {
  const { t, language, formatDateTime } = useI18n();
  const english = language === 'en-US';
  const moduleName = (code: string) => AUDIT_MODULES[code]?.[english ? 0 : 1] || humanizeCode(code);
  // Entity types (snake_case or class names) as words; session, link and
  // assistant skill ids and uuids are not shown (src/i18n/auditSummaries.ts).
  const entityName = (code: string) => auditEntityLabel(code, language);
  // A record id stays as recorded; an internal one is left out.
  const entityId = (type: string, id: string) => auditEntityIdText(type, id);
  // An action code as words, never the code itself (see AUDIT_ACTIONS).
  const actionName = (code: string) => AUDIT_ACTIONS[code]?.[english ? 0 : 1] || (english ? humanizeCode(code) : undefined);
  // A link from a record (a sales order's Related records) opens its entries:
  // ?entityType=&entityId=, with entityLabel naming it (its document number).
  // The filter is shown and can be removed.
  const [params, setParams] = useSearchParams();
  const recordType = params.get('entityType') || '', recordId = params.get('entityId') || '';
  const recordFilter = recordType && recordId ? { entityType: recordType, entityId: recordId } : null;
  // The record's document number, when the link gave it, names its rows too.
  const recordLabel = params.get('entityLabel') || '';
  const recordName = [entityName(recordType), recordLabel || entityId(recordType, recordId)].filter(Boolean).join(' ');
  const clearRecord = () => { const next = new URLSearchParams(params); for (const key of ['entityType', 'entityId', 'entityLabel']) next.delete(key); setParams(next, { replace: true }); };
  const [entries, setEntries] = useState<SettingsAuditEntry[]>([]); const [query, setQuery] = useState(''); const [module, setModule] = useState(''); const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => { fetchSettingsAudit(recordFilter || {}).then(setEntries).catch(() => setEntries([])); }, [recordType, recordId]);
  const filtered = useMemo(() => entries.filter(e => (!module || e.module === module) && (!query || JSON.stringify(e).toLowerCase().includes(query.toLowerCase()))), [entries, query, module]);
  return <>{recordFilter && <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" data-testid="audit-record-filter"><span className="text-slate-500">{english ? 'Showing entries for' : '仅显示此记录的审计条目：'}</span><button type="button" onClick={clearRecord} aria-label={english ? `Remove filter: ${recordName}` : `移除筛选：${recordName}`} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 font-medium text-blue-700 hover:bg-blue-100">{recordName}<X size={12} aria-hidden /></button></div>}<div className="mb-4 flex flex-wrap gap-2"><label className="relative min-w-[260px] flex-1"><Search className="absolute left-3 top-2.5 text-slate-400" size={16} /><input aria-label={t('settings.searchAudit')} className={`${fieldClass} pl-9`} value={query} onChange={e => setQuery(e.target.value)} placeholder={t('settings.auditPlaceholder')} /></label><select aria-label={t('settings.moduleFilter')} className={`${fieldClass} w-44`} value={module} onChange={e => setModule(e.target.value)}><option value="">{t('settings.allModules')}</option>{[...new Set(entries.map(e => e.module))].map(x => <option key={x} value={x}>{moduleName(x)}</option>)}</select></div><div className="space-y-2">{filtered.map(entry => { const type = entry.entity?.type as BusinessEntityType | undefined; return <div key={entry.id} className="rounded-xl border border-slate-200 p-4"><button className="w-full text-left" onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}><div className="flex flex-wrap justify-between gap-2"><span className="font-medium" title={actionName(entry.action)}>{auditSummaryText(entry, language)}</span><time className="text-xs text-slate-500" dateTime={entry.timestamp}>{entry.timestamp && !Number.isNaN(new Date(entry.timestamp).getTime()) ? formatDateTime(entry.timestamp) : entry.timestamp}</time></div><div className="mt-1 text-xs text-slate-500">{entry.actor?.name || t('settings.systemActor')} · <span>{moduleName(entry.module)}</span>{entry.entity?.type ? <> · <span>{entityName(entry.entity.type)}</span> <span>{recordLabel && entry.entity.type === recordType && entry.entity.id === recordId ? recordLabel : entityId(entry.entity.type, entry.entity.id || '')}</span></> : null}</div></button>{expanded === entry.id && <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-2"><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{t('settings.before')}{`\n`}{JSON.stringify(entry.before, null, 2)}</pre><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{t('settings.after')}{`\n`}{JSON.stringify(entry.after, null, 2)}</pre>{entry.entity?.id && type && type in businessEntityRouteRegistry && <BusinessEntityLink entityType={type} entityId={entry.entity.id}>{t('settings.openEntity')}</BusinessEntityLink>}</div>}</div>; })}{!filtered.length && <div className="py-12 text-center text-sm text-slate-500">{t('settings.noAudit')}</div>}</div></>;
}

export default function SettingsPage({ initialView }: { initialView?: string; onNavigate: NavigateFn }) {
  const { t, locale, timezone } = useI18n();
  if (initialView === 'custom-fields') return <CustomFieldsSettings />;
  if (['profile', 'company', 'roles', 'warehouse-access', 'readiness'].includes(initialView || '')) return <WorkspaceSettings view={initialView || 'profile'} />;
  const view = ((initialView === 'boundaries' ? 'advanced' : initialView) || 'company') as View;
  const [data, setData] = useState<SettingsRuntime | null>(null); const [draft, setDraft] = useState<SettingsRuntime | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { setLoading(true); fetchSettingsRuntime().then(next => { setData(next); setDraft(next); setError(''); }).catch(err => setError(err instanceof Error ? err.message : t('settings.loadFailed'))).finally(() => setLoading(false)); }, []);
  if (view === 'audit') return <Card className="p-5"><Header view="audit" /><Audit /></Card>;
  if (loading) return <Card className="p-6"><div className="h-52 animate-pulse rounded-xl bg-slate-100" /></Card>;
  if (error || !data || !draft) return <Card className="p-6"><div className="text-sm text-red-600">{error || t('settings.loadFailed')}</div><RecoveryActions actions={[{ key: 'reload', label: t('settings.reload'), onClick: () => window.location.reload(), kind: 'list' }]} /></Card>;
  const section = view as keyof SettingsRuntime;
  const dirty = JSON.stringify(data[section]) !== JSON.stringify(draft[section]);
  const readOnly = NOT_IN_EFFECT_SECTIONS.includes(view);
  const numberingPrefixes = draft.numbering.rules.map(rule => rule.prefix.toUpperCase());
  const invalid = (view === 'review' && TOLERANCE_FIELDS.some(field => toleranceError(field.key, draft.review[field.key]) !== null))
    || (view === 'numbering' && (new Set(numberingPrefixes).size !== numberingPrefixes.length || numberingPrefixes.some(prefix => !DOCUMENT_NUMBER_PREFIX_PATTERN.test(prefix))));
  const change = <K extends keyof SettingsRuntime>(next: SettingsRuntime[K]) => { setDraft({ ...draft, [section]: next }); setNotice(''); };
  const save = async () => { setSaving(true); setNotice(''); try { const result = await saveSettingsSection(section, draft[section]); setData({ ...data, [section]: result.settings }); setDraft({ ...draft, [section]: result.settings }); setNotice(t('settings.savedAt', { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date()) })); if (section === 'modules') { localStorage.setItem('flowchain:module-settings', JSON.stringify(result.settings)); window.dispatchEvent(new Event('flowchain:module-settings')); } } catch { setNotice(t('settings.saveFailed')); } finally { setSaving(false); } };
  return <Card className="p-5" data-testid={`settings-${view}`}><Header view={view} dirty={dirty} saving={saving} invalid={invalid} onSave={readOnly ? undefined : save} onCancel={() => setDraft(data)} />{notice && <div role="status" className={`mb-4 rounded-lg p-3 text-sm ${notice.startsWith(t('settings.saved').slice(0, 3)) ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{notice}</div>}
    {view === 'numbering' && <Numbering value={draft.numbering} onChange={change} timezone={timezone} />}{view === 'review' && <Review value={draft.review} onChange={change} />}{view === 'modules' && <NotInEffect><Modules value={draft.modules} onChange={change} /></NotInEffect>}{view === 'ai' && <><AiModelSwitch value={draft.ai} onChange={change} /><NotInEffect><AiGovernance value={draft.ai} onChange={change} /></NotInEffect></>}{view === 'advanced' && <NotInEffect><Advanced value={draft.advanced} onChange={change} /></NotInEffect>}
    <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500"><ShieldCheck size={14} />{t('settings.auditHint')}</div></Card>;
}
