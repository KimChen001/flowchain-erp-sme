import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInventoryAdjustmentPostingPlan,
  buildStockTransferPostingPlan,
} from "./inventory-operations-policy.mjs";

const tenantId = "tenant-1";

// Just enough of Prisma for the posting plans: documents by id and stock
// records by id or by (sku, warehouseKey, locationKey).
function fakePrisma({ balances = [], transfer = null, adjustment = null }) {
  const matches = (row, where) =>
    Object.entries(where).every(([field, value]) => {
      if (field === "OR") return value.some((part) => matches(row, part));
      if (value && typeof value === "object" && Array.isArray(value.in))
        return value.in.includes(row[field]);
      return row[field] === value;
    });
  return {
    stockTransferDocument: { findFirst: async () => transfer },
    inventoryAdjustmentDocument: { findFirst: async () => adjustment },
    inventoryBalance: {
      findMany: async ({ where }) =>
        balances.filter((row) => matches(row, where)),
    },
  };
}

const balance = (overrides = {}) => ({
  id: "balance-a",
  tenantId,
  itemId: "item-1",
  sku: "SKU-1",
  itemName: "Widget",
  warehouseId: "wh-a",
  warehouseKey: "wh-a",
  location: "A-01",
  locationKey: "a-01",
  onHandQuantity: "10",
  reservedQuantity: "0",
  availableQuantity: "10",
  unit: "EA",
  version: 3,
  ...overrides,
});

const transferTo = (destination) => ({
  id: "transfer-1",
  tenantId,
  workflowStatus: "ready",
  postingStatus: "unposted",
  version: 1,
  lines: [
    {
      id: "line-1",
      itemId: "item-1",
      sku: "SKU-1",
      itemName: "Widget",
      unit: "EA",
      quantity: "4",
      legs: [
        {
          id: "leg-source",
          direction: "source",
          warehouseId: "wh-a",
          location: "A-01",
          locationKey: "a-01",
        },
        { id: "leg-destination", direction: "destination", ...destination },
      ],
    },
  ],
});

const adjustmentWith = (reasonCode, lines) => ({
  id: "adjustment-1",
  tenantId,
  reasonCode,
  workflowStatus: "ready",
  postingStatus: "unposted",
  version: 1,
  lines: lines.map((line, index) => ({
    id: `adj-line-${index + 1}`,
    inventoryBalanceId: null,
    itemId: "item-1",
    sku: "SKU-1",
    itemName: "Widget",
    warehouseId: "wh-b",
    location: "OPEN-01",
    locationKey: "open-01",
    unit: "EA",
    ...line,
  })),
});

test("a transfer to a location with no stock record plans a new zero record", async () => {
  const plan = await buildStockTransferPostingPlan({
    prisma: fakePrisma({
      balances: [balance()],
      transfer: transferTo({
        warehouseId: "wh-b",
        location: "NEW-BIN",
        locationKey: "new-bin",
      }),
    }),
    tenantId,
    transferId: "transfer-1",
  });
  assert.equal(plan.allowed, true);
  const created = plan.balanceImpacts.find((row) => row.createsBalance);
  assert.ok(created);
  assert.equal(created.balanceId, null);
  assert.equal(created.onHandBefore, "0.0000");
  assert.equal(created.onHandAfter, "4.0000");
  assert.equal(created.version, 0);
  const source = plan.balanceImpacts.find((row) => !row.createsBalance);
  assert.equal(source.balanceId, "balance-a");
  assert.equal(source.onHandAfter, "6.0000");
  const inbound = plan.movementFacts.find(
    (row) => row.movementType === "stock_transfer_in",
  );
  assert.equal(inbound.balanceId, null);
  assert.equal(inbound.createsBalance, true);
});

test("a transfer still needs a source stock record", async () => {
  const plan = await buildStockTransferPostingPlan({
    prisma: fakePrisma({
      balances: [],
      transfer: transferTo({
        warehouseId: "wh-b",
        location: "NEW-BIN",
        locationKey: "new-bin",
      }),
    }),
    tenantId,
    transferId: "transfer-1",
  });
  assert.equal(plan.allowed, false);
  assert.deepEqual(
    plan.blockingIssues.map((row) => row.code),
    ["TRANSFER_SOURCE_BALANCE_NOT_FOUND"],
  );
  assert.equal(plan.balanceImpacts.length, 0);
});

test("found stock at a new location is allowed when positive and blocked when negative", async () => {
  const positive = await buildInventoryAdjustmentPostingPlan({
    prisma: fakePrisma({
      adjustment: adjustmentWith("found_stock", [
        { adjustmentQuantity: "2.5" },
      ]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(positive.allowed, true);
  assert.equal(positive.balanceImpacts.length, 1);
  assert.equal(positive.balanceImpacts[0].createsBalance, true);
  assert.equal(positive.balanceImpacts[0].onHandAfter, "2.5000");
  assert.equal(positive.movementFacts[0].createsBalance, true);

  const negative = await buildInventoryAdjustmentPostingPlan({
    prisma: fakePrisma({
      adjustment: adjustmentWith("found_stock", [
        { adjustmentQuantity: "-1" },
      ]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(negative.allowed, false);
  assert.ok(
    negative.blockingIssues.some(
      (row) => row.code === "ADJUSTMENT_NEGATIVE_INVENTORY",
    ),
  );
});

test("a line naming a key that already has a record resolves to that record", async () => {
  const plan = await buildInventoryAdjustmentPostingPlan({
    prisma: fakePrisma({
      balances: [
        balance({
          id: "balance-b",
          warehouseId: "wh-b",
          warehouseKey: "wh-b",
          location: "OPEN-01",
          locationKey: "open-01",
          onHandQuantity: "1",
          availableQuantity: "1",
        }),
      ],
      adjustment: adjustmentWith("found_stock", [{ adjustmentQuantity: "2" }]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.balanceImpacts[0].balanceId, "balance-b");
  assert.equal(plan.balanceImpacts[0].createsBalance, false);
  assert.equal(plan.balanceImpacts[0].onHandAfter, "3.0000");
});

test("opening stock is refused on a stock record that already holds stock", async () => {
  const plan = await buildInventoryAdjustmentPostingPlan({
    prisma: fakePrisma({
      balances: [
        balance({
          id: "balance-b",
          warehouseId: "wh-b",
          warehouseKey: "wh-b",
          location: "OPEN-01",
          locationKey: "open-01",
        }),
      ],
      adjustment: adjustmentWith("opening_balance", [
        { adjustmentQuantity: "5" },
      ]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(plan.allowed, false);
  assert.equal(plan.blockingIssues[0].code, "ADJUSTMENT_OPENING_BALANCE_EXISTS");
  assert.equal(plan.blockingIssues[0].status, 409);

  const zeroRow = await buildInventoryAdjustmentPostingPlan({
    prisma: fakePrisma({
      balances: [
        balance({
          id: "balance-b",
          warehouseId: "wh-b",
          warehouseKey: "wh-b",
          location: "OPEN-01",
          locationKey: "open-01",
          onHandQuantity: "0",
          availableQuantity: "0",
        }),
      ],
      adjustment: adjustmentWith("opening_balance", [
        { inventoryBalanceId: "balance-b", adjustmentQuantity: "5" },
      ]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(zeroRow.allowed, true);
  assert.equal(zeroRow.balanceImpacts[0].balanceId, "balance-b");
});

test("opening stock lines for the same key are combined into one new record", async () => {
  const plan = await buildInventoryAdjustmentPostingPlan({
    prisma: fakePrisma({
      adjustment: adjustmentWith("opening_balance", [
        { adjustmentQuantity: "3" },
        { adjustmentQuantity: "2", location: "open-01 " },
      ]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.balanceImpacts.length, 1);
  assert.equal(plan.balanceImpacts[0].quantity, "5.0000");
  assert.deepEqual(plan.balanceImpacts[0].lineIds, [
    "adj-line-1",
    "adj-line-2",
  ]);
  assert.equal(plan.movementFacts.length, 2);
});
