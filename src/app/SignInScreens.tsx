import React, { useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { Activity, ArrowLeft, BarChart3, Boxes, Globe, Info, Link2, Loader2, Lock, Mail, ShieldCheck, ShoppingCart } from "lucide-react";
import { A } from "../components/ui";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../lib/constants";
import { ApiError, apiJson, AUTH_TOKEN_KEY, CURRENT_USER_KEY } from "../lib/api-client";
import { useI18n } from "../i18n/I18n";
import type { WorkspaceUser } from "../types/scm";

export type LocalDevelopmentStatus = {
  localDevelopment: true;
  tenantId: string;
  workspaceName: string;
  availableLoginEmails: string[];
  demoMasterDataLoaded: boolean;
  demoScenarioLoaded: boolean;
  universalIntakeEnabled: boolean;
};

export const SIGN_IN_CONFIRM_PATH = "/sign-in/confirm";
export const ACCEPT_INVITATION_PATH = "/accept-invitation";
const RESEND_DELAY_SECONDS = 60;

const COPY = {
  tagline: { en: "AI-powered inventory and supply chain workspace", zh: PRODUCT_TAGLINE },
  // The headline is two lines so Chinese never breaks in the middle of a word.
  headlineLead: { en: "Purchasing, sales, and inventory,", zh: "采购、销售与库存，" },
  headlineRest: { en: "connected in one workspace.", zh: "在一个工作台协同完成。" },
  intro: { en: "An ERP workspace for small and medium businesses. Master data, purchasing, sales, inventory, analytics, and operational finance share one set of records.", zh: "面向中小企业的 ERP 进销存平台。基础资料、采购、销售、库存、经营分析与运营财务共用同一套数据。" },
  buyLabel: { en: "Purchasing", zh: "采购协同" },
  buyDetail: { en: "Requisitions, purchase orders, receiving, and supplier bills", zh: "采购申请、采购订单、收货与供应商账单" },
  stockLabel: { en: "Inventory", zh: "库存管理" },
  stockDetail: { en: "Stock by warehouse, reorder points, and movements", zh: "分仓库存、补货点与出入库记录" },
  planLabel: { en: "Business insights", zh: "经营洞察" },
  planDetail: { en: "Dashboards built from your own transactions", zh: "基于真实业务数据的经营看板" },
  scopeNote: { en: "Payment, collection, refund, tax, and general-ledger execution are not enabled.", zh: "付款、收款、退款、税务与总账执行尚未启用。" },
  title: { en: "Sign in to your workspace", zh: "登录工作区" },
  subtitle: { en: "Enter your work email and we'll send you a secure sign-in link.", zh: "输入工作邮箱，我们会发送一个安全登录链接。" },
  language: { en: "Interface language", zh: "界面语言" },
  email: { en: "Work email", zh: "工作邮箱" },
  send: { en: "Email me a sign-in link", zh: "发送登录链接" },
  sending: { en: "Sending", zh: "正在发送" },
  checkTitle: { en: "Check your email", zh: "请查看你的邮箱" },
  checkBody: { en: "If {email} can sign in to this workspace, a sign-in link is on its way. The link expires in 15 minutes and works once.", zh: "如果 {email} 可以登录此工作区，登录链接已发送。链接 15 分钟内有效，且只能使用一次。" },
  checkHint: { en: "Open the link on this device. It can take a minute to arrive; check your spam folder too.", zh: "请在本设备上打开链接。邮件可能需要一分钟左右送达，也请查看垃圾邮件文件夹。" },
  resend: { en: "Resend the link", zh: "重新发送链接" },
  resendIn: { en: "Resend available in {seconds}s", zh: "{seconds} 秒后可重新发送" },
  resent: { en: "If the email can sign in, a new link is on its way.", zh: "如果该邮箱可以登录，新的链接已发送。" },
  otherEmail: { en: "Use a different email", zh: "使用其他邮箱" },
  requestFailed: { en: "Unable to reach FlowChain. Check your connection and try again.", zh: "无法连接 FlowChain，请检查网络后重试。" },
  localTitle: { en: "Local development", zh: "本地开发" },
  localAccounts: { en: "Available local accounts: ", zh: "本地可用账户：" },
  useAdmin: { en: "Use local administrator", zh: "使用本地管理员" },
  useManager: { en: "Use local manager", zh: "使用本地经理" },
  viewLink: { en: "View the sign-in link", zh: "查看登录链接" },
  openLocalLink: { en: "Open the sign-in link", zh: "打开登录链接" },
  noLocalLink: { en: "No sign-in link for this email in the local outbox.", zh: "本地发件箱中没有该邮箱的登录链接。" },
  localOnly: { en: "Shown only while local development is on. Mail goes to the local outbox, not the internet.", zh: "仅在本地开发模式下显示。邮件写入本地发件箱，不会真正发出。" },
  confirmChecking: { en: "Checking your sign-in link…", zh: "正在检查登录链接…" },
  confirmTitle: { en: "Finish signing in", zh: "完成登录" },
  confirmBody: { en: "Click the button to open FlowChain on this device.", zh: "点击按钮，在本设备上打开 FlowChain。" },
  confirmButton: { en: "Sign in to {workspace}", zh: "登录 {workspace}" },
  confirmFallbackWorkspace: { en: "FlowChain", zh: "FlowChain" },
  confirmSigningIn: { en: "Signing in", zh: "正在登录" },
  invalidTitle: { en: "This sign-in link is invalid or has expired", zh: "登录链接无效或已过期" },
  invalidBody: { en: "Sign-in links work once and expire after 15 minutes. Request a new one to continue.", zh: "登录链接只能使用一次，15 分钟后失效。请重新获取链接后继续。" },
  backToSignIn: { en: "Back to sign in", zh: "返回登录" },
  inviteChecking: { en: "Checking your invitation…", zh: "正在检查邀请…" },
  inviteTitle: { en: "Join {workspace}", zh: "加入 {workspace}" },
  inviteBody: { en: "You were invited as {role} with {email}.", zh: "你以 {email} 被邀请为{role}。" },
  inviteName: { en: "Your name", zh: "你的姓名" },
  inviteAccept: { en: "Accept and email me a sign-in link", zh: "接受邀请并发送登录链接" },
  inviteAccepting: { en: "Accepting", zh: "正在接受" },
  inviteInvalidTitle: { en: "This invitation is invalid or has expired", zh: "邀请无效或已过期" },
  inviteInvalidBody: { en: "Invitations work once and expire. Ask the person who invited you for a new one.", zh: "邀请只能使用一次且会过期。请联系邀请你的人重新发送。" },
  inviteFailed: { en: "The invitation could not be accepted. Try again.", zh: "邀请接受失败，请重试。" },
} as const;

const INVITED_ROLE: Record<string, [string, string]> = {
  admin: ["Workspace Administrator", "工作区管理员"], manager: ["Operations Manager", "运营经理"],
  "business-specialist": ["Operations Specialist", "运营专员"], buyer: ["Procurement Specialist", "采购专员"],
  "finance-specialist": ["Finance Specialist", "财务专员"], viewer: ["Read-only Viewer", "只读查看者"],
};

type CopyKey = keyof typeof COPY;

function useCopy() {
  const { language } = useI18n();
  return (key: CopyKey, values: Record<string, string | number> = {}) => {
    const template: string = COPY[key][language === "zh-CN" ? "zh" : "en"];
    return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  };
}

const FEATURES = [
  { icon: ShoppingCart, label: "buyLabel", detail: "buyDetail" },
  { icon: Boxes, label: "stockLabel", detail: "stockDetail" },
  { icon: BarChart3, label: "planLabel", detail: "planDetail" },
] as const;

const NAVY = "#0f1b33";

function BrandMark({ size }: { size: "sm" | "lg" }) {
  const box = size === "lg" ? "w-10 h-10 rounded-xl" : "w-8 h-8 rounded-lg";
  return (
    <div className={`${box} flex items-center justify-center shrink-0`} style={{ background: A.blue }}>
      <Activity size={size === "lg" ? 20 : 16} className="text-white" strokeWidth={2.5} />
    </div>
  );
}

function LanguageSelect() {
  const { language, setGuestLanguage } = useI18n();
  const copy = useCopy();
  return (
    <label className="inline-flex items-center gap-1.5 rounded-lg border bg-white pl-2.5 pr-1 h-9 text-slate-600 focus-within:ring-2 focus-within:ring-blue-500/30" style={{ borderColor: A.gray4 }} title={copy("language")}>
      <Globe size={14} aria-hidden="true" />
      <select aria-label="Interface language / 界面语言" value={language} onChange={event => setGuestLanguage(event.target.value as "en-US" | "zh-CN")} className="h-full bg-transparent pr-1 outline-none cursor-pointer" style={{ color: A.label }}>
        <option value="en-US">English</option>
        <option value="zh-CN">中文</option>
      </select>
    </label>
  );
}

function SignInLayout({ children }: { children: React.ReactNode }) {
  const copy = useCopy();
  return (
    <>
      <Toaster position="top-right" />
      <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" style={{ background: "#f5f7fa", fontFamily: "var(--fc-font-family)" }}>
        <aside
          className="relative hidden lg:flex flex-col justify-between overflow-hidden px-14 py-12 text-white"
          style={{
            background: `radial-gradient(900px 520px at 85% 110%, rgba(37,99,235,0.45), transparent 60%), radial-gradient(600px 400px at -10% -10%, rgba(13,148,136,0.22), transparent 60%), ${NAVY}`,
          }}
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)", backgroundSize: "44px 44px", maskImage: "linear-gradient(180deg, black, transparent 85%)" }} />
          <div className="relative flex items-center gap-3">
            <BrandMark size="lg" />
            <div>
              <div className="text-lg font-semibold leading-tight">{PRODUCT_NAME}</div>
              <div className="text-[13px] leading-5" style={{ color: "#a5b4cf" }}>{copy("tagline")}</div>
            </div>
          </div>
          <div className="relative max-w-[560px] py-12">
            <h1 className="text-[36px] leading-[1.25] font-semibold tracking-tight">
              <span className="block">{copy("headlineLead")}</span>
              <span className="block" style={{ color: "#93b4ff" }}>{copy("headlineRest")}</span>
            </h1>
            <p className="mt-5 text-[15px] leading-7" style={{ color: "#c3cde0" }}>{copy("intro")}</p>
            <ul className="mt-10 space-y-3">
              {FEATURES.map(({ icon: Icon, label, detail }) => (
                <li key={label} className="flex items-start gap-4 rounded-xl px-4 py-3.5" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(37,99,235,0.22)", color: "#93b4ff" }}>
                    <Icon size={17} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold leading-5">{copy(label)}</div>
                    <div className="mt-0.5 text-[13px] leading-5" style={{ color: "#a5b4cf" }}>{copy(detail)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="relative flex items-center gap-2 text-xs leading-5" style={{ color: "#8393b0" }}>
            <Info size={13} className="shrink-0" />{copy("scopeNote")}
          </p>
        </aside>
        <main className="flex min-h-screen flex-col px-4 py-6 sm:px-8 lg:px-12">
          <div className="flex items-center justify-between gap-3 lg:justify-end">
            <div className="flex items-center gap-2.5 lg:hidden">
              <BrandMark size="sm" />
              <span className="text-base font-semibold" style={{ color: A.label }}>{PRODUCT_NAME}</span>
            </div>
            <LanguageSelect />
          </div>
          <div className="flex flex-1 items-center justify-center py-10">
            <div className="w-full max-w-[420px] rounded-2xl bg-white p-7 sm:p-8 space-y-5" style={{ border: `1px solid ${A.gray4}`, boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 12px 32px rgba(15,23,42,0.06)" }}>
              {children}
            </div>
          </div>
          <p className="lg:hidden text-center text-xs leading-5" style={{ color: A.gray1 }}>{copy("scopeNote")}</p>
        </main>
      </div>
    </>
  );
}

function CardHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="space-y-3 pb-1">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#eff4ff", color: A.blue }}>{icon}</div>
      <div>
        <h2 className="text-xl font-semibold leading-7" style={{ color: A.label }}>{title}</h2>
        {subtitle && <div className="mt-1 text-sm leading-6" style={{ color: A.gray1 }}>{subtitle}</div>}
      </div>
    </div>
  );
}

const primaryButton = "w-full h-11 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold text-white transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:opacity-70";
const inputClass = "mt-1.5 w-full h-11 rounded-lg border bg-white px-3 text-sm outline-none transition-shadow focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
const secondaryButton = "w-full h-10 rounded-lg flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-60";

// In local development the outbox holds the email instead of sending it;
// this reads the latest link for the address from the local-only endpoint.
function LocalSignInLink({ email }: { email: string }) {
  const copy = useCopy();
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready"; url: string }>({ status: "idle", url: "" });
  async function load() {
    setState({ status: "loading", url: "" });
    try {
      const result = await apiJson<{ links: Array<{ url: string }> }>(`/api/dev/sign-in-links?email=${encodeURIComponent(email)}`);
      setState({ status: "ready", url: result.links[0]?.url || "" });
    } catch {
      setState({ status: "ready", url: "" });
    }
  }
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs leading-5 text-amber-900 space-y-2" data-testid="local-sign-in-link">
      <div className="font-semibold">{copy("localTitle")}</div>
      <div>{copy("localOnly")}</div>
      <button type="button" className="rounded-md border border-amber-200 bg-white px-2 py-1 inline-flex items-center gap-1 hover:bg-amber-100" onClick={load} disabled={state.status === "loading"}>
        <Link2 size={12} />{copy("viewLink")}
      </button>
      {state.status === "ready" && (state.url
        ? <div><a className="font-semibold underline break-all" href={state.url}>{copy("openLocalLink")}</a></div>
        : <div>{copy("noLocalLink")}</div>)}
    </div>
  );
}

export function LoginScreen({ localStatus }: { localStatus: LocalDevelopmentStatus | null }) {
  const copy = useCopy();
  const [email, setEmail] = useState(localStatus?.availableLoginEmails[0] || "");
  const [sentTo, setSentTo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!sentTo) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sentTo]);

  async function requestLink(address: string) {
    setSending(true);
    setError("");
    try {
      await apiJson("/api/auth/email-link", { method: "POST", body: JSON.stringify({ email: address }) });
      setSentTo(address);
      setResendAt(Date.now() + RESEND_DELAY_SECONDS * 1000);
      setClock(Date.now());
      return true;
    } catch {
      setError(copy("requestFailed"));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setNotice("");
    await requestLink(email.trim());
  }

  async function resend() {
    if (await requestLink(sentTo)) setNotice(copy("resent"));
  }

  const secondsLeft = Math.max(0, Math.ceil((resendAt - clock) / 1000));

  if (sentTo) {
    return (
      <SignInLayout>
        <div data-testid="sign-in-check-email" className="space-y-4">
          <CardHeading icon={<Mail size={16} />} title={copy("checkTitle")} />
          <p className="text-sm leading-6" style={{ color: A.label }}>{copy("checkBody", { email: sentTo })}</p>
          <p className="text-xs leading-5" style={{ color: A.gray1 }}>{copy("checkHint")}</p>
          {notice && <p className="text-xs" role="status" style={{ color: A.gray1 }}>{notice}</p>}
          {error && <p className="text-xs" role="alert" style={{ color: A.red }}>{error}</p>}
          <button type="button" data-testid="sign-in-resend" onClick={resend} disabled={secondsLeft > 0 || sending} className={secondaryButton} style={{ background: A.gray6, color: A.label, border: "0.5px solid rgba(0,0,0,0.08)" }}>
            {sending ? <Loader2 size={14} className="animate-spin" /> : null}
            {secondsLeft > 0 ? copy("resendIn", { seconds: secondsLeft }) : copy("resend")}
          </button>
          <button type="button" onClick={() => { setSentTo(""); setNotice(""); setError(""); }} className={secondaryButton} style={{ color: A.blue }}>
            <ArrowLeft size={14} />{copy("otherEmail")}
          </button>
          {localStatus && <LocalSignInLink email={sentTo} />}
        </div>
      </SignInLayout>
    );
  }

  return (
    <SignInLayout>
      <form onSubmit={submit} className="space-y-4" data-testid="sign-in-email-form">
        <CardHeading icon={<Lock size={16} />} title={copy("title")} subtitle={copy("subtitle")} />
        {localStatus && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs leading-5 text-amber-900" data-testid="local-login-metadata">
            <div className="font-semibold">{copy("localTitle")} · {localStatus.workspaceName}</div>
            {localStatus.availableLoginEmails.length > 0 && (
              <>
                <div className="mt-0.5">{copy("localAccounts")}{localStatus.availableLoginEmails.join(", ")}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {localStatus.availableLoginEmails.map((address) => (
                    <button key={address} type="button" className="rounded-md border border-amber-200 bg-white px-2 py-1 hover:bg-amber-100" onClick={() => setEmail(address)}>
                      {address === "admin@flowchain.local" ? copy("useAdmin") : copy("useManager")}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <label className="block">
          <span className="text-sm font-medium" style={{ color: A.label }}>{copy("email")}</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
            style={{ color: A.label, borderColor: A.gray3 }}
            placeholder="name@company.com"
            type="email"
            autoComplete="email"
            required
          />
        </label>
        {error && <p className="text-xs" role="alert" style={{ color: A.red }}>{error}</p>}
        <button type="submit" disabled={sending} className={primaryButton} style={{ background: A.blue }}>
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
          {sending ? copy("sending") : copy("send")}
        </button>
      </form>
    </SignInLayout>
  );
}

// The page an invitation link opens. It shows what the invitation is for,
// accepts it with the person's name, then emails a sign-in link to the invited
// address. The token is removed from the address bar at once.
export function AcceptInvitationScreen({ localStatus }: { localStatus: LocalDevelopmentStatus | null }) {
  const copy = useCopy();
  const { language } = useI18n();
  const token = useRef<string | null>(null);
  if (token.current === null) token.current = new URLSearchParams(window.location.search).get("token") || "";
  const [invitation, setInvitation] = useState<{ email: string; role: string; workspaceName: string } | null>(null);
  const [status, setStatus] = useState<"checking" | "ready" | "accepting" | "sent" | "invalid">("checking");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (window.location.search) window.history.replaceState(window.history.state, "", ACCEPT_INVITATION_PATH);
    if (!token.current) { setStatus("invalid"); return; }
    let active = true;
    apiJson<{ email: string; role: string; workspaceName: string }>("/api/workspace/invitations/inspect", { method: "POST", body: JSON.stringify({ token: token.current }) })
      .then((result) => { if (active) { setInvitation(result); setStatus("ready"); } })
      .catch(() => { if (active) setStatus("invalid"); });
    return () => { active = false; };
  }, []);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    if (!invitation) return;
    setStatus("accepting"); setError("");
    try {
      await apiJson("/api/workspace/invitations/accept", { method: "POST", body: JSON.stringify({ token: token.current, name: name.trim() }) });
      await apiJson("/api/auth/email-link", { method: "POST", body: JSON.stringify({ email: invitation.email }) });
      setStatus("sent");
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status < 500 ? failure.message : copy("inviteFailed"));
      setStatus("ready");
    }
  }

  if (status === "checking") return <SignInLayout><div className="flex items-center gap-2 text-sm" style={{ color: A.gray1 }}><Loader2 size={14} className="animate-spin" />{copy("inviteChecking")}</div></SignInLayout>;
  if (status === "invalid" || !invitation) return (
    <SignInLayout>
      <div data-testid="invitation-invalid" className="space-y-4">
        <CardHeading icon={<Lock size={16} />} title={copy("inviteInvalidTitle")} />
        <p className="text-sm leading-6" style={{ color: A.label }}>{copy("inviteInvalidBody")}</p>
        <a href="/" className={secondaryButton} style={{ color: A.blue }}><ArrowLeft size={14} />{copy("backToSignIn")}</a>
      </div>
    </SignInLayout>
  );
  if (status === "sent") return (
    <SignInLayout>
      <div data-testid="invitation-accepted" className="space-y-4">
        <CardHeading icon={<Mail size={16} />} title={copy("checkTitle")} />
        <p className="text-sm leading-6" style={{ color: A.label }}>{copy("checkBody", { email: invitation.email })}</p>
        <p className="text-xs leading-5" style={{ color: A.gray1 }}>{copy("checkHint")}</p>
        {localStatus && <LocalSignInLink email={invitation.email} />}
      </div>
    </SignInLayout>
  );
  const roleName = INVITED_ROLE[invitation.role]?.[language === "zh-CN" ? 1 : 0] || invitation.role;
  return (
    <SignInLayout>
      <form onSubmit={accept} className="space-y-4" data-testid="accept-invitation-form">
        <CardHeading icon={<ShieldCheck size={16} />} title={copy("inviteTitle", { workspace: invitation.workspaceName })} subtitle={copy("inviteBody", { role: roleName, email: invitation.email })} />
        <label className="block">
          <span className="text-sm font-medium" style={{ color: A.label }}>{copy("inviteName")}</span>
          <input data-testid="accept-invitation-name" value={name} onChange={(event) => setName(event.target.value)} className={inputClass} style={{ color: A.label, borderColor: A.gray3 }} autoComplete="name" required />
        </label>
        {error && <p className="text-xs" role="alert" style={{ color: A.red }}>{error}</p>}
        <button data-testid="accept-invitation-submit" type="submit" disabled={status === "accepting" || !name.trim()} className={primaryButton} style={{ background: A.blue }}>
          {status === "accepting" ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
          {status === "accepting" ? copy("inviteAccepting") : copy("inviteAccept")}
        </button>
      </form>
    </SignInLayout>
  );
}

// The page a sign-in email links to. Opening it signs nobody in: mail
// scanners fetch links in advance, so the token is used only when the person
// clicks the button. The token is removed from the address bar at once.
export function SignInConfirmScreen({ onSignedIn }: { onSignedIn: (user: WorkspaceUser, token: string) => void }) {
  const copy = useCopy();
  const token = useRef<string | null>(null);
  if (token.current === null) token.current = new URLSearchParams(window.location.search).get("token") || "";
  const [state, setState] = useState<{ status: "checking" | "ready" | "signing" | "invalid"; workspaceName: string }>({ status: "checking", workspaceName: "" });

  useEffect(() => {
    if (window.location.search) window.history.replaceState(window.history.state, "", SIGN_IN_CONFIRM_PATH);
    if (!token.current) {
      setState({ status: "invalid", workspaceName: "" });
      return;
    }
    let active = true;
    apiJson<{ workspaceName: string }>("/api/auth/email-link/inspect", { method: "POST", body: JSON.stringify({ token: token.current }) })
      .then((result) => { if (active) setState({ status: "ready", workspaceName: result.workspaceName }); })
      .catch((error) => {
        if (!active) return;
        // Only a definite answer marks the link invalid; otherwise the button
        // still lets the person try.
        setState({ status: error instanceof ApiError && error.status === 400 ? "invalid" : "ready", workspaceName: "" });
      });
    return () => { active = false; };
  }, []);

  async function confirm() {
    setState((current) => ({ ...current, status: "signing" }));
    try {
      const result = await apiJson<{ token: string; user: WorkspaceUser }>("/api/auth/email-link/confirm", { method: "POST", body: JSON.stringify({ token: token.current }) });
      localStorage.setItem(AUTH_TOKEN_KEY, result.token);
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(result.user));
      onSignedIn(result.user, result.token);
    } catch {
      setState((current) => ({ ...current, status: "invalid" }));
    }
  }

  const workspace = state.workspaceName || copy("confirmFallbackWorkspace");
  return (
    <SignInLayout>
      {state.status === "checking" && (
        <div className="flex items-center gap-2 text-sm" style={{ color: A.gray1 }} data-testid="sign-in-confirm-checking">
          <Loader2 size={15} className="animate-spin" />{copy("confirmChecking")}
        </div>
      )}
      {(state.status === "ready" || state.status === "signing") && (
        <div className="space-y-4" data-testid="sign-in-confirm">
          <CardHeading icon={<ShieldCheck size={16} />} title={copy("confirmTitle")} subtitle={copy("confirmBody")} />
          <button type="button" onClick={confirm} disabled={state.status === "signing"} className={primaryButton} style={{ background: A.blue }}>
            {state.status === "signing" ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            {state.status === "signing" ? copy("confirmSigningIn") : copy("confirmButton", { workspace })}
          </button>
        </div>
      )}
      {state.status === "invalid" && (
        <div className="space-y-4" data-testid="sign-in-confirm-invalid" role="alert">
          <CardHeading icon={<Lock size={16} />} title={copy("invalidTitle")} />
          <p className="text-sm leading-6" style={{ color: A.gray1 }}>{copy("invalidBody")}</p>
          <a href="/" className={secondaryButton} style={{ background: A.gray6, color: A.label, border: "0.5px solid rgba(0,0,0,0.08)" }}>
            <ArrowLeft size={14} />{copy("backToSignIn")}
          </a>
        </div>
      )}
    </SignInLayout>
  );
}
