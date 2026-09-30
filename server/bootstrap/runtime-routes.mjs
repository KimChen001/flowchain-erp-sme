import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { localDevelopmentEnabled } from "../domain/local-development-contract.mjs";
import {
  buildLivenessPayload,
  checkRuntimeReadiness,
} from "../domain/runtime-readiness.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { mailProviderName } from "../mail/mailer.mjs";
import { defaultOutboxPath, readOutbox } from "../mail/outbox-mailer.mjs";
import { send } from "../utils/http.mjs";

export async function handleRuntimeRoutes({
  req,
  res,
  url,
  env,
  buildIdentity,
  readinessCheck = checkRuntimeReadiness,
}) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(
      res,
      200,
      buildLivenessPayload({
        env,
        gitFallback: buildIdentity,
      }),
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ready") {
    const readiness = await readinessCheck({ env });
    send(res, readiness.status, readiness.payload);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/dev/local-status") {
    if (!localDevelopmentEnabled(env)) {
      send(res, 404, { error: "Not found" });
      return true;
    }
    const prisma = await getPrismaClient(env);
    const tenantId = String(env.FLOWCHAIN_DEFAULT_TENANT_ID || "").trim();
    const [tenant, users, demoMasterDataCount, demoScenarioCount] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { tenantId, status: "active", email: { in: ["admin@flowchain.local", "kim@example.com"] } }, select: { email: true }, orderBy: { email: "asc" } }),
      prisma.item.count({ where: { tenantId, id: { startsWith: "LOCAL-DEMO-ITEM-" } } }),
      prisma.purchaseOrder.count({ where: { tenantId, id: { startsWith: "LOCAL-DEMO-PO-" } } }),
    ]);
    send(res, 200, {
      localDevelopment: true,
      tenantId: tenant?.id || tenantId,
      workspaceName: tenant?.name || "",
      availableLoginEmails: users.map(user => user.email),
      demoMasterDataLoaded: demoMasterDataCount > 0,
      demoScenarioLoaded: demoScenarioCount > 0,
      universalIntakeEnabled: capabilityForEnvironment("universal-intake", env)?.enabled === true,
    });
    return true;
  }

  // Local development only: the latest sign-in links in the local mail
  // outbox, for the "View the sign-in link" helper on the sign-in page.
  if (req.method === "GET" && url.pathname === "/api/dev/sign-in-links") {
    if (!localDevelopmentEnabled(env)) {
      send(res, 404, { error: "Not found" });
      return true;
    }
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const messages = mailProviderName(env) === "outbox" ? await readOutbox(defaultOutboxPath(env)) : [];
    const links = messages
      .filter((message) => message.tag === "sign-in-link" && (!email || String(message.to).toLowerCase() === email))
      .reverse()
      .slice(0, 5)
      .map((message) => ({ to: message.to, createdAt: message.createdAt, url: String(message.text || "").match(/https?:\/\/\S+\/sign-in\/confirm\?token=[A-Za-z0-9_%-]+/)?.[0] || "" }))
      .filter((link) => link.url);
    send(res, 200, { links });
    return true;
  }

  return false;
}
