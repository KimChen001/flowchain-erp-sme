import assert from "node:assert/strict";
import test from "node:test";
import { handleCustomFieldsRoute } from "./custom-fields.routes.mjs";

const permissions = new Set(["custom_field.read", "custom_field.manage", "custom_field.publish"]);
const actor = {
  complete: true,
  authenticated: true,
  tenantId: "tenant-a",
  user: { id: "user-a" },
  roleIds: [],
  permissionSourceRoleIds: new Map([...permissions].map(code => [code, ["admin"]])),
  permissionCodes: permissions,
  readWarehouseIds: new Set(),
  operateWarehouseIds: new Set(),
};

function context({ method = "GET", path = "/api/custom-fields", body = {}, authenticated = true, service } = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      req: { method, headers: {} },
      res: {},
      url: new URL(`http://local${path}`),
      send: (_res, status, payload) => sent.push({ status, payload }),
      identity: authenticated ? { authenticated: true } : null,
      env: { FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE: "true", NODE_ENV: "test" },
      intakePrisma: {},
      intakeActor: actor,
      intakeReadBody: async () => body,
      customFieldService: service || { list: async () => ({ customFields: [] }) },
    },
  };
}

test("Custom Field API requires authentication and capability", async () => {
  const anonymous = context({ authenticated: false });
  await handleCustomFieldsRoute(anonymous.ctx);
  assert.equal(anonymous.sent[0].status, 401);
  const disabled = context();
  disabled.ctx.env.FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE = "false";
  await handleCustomFieldsRoute(disabled.ctx);
  assert.equal(disabled.sent[0].status, 503);
  assert.equal(disabled.sent[0].payload.code, "FLOWCHAIN_CAPABILITY_DISABLED");
});

test("Custom Field API dispatches tenant-scoped list, create, publish, revise, and retire actions", async () => {
  const calls = [];
  const service = {
    list: async () => ({ customFields: [] }),
    create: async input => (calls.push(["create", input]), { id: "field-1" }),
    revise: async (id, input) => (calls.push(["revise", id, input]), { id }),
    publish: async (id, input) => (calls.push(["publish", id, input]), { id, status: "published" }),
    retire: async id => (calls.push(["retire", id]), { id, status: "retired" }),
  };
  for (const [path, body, expected] of [
    ["/api/custom-fields", { fieldKey: "grade" }, 201],
    ["/api/custom-fields/field-1/revisions", { label: "Grade 2" }, 201],
    ["/api/custom-fields/field-1/publish", {}, 200],
    ["/api/custom-fields/field-1/retire", {}, 200],
  ]) {
    const request = context({ method: "POST", path, body, service });
    await handleCustomFieldsRoute(request.ctx);
    assert.equal(request.sent[0].status, expected);
  }
  assert.deepEqual(calls.map(value => value[0]), ["create", "revise", "publish", "retire"]);
});

test("Custom Field API sanitizes unexpected failures", async () => {
  const request = context({ service: { list: async () => { throw new Error("database secret"); } } });
  await handleCustomFieldsRoute(request.ctx);
  assert.deepEqual(request.sent[0], { status: 500, payload: { code: "CUSTOM_FIELD_REQUEST_FAILED", message: "The custom field request could not be completed." } });
});
