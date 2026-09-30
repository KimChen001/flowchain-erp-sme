import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { normalizedRole } from "../domain/local-signed-session.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

// Signed-in sessions live in PostgreSQL (WorkspaceSession), so a deploy or a
// restart keeps people signed in. The bearer token names a random session
// id; the database stores only its SHA-256 hash. Every request checks the
// row: not revoked, not expired, user still active in the session's tenant.
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
// A verified session is reused for at most this long before the row is read
// again. Revoking through this process drops the entry at once; another
// process sees the revocation within this window.
export const SESSION_CACHE_TTL_MS = 10_000;
const SESSION_CACHE_MAX_ENTRIES = 5_000;
const LAST_SEEN_INTERVAL_MS = 5 * 60_000;
const USER_AGENT_MAX_LENGTH = 256;

const text = (value) => String(value ?? "").trim();
export const sha256Hex = (value) => createHash("sha256").update(String(value)).digest("hex");

// Only the network prefix is kept: /24 for IPv4 and /48 for IPv6.
export function truncateIp(value) {
  const ip = text(value).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.0`;
  if (isIP(ip) === 6) {
    const [head] = ip.split("::");
    const groups = head.split(":").filter(Boolean);
    return `${[...groups, "0", "0", "0"].slice(0, 3).join(":")}::`;
  }
  return null;
}

export function truncateUserAgent(value) {
  const agent = text(value);
  return agent ? agent.slice(0, USER_AGENT_MAX_LENGTH) : null;
}

// Behind the HTTPS gateway every connection comes from the gateway, so the
// client address is the last X-Forwarded-For entry, which the gateway itself
// appended. Earlier entries are client-supplied and never trusted.
export function clientIp(req, env = process.env) {
  if (text(env.FLOWCHAIN_TRUST_PROXY).toLowerCase() === "true") {
    const forwarded = String(req.headers?.["x-forwarded-for"] || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded.at(-1);
  }
  return text(req.socket?.remoteAddress);
}

export function requestClient(req, env = process.env) {
  const ip = clientIp(req, env);
  return { ip, ipAddress: truncateIp(ip), userAgent: truncateUserAgent(req.headers?.["user-agent"]) };
}

const sessionAudit = ({ tenantId, actorId, action, entityType, entityId, summary, metadata }) => ({
  id: randomUUID(),
  tenantId,
  source: "workspace_session",
  module: "auth",
  action,
  entityType,
  entityId,
  actorId,
  summary,
  metadata,
});

// Ends every live session of a user and any unused sign-in link, for
// disabling a user or changing their role. Pass a transaction client to make
// it part of the change itself.
export async function revokeUserSessions(db, { tenantId, userId, reason, actorId = null, now = new Date() }) {
  const revoked = await db.workspaceSession.updateMany({
    where: { tenantId, userId, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now, revokedReason: reason },
  });
  await db.workspaceSignInLink.updateMany({
    where: { tenantId, userId, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: now },
  });
  if (revoked.count > 0) {
    await db.auditLog.create({ data: sessionAudit({
      tenantId,
      actorId,
      action: "sessions_revoked",
      entityType: "User",
      entityId: userId,
      summary: `Ended ${revoked.count} signed-in ${revoked.count === 1 ? "session" : "sessions"}.`,
      metadata: { reason, count: revoked.count },
    }) });
  }
  return revoked.count;
}

export function createWorkspaceSessionStore({
  env = process.env,
  prismaFactory = getPrismaClient,
  now = () => Date.now(),
  cacheTtlMs = SESSION_CACHE_TTL_MS,
} = {}) {
  const cache = new Map();
  const prisma = () => prismaFactory(env);

  function remember(hash, entry) {
    if (cache.size >= SESSION_CACHE_MAX_ENTRIES) cache.clear();
    cache.set(hash, entry);
  }

  function forgetUser(userId) {
    for (const [hash, entry] of cache) if (entry.session.userId === userId) cache.delete(hash);
  }

  // Creates the row and returns the raw session id for the signed token.
  // `db` may be a transaction client.
  async function create({ tenantId, userId, userAgent = null, ipAddress = null, db = null }) {
    const sessionId = randomBytes(32).toString("base64url");
    const createdAt = new Date(now());
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_SECONDS * 1000);
    const client = db || (await prisma());
    const row = await client.workspaceSession.create({
      data: {
        id: randomUUID(),
        tenantId,
        userId,
        sessionIdHash: sha256Hex(sessionId),
        createdAt,
        expiresAt,
        lastSeenAt: createdAt,
        userAgent: truncateUserAgent(userAgent),
        ipAddress,
      },
    });
    return { sessionId, row, expiresAt };
  }

  // Returns the signed-in session for a raw session id, or null.
  async function resolve(sessionId) {
    const hash = sha256Hex(sessionId);
    const current = now();
    const cached = cache.get(hash);
    if (cached && cached.checkedAt + cacheTtlMs > current && cached.session.expiresAtMs > current) return cached.session;
    cache.delete(hash);

    const client = await prisma();
    const row = await client.workspaceSession.findUnique({
      where: { sessionIdHash: hash },
      include: { user: { select: { id: true, tenantId: true, email: true, name: true, role: true, status: true } } },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= current) return null;
    // The session keeps its own tenant, whatever FLOWCHAIN_DEFAULT_TENANT_ID
    // says now; the user must still be active in that tenant.
    if (!row.user || row.user.status !== "active" || row.user.tenantId !== row.tenantId) return null;

    if (current - row.lastSeenAt.getTime() > LAST_SEEN_INTERVAL_MS) {
      await client.workspaceSession
        .updateMany({ where: { id: row.id, revokedAt: null }, data: { lastSeenAt: new Date(current) } })
        .catch(() => {});
    }
    const session = {
      id: row.id,
      sessionId,
      userId: row.user.id,
      tenantId: row.tenantId,
      name: row.user.name,
      email: row.user.email,
      role: normalizedRole(row.user.role),
      expiresAtMs: row.expiresAt.getTime(),
    };
    remember(hash, { session, checkedAt: current });
    return session;
  }

  // Ends one session (sign-out). Returns the revoked row, or null when the
  // session was already ended.
  async function revoke(sessionId, { reason = "logout", actorId = null } = {}) {
    const hash = sha256Hex(sessionId);
    cache.delete(hash);
    const client = await prisma();
    const revokedAt = new Date(now());
    return client.$transaction(async (tx) => {
      const updated = await tx.workspaceSession.updateMany({
        where: { sessionIdHash: hash, revokedAt: null },
        data: { revokedAt, revokedReason: reason },
      });
      if (updated.count !== 1) return null;
      const row = await tx.workspaceSession.findUnique({ where: { sessionIdHash: hash } });
      await tx.auditLog.create({ data: sessionAudit({
        tenantId: row.tenantId,
        actorId: actorId || row.userId,
        action: "session_logout",
        entityType: "WorkspaceSession",
        entityId: row.id,
        summary: "Signed out.",
        metadata: { reason },
      }) });
      return row;
    });
  }

  async function revokeUser({ tenantId, userId, reason, actorId = null, db = null }) {
    forgetUser(userId);
    const client = db || (await prisma());
    const count = await revokeUserSessions(client, { tenantId, userId, reason, actorId, now: new Date(now()) });
    forgetUser(userId);
    return count;
  }

  return { create, resolve, revoke, revokeUser, forgetUser };
}

export function publicSessionUser(user, tenant) {
  return { id: user.id, name: user.name, email: user.email, company: tenant?.name || "", role: normalizedRole(user.role), tenantId: user.tenantId };
}
