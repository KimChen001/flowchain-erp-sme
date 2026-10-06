import assert from "node:assert/strict";
import test from "node:test";
import { PriceHistoryError, createPriceHistoryReadService } from "../domain/price-history-read-service.mjs";
import { handlePriceHistoryRoute } from "./price-history.routes.mjs";

function routeContext({ path = "/api/procurement/price-history?key=ITEM-1%7Cpcs%7CUSD", method = "GET", authenticated = true, service, prisma } = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      req: { method },
      res: {},
      url: new URL(`http://localhost${path}`),
      identity: authenticated
        ? { authenticated: true, tenantId: "signed-tenant", userId: "signed-user", role: "buyer" }
        : { authenticated: false },
      priceHistoryService: service,
      priceHistoryPrisma: prisma,
      send: (_res, status, payload) => sent.push({ status, payload }),
    },
  };
}

test("the route answers only GET /api/procurement/price-history", async () => {
  assert.equal(await handlePriceHistoryRoute(routeContext({ method: "POST" }).ctx), false);
  assert.equal(await handlePriceHistoryRoute(routeContext({ path: "/api/procurement/price-history/x" }).ctx), false);
});

test("the route needs a signed-in reader", async () => {
  const route = routeContext({ authenticated: false, service: { read: async () => assert.fail("not read") } });
  assert.equal(await handlePriceHistoryRoute(route.ctx), true);
  assert.deepEqual(route.sent, [{ status: 401, payload: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } }]);
});

test("the route passes every key and the signed identity to the service", async () => {
  let observed;
  const payload = { histories: [], timeZone: "America/New_York", priceLabel: "purchase_order_price" };
  const route = routeContext({
    path: "/api/procurement/price-history?key=ITEM-1%7Cpcs%7CUSD&key=ITEM-2%7C%7CEUR",
    service: { read: async (keys, context) => { observed = { keys, tenantId: context.identity.tenantId }; return payload; } },
  });
  await handlePriceHistoryRoute(route.ctx);
  assert.deepEqual(observed, { keys: ["ITEM-1|pcs|USD", "ITEM-2||EUR"], tenantId: "signed-tenant" });
  assert.deepEqual(route.sent, [{ status: 200, payload }]);
});

test("the route maps permission and key errors, and hides unexpected ones", async (t) => {
  for (const [status, error] of [
    [403, Object.assign(new Error("Denied"), { name: "AuthorizationError", code: "AUTHORIZATION_PERMISSION_DENIED", status: 403 })],
    [422, new PriceHistoryError("PRICE_HISTORY_TOO_MANY_KEYS", "Ask for at most 50 items at a time.", 422)],
    [500, Object.assign(new Error("P2010 raw query failed at postgres://secret"), { code: "P2010" })],
  ]) {
    await t.test(String(status), async () => {
      const route = routeContext({ service: { read: async () => { throw error; } } });
      await handlePriceHistoryRoute(route.ctx);
      assert.equal(route.sent[0].status, status);
      assert.doesNotMatch(JSON.stringify(route.sent[0].payload), /secret/);
    });
  }
});

test("more than 50 keys are refused before the database is read", async () => {
  const keys = Array.from({ length: 51 }, (_, index) => `key=ITEM-${index}%7Cpcs%7CUSD`).join("&");
  const prisma = { $queryRawUnsafe: async () => assert.fail("not queried"), user: { findFirst: async () => assert.fail("not resolved") } };
  const route = routeContext({ path: `/api/procurement/price-history?${keys}`, service: createPriceHistoryReadService({ prisma }) });
  await handlePriceHistoryRoute(route.ctx);
  assert.equal(route.sent[0].status, 422);
  assert.equal(route.sent[0].payload.code, "PRICE_HISTORY_TOO_MANY_KEYS");
});

test("a reader without price rights gets the facts with prices masked", async () => {
  const rows = [{ lineId: "L1", purchaseOrderId: "PO-0031", orderNumber: null, supplierId: "S1", supplierName: "Acme", itemId: "ITEM-1", unit: "pcs", currency: "USD", unitPrice: "4.2000", orderedQuantity: "10.0000", issuedAt: new Date("2026-09-14T15:00:00Z"), createdAt: new Date("2026-09-10T15:00:00Z") }];
  let tenantAsked;
  const prisma = {
    $queryRawUnsafe: async (_sql, tenantId) => { tenantAsked = tenantId; return rows; },
    item: { findMany: async () => [] },
    tenant: { findUnique: async () => ({ timezone: "America/New_York" }) },
  };
  const resolveActor = async (_client, identity) => ({ tenantId: identity.tenantId, authenticated: true, complete: true, user: { id: identity.userId }, permissionCodes: new Set(["procurement.purchase_order.read"]) });
  const route = routeContext({ service: createPriceHistoryReadService({ prisma, resolveActor }) });
  await handlePriceHistoryRoute(route.ctx);
  assert.equal(tenantAsked, "signed-tenant");
  assert.equal(route.sent[0].status, 200);
  const { histories, restrictedFields } = route.sent[0].payload;
  assert.deepEqual(restrictedFields, ["unitPrice"]);
  assert.deepEqual([histories[0].latest.orderNumber, histories[0].latest.date, histories[0].latest.unitPrice], ["PO-0031", "2026-09-14", null]);
});
