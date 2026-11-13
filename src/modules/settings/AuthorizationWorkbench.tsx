import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, Save, ShieldAlert, Users } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, useConfirm } from "../../components/ui";
import { permissionLabel } from "./permissionLabels";
import { useI18n } from "../../i18n/I18n";
import { ROLE_TEMPLATE_NAMES, roleDisplayName } from "../../../shared/roles.mjs";

type Permission = { code: string; module: string; resource: string; action: string; riskLevel: string; fieldVisibility: string[] };
type Role = { id: string; roleKey: string; name: string; description?: string; status: string; isDefaultTemplate: boolean; version: number; updatedAt: string; updatedBy?: { id: string; name: string }; permissionCodes: string[]; permissionCount: number; userCount: number; members: Array<{ id: string; name: string; email: string }> };
type User = { id: string; name: string; email: string; status: string; legacyRole: string; roleIds: string[]; roles: Array<{ id: string; name: string }>; warehouseScopes: Array<{ warehouseId: string; accessLevel: string }> };
type Model = { permissionCatalog: Permission[]; roles: Role[]; users: User[]; defaultRoleTemplates: Array<{ roleKey: string; name: string }> };

const field = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";
const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50";
const moduleOrder = ["settings", "master_data", "contracts", "procurement", "receiving", "sales", "inventory", "returns", "finance", "audit"];
const moduleLabels: Record<string, [string, string]> = { settings: ["设置", "Settings"], master_data: ["基础资料", "Master data"], contracts: ["合同", "Contracts"], procurement: ["采购", "Procurement"], receiving: ["收货", "Receiving"], sales: ["销售与发货", "Sales & outbound"], inventory: ["库存", "Inventory"], returns: ["退货与隔离", "Returns & quarantine"], finance: ["财务", "Finance"], audit: ["审计", "Audit"] };
// Every signed-in user can read master data; its codes only allow editing, so
// they never hide the module and the visibility preview leaves it out.
const previewModules = moduleOrder.filter((module) => module !== "master_data");
const highRisk = new Set(["approve", "post", "reverse", "mark_export_ready", "manage"]);

export default function AuthorizationWorkbench() {
  const { language, formatDateTime } = useI18n();
  const en = language === "en-US";
  const [model, setModel] = useState<Model | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Role | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const tr = (zh: string, english: string) => en ? english : zh;
  const confirmDialog = useConfirm();
  const roleName = (role: Role) => roleDisplayName(role, language);
  // A default template's description as the workspace was given it
  // ("FlowChain default role template: Finance Specialist") reads in the
  // interface language; one the workspace wrote stays as written. Like the
  // name, the stored text changes only when someone edits it.
  const roleDescription = (role: Role) => {
    const template = ROLE_TEMPLATE_NAMES[role.roleKey];
    if (!template || role.description !== `FlowChain default role template: ${template.stored}`) return role.description || "";
    return tr(`FlowChain 默认角色模板：${template.zh}`, `FlowChain default role template: ${template.en}`);
  };
  const accessName = (access: string) => access === "operate" ? tr("可操作", "Operate") : access === "read" ? tr("只读", "Read") : access;
  // A warehouse scope is shown by the warehouse's name, else its code; the
  // stored id only for a warehouse the list does not have.
  const [warehouseLabels, setWarehouseLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    apiJson<{ warehouses?: Array<{ id: string; code?: string; name?: string }> }>("/api/master-data/warehouses")
      .then((payload) => { if (active) setWarehouseLabels(Object.fromEntries((payload?.warehouses || []).filter((row) => row.id).map((row) => [row.id, String(row.name || "").trim() || String(row.code || "").trim() || row.id]))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const warehouseLabel = (id: string) => warehouseLabels[id] || id;
  const load = async () => { try { const next = await apiJson<Model>("/api/authorization/roles"); setModel(next); const id = selectedId || next.roles[0]?.id || ""; setSelectedId(id); setDraft(next.roles.find((role) => role.id === id) || null); setNotice(""); } catch (error) { setNotice(error instanceof Error ? error.message : tr("无权访问或加载失败", "Access denied or failed to load")); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => { setDraft(model?.roles.find((role) => role.id === selectedId) || null); }, [selectedId, model]);
  const grouped = useMemo(() => moduleOrder.map((module) => ({ module, permissions: model?.permissionCatalog.filter((permission) => permission.module === module) || [] })).filter((group) => group.permissions.length), [model]);
  const selected = model?.roles.find((role) => role.id === selectedId);
  const changed = Boolean(draft && selected && JSON.stringify({ name: draft.name, description: draft.description, status: draft.status, permissionCodes: [...draft.permissionCodes].sort() }) !== JSON.stringify({ name: selected.name, description: selected.description, status: selected.status, permissionCodes: [...selected.permissionCodes].sort() }));
  const toggle = (code: string) => setDraft((current) => current ? { ...current, permissionCodes: current.permissionCodes.includes(code) ? current.permissionCodes.filter((item) => item !== code) : [...current.permissionCodes, code] } : current);
  const save = async () => { if (!draft) return; setSaving(true); try { await apiJson(`/api/authorization/roles/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: JSON.stringify({ name: draft.name, description: draft.description, status: draft.status, permissionCodes: draft.permissionCodes }) }); await load(); setNotice(tr("角色权限已立即生效。", "Role permissions are effective immediately.")); } catch (error) { setNotice(error instanceof Error ? error.message : tr("保存失败", "Save failed")); } finally { setSaving(false); } };
  const create = async (copyFromRoleId?: string) => {
    const source = copyFromRoleId ? model?.roles.find((role) => role.id === copyFromRoleId) : undefined;
    const name = await confirmDialog.prompt({
      title: source ? tr("复制角色", "Copy role") : tr("创建角色", "Create role"),
      description: source ? tr(`新角色从“${roleName(source)}”的权限开始。`, `The new role starts with the permissions of ${roleName(source)}.`) : tr("新角色没有任何权限，创建后在下方勾选。", "The new role has no permissions until you tick them below."),
      field: { label: tr("角色名称", "Role name"), placeholder: tr("例如：退货专员", "For example: Returns clerk"), multiline: false, maxLength: 120 },
      confirmLabel: tr("创建角色", "Create role"),
    });
    if (!name) return;
    try { const role = await apiJson<Role>("/api/authorization/roles", { method: "POST", body: JSON.stringify({ name, copyFromRoleId }) }); await load(); setSelectedId(role.id); } catch (error) { setNotice(error instanceof Error ? error.message : tr("创建失败", "Create failed")); } };
  // Ticking a role changes the member's access at once and ends their
  // sessions, so it names the change and asks first.
  const assign = async (user: User, roleId: string, enabled: boolean) => {
    const role = model?.roles.find((item) => item.id === roleId);
    const who = user.name || user.email;
    const what = role ? roleName(role) : "";
    const confirmed = await confirmDialog.confirm({
      title: enabled ? tr(`为 ${who} 分配“${what}”角色？`, `Give ${who} the ${what} role?`) : tr(`移除 ${who} 的“${what}”角色？`, `Remove the ${what} role from ${who}?`),
      description: tr("权限立即生效；该成员需要重新登录。", "Their permissions change straight away, and they'll need to sign in again."),
      confirmLabel: enabled ? tr("分配角色", "Give role") : tr("移除角色", "Remove role"),
      tone: enabled ? "primary" : "danger",
      testId: "role-assignment-dialog",
    });
    if (!confirmed) return;
    const roleIds = enabled ? [...new Set([...user.roleIds, roleId])] : user.roleIds.filter((id) => id !== roleId); try { await apiJson(`/api/authorization/users/${encodeURIComponent(user.id)}/roles`, { method: "PUT", body: JSON.stringify({ roleIds }) }); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : tr("分配失败", "Assignment failed")); } };
  if (!model) return <Card className="p-6" data-testid="authorization-workbench">{notice || tr("正在加载用户与角色…", "Loading users and roles…")}</Card>;
  return <div className="space-y-5" data-testid="authorization-workbench">
    {confirmDialog.element}
    <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{tr("角色与权限", "Roles and permissions")}</h2><p className="mt-1 text-sm text-slate-500">{tr("角色名称可自定义；角色中的权限由 FlowChain 定义。在仓库中操作还需要该仓库的访问权限。", "You can name roles yourself; the permissions in them are defined by FlowChain. Acting in a warehouse also needs access to that warehouse.")}</p></div><button data-testid="create-role" className={`${button} text-white`} style={{ background: A.blue }} onClick={() => void create()}><Plus size={15}/>{tr("创建角色", "Create role")}</button></div>{notice && <div role="status" className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">{notice}</div>}</Card>
    <div className="grid gap-5 xl:grid-cols-[390px_1fr]">
      <Card className="overflow-hidden"><div className="border-b p-4 font-semibold">{tr("角色列表", "Role list")}</div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3">{tr("角色", "Role")}</th><th>{tr("用户 / 权限", "Users / permissions")}</th><th>{tr("状态", "Status")}</th></tr></thead><tbody>{model.roles.map((role) => <tr key={role.id} className={`cursor-pointer border-t ${selectedId === role.id ? "bg-blue-50" : ""}`} onClick={() => setSelectedId(role.id)}><td className="p-3"><div className="font-medium">{roleName(role)}</div><div className="text-xs text-slate-500">{role.isDefaultTemplate ? tr("默认模板", "Default template") : tr("自定义角色", "Custom role")}<br/>{formatDateTime(role.updatedAt)} · {role.updatedBy?.name || "—"}</div></td><td>{role.userCount} / {role.permissionCount}</td><td>{role.status === "active" ? tr("启用", "Active") : tr("停用", "Inactive")}</td></tr>)}</tbody></table></div></Card>
      {draft && <Card className="p-5"><div className="flex flex-wrap justify-between gap-3"><div className="grid min-w-[280px] flex-1 gap-3 md:grid-cols-2"><label className="text-sm">{tr("角色名称", "Role name")}<input className={`${field} mt-1`} value={roleName(draft)} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label><label className="text-sm">{tr("状态", "Status")}<select className={`${field} mt-1`} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="active">{tr("启用", "Active")}</option><option value="inactive">{tr("停用", "Inactive")}</option></select></label><label className="text-sm md:col-span-2">{tr("描述", "Description")}<textarea className={`${field} mt-1`} value={roleDescription(draft)} onChange={(event) => setDraft({ ...draft, description: event.target.value })}/></label></div><div className="flex items-start gap-2"><button className={`${button} border bg-white`} onClick={() => void create(draft.id)}><Copy size={14}/>{tr("复制模板", "Copy role")}</button><button data-testid="save-role" className={`${button} text-white`} style={{ background: A.blue }} disabled={!changed || saving} onClick={() => void save()}><Save size={14}/>{tr("保存", "Save")}</button></div></div>
        <div className="mt-5"><h3 className="font-semibold">{tr("权限", "Permissions")}</h3><div className="mt-3 grid gap-4 lg:grid-cols-2">{grouped.map((group) => <section key={group.module} className="rounded-xl border p-4"><h4 className="font-semibold">{moduleLabels[group.module]?.[en ? 1 : 0] || group.module}</h4><div className="mt-2 space-y-2">{group.permissions.map((permission) => <label key={permission.code} className="flex items-start gap-2 text-sm"><input type="checkbox" data-testid={`permission-${permission.code}`} checked={draft.permissionCodes.includes(permission.code)} onChange={() => toggle(permission.code)}/><span><span>{permissionLabel(permission, en)}</span>{highRisk.has(permission.action) && <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-xs font-semibold text-rose-700"><ShieldAlert className="mr-1 inline" size={11}/>{tr("高风险", "High risk")}</span>}{permission.fieldVisibility.length > 0 && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">{tr("敏感字段", "Sensitive field")}</span>}</span></label>)}</div></section>)}</div></div>
        <div className="mt-5 rounded-xl bg-slate-50 p-4"><h3 className="font-semibold">{tr("模块可见性预览", "Module visibility preview")}</h3><div className="mt-2 flex flex-wrap gap-2">{previewModules.map((module) => { const visible = model.permissionCatalog.some((permission) => permission.module === module && (permission.action === "read" || permission.action === "manage") && draft.permissionCodes.includes(permission.code)); return <span key={module} className={`rounded-full px-3 py-1 text-xs ${visible ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-500"}`}>{moduleLabels[module]?.[en ? 1 : 0] || module}</span>; })}</div></div>
      </Card>}
    </div>
    <Card className="p-5"><h3 className="flex items-center gap-2 font-semibold"><Users size={17}/>{tr("用户分配与有效权限", "User assignment & effective permissions")}</h3><p className="mt-1 text-sm text-slate-500">{tr("角色与仓库权限分开设置。成员在仓库中操作还需要该仓库的访问权限。", "Roles and warehouse access are set separately. To act in a warehouse, a member also needs access to it.")}</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead className="bg-slate-50 text-left"><tr><th className="p-2">{tr("用户", "User")}</th>{model.roles.map((role) => <th className="p-2" key={role.id}>{roleName(role)}</th>)}<th>{tr("仓库范围", "Warehouse scope")}</th></tr></thead><tbody>{model.users.map((user) => <tr className="border-t" key={user.id}><td className="p-2"><div className="font-medium">{user.name}</div><div className="text-xs text-slate-500">{user.email}</div></td>{model.roles.map((role) => <td className="p-2" key={role.id}><input aria-label={`${user.email} ${roleName(role)}`} type="checkbox" checked={user.roleIds.includes(role.id)} disabled={role.status !== "active"} onChange={(event) => void assign(user, role.id, event.target.checked)}/></td>)}<td className="text-xs">{user.warehouseScopes.map((scope) => `${warehouseLabel(scope.warehouseId)} · ${accessName(scope.accessLevel)}`).join(", ") || tr("无", "None")}</td></tr>)}</tbody></table></div></Card>
  </div>;
}
