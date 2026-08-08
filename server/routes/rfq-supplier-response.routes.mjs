import {
  RfqSupplierResponseCommandError,
  createRfqSupplierResponseCommandService,
} from "../domain/rfq-supplier-response-command-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

function knownError(error) {
  return error instanceof RfqSupplierResponseCommandError ||
    error instanceof PilotIdentityError ||
    error?.name === "AuthorizationError";
}

function sendError(ctx, error) {
  if (error instanceof SyntaxError) {
    ctx.send(ctx.res, 422, {
      code: "RFQ_RESPONSE_PAYLOAD_INVALID",
      message: "The request body must contain valid JSON.",
    });
    return;
  }
  if (knownError(error)) {
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || "RFQ_SUPPLIER_RESPONSE_COMMAND_FAILED",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  ctx.send(ctx.res, 500, {
    code: "RFQ_SUPPLIER_RESPONSE_COMMAND_FAILED",
    message: "The supplier response command could not be completed.",
  });
}

async function service(ctx) {
  if (ctx.rfqSupplierResponseCommandService) return ctx.rfqSupplierResponseCommandService;
  const prisma = ctx.rfqSupplierResponsePrisma || await getPrismaClient(ctx.env || process.env);
  return createRfqSupplierResponseCommandService({ prisma, env: ctx.env || process.env });
}

export async function handleRfqSupplierResponseRoute(ctx) {
  const initial = ctx.url.pathname.match(/^\/api\/procurement\/rfqs\/([^/]+)\/supplier-responses$/);
  const append = ctx.url.pathname.match(/^\/api\/procurement\/rfqs\/([^/]+)\/supplier-responses\/([^/]+)\/revisions$/);
  if (ctx.req.method !== "POST" || (!initial && !append)) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  try {
    const body = await ctx.readBody(ctx.req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RfqSupplierResponseCommandError(
        "RFQ_RESPONSE_PAYLOAD_INVALID",
        "The request body must be a JSON object.",
        422,
      );
    }
    const idempotencyKey = String(ctx.req.headers?.["idempotency-key"] || body.idempotencyKey || "").trim();
    const input = { ...body, idempotencyKey };
    const command = await service(ctx);
    if (initial) {
      ctx.send(ctx.res, 201, await command.recordInitialResponse(decodeURIComponent(initial[1]), input, { identity: ctx.identity }));
    } else {
      ctx.send(ctx.res, 201, await command.appendRevision(decodeURIComponent(append[1]), decodeURIComponent(append[2]), input, { identity: ctx.identity }));
    }
  } catch (error) {
    sendError(ctx, error);
  }
  return true;
}
