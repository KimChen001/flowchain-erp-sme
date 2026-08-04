import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import {
  PRODUCTION_CONFIG_ERROR,
  validateProductionRuntimeConfig,
} from "../config/production-runtime-config.mjs";
import { createScmServer } from "../bootstrap/scm-server.mjs";
import { createServerLifecycle, registerShutdownSignals } from "../bootstrap/server-lifecycle.mjs";
import { createLocalSessionSecret } from "./local-signed-session.mjs";
import { buildLivenessPayload, checkRuntimeReadiness, RUNTIME_NOT_READY } from "./runtime-readiness.mjs";

const validProductionEnv = (overrides = {}) => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://runtime-user:runtime-password@database.invalid/flowchain",
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_DEFAULT_TENANT_ID: "tenant-production-runtime",
  FLOWCHAIN_LOCAL_SESSION_SECRET: "production-session-secret-at-least-32-characters",
  FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
  FLOWCHAIN_UPLOAD_STORAGE_DIR: resolve(".production-runtime-attachments"),
  FLOWCHAIN_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  FLOWCHAIN_BRANCH: "chore/production-deployment-foundation",
  ...overrides,
});

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, payload: await response.json() };
}

test("production runtime configuration is centralized, fail-fast, and redacted", () => {
  const serverSource = readFileSync(resolve(import.meta.dirname, "../bootstrap/scm-server.mjs"), "utf8");
  assert.ok(serverSource.indexOf("validateProductionRuntimeConfig(process.env)") < serverSource.indexOf("return http.createServer"));
  const valid = validateProductionRuntimeConfig(validProductionEnv());
  assert.equal(valid.validated, true);
  assert.equal(valid.persistenceMode, "database");

  const secret = "must-not-appear-in-errors";
  assert.throws(
    () => validateProductionRuntimeConfig(validProductionEnv({
      DATABASE_URL: "",
      FLOWCHAIN_LOCAL_SESSION_SECRET: secret,
      FLOWCHAIN_UPLOAD_STORAGE_DIR: "",
      FLOWCHAIN_COMMIT_SHA: "",
    })),
    (error) => {
      assert.equal(error.code, PRODUCTION_CONFIG_ERROR);
      assert.deepEqual(error.issues.map((entry) => entry.key), [
        "DATABASE_URL",
        "FLOWCHAIN_LOCAL_SESSION_SECRET",
        "FLOWCHAIN_COMMIT_SHA",
        "FLOWCHAIN_UPLOAD_STORAGE_DIR",
      ]);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error.issues), /postgresql:\/\//i);
      return true;
    },
  );
});

test("production lifecycle composes with the decomposed server runtime", () => {
  const serverSource = readFileSync(resolve(import.meta.dirname, "../bootstrap/scm-server.mjs"), "utf8");
  const handlerSource = readFileSync(resolve(import.meta.dirname, "../bootstrap/http-request-handler.mjs"), "utf8");
  const runtimeRoutesSource = readFileSync(resolve(import.meta.dirname, "../bootstrap/runtime-routes.mjs"), "utf8");
  const lifecycleSource = readFileSync(resolve(import.meta.dirname, "../bootstrap/server-lifecycle.mjs"), "utf8");
  const compositionBlock = serverSource.slice(
    serverSource.indexOf("export function createScmServer"),
    serverSource.indexOf("export function startScmServer"),
  );
  const startBlock = serverSource.slice(serverSource.indexOf("export function startScmServer"));

  assert.match(compositionBlock, /validateProductionRuntimeConfig\(process\.env\)/);
  assert.match(compositionBlock, /createHttpRequestHandler\(\{/);
  assert.match(compositionBlock, /readinessCheck,/);
  assert.doesNotMatch(compositionBlock, /url\.pathname|resolveRequestIdentity|sendStaticAsset|sendInternalServerError/);
  assert.match(runtimeRoutesSource, /url\.pathname === "\/api\/health"/);
  assert.match(runtimeRoutesSource, /buildLivenessPayload/);
  assert.match(runtimeRoutesSource, /url\.pathname === "\/api\/ready"/);
  assert.match(runtimeRoutesSource, /readinessCheck\(\{ env \}\)/);
  assert.ok(handlerSource.indexOf("handleRuntimeRoutes({") < handlerSource.indexOf("createRepositoryRegistry({"));
  assert.ok(handlerSource.indexOf("handleRuntimeRoutes({") < handlerSource.indexOf("resolveRequestIdentity("));
  assert.match(startBlock, /createServerLifecycle\(\{/);
  assert.match(startBlock, /registerShutdownSignals\(\{/);
  assert.doesNotMatch(startBlock, /closeAllConnections|disconnectPrismaClient|signalTarget\.once/);
  assert.match(lifecycleSource, /closeAllConnections/);
  assert.match(lifecycleSource, /disconnectPrismaClient/);
  assert.match(lifecycleSource, /signalTarget\.once/);
});

test("Mobile Sync secrets are required only when the capability is enabled", () => {
  assert.doesNotThrow(() => validateProductionRuntimeConfig(validProductionEnv({ FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false" })));
  assert.throws(
    () => validateProductionRuntimeConfig(validProductionEnv({ FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "true" })),
    (error) => error.issues.some((entry) => entry.key === "FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET"),
  );
  assert.doesNotThrow(() => validateProductionRuntimeConfig(validProductionEnv({
    FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "true",
    FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID: "runtime-current",
    FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET: "runtime-mobile-sync-secret-at-least-32-characters",
  })));
});

test("production local session secret never falls back to a random value", () => {
  assert.throws(
    () => createLocalSessionSecret({ NODE_ENV: "production" }),
    { code: "FLOWCHAIN_LOCAL_SESSION_SECRET_REQUIRED" },
  );
  assert.equal(createLocalSessionSecret(validProductionEnv()), validProductionEnv().FLOWCHAIN_LOCAL_SESSION_SECRET);
  assert.ok(createLocalSessionSecret({ NODE_ENV: "test" }).length >= 32);
});

test("liveness is safe build/runtime identity without database diagnostics", () => {
  const payload = buildLivenessPayload({ env: validProductionEnv() });
  assert.equal(payload.ok, true);
  assert.equal(payload.live, true);
  assert.equal(payload.authority, "postgresql");
  assert.equal(payload.commitSha, validProductionEnv().FLOWCHAIN_COMMIT_SHA);
  assert.equal(payload.branch, validProductionEnv().FLOWCHAIN_BRANCH);
  assert.deepEqual(payload.runtime, { nodeVersion: process.version });
  assert.doesNotMatch(JSON.stringify(payload), /runtime-password|DATABASE_URL|UPLOAD_STORAGE_DIR|session-secret/i);
});

test("readiness verifies database tenant attachment and returns only redacted states", async () => {
  const env = { ...validProductionEnv(), NODE_ENV: "test" };
  const healthy = await checkRuntimeReadiness({
    env,
    prismaFactory: async () => ({
      $queryRawUnsafe: async () => [{ ok: 1 }],
      tenant: { findUnique: async () => ({ id: env.FLOWCHAIN_DEFAULT_TENANT_ID }) },
    }),
    attachmentStorageFactory: () => ({ healthCheck: async () => ({ status: "healthy", writable: true, root: "secret-path" }) }),
  });
  assert.equal(healthy.status, 200);
  assert.equal(healthy.payload.ready, true);
  assert.deepEqual(healthy.payload.checks, {
    configuration: "ready",
    database: "ready",
    tenant: "ready",
    attachmentStorage: "ready",
  });

  const unavailable = await checkRuntimeReadiness({
    env,
    prismaFactory: async () => { throw new Error("postgresql://user:password@secret-host/db"); },
    attachmentStorageFactory: () => ({ healthCheck: async () => { throw new Error("C:/secret/attachment/path"); } }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.payload.code, RUNTIME_NOT_READY);
  assert.deepEqual(unavailable.payload.checks, {
    configuration: "ready",
    database: "not_ready",
    tenant: "not_ready",
    attachmentStorage: "not_ready",
  });
  assert.doesNotMatch(JSON.stringify(unavailable.payload), /secret-host|password|attachment\/path|postgresql:\/\//i);
});

test("health and readiness are unauthenticated server routes", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: "tenant-health-route",
  });
  const server = createScmServer({
    readinessCheck: async () => ({ status: 503, payload: { ready: false, code: RUNTIME_NOT_READY, checks: { database: "not_ready" } } }),
  });
  try {
    const port = await listen(server);
    const health = await getJson(port, "/api/health");
    const ready = await getJson(port, "/api/ready");
    assert.equal(health.status, 200);
    assert.equal(health.payload.live, true);
    assert.equal(ready.status, 503);
    assert.equal(ready.payload.code, RUNTIME_NOT_READY);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("graceful shutdown is idempotent, drains HTTP, disconnects Prisma, and unregisters signals", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await listen(server);
  let disconnects = 0;
  const lifecycle = createServerLifecycle({ server, disconnect: async () => { disconnects += 1; }, logger: null, shutdownTimeoutMs: 1_000 });
  const first = lifecycle.shutdown("test");
  const second = lifecycle.shutdown("duplicate");
  assert.equal(first, second);
  await first;
  assert.equal(server.listening, false);
  assert.equal(disconnects, 1);

  const signalTarget = new EventEmitter();
  let signalled = 0;
  const remove = registerShutdownSignals({ lifecycle: { shutdown: async () => { signalled += 1; } }, signalTarget, logger: null });
  signalTarget.emit("SIGTERM");
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(signalled, 1);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  remove();
});

test("graceful shutdown still disconnects Prisma when HTTP close reports an error", async () => {
  let disconnects = 0;
  const server = {
    listening: true,
    close(callback) { callback(new Error("close_failed")); },
    closeIdleConnections() {},
    closeAllConnections() {},
  };
  const lifecycle = createServerLifecycle({
    server,
    disconnect: async () => { disconnects += 1; },
    logger: null,
    shutdownTimeoutMs: 50,
  });
  await assert.rejects(() => lifecycle.shutdown("close-error"), /close_failed/);
  assert.equal(disconnects, 1);
});
