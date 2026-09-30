import { createProcurementWorkflowService } from "../services/procurement-workflow-service.mjs";
import { createProcurementRequestCommandService } from "../services/procurement-request-command-service.mjs";
import { authorizeMutation } from "../domain/mutation-authorization.mjs";
import { recommendProcurementPath } from "../domain/procurement-workflow.mjs";
const repositoryFor = (ctx) => {
  if (!ctx.repositories?.procurementRuntime) throw new Error("PostgreSQL procurement repository is not configured.");
  return ctx.repositories.procurementRuntime;
};
// Item and supplier lookups read the signed-in workspace's master data.
const itemRepositoryFor = (ctx) => {
  const masterData = ctx.repositories?.masterData;
  if (!masterData) return undefined;
  const scope = { tenantId: ctx.identity?.tenantId };
  return {
    getItem: (idOrSku) => masterData.getItem(idOrSku, scope),
    getSupplier: (idOrName) => masterData.getSupplier(idOrName, scope),
  };
};
const PROCUREMENT_PATH_POLICY = Object.freeze({
  directPurchaseThreshold: 50000,
  rfqRequiredAboveAmount: 100000,
  allowManagerOverride: true,
});
const workflowService = (ctx) => createProcurementWorkflowService({
  repository: repositoryFor(ctx), itemRepository: itemRepositoryFor(ctx),
  policyProvider: async () => PROCUREMENT_PATH_POLICY,
});
// Purchase request commands write PostgreSQL directly. Permissions come from
// the signed-in actor's role grants inside the service, not from role names.
const requestCommands = (ctx) => ctx.repositories?.procurementRequests
  || createProcurementRequestCommandService({ masterData: ctx.repositories?.masterData, env: ctx.env || process.env });
const actor = (ctx) => ctx.identity.userId;
const allowed = (ctx, action) => {
  const r = ctx.identity.role;
  if (["manager", "admin", "procurement-manager"].includes(r)) return true;
  if (r === "viewer") return false;
  if (r === "business-specialist")
    return ["pr.create", "pr.submit", "pr.cancel", "pr.update"].includes(
      action,
    );
  if (r === "procurement-specialist")
    return [
      "path",
      "direct-po",
      "rfq.create",
      "po.submit",
      "pr.create",
      "pr.submit",
    ].includes(action);
  return false;
};
const deny = (send, res) =>
  send(res, 403, {
    code: "PERMISSION_DENIED",
    message: "当前用户无权执行此操作",
    details: [],
  });
const authorizeAction = (ctx, action) => {
  const authorization = authorizeMutation(ctx, {
    allowedRoles: ["admin", "manager", "procurement-manager", "business-specialist", "procurement-specialist"],
    action,
    resource: "procurement-workflow",
  });
  if (authorization.blocked) return false;
  if (allowed(ctx, action)) return true;
  deny(ctx.send, ctx.res);
  return false;
};
const failure = (send, res, e) => {
  // Serializable transactions that lose a race are safe to retry.
  if (e?.code === "P2034") return send(res, 409, { code: "TRANSACTION_CONFLICT", message: "Another change landed at the same time. Reload and try again.", details: [] });
  // Errors without a status are unexpected; the server error boundary logs
  // them and answers without leaking internals.
  if (!e?.status) throw e;
  return send(res, e.status, {
    code: e.code || "PROCUREMENT_COMMAND_FAILED",
    message: e.message,
    details: e.details || [],
    entityId: e.entityId,
    currentStatus: e.currentStatus,
    currentVersion: e.currentVersion,
    expectedVersion: e.expectedVersion,
  });
};
const respond = async (ctx, status, run) => {
  try {
    ctx.send(ctx.res, status, await run());
  } catch (e) {
    failure(ctx.send, ctx.res, e);
  }
  return true;
};
const commandBody = async (ctx) => {
  const body = (await ctx.readBody(ctx.req)) || {};
  const header = String(ctx.req.headers?.["idempotency-key"] || "").trim();
  return header && !body.idempotencyKey ? { ...body, idempotencyKey: header } : body;
};
export async function handleProcurementWorkflowRoute(ctx) {
  const { req, res, url, send, readBody } = ctx;
  if (!url.pathname.startsWith("/api/procurement/")) return false;
  const runtimeRepository = repositoryFor(ctx);
  const service = workflowService(ctx);
  if (req.method === "GET" && url.pathname === "/api/procurement/requests") {
    if (!ctx.identity?.authenticated || !ctx.identity.tenantId) return send(res, 401, { code: "TENANT_CONTEXT_REQUIRED", message: "An authenticated tenant context is required." }) || true;
    const snapshot = await ctx.repositories.procurementRead.snapshot({ tenantId: ctx.identity.tenantId });
    return send(res, 200, snapshot.purchaseRequests) || true;
  }
  const requestDetail = url.pathname.match(/^\/api\/procurement\/requests\/([^/]+)$/);
  if (req.method === "GET" && requestDetail)
    return respond(ctx, 200, () => requestCommands(ctx).readPurchaseRequest(decodeURIComponent(requestDetail[1]), ctx));
  if (req.method === "POST" && url.pathname === "/api/procurement/requests")
    return respond(ctx, 201, async () => requestCommands(ctx).createPurchaseRequest(await commandBody(ctx), ctx));
  if (req.method === "PATCH" && requestDetail)
    return respond(ctx, 200, async () => requestCommands(ctx).updatePurchaseRequestDraft(decodeURIComponent(requestDetail[1]), await commandBody(ctx), ctx));
  const action = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/(submit|approve|reject|withdraw|cancel)$/,
  );
  if (req.method === "POST" && action)
    return respond(ctx, 200, async () => requestCommands(ctx).transitionPurchaseRequest(decodeURIComponent(action[1]), action[2], await commandBody(ctx), ctx));
  const recommendation = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/path-recommendation$/,
  );
  if (req.method === "GET" && recommendation)
    return respond(ctx, 200, async () => recommendProcurementPath(await requestCommands(ctx).readPurchaseRequest(decodeURIComponent(recommendation[1]), ctx), PROCUREMENT_PATH_POLICY, {}, {}));
  const rfq = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/rfqs$/,
  );
  if (req.method === "POST" && rfq)
    return respond(ctx, 201, async () => requestCommands(ctx).createRfqFromPurchaseRequest(decodeURIComponent(rfq[1]), await commandBody(ctx), ctx));
  const po = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/(direct-purchase-order|generate-purchase-orders)$/,
  );
  if (req.method === "POST" && po)
    return respond(ctx, 201, async () => requestCommands(ctx).createPurchaseOrdersFromPurchaseRequest(decodeURIComponent(po[1]), await commandBody(ctx), ctx));
  if (req.method === "GET" && url.pathname === "/api/procurement/rfqs") {
    if (!ctx.identity?.authenticated || !ctx.identity.tenantId) return send(res, 401, { code: "TENANT_CONTEXT_REQUIRED", message: "An authenticated tenant context is required." }) || true;
    const snapshot = await ctx.repositories.procurementRead.snapshot({ tenantId: ctx.identity.tenantId });
    return send(res, 200, snapshot.rfqs) || true;
  }
  if (req.method === "GET" && url.pathname === "/api/procurement/orders") {
    if (!ctx.identity?.authenticated || !ctx.identity.tenantId) return send(res, 401, { code: "TENANT_CONTEXT_REQUIRED", message: "An authenticated tenant context is required." }) || true;
    const snapshot = await ctx.repositories.procurementRead.snapshot({ tenantId: ctx.identity.tenantId });
    return send(res, 200, snapshot.purchaseOrders) || true;
  }
  const orderDetail = url.pathname.match(/^\/api\/procurement\/orders\/([^/]+)$/);
  if (req.method === "GET" && orderDetail) {
    const order = await runtimeRepository.get("po", decodeURIComponent(orderDetail[1]));
    return send(res, order ? 200 : 404, order || { code: "ENTITY_NOT_FOUND", message: "采购订单不存在" }) || true;
  }
  const poAction = url.pathname.match(
    /^\/api\/procurement\/orders\/([^/]+)\/(submit|approve|issue|cancel)$/,
  );
  if (req.method === "POST" && poAction) {
    const permissionAction =
      poAction[2] === "submit" ? "po.submit" : "po.approve";
    if (!authorizeAction(ctx, permissionAction)) return true;
    try {
      const b = await readBody(req);
      const next = {
        submit: "pending_approval",
        approve: "approved",
        issue: "issued",
        cancel: "cancelled",
      }[poAction[2]];
      send(
        res,
        200,
        await service.transitionPurchaseOrder(
          decodeURIComponent(poAction[1]),
          next,
          { ...b, actor: actor(ctx) },
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  const rfqAction = url.pathname.match(
    /^\/api\/procurement\/rfqs\/([^/]+)\/(open|cancel)$/,
  );
  if (req.method === "POST" && rfqAction)
    return respond(ctx, 200, async () => requestCommands(ctx).transitionRfq(decodeURIComponent(rfqAction[1]), rfqAction[2], await commandBody(ctx), ctx));
  return false;
}
