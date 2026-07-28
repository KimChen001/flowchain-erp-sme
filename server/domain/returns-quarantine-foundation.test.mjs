import assert from "node:assert/strict";
import test from "node:test";
import { handleInventoryRoute } from "../routes/inventory.routes.mjs";

const identity = {
  authenticated: true,
  tenantId: "tenant-returns",
  userId: "manager-returns",
  role: "manager",
};

function prismaFixture() {
  const calls = [];
  const available = {
    id: "available-balance-1",
    itemId: "item-1",
    sku: "SKU-RET-1",
    itemName: "Return Item",
    warehouseId: "warehouse-readable",
    location: "A-01",
    locationKey: "a-01",
    onHandQuantity: "10.0000",
    reservedQuantity: "2.0000",
    availableQuantity: "8.0000",
    unit: "EA",
    version: 3,
    updatedAt: new Date("2026-07-17T00:00:00Z"),
  };
  const quarantine = {
    id: "quarantine-balance-1",
    itemId: "item-1",
    sku: "SKU-RET-1",
    itemName: "Return Item",
    warehouseId: "warehouse-readable",
    location: "Q-01",
    locationKey: "q-01",
    onHandQuantity: "4.0000",
    unit: "EA",
    status: "active",
    version: 2,
    updatedAt: new Date("2026-07-17T00:00:00Z"),
  };
  return {
    calls,
    user: {
      findFirst: async () => ({
        id: identity.userId,
        tenantId: identity.tenantId,
        role: identity.role,
        status: "active",
        warehouseScopes: [
          { warehouseId: "warehouse-readable", accessLevel: "read" },
        ],
      }),
    },
    inventoryBalance: {
      findMany: async (args) => {
        calls.push({ model: "inventoryBalance", operation: "findMany", args });
        return [available];
      },
    },
    quarantineInventoryBalance: {
      count: async (args) => {
        calls.push({
          model: "quarantineInventoryBalance",
          operation: "count",
          args,
        });
        return 1;
      },
      findMany: async (args) => {
        calls.push({
          model: "quarantineInventoryBalance",
          operation: "findMany",
          args,
        });
        return [quarantine];
      },
    },
  };
}

async function route(path, { prisma = prismaFixture(), actor = identity, env } = {}) {
  let response;
  const ctx = {
    req: { method: "GET", headers: {} },
    res: {},
    url: new URL(path, "http://local"),
    db: {},
    identity: actor,
    inventoryPrisma: prisma,
    env: {
      FLOWCHAIN_PERSISTENCE_MODE: "database",
      FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: "false",
      ...env,
    },
    send(_res, status, payload) {
      response = { status, payload };
    },
  };
  assert.equal(await handleInventoryRoute(ctx), true);
  return { response, prisma };
}

test("available and quarantine selectors expose separate inventory classes", async () => {
  const prisma = prismaFixture();
  const available = await route(
    "/api/inventory/balances/select?sku=SKU-RET-1",
    { prisma },
  );
  assert.equal(available.response.status, 200);
  assert.equal(available.response.payload.inventoryClass, "available");
  assert.equal(available.response.payload.options.length, 1);
  assert.deepEqual(available.response.payload.options[0], {
    id: "available-balance-1",
    balanceType: "available",
    itemId: "item-1",
    sku: "SKU-RET-1",
    itemName: "Return Item",
    warehouseId: "warehouse-readable",
    location: "A-01",
    locationKey: "a-01",
    onHandQuantity: "10.0000",
    reservedQuantity: "2.0000",
    availableQuantity: "8.0000",
    quarantineQuantity: null,
    unit: "EA",
    version: 3,
    reservable: true,
  });

  const quarantined = await route(
    "/api/inventory/quarantine-balances/select?sku=SKU-RET-1",
    { prisma },
  );
  assert.equal(quarantined.response.status, 200);
  assert.equal(quarantined.response.payload.inventoryClass, "quarantine");
  assert.equal(quarantined.response.payload.capability.enabled, false);
  assert.equal(quarantined.response.payload.options.length, 1);
  assert.equal(
    quarantined.response.payload.options[0].balanceType,
    "quarantine",
  );
  assert.equal(quarantined.response.payload.options[0].reservable, false);
  assert.equal(quarantined.response.payload.options[0].availableQuantity, null);
  assert.equal(
    quarantined.response.payload.options[0].quarantineQuantity,
    "4.0000",
  );

  const availableCall = prisma.calls.find(
    (entry) => entry.model === "inventoryBalance",
  );
  assert.equal(availableCall.args.where.tenantId, identity.tenantId);
  assert.deepEqual(availableCall.args.where.availableQuantity, { gt: 0 });
  assert.deepEqual(availableCall.args.where.AND[0], {
    warehouseId: { in: ["warehouse-readable"] },
  });

  const quarantineCall = prisma.calls.find(
    (entry) =>
      entry.model === "quarantineInventoryBalance" &&
      entry.operation === "findMany",
  );
  assert.equal(quarantineCall.args.where.tenantId, identity.tenantId);
  assert.equal(quarantineCall.args.where.status, "active");
  assert.deepEqual(quarantineCall.args.where.onHandQuantity, { gt: 0 });
  assert.deepEqual(quarantineCall.args.where.AND[0], {
    warehouseId: { in: ["warehouse-readable"] },
  });
});

test("quarantine reads remain available while mutation capability is disabled", async () => {
  const disabled = await route("/api/inventory/quarantine-balances");
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.response.payload.capability.enabled, false);
  assert.equal(disabled.response.payload.capability.readReady, true);
  assert.equal(disabled.response.payload.capability.writeReady, false);
  assert.equal(disabled.response.payload.balances[0].reservedQuantity, null);

  const enabled = await route("/api/inventory/quarantine-balances", {
    env: { FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE: "true" },
  });
  assert.equal(enabled.response.payload.capability.enabled, true);
});

test("authoritative inventory selectors fail closed without authenticated identity", async () => {
  const anonymousQuarantine = await route("/api/inventory/quarantine-balances/select", {
    actor: { authenticated: false },
  });
  assert.equal(anonymousQuarantine.response.status, 401);
  assert.equal(
    anonymousQuarantine.response.payload.code,
    "AUTHENTICATION_REQUIRED",
  );

  const anonymous = await route("/api/inventory/balances/select", {
    actor: { authenticated: false },
  });
  assert.equal(anonymous.response.status, 401);
  assert.equal(
    anonymous.response.payload.code,
    "AUTHENTICATION_REQUIRED",
  );
});
