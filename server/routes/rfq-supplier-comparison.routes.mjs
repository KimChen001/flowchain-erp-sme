import {
  RfqSupplierComparisonError,
  createRfqSupplierComparisonService,
} from "../domain/rfq-supplier-comparison-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

function knownError(error) {
  return error instanceof RfqSupplierComparisonError ||
    error instanceof PilotIdentityError ||
    error?.name === "AuthorizationError";
}

function sendError(ctx, error) {
  if (knownError(error)) {
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || "RFQ_SUPPLIER_COMPARISON_FAILED",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  ctx.send(ctx.res, 500, {
    code: "RFQ_SUPPLIER_COMPARISON_FAILED",
    message: "The supplier comparison could not be loaded.",
  });
}

async function comparisonService(ctx) {
  if (ctx.rfqSupplierComparisonService) return ctx.rfqSupplierComparisonService;
  const prisma = ctx.rfqSupplierComparisonPrisma || await getPrismaClient(ctx.env || process.env);
  return createRfqSupplierComparisonService({ prisma, env: ctx.env || process.env });
}

export async function handleRfqSupplierComparisonRoute(ctx) {
  const match = ctx.url.pathname.match(/^\/api\/procurement\/rfqs\/([^/]+)\/comparison$/);
  if (ctx.req.method !== "GET" || !match) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  try {
    const service = await comparisonService(ctx);
    let rfqId;
    try {
      rfqId = decodeURIComponent(match[1]);
    } catch {
      throw new RfqSupplierComparisonError("RFQ_ID_INVALID", "rfqId is invalid.", 422);
    }
    ctx.send(ctx.res, 200, await service.getComparison(rfqId, { identity: ctx.identity }));
  } catch (error) {
    sendError(ctx, error);
  }
  return true;
}
