import { createContractCommandService } from "../domain/contract-command-service.mjs";
import { ContractError, contractFail, contractsEnabled } from "../domain/contract-policy.mjs";
import { createContractReadService } from "../domain/contract-read-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { isTransactionConflict } from "../persistence/transaction-conflict.mjs";

// Contract records (docs/contracts-module-design.md, K1):
//   GET    /api/contracts                         list (search, type, state, ownerId, supplierId, sort, page, pageSize)
//   POST   /api/contracts                         create a draft
//   GET    /api/contracts/:id                     detail with files and history
//   PATCH  /api/contracts/:id                     update
//   DELETE /api/contracts/:id                     delete a draft
//   POST   /api/contracts/:id/activate            activate a draft
//   POST   /api/contracts/:id/terminate           terminate an active contract
//   POST   /api/contracts/:id/renew               start a renewal draft
//   POST   /api/contracts/:id/attachments         bind a staged upload (POST /api/uploads/stage, purpose "contract")
//   DELETE /api/contracts/:id/attachments/:attachmentId
// Files download through GET /api/attachments/:id/download. Commands take
// expectedVersion and an optional idempotencyKey (or Idempotency-Key header);
// DELETE also takes expectedVersion as a query parameter. With the contracts
// capability off every route answers 409 CONTRACTS_CAPABILITY_NOT_AVAILABLE.
// The workspace is always the session's; nothing in the body chooses it.

// The shared readBody has no size limit, so contract requests are read with
// one, as the custom field, intake and import routes do. A file is staged as
// base64, a third larger than the 20 MB it may be.
export const CONTRACT_REQUEST_MAX_BYTES = 256 * 1024;
export const CONTRACT_UPLOAD_MAX_REQUEST_BYTES = Math.ceil((20 * 1024 * 1024) / 3) * 4 + 64 * 1024;

export async function readBoundedJson(req, maximumBytes) {
  if (Object.prototype.hasOwnProperty.call(req, "__flowchainParsedBody")) return req.__flowchainParsedBody;
  const tooLarge = () => new ContractError("CONTRACT_REQUEST_TOO_LARGE", "The request is larger than the supported limit.", 413, [], { limitBytes: maximumBytes });
  if (Number(req.headers?.["content-length"] || 0) > maximumBytes) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) throw tooLarge();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ContractError("CONTRACT_REQUEST_JSON_INVALID", "The request body must be valid JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ContractError("CONTRACT_REQUEST_JSON_INVALID", "The request body must be a JSON object.", 400);
  Object.defineProperty(req, "__flowchainParsedBody", { value: parsed, enumerable: false });
  return parsed;
}

export function sendContractError(ctx, error) {
  if (error instanceof ContractError || error instanceof PilotIdentityError || error?.name === "AuthorizationError") {
    const extra = error instanceof ContractError
      ? Object.fromEntries(["entityId", "currentStatus", "currentVersion", "expectedVersion", "renewalId", "renewalNumber", "capability", "limitBytes"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]]))
      : {};
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || "CONTRACT_REQUEST_FAILED",
      message: error.message,
      details: error?.name === "AuthorizationError" ? [] : error.details || [],
      ...(error?.name === "AuthorizationError" ? { permission: error.details?.permissionCode } : {}),
      ...extra,
    });
    return;
  }
  // Serializable transactions that lose a race are retried; one that still
  // loses is safe to send again.
  if (isTransactionConflict(error)) {
    ctx.send(ctx.res, 409, { code: "TRANSACTION_CONFLICT", message: "Another change landed at the same time. Reload and try again.", details: [] });
    return;
  }
  if (error?.code === "P2002") {
    ctx.send(ctx.res, 409, { code: "CONTRACT_CONFLICT", message: "Another change landed at the same time. Reload and try again.", details: [] });
    return;
  }
  ctx.reportError?.(error);
  ctx.send(ctx.res, 500, { code: "CONTRACT_REQUEST_FAILED", message: "The contract request could not be completed." });
}

export async function handleContractsRoute(ctx) {
  const path = ctx.url.pathname;
  if (path !== "/api/contracts" && !path.startsWith("/api/contracts/")) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  const env = ctx.env || process.env;
  if (!contractsEnabled(env)) {
    ctx.send(ctx.res, 409, { code: "CONTRACTS_CAPABILITY_NOT_AVAILABLE", message: "Contracts require database persistence and explicit enablement.", capability: "contracts", details: [] });
    return true;
  }
  const method = ctx.req.method;
  const reads = () => ctx.contractReadService || createContractReadService({ prisma: ctx.contractPrisma, env });
  const commands = () => ctx.contractCommandService || createContractCommandService({ prisma: ctx.contractPrisma, env });
  const body = async () => {
    const parsed = await readBoundedJson(ctx.req, CONTRACT_REQUEST_MAX_BYTES);
    const header = String(ctx.req.headers?.["idempotency-key"] || "").trim();
    return header && !parsed.idempotencyKey ? { ...parsed, idempotencyKey: header } : parsed;
  };
  // A DELETE may carry its expected version in the query instead of a body.
  const deleteBody = async () => {
    const parsed = await body();
    const version = ctx.url.searchParams.get("expectedVersion");
    return parsed.expectedVersion === undefined && version !== null ? { ...parsed, expectedVersion: version } : parsed;
  };
  const respond = (status, payload) => { ctx.send(ctx.res, status, payload); return true; };
  try {
    if (path === "/api/contracts") {
      if (method === "GET") return respond(200, await reads().list(Object.fromEntries(ctx.url.searchParams.entries()), ctx));
      if (method === "POST") return respond(201, await commands().createContract(await body(), ctx));
      return contractFail("CONTRACT_ROUTE_NOT_FOUND", "Contract route not found.", 404);
    }
    const match = path.match(/^\/api\/contracts\/([^/]+)(?:\/(activate|terminate|renew|attachments)(?:\/([^/]+))?)?$/);
    if (!match) return contractFail("CONTRACT_ROUTE_NOT_FOUND", "Contract route not found.", 404);
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const attachmentId = match[3] ? decodeURIComponent(match[3]) : null;
    if (!action) {
      if (method === "GET") return respond(200, await reads().get(id, ctx));
      if (method === "PATCH") return respond(200, await commands().updateContract(id, await body(), ctx));
      if (method === "DELETE") return respond(200, await commands().deleteDraft(id, await deleteBody(), ctx));
    } else if (action === "attachments") {
      if (!attachmentId && method === "POST") return respond(201, await commands().addFile(id, await body(), ctx));
      if (attachmentId && method === "DELETE") return respond(200, await commands().removeFile(id, attachmentId, await deleteBody(), ctx));
    } else if (!attachmentId && method === "POST") {
      if (action === "activate") return respond(200, await commands().activateContract(id, await body(), ctx));
      if (action === "terminate") return respond(200, await commands().terminateContract(id, await body(), ctx));
      if (action === "renew") return respond(201, await commands().renewContract(id, await body(), ctx));
    }
    return contractFail("CONTRACT_ROUTE_NOT_FOUND", "Contract route not found.", 404);
  } catch (error) {
    sendContractError(ctx, error);
    return true;
  }
}
