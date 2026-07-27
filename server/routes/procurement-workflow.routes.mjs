import { createProcurementWorkflowService } from "../services/procurement-workflow-service.mjs";
import { authorizeMutation } from "../domain/mutation-authorization.mjs";
const repositoryFor = (ctx) => {
  if (!ctx.repositories?.procurementRuntime) throw new Error("PostgreSQL procurement repository is not configured.");
  return ctx.repositories.procurementRuntime;
};
const workflowService = (ctx) => createProcurementWorkflowService({
  repository: repositoryFor(ctx), itemRepository: ctx.repositories?.masterData,
  policyProvider: async () => ({
    directPurchaseThreshold: 50000,
    rfqRequiredAboveAmount: 100000,
    allowManagerOverride: true,
  }),
});
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
const failure = (send, res, e) =>
  send(res, e.status || 500, {
    code: e.code || "PERSISTENCE_ERROR",
    message: e.message,
    details: e.details || [],
    entityId: e.entityId,
    currentStatus: e.currentStatus,
    currentVersion: e.currentVersion,
    expectedVersion: e.expectedVersion,
  });
export async function handleProcurementWorkflowRoute(ctx) {
  const { req, res, url, send, readBody } = ctx;
  const runtimeRepository = repositoryFor(ctx);
  const service = workflowService(ctx);
  if (req.method === "GET" && url.pathname === "/api/procurement/requests") {
    if (!ctx.identity?.authenticated || !ctx.identity.tenantId) return send(res, 401, { code: "TENANT_CONTEXT_REQUIRED", message: "An authenticated tenant context is required." }) || true;
    const snapshot = await ctx.repositories.procurementRead.snapshot({ tenantId: ctx.identity.tenantId });
    return send(res, 200, snapshot.purchaseRequests) || true;
  }
  const requestDetail = url.pathname.match(/^\/api\/procurement\/requests\/([^/]+)$/);
  if (req.method === "GET" && requestDetail) {
    const request = await runtimeRepository.get("pr", decodeURIComponent(requestDetail[1]));
    return send(res, request ? 200 : 404, request || { code: "ENTITY_NOT_FOUND", message: "采购申请不存在" }) || true;
  }
  if (req.method === "POST" && url.pathname === "/api/procurement/requests") {
    if (!authorizeAction(ctx, "pr.create")) return true;
    try {
      return (
        send(
          res,
          201,
          await service.createPurchaseRequest(await readBody(req), actor(ctx)),
        ) || true
      );
    } catch (e) {
      failure(send, res, e);
      return true;
    }
  }
  const draftUpdate = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)$/,
  );
  if (req.method === "PATCH" && draftUpdate) {
    if (!authorizeAction(ctx, "pr.update")) return true;
    try {
      send(
        res,
        200,
        await service.updatePurchaseRequestDraft(
          decodeURIComponent(draftUpdate[1]),
          await readBody(req),
          actor(ctx),
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  const action = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/(submit|approve|reject|withdraw|cancel)$/,
  );
  if (req.method === "POST" && action) {
    const permissionAction = ["approve", "reject"].includes(action[2])
      ? "pr.approve"
      : `pr.${action[2]}`;
    if (!authorizeAction(ctx, permissionAction)) return true;
    try {
      const b = await readBody(req);
      if (action[2] === "reject" && !String(b.reason || "").trim()) throw Object.assign(new Error("拒绝必须填写原因"), { code: "REJECT_REASON_REQUIRED", status: 400, details: [{ field: "reason" }] });
      const next = {
        submit: "submitted",
        approve: "approved",
        reject: "rejected",
        withdraw: "draft",
        cancel: "cancelled",
      }[action[2]];
      send(
        res,
        200,
        await service.transitionPurchaseRequest(
          decodeURIComponent(action[1]),
          next,
          { ...b, actor: actor(ctx) },
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  const recommendation = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/path-recommendation$/,
  );
  if (req.method === "GET" && recommendation) {
    try {
      send(
        res,
        200,
        await service.recommendPath(
          decodeURIComponent(recommendation[1]),
          ctx.identity?.userId || "anonymous",
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  const rfq = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/rfqs$/,
  );
  if (req.method === "POST" && rfq) {
    if (!authorizeAction(ctx, "rfq.create")) return true;
    try {
      send(
        res,
        201,
        await service.createRfqFromPurchaseRequest(
          decodeURIComponent(rfq[1]),
          await readBody(req),
          actor(ctx),
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  const po = url.pathname.match(
    /^\/api\/procurement\/requests\/([^/]+)\/(direct-purchase-order|generate-purchase-orders)$/,
  );
  if (req.method === "POST" && po) {
    if (!authorizeAction(ctx, "direct-po")) return true;
    try {
      send(
        res,
        201,
        await service.createDirectPoFromPurchaseRequest(
          decodeURIComponent(po[1]),
          await readBody(req),
          actor(ctx),
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/procurement/rfqs")
    return send(res, 200, await runtimeRepository.list("rfq")) || true;
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
  if (req.method === "POST" && rfqAction) {
    if (!authorizeAction(ctx, "rfq.create")) return true;
    try {
      const b = await readBody(req);
      send(
        res,
        200,
        await service.transitionRfq(
          decodeURIComponent(rfqAction[1]),
          rfqAction[2] === "open" ? "open" : "cancelled",
          { ...b, actor: actor(ctx) },
        ),
      );
    } catch (e) {
      failure(send, res, e);
    }
    return true;
  }
  return false;
}
