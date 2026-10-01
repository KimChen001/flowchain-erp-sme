import assert from "node:assert/strict";
import test from "node:test";
import { handleInventoryRoute } from "./inventory.routes.mjs";

function routeContext(role) {
  let response;
  const touched = [];
  const inventoryRead = new Proxy(
    {},
    {
      get(_target, name) {
        touched.push(String(name));
        return async () => {
          throw new Error("repository(...).upsertItem is not a function");
        };
      },
    },
  );
  const ctx = {
    req: { method: "POST", headers: {} },
    res: {},
    url: new URL("/api/inventory/items", "http://localhost"),
    env: { FLOWCHAIN_PERSISTENCE_MODE: "database" },
    identity: {
      authenticated: true,
      tenantId: "tenant-test",
      userId: "user-test",
      role,
    },
    repositories: { inventoryRead },
    readBody: async () => {
      touched.push("readBody");
      return { sku: "X-1", itemName: "x", onHandQuantity: 1 };
    },
    send(_res, status, payload) {
      response = { status, payload };
    },
  };
  return { ctx, touched, response: () => response };
}

test("POST /api/inventory/items is refused as not implemented", async () => {
  const route = routeContext("manager");
  assert.equal(await handleInventoryRoute(route.ctx), true);
  assert.deepEqual(route.response(), {
    status: 501,
    payload: {
      code: "FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED",
      message:
        "Legacy inventory item mutation is not available. Use inventory transfers, cycle counts, or adjustments.",
      capability: "inventory",
      limitations: ["legacy_inventory_item_mutation_removed"],
    },
  });
  assert.deepEqual(route.touched, []);
  assert.doesNotMatch(
    JSON.stringify(route.response()),
    /upsertItem|is not a function|repository\(/,
  );
});

test("POST /api/inventory/items still requires a write role", async () => {
  const route = routeContext("viewer");
  assert.equal(await handleInventoryRoute(route.ctx), true);
  assert.equal(route.response().status, 403);
  assert.equal(route.response().payload.code, "PERMISSION_DENIED");
  assert.deepEqual(route.touched, []);
});
