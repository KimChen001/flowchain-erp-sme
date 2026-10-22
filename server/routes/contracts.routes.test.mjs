import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { AuthorizationError } from "../auth/authorization-service.mjs";
import { ContractError } from "../domain/contract-policy.mjs";
import { CONTRACT_REQUEST_MAX_BYTES, CONTRACT_UPLOAD_MAX_REQUEST_BYTES, handleContractsRoute, readBoundedJson } from "./contracts.routes.mjs";

// The contract routes: capability and sign-in gates, dispatch to the read and
// command services, the bounded body reader and the error codes.

const ON = { FLOWCHAIN_ENABLE_CONTRACTS: "true" };

function request(method, path, body, headers = {}) {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(raw ? { "content-length": String(Buffer.byteLength(raw)) } : {}), ...headers };
  return req;
}

async function call(method, path, { body, headers, env = ON, identity = { authenticated: true, tenantId: "tenant-c", userId: "user-c" }, reads = {}, commands = {} } = {}) {
  const sent = [];
  const ctx = {
    req: request(method, path, body, headers),
    res: {},
    url: new URL(`http://local${path}`),
    identity,
    env,
    contractReadService: reads,
    contractCommandService: commands,
    send: (_res, status, payload) => sent.push({ status, payload }),
  };
  const handled = await handleContractsRoute(ctx);
  return { handled, ...sent[0] };
}

test("other paths are not contract routes", async () => {
  for (const path of ["/api/contract", "/api/contractsx", "/api/master-data/suppliers"]) assert.equal((await call("GET", path)).handled, false, path);
});

test("signed out is 401; with the capability off every route is 409 CONTRACTS_CAPABILITY_NOT_AVAILABLE", async () => {
  const anonymous = await call("GET", "/api/contracts", { identity: { authenticated: false } });
  assert.deepEqual([anonymous.handled, anonymous.status, anonymous.payload.code], [true, 401, "AUTHENTICATION_REQUIRED"]);
  for (const [method, path] of [["GET", "/api/contracts"], ["POST", "/api/contracts"], ["GET", "/api/contracts/C-1"], ["POST", "/api/contracts/C-1/activate"], ["DELETE", "/api/contracts/C-1/attachments/A-1"]]) {
    for (const env of [{}, { FLOWCHAIN_ENABLE_CONTRACTS: "false" }]) {
      const result = await call(method, path, { env, reads: { list: () => assert.fail("must not read") } });
      assert.deepEqual([result.status, result.payload.code, result.payload.capability], [409, "CONTRACTS_CAPABILITY_NOT_AVAILABLE", "contracts"], `${method} ${path}`);
    }
  }
});

test("each route reaches its service with the id, body and status", async () => {
  const calls = [];
  const record = (name, status = {}) => async (...args) => { calls.push([name, ...args.slice(0, -1)]); return { name, ...status }; };
  const reads = { list: record("list"), get: record("get") };
  const commands = {
    createContract: record("create"), updateContract: record("update"), deleteDraft: record("delete"), activateContract: record("activate"),
    terminateContract: record("terminate"), renewContract: record("renew"), addFile: record("addFile"), removeFile: record("removeFile"),
  };
  const run = (method, path, body, headers) => call(method, path, { body, headers, reads, commands });
  assert.equal((await run("GET", "/api/contracts?search=acme&state=ending,notice_due&page=2")).status, 200);
  assert.deepEqual(calls.at(-1), ["list", { search: "acme", state: "ending,notice_due", page: "2" }]);
  assert.equal((await run("POST", "/api/contracts", { title: "T" }, { "idempotency-key": "key-1" })).status, 201);
  assert.deepEqual(calls.at(-1), ["create", { title: "T", idempotencyKey: "key-1" }]);
  assert.equal((await run("GET", "/api/contracts/C%2F1")).status, 200);
  assert.deepEqual(calls.at(-1), ["get", "C/1"]);
  assert.equal((await run("PATCH", "/api/contracts/C-1", { notes: "n", expectedVersion: 2 })).status, 200);
  assert.deepEqual(calls.at(-1), ["update", "C-1", { notes: "n", expectedVersion: 2 }]);
  assert.equal((await run("DELETE", "/api/contracts/C-1?expectedVersion=3")).status, 200);
  assert.deepEqual(calls.at(-1), ["delete", "C-1", { expectedVersion: "3" }]);
  assert.equal((await run("POST", "/api/contracts/C-1/activate", { expectedVersion: 1, signedOn: "2026-10-01" })).status, 200);
  assert.deepEqual(calls.at(-1), ["activate", "C-1", { expectedVersion: 1, signedOn: "2026-10-01" }]);
  assert.equal((await run("POST", "/api/contracts/C-1/terminate", { expectedVersion: 2, terminatedOn: "2026-10-09", reason: "Supplier closed" })).status, 200);
  assert.equal(calls.at(-1)[0], "terminate");
  assert.equal((await run("POST", "/api/contracts/C-1/renew", { expectedVersion: 2 })).status, 201);
  assert.deepEqual(calls.at(-1), ["renew", "C-1", { expectedVersion: 2 }]);
  assert.equal((await run("POST", "/api/contracts/C-1/attachments", { uploadId: "U-1", expectedVersion: 2 })).status, 201);
  assert.deepEqual(calls.at(-1), ["addFile", "C-1", { uploadId: "U-1", expectedVersion: 2 }]);
  assert.equal((await run("DELETE", "/api/contracts/C-1/attachments/A-1", { expectedVersion: 3 })).status, 200);
  assert.deepEqual(calls.at(-1), ["removeFile", "C-1", "A-1", { expectedVersion: 3 }]);
  for (const [method, path] of [["PUT", "/api/contracts"], ["GET", "/api/contracts/C-1/activate"], ["POST", "/api/contracts/C-1/approve"], ["POST", "/api/contracts/C-1/attachments/A-1"], ["GET", "/api/contracts/C-1/x/y/z"]]) {
    const result = await run(method, path);
    assert.deepEqual([result.status, result.payload.code], [404, "CONTRACT_ROUTE_NOT_FOUND"], `${method} ${path}`);
  }
});

test("the body is read with a limit: too large is 413, not JSON is 400", async () => {
  const commands = { createContract: async () => assert.fail("must not run") };
  const declared = await call("POST", "/api/contracts", { body: { title: "T" }, headers: { "content-length": String(CONTRACT_REQUEST_MAX_BYTES + 1) }, commands });
  assert.deepEqual([declared.status, declared.payload.code, declared.payload.limitBytes], [413, "CONTRACT_REQUEST_TOO_LARGE", CONTRACT_REQUEST_MAX_BYTES]);
  // A body longer than it says is stopped while it is read.
  const streamed = await call("POST", "/api/contracts", { body: { notes: "x".repeat(CONTRACT_REQUEST_MAX_BYTES) }, headers: { "content-length": "10" }, commands });
  assert.deepEqual([streamed.status, streamed.payload.code], [413, "CONTRACT_REQUEST_TOO_LARGE"]);
  for (const body of ["{not json", "[1,2]", "null"]) {
    const invalid = await call("POST", "/api/contracts", { body, commands });
    assert.deepEqual([invalid.status, invalid.payload.code], [400, "CONTRACT_REQUEST_JSON_INVALID"], body);
  }
  // The upload limit fits a 20 MB file in base64 with room for the JSON around it.
  assert.ok(CONTRACT_UPLOAD_MAX_REQUEST_BYTES >= Math.ceil((20 * 1024 * 1024) / 3) * 4 + 1024);
  assert.ok(CONTRACT_UPLOAD_MAX_REQUEST_BYTES < 30 * 1024 * 1024);
  const req = request("POST", "/", { a: 1 });
  assert.deepEqual(await readBoundedJson(req, 100), { a: 1 });
  // A second read returns the parsed body.
  assert.deepEqual(await readBoundedJson(req, 100), { a: 1 });
});

test("errors keep their codes: validation 422, conflict 409 with versions, permission 403, transaction conflict 409", async () => {
  const fail = (error) => ({ createContract: async () => { throw error; }, updateContract: async () => { throw error; } });
  const validation = await call("POST", "/api/contracts", { body: {}, commands: fail(new ContractError("VALIDATION_ERROR", "Check the highlighted fields.", 422, [{ field: "title", code: "REQUIRED" }])) });
  assert.deepEqual([validation.status, validation.payload.code, validation.payload.details], [422, "VALIDATION_ERROR", [{ field: "title", code: "REQUIRED" }]]);
  const conflict = await call("PATCH", "/api/contracts/C-1", { body: { expectedVersion: 1 }, commands: fail(new ContractError("VERSION_CONFLICT", "Changed.", 409, [], { entityId: "C-1", expectedVersion: 1, currentVersion: 2 })) });
  assert.deepEqual([conflict.status, conflict.payload.code, conflict.payload.expectedVersion, conflict.payload.currentVersion], [409, "VERSION_CONFLICT", 1, 2]);
  const denied = await call("POST", "/api/contracts", { body: {}, commands: fail(new AuthorizationError({ reasonCode: "AUTHORIZATION_PERMISSION_DENIED", permissionCode: "contracts.contract.manage" })) });
  assert.deepEqual([denied.status, denied.payload.code, denied.payload.permission], [403, "AUTHORIZATION_PERMISSION_DENIED", "contracts.contract.manage"]);
  const raced = await call("POST", "/api/contracts", { body: {}, commands: fail(Object.assign(new Error("could not serialize"), { code: "P2034" })) });
  assert.deepEqual([raced.status, raced.payload.code], [409, "TRANSACTION_CONFLICT"]);
  const reported = [];
  const unexpected = { req: request("POST", "/api/contracts", {}), res: {}, url: new URL("http://local/api/contracts"), identity: { authenticated: true }, env: ON, contractCommandService: fail(new Error("boom")), reportError: (error) => reported.push(error.message), send: (_res, status, payload) => reported.push([status, payload.code]) };
  await handleContractsRoute(unexpected);
  assert.deepEqual(reported, ["boom", [500, "CONTRACT_REQUEST_FAILED"]]);
});
