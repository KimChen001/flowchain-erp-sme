import { randomBytes, randomUUID } from "node:crypto";
import { effectiveLanguage } from "../domain/workspace-settings-contract.mjs";
import { resolveServerTenantId } from "../domain/local-signed-session.mjs";
import { createMailer } from "../mail/mailer.mjs";
import { buildSignInEmail, SIGN_IN_LINK_TTL_MINUTES } from "../mail/sign-in-email.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { sha256Hex } from "./workspace-sessions.mjs";

// Email sign-in links. A request never reveals whether the address can sign
// in: every request gets the same answer, and only an active provisioned
// user is sent a link. A link is a single-use random token; only its SHA-256
// hash is stored. Opening the link does not sign in; the confirm page posts
// the token, and the server consumes it with one conditional update.
export const SIGN_IN_LINK_TTL_MS = SIGN_IN_LINK_TTL_MINUTES * 60_000;
export const EMAIL_LINK_RATE_WINDOW_MS = 60 * 60_000;
export const EMAIL_LINK_LIMITS = Object.freeze({ email: 5, ip: 20 });
const RATE_EVENT_RETENTION_MS = 24 * 60 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export const EMAIL_LINK_ACCEPTED = Object.freeze({
  status: "accepted",
  message: "If this email can sign in to the workspace, a sign-in link is on its way.",
});

export class SignInLinkInvalidError extends Error {
  constructor() {
    super("This sign-in link is invalid or has expired. Request a new one.");
    this.name = "SignInLinkInvalidError";
    this.code = "SIGN_IN_LINK_INVALID";
    this.status = 400;
  }
}

const text = (value) => String(value ?? "").trim();
const isProduction = (env) => text(env.NODE_ENV).toLowerCase() === "production" || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === "production";
const isLoopbackOrigin = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
};

export function normalizeSignInEmail(value) {
  const email = text(value).toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
}

// Links point at FLOWCHAIN_PUBLIC_BASE_URL, which production requires.
// Outside production they may fall back to the loopback origin the request
// came from, so a local sign-in link opens the local app.
export function signInLinkBaseUrl(env, req) {
  const configured = text(env.FLOWCHAIN_PUBLIC_BASE_URL).replace(/\/+$/, "");
  if (configured || isProduction(env)) return configured;
  return isLoopbackOrigin(req?.headers?.origin)
    || isLoopbackOrigin(`http://${req?.headers?.host || ""}`)
    || "http://localhost";
}

const linkAudit = ({ tenantId, actorId, action, entityType, entityId, summary, metadata }) => ({
  id: randomUUID(),
  tenantId,
  source: "email_link_sign_in",
  module: "auth",
  action,
  entityType,
  entityId,
  actorId,
  summary,
  metadata,
});

export function createEmailLinkService({
  env = process.env,
  prismaFactory = getPrismaClient,
  sessionStore,
  mailer = null,
  logger = console,
  now = () => Date.now(),
} = {}) {
  let resolvedMailer = mailer;
  const getMailer = () => (resolvedMailer ||= createMailer(env));
  const prisma = () => prismaFactory(env);

  // Records the request against both limits unless either is already
  // reached. The advisory locks serialize concurrent requests for the same
  // email or IP, so the limit holds under concurrency; they are always taken
  // email first, then IP, so two requests never wait on each other in a cycle.
  async function withinRateLimits(tx, { email, ip, at }) {
    const keys = [
      { kind: "email", keyHash: sha256Hex(`email:${email}`), limit: EMAIL_LINK_LIMITS.email },
      { kind: "ip", keyHash: sha256Hex(`ip:${ip || "unknown"}`), limit: EMAIL_LINK_LIMITS.ip },
    ];
    for (const key of keys) await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`sign-in:${key.kind}:${key.keyHash}`}))) AS lock`;
    const since = new Date(at.getTime() - EMAIL_LINK_RATE_WINDOW_MS);
    for (const key of keys) {
      const count = await tx.signInRateLimitEvent.count({ where: { kind: key.kind, keyHash: key.keyHash, createdAt: { gt: since } } });
      if (count >= key.limit) return { allowed: false, limit: key.kind, keyHash: key.keyHash };
    }
    await tx.signInRateLimitEvent.createMany({ data: keys.map((key) => ({ id: randomUUID(), kind: key.kind, keyHash: key.keyHash, createdAt: at })) });
    await tx.signInRateLimitEvent.deleteMany({ where: { createdAt: { lt: new Date(at.getTime() - RATE_EVENT_RETENTION_MS) } } });
    return { allowed: true };
  }

  // Resolves once the request is recorded. The email itself is sent after
  // that, so the answer takes the same time whether or not a link was sent;
  // `delivery` settles when sending finishes and never rejects.
  async function request({ email: rawEmail, client = {}, req = null }) {
    const email = normalizeSignInEmail(rawEmail);
    const tenantId = resolveServerTenantId(env);
    if (!email || !tenantId) return { outcome: "ignored", delivery: Promise.resolve() };
    const at = new Date(now());
    const db = await prisma();
    const result = await db.$transaction(async (tx) => {
      const rate = await withinRateLimits(tx, { email, ip: client.ip, at });
      if (!rate.allowed) return { outcome: "rate_limited", rate };
      const user = await tx.user.findFirst({ where: { tenantId, email }, include: { tenant: true } });
      if (!user || user.status !== "active") return { outcome: "ignored" };

      const invalidated = await tx.workspaceSignInLink.updateMany({
        where: { tenantId, userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: at },
      });
      const token = randomBytes(32).toString("base64url");
      const link = await tx.workspaceSignInLink.create({
        data: {
          id: randomUUID(),
          tenantId,
          userId: user.id,
          tokenHash: sha256Hex(token),
          createdAt: at,
          expiresAt: new Date(at.getTime() + SIGN_IN_LINK_TTL_MS),
          requestIp: client.ipAddress || null,
          requestUserAgent: client.userAgent || null,
        },
      });
      await tx.auditLog.create({ data: linkAudit({
        tenantId,
        actorId: user.id,
        action: "sign_in_link_requested",
        entityType: "WorkspaceSignInLink",
        entityId: link.id,
        summary: "Sign-in link requested.",
        metadata: { expiresAt: link.expiresAt.toISOString(), requestIp: link.requestIp, invalidatedEarlierLinks: invalidated.count },
      }) });
      return { outcome: "sent", user, token };
    });

    if (result.outcome === "rate_limited") {
      logger.warn?.(JSON.stringify({ event: "sign_in_link_rate_limited", limit: result.rate.limit, key: result.rate.keyHash.slice(0, 12), ipAddress: client.ipAddress || null }));
      return { outcome: "rate_limited", delivery: Promise.resolve() };
    }
    if (result.outcome !== "sent") return { outcome: result.outcome, delivery: Promise.resolve() };

    const { user, token } = result;
    const linkUrl = `${signInLinkBaseUrl(env, req)}/sign-in/confirm?token=${encodeURIComponent(token)}`;
    let language = "en-US";
    try {
      language = effectiveLanguage(user, user.tenant);
    } catch {
      // An unsupported stored preference falls back to US English.
    }
    const message = buildSignInEmail({ language, workspaceName: user.tenant.name, link: linkUrl });
    const delivery = Promise.resolve()
      .then(() => getMailer().send({ to: user.email, ...message, tag: "sign-in-link" }))
      .then((sent) => {
        logger.info?.(JSON.stringify({ event: "sign_in_link_sent", provider: sent.provider, messageId: sent.messageId, userId: user.id }));
      })
      .catch((error) => {
        logger.error?.(JSON.stringify({ event: "sign_in_link_delivery_failed", provider: error?.provider || null, status: error?.status || null, providerCode: error?.providerCode || null, code: error?.code || "MAIL_DELIVERY_FAILED", userId: user.id }));
      });
    return { outcome: "sent", delivery };
  }

  const usableLink = (at) => ({ consumedAt: null, invalidatedAt: null, expiresAt: { gt: at } });

  function assertLinkUser(link) {
    const serverTenantId = resolveServerTenantId(env);
    if (!link?.user || link.user.status !== "active" || link.user.tenantId !== link.tenantId) throw new SignInLinkInvalidError();
    if (serverTenantId && link.tenantId !== serverTenantId) throw new SignInLinkInvalidError();
  }

  // For the confirm page: the workspace name, without using the link.
  async function inspect(token) {
    if (!TOKEN_PATTERN.test(text(token))) throw new SignInLinkInvalidError();
    const db = await prisma();
    const link = await db.workspaceSignInLink.findFirst({
      where: { tokenHash: sha256Hex(text(token)), ...usableLink(new Date(now())) },
      include: { user: true, tenant: true },
    });
    assertLinkUser(link);
    return { workspaceName: link.tenant.name };
  }

  // Uses the link and creates the session in one transaction. The
  // conditional update succeeds for exactly one caller, so a replayed or
  // concurrent confirm fails. Every failure is the same generic error.
  async function confirm({ token, client = {} }) {
    if (!TOKEN_PATTERN.test(text(token))) throw new SignInLinkInvalidError();
    const tokenHash = sha256Hex(text(token));
    const at = new Date(now());
    const db = await prisma();
    return db.$transaction(async (tx) => {
      const consumed = await tx.workspaceSignInLink.updateMany({
        where: { tokenHash, ...usableLink(at) },
        data: { consumedAt: at },
      });
      if (consumed.count !== 1) throw new SignInLinkInvalidError();
      const link = await tx.workspaceSignInLink.findUnique({ where: { tokenHash }, include: { user: true, tenant: true } });
      assertLinkUser(link);
      const created = await sessionStore.create({
        db: tx,
        tenantId: link.tenantId,
        userId: link.userId,
        userAgent: client.userAgent,
        ipAddress: client.ipAddress,
      });
      await tx.auditLog.create({ data: linkAudit({
        tenantId: link.tenantId,
        actorId: link.userId,
        action: "sign_in_link_consumed",
        entityType: "WorkspaceSignInLink",
        entityId: link.id,
        summary: "Sign-in link used.",
        metadata: { sessionId: created.row.id, ipAddress: client.ipAddress || null },
      }) });
      await tx.auditLog.create({ data: linkAudit({
        tenantId: link.tenantId,
        actorId: link.userId,
        action: "session_created",
        entityType: "WorkspaceSession",
        entityId: created.row.id,
        summary: "Signed in with an email link.",
        metadata: { method: "email_link", expiresAt: created.expiresAt.toISOString(), ipAddress: client.ipAddress || null },
      }) });
      return { created, user: link.user, tenant: link.tenant };
    });
  }

  return { request, inspect, confirm };
}
