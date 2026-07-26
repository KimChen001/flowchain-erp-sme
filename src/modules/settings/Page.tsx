import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, Search, ShieldCheck } from 'lucide-react';
import { A, Card, RecoveryActions } from '../../components/ui';
import { BusinessEntityLink } from '../../components/business/BusinessEntityLink';
import { businessEntityRouteRegistry, type BusinessEntityType } from '../../components/business/businessEntityRoutes';
import { fetchSettingsAudit, fetchSettingsRuntime, saveSettingsSection, type SettingsAuditEntry, type SettingsRuntime } from './settingsRuntime';
import WorkspaceSettings from './WorkspaceSettings';
import { useI18n } from '../../i18n/I18n';
import CustomFieldsSettings from './CustomFieldsSettings';

type View = keyof SettingsRuntime | 'audit';
type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null) => void;

const sectionTitles: Record<View, [string, string]> = {
  company: ['公司与工作区', '维护当前业务空间的基础信息。'], roles: ['用户与角色', '管理访问成员、角色和启用状态。'],
  numbering: ['编号规则', '设置单据前缀、日期段和流水号。'], review: ['复核策略', '集中管理金额、风险和库存容差门槛。'],
  modules: ['菜单与模块', '配置启用模块、顺序、默认入口和角色可见性。'], ai: ['AI 治理', '按能力设置允许、复核或禁止等级。'],
  audit: ['操作日志', '检索真实设置与业务审计记录。'], advanced: ['高级设置', '维护安全、导出和显示类受控参数。'],
};

const fieldClass = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

function Header({ view, dirty, saving, onSave, onCancel }: { view: View; dirty?: boolean; saving?: boolean; onSave?: () => void; onCancel?: () => void }) {
  const { t, language } = useI18n();
  const key = ({ company: 'settings.company', roles: 'settings.roles', numbering: 'settings.numbering', review: 'settings.review', modules: 'settings.modules', ai: 'settings.ai', audit: 'settings.audit', advanced: 'settings.advanced' } as const)[view];
  const [, fallbackDescription] = sectionTitles[view];
  const title = t(key);
  const description = language === 'en-US' ? '' : fallbackDescription;
  return <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div><h2 className="fc-section-title" style={{ color: A.label }}>{title}</h2><p className="mt-1 text-sm" style={{ color: A.sub }}>{description}</p></div>
    {onSave && <div className="flex gap-2">{dirty && <button onClick={onCancel} disabled={saving} className={`${buttonClass} border border-slate-200 bg-white`}>{t('settings.cancel')}</button>}<button data-testid="settings-save" disabled={!dirty || saving} onClick={onSave} className={`${buttonClass} text-white`} style={{ background: A.blue }}><Save size={15} />{saving ? t('settings.saving') : dirty ? t('settings.save') : t('settings.saved')}</button></div>}
  </div>;
}

function Company({ value, onChange }: { value: SettingsRuntime['company']; onChange: (v: SettingsRuntime['company']) => void }) {
  return <div className="grid gap-4 md:grid-cols-2">{[
    ['companyName', '公司名称'], ['workspaceName', '工作区名称'], ['timezone', '时区'], ['currency', '本位币'], ['locale', '区域格式'],
  ].map(([key, label]) => <label key={key} className="text-sm"><span className="mb-1 block font-medium" style={{ color: A.label }}>{label}</span><input className={fieldClass} value={String(value[key as keyof typeof value])} onChange={(e) => onChange({ ...value, [key]: e.target.value })} /></label>)}</div>;
}

function Roles({ value, onChange }: { value: SettingsRuntime['roles']; onChange: (v: SettingsRuntime['roles']) => void }) {
  const users = value.users;
  const update = (id: string, patch: Partial<(typeof users)[number]>) => onChange({ ...value, users: users.map((user) => user.id === id ? { ...user, ...patch } : user) });
  const add = () => onChange({ ...value, users: [...users, { id: `USR-${Date.now()}`, name: '新成员', email: '', role: '只读访客', enabled: true }] });
  return <><div className="mb-3 flex justify-end"><button onClick={add} className={`${buttonClass} border border-slate-200 bg-white`}><Plus size={15} />添加用户</button></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{['姓名', '邮箱', '角色', '状态'].map(x => <th key={x} className="px-3 py-2 font-medium">{x}</th>)}</tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-t border-slate-100">
      <td className="p-2"><input aria-label={`${user.name}姓名`} className={fieldClass} value={user.name} onChange={e => update(user.id, { name: e.target.value })} /></td>
      <td className="p-2"><input aria-label={`${user.name}邮箱`} className={fieldClass} value={user.email} onChange={e => update(user.id, { email: e.target.value })} /></td>
      <td className="p-2"><select aria-label={`${user.name}角色`} className={fieldClass} value={user.role} onChange={e => update(user.id, { role: e.target.value })}>{value.roleOptions.map(role => <option key={role}>{role}</option>)}</select></td>
      <td className="p-2"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={user.enabled} onChange={e => update(user.id, { enabled: e.target.checked })} />{user.enabled ? '已启用' : '已停用'}</label></td>
    </tr>)}</tbody></table></div><p className="mt-3 text-xs text-slate-500">系统会阻止停用或降级最后一名管理员；这里不发送邀请邮件。</p></>;
}

function previewNumber(rule: SettingsRuntime['numbering']['rules'][number]) {
  const date = rule.datePattern === 'YYYYMMDD' ? '20260711' : rule.datePattern === 'YYYYMM' ? '202607' : '';
  return [rule.prefix.toUpperCase(), date, String(rule.nextSequence).padStart(rule.sequenceLength, '0')].filter(Boolean).join(rule.separator);
}

function Numbering({ value, onChange }: { value: SettingsRuntime['numbering']; onChange: (v: SettingsRuntime['numbering']) => void }) {
  const { t } = useI18n();
  const update = (id: string, patch: Partial<(typeof value.rules)[number]>) => onChange({ rules: value.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) });
  const signatures = value.rules.map(r => `${r.prefix.toUpperCase()}|${r.datePattern}|${r.separator}`);
  return <div className="space-y-3">{value.rules.map((rule, index) => { const conflict = signatures.indexOf(signatures[index]) !== index; return <div key={rule.id} className="grid gap-3 rounded-xl border border-slate-200 p-4 md:grid-cols-7">
    <label className="text-xs md:col-span-2">{t('settings.document')}<input className={`${fieldClass} mt-1`} value={rule.document} onChange={e => update(rule.id, { document: e.target.value })} /></label>
    <label className="text-xs">{t('settings.prefix')}<input className={`${fieldClass} mt-1`} value={rule.prefix} onChange={e => update(rule.id, { prefix: e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 8) })} /></label>
    <label className="text-xs">{t('settings.datePattern')}<select className={`${fieldClass} mt-1`} value={rule.datePattern} onChange={e => update(rule.id, { datePattern: e.target.value })}><option>YYYYMM</option><option>YYYYMMDD</option><option value="">{t('settings.noDate')}</option></select></label>
    <label className="text-xs">{t('settings.separator')}<input className={`${fieldClass} mt-1`} value={rule.separator} maxLength={1} onChange={e => update(rule.id, { separator: e.target.value })} /></label>
    <label className="text-xs">{t('settings.sequenceLength')}<input type="number" min={2} max={8} className={`${fieldClass} mt-1`} value={rule.sequenceLength} onChange={e => update(rule.id, { sequenceLength: Number(e.target.value) })} /></label>
    <div className="text-xs"><span>{t('settings.preview')}</span><div className="mt-1 rounded-lg bg-slate-50 px-3 py-2 font-mono">{previewNumber(rule)}</div>{conflict && <span className="mt-1 block text-red-600">{t('settings.conflict')}</span>}</div>
  </div>; })}</div>;
}

function Review({ value, onChange }: { value: SettingsRuntime['review']; onChange: (v: SettingsRuntime['review']) => void }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState(120000); const requires = value.enabled && amount >= value.amountThreshold;
  return <div className="grid gap-5 lg:grid-cols-[1fr_320px]"><div className="grid gap-4 md:grid-cols-2">
    <label className="text-sm">{t('settings.amountThreshold')}<input type="number" className={`${fieldClass} mt-1`} value={value.amountThreshold} onChange={e => onChange({ ...value, amountThreshold: Number(e.target.value) })} /></label>
    <label className="text-sm">{t('settings.inventoryTolerance')}<input type="number" className={`${fieldClass} mt-1`} value={value.inventoryTolerancePercent} onChange={e => onChange({ ...value, inventoryTolerancePercent: Number(e.target.value) })} /></label>
    <label className="text-sm">{t('settings.riskLevels')}<input className={`${fieldClass} mt-1`} value={value.riskLevels.join(', ')} onChange={e => onChange({ ...value, riskLevels: e.target.value.split(/[、,]/).filter(Boolean) })} /></label>
    <label className="text-sm">{t('settings.reviewerRoles')}<input className={`${fieldClass} mt-1`} value={value.reviewerRoles.join(', ')} onChange={e => onChange({ ...value, reviewerRoles: e.target.value.split(/[、,]/).filter(Boolean) })} /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />{t('settings.enableReview')}</label>
    <div className="md:col-span-2"><div className="mb-2 text-sm font-medium">{t('settings.reviewPolicyList')}</div><div className="grid gap-2">{(value.policies || []).map(policy => <label key={policy.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm"><input type="checkbox" checked={policy.enabled} onChange={e => onChange({ ...value, policies: value.policies.map(row => row.id === policy.id ? { ...row, enabled: e.target.checked } : row) })} />{policy.name}</label>)}</div></div>
  </div><div className="rounded-xl bg-slate-50 p-4"><div className="font-medium">{t('settings.policySimulation')}</div><label className="mt-3 block text-xs">{t('settings.simulatedAmount')}<input type="number" className={`${fieldClass} mt-1`} value={amount} onChange={e => setAmount(Number(e.target.value))} /></label><div className={`mt-3 rounded-lg p-3 text-sm ${requires ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>{requires ? t('settings.reviewRequired', { roles: value.reviewerRoles.join(' / ') }) : t('settings.standardFlow')}</div></div></div>;
}

function Modules({ value, onChange }: { value: SettingsRuntime['modules']; onChange: (v: SettingsRuntime['modules']) => void }) {
  const sorted = [...value.items].sort((a, b) => a.order - b.order);
  const update = (id: string, patch: Partial<(typeof value.items)[number]>) => onChange({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) });
  const move = (index: number, delta: number) => { const next = [...sorted]; const target = index + delta; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onChange({ ...value, items: next.map((item, i) => ({ ...item, order: i + 1 })) }); };
  return <div className="grid gap-5 lg:grid-cols-[1fr_260px]"><div className="space-y-2">{sorted.map((item, index) => <div key={item.id} className="grid items-center gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[32px_1fr_160px_110px]">
    <div className="flex flex-col"><button aria-label="上移" onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button aria-label="下移" onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div><div><div className="font-medium">{item.label}</div><input aria-label={`${item.label}可见角色`} className={`${fieldClass} mt-1`} value={item.roles.join('、')} onChange={e => update(item.id, { roles: e.target.value.split(/[、,]/).filter(Boolean) })} /></div>
    <label className="text-sm"><input type="radio" name="default-module" checked={value.defaultModule === item.id} onChange={() => onChange({ ...value, defaultModule: item.id })} /> 设为默认</label>
    <label className="text-sm"><input type="checkbox" checked={item.enabled} disabled={['overview', 'settings'].includes(item.id)} onChange={e => update(item.id, { enabled: e.target.checked })} /> {item.enabled ? '已启用' : '已停用'}</label>
  </div>)}</div><div className="rounded-xl bg-slate-900 p-4 text-white"><div className="text-xs text-slate-400">侧边栏预览</div><div className="mt-3 space-y-1">{sorted.filter(x => x.enabled).map(x => <div key={x.id} className={`rounded-lg px-3 py-2 text-sm ${x.id === value.defaultModule ? 'bg-blue-600' : 'bg-slate-800'}`}>{x.label}</div>)}</div></div></div>;
}

function AiGovernance({ value, onChange }: { value: SettingsRuntime['ai']; onChange: (v: SettingsRuntime['ai']) => void }) {
  const levels = ['允许', '复核后允许', '仅生成待确认动作', '禁止'];
  return <><div className="space-y-2">{value.capabilities.map(cap => <div key={cap.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4"><div><div className="font-medium">{cap.label}</div><div className="text-xs text-slate-500">能力 ID：{cap.id}</div></div><select className={`${fieldClass} max-w-[220px]`} value={cap.level} onChange={e => onChange({ ...value, capabilities: value.capabilities.map(x => x.id === cap.id ? { ...x, level: e.target.value } : x) })}>{levels.map(level => <option key={level}>{level}</option>)}</select></div>)}</div><div className="mt-4 flex flex-wrap gap-6 rounded-xl bg-slate-50 p-4 text-sm"><label><input type="checkbox" checked={value.evidenceRequired} onChange={e => onChange({ ...value, evidenceRequired: e.target.checked })} /> 回答必须附业务证据</label><label>记录保留天数 <input type="number" className="ml-2 w-24 rounded border px-2 py-1" value={value.retainDays} onChange={e => onChange({ ...value, retainDays: Number(e.target.value) })} /></label></div></>;
}

function Advanced({ value, onChange }: { value: SettingsRuntime['advanced']; onChange: (v: SettingsRuntime['advanced']) => void }) {
  return <div className="grid gap-4 md:grid-cols-2"><label className="text-sm">会话超时（分钟）<input type="number" className={`${fieldClass} mt-1`} value={value.sessionTimeoutMinutes} onChange={e => onChange({ ...value, sessionTimeoutMinutes: Number(e.target.value) })} /></label><label className="text-sm">单次导出上限<input type="number" className={`${fieldClass} mt-1`} value={value.exportLimit} onChange={e => onChange({ ...value, exportLimit: Number(e.target.value) })} /></label><label className="text-sm">日期格式<select className={`${fieldClass} mt-1`} value={value.dateFormat} onChange={e => onChange({ ...value, dateFormat: e.target.value })}><option>YYYY-MM-DD</option><option>DD/MM/YYYY</option><option>MM/DD/YYYY</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.negativeInventoryBlocked} onChange={e => onChange({ ...value, negativeInventoryBlocked: e.target.checked })} />阻止负库存过账</label><label className="text-sm md:col-span-2">维护公告<textarea rows={3} className={`${fieldClass} mt-1`} value={value.maintenanceNotice} onChange={e => onChange({ ...value, maintenanceNotice: e.target.value })} /></label></div>;
}

function Audit() {
  const [entries, setEntries] = useState<SettingsAuditEntry[]>([]); const [query, setQuery] = useState(''); const [module, setModule] = useState(''); const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => { fetchSettingsAudit().then(setEntries).catch(() => setEntries([])); }, []);
  const filtered = useMemo(() => entries.filter(e => (!module || e.module === module) && (!query || JSON.stringify(e).toLowerCase().includes(query.toLowerCase()))), [entries, query, module]);
  return <><div className="mb-4 flex flex-wrap gap-2"><label className="relative min-w-[260px] flex-1"><Search className="absolute left-3 top-2.5 text-slate-400" size={16} /><input aria-label="搜索操作日志" className={`${fieldClass} pl-9`} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索操作者、摘要或实体" /></label><select aria-label="模块筛选" className={`${fieldClass} w-44`} value={module} onChange={e => setModule(e.target.value)}><option value="">全部模块</option>{[...new Set(entries.map(e => e.module))].map(x => <option key={x}>{x}</option>)}</select></div><div className="space-y-2">{filtered.map(entry => { const type = entry.entity?.type as BusinessEntityType | undefined; return <div key={entry.id} className="rounded-xl border border-slate-200 p-4"><button className="w-full text-left" onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{entry.summary || entry.action}</span><time className="text-xs text-slate-500">{new Date(entry.timestamp).toLocaleString('zh-CN')}</time></div><div className="mt-1 text-xs text-slate-500">{entry.actor?.name || '系统'} · {entry.module} · {entry.entity?.type || 'system'} {entry.entity?.id || ''}</div></button>{expanded === entry.id && <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-2"><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">变更前{`\n`}{JSON.stringify(entry.before, null, 2)}</pre><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">变更后{`\n`}{JSON.stringify(entry.after, null, 2)}</pre>{entry.entity?.id && type && type in businessEntityRouteRegistry && <BusinessEntityLink entityType={type} entityId={entry.entity.id}>打开关联实体</BusinessEntityLink>}</div>}</div>; })}{!filtered.length && <div className="py-12 text-center text-sm text-slate-500">没有符合条件的日志</div>}</div></>;
}

export default function SettingsPage({ initialView }: { initialView?: string; onNavigate: NavigateFn }) {
  const { t, locale } = useI18n();
  if (initialView === 'custom-fields') return <CustomFieldsSettings />;
  if (['profile', 'company', 'roles', 'warehouse-access', 'readiness'].includes(initialView || '')) return <WorkspaceSettings view={initialView || 'profile'} />;
  const view = ((initialView === 'boundaries' ? 'advanced' : initialView) || 'company') as View;
  const [data, setData] = useState<SettingsRuntime | null>(null); const [draft, setDraft] = useState<SettingsRuntime | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { setLoading(true); fetchSettingsRuntime().then(next => { setData(next); setDraft(next); setError(''); }).catch(err => setError(err instanceof Error ? err.message : '设置加载失败')).finally(() => setLoading(false)); }, []);
  if (view === 'audit') return <Card className="p-5"><Header view="audit" /><Audit /></Card>;
  if (loading) return <Card className="p-6"><div className="h-52 animate-pulse rounded-xl bg-slate-100" /></Card>;
  if (error || !data || !draft) return <Card className="p-6"><div className="text-sm text-red-600">{error || '设置加载失败'}</div><RecoveryActions actions={[{ key: 'reload', label: '重新加载', onClick: () => window.location.reload(), kind: 'list' }]} /></Card>;
  const section = view as keyof SettingsRuntime;
  const dirty = JSON.stringify(data[section]) !== JSON.stringify(draft[section]);
  const change = <K extends keyof SettingsRuntime>(next: SettingsRuntime[K]) => { setDraft({ ...draft, [section]: next }); setNotice(''); };
  const save = async () => { setSaving(true); setNotice(''); try { const result = await saveSettingsSection(section, draft[section]); setData({ ...data, [section]: result.settings }); setDraft({ ...draft, [section]: result.settings }); setNotice(t('settings.savedAt', { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date()) })); if (section === 'modules') { localStorage.setItem('flowchain:module-settings', JSON.stringify(result.settings)); window.dispatchEvent(new Event('flowchain:module-settings')); } } catch { setNotice(t('settings.saveFailed')); } finally { setSaving(false); } };
  return <Card className="p-5" data-testid={`settings-${view}`}><Header view={view} dirty={dirty} saving={saving} onSave={save} onCancel={() => setDraft(data)} />{notice && <div role="status" className={`mb-4 rounded-lg p-3 text-sm ${notice.startsWith(t('settings.saved').slice(0, 3)) ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{notice}</div>}
    {view === 'company' && <Company value={draft.company} onChange={change} />}{view === 'roles' && <Roles value={draft.roles} onChange={change} />}{view === 'numbering' && <Numbering value={draft.numbering} onChange={change} />}{view === 'review' && <Review value={draft.review} onChange={change} />}{view === 'modules' && <Modules value={draft.modules} onChange={change} />}{view === 'ai' && <AiGovernance value={draft.ai} onChange={change} />}{view === 'advanced' && <Advanced value={draft.advanced} onChange={change} />}
    <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500"><ShieldCheck size={14} />{t('settings.auditHint')}</div></Card>;
}
