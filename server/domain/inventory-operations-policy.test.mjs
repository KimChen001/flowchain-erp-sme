import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInventoryAdjustmentPostingPlan,
  buildInventoryAdjustmentReversalPlan,
  buildStockTransferPostingPlan,
} from "./inventory-operations-policy.mjs";

const tenantId = "tenant-1";

// Just enough of Prisma for the posting plans: documents by id, stock
// records by id or by (sku, warehouseKey, locationKey), and movements. Like
// Prisma, a null inside an `in` list is a validation error.
function fakePrisma({
  balances = [],
  movements = [],
  transfer = null,
  adjustment = null,
}) {
  const matches = (row, where) =>
    Object.entries(where).every(([field, value]) => {
      if (field === "OR") return value.some((part) => matches(row, part));
      if (value && typeof value === "object" && Array.isArray(value.in)) {
        if (value.in.some((entry) => entry == null))
          throw new Error("Argument `in`: Invalid value provided.");
        return value.in.includes(row[field]);
      }
      if (value && typeof value === "object" && Array.isArray(value.notIn))
        return !value.notIn.includes(row[field]);
      if (value && typeof value === "object" && "not" in value)
        return row[field] !== value.not && row[field] !== undefined;
      return row[field] === value;
    });
  return {
    stockTransferDocument: { findFirst: async () => transfer },
    inventoryAdjustmentDocument: { findFirst: async () => adjustment },
    inventoryBalance: {
      findMany: async ({ where }) =>
        balances.filter((row) => matches(row, where)),
    },
    inventoryMovement: {
      findMany: async ({ where }) =>
        movements.filter((row) => matches(row, where)),
      count: async ({ where }) =>
        movements.filter((row) => matches(row, where)).length,
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

const movement = (overrides = {}) => ({
  id: "movement-1",
  tenantId,
  sku: "SKU-1",
  warehouseId: "wh-b",
  locationKey: "open-01",
  movementType: "stock_transfer_in",
  reason: null,
  reversedByMovementId: null,
  ...overrides,
});

test("opening stock is refused on an emptied stock record that has history", async () => {
  const emptied = balance({
    id: "balance-b",
    warehouseId: "wh-b",
    warehouseKey: "wh-b",
    location: "OPEN-01",
    locationKey: "open-01",
    onHandQuantity: "0",
    availableQuantity: "0",
  });
  const plan = (movements) =>
    buildInventoryAdjustmentPostingPlan({
      prisma: fakePrisma({
        balances: [emptied],
        movements,
        adjustment: adjustmentWith("opening_balance", [
          { inventoryBalanceId: "balance-b", adjustmentQuantity: "5" },
        ]),
      }),
      tenantId,
      adjustmentId: "adjustment-1",
    });
  // Stock came in by transfer and went out again.
  const traded = await plan([
    movement({ id: "in-1" }),
    movement({ id: "out-1", movementType: "stock_transfer_out" }),
  ]);
  assert.equal(traded.allowed, false);
  assert.equal(
    traded.blockingIssues[0].code,
    "ADJUSTMENT_OPENING_BALANCE_EXISTS",
  );
  // An earlier opening entry that was posted and later emptied by trading.
  const openedBefore = await plan([
    movement({
      id: "open-1",
      movementType: "inventory_adjustment",
      reason: "opening_balance",
    }),
    movement({ id: "out-1", movementType: "shipment_posting" }),
  ]);
  assert.equal(openedBefore.allowed, false);
  // The only history is a reversed opening entry: the location may be
  // opened again.
  const reversedOpening = await plan([
    movement({
      id: "open-1",
      movementType: "inventory_adjustment",
      reason: "opening_balance",
      reversedByMovementId: "open-1-reversal",
    }),
    movement({
      id: "open-1-reversal",
      movementType: "inventory_adjustment_reversal",
    }),
  ]);
  assert.equal(reversedOpening.allowed, true);
});

test("quarantine movements at the same key are not history of the stock record", async () => {
  const emptied = balance({
    id: "balance-b",
    warehouseId: "wh-b",
    warehouseKey: "wh-b",
    location: "OPEN-01",
    locationKey: "open-01",
    onHandQuantity: "0",
    availableQuantity: "0",
  });
  const plan = (movements) =>
    buildInventoryAdjustmentPostingPlan({
      prisma: fakePrisma({
        balances: [emptied],
        movements,
        adjustment: adjustmentWith("opening_balance", [
          { inventoryBalanceId: "balance-b", adjustmentQuantity: "5" },
        ]),
      }),
      tenantId,
      adjustmentId: "adjustment-1",
    });
  const reversedOpening = [
    movement({
      id: "open-1",
      movementType: "inventory_adjustment",
      reason: "opening_balance",
      reversedByMovementId: "open-1-reversal",
    }),
    movement({
      id: "open-1-reversal",
      movementType: "inventory_adjustment_reversal",
    }),
  ];
  const quarantine = { balanceType: "quarantine", balanceId: "quarantine-b" };
  // A reversed opening plus a customer return received into quarantine and
  // sent back to the supplier from quarantine: the location may be opened.
  const quarantineOnly = await plan([
    ...reversedOpening,
    movement({
      id: "return-in-1",
      movementType: "customer_return_quarantine_in",
      metadata: quarantine,
    }),
    movement({
      id: "supplier-out-1",
      movementType: "supplier_return_out",
      metadata: quarantine,
    }),
  ]);
  assert.equal(quarantineOnly.allowed, true);
  // Released from quarantine into available stock: the available side counts.
  const released = await plan([
    ...reversedOpening,
    movement({
      id: "release-out-1",
      movementType: "quarantine_release_out",
      metadata: quarantine,
    }),
    movement({
      id: "release-in-1",
      movementType: "quarantine_release_available_in",
      metadata: { balanceType: "available", balanceId: "balance-b" },
    }),
  ]);
  assert.equal(released.allowed, false);
  assert.equal(
    released.blockingIssues[0].code,
    "ADJUSTMENT_OPENING_BALANCE_EXISTS",
  );
  // A supplier return from available stock, or one with no recorded balance
  // type, counts as history.
  for (const metadata of [
    { balanceType: "available", balanceId: "balance-b" },
    null,
  ]) {
    const returned = await plan([
      ...reversedOpening,
      movement({
        id: "supplier-out-1",
        movementType: "supplier_return_out",
        metadata,
      }),
    ]);
    assert.equal(returned.allowed, false);
  }
});

test("reverse preview of an unposted line without a stock record is a state refusal", async () => {
  const plan = await buildInventoryAdjustmentReversalPlan({
    prisma: fakePrisma({
      adjustment: adjustmentWith("opening_balance", [
        { adjustmentQuantity: "5" },
      ]),
    }),
    tenantId,
    adjustmentId: "adjustment-1",
  });
  assert.equal(plan.allowed, false);
  assert.equal(plan.blockingIssues[0].code, "ADJUSTMENT_ALREADY_POSTED");
  assert.equal(plan.blockingIssues[0].status, 409);
});
