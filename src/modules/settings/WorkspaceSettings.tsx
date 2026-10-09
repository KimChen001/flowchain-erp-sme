import { useEffect, useMemo, useRef, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import AuthorizationWorkbench from "./AuthorizationWorkbench";
import DocumentTemplateSettings from "./DocumentTemplateSettings";
import WarehouseMaster from "./WarehouseMaster";
import WorkspaceMembers from "./WorkspaceMembers";

type Profile = {
  id: string;
  email: string;
  name: string;
  role: string;
  roleLabel: string;
  jobTitle?: string;
  status: string;
  languagePreference?: "zh-CN" | "en-US" | null;
  defaultWarehouseId?: string;
  profileCompletedAt?: string;
  version: number;
  warehouseScopes?: Array<{ warehouseId: string; accessLevel: string }>;
};
type Workspace = {
  id: string;
  name: string;
  workspaceName: string;
  legalName?: string;
  companyName: string;
  countryCode: string;
  baseCurrency: string;
  timezone: string;
  locale: "zh-CN" | "en-US";
  defaultLanguage: "zh-CN" | "en-US";
  baseCurrencyLocked: boolean;
  workspaceCompletedAt?: string;
  version: number;
  options: { languages: string[]; locales: string[]; timezones: string[]; currencies: string[] };
};
type Warehouse = { id: string; code: string; name: string; status: string };
type User = Profile & { warehouseScopes: Array<{ warehouseId: string; accessLevel: string }> };
type AssignedRole = { id: string; roleKey: string; name: string };
type AuthorizationContext = { effectivePermissions?: string[]; roles?: AssignedRole[] };
type Diagnostics = { overall: string; generatedAt: string; openingBalanceLocked: boolean; checks: Array<{ id: string; status: "pass" | "warn" | "fail"; detail: string }> };
type SaveState = "saved" | "dirty" | "saving" | "success" | "failure";

const field = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";
const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50";
const timezoneLabels: Record<string, { zh: string; en: string }> = {
  "Asia/Shanghai": { zh: "中国标准时间", en: "China Standard Time" },
  "America/New_York": { zh: "美国东部时间", en: "US Eastern Time" },
  "America/Chicago": { zh: "美国中部时间", en: "US Central Time" },
  "America/Los_Angeles": { zh: "美国太平洋时间", en: "US Pacific Time" },
  "Europe/London": { zh: "英国时间", en: "United Kingdom Time" },
};
// Default role templates are stored under their English names. An unchanged
// template is shown in the interface language; a renamed or custom role keeps
// the name the workspace gave it.
const TEMPLATE_ROLE_NAMES: Record<string, [string, string]> = {
  "workspace-administrator": ["Workspace Administrator", "工作区管理员"],
  "operations-manager": ["Operations Manager", "运营经理"],
  "operations-specialist": ["Operations Specialist", "运营专员"],
  "procurement-specialist": ["Procurement Specialist", "采购专员"],
  "finance-specialist": ["Finance Specialist", "财务专员"],
  "read-only-viewer": ["Read-only Viewer", "只读查看者"],
  "intake-uploader": ["Intake Uploader", "导入上传员"],
  "intake-reviewer": ["Intake Reviewer", "导入复核员"],
};
const currencyLabels: Record<string, { zh: string; en: string }> = {
  CNY: { zh: "人民币", en: "Chinese Yuan" }, USD: { zh: "美元", en: "US Dollar" },
  EUR: { zh: "欧元", en: "Euro" }, GBP: { zh: "英镑", en: "Pound Sterling" },
  JPY: { zh: "日元", en: "Japanese Yen" }, AUD: { zh: "澳大利亚元", en: "Australian Dollar" },
  CAD: { zh: "加拿大元", en: "Canadian Dollar" },
};

function SearchableSelect({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => options.filter(option => `${option.value} ${option.label}`.toLowerCase().includes(query.toLowerCase())), [options, query]);
  return <label className="text-sm">
    <span className="mb-1 block font-medium" style={{ color: A.label }}>{label}</span>
    <input aria-label={`${label} ${t("top.search")}`} type="search" className={`${field} mb-1`} value={query} onChange={event => setQuery(event.target.value)} disabled={disabled} placeholder="⌕" />
    <select aria-label={label} className={field} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
      {filtered.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function SaveActions({ state, onCancel, onSave }: { state: SaveState; onCancel: () => void; onSave: () => void }) {
  const { t, locale } = useI18n();
  const savedAt = state === "success" ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date()) : "";
  return <div className="flex flex-wrap items-center justify-end gap-2">
    {state === "dirty" && <button type="button" className={`${button} border border-slate-200 bg-white`} onClick={onCancel}>{t("settings.cancel")}</button>}
    <button type="button" data-testid="settings-save" className={`${button} text-white`} style={{ background: A.blue }} disabled={!["dirty", "saving"].includes(state) || state === "saving"} onClick={onSave}>
      <Save size={15} />{state === "saving" ? t("settings.saving") : state === "dirty" ? t("settings.save") : state === "success" ? t("settings.savedAt", { time: savedAt }) : state === "failure" ? t("settings.saveFailed") : t("settings.saved")}
    </button>
  </div>;
}

export default function WorkspaceSettings({ view }: { view: string }) {
  const { t, language, formatDateTime } = useI18n();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savedProfile, setSavedProfile] = useState<Profile | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [savedWorkspace, setSavedWorkspace] = useState<Workspace | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  // Members as last read from the server, to tell unsaved access edits apart.
  const loadedUsers = useRef<User[]>([]);
  const [notice, setNotice] = useState("");
  const [profileState, setProfileState] = useState<SaveState>("saved");
  const [workspaceState, setWorkspaceState] = useState<SaveState>("saved");
  const [scopeUserId, setScopeUserId] = useState("");
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  // What the signed-in user may do here comes from their effective
  // permissions, the same codes the server checks. The legacy profile role
  // grants nothing: a teammate made Workspace Administrator in Roles gets these
  // controls, and an admin reduced to a read-only role loses them.
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [assignedRoles, setAssignedRoles] = useState<AssignedRole[]>([]);
  const canEditWorkspace = permissions.has("settings.workspace.manage");
  const canReadUsers = permissions.has("settings.users.read");
  const canManageUsers = permissions.has("settings.users.manage");
  const canReadDiagnostics = permissions.has("settings.diagnostics.read");
  const roleName = (role: AssignedRole) => {
    const template = TEMPLATE_ROLE_NAMES[role.roleKey];
    return template && role.name === template[0] ? template[language === "en-US" ? 0 : 1] : role.name;
  };
  const accessName = (access: string) => access === "operate" ? t("settings.operate") : access === "read" ? t("settings.read") : t("settings.noAccess");

  async function load() {
    setNotice("");
    try {
      const [p, w, wh, context] = await Promise.all([
        apiJson<Profile>("/api/me/profile"),
        apiJson<Workspace>("/api/workspace"),
        apiJson<{ warehouses: Warehouse[] }>("/api/workspace/warehouses"),
        apiJson<AuthorizationContext>("/api/authorization/context"),
      ]);
      const granted = new Set(context.effectivePermissions || []);
      setPermissions(granted); setAssignedRoles(context.roles || []);
      setProfile(p); setSavedProfile(p); setProfileState("saved");
      setWorkspace(w); setSavedWorkspace(w); setWorkspaceState("saved");
      setWarehouses(wh.warehouses);
      if (granted.has("settings.users.read")) {
        const u = await apiJson<{ users: User[] }>("/api/workspace/users");
        loadedUsers.current = u.users;
        setUsers(u.users);
        // Whoever grants access opens on a teammate to edit; someone who may
        // only read it opens on their own access.
        const firstUserId = granted.has("settings.users.manage") ? u.users.find(user => user.id !== p.id)?.id : p.id;
        setScopeUserId(current => current || firstUserId || u.users[0]?.id || "");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("settings.loadFailed"));
    }
  }
  useEffect(() => { void load(); }, []);
  // After a warehouse is added, renamed or set inactive: the warehouse list,
  // the signed-in user's own access and default, and members' access, without
  // dropping access edits not yet saved. A member's unsaved edits are kept,
  // with any access granted on the server since (the creator's access to a
  // warehouse they just added) added to them.
  async function refreshWarehouses() {
    try {
      const [p, wh] = await Promise.all([
        apiJson<Profile>("/api/me/profile"),
        apiJson<{ warehouses: Warehouse[] }>("/api/workspace/warehouses"),
      ]);
      setWarehouses(wh.warehouses);
      const access = { warehouseScopes: p.warehouseScopes, defaultWarehouseId: p.defaultWarehouseId, version: p.version };
      setProfile(current => current && { ...current, ...access });
      setSavedProfile(current => current && { ...current, ...access });
      if (!permissions.has("settings.users.read")) return;
      const u = await apiJson<{ users: User[] }>("/api/workspace/users");
      const before = new Map(loadedUsers.current.map(user => [user.id, user]));
      loadedUsers.current = u.users;
      setUsers(current => u.users.map(fresh => {
        const local = current.find(user => user.id === fresh.id);
        const was = before.get(fresh.id);
        if (!local || !was || JSON.stringify(local.warehouseScopes) === JSON.stringify(was.warehouseScopes)) return fresh;
        const granted = fresh.warehouseScopes.filter(scope => !was.warehouseScopes.some(old => old.warehouseId === scope.warehouseId) && !local.warehouseScopes.some(own => own.warehouseId === scope.warehouseId));
        return { ...fresh, warehouseScopes: [...local.warehouseScopes, ...granted] };
      }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("settings.loadFailed"));
    }
  }
  useEffect(() => {
    if (view === "readiness" && canReadDiagnostics) {
      apiJson<Diagnostics>("/api/admin/pilot-diagnostics").then(setDiagnostics).catch(error => setNotice(error instanceof Error ? error.message : t("settings.loadFailed")));
    }
  }, [view, canReadDiagnostics]);
  useEffect(() => {
    if (profile && savedProfile) setProfileState(JSON.stringify(profile) === JSON.stringify(savedProfile) ? "saved" : "dirty");
  }, [profile, savedProfile]);
  useEffect(() => {
    if (workspace && savedWorkspace) setWorkspaceState(JSON.stringify(workspace) === JSON.stringify(savedWorkspace) ? "saved" : "dirty");
  }, [workspace, savedWorkspace]);

  async function saveProfile() {
    if (!profile) return;
    setProfileState("saving");
    try {
      const next = await apiJson<Profile>("/api/me/profile", { method: "PATCH", body: JSON.stringify(profile) });
      setProfile(next); setSavedProfile(next); setProfileState("success");
      window.dispatchEvent(new Event("flowchain:localization-changed"));
    } catch {
      setProfileState("failure");
    }
  }
  async function saveWorkspace() {
    if (!workspace) return;
    setWorkspaceState("saving");
    try {
      const next = await apiJson<Workspace>("/api/workspace", { method: "PATCH", body: JSON.stringify(workspace) });
      setWorkspace(next); setSavedWorkspace(next); setWorkspaceState("success");
      window.dispatchEvent(new Event("flowchain:localization-changed"));
    } catch (error) {
      setWorkspaceState("failure");
      setNotice(error instanceof Error ? error.message : t("settings.saveFailed"));
    }
  }
  async function saveScopes() {
    const target = users.find(user => user.id === scopeUserId);
    if (!target) return;
    try {
      await apiJson(`/api/workspace/users/${encodeURIComponent(target.id)}/warehouse-scopes`, { method: "PUT", body: JSON.stringify({ scopes: target.warehouseScopes }) });
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : t("settings.saveFailed")); }
  }

  if (!profile || !workspace) return <Card className="p-6"><div className="h-40 animate-pulse rounded-xl bg-slate-100" /><span className="sr-only">{t("settings.loading")}</span>{notice}</Card>;
  const title = ({
    profile: t("settings.profile"),
    company: t("settings.company"),
    roles: t("settings.roles"),
    "warehouse-access": t("settings.warehouse"),
    readiness: t("settings.readiness"),
  } as Record<string, string>)[view] || t("nav.settings");
  const languageOptions = [
    { value: "en-US", label: `${t("settings.english")} — en-US` },
    { value: "zh-CN", label: `${t("settings.chinese")} — zh-CN` },
  ];
  const timezoneOptions = workspace.options.timezones.map(value => ({ value, label: `${value} — ${timezoneLabels[value]?.[language === "en-US" ? "en" : "zh"] || value}` }));
  const currencyOptions = workspace.options.currencies.map(value => ({ value, label: `${value} — ${currencyLabels[value]?.[language === "en-US" ? "en" : "zh"] || value}` }));
  const localeOptions = [
    { value: "zh-CN", label: "简体中文（中国）— zh-CN" },
    { value: "en-US", label: "English (United States) — en-US" },
  ];
  // Someone who reads or grants warehouse access is sent every warehouse, but
  // their own default warehouse must still be one they can read.
  const ownWarehouseIds = new Set((profile.warehouseScopes || []).map(scope => scope.warehouseId));
  // A warehouse is maintained by an administrator with operate access to it.
  const ownOperateIds = new Set((profile.warehouseScopes || []).filter(scope => scope.accessLevel === "operate").map(scope => scope.warehouseId));
  const scopeTarget = canReadUsers ? users.find(user => user.id === scopeUserId) : undefined;

  // Members, then roles, permissions and assignments. Both read the actor's
  // effective permissions, not the legacy profile role.
  if (view === "roles") return <div className="space-y-5"><WorkspaceMembers /><AuthorizationWorkbench /></div>;

  const settingsCard = <Card className="p-5" data-testid={`workspace-settings-${view}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-slate-500">{workspace.workspaceName}</p></div>
      {view === "profile" && <SaveActions state={profileState} onCancel={() => setProfile(savedProfile)} onSave={saveProfile} />}
      {view === "company" && canEditWorkspace && <SaveActions state={workspaceState} onCancel={() => setWorkspace(savedWorkspace)} onSave={saveWorkspace} />}
    </div>
    {notice && <div role="status" className="my-3 rounded-lg bg-slate-50 p-3 text-sm">{notice}</div>}

    {view === "profile" && <div className="mt-5 grid gap-4 md:grid-cols-2">
      <label>{t("settings.profileName")}<input className={field} value={profile.name} onChange={event => setProfile({ ...profile, name: event.target.value })} /></label>
      <label>{t("settings.jobTitle")}<input className={field} value={profile.jobTitle || ""} onChange={event => setProfile({ ...profile, jobTitle: event.target.value })} /></label>
      <label>{t("settings.email")}<input className={`${field} bg-slate-50`} value={profile.email} readOnly /></label>
      <label>{t("settings.role")}<input data-testid="profile-roles" className={`${field} bg-slate-50`} value={assignedRoles.map(roleName).join(", ") || t("settings.none")} readOnly /></label>
      <label>{t("settings.interfaceLanguage")}<select aria-label={t("settings.interfaceLanguage")} className={field} value={profile.languagePreference || ""} onChange={event => setProfile({ ...profile, languagePreference: (event.target.value || null) as Profile["languagePreference"] })}><option value="">{t("settings.followWorkspace")}</option>{languageOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>{t("settings.defaultWarehouse")}<select aria-label={t("settings.defaultWarehouse")} className={field} value={profile.defaultWarehouseId || ""} onChange={event => setProfile({ ...profile, defaultWarehouseId: event.target.value })}><option value="">{t("settings.none")}</option>{warehouses.filter(item => item.status === "active" && ownWarehouseIds.has(item.id)).map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
    </div>}

    {view === "company" && <div className="mt-5 grid gap-4 md:grid-cols-2">
      <label>{t("settings.companyName")}<input className={field} value={workspace.companyName} disabled={!canEditWorkspace} onChange={event => setWorkspace({ ...workspace, companyName: event.target.value, legalName: event.target.value })} /></label>
      <label>{t("settings.workspaceName")}<input className={field} value={workspace.workspaceName} disabled={!canEditWorkspace} onChange={event => setWorkspace({ ...workspace, workspaceName: event.target.value, name: event.target.value })} /></label>
      <SearchableSelect label={t("settings.timezone")} value={workspace.timezone} options={timezoneOptions} disabled={!canEditWorkspace} onChange={value => setWorkspace({ ...workspace, timezone: value })} />
      <SearchableSelect label={t("settings.currency")} value={workspace.baseCurrency} options={currencyOptions} disabled={!canEditWorkspace || workspace.baseCurrencyLocked} onChange={value => setWorkspace({ ...workspace, baseCurrency: value })} />
      <SearchableSelect label={t("settings.locale")} value={workspace.locale} options={localeOptions} disabled={!canEditWorkspace} onChange={value => setWorkspace({ ...workspace, locale: value as Workspace["locale"] })} />
      <SearchableSelect label={t("settings.defaultLanguage")} value={workspace.defaultLanguage} options={languageOptions} disabled={!canEditWorkspace} onChange={value => setWorkspace({ ...workspace, defaultLanguage: value as Workspace["defaultLanguage"] })} />
      {workspace.baseCurrencyLocked && <p className="text-sm text-amber-700 md:col-span-2">{t("settings.currencyLocked")}</p>}
      {!canEditWorkspace && <p data-testid="workspace-read-only" className="text-sm text-amber-700 md:col-span-2">{t("settings.workspaceOnly")}</p>}
      <div data-testid="locale-format-preview" className="rounded-lg bg-slate-50 p-3 text-sm md:col-span-2">
        {new Intl.DateTimeFormat(workspace.locale, { dateStyle: "medium", timeStyle: "short", timeZone: workspace.timezone }).format(new Date("2026-07-17T08:30:00Z"))}
        {" · "}
        {new Intl.NumberFormat(workspace.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234567.89)}
      </div>
    </div>}

    {view === "warehouse-access" && canEditWorkspace && <WarehouseMaster operateIds={ownOperateIds} onChanged={() => void refreshWarehouses()} />}
    {view === "warehouse-access" && <div className="mt-5 overflow-x-auto" data-testid="warehouse-access">
      {canReadUsers && <div className="mb-3 flex gap-2"><select aria-label={t("settings.user")} data-testid="warehouse-access-user" className={`${field} max-w-sm`} value={scopeUserId} onChange={event => setScopeUserId(event.target.value)}>{users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select>{canManageUsers && <button data-testid="warehouse-access-save" onClick={saveScopes} className={`${button} text-white`} style={{ background: A.blue }}><Save size={15} />{t("settings.saveAccess")}</button>}</div>}
      <table className="w-full text-sm"><thead><tr><th className="p-2 text-left">{t("settings.warehouse")}</th><th>{t("settings.warehouseScope")}</th><th>{t("settings.defaultWarehouse")}</th></tr></thead><tbody>{warehouses.map(warehouse => {
        // A user's access is exactly their warehouse scopes, administrators
        // included: no role name grants every warehouse.
        const scopes = scopeTarget ? scopeTarget.warehouseScopes : profile.warehouseScopes || [];
        const access = scopes.find(scope => scope.warehouseId === warehouse.id)?.accessLevel || "";
        const defaultWarehouseId = scopeTarget ? scopeTarget.defaultWarehouseId : profile.defaultWarehouseId;
        return <tr key={warehouse.id} className="border-t"><td className="p-2">{warehouse.code} · {warehouse.name}{warehouse.status !== "active" && <span className="text-slate-500"> · {t("settings.warehouseInactive")}</span>}</td><td className="text-center">{canManageUsers && scopeTarget ? <select aria-label={`${warehouse.code} ${t("settings.warehouseScope")}`} className={field} value={access} onChange={event => setUsers(rows => rows.map(user => user.id === scopeTarget.id ? { ...user, warehouseScopes: [...user.warehouseScopes.filter(scope => scope.warehouseId !== warehouse.id), ...(event.target.value ? [{ warehouseId: warehouse.id, accessLevel: event.target.value }] : [])] } : user))}><option value="">{t("settings.noAccess")}</option><option value="read">{t("settings.read")}</option><option value="operate">{t("settings.operate")}</option></select> : accessName(access)}</td><td className="text-center">{defaultWarehouseId === warehouse.id ? "✓" : "—"}</td></tr>;
      })}</tbody></table>
    </div>}

    {view === "readiness" && <div className="mt-5 space-y-4">
      <div className="grid gap-3 md:grid-cols-3">{[
        [t("settings.profileSection"), Boolean(profile.profileCompletedAt)],
        [t("settings.workspaceSection"), Boolean(workspace.workspaceCompletedAt)],
        [t("settings.accessSection"), ownWarehouseIds.size > 0],
      ].map(([label, ok]) => <div key={String(label)} className="rounded-xl border p-4"><ShieldCheck size={18} color={ok ? A.green : A.orange} /><div className="mt-2 font-semibold">{label}</div><div className="text-sm text-slate-500">{ok ? t("settings.ready") : t("settings.needsSetup")}</div></div>)}</div>
      {canReadDiagnostics && diagnostics && <div className="rounded-xl border p-4" data-testid="admin-diagnostics"><div className="flex items-center justify-between"><h3 className="font-semibold">{t("settings.systemReadiness")}</h3><span className="text-xs uppercase">{diagnostics.overall}</span></div><div className="mt-3 grid gap-2 md:grid-cols-2">{diagnostics.checks.map(check => <div key={check.id} className="rounded-lg bg-slate-50 p-3 text-sm"><span className="font-semibold">{check.status.toUpperCase()}</span> · {check.id}</div>)}</div><div className="mt-3 text-xs text-slate-500">{formatDateTime(diagnostics.generatedAt)}</div></div>}
    </div>}
  </Card>;
  // The letterhead and document templates sit with the company they print.
  if (view === "company") return <div className="space-y-5">{settingsCard}<DocumentTemplateSettings canEdit={canEditWorkspace} /></div>;
  return settingsCard;
}
