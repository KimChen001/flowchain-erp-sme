import assert from "node:assert/strict";
import test from "node:test";
import { handleIntakeRoute } from "./intake.routes.mjs";

const allPermissions = new Set([
  "intake.artifact.create", "intake.artifact.read", "intake.batch.create", "intake.batch.read",
  "intake.batch.cancel", "intake.mapping.manage", "intake.review", "intake.commit",
]);

function actor(permissions = allPermissions, tenantId = "tenant-a") {
  return {
    complete: true,
    authenticated: true,
    tenantId,
    user: { id: "user-a" },
    roleIds: [],
    permissionSourceRoleIds: new Map([...permissions].map(code => [code, ["role-a"]])),
    permissionCodes: permissions,
    readWarehouseIds: new Set(),
    operateWarehouseIds: new Set(),
  };
}

function context({ method = "GET", path = "/api/intake/artifacts", permissions = allPermissions, authenticated = true, body = {}, services, structured } = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      req: { method, headers: {} },
      res: {},
      url: new URL(`http://local${path}`),
      send: (_res, status, payload) => sent.push({ status, payload }),
      identity: authenticated ? { authenticated: true, tenantId: "tenant-a", userId: "user-a" } : null,
      env: { FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true", NODE_ENV: "test" },
      intakeActor: actor(permissions),
      intakeReadBody: async () => body,
      intakeServices: services || {
        artifacts: { list: async () => ({ artifacts: [], nextCursor: null }) },
        batches: {},
        mappings: {},
        issues: {},
        reviews: {},
        commits: {},
      },
      structuredIntakeService: structured,
    },
  };
}

test("intake API requires authentication before preview capability access", async () => {
  const { ctx, sent } = context({ authenticated: false });
  assert.equal(await handleIntakeRoute(ctx), true);
  assert.deepEqual(sent[0], { status: 401, payload: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } });
});

test("intake API requires explicit preview capability enablement", async () => {
  const { ctx, sent } = context();
  ctx.env.FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE = "false";
  assert.equal(await handleIntakeRoute(ctx), true);
  assert.equal(sent[0].status, 503);
  assert.equal(sent[0].payload.code, "FLOWCHAIN_CAPABILITY_DISABLED");
  assert.equal(sent[0].payload.capability, "universal-intake");
});

test("intake API enforces permission and projects service DTOs", async () => {
  const denied = context({ permissions: new Set() });
  await handleIntakeRoute(denied.ctx);
  assert.equal(denied.sent[0].status, 403);
  assert.equal(denied.sent[0].payload.code, "AUTHORIZATION_PERMISSION_DENIED");

  const allowed = context();
  await handleIntakeRoute(allowed.ctx);
  assert.deepEqual(allowed.sent[0], { status: 200, payload: { artifacts: [], nextCursor: null } });
});

test("commit endpoint remains 501 after intake.commit authorization", async () => {
  const services = {
    artifacts: {}, batches: {}, mappings: {}, issues: {}, reviews: {},
    commits: { attempt: async () => ({
      code: "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED",
      message: "Governed business commit adapters are not implemented in Phase 5.4B.",
      attemptId: "attempt-1",
      status: "blocked",
      idempotentReplay: false,
    }) },
  };
  const { ctx, sent } = context({ method: "POST", path: "/api/intake/batches/batch-1/commit", body: { idempotencyKey: "key-1" }, services });
  await handleIntakeRoute(ctx);
  assert.equal(sent[0].status, 501);
  assert.equal(sent[0].payload.code, "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED");
  assert.equal(sent[0].payload.status, "blocked");
});

test("public batch creation accepts only Phase 5.4B master-data record types", async () => {
  const { ctx, sent } = context({ method: "POST", path: "/api/intake/batches", body: { artifactId: "artifact-1", batchType: "purchase_order" } });
  await handleIntakeRoute(ctx);
  assert.equal(sent[0].status, 422);
  assert.equal(sent[0].payload.code, "INTAKE_RECORD_TYPE_UNSUPPORTED");
});

test("Paste adapters dispatch to controlled structured service after both permissions", async () => {
  const structured = { paste: async (kind, body) => ({ kind, recordType: body.recordType, parserOwned: true }) };
  const { ctx, sent } = context({ method: "POST", path: "/api/intake/paste/table", body: { recordType: "supplier", content: "code\tname" }, structured });
  await handleIntakeRoute(ctx);
  assert.deepEqual(sent[0], { status: 201, payload: { kind: "table", recordType: "supplier", parserOwned: true } });
});

test("public direct IntakeRecord insertion is retired with a stable 501", async () => {
  const { ctx, sent } = context({ method: "POST", path: "/api/intake/batches/batch-1/records", body: { records: [{ name: "bypass" }] } });
  await handleIntakeRoute(ctx);
  assert.equal(sent[0].status, 501);
  assert.equal(sent[0].payload.code, "FLOWCHAIN_INTAKE_DIRECT_RECORD_INSERT_RETIRED");
  assert.match(sent[0].payload.message, /controlled parser/i);
});

test("routes never expose service errors as raw stacks or Prisma objects", async () => {
  const { ctx, sent } = context({
    services: {
      artifacts: { list: async () => { const error = new Error("database secret at C:\\private\\db"); error.code = "P9999"; throw error; } },
      batches: {}, mappings: {}, issues: {}, reviews: {}, commits: {},
    },
  });
  await handleIntakeRoute(ctx);
  assert.deepEqual(sent[0], { status: 500, payload: { code: "INTAKE_REQUEST_FAILED", message: "The Intake request could not be completed." } });
});
