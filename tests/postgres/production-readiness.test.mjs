import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";
import { checkRuntimeReadiness, RUNTIME_NOT_READY } from "../../server/domain/runtime-readiness.mjs";

test("production readiness checks a real PostgreSQL connection and tenant", async () => {
  const tenantId = `tenant-production-readiness-${randomUUID()}`;
  const prisma = await createPrismaClient(process.env);
  const env = {
    ...process.env,
    NODE_ENV: "production",
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_LOCAL_SESSION_SECRET: "postgres-readiness-session-secret-at-least-32-characters",
    FLOWCHAIN_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    FLOWCHAIN_BRANCH: "ci/production-readiness",
  };

  try {
    await prisma.tenant.create({ data: { id: tenantId, name: "Production Readiness Integration" } });
    const ready = await checkRuntimeReadiness({ env, prismaFactory: async () => prisma });
    assert.equal(ready.status, 200);
    assert.equal(ready.payload.ready, true);
    assert.deepEqual(ready.payload.checks, {
      configuration: "ready",
      database: "ready",
      tenant: "ready",
      attachmentStorage: "ready",
    });

    const missingTenant = await checkRuntimeReadiness({
      env: { ...env, FLOWCHAIN_DEFAULT_TENANT_ID: `${tenantId}-missing` },
      prismaFactory: async () => prisma,
    });
    assert.equal(missingTenant.status, 503);
    assert.equal(missingTenant.payload.code, RUNTIME_NOT_READY);
    assert.equal(missingTenant.payload.checks.database, "ready");
    assert.equal(missingTenant.payload.checks.tenant, "not_ready");
  } finally {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }
});
