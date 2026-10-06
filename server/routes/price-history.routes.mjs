import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { PriceHistoryError, createPriceHistoryReadService } from "../domain/price-history-read-service.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

// GET /api/procurement/price-history?key=itemId|unit|currency (repeated, at
// most 50): each item's latest prices on the workspace's own issued purchase
// orders, for the forms where a person enters or reviews a price. Display
// only: no form fills a price from it.

function knownError(error) {
  return error instanceof PriceHistoryError ||
    error instanceof PilotIdentityError ||
    error?.name === "AuthorizationError";
}

async function priceHistoryService(ctx) {
  if (ctx.priceHistoryService) return ctx.priceHistoryService;
  const prisma = ctx.priceHistoryPrisma || await getPrismaClient(ctx.env || process.env);
  return createPriceHistoryReadService({ prisma, env: ctx.env || process.env });
}

export async function handlePriceHistoryRoute(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/api/procurement/price-history") return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  try {
    const service = await priceHistoryService(ctx);
    ctx.send(ctx.res, 200, await service.read(ctx.url.searchParams.getAll("key"), { identity: ctx.identity }));
  } catch (error) {
    if (knownError(error)) {
      ctx.send(ctx.res, error.status || 400, { code: error.code || "PRICE_HISTORY_FAILED", message: error.message });
    } else {
      ctx.send(ctx.res, 500, { code: "PRICE_HISTORY_FAILED", message: "The price history could not be loaded." });
    }
  }
  return true;
}
