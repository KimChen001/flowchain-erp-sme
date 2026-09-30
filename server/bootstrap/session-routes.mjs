import { issueLocalSessionToken } from "../domain/local-signed-session.mjs";
import { publicSessionUser, requestClient, SESSION_TTL_SECONDS } from "../auth/workspace-sessions.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { readBody, send } from "../utils/http.mjs";
import { roleLabel } from "../../shared/roles.mjs";

export function normalizeLogin(body) {
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  if (!email) {
    throw new Error("email is required");
  }
  return { email };
}

// Issues the signed bearer token for a stored session and the payload every
// sign-in route returns.
export function signedInPayload({ created, user, tenant, localSessionSecret }) {
  const token = issueLocalSessionToken({ sessionId: created.sessionId }, localSessionSecret, { ttlSeconds: SESSION_TTL_SECONDS });
  const publicUser = publicSessionUser(user, tenant);
  return {
    token,
    expiresAt: created.expiresAt.toISOString(),
    user: { ...publicUser, roleLabel: roleLabel(publicUser.role) },
  };
}

export async function handleSessionRoutes({
  req,
  res,
  url,
  identity,
  sessionStore,
  localSessionSecret,
  env = process.env,
}) {
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    let profile;
    try {
      profile = normalizeLogin(body);
    } catch (error) {
      send(res, 400, { error: error.message });
      return true;
    }
    const tenantId = String(env.FLOWCHAIN_DEFAULT_TENANT_ID || "").trim();
    if (!tenantId) {
      send(res, 403, {
        code: "TENANT_CONTEXT_REQUIRED",
        message: "Pilot workspace tenant is not configured.",
      });
      return true;
    }
    const prisma = await getPrismaClient(env);
    const provisioned = await prisma.user.findFirst({
      where: { tenantId, email: profile.email },
      include: { tenant: true },
    });
    if (!provisioned) {
      send(res, 403, {
        code: "USER_NOT_PROVISIONED",
        message: "This email is not provisioned for the Pilot workspace.",
      });
      return true;
    }
    if (provisioned.status !== "active") {
      send(res, 403, {
        code: "USER_DISABLED",
        message: "This workspace user is disabled.",
      });
      return true;
    }
    const client = requestClient(req, env);
    const created = await sessionStore.create({
      tenantId,
      userId: provisioned.id,
      userAgent: client.userAgent,
      ipAddress: client.ipAddress,
    });
    send(res, 200, signedInPayload({ created, user: provisioned, tenant: provisioned.tenant, localSessionSecret }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    if (identity.authenticated && identity.source === "local_signed_session") {
      await sessionStore.revoke(identity.sessionId, { reason: "logout", actorId: identity.userId });
    }
    send(res, 200, { status: "signed_out" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    if (!identity.authenticated || identity.source !== "local_signed_session") {
      send(res, 401, {
        code: "INVALID_SESSION",
        error: "invalid or expired workspace session token",
      });
      return true;
    }
    send(res, 200, {
      id: identity.userId,
      name: identity.name,
      email: identity.email,
      role: identity.role,
      tenantId: identity.tenantId,
      expiresAt: identity.expiresAt,
    });
    return true;
  }

  return false;
}
