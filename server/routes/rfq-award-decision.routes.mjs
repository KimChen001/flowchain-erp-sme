import { RfqAwardDecisionError, createRfqAwardDecisionService } from "../domain/rfq-award-decision-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

const knownError = (error) => error instanceof RfqAwardDecisionError || error instanceof PilotIdentityError || error?.name === "AuthorizationError";

function sendError(ctx, error) {
  if (error instanceof SyntaxError) {
    ctx.send(ctx.res, 422, { code: "RFQ_AWARD_INPUT_INVALID", message: "The request body must contain valid JSON." });
  } else if (knownError(error)) {
    ctx.send(ctx.res, error.status || 400, { code: error.code || "RFQ_AWARD_DECISION_FAILED", message: error.message, ...(error.details ? { details: error.details } : {}) });
  } else {
    ctx.send(ctx.res, 500, { code: "RFQ_AWARD_DECISION_FAILED", message: "The Award Decision request could not be completed." });
  }
}

async function service(ctx) {
  if (ctx.rfqAwardDecisionService) return ctx.rfqAwardDecisionService;
  const prisma = ctx.rfqAwardDecisionPrisma || await getPrismaClient(ctx.env || process.env);
  return createRfqAwardDecisionService({ prisma, env: ctx.env || process.env });
}

function routeId(value) {
  try { return decodeURIComponent(value); } catch { throw new RfqAwardDecisionError("RFQ_ID_INVALID", "rfqId is invalid.", 422); }
}

export async function handleRfqAwardDecisionRoute(ctx) {
  const create = ctx.url.pathname.match(/^\/api\/procurement\/rfqs\/([^/]+)\/award-decisions$/);
  const read = ctx.url.pathname.match(/^\/api\/procurement\/rfqs\/([^/]+)\/award-decision$/);
  if (!(ctx.req.method === "POST" && create) && !(ctx.req.method === "GET" && read)) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  try {
    const target = routeId(create?.[1] || read?.[1]);
    const awardService = await service(ctx);
    if (create) {
      const body = await ctx.readBody(ctx.req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RfqAwardDecisionError("RFQ_AWARD_INPUT_INVALID", "The request body must be a JSON object.", 422);
      const idempotencyKey = String(ctx.req.headers?.["idempotency-key"] || body.idempotencyKey || "").trim();
      ctx.send(ctx.res, 201, await awardService.createAwardDecision(target, { ...body, idempotencyKey }, { identity: ctx.identity }));
    } else {
      ctx.send(ctx.res, 200, await awardService.getAwardDecision(target, { identity: ctx.identity }));
    }
  } catch (error) {
    sendError(ctx, error);
  }
  return true;
}
