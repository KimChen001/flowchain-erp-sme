import React, { useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { Activity, ArrowLeft, Link2, Loader2, Lock, Mail, ShieldCheck } from "lucide-react";
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
const RESEND_DELAY_SECONDS = 60;

const COPY = {
  tagline: { en: "AI-powered inventory and supply chain workspace", zh: PRODUCT_TAGLINE },
  headline: { en: "Connect purchasing, sales, inventory, and business insights in one workspace.", zh: "把基础资料、采购、销售、库存和经营分析连接到同一个工作台。" },
  intro: { en: "FlowChain brings master data, purchasing, sales, inventory, analytics, and operational finance together for small and medium businesses. Payment, collection, refund, tax, and general-ledger execution are not enabled.", zh: "FlowChain 是面向中小企业的 ERP 进销存协同平台，当前连接基础资料、采购、销售、库存、经营分析和运营财务。付款、收款、退款、税务与总账执行尚未启用。" },
  buy: { en: "Buy", zh: "采" },
  buyLabel: { en: "Purchasing", zh: "采购协同" },
  stock: { en: "Stock", zh: "库" },
  stockLabel: { en: "Inventory", zh: "库存管理" },
  plan: { en: "Plan", zh: "析" },
  planLabel: { en: "Business insights", zh: "经营洞察" },
  title: { en: "Sign in to your workspace", zh: "登录工作区" },
  subtitle: { en: "We'll email you a secure sign-in link.", zh: "我们会向你的邮箱发送一个安全登录链接。" },
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
} as const;

type CopyKey = keyof typeof COPY;

function useCopy() {
  const { language } = useI18n();
  return (key: CopyKey, values: Record<string, string | number> = {}) => {
    const template: string = COPY[key][language === "zh-CN" ? "zh" : "en"];
    return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  };
}

function SignInLayout({ children }: { children: React.ReactNode }) {
  const copy = useCopy();
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: A.bg, fontFamily: "var(--fc-font-family)" }}>
      <Toaster position="top-right" />
      <div className="w-full max-w-5xl grid grid-cols-[1.05fr_0.95fr] gap-8 items-center">
        <section className="space-y-8">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, #0071e3 0%, #32ade6 100%)" }}>
              <Activity size={20} className="text-white" strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-2xl font-semibold" style={{ color: A.label }}>{PRODUCT_NAME}</div>
              <div className="text-sm" style={{ color: A.sub }}>{copy("tagline")}</div>
            </div>
          </div>
          <div>
            <h1 className="text-[38px] leading-tight font-semibold mb-4" style={{ color: A.label }}>{copy("headline")}</h1>
            <p className="text-base leading-7 max-w-xl" style={{ color: A.sub }}>{copy("intro")}</p>
          </div>
          <div className="grid grid-cols-3 gap-3 max-w-xl">
            {([["buy", "buyLabel"], ["stock", "stockLabel"], ["plan", "planLabel"]] as const).map(([value, label]) => (
              <div key={value} className="rounded-2xl px-4 py-3" style={{ background: A.white, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                <div className="text-lg font-semibold" style={{ color: A.label }}>{copy(value)}</div>
                <div className="text-xs" style={{ color: A.gray1 }}>{copy(label)}</div>
              </div>
            ))}
          </div>
        </section>
        <div className="rounded-[20px] p-6 space-y-4" style={{ background: A.white, boxShadow: "0 18px 60px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.08)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function CardHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 pb-2">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "#f0f6ff", color: A.blue }}>{icon}</div>
      <div>
        <h2 className="text-base font-semibold" style={{ color: A.label }}>{title}</h2>
        {subtitle && <div className="text-xs" style={{ color: A.gray1 }}>{subtitle}</div>}
      </div>
    </div>
  );
}

const primaryButton = "w-full h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-white disabled:opacity-70";
const secondaryButton = "w-full h-10 rounded-xl flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-60";

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
    <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 space-y-2" data-testid="local-sign-in-link">
      <div className="font-semibold">{copy("localTitle")}</div>
      <div>{copy("localOnly")}</div>
      <button type="button" className="rounded-md bg-white px-2 py-1 inline-flex items-center gap-1" onClick={load} disabled={state.status === "loading"}>
        <Link2 size={12} />{copy("viewLink")}
      </button>
      {state.status === "ready" && (state.url
        ? <div><a className="font-semibold underline break-all" href={state.url}>{copy("openLocalLink")}</a></div>
        : <div>{copy("noLocalLink")}</div>)}
    </div>
  );
}

export function LoginScreen({ localStatus }: { localStatus: LocalDevelopmentStatus | null }) {
  const { language, setGuestLanguage } = useI18n();
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
        <label className="block text-xs font-medium" style={{ color: A.gray1 }}>
          {copy("language")}
          <select aria-label="Interface language / 界面语言" value={language} onChange={event => setGuestLanguage(event.target.value as "en-US" | "zh-CN")} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white p-2">
            <option value="en-US">English</option>
            <option value="zh-CN">中文</option>
          </select>
        </label>
        {localStatus && (
          <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900" data-testid="local-login-metadata">
            <div className="font-semibold">{copy("localTitle")} · {localStatus.workspaceName}</div>
            <div className="mt-1">{copy("localAccounts")}{localStatus.availableLoginEmails.join(", ")}</div>
            <div className="mt-2 flex gap-2">
              {localStatus.availableLoginEmails.map((address) => (
                <button key={address} type="button" className="rounded-md bg-white px-2 py-1" onClick={() => setEmail(address)}>
                  {address === "admin@flowchain.local" ? copy("useAdmin") : copy("useManager")}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="block">
          <span className="text-xs font-medium" style={{ color: A.gray1 }}>{copy("email")}</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full h-11 rounded-xl px-3 text-sm outline-none"
            style={{ background: A.gray6, color: A.label, border: "0.5px solid rgba(0,0,0,0.08)" }}
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
