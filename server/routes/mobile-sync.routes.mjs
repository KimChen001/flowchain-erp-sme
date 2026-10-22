import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { createMobileSyncService, MobileSyncError } from "../domain/mobile-sync-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

const query = (url) => Object.fromEntries(url.searchParams.entries());

function unavailable(ctx) {
  ctx.send(ctx.res, 409, { code: "MOBILE_SYNC_CAPABILITY_NOT_AVAILABLE", message: "Mobile sync requires database persistence and explicit enablement.", details: { capability: "mobile-sync" } });
}

function sendError(ctx, error) {
  if (error instanceof MobileSyncError || error instanceof PilotIdentityError || error?.name === "AuthorizationError") {
    ctx.send(ctx.res, error.status || 400, { code: error.code || "MOBILE_SYNC_FAILED", message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  ctx.reportError?.(error);
  ctx.send(ctx.res, 500, { code: "MOBILE_SYNC_FAILED", message: "Mobile synchronization could not be completed." });
}

export async function handleMobileSyncRoute(ctx) {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/sync/")) return false;
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." }); return true; }
  if (!capabilityForEnvironment("mobile-sync", ctx.env || process.env)?.enabled) { unavailable(ctx); return true; }
  try {
    const prisma = ctx.mobileSyncPrisma || await getPrismaClient(ctx.env || process.env);
    const service = ctx.mobileSyncService || createMobileSyncService({ prisma, env: ctx.env || process.env });
    if (ctx.req.method === "POST" && path === "/api/sync/clients/register") {
      ctx.send(ctx.res, 201, await service.register(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/sync/initial") {
      ctx.send(ctx.res, 200, await service.initial(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/sync/changes") {
      const result = await service.changes(query(ctx.url), ctx);
      ctx.send(ctx.res, result.resetRequired ? 409 : 200, result);
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/sync/acknowledge") {
      ctx.send(ctx.res, 200, await service.acknowledge(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    const revoke = path.match(/^\/api\/sync\/clients\/([^/]+)\/revoke$/);
    if (ctx.req.method === "POST" && revoke) {
      ctx.send(ctx.res, 200, await service.revoke(decodeURIComponent(revoke[1]), await ctx.readBody(ctx.req), ctx));
      return true;
    }
    ctx.send(ctx.res, 404, { code: "SYNC_ROUTE_NOT_FOUND", message: "Sync route not found." });
    return true;
  } catch (error) {
    sendError(ctx, error);
    return true;
  }
}
