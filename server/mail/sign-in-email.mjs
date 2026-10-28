// The transactional email that carries a sign-in link: plain, in the user's
// language (US English unless their preference is zh-CN), as text and HTML.
export const SIGN_IN_LINK_TTL_MINUTES = 15;

export const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const COPY = {
  "en-US": {
    subject: "Your FlowChain sign-in link",
    heading: (workspace) => (workspace ? `Sign in to ${workspace}` : "Sign in to your FlowChain workspace"),
    intro: "Use the button below to sign in to FlowChain.",
    button: "Sign in to FlowChain",
    fallback: "Or copy and paste this link into your browser:",
    expiry: (minutes) => `This link expires in ${minutes} minutes and can be used once.`,
    ignore: "If you didn't request this, you can ignore this email. Nobody can sign in without the link.",
    signature: "FlowChain",
  },
  "zh-CN": {
    subject: "你的 FlowChain 登录链接",
    heading: (workspace) => (workspace ? `登录 ${workspace}` : "登录你的 FlowChain 工作区"),
    intro: "点击下方按钮登录 FlowChain。",
    button: "登录 FlowChain",
    fallback: "也可以将此链接复制到浏览器中打开：",
    expiry: (minutes) => `此链接 ${minutes} 分钟后失效，且只能使用一次。`,
    ignore: "如果这不是你本人的操作，请忽略此邮件。没有此链接，任何人都无法登录。",
    signature: "FlowChain",
  },
};

export function buildSignInEmail({ language, workspaceName, link, expiresInMinutes = SIGN_IN_LINK_TTL_MINUTES }) {
  const lang = language === "zh-CN" ? "zh-CN" : "en-US";
  const copy = COPY[lang];
  const workspace = String(workspaceName || "").trim();
  const heading = copy.heading(workspace);
  const expiry = copy.expiry(expiresInMinutes);

  const text = [
    heading,
    "",
    copy.intro,
    "",
    link,
    "",
    expiry,
    "",
    copy.ignore,
    "",
    `— ${copy.signature}`,
  ].join("\n");

  const href = escapeHtml(link);
  const html = `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(copy.subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:22px;">${escapeHtml(copy.intro)}</p>
<p style="margin:0 0 24px;"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#0071e3;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#6e6e73;">${escapeHtml(copy.fallback)}</p>
<p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;"><a href="${href}" style="color:#0071e3;">${href}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#6e6e73;">${escapeHtml(expiry)}</p>
<p style="margin:0;font-size:13px;line-height:20px;color:#6e6e73;">${escapeHtml(copy.ignore)}</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject: copy.subject, text, html };
}
