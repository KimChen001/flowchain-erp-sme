import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { MAX_UPLOAD_BYTES, createAttachmentService } from "../domain/attachment-service.mjs";
import { InternalSettlementError } from "../domain/internal-settlement-command-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { bodyLimitForFile } from "../utils/http.mjs";

const error = (ctx, caught) => {
  if (caught instanceof InternalSettlementError || caught instanceof PilotIdentityError || caught?.name === "AttachmentStorageError" || caught?.name === "AuthorizationError" || caught?.name === "RequestBodyError") ctx.send(ctx.res, caught.status || 400, { code: caught.code || "ATTACHMENT_FAILED", message: caught.message, ...(caught.details ? { details: caught.details } : {}) });
  else { ctx.reportError?.(caught); ctx.send(ctx.res, 500, { code: "ATTACHMENT_FAILED", message: "The attachment operation could not be completed." }); }
};

export async function handleAttachmentRoute(ctx) {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/uploads/") && !path.startsWith("/api/attachments/") && !/\/attachments$/.test(path)) return false;
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." }); return true; }
  if (!capabilityForEnvironment("mobile-operations", ctx.env || process.env)?.enabled && !capabilityForEnvironment("settlement-workflow", ctx.env || process.env)?.enabled) { ctx.send(ctx.res, 409, { code: "ATTACHMENT_CAPABILITY_NOT_AVAILABLE", message: "Attachment evidence requires an explicitly enabled database capability." }); return true; }
  try {
    const prisma = ctx.attachmentPrisma || await getPrismaClient(ctx.env || process.env), service = ctx.attachmentService || createAttachmentService({ prisma, env: ctx.env || process.env });
    if (ctx.req.method === "GET" && path === "/api/attachments/health") { ctx.send(ctx.res, 200, await service.healthCheck()); return true; }
    if (ctx.req.method === "GET" && path === "/api/attachments/orphans") { ctx.send(ctx.res, 200, await service.orphanCheck()); return true; }
    if (ctx.req.method === "POST" && path === "/api/uploads/stage") { ctx.send(ctx.res, 201, await service.stageUpload(await ctx.readBody(ctx.req, { maxBytes: bodyLimitForFile(MAX_UPLOAD_BYTES) }), ctx)); return true; }
    const upload = path.match(/^\/api\/uploads\/([^/]+)\/status$/); if (ctx.req.method === "GET" && upload) { ctx.send(ctx.res, 200, await service.status(decodeURIComponent(upload[1]), ctx)); return true; }
    const settlement = path.match(/^\/api\/finance\/settlements\/([^/]+)\/attachments$/); if (ctx.req.method === "POST" && settlement) { ctx.send(ctx.res, 201, await service.bindSettlement(decodeURIComponent(settlement[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const receiving = path.match(/^\/api\/receiving\/drafts\/([^/]+)\/attachments$/); if (ctx.req.method === "POST" && receiving) { ctx.send(ctx.res, 201, await service.bindReceiving(decodeURIComponent(receiving[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const attachment = path.match(/^\/api\/attachments\/([^/]+)\/download$/); if (ctx.req.method === "GET" && attachment) { const file = await service.download(decodeURIComponent(attachment[1]), ctx); ctx.res.writeHead(200, { "content-type": file.mimeType, "content-length": file.bytes.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`, "x-content-sha256": file.sha256, "cache-control": "private, no-store" }); ctx.res.end(file.bytes); return true; }
    const remove = path.match(/^\/api\/attachments\/([^/]+)$/); if (ctx.req.method === "DELETE" && remove) { ctx.send(ctx.res, 200, await service.deleteAttachment(decodeURIComponent(remove[1]), ctx)); return true; }
    ctx.send(ctx.res, 404, { code: "ATTACHMENT_ROUTE_NOT_FOUND", message: "Attachment route not found." }); return true;
  } catch (caught) { error(ctx, caught); return true; }
}
