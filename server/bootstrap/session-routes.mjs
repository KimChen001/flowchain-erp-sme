import {
  createLocalSession,
  issueLocalSessionToken,
} from "../domain/local-signed-session.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { readBody, send } from "../utils/http.mjs";
import { roleLabel } from "../../shared/roles.mjs";

export function normalizeLogin(body) {
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const name = String(body.name || "").trim();
  const company = String(body.company || "").trim();
  if (!email || !name || !company) {
    throw new Error("company, name and email are required");
  }
  return { email, name, company };
}

export async function handleSessionRoutes({
  req,
  res,
  url,
  identity,
  localSessions,
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
      where: {
        tenantId,
        email: String(profile.email || "")
          .trim()
          .toLowerCase(),
      },
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
    profile = {
      id: provisioned.id,
      tenantId,
      name: provisioned.name,
      email: provisioned.email,
      company: provisioned.tenant.name,
      role: provisioned.role,
      version: provisioned.version,
    };
    const session = createLocalSession(profile, {
      env,
      authoritativeRole: true,
    });
    localSessions.set(session.sessionId, session);
    const token = issueLocalSessionToken(session, localSessionSecret);
    send(res, 200, {
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      user: {
        id: session.userId,
        name: session.name,
        email: session.email,
        company: session.company,
        role: session.role,
        roleLabel: roleLabel(session.role),
        tenantId: session.tenantId,
      },
    });
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
