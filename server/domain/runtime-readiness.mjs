import { validateProductionRuntimeConfig } from "../config/production-runtime-config.mjs";
import { createLocalDurableAttachmentStorage } from "./attachment-storage-provider.mjs";
import { getPersistenceMode } from "../repositories/adapter-registry.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

export const RUNTIME_NOT_READY = "FLOWCHAIN_RUNTIME_NOT_READY";
const service = "flowchain-scm-api";
const text = (value) => String(value ?? "").trim();

export function runtimeBuildIdentity(env = process.env, gitFallback = {}) {
  return {
    commitSha: text(env.FLOWCHAIN_COMMIT_SHA) || text(gitFallback.commitSha) || "unknown",
    branch: text(env.FLOWCHAIN_BRANCH) || text(gitFallback.branch) || "unknown",
    runtimeMode: text(env.NODE_ENV).toLowerCase() === "production" ? "production" : "local-dev",
  };
}

export function buildLivenessPayload({ env = process.env, gitFallback } = {}) {
  return {
    ok: true,
    live: true,
    service,
    ...runtimeBuildIdentity(env, gitFallback),
    persistenceMode: getPersistenceMode(env),
    authority: "postgresql",
    runtime: { nodeVersion: process.version },
    timestamp: new Date().toISOString(),
  };
}

export async function checkRuntimeReadiness({
  env = process.env,
  prismaFactory = getPrismaClient,
  attachmentStorageFactory = createLocalDurableAttachmentStorage,
  now = () => new Date(),
} = {}) {
  const checks = {
    configuration: "not_ready",
    database: "not_ready",
    tenant: "not_ready",
    attachmentStorage: "not_ready",
  };
  let prisma;

  try {
    validateProductionRuntimeConfig(env);
    if (getPersistenceMode(env) !== "database" || !text(env.DATABASE_URL) || !text(env.FLOWCHAIN_DEFAULT_TENANT_ID)) throw new Error("runtime_configuration_incomplete");
    checks.configuration = "ready";
  } catch {
    // Readiness deliberately reports only stable check states.
  }

  try {
    prisma = await prismaFactory(env);
    await prisma.$queryRawUnsafe("SELECT 1");
    checks.database = "ready";
  } catch {
    // ORM and connection details must never cross the readiness boundary.
  }

  if (checks.database === "ready" && text(env.FLOWCHAIN_DEFAULT_TENANT_ID)) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: text(env.FLOWCHAIN_DEFAULT_TENANT_ID) },
        select: { id: true },
      });
      if (tenant) checks.tenant = "ready";
    } catch {
      // A missing/inaccessible tenant is represented only as not_ready.
    }
  }

  try {
    const storage = attachmentStorageFactory({ env });
    const health = await storage.healthCheck();
    if (health?.status === "healthy" && health?.writable === true) checks.attachmentStorage = "ready";
  } catch {
    // Filesystem paths and provider diagnostics remain internal.
  }

  const ready = Object.values(checks).every((status) => status === "ready");
  const payload = {
    ready,
    service,
    authority: "postgresql",
    checks,
    timestamp: now().toISOString(),
  };
  if (!ready) payload.code = RUNTIME_NOT_READY;
  return { status: ready ? 200 : 503, payload };
}
