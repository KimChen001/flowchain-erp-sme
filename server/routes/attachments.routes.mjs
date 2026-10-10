import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { createAttachmentService } from "../domain/attachment-service.mjs";
import { contractsEnabled } from "../domain/contract-policy.mjs";
import { InternalSettlementError } from "../domain/internal-settlement-command-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { CONTRACT_UPLOAD_MAX_REQUEST_BYTES, readBoundedJson } from "./contracts.routes.mjs";

const error = (ctx, caught) => {
  if (caught instanceof InternalSettlementError || caught instanceof PilotIdentityError || caught?.name === "AttachmentStorageError" || caught?.name === "AuthorizationError" || caught?.name === "ContractError") ctx.send(ctx.res, caught.status || 400, { code: caught.code || "ATTACHMENT_FAILED", message: caught.message, ...(caught.details ? { details: caught.details } : {}) });
  else { ctx.reportError?.(caught); ctx.send(ctx.res, 500, { code: "ATTACHMENT_FAILED", message: "The attachment operation could not be completed." }); }
};

// Uploads and evidence files. Mobile and settlement evidence needs mobile
// operations or the settlement workflow, as before. A contract's signed file
// (docs/contracts-module-design.md §6) needs only the contracts capability:
// it is staged with purpose "contract" (contracts.contract.manage, read with
// a size limit that fits a 20 MB file in base64), bound and removed through
// /api/contracts, and downloaded here with contracts.contract.read.
export async function handleAttachmentRoute(ctx) {
  const path = ctx.url.pathname;
  if (path.startsWith("/api/contracts/")) return false;
  if (!path.startsWith("/api/uploads/") && !path.startsWith("/api/attachments/") && !/\/attachments$/.test(path)) return false;
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." }); return true; }
  const env = ctx.env || process.env;
  const legacy = Boolean(capabilityForEnvironment("mobile-operations", env)?.enabled || capabilityForEnvironment("settlement-workflow", env)?.enabled);
  const contracts = contractsEnabled(env);
  const unavailable = () => { ctx.send(ctx.res, 409, { code: "ATTACHMENT_CAPABILITY_NOT_AVAILABLE", message: "Attachment evidence requires an explicitly enabled database capability." }); return true; };
  if (!legacy && !contracts) return unavailable();
  try {
    const prisma = ctx.attachmentPrisma || await getPrismaClient(env), service = ctx.attachmentService || createAttachmentService({ prisma, env });
    if (ctx.req.method === "GET" && path === "/api/attachments/health") { ctx.send(ctx.res, 200, await service.healthCheck()); return true; }
    if (ctx.req.method === "GET" && path === "/api/attachments/orphans") { ctx.send(ctx.res, 200, await service.orphanCheck()); return true; }
    if (ctx.req.method === "POST" && path === "/api/uploads/stage") {
      // With contracts on, a staged file may be a contract's, so the body is
      // read with a limit; without them the request is read as before.
      const input = contracts ? await readBoundedJson(ctx.req, CONTRACT_UPLOAD_MAX_REQUEST_BYTES) : await ctx.readBody(ctx.req);
      if (String(input?.purpose ?? "").trim() === "contract" ? !contracts : !legacy) return unavailable();
      ctx.send(ctx.res, 201, await service.stageUpload(input, ctx)); return true;
    }
    const attachment = path.match(/^\/api\/attachments\/([^/]+)\/download$/); if (ctx.req.method === "GET" && attachment) { const file = await service.download(decodeURIComponent(attachment[1]), ctx, { legacyEnabled: legacy, contractsEnabled: contracts }); ctx.res.writeHead(200, { "content-type": file.mimeType, "content-length": file.bytes.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`, "x-content-sha256": file.sha256, "cache-control": "private, no-store" }); ctx.res.end(file.bytes); return true; }
    if (!legacy) return unavailable();
    const upload = path.match(/^\/api\/uploads\/([^/]+)\/status$/); if (ctx.req.method === "GET" && upload) { ctx.send(ctx.res, 200, await service.status(decodeURIComponent(upload[1]), ctx)); return true; }
    const settlement = path.match(/^\/api\/finance\/settlements\/([^/]+)\/attachments$/); if (ctx.req.method === "POST" && settlement) { ctx.send(ctx.res, 201, await service.bindSettlement(decodeURIComponent(settlement[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const receiving = path.match(/^\/api\/receiving\/drafts\/([^/]+)\/attachments$/); if (ctx.req.method === "POST" && receiving) { ctx.send(ctx.res, 201, await service.bindReceiving(decodeURIComponent(receiving[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const remove = path.match(/^\/api\/attachments\/([^/]+)$/); if (ctx.req.method === "DELETE" && remove) { ctx.send(ctx.res, 200, await service.deleteAttachment(decodeURIComponent(remove[1]), ctx)); return true; }
    ctx.send(ctx.res, 404, { code: "ATTACHMENT_ROUTE_NOT_FOUND", message: "Attachment route not found." }); return true;
  } catch (caught) { error(ctx, caught); return true; }
}
