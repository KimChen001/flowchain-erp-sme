import { canReadProcurementDocument, maskProcurementRecord, maskProcurementSnapshot, procurementReadAccess } from "../domain/procurement-read-access.mjs";
const denied = (send, res) => send(res, 403, { code: "PERMISSION_DENIED", message: "Your role cannot view these procurement records.", details: [] }) || true;
import { createHash } from "node:crypto";
import { createProcurementRequestCommandService } from "../services/procurement-request-command-service.mjs";
import { recommendProcurementPath } from "../domain/procurement-workflow.mjs";
const PROCUREMENT_PATH_POLICY = Object.freeze({
  directPurchaseThreshold: 50000,
  rfqRequiredAboveAmount: 100000,
  allowManagerOverride: true,
});
// Purchase request commands write PostgreSQL directly. Permissions come from
// the signed-in actor's role grants inside the service, not from role names.
const requestCommands = (ctx) => ctx.repositories?.procurementRequests
  || createProcurementRequestCommandService({ masterData: ctx.repositories?.masterData, env: ctx.env || process.env });
// PO commands go through the same PostgreSQL authority as mobile approval.
const purchaseOrderCommands = (ctx) => {
  if (!ctx.repositories?.procurementAuthority) throw new Error("PostgreSQL procurement authority is not configured.");
  return ctx.repositories.procurementAuthority;
};
const PURCHASE_ORDER_ACTIONS = Object.freeze({
  submit: "submitPurchaseOrder",
  approve: "approvePurchaseOrder",
  reject: "rejectPurchaseOrder",
  "return-for-revision": "returnPurchaseOrderForRevision",
  issue: "issuePurchaseOrder",
  cancel: "cancelPurchaseOrder",
  close: "closePurchaseOrder",
});
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
  const { req, res, url, send } = ctx;
  if (!url.pathname.startsWith("/api/procurement/")) return false;
  // Lists answer only the collections the actor may read, with prices and
  // amounts masked by role (procurement-read-access.mjs).
  const list = async (key, type) => {
    if (!ctx.identity?.authenticated || !ctx.identity.tenantId) return send(res, 401, { code: "TENANT_CONTEXT_REQUIRED", message: "An authenticated tenant context is required." }) || true;
    const access = await procurementReadAccess(ctx);
    if (!canReadProcurementDocument(type, access)) return denied(send, res);
    const snapshot = await ctx.repositories.procurementRead.snapshot({ tenantId: ctx.identity.tenantId });
    return send(res, 200, maskProcurementSnapshot(snapshot, access)[key]) || true;
  };
  if (req.method === "GET" && url.pathname === "/api/procurement/requests") return list("purchaseRequests", "pr");
  const requestDetail = url.pathname.match(/^\/api\/procurement\/requests\/([^/]+)$/);
  if (req.method === "GET" && requestDetail)
    return respond(ctx, 200, async () => maskProcurementRecord(await requestCommands(ctx).readPurchaseRequest(decodeURIComponent(requestDetail[1]), ctx), "pr", await procurementReadAccess(ctx)));
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
  if (req.method === "GET" && url.pathname === "/api/procurement/rfqs") return list("rfqs", "rfq");
  if (req.method === "GET" && url.pathname === "/api/procurement/orders") return list("purchaseOrders", "po");
  const orderDetail = url.pathname.match(/^\/api\/procurement\/orders\/([^/]+)$/);
  // Prices as the mobile detail shows them: only with procurement.prices.read.
  if (req.method === "GET" && orderDetail)
    return respond(ctx, 200, async () => {
      const access = await procurementReadAccess(ctx);
      const order = await purchaseOrderCommands(ctx).readPurchaseOrder(decodeURIComponent(orderDetail[1]), ctx, { includePrices: access.prices, includePartner: true });
      return access.prices ? order : { ...order, restrictedFields: ["amounts"] };
    });
  const poAction = url.pathname.match(
    /^\/api\/procurement\/orders\/([^/]+)\/(submit|approve|reject|return-for-revision|issue|cancel|close)$/,
  );
  if (req.method === "POST" && poAction) {
    const command = PURCHASE_ORDER_ACTIONS[poAction[2]];
    const id = decodeURIComponent(poAction[1]);
    return respond(ctx, 200, async () => {
      const body = await commandBody(ctx);
      // The desktop page sends no key: a resend of the same action, version and
      // reason is the same command.
      const idempotencyKey = body.idempotencyKey || `desktop.${poAction[2]}:${id}:v${body.expectedVersion}:${createHash("sha256").update(String(body.reason || "")).digest("hex").slice(0, 16)}`;
      return purchaseOrderCommands(ctx)[command](id, { ...body, idempotencyKey }, ctx);
    });
  }
  // Revising a promised date on an issued PO keeps the original promise and
  // records the revision with its reason.
  const promisedDates = url.pathname.match(/^\/api\/procurement\/orders\/([^/]+)\/promised-dates$/);
  if (req.method === "POST" && promisedDates) {
    const id = decodeURIComponent(promisedDates[1]);
    return respond(ctx, 200, async () => {
      const body = await commandBody(ctx);
      const idempotencyKey = body.idempotencyKey || `desktop.promised-dates:${id}:v${body.expectedVersion}:${createHash("sha256").update(JSON.stringify([body.lines || [], String(body.reason || "")])).digest("hex").slice(0, 16)}`;
      return purchaseOrderCommands(ctx).revisePromisedDates(id, { ...body, idempotencyKey }, ctx);
    });
  }
  const rfqAction = url.pathname.match(
    /^\/api\/procurement\/rfqs\/([^/]+)\/(open|cancel)$/,
  );
  if (req.method === "POST" && rfqAction)
    return respond(ctx, 200, async () => requestCommands(ctx).transitionRfq(decodeURIComponent(rfqAction[1]), rfqAction[2], await commandBody(ctx), ctx));
  return false;
}
