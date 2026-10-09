import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import {
  createInventoryOperationsCommandService,
  InventoryOperationsError,
} from "../domain/inventory-operations-command-service.mjs";
import {
  buildCycleCountCancellationPlan,
  buildCycleCountPostingPlan,
  buildInventoryAdjustmentCancellationPlan,
  buildInventoryAdjustmentPostingPlan,
  buildInventoryAdjustmentReversalPlan,
  buildStockTransferCancellationPlan,
  buildStockTransferPostingPlan,
  buildStockTransferReversalPlan,
} from "../domain/inventory-operations-policy.mjs";
import {
  createInventoryOperationsReadService,
  InventoryOperationsReadError,
} from "../domain/inventory-operations-read-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { notifyApprovalWaiting } from "../notifications/approval-notifier.mjs";

const capabilityIds = [
  "stock-transfer",
  "cycle-count",
  "inventory-adjustment-document",
];
const capabilities = (env) =>
  Object.fromEntries(
    capabilityIds.map((id) => [id, capabilityForEnvironment(id, env)]),
  );
const query = (url) => Object.fromEntries(url.searchParams.entries());

export async function handleInventoryOperationsRoute(ctx) {
  const { req, res, url, send } = ctx;
  if (
    !url.pathname.startsWith("/api/inventory/operations") &&
    !url.pathname.startsWith("/api/inventory/transfers") &&
    !url.pathname.startsWith("/api/inventory/counts") &&
    !url.pathname.startsWith("/api/inventory/adjustments")
  )
    return false;
  const env = ctx.env || process.env;
  try {
    const prisma =
      ctx.inventoryOperationsPrisma ||
      ctx.outboundPrisma ||
      (await getPrismaClient(env));
    const read = createInventoryOperationsReadService({
      prisma,
      capabilities: capabilities(env),
    });
    const command = createInventoryOperationsCommandService({ prisma, env });
    if (
      req.method === "GET" &&
      url.pathname === "/api/inventory/operations/entry-data"
    ) {
      send(res, 200, await read.entryData(ctx));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/inventory/transfers") {
      send(res, 200, await read.listTransfers(query(url), ctx));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/inventory/transfers") {
      send(
        res,
        201,
        await command.createTransfer(await ctx.readBody(req), ctx),
      );
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/inventory/counts") {
      send(res, 200, await read.listCountSessions(query(url), ctx));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/inventory/counts") {
      send(res, 201, await command.createCount(await ctx.readBody(req), ctx));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/inventory/adjustments") {
      send(res, 200, await read.listAdjustments(query(url), ctx));
      return true;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/inventory/adjustments"
    ) {
      const result = await command.createAdjustment(await ctx.readBody(req), ctx);
      send(res, 201, result);
      // A new adjustment waits for someone to ready it (its approval).
      notifyApprovalWaiting(ctx, result, {
        documentType: "inventory_adjustment",
        documentId: result?.entityId,
      });
      return true;
    }

    const match = url.pathname.match(
      /^\/api\/inventory\/(transfers|counts|adjustments)\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (!match) return false;
    const [, kind, id, action = ""] = match;
    if (req.method === "GET" && action === "workbench") {
      const data =
        kind === "transfers"
          ? await read.transferWorkbench(id, ctx)
          : kind === "counts"
            ? await read.countWorkbench(id, ctx)
            : await read.adjustmentWorkbench(id, ctx);
      send(res, 200, data);
      return true;
    }
    if (
      req.method === "GET" &&
      ["evidence", "links", "reconciliation"].includes(action)
    ) {
      const data =
        kind === "transfers"
          ? await read.transferWorkbench(id, ctx)
          : kind === "counts"
            ? await read.countWorkbench(id, ctx)
            : await read.adjustmentWorkbench(id, ctx);
      send(
        res,
        200,
        action === "evidence"
          ? data.evidence
          : action === "links"
            ? data.smartLinks || []
            : data.reconciliation,
      );
      return true;
    }
    const body = await ctx.readBody(req);
    if (req.method === "PATCH" && !action) {
      const result =
        kind === "transfers"
          ? await command.reviseTransfer(id, body, ctx)
          : kind === "counts"
            ? await command.reviseCount(id, body, ctx)
            : await command.reviseAdjustment(id, body, ctx);
      send(res, 200, result);
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, {
        code: "METHOD_NOT_ALLOWED",
        message: "Method not allowed.",
      });
      return true;
    }
    if (action.endsWith("-preview")) {
      const operation = action.replace("-preview", "");
      let plan;
      if (kind === "transfers") {
        await read.transferWorkbench(id, ctx);
        plan =
          operation === "post"
            ? await buildStockTransferPostingPlan({
                prisma,
                tenantId: ctx.identity?.tenantId,
                transferId: id,
              })
            : operation === "reverse"
              ? await buildStockTransferReversalPlan({
                  prisma,
                  tenantId: ctx.identity?.tenantId,
                  transferId: id,
                })
              : await buildStockTransferCancellationPlan({
                  prisma,
                  tenantId: ctx.identity?.tenantId,
                  transferId: id,
                  reason: body.reason,
                });
      } else if (kind === "counts") {
        await read.countWorkbench(id, ctx);
        // Each preview answers for its own operation: cancel previews a
        // cancellation, never the posting plan.
        plan =
          operation === "cancel"
            ? await buildCycleCountCancellationPlan({
                prisma,
                tenantId: ctx.identity?.tenantId,
                countSessionId: id,
                reason: body.reason,
              })
            : operation === "post"
              ? await buildCycleCountPostingPlan({
                  prisma,
                  tenantId: ctx.identity?.tenantId,
                  countSessionId: id,
                })
              : {
                  normalizedPlan: { countSessionId: id },
                  allowed: false,
                  blockingIssues: [
                    {
                      code: "COUNT_REVERSAL_UNSUPPORTED",
                      message: "Posted cycle counts cannot be reversed. Post an adjustment instead.",
                      status: 409,
                    },
                  ],
                  warnings: [],
                  balanceImpacts: [],
                  documentImpacts: [],
                };
      } else {
        await read.adjustmentWorkbench(id, ctx);
        plan =
          operation === "post"
            ? await buildInventoryAdjustmentPostingPlan({
                prisma,
                tenantId: ctx.identity?.tenantId,
                adjustmentId: id,
              })
            : operation === "reverse"
              ? await buildInventoryAdjustmentReversalPlan({
                  prisma,
                  tenantId: ctx.identity?.tenantId,
                  adjustmentId: id,
                })
              : await buildInventoryAdjustmentCancellationPlan({
                  prisma,
                  tenantId: ctx.identity?.tenantId,
                  adjustmentId: id,
                  reason: body.reason,
                });
      }
      send(res, 200, plan);
      return true;
    }
    const operations = {
      transfers: {
        ready: command.readyTransfer,
        cancel: command.cancelTransfer,
        post: command.postTransfer,
        reverse: command.reverseTransfer,
      },
      counts: {
        submit: command.submitCount,
        review: command.reviewCount,
        post: command.postCount,
        cancel: command.cancelCount,
      },
      adjustments: {
        ready: command.readyAdjustment,
        cancel: command.cancelAdjustment,
        post: command.postAdjustment,
        reverse: command.reverseAdjustment,
      },
    };
    const handler = operations[kind]?.[action];
    if (!handler) {
      send(res, 404, {
        code: "INVENTORY_OPERATION_NOT_FOUND",
        message: "Inventory operation route was not found.",
      });
      return true;
    }
    send(res, 200, await handler(id, body, ctx));
    return true;
  } catch (error) {
    const known =
      error instanceof InventoryOperationsError ||
      error instanceof InventoryOperationsReadError ||
      error instanceof PilotIdentityError ||
      error?.name === "AuthorizationError";
    send(res, known ? error.status || 400 : 500, {
      code: known ? error.code : "INVENTORY_OPERATION_FAILED",
      message: known ? error.message : "Inventory operation failed.",
    });
    return true;
  }
}
