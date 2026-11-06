import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueSignInLink } from "../../server/auth/email-link-sign-in.mjs";
import { readBody, send } from "../../server/utils/http.mjs";
import { createOutboxMailer } from "../../server/mail/outbox-mailer.mjs";

// Test harnesses that run the server with NODE_ENV=production must pass the
// production config validation, which requires a real mail provider. These
// values satisfy it without being usable: the token is random, the sender and
// base URL use the reserved .test domain, and no harness requests a sign-in
// link, so nothing is ever sent to the provider. Approval emails, which the
// documents a harness submits would otherwise trigger, stay off unless the
// caller set FLOWCHAIN_APPROVAL_EMAILS.
export function productionHarnessMailEnv() {
  return {
    FLOWCHAIN_APPROVAL_EMAILS: process.env.FLOWCHAIN_APPROVAL_EMAILS || "off",
    FLOWCHAIN_MAIL_PROVIDER: "postmark",
    POSTMARK_SERVER_TOKEN: `harness-never-sends-${randomUUID()}`,
    FLOWCHAIN_MAIL_FROM: "FlowChain <sign-in@flowchain.test>",
    FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.test",
  };
}

// For in-process harnesses: createScmServer({ mailer }) with this writes any
// mail to a temporary outbox file instead of the configured provider.
export function productionHarnessMailer() {
  return createOutboxMailer({ path: join(tmpdir(), `flowchain-harness-outbox-${process.pid}.json`) });
}

// Production refuses the email-only test sign-in. A harness running the
// server in production mode signs in the way a person does after opening the
// email: it creates the link itself, standing in for the mailbox, and posts
// the token to the confirm endpoint, which creates a real database session.
// Resolves to the same { token, expiresAt, user } the sign-in routes return.
export async function signInThroughEmailLink(base, prisma, { tenantId, email }) {
  const user = await prisma.user.findFirst({ where: { tenantId, email: String(email).trim().toLowerCase() } });
  if (!user) throw Object.assign(new Error(`No provisioned user ${email}`), { status: 403, code: "USER_NOT_PROVISIONED" });
  const { token } = await prisma.$transaction((tx) => issueSignInLink(tx, { tenantId, userId: user.id }));
  const response = await fetch(`${base}/api/auth/email-link/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(`Email-link confirm failed with ${response.status} ${payload.code || ""}`), { status: response.status, code: payload.code, payload });
  return payload;
}

// Many browser specs still sign in with POST /api/auth/login. In production
// mode the server itself refuses that route, so an in-process harness puts
// this in front of the server: it answers the route by signing in through an
// email link as above. Unknown and disabled users get the 403 codes the
// local-development route returns. It never changes the server's own routes.
export function answerLegacySignInThroughEmailLink(server, { prisma, tenantId }) {
  const [handler] = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    if (req.method !== "POST" || new URL(req.url || "/", "http://harness").pathname !== "/api/auth/login") return handler(req, res);
    try {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const user = email ? await prisma.user.findFirst({ where: { tenantId, email } }) : null;
      if (!user) return send(res, 403, { code: "USER_NOT_PROVISIONED", message: "This email is not provisioned for the Pilot workspace." });
      if (user.status !== "active") return send(res, 403, { code: "USER_DISABLED", message: "This workspace user is disabled." });
      send(res, 200, await signInThroughEmailLink(`http://127.0.0.1:${server.address().port}`, prisma, { tenantId, email }));
    } catch (error) {
      send(res, error.status || 500, error.payload || { code: "HARNESS_SIGN_IN_FAILED", message: error.message });
    }
  });
  return server;
}
