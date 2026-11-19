import { useCallback, useEffect, useState } from "react";
import { Copy, Send, UserCheck, UserX } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, useConfirm } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ROLE_NAMES } from "../../../shared/roles.mjs";
import { listTableCardsRef } from "../../components/ui/workbenchTable";

// Workspace members: invite a teammate with a role, revoke a pending
// invitation, and enable or disable a member. Role assignments and warehouse
// access are edited in the sections below. The server checks
// settings.users.read and settings.users.manage on every call, and
// settings.roles.assign to invite.

type Member = { id: string; name: string; email: string; role: string; status: string; version: number };
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string; createdAt: string };

// The invitation roles, each a default role template, named from the shared
// role vocabulary.
export const INVITATION_ROLES: Array<[string, string, string]> = ["manager", "business-specialist", "buyer", "finance-specialist", "viewer", "admin"]
  .map((code) => [code, ROLE_NAMES[code].en, ROLE_NAMES[code].zh]);
const STATUS: Record<string, [string, string]> = {
  active: ["Active", "已启用"], disabled: ["Disabled", "已停用"], pending: ["Pending", "待接受"],
  accepted: ["Accepted", "已接受"], expired: ["Expired", "已过期"], revoked: ["Revoked", "已撤销"],
};

const field = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";
const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50";

export default function WorkspaceMembers() {
  const { language, formatDateTime } = useI18n();
  const en = language === "en-US";
  const tr = (english: string, chinese: string) => (en ? english : chinese);
  const roleName = (role: string) => { const entry = INVITATION_ROLES.find(([code]) => code === role); return entry ? entry[en ? 1 : 2] : role; };
  const statusName = (status: string) => STATUS[status]?.[en ? 0 : 1] || status;
  const [permissions, setPermissions] = useState<Set<string> | null>(null);
  const [selfId, setSelfId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("business-specialist");
  const [link, setLink] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const confirmDialog = useConfirm();

  const load = useCallback(async () => {
    try {
      const context = await apiJson<{ effectivePermissions?: string[]; userId?: string; user?: { id: string } }>("/api/authorization/context");
      const granted = new Set(context.effectivePermissions || []);
      setPermissions(granted);
      setSelfId(context.userId || context.user?.id || "");
      if (!granted.has("settings.users.read")) return;
      const [users, invites] = await Promise.all([
        apiJson<{ users: Member[] }>("/api/workspace/users"),
        apiJson<{ invitations: Invitation[] }>("/api/workspace/invitations"),
      ]);
      setMembers(users.users);
      setInvitations(invites.invitations);
    } catch (error) {
      setPermissions((current) => current || new Set());
      setNotice(error instanceof Error ? error.message : tr("Members could not be loaded.", "成员加载失败。"));
    }
  }, [en]);
  useEffect(() => { void load(); }, [load]);

  if (!permissions) return <Card className="p-5" data-testid="workspace-members">{tr("Loading members…", "正在加载成员…")}</Card>;
  if (!permissions.has("settings.users.read")) return null;
  const canManage = permissions.has("settings.users.manage");
  // An invitation assigns its role when accepted, so the server also checks
  // settings.roles.assign before creating one.
  const canInvite = canManage && permissions.has("settings.roles.assign");

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("invite"); setNotice(""); setLink("");
    try {
      const result = await apiJson<{ invitationPath: string }>("/api/workspace/invitations", { method: "POST", body: JSON.stringify({ email: email.trim(), role }) });
      setLink(`${window.location.origin}${result.invitationPath}`);
      setEmail("");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tr("The invitation could not be created.", "邀请创建失败。"));
    } finally { setBusy(""); }
  };
  const revoke = async (invitation: Invitation) => {
    const confirmed = await confirmDialog.confirm({
      title: tr(`Revoke the invitation for ${invitation.email}?`, `撤销发给 ${invitation.email} 的邀请？`),
      description: tr("The invitation link stops working. You can invite them again later.", "邀请链接将失效。之后可以重新邀请。"),
      confirmLabel: tr("Revoke", "撤销"),
      cancelLabel: tr("Cancel", "取消"),
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(invitation.id); setNotice("");
    try { await apiJson(`/api/workspace/invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: "POST", body: JSON.stringify({}) }); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : tr("The invitation could not be revoked.", "邀请撤销失败。")); }
    finally { setBusy(""); }
  };
  const setStatus = async (member: Member, status: "active" | "disabled") => {
    if (status === "disabled" && !(await confirmDialog.confirm({
      title: tr(`Disable ${member.email}?`, `停用 ${member.email}？`),
      description: tr("They are signed out now and cannot sign in until enabled again.", "该成员会立即被登出，重新启用前无法登录。"),
      confirmLabel: tr("Disable", "停用"),
      cancelLabel: tr("Cancel", "取消"),
      tone: "danger",
    }))) return;
    setBusy(member.id); setNotice("");
    try { await apiJson(`/api/workspace/users/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify({ status, version: member.version }) }); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : tr("The member could not be updated.", "成员更新失败。")); await load(); }
    finally { setBusy(""); }
  };
  const pending = invitations.filter((invitation) => invitation.status === "pending");

  return <Card className="p-5" data-testid="workspace-members">
    {confirmDialog.element}
    <h2 className="text-lg font-semibold">{tr("Members", "成员")}</h2>
    <p className="mt-1 text-sm text-slate-500">{tr("Invite teammates and enable or disable members. Choose each member's roles and warehouse access below.", "邀请同事加入，启用或停用成员。成员的角色和仓库权限在下方设置。")}</p>
    {notice && <div role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{notice}</div>}

    {canInvite && <form onSubmit={(event) => void invite(event)} className="mt-4 flex flex-wrap items-end gap-2" data-testid="invite-member-form">
      <label className="text-sm">{tr("Email", "邮箱")}<input data-testid="invite-email" type="email" required className={`${field} mt-1 block w-72`} placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="text-sm">{tr("Role", "角色")}<select data-testid="invite-role" className={`${field} mt-1 block w-56`} value={role} onChange={(event) => setRole(event.target.value)}>{INVITATION_ROLES.map(([code, english, chinese]) => <option key={code} value={code}>{en ? english : chinese}</option>)}</select></label>
      <button data-testid="invite-submit" type="submit" disabled={busy === "invite" || !email.trim()} className={`${button} text-white`} style={{ background: A.blue }}><Send size={15} />{tr("Create invitation", "创建邀请")}</button>
    </form>}
    {link && <div data-testid="invite-link" className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
      <div>{tr("Email delivery is not connected. Send this link to the person yourself; it works once and expires in 3 days.", "尚未接入邮件发送，请自行把此链接发给对方；链接只能使用一次，3 天后过期。")}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all text-xs">{link}</code><button type="button" className="inline-flex items-center gap-1 text-blue-700" onClick={() => void navigator.clipboard?.writeText(link)}><Copy size={14} />{tr("Copy link", "复制链接")}</button></div>
    </div>}

    {/* On a phone each member is a card: name and status on top, the email
        under it and the Disable or Enable button at the bottom. */}
    <div className="mt-4 overflow-x-auto" ref={listTableCardsRef}><table className="w-full min-w-[640px] text-sm" data-testid="member-table"><thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-2">{tr("Name", "姓名")}</th><th className="p-2">{tr("Email", "邮箱")}</th><th className="p-2">{tr("Status", "状态")}</th><th className="p-2" /></tr></thead>
      <tbody>{members.map((member) => <tr key={member.id} className="border-t" data-testid={`member-${member.email}`}>
        <td className="p-2 font-medium">{member.name}</td><td className="p-2">{member.email}</td>
        <td className="p-2"><span className={`rounded-full px-2 py-0.5 text-xs ${member.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>{statusName(member.status)}</span></td>
        <td className="p-2 text-right">{canManage && member.id !== selfId && (member.status === "active"
          ? <button data-testid={`disable-${member.email}`} disabled={busy === member.id} className={`${button} border bg-white text-slate-700`} onClick={() => void setStatus(member, "disabled")}><UserX size={14} />{tr("Disable", "停用")}</button>
          : <button data-testid={`enable-${member.email}`} disabled={busy === member.id} className={`${button} border bg-white text-slate-700`} onClick={() => void setStatus(member, "active")}><UserCheck size={14} />{tr("Enable", "启用")}</button>)}</td>
      </tr>)}</tbody></table></div>

    {invitations.length > 0 && <div className="mt-4"><h3 className="text-sm font-semibold">{tr("Invitations", "邀请")} {pending.length ? `· ${pending.length} ${tr("pending", "待接受")}` : ""}</h3>
      <ul className="mt-2 space-y-1 text-sm" data-testid="invitation-list">{invitations.map((invitation) => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2" data-testid={`invitation-${invitation.email}`}>
        <span>{invitation.email} · {roleName(invitation.role)} · {statusName(invitation.status)} · {tr("expires", "过期时间")} {formatDateTime(invitation.expiresAt)}</span>
        {canManage && invitation.status === "pending" && <button data-testid={`revoke-${invitation.email}`} disabled={busy === invitation.id} className="text-sm text-red-600" onClick={() => void revoke(invitation)}>{tr("Revoke", "撤销")}</button>}
      </li>)}</ul></div>}
  </Card>;
}
