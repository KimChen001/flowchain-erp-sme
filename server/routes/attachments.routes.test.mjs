import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { handleAttachmentRoute } from "./attachments.routes.mjs";

function context(method, path, service, body = {}, options = {}) {
  const sent = [], response = {
    headers: null,
    bytes: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(bytes) { this.bytes = bytes; },
  };
  return {
    sent,
    response,
    value: {
      req: { method },
      res: response,
      url: new URL(`http://local${path}`),
      identity: options.identity ?? { authenticated: true, tenantId: "tenant", userId: "user" },
      env: options.env ?? { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "true" },
      attachmentPrisma: {},
      attachmentService: service,
      readBody: async () => body,
      send: (_res, status, payload) => sent.push({ status, payload }),
    },
  };
}

test("attachment routes dispatch staged upload, evidence binding, status, and deletion", async () => {
  const calls = [];
  const service = {
    stageUpload: async (body) => (calls.push(["stage", body]), { uploadId: "upload-1" }),
    status: async (id) => (calls.push(["status", id]), { uploadId: id, status: "staged" }),
    bindSettlement: async (id, body) => (calls.push(["settlement", id, body]), { attachmentId: "settlement-attachment" }),
    bindReceiving: async (id, body) => (calls.push(["receiving", id, body]), { attachmentId: "receiving-attachment" }),
    deleteAttachment: async (id) => (calls.push(["delete", id]), { attachmentId: id, status: "deleted" }),
  };
  const stage = context("POST", "/api/uploads/stage", service, { fileName: "proof.txt" });
  assert.equal(await handleAttachmentRoute(stage.value), true);
  assert.equal(stage.sent[0].status, 201);
  const status = context("GET", "/api/uploads/upload-1/status", service);
  await handleAttachmentRoute(status.value);
  assert.equal(status.sent[0].payload.status, "staged");
  const settlement = context("POST", "/api/finance/settlements/SET%2F1/attachments", service, { uploadId: "upload-1" });
  await handleAttachmentRoute(settlement.value);
  assert.deepEqual(calls.at(-1), ["settlement", "SET/1", { uploadId: "upload-1" }]);
  const receiving = context("POST", "/api/receiving/drafts/GRN-1/attachments", service, { uploadId: "upload-2" });
  await handleAttachmentRoute(receiving.value);
  assert.deepEqual(calls.at(-1), ["receiving", "GRN-1", { uploadId: "upload-2" }]);
  const remove = context("DELETE", "/api/attachments/attachment-1", service);
  await handleAttachmentRoute(remove.value);
  assert.equal(remove.sent[0].payload.status, "deleted");
});

test("attachment download is a controlled no-store stream", async () => {
  const bytes = Buffer.from("evidence");
  const service = { download: async () => ({ bytes, fileName: "payment proof.txt", mimeType: "text/plain", sha256: "a".repeat(64) }) };
  const value = context("GET", "/api/attachments/attachment-1/download", service);
  await handleAttachmentRoute(value.value);
  assert.equal(value.response.status, 200);
  assert.equal(value.response.headers["cache-control"], "private, no-store");
  assert.equal(value.response.headers["x-content-sha256"], "a".repeat(64));
  assert.match(value.response.headers["content-disposition"], /payment%20proof\.txt/);
  assert.deepEqual(value.response.bytes, bytes);
});

test("attachment boundary ignores unrelated routes and fails closed for auth or capability", async () => {
  const unrelated = context("GET", "/api/finance/settlements", {});
  assert.equal(await handleAttachmentRoute(unrelated.value), false);
  const anonymous = context("POST", "/api/uploads/stage", {}, {}, { identity: { authenticated: false } });
  assert.equal(await handleAttachmentRoute(anonymous.value), true);
  assert.equal(anonymous.sent[0].status, 401);
  const disabled = context("POST", "/api/uploads/stage", {}, {}, { env: { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "false", FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "false" } });
  await handleAttachmentRoute(disabled.value);
  assert.equal(disabled.sent[0].status, 409);
  assert.equal(disabled.sent[0].payload.code, "ATTACHMENT_CAPABILITY_NOT_AVAILABLE");
});

// Contract files (docs/contracts-module-design.md §6) need only the contracts
// capability: staging with purpose "contract" and downloading open with it,
// and the rest stays behind mobile operations or the settlement workflow.
const CONTRACTS_ONLY = { FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_CONTRACTS: "true" };
function streamed(method, path, service, body, env) {
  const value = context(method, path, service, body, { env });
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = method;
  req.headers = { "content-length": String(Buffer.byteLength(raw)) };
  value.value.req = req;
  value.value.readBody = async () => assert.fail("a staged contract file is read with the bounded reader");
  return value;
}

test("with only contracts on, a contract file stages and downloads; other evidence stays closed", async () => {
  const calls = [];
  const service = {
    stageUpload: async (body) => (calls.push(["stage", body.purpose]), { uploadId: "upload-c" }),
    download: async (id, _ctx, options) => (calls.push(["download", id, options]), { bytes: Buffer.from("pdf"), fileName: "signed.pdf", mimeType: "application/pdf", sha256: "b".repeat(64) }),
    status: async () => assert.fail("status needs mobile operations"),
  };
  const stage = streamed("POST", "/api/uploads/stage", service, { purpose: "contract", fileName: "signed.pdf", mimeType: "application/pdf", contentBase64: "cGRm" }, CONTRACTS_ONLY);
  assert.equal(await handleAttachmentRoute(stage.value), true);
  assert.equal(stage.sent[0].status, 201);
  assert.deepEqual(calls.at(-1), ["stage", "contract"]);
  const evidence = streamed("POST", "/api/uploads/stage", service, { fileName: "proof.txt", mimeType: "text/plain", contentBase64: "eA==" }, CONTRACTS_ONLY);
  await handleAttachmentRoute(evidence.value);
  assert.deepEqual([evidence.sent[0].status, evidence.sent[0].payload.code], [409, "ATTACHMENT_CAPABILITY_NOT_AVAILABLE"]);
  const download = context("GET", "/api/attachments/attachment-c/download", service, {}, { env: CONTRACTS_ONLY });
  await handleAttachmentRoute(download.value);
  assert.equal(download.response.status, 200);
  assert.deepEqual(calls.at(-1), ["download", "attachment-c", { legacyEnabled: false, contractsEnabled: true }]);
  for (const [method, path] of [["GET", "/api/uploads/upload-c/status"], ["POST", "/api/receiving/drafts/GRN-1/attachments"], ["POST", "/api/finance/settlements/SET-1/attachments"], ["DELETE", "/api/attachments/attachment-1"]]) {
    const closed = context(method, path, service, {}, { env: CONTRACTS_ONLY });
    await handleAttachmentRoute(closed.value);
    assert.deepEqual([closed.sent[0].status, closed.sent[0].payload.code], [409, "ATTACHMENT_CAPABILITY_NOT_AVAILABLE"], `${method} ${path}`);
  }
});

test("a contract file needs contracts on, even when mobile operations are on", async () => {
  const service = { stageUpload: async () => assert.fail("must not stage") };
  const value = context("POST", "/api/uploads/stage", service, { purpose: "contract", fileName: "signed.pdf", mimeType: "application/pdf" });
  await handleAttachmentRoute(value.value);
  assert.deepEqual([value.sent[0].status, value.sent[0].payload.code], [409, "ATTACHMENT_CAPABILITY_NOT_AVAILABLE"]);
  // With both on, receiving and settlement evidence stage as before, and
  // downloads look up every kind.
  const both = { ...CONTRACTS_ONLY, FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "true" };
  const calls = [];
  const open = { stageUpload: async (body) => (calls.push(body.purpose ?? null), { uploadId: "u" }), download: async (_id, _ctx, options) => (calls.push(options), { bytes: Buffer.from("x"), fileName: "x.txt", mimeType: "text/plain", sha256: "c".repeat(64) }) };
  const evidence = streamed("POST", "/api/uploads/stage", open, { fileName: "proof.txt", mimeType: "text/plain", contentBase64: "eA==" }, both);
  await handleAttachmentRoute(evidence.value);
  assert.equal(evidence.sent[0].status, 201);
  const download = context("GET", "/api/attachments/a/download", open, {}, { env: both });
  await handleAttachmentRoute(download.value);
  assert.deepEqual(calls, [null, { legacyEnabled: true, contractsEnabled: true }]);
});

test("a staged upload larger than a 20 MB file in base64 is refused before it is read", async () => {
  const value = context("POST", "/api/uploads/stage", { stageUpload: async () => assert.fail("must not stage") }, {}, { env: CONTRACTS_ONLY });
  const req = Readable.from([]);
  req.method = "POST";
  req.headers = { "content-length": String(30 * 1024 * 1024) };
  value.value.req = req;
  await handleAttachmentRoute(value.value);
  assert.deepEqual([value.sent[0].status, value.sent[0].payload.code], [413, "CONTRACT_REQUEST_TOO_LARGE"]);
});

test("contract file routes belong to the contract routes", async () => {
  for (const path of ["/api/contracts/C-1/attachments", "/api/contracts/C-1/attachments/A-1"]) {
    assert.equal(await handleAttachmentRoute(context("POST", path, {}, {}, { env: CONTRACTS_ONLY }).value), false, path);
  }
});
