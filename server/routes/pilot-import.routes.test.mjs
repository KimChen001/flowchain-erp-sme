import assert from "node:assert/strict";
import test from "node:test";
import { handlePilotImportRoute, LEGACY_IMPORT_PIPELINE_RETIRED } from "./pilot-import.routes.mjs";

async function call(path, { method = "POST", authenticated = true } = {}) {
  let response;
  const handled = await handlePilotImportRoute({
    req: { method, headers: {} },
    res: {},
    url: new URL(path, "http://local"),
    identity: authenticated ? { authenticated: true, userId: "admin", role: "admin" } : { authenticated: false },
    send(_res, status, payload) { response = { status, payload }; },
  });
  return { handled, response };
}

test("legacy import routes require authentication and then fail closed for every method", async () => {
  const unauthenticated = await call("/api/imports/preview", { authenticated: false });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.response.payload.code, "AUTHENTICATION_REQUIRED");
  for (const [method, path] of [
    ["POST", "/api/imports/preview"],
    ["GET", "/api/imports/pilot-existing"],
    ["GET", "/api/imports/pilot-existing/issues"],
    ["POST", "/api/imports/pilot-existing/commit"],
    ["POST", "/api/imports/pilot-existing/cancel"],
    ["GET", "/api/import-batches"],
    ["GET", "/api/import-batches/legacy-existing"],
    ["POST", "/api/import-batches/legacy-existing/rollback"],
  ]) {
    const result = await call(path, { method });
    assert.equal(result.handled, true);
    assert.equal(result.response.status, 501);
    assert.deepEqual(result.response.payload, LEGACY_IMPORT_PIPELINE_RETIRED);
  }
});

test("unrelated APIs are not claimed by the legacy retirement gate", async () => {
  assert.equal((await call("/api/intake/artifacts", { method: "GET" })).handled, false);
});
