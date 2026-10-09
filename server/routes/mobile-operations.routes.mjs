import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { createMobileOperationsService, MobileOperationsError } from "../domain/mobile-operations-service.mjs";
import { ReceivingCommandError } from "../domain/receiving-posting-command-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

function sendError(ctx, error) {
  if (error instanceof MobileOperationsError || error instanceof ReceivingCommandError || error instanceof PilotIdentityError || error?.name === "AuthorizationError" || error?.code) { ctx.send(ctx.res, error.status || 400, { code: error.code || "MOBILE_OPERATIONS_FAILED", message: error.message, ...(error.details ? { details: error.details } : {}) }); return; }
  ctx.reportError?.(error);
  ctx.send(ctx.res, 500, { code: "MOBILE_OPERATIONS_FAILED", message: "Mobile operation could not be completed." });
}

export async function handleMobileOperationsRoute(ctx) {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/mobile/")) return false;
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." }); return true; }
  if (!capabilityForEnvironment("mobile-operations", ctx.env || process.env)?.enabled) { ctx.send(ctx.res, 409, { code: "MOBILE_OPERATIONS_CAPABILITY_NOT_AVAILABLE", message: "Mobile operations require database persistence and explicit enablement." }); return true; }
  try {
    const prisma = ctx.mobileOperationsPrisma || await getPrismaClient(ctx.env || process.env);
    const service = ctx.mobileOperationsService || createMobileOperationsService({ prisma, procurementRepository: ctx.repositories?.procurementLegacyRuntime || ctx.repositories?.procurementRuntime, procurementAuthority: ctx.repositories?.procurementAuthority, masterDataRepository: ctx.repositories?.masterData, env: ctx.env || process.env });
    if (ctx.req.method === "GET" && path === "/api/mobile/tasks") { ctx.send(ctx.res, 200, await service.listTasks(ctx)); return true; }
    const task = path.match(/^\/api\/mobile\/tasks\/(.+)$/); if (ctx.req.method === "GET" && task) { ctx.send(ctx.res, 200, await service.taskDetail(decodeURIComponent(task[1]), ctx)); return true; }
    const po = path.match(/^\/api\/mobile\/purchase-orders\/([^/]+)$/); if (ctx.req.method === "GET" && po) { ctx.send(ctx.res, 200, await service.purchaseOrderDetail(decodeURIComponent(po[1]), ctx)); return true; }
    const poAction = path.match(/^\/api\/mobile\/purchase-orders\/([^/]+)\/(approve|reject|return-for-revision)$/); if (ctx.req.method === "POST" && poAction) { const action = poAction[2] === "return-for-revision" ? "return_for_revision" : poAction[2]; ctx.send(ctx.res, 200, await service.actOnPurchaseOrder(decodeURIComponent(poAction[1]), action, await ctx.readBody(ctx.req), ctx)); return true; }
    if (ctx.req.method === "GET" && path === "/api/mobile/receiving/purchase-orders") { ctx.send(ctx.res, 200, await service.searchReceivingPurchaseOrders(ctx.url.searchParams.get("search"), ctx)); return true; }
    if (ctx.req.method === "POST" && path === "/api/mobile/receiving/drafts") { ctx.send(ctx.res, 201, await service.createReceivingDraft(await ctx.readBody(ctx.req), ctx)); return true; }
    const draft = path.match(/^\/api\/mobile\/receiving\/drafts\/([^/]+)$/); if (ctx.req.method === "PATCH" && draft) { ctx.send(ctx.res, 200, await service.reviseReceivingDraft(decodeURIComponent(draft[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const submit = path.match(/^\/api\/mobile\/receiving\/drafts\/([^/]+)\/submit$/); if (ctx.req.method === "POST" && submit) { ctx.send(ctx.res, 200, await service.submitReceivingDraft(decodeURIComponent(submit[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const preview = path.match(/^\/api\/mobile\/receiving\/([^/]+)\/preview$/); if (ctx.req.method === "GET" && preview) { ctx.send(ctx.res, 200, await service.previewReceiving(decodeURIComponent(preview[1]), ctx)); return true; }
    const post = path.match(/^\/api\/mobile\/receiving\/([^/]+)\/post$/); if (ctx.req.method === "POST" && post) { ctx.send(ctx.res, 200, await service.postReceiving(decodeURIComponent(post[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const evidence = path.match(/^\/api\/mobile\/receiving\/([^/]+)\/(?:grn|inventory-impact)$/); if (ctx.req.method === "GET" && evidence) { ctx.send(ctx.res, 200, await service.receivingEvidence(decodeURIComponent(evidence[1]), ctx)); return true; }
    const receiving = path.match(/^\/api\/mobile\/receiving\/([^/]+)$/); if (ctx.req.method === "GET" && receiving) { ctx.send(ctx.res, 200, await service.receivingDetail(decodeURIComponent(receiving[1]), ctx)); return true; }
    ctx.send(ctx.res, 404, { code: "MOBILE_ROUTE_NOT_FOUND", message: "Mobile route not found." }); return true;
  } catch (error) { sendError(ctx, error); return true; }
}
