import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { localDevelopmentEnabled } from "../domain/local-development-contract.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { send } from "../utils/http.mjs";

export async function handleRuntimeRoutes({
  req,
  res,
  url,
  env,
  buildIdentity,
  dataMode,
  persistenceMode,
}) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, {
      ok: true,
      service: "flowchain-scm-api",
      ...buildIdentity,
      dataMode: dataMode.mode,
      readsDemoData: dataMode.readsDemoData,
      persistenceMode,
      authority: "postgresql",
      timestamp: new Date().toISOString(),
    });
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

  return false;
}
