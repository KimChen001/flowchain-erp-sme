import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createPrismaClient } from "../persistence/prisma-client.mjs";
import { realPostgresSuiteGate } from "../persistence/test-db-harness.mjs";
import {
  createOutboundPostingCommandService,
  outboundRequestHash,
} from "./outbound-posting-command-service.mjs";
import { createOutboundQueryService } from "./outbound-query-service.mjs";
import {
  buildSalesOrderReservationPlan,
  buildShipmentReversalPlan,
  outboundDecimalString,
  outboundDecimalUnits,
} from "./outbound-transaction-policy.mjs";
import {
  createSalesOrderReadService,
  createSalesOrderWorkbenchService,
} from "./sales-order-workbench-service.mjs";
import { createOutboundWorkbenchReadService } from "./outbound-workbench-read-service.mjs";
import { createInventoryAuthoritativeReadService } from "./inventory-authoritative-read-service.mjs";
import { handleSalesOrderWorkbenchRoute } from "../routes/sales-order-workbench.routes.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// The order page's whole-order plans (src/modules/sales/outboundPlans.ts),
// bundled so this suite sends what the page sends.
async function loadOutboundPlans() {
  const directory = await mkdtemp(join(tmpdir(), "flowchain-outbound-plans-"));
  const result = await build({ entryPoints: [resolve(import.meta.dirname, "../../src/modules/sales/outboundPlans.ts")], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  const file = join(directory, "plans.mjs");
  await writeFile(file, result.outputFiles[0].text);
  try { return await import(pathToFileURL(file).href); } finally { await rm(directory, { recursive: true, force: true }); }
}

const gate = realPostgresSuiteGate("npm run test:db:outbound");
const realPostgres = gate.enabled;
const env = {
  ...process.env,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "true",
};
let prisma;
if (!realPostgres) {
  // Must report SKIP, not a pass. This suite is the outbound quantity,
  // reservation and concurrency coverage; a green line for a suite that never
  // executed is worse than no line at all.
  if (gate.failure) {
    test("outbound PostgreSQL transaction suite is misconfigured", () => {
      throw new Error(gate.failure);
    });
  } else {
    test("outbound PostgreSQL transactions run in the isolated test:db:outbound gate", { skip: gate.skipReason }, () => {});
  }
} else {
  before(async () => {
    prisma = await createPrismaClient(env);
  });
  after(async () => {
    await prisma?.$disconnect();
  });

  const identity = (tenantId, userId, role = "manager") => ({
    identity: {
      authenticated: true,
      tenantId,
      userId,
      role,
      source: "signed-session",
    },
  });
  const command = (client = prisma) =>
    createOutboundPostingCommandService({ prisma: client, env });
  const fixed = (value) => outboundDecimalString(outboundDecimalUnits(value));
  const enabledWorkbenchCapabilities = {
    lifecycle: { enabled: true },
    reservation: { enabled: true },
    shipmentDraft: { enabled: true },
    shipmentPosting: { enabled: true },
    shipmentReversal: { enabled: true },
  };
  const enabledQueryCapabilities = {
    "sales-reservation": { enabled: true },
    "sales-shipment-draft": { enabled: true },
    "sales-shipment-posting": { enabled: true },
    "sales-shipment-reversal": { enabled: true },
  };

  test("stable request hashing ignores object insertion and business-array order", () => {
    const a = {
      salesOrderId: "SO-1",
      allocations: [
        { warehouseId: "B", quantity: "1" },
        { quantity: "2", warehouseId: "A" },
      ],
    };
    const b = {
      allocations: [
        { warehouseId: "A", quantity: "2" },
        { quantity: "1", warehouseId: "B" },
      ],
      salesOrderId: "SO-1",
    };
    assert.equal(outboundRequestHash(a), outboundRequestHash(b));
  });

  test("an order for a chosen customer keeps the customer's id and recorded name, and entry data lists active customers", async () => {
    const base = await seed(),
      other = await seed(),
      ctx = identity(base.tenantId, base.actorId),
      service = createSalesOrderWorkbenchService({ prisma });
    const customer = (tenantId, code, name, extra = {}) => ({
      id: randomUUID(),
      tenantId,
      namespace: "master-data.customers",
      recordKey: code,
      payload: { id: `${code}-ID`, code, name, status: "active", ...extra },
    });
    await prisma.runtimeRecord.createMany({
      data: [
        customer(base.tenantId, "CUST-RW", "Redwood Plumbing", { currency: "USD", paymentTerms: "NET30" }),
        customer(base.tenantId, "CUST-OLD", "Closed Account", { status: "inactive" }),
        customer(other.tenantId, "CUST-FOREIGN", "Other Workspace Customer"),
      ],
    });
    const entry = await createSalesOrderReadService({ prisma, lifecycleCapability: { enabled: true } }).entryData(ctx);
    assert.deepEqual(
      entry.customers.map((row) => [row.id, row.code, row.name, row.currency, row.paymentTerms]),
      [["CUST-RW-ID", "CUST-RW", "Redwood Plumbing", "USD", "NET30"]],
    );
    const order = (customerId, extra = {}) => ({
      customerId,
      customerName: "redwood plumbng",
      currency: "USD",
      idempotencyKey: `customer-${randomUUID()}`,
      lines: [{ itemId: base.itemId, quantity: "2", unitPrice: "5" }, { itemId: base.itemId, quantity: "1", unitPrice: "4" }],
      ...extra,
    });
    // The name recorded in Customers wins over a typed one.
    const created = await service.createOrder(order("CUST-RW-ID", { promisedDate: "2026-10-20T12:00:00.000Z" }), ctx);
    assert.deepEqual(
      [created.order.customerId, created.order.customerName, created.order.lines.length, created.order.promisedDate],
      ["CUST-RW-ID", "Redwood Plumbing", 2, "2026-10-20T12:00:00.000Z"],
    );
    // Inactive, unknown and another workspace's customers are refused.
    for (const customerId of ["CUST-OLD-ID", "CUST-NOPE", "CUST-FOREIGN-ID"]) {
      await assert.rejects(service.createOrder(order(customerId), ctx), (error) => error.code === "SALES_ORDER_CUSTOMER_NOT_FOUND");
    }
    // A revision may name the customer by code, and keeps every line sent.
    const revised = await service.reviseOrder(
      created.order.id,
      {
        expectedOrderVersion: created.order.version,
        idempotencyKey: `customer-revise-${randomUUID()}`,
        revisionMode: "replace_all",
        expectedLineIds: created.order.lines.map((line) => line.id),
        header: { customerId: "CUST-RW", currency: "USD", promisedDate: null },
        lines: [{ itemId: base.itemId, quantity: "3", unitPrice: "5" }, { itemId: base.itemId, quantity: "2", unitPrice: "4" }],
      },
      ctx,
    );
    assert.deepEqual(
      [revised.order.customerId, revised.order.customerName, revised.order.lines.map((line) => line.orderedQuantity), revised.order.promisedDate],
      ["CUST-RW-ID", "Redwood Plumbing", ["3.0000", "2.0000"], null],
    );
  });

  test("authoritative sales order lifecycle creates, revises, confirms, holds, resumes, and paginates", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId),
      service = createSalesOrderWorkbenchService({ prisma });
    await prisma.runtimeRecord.create({ data: { id: randomUUID(), tenantId: base.tenantId, namespace: "master-data.customers", recordKey: "CUST-LIFE", payload: { id: "CUST-LIFE-ID", code: "CUST-LIFE", name: "Lifecycle Revised", status: "active" } } });
    const created = await service.createOrder(
      {
        customerName: "Lifecycle Customer",
        currency: "USD",
        idempotencyKey: "lifecycle-create",
        lines: [{ itemId: base.itemId, quantity: "2.5000" }],
      },
      ctx,
    );
    assert.equal(created.order.workflowStatus, "draft");
    assert.match(created.order.orderNumber, /^SO-\d{6}-\d{4,}$/);
    assert.deepEqual(
      [
        created.order.lines[0].sku,
        created.order.lines[0].itemName,
        created.order.lines[0].orderedQuantity,
      ],
      [
        (await prisma.item.findUnique({ where: { id: base.itemId } })).sku,
        "出库测试物料",
        "2.5000",
      ],
    );
    assert.equal(
      (
        await service.createOrder(
          {
            orderNumber: created.order.orderNumber,
            customerName: "Lifecycle Customer",
            currency: "USD",
            idempotencyKey: "lifecycle-create",
            lines: [{ itemId: base.itemId, quantity: "2.5000" }],
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    const revised = await service.reviseOrder(
      created.order.id,
      {
        expectedOrderVersion: 0,
        idempotencyKey: "lifecycle-revise",
        revisionMode: "replace_all",
        expectedLineIds: created.order.lines.map((line) => line.id),
        header: { customerId: "CUST-LIFE-ID", currency: "CNY" },
        lines: [{ itemId: base.itemId, quantity: "3", unitPrice: "4" }],
      },
      ctx,
    );
    const confirmed = await service.confirmOrder(
      created.order.id,
      {
        expectedOrderVersion: revised.order.version,
        idempotencyKey: "lifecycle-confirm",
      },
      ctx,
    );
    assert.equal(
      (
        await service.confirmOrder(
          created.order.id,
          {
            expectedOrderVersion: revised.order.version,
            idempotencyKey: "lifecycle-confirm",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    await assert.rejects(
      () =>
        service.confirmOrder(
          created.order.id,
          {
            expectedOrderVersion: confirmed.order.version,
            idempotencyKey: "lifecycle-confirm",
          },
          ctx,
        ),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
    const held = await service.holdOrder(
      created.order.id,
      {
        expectedOrderVersion: confirmed.order.version,
        idempotencyKey: "lifecycle-hold",
      },
      ctx,
    );
    assert.equal(
      (
        await service.holdOrder(
          created.order.id,
          {
            expectedOrderVersion: confirmed.order.version,
            idempotencyKey: "lifecycle-hold",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    const resumed = await service.resumeOrder(
      created.order.id,
      {
        expectedOrderVersion: held.order.version,
        idempotencyKey: "lifecycle-resume",
      },
      ctx,
    );
    assert.equal(
      (
        await service.resumeOrder(
          created.order.id,
          {
            expectedOrderVersion: held.order.version,
            idempotencyKey: "lifecycle-resume",
          },
          ctx,
        )
      ).idempotentReplay,
      true,
    );
    assert.equal(resumed.order.workflowStatus, "confirmed");
    await assert.rejects(
      () =>
        service.reviseOrder(
          created.order.id,
          {
            expectedOrderVersion: resumed.order.version,
            idempotencyKey: "lifecycle-invalid-edit",
            revisionMode: "replace_all",
            expectedLineIds: revised.order.lines.map((line) => line.id),
            header: {},
            lines: [{ itemId: base.itemId, quantity: "1" }],
          },
          ctx,
        ),
      (error) => error.code === "SALES_ORDER_INVALID_STATE",
    );
    const listed = await createSalesOrderReadService({ prisma }).listOrders(
      { page: 1, pageSize: 1, search: "Lifecycle Revised" },
      ctx,
    );
    assert.deepEqual(
      [listed.total, listed.orders.length, listed.dataSource],
      [1, 1, "Authoritative PostgreSQL"],
    );
    assert.equal(
      await prisma.auditLog.count({
        where: { tenantId: base.tenantId, entityId: created.order.id },
      }),
      5,
    );
    assert.equal(
      await prisma.businessCommandExecution.count({
        where: {
          tenantId: base.tenantId,
          commandType: {
            in: [
              "confirm_sales_order",
              "hold_sales_order",
              "resume_sales_order",
            ],
          },
        },
      }),
      3,
    );
  });

  // Document numbering (owner decisions 2026-11-04): the server gives each
  // sales order SO-YYYYMM-NNNN and each shipment draft DN-YYYYMM-NNNN, the
  // sequence per workspace, type and workspace month. A client number is ignored.
  // Design audit L4-13, L4-14, L4-26: an order could be confirmed with no
  // price (invoicing refused it only after it shipped) or for a customer that
  // was inactive or restricted, and a revision that left the customer out
  // cleared it.
  test("confirming needs a price on every line and an active, unrestricted customer; a revision keeps what it leaves out", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId),
      service = createSalesOrderWorkbenchService({ prisma });
    const customer = (code, extra = {}) => ({ id: randomUUID(), tenantId: base.tenantId, namespace: "master-data.customers", recordKey: code, payload: { id: `${code}-ID`, code, name: `${code} Ltd`, status: "active", ...extra } });
    await prisma.runtimeRecord.createMany({ data: [customer("CONF-OK"), customer("CONF-RESTRICTED"), customer("CONF-LEGACY", { creditStatus: "受限" })] });
    const draft = async (key, extra = {}) => (await service.createOrder({ customerId: "CONF-OK-ID", currency: "USD", idempotencyKey: key, promisedDate: "2026-11-30T12:00:00.000Z", lines: [{ itemId: base.itemId, quantity: "1", unitPrice: "5" }], ...extra }, ctx)).order;
    const confirm = (order, key) => service.confirmOrder(order.id, { expectedOrderVersion: order.version, idempotencyKey: key }, ctx);

    // A line without a price: refused, naming the line. Zero is a price (a free item).
    const unpriced = await draft("conf-unpriced", { lines: [{ itemId: base.itemId, quantity: "1" }] });
    await assert.rejects(confirm(unpriced, "conf-unpriced-confirm"), (error) => error.code === "SALES_ORDER_PRICE_REQUIRED" && error.details.lineIds.length === 1);
    const free = await draft("conf-free", { lines: [{ itemId: base.itemId, quantity: "1", unitPrice: "0" }] });
    assert.equal((await confirm(free, "conf-free-confirm")).order.workflowStatus, "confirmed");

    // A customer typed in, not chosen from Customers: refused.
    const typed = (await service.createOrder({ customerName: "Walk-in", currency: "USD", idempotencyKey: "conf-typed", lines: [{ itemId: base.itemId, quantity: "1", unitPrice: "5" }] }, ctx)).order;
    await assert.rejects(confirm(typed, "conf-typed-confirm"), (error) => error.code === "SALES_ORDER_CUSTOMER_REQUIRED");

    // Restricted (as a code, or the Chinese word older records hold), or inactive since: refused.
    const restricted = await draft("conf-restricted", { customerId: "CONF-RESTRICTED-ID" });
    await prisma.runtimeRecord.updateMany({ where: { tenantId: base.tenantId, recordKey: "CONF-RESTRICTED" }, data: { payload: { id: "CONF-RESTRICTED-ID", code: "CONF-RESTRICTED", name: "CONF-RESTRICTED Ltd", status: "active", creditStatus: "restricted" } } });
    await assert.rejects(confirm(restricted, "conf-restricted-confirm"), (error) => error.code === "SALES_ORDER_CUSTOMER_RESTRICTED");
    const legacy = await draft("conf-legacy", { customerId: "CONF-LEGACY-ID" });
    await assert.rejects(confirm(legacy, "conf-legacy-confirm"), (error) => error.code === "SALES_ORDER_CUSTOMER_RESTRICTED");
    const closed = await draft("conf-closed")
    await prisma.runtimeRecord.updateMany({ where: { tenantId: base.tenantId, recordKey: "CONF-OK" }, data: { payload: { id: "CONF-OK-ID", code: "CONF-OK", name: "CONF-OK Ltd", status: "inactive" } } });
    await assert.rejects(confirm(closed, "conf-closed-confirm"), (error) => error.code === "SALES_ORDER_CUSTOMER_NOT_FOUND");
    await prisma.runtimeRecord.updateMany({ where: { tenantId: base.tenantId, recordKey: "CONF-OK" }, data: { payload: { id: "CONF-OK-ID", code: "CONF-OK", name: "CONF-OK Ltd", status: "active" } } });

    // A revision that sends only lines keeps the customer and the promised date.
    const kept = await draft("conf-keep");
    const revised = (await service.reviseOrder(kept.id, { expectedOrderVersion: kept.version, idempotencyKey: "conf-keep-revise", revisionMode: "replace_all", expectedLineIds: kept.lines.map((line) => line.id), header: {}, lines: [{ itemId: base.itemId, quantity: "2", unitPrice: "5" }] }, ctx)).order;
    assert.deepEqual([revised.customerId, revised.customerName, revised.promisedDate?.slice(0, 10)], ["CONF-OK-ID", "CONF-OK Ltd", "2026-11-30"]);
    // Sent empty, the promised date is cleared.
    const cleared = (await service.reviseOrder(kept.id, { expectedOrderVersion: revised.version, idempotencyKey: "conf-keep-clear", revisionMode: "replace_all", expectedLineIds: revised.lines.map((line) => line.id), header: { promisedDate: null }, lines: [{ itemId: base.itemId, quantity: "2", unitPrice: "5" }] }, ctx)).order;
    assert.deepEqual([cleared.customerId, cleared.promisedDate], ["CONF-OK-ID", null]);
  });

  // Design audit L4-03: deactivating an item stopped every open order with it
  // from shipping, a wrong shipment from being reversed, and the order from
  // being held or resumed.
  test("an item deactivated after the order was confirmed still reserves, ships, reverses, holds and resumes", async () => {
    const ids = await seed();
    const service = command();
    const ctx = identity(ids.tenantId, ids.actorId);
    await prisma.item.update({ where: { id: ids.itemId }, data: { status: "inactive" } });
    const reserved = await service.reserveSalesOrderInventory(reserveInput(ids, "4.0000", "inactive-reserve"), ctx);
    const reservationId = reserved.reservations[0].id;
    const drafted = await service.createShipmentDraft({ salesOrderId: ids.salesOrderId, expectedOrderVersion: 1, idempotencyKey: "inactive-draft", lines: [{ salesOrderLineId: ids.salesOrderLineId, allocations: [{ reservationId, quantity: "4.0000" }] }] }, ctx);
    const posted = await service.postShipment({ shipmentId: drafted.shipment.id, expectedShipmentVersion: 0, idempotencyKey: "inactive-post" }, ctx);
    assert.equal(posted.movementIds.length, 1);
    const reversed = await service.reverseShipment({ shipmentId: drafted.shipment.id, expectedShipmentVersion: 1, idempotencyKey: "inactive-reverse", reason: "Wrong item sent" }, ctx);
    assert.equal(reversed.movementIds.length, 1);
    // Hold and resume read the lines again, without asking for an active item.
    const workbench = createSalesOrderWorkbenchService({ prisma });
    const order = await prisma.salesOrder.findUnique({ where: { id: ids.salesOrderId } });
    const held = await workbench.holdOrder(ids.salesOrderId, { expectedOrderVersion: order.version, idempotencyKey: "inactive-hold" }, ctx);
    const resumed = await workbench.resumeOrder(ids.salesOrderId, { expectedOrderVersion: held.order.version, idempotencyKey: "inactive-resume" }, ctx);
    assert.equal(resumed.order.workflowStatus, "confirmed");
    // A new order with the item is still refused.
    await assert.rejects(workbench.createOrder({ customerName: "New order", currency: "USD", idempotencyKey: "inactive-new", lines: [{ itemId: ids.itemId, quantity: "1", unitPrice: "1" }] }, ctx), (error) => error.code === "SALES_ORDER_ITEM_INVALID");
  });

  test("sales orders are numbered SO-YYYYMM-NNNN by the server in the workspace month; a client number is ignored", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId);
    // 03:30 UTC on Dec 1 is still Nov 30 in New York, the workspace timezone.
    let at = new Date("2026-12-01T03:30:00.000Z");
    const service = createSalesOrderWorkbenchService({ prisma, now: () => at });
    const order = (key, extra = {}) => ({
      customerName: "Numbered Customer",
      currency: "USD",
      idempotencyKey: key,
      lines: [{ itemId: base.itemId, quantity: "1" }],
      ...extra,
    });
    const first = await service.createOrder(order("number-first", { orderNumber: "CLIENT-SO-1" }), ctx);
    const second = await service.createOrder(order("number-second", { orderNumber: "CLIENT-SO-1" }), ctx);
    assert.deepEqual([first.order.orderNumber, second.order.orderNumber], ["SO-202611-0001", "SO-202611-0002"]);
    assert.equal(await prisma.salesOrder.count({ where: { tenantId: base.tenantId, orderNumber: "CLIENT-SO-1" } }), 0);
    assert.equal((await prisma.salesOrder.findUnique({ where: { id: second.order.id } })).orderNumber, "SO-202611-0002");
    // A different client number on a replay changes nothing.
    const replay = await service.createOrder(order("number-first", { orderNumber: "CLIENT-SO-OTHER" }), ctx);
    assert.deepEqual([replay.idempotentReplay, replay.order.orderNumber], [true, "SO-202611-0001"]);
    // The same moment in a Shanghai workspace is already December; a number
    // the workspace already has (typed before this rule) is skipped.
    await prisma.tenant.update({ where: { id: base.tenantId }, data: { timezone: "Asia/Shanghai" } });
    const december = await service.createOrder(order("number-december"), ctx);
    assert.equal(december.order.orderNumber, "SO-202612-0001");
    await prisma.salesOrder.create({ data: { id: `typed-${base.tenantId}`, tenantId: base.tenantId, orderNumber: "SO-202612-0002", customerName: "Typed Before", currency: "USD" } });
    at = new Date("2026-12-15T15:00:00.000Z");
    assert.equal((await service.createOrder(order("number-skip"), ctx)).order.orderNumber, "SO-202612-0003");
  });

  test("two sales orders saved at the same moment get consecutive numbers", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId);
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const at = () => new Date("2026-11-04T15:00:00.000Z");
      const create = (client, key) =>
        createSalesOrderWorkbenchService({ prisma: client, now: at }).createOrder(
          { customerName: "Race Customer", currency: "USD", idempotencyKey: key, lines: [{ itemId: base.itemId, quantity: "1" }] },
          ctx,
        );
      const results = await Promise.allSettled([create(clientA, "race-a"), create(clientB, "race-b")]);
      assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results.map((result) => result.reason?.code || result.reason?.message)));
      assert.deepEqual(results.map((result) => result.value.order.orderNumber).sort(), ["SO-202611-0001", "SO-202611-0002"]);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("shipment drafts are numbered DN-YYYYMM-NNNN by the server in the workspace month; a client number is ignored", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId);
    const at = new Date("2026-12-01T03:30:00.000Z");
    const service = createOutboundPostingCommandService({ prisma, env, now: () => at });
    const reserved = await service.reserveSalesOrderInventory(reserveInput(ids, "3", "number-reserve"), ctx);
    const reservationId = reserved.reservations[0].id;
    const lines = [{ salesOrderLineId: ids.salesOrderLineId, allocations: [{ reservationId, quantity: "1" }] }];
    // The preview has no number to show.
    const preview = await createOutboundQueryService({ prisma, capabilities: enabledQueryCapabilities })
      .previewShipmentDraft({ salesOrderId: ids.salesOrderId, shipmentNumber: "CLIENT-DN-1", lines }, ctx);
    assert.equal(preview.allowed, true);
    assert.equal(preview.normalizedPlan.shipmentNumber, undefined);
    const draft = (version, key) =>
      service.createShipmentDraft({ salesOrderId: ids.salesOrderId, shipmentNumber: "CLIENT-DN-1", expectedOrderVersion: version, idempotencyKey: key, lines }, ctx);
    const first = await draft(1, "number-draft-1");
    const second = await draft(2, "number-draft-2");
    assert.deepEqual([first.shipment.shipmentNumber, second.shipment.shipmentNumber], ["DN-202611-0001", "DN-202611-0002"]);
    assert.equal(await prisma.shipmentDocument.count({ where: { tenantId: ids.tenantId, shipmentNumber: "CLIENT-DN-1" } }), 0);
    assert.equal((await prisma.shipmentDocument.findUnique({ where: { id: second.entityId } })).shipmentNumber, "DN-202611-0002");
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { timezone: "Asia/Shanghai" } });
    assert.equal((await draft(3, "number-draft-3")).shipment.shipmentNumber, "DN-202612-0001");
  });

  test("multi-line draft replacement requires a complete replace_all line identity contract", async () => {
    const base = await seed(),
      ctx = identity(base.tenantId, base.actorId),
      service = createSalesOrderWorkbenchService({ prisma });
    const created = await service.createOrder(
      {
        customerName: "Multi Draft",
        currency: "CNY",
        idempotencyKey: "multi-draft-create",
        lines: [
          { itemId: base.itemId, quantity: "1" },
          { itemId: base.itemId, quantity: "2" },
          { itemId: base.itemId, quantity: "3" },
        ],
      },
      ctx,
    );
    const originalIds = created.order.lines.map((line) => line.id),
      originalQuantities = created.order.lines.map(
        (line) => line.orderedQuantity,
      );
    const foreign = await service.createOrder(
      {
        customerName: "Foreign Draft",
        currency: "CNY",
        idempotencyKey: "foreign-draft-create",
        lines: [{ itemId: base.itemId, quantity: "1" }],
      },
      ctx,
    );
    const incompleteCases = [
      { key: "missing-mode", revisionMode: "", expectedLineIds: originalIds },
      { key: "missing-ids", revisionMode: "replace_all", expectedLineIds: [] },
      {
        key: "one-id",
        revisionMode: "replace_all",
        expectedLineIds: originalIds.slice(0, 1),
      },
      {
        key: "extra-id",
        revisionMode: "replace_all",
        expectedLineIds: [...originalIds, "unknown-line"],
      },
      {
        key: "foreign-id",
        revisionMode: "replace_all",
        expectedLineIds: [
          originalIds[0],
          originalIds[1],
          foreign.order.lines[0].id,
        ],
      },
    ];
    for (const item of incompleteCases) {
      await assert.rejects(
        () =>
          service.reviseOrder(
            created.order.id,
            {
              expectedOrderVersion: 0,
              idempotencyKey: `multi-${item.key}`,
              revisionMode: item.revisionMode,
              expectedLineIds: item.expectedLineIds,
              header: { customerName: "Unsafe replacement" },
              lines: [{ itemId: base.itemId, quantity: "9" }],
            },
            ctx,
          ),
        (error) =>
          error.code === "SALES_ORDER_DRAFT_REVISION_INCOMPLETE" &&
          error.status === 409,
      );
      const unchanged = await prisma.salesOrder.findUnique({
        where: { id: created.order.id },
        include: { lines: { orderBy: { id: "asc" } } },
      });
      assert.deepEqual(
        unchanged.lines.map((line) => line.id),
        originalIds,
      );
      assert.deepEqual(
        unchanged.lines.map((line) => fixed(line.orderedQuantity)),
        originalQuantities,
      );
    }
    const workbench = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    }).orderWorkbench(created.order.id, ctx);
    // The draft editor sends every line, so a multi-line draft can be edited.
    assert.equal(workbench.availableActions.canEditDraft, true);
    assert.ok(
      !workbench.availableActions.blockingReasonCodes.includes(
        "MULTI_LINE_DRAFT_EDITOR_NOT_AVAILABLE",
      ),
    );
    const completeInput = {
      expectedOrderVersion: 0,
      idempotencyKey: "multi-complete-replace",
      revisionMode: "replace_all",
      expectedLineIds: originalIds,
      header: { customerName: "Safe replacement" },
      lines: [
        { itemId: base.itemId, quantity: "4" },
        { itemId: base.itemId, quantity: "5" },
        { itemId: base.itemId, quantity: "6" },
      ],
    };
    const revised = await service.reviseOrder(
      created.order.id,
      completeInput,
      ctx,
    );
    assert.deepEqual(
      revised.order.lines.map((line) => line.orderedQuantity).sort(),
      ["4.0000", "5.0000", "6.0000"],
    );
    assert.equal(
      (await service.reviseOrder(created.order.id, completeInput, ctx))
        .idempotentReplay,
      true,
    );
    assert.equal(
      await prisma.businessCommandExecution.count({
        where: {
          tenantId: base.tenantId,
          commandType: "revise_sales_order_draft",
          idempotencyKey: "multi-complete-replace",
        },
      }),
      1,
    );
  });

  // Design audit L4-08, L4-28: "Reserve all" and "Ship all" on the order
  // page send every line in one request, so a two-line order makes one
  // shipment, not two. The shipment list reads it in the reader's warehouses,
  // and with the outbound write switch off the list and the shipment page
  // still read.
  test("reserve all and ship all make one multi-line shipment, which the list and the shipment page read with writes off", async () => {
    const { reserveAllPlan, shipAllPlan } = await loadOutboundPlans();
    const ids = await seed({ stock: "10.0000", ordered: "6.0000" });
    const ctx = identity(ids.tenantId, ids.actorId);
    const suffix = randomUUID(),
      itemB = `item-b-${suffix}`,
      skuB = `SKU-B-${suffix}`;
    await prisma.item.create({ data: { id: itemB, tenantId: ids.tenantId, sku: skuB, name: "Second item", unit: "EA" } });
    await prisma.inventoryBalance.create({
      data: { id: `bal-b-${suffix}`, tenantId: ids.tenantId, itemId: itemB, sku: skuB, itemName: "Second item", warehouseId: ids.warehouseId, warehouseKey: ids.warehouseId, location: "B-01", locationKey: "b-01", onHandQuantity: "5", reservedQuantity: "0", availableQuantity: "5", unit: "EA", status: "available" },
    });
    await prisma.salesOrderLine.create({
      data: { id: `sol-b-${suffix}`, salesOrderId: ids.salesOrderId, itemId: itemB, sku: skuB, itemName: "Second item", orderedQuantity: "3", unit: "EA" },
    });
    const read = createOutboundWorkbenchReadService({ prisma, capabilities: enabledWorkbenchCapabilities });

    // Reserve all: one request covers both lines.
    let work = await read.orderWorkbench(ids.salesOrderId, ctx);
    const reservePlan = reserveAllPlan(work.lines, work.availability);
    assert.deepEqual(reservePlan.short, []);
    assert.deepEqual(reservePlan.allocations.map((row) => [row.salesOrderLineId === ids.salesOrderLineId ? "A" : "B", row.quantity]).sort(), [["A", "6"], ["B", "3"]]);
    await command().reserveSalesOrderInventory({ salesOrderId: ids.salesOrderId, expectedOrderVersion: work.order.version, idempotencyKey: `reserve-all-${suffix}`, allocations: reservePlan.allocations }, ctx);

    // Ship all: one shipment, one number, both lines.
    work = await read.orderWorkbench(ids.salesOrderId, ctx);
    assert.equal(work.order.reservationStatus, "fully_reserved");
    const shipPlan = shipAllPlan(work.lines, work.reservations);
    assert.equal(shipPlan.length, 2);
    const drafted = await command().createShipmentDraft({ salesOrderId: ids.salesOrderId, expectedOrderVersion: work.order.version, idempotencyKey: `ship-all-${suffix}`, lines: shipPlan }, ctx);
    const shipments = await prisma.shipmentDocument.findMany({ where: { tenantId: ids.tenantId, salesOrderId: ids.salesOrderId }, include: { lines: true } });
    assert.equal(shipments.length, 1);
    assert.equal(shipments[0].id, drafted.shipment.id);
    assert.deepEqual(shipments[0].lines.map((line) => fixed(line.requestedQuantity)).sort(), ["3.0000", "6.0000"]);
    // Nothing is left to ship on another draft.
    assert.deepEqual(shipAllPlan((await read.orderWorkbench(ids.salesOrderId, ctx)).lines, (await read.orderWorkbench(ids.salesOrderId, ctx)).reservations), []);

    // The list: the shipment with its two lines, the counts, the filters.
    const listed = await read.listShipments({}, ctx);
    assert.equal(listed.total, 1);
    assert.deepEqual(
      [listed.shipments[0].shipmentNumber, listed.shipments[0].lineCount, listed.shipments[0].quantity, listed.shipments[0].unit, listed.shipments[0].warehouseIds],
      [drafted.shipment.shipmentNumber, 2, "9.0000", "EA", [ids.warehouseId]],
    );
    assert.deepEqual(listed.counts, { all: 1, to_post: 1, posted: 0, reversed: 0, cancelled: 0 });
    assert.equal((await read.listShipments({ status: "posted" }, ctx)).total, 0);
    assert.equal((await read.listShipments({ search: skuB.toLowerCase() }, ctx)).total, 1);
    assert.equal((await read.listShipments({ search: "no-such-shipment" }, ctx)).total, 0);
    await command().postShipment({ shipmentId: drafted.shipment.id, expectedShipmentVersion: drafted.shipment.version, idempotencyKey: `ship-all-post-${suffix}` }, ctx);
    assert.deepEqual((await read.listShipments({ status: "posted" }, ctx)).shipments.map((row) => row.id), [drafted.shipment.id]);

    // A reader limited to another warehouse sees none of it.
    const otherWarehouse = `wh-other-${suffix}`,
      otherUser = `reader-other-${suffix}`;
    await prisma.warehouse.create({ data: { id: otherWarehouse, tenantId: ids.tenantId, code: `WH-O-${suffix}`, name: "Other Warehouse", status: "active" } });
    await prisma.user.create({ data: { id: otherUser, tenantId: ids.tenantId, email: `${otherUser}@example.com`, name: "Other Reader", role: "manager" } });
    await prisma.userWarehouseScope.create({ data: { id: `scope-other-${suffix}`, tenantId: ids.tenantId, userId: otherUser, warehouseId: otherWarehouse, accessLevel: "read" } });
    const other = await read.listShipments({}, identity(ids.tenantId, otherUser));
    assert.deepEqual([other.total, other.shipments.length, other.counts.all], [0, 0, 0]);

    // With the outbound write switch off, the list and the shipment page read.
    const get = async (path) => {
      let sent = null;
      const handled = await handleSalesOrderWorkbenchRoute({
        url: new URL(`http://localhost${path}`),
        req: { method: "GET" },
        res: {},
        identity: ctx.identity,
        env: { ...env, FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "false" },
        outboundPrisma: prisma,
        send: (_res, status, body) => { sent = { status, body }; },
      });
      assert.equal(handled, true, path);
      return sent;
    };
    const list = await get("/api/sales/shipments");
    assert.deepEqual([list.status, list.body.total], [200, 1]);
    const page = await get(`/api/sales/shipments/${encodeURIComponent(drafted.shipment.id)}/workbench`);
    assert.equal(page.status, 200);
    assert.equal(page.body.shipment.postingStatus, "posted");
    assert.equal(page.body.lines.length, 2);
    // Read-only: nothing can be posted, reversed or cancelled.
    assert.deepEqual([page.body.availableActions.canPost, page.body.availableActions.canReverse, page.body.availableActions.canCancel], [false, false, false]);
  });

  async function seed({
    stock = "10.0000",
    ordered = "10.0000",
    actorRole = "manager",
    scope = "operate",
    suffix = randomUUID(),
  } = {}) {
    const ids = {
      tenantId: `tenant-${suffix}`,
      actorId: `actor-${suffix}`,
      warehouseId: `wh-${suffix}`,
      itemId: `item-${suffix}`,
      balanceId: `bal-${suffix}`,
      salesOrderId: `so-${suffix}`,
      salesOrderLineId: `sol-${suffix}`,
    };
    await prisma.tenant.create({
      data: { id: ids.tenantId, name: `Tenant ${suffix}` },
    });
    await prisma.user.create({
      data: {
        id: ids.actorId,
        tenantId: ids.tenantId,
        email: `${ids.actorId}@example.com`,
        name: "Outbound Manager",
        role: actorRole,
      },
    });
    await prisma.warehouse.create({
      data: {
        id: ids.warehouseId,
        tenantId: ids.tenantId,
        code: `WH-${suffix}`,
        name: "Main Warehouse",
        status: "active",
      },
    });
    if (scope)
      await prisma.userWarehouseScope.create({
        data: {
          id: `scope-${suffix}`,
          tenantId: ids.tenantId,
          userId: ids.actorId,
          warehouseId: ids.warehouseId,
          accessLevel: scope,
        },
      });
    await prisma.item.create({
      data: {
        id: ids.itemId,
        tenantId: ids.tenantId,
        sku: `SKU-${suffix}`,
        name: "出库测试物料",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        id: ids.balanceId,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: `SKU-${suffix}`,
        itemName: "出库测试物料",
        warehouseId: ids.warehouseId,
        warehouseKey: ids.warehouseId,
        location: "A-01",
        locationKey: "a-01",
        onHandQuantity: stock,
        reservedQuantity: "0",
        availableQuantity: stock,
        unit: "EA",
        status: "available",
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        id: `opening-${suffix}`,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: `SKU-${suffix}`,
        itemName: "出库测试物料",
        warehouseId: ids.warehouseId,
        location: "A-01",
        locationKey: "a-01",
        movementType: "opening_balance",
        movementLabel: "Opening balance",
        sourceDocument: "test-seed",
        sourceDocumentType: "TestSeed",
        sourceDocumentId: ids.balanceId,
        sourceDocumentLineId: ids.balanceId,
        quantityIn: stock,
        quantityOut: "0",
        adjustmentQty: "0",
        status: "posted",
        unit: "EA",
      },
    });
    await prisma.salesOrder.create({
      data: {
        id: ids.salesOrderId,
        tenantId: ids.tenantId,
        orderNumber: `SO-${suffix}`,
        customerName: "Test Customer",
        workflowStatus: "confirmed",
        reservationStatus: "not_reserved",
        fulfillmentStatus: "not_fulfilled",
        currency: "CNY",
        lines: {
          create: {
            id: ids.salesOrderLineId,
            itemId: ids.itemId,
            sku: `SKU-${suffix}`,
            itemName: "出库测试物料",
            orderedQuantity: ordered,
            reservedQuantity: "0",
            fulfilledQuantity: "0",
            unit: "EA",
          },
        },
      },
    });
    return ids;
  }

  const reserveInput = (
    ids,
    quantity = "4.0000",
    key = `reserve-${randomUUID()}`,
  ) => ({
    salesOrderId: ids.salesOrderId,
    expectedOrderVersion: 0,
    idempotencyKey: key,
    allocations: [
      {
        salesOrderLineId: ids.salesOrderLineId,
        warehouseId: ids.warehouseId,
        location: "A-01",
        quantity,
      },
    ],
  });

  async function assertReconciled(ids) {
    const [balance, line, reservations] = await Promise.all([
      prisma.inventoryBalance.findUnique({ where: { id: ids.balanceId } }),
      prisma.salesOrderLine.findUnique({ where: { id: ids.salesOrderLineId } }),
      prisma.inventoryReservation.findMany({
        where: { tenantId: ids.tenantId, salesOrderId: ids.salesOrderId },
      }),
    ]);
    const d = (value) => BigInt(String(value).replace(".", ""));
    assert.equal(
      d(balance.availableQuantity),
      d(balance.onHandQuantity) - d(balance.reservedQuantity),
    );
    assert.ok(
      d(line.reservedQuantity) >= 0n && d(line.fulfilledQuantity) >= 0n,
    );
    assert.ok(
      d(line.reservedQuantity) + d(line.fulfilledQuantity) <=
        d(line.orderedQuantity),
    );
    for (const reservation of reservations) {
      assert.ok(
        d(reservation.consumedQuantity) + d(reservation.releasedQuantity) <=
          d(reservation.reservedQuantity),
      );
      assert.ok(
        d(reservation.allocatedQuantity) <=
          d(reservation.reservedQuantity) -
            d(reservation.consumedQuantity) -
            d(reservation.releasedQuantity),
      );
    }
  }

  test("authoritative reserve, draft, post, replay, and reversal close the PostgreSQL transaction loop", async () => {
    const ids = await seed();
    const service = command();
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "4.0000", "reserve-main"),
      identity(ids.tenantId, ids.actorId),
    );
    assert.equal(reserved.reservations.length, 1);
    let balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { tenantId: ids.tenantId, movementType: "shipment_posting" },
      }),
      0,
    );
    const reservationId = reserved.reservations[0].id;

    const drafted = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 1,
        idempotencyKey: "draft-main",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [{ reservationId, quantity: "4.0000" }],
          },
        ],
      },
      identity(ids.tenantId, ids.actorId),
    );
    const shipmentId = drafted.shipment.id;
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    assert.equal(
      fixed(
        (
          await prisma.inventoryReservation.findUnique({
            where: { id: reservationId },
          })
        ).allocatedQuantity,
      ),
      "4.0000",
    );

    const posted = await service.postShipment(
      { shipmentId, expectedShipmentVersion: 0, idempotencyKey: "post-main" },
      identity(ids.tenantId, ids.actorId),
    );
    assert.equal(posted.movementIds.length, 1);
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["6.0000", "0.0000", "6.0000"],
    );
    let reservation = await prisma.inventoryReservation.findUnique({
      where: { id: reservationId },
    });
    assert.deepEqual(
      [
        fixed(reservation.allocatedQuantity),
        fixed(reservation.consumedQuantity),
        reservation.status,
      ],
      ["0.0000", "4.0000", "consumed"],
    );
    let line = await prisma.salesOrderLine.findUnique({
      where: { id: ids.salesOrderLineId },
    });
    assert.deepEqual(
      [fixed(line.reservedQuantity), fixed(line.fulfilledQuantity)],
      ["0.0000", "4.0000"],
    );
    assert.equal(
      (
        await service.postShipment(
          {
            shipmentId,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-main",
          },
          identity(ids.tenantId, ids.actorId),
        )
      ).idempotentReplay,
      true,
    );

    const reversed = await service.reverseShipment(
      {
        shipmentId,
        expectedShipmentVersion: 1,
        idempotencyKey: "reverse-main",
        reason: "Customer correction",
      },
      identity(ids.tenantId, ids.actorId),
    );
    assert.equal(reversed.movementIds.length, 1);
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    reservation = await prisma.inventoryReservation.findUnique({
      where: { id: reservationId },
    });
    assert.deepEqual(
      [
        fixed(reservation.allocatedQuantity),
        fixed(reservation.consumedQuantity),
        reservation.status,
      ],
      ["0.0000", "0.0000", "active"],
    );
    line = await prisma.salesOrderLine.findUnique({
      where: { id: ids.salesOrderLineId },
    });
    assert.deepEqual(
      [fixed(line.reservedQuantity), fixed(line.fulfilledQuantity)],
      ["4.0000", "0.0000"],
    );
    const original = await prisma.inventoryMovement.findUnique({
      where: { id: posted.movementIds[0] },
    });
    const reversal = await prisma.inventoryMovement.findUnique({
      where: { id: reversed.movementIds[0] },
    });
    assert.equal(original.itemName, "出库测试物料");
    assert.equal(reversal.itemName, "出库测试物料");
    assert.equal(original.reversedByMovementId, reversal.id);
    assert.equal(reversal.reversalOfMovementId, original.id);
    assert.deepEqual(
      [fixed(original.quantityIn), fixed(original.quantityOut)],
      ["0.0000", "4.0000"],
    );
    assert.equal(
      await prisma.auditLog.count({ where: { tenantId: ids.tenantId, module: "sales_outbound" } }),
      4,
    );
    assert.equal(
      await prisma.businessCommandExecution.count({
        where: { tenantId: ids.tenantId, status: "completed" },
      }),
      4,
    );
    assert.equal(
      await prisma.inventoryReservationEvent.count({
        where: { tenantId: ids.tenantId },
      }),
      4,
    );
    const linkedEvents = await prisma.inventoryReservationEvent.findMany({
      where: { tenantId: ids.tenantId },
      include: { commandExecution: true },
    });
    assert.ok(
      linkedEvents.every(
        (event) =>
          event.commandExecutionId &&
          event.commandExecution?.commandType === event.commandType &&
          event.commandExecution?.idempotencyKey,
      ),
    );
    const workbench = await createOutboundWorkbenchReadService({
      prisma,
    }).orderWorkbench(ids.salesOrderId, identity(ids.tenantId, ids.actorId));
    assert.equal(workbench.dataSource, "Authoritative PostgreSQL");
    assert.equal(workbench.reconciliation.status, "matched");
    assert.ok(
      workbench.evidence.some(
        (event) => event.commandExecutionId && event.idempotencyKey,
      ),
    );
    assert.ok(
      workbench.smartLinks.some(
        (link) =>
          link.targetRouteId === "inventory:movements" &&
          link.filter.relatedSalesOrderId === ids.salesOrderId,
      ),
    );
    assert.equal(
      workbench.smartLinks.find((link) => link.targetType === "shipment")
        .targetId,
      shipmentId,
    );
    const shipmentWorkbench = await createOutboundWorkbenchReadService({
      prisma,
    }).shipmentWorkbench(shipmentId, identity(ids.tenantId, ids.actorId));
    assert.equal(shipmentWorkbench.availableActions.canReverse, false);
    assert.equal(shipmentWorkbench.movements.length, 2);
    await assertReconciled(ids);
  });

  test("holding a sales order blocks shipment posting without writes, resume permits posting, and reversal remains safe on hold", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId),
      service = command(),
      lifecycle = createSalesOrderWorkbenchService({ prisma });
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "3", "hold-reserve"),
      ctx,
    );
    const drafted = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 1,
        idempotencyKey: "hold-draft",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: reserved.reservations[0].id, quantity: "3" },
            ],
          },
        ],
      },
      ctx,
    );
    const beforeHold = await prisma.salesOrder.findUnique({
      where: { id: ids.salesOrderId },
    });
    await lifecycle.holdOrder(
      ids.salesOrderId,
      {
        expectedOrderVersion: beforeHold.version,
        idempotencyKey: "hold-before-post",
      },
      ctx,
    );
    const snapshot = async () => ({
      balance: await prisma.inventoryBalance.findUnique({
        where: { id: ids.balanceId },
      }),
      reservation: await prisma.inventoryReservation.findUnique({
        where: { id: reserved.reservations[0].id },
      }),
      shipment: await prisma.shipmentDocument.findUnique({
        where: { id: drafted.shipment.id },
      }),
      movements: await prisma.inventoryMovement.count({
        where: { tenantId: ids.tenantId, movementType: "shipment_posting" },
      }),
    });
    const beforeRejectedPost = await snapshot();
    const preview = await createOutboundQueryService({
      prisma,
      capabilities: enabledQueryCapabilities,
    }).previewShipmentPosting({ shipmentId: drafted.shipment.id }, ctx);
    assert.equal(preview.allowed, false);
    assert.ok(
      preview.blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ON_HOLD",
      ),
    );
    await assert.rejects(
      () =>
        service.postShipment(
          {
            shipmentId: drafted.shipment.id,
            expectedShipmentVersion: 0,
            idempotencyKey: "hold-post-rejected",
          },
          ctx,
        ),
      (error) => error.code === "SALES_ORDER_ON_HOLD" && error.status === 409,
    );
    const afterRejectedPost = await snapshot();
    assert.deepEqual(
      [
        fixed(afterRejectedPost.balance.onHandQuantity),
        fixed(afterRejectedPost.balance.reservedQuantity),
        fixed(afterRejectedPost.reservation.consumedQuantity),
        afterRejectedPost.shipment.postingStatus,
        afterRejectedPost.movements,
      ],
      [
        fixed(beforeRejectedPost.balance.onHandQuantity),
        fixed(beforeRejectedPost.balance.reservedQuantity),
        fixed(beforeRejectedPost.reservation.consumedQuantity),
        beforeRejectedPost.shipment.postingStatus,
        beforeRejectedPost.movements,
      ],
    );
    const held = await prisma.salesOrder.findUnique({
      where: { id: ids.salesOrderId },
    });
    await lifecycle.resumeOrder(
      ids.salesOrderId,
      {
        expectedOrderVersion: held.version,
        idempotencyKey: "resume-before-post",
      },
      ctx,
    );
    await service.postShipment(
      {
        shipmentId: drafted.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "hold-post-success",
      },
      ctx,
    );
    const postedOrder = await prisma.salesOrder.findUnique({
      where: { id: ids.salesOrderId },
    });
    await lifecycle.holdOrder(
      ids.salesOrderId,
      {
        expectedOrderVersion: postedOrder.version,
        idempotencyKey: "hold-before-reverse",
      },
      ctx,
    );
    const shipmentWorkbench = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    }).shipmentWorkbench(drafted.shipment.id, ctx);
    assert.equal(shipmentWorkbench.availableActions.canReverse, true);
    await service.reverseShipment(
      {
        shipmentId: drafted.shipment.id,
        expectedShipmentVersion: 1,
        idempotencyKey: "reverse-while-held",
        reason: "Safe correction while order is held",
      },
      ctx,
    );
    assert.equal(
      (
        await prisma.shipmentDocument.findUnique({
          where: { id: drafted.shipment.id },
        })
      ).postingStatus,
      "reversed",
    );
    await assertReconciled(ids);
  });

  test("outbound workbench capability contract keeps reads available while every disabled mutation action fails closed", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId);
    const disabled = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: {},
    }).orderWorkbench(ids.salesOrderId, ctx);
    assert.equal(disabled.dataSource, "Authoritative PostgreSQL");
    assert.deepEqual(
      [
        disabled.availableActions.canEditDraft,
        disabled.availableActions.canConfirm,
        disabled.availableActions.canHold,
        disabled.availableActions.canResume,
        disabled.availableActions.canReserve,
        disabled.availableActions.canRelease,
        disabled.availableActions.canCreateShipment,
      ],
      [false, false, false, false, false, false, false],
    );
    assert.ok(
      disabled.availableActions.blockingReasonCodes.includes(
        "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
      ),
    );
    const enabled = await createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    }).orderWorkbench(ids.salesOrderId, ctx);
    assert.equal(enabled.availableActions.canHold, true);
    assert.equal(enabled.availableActions.canReserve, true);
  });

  test("warehouse-scoped outbound projection hides cross-warehouse facts and marks reconciliation incomplete", async () => {
    const ids = await seed({ stock: "10", ordered: "10" }),
      suffix = randomUUID(),
      ctx = identity(ids.tenantId, ids.actorId);
    const warehouseB = `wh-b-${suffix}`,
      balanceB = `bal-b-${suffix}`;
    await prisma.warehouse.create({
      data: {
        id: warehouseB,
        tenantId: ids.tenantId,
        code: `WH-B-${suffix}`,
        name: "Restricted Warehouse",
        status: "active",
      },
    });
    await prisma.userWarehouseScope.create({
      data: {
        id: `scope-b-${suffix}`,
        tenantId: ids.tenantId,
        userId: ids.actorId,
        warehouseId: warehouseB,
        accessLevel: "operate",
      },
    });
    const item = await prisma.item.findUnique({ where: { id: ids.itemId } });
    await prisma.inventoryBalance.create({
      data: {
        id: balanceB,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: warehouseB,
        warehouseKey: warehouseB,
        location: "B-01",
        locationKey: "b-01",
        onHandQuantity: "10",
        reservedQuantity: "0",
        availableQuantity: "10",
        unit: "EA",
        status: "available",
      },
    });
    const hiddenOpeningMovement = `opening-b-${suffix}`;
    await prisma.inventoryMovement.create({
      data: {
        id: hiddenOpeningMovement,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: warehouseB,
        location: "B-01",
        locationKey: "b-01",
        movementType: "opening_balance",
        movementLabel: "Opening balance",
        sourceDocument: "test-seed",
        sourceDocumentType: "TestSeed",
        sourceDocumentId: balanceB,
        sourceDocumentLineId: balanceB,
        quantityIn: "10",
        quantityOut: "0",
        adjustmentQty: "0",
        status: "posted",
        unit: "EA",
      },
    });
    const service = command();
    const reserved = await service.reserveSalesOrderInventory(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 0,
        idempotencyKey: "scope-reserve",
        allocations: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            warehouseId: ids.warehouseId,
            location: "A-01",
            quantity: "2",
          },
          {
            salesOrderLineId: ids.salesOrderLineId,
            warehouseId: warehouseB,
            location: "B-01",
            quantity: "2",
          },
        ],
      },
      ctx,
    );
    const reservationA = reserved.reservations.find(
      (row) => row.warehouseId === ids.warehouseId,
    );
    const reservationB = reserved.reservations.find(
      (row) => row.warehouseId === warehouseB,
    );
    const shipmentA = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 1,
        idempotencyKey: "scope-draft-a",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [{ reservationId: reservationA.id, quantity: "1" }],
          },
        ],
      },
      ctx,
    );
    const shipmentB = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 2,
        idempotencyKey: "scope-draft-b",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [{ reservationId: reservationB.id, quantity: "1" }],
          },
        ],
      },
      ctx,
    );
    const hiddenPost = await service.postShipment(
      {
        shipmentId: shipmentB.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "scope-post-b",
      },
      ctx,
    );
    const viewerId = `viewer-a-${suffix}`,
      adminId = `admin-${suffix}`;
    await prisma.user.createMany({
      data: [
        {
          id: viewerId,
          tenantId: ids.tenantId,
          email: `${viewerId}@example.com`,
          name: "Warehouse A Viewer",
          role: "manager",
        },
        {
          id: adminId,
          tenantId: ids.tenantId,
          email: `${adminId}@example.com`,
          name: "Workspace Admin",
          role: "admin",
        },
      ],
    });
    await prisma.userWarehouseScope.create({
      data: {
        id: `scope-viewer-a-${suffix}`,
        tenantId: ids.tenantId,
        userId: viewerId,
        warehouseId: ids.warehouseId,
        accessLevel: "read",
      },
    });
    const read = createOutboundWorkbenchReadService({
      prisma,
      capabilities: enabledWorkbenchCapabilities,
    });
    const partial = await read.orderWorkbench(
      ids.salesOrderId,
      identity(ids.tenantId, viewerId),
    );
    assert.deepEqual(
      [
        partial.scopeCoverage.status,
        partial.scopeCoverage.hiddenWarehouseFacts,
        partial.reconciliation.status,
        partial.reconciliation.reasonCode,
      ],
      ["partial", true, "unavailable", "PARTIAL_WAREHOUSE_SCOPE"],
    );
    assert.equal(partial.lines[0].quantityScope, "visible_warehouses_only");
    assert.equal(partial.lines[0].remainingToReserve, null);
    assert.deepEqual(
      partial.reservations.map((row) => row.id),
      [reservationA.id],
    );
    assert.deepEqual(
      partial.shipments.map((row) => row.id),
      [shipmentA.shipment.id],
    );
    assert.equal(
      partial.smartLinks.find((link) => link.targetType === "shipment")
        .targetId,
      shipmentA.shipment.id,
    );
    assert.ok(
      partial.availability.every((row) =>
        row.balances.every(
          (balance) => balance.warehouseId === ids.warehouseId,
        ),
      ),
    );
    assert.ok(
      partial.evidence.some(
        (event) =>
          event.eventType === "shipment_draft_created" &&
          event.entityId === shipmentA.shipment.id,
      ),
    );
    assert.equal(
      partial.evidence.some(
        (event) => event.eventType === "sales_inventory_reserved",
      ),
      false,
    );
    assert.equal(
      partial.evidence.some(
        (event) => event.entityId === shipmentB.shipment.id,
      ),
      false,
    );
    const serialized = JSON.stringify(partial);
    for (const hiddenId of [
      warehouseB,
      balanceB,
      reservationB.id,
      shipmentB.shipment.id,
      hiddenOpeningMovement,
      ...hiddenPost.movementIds,
    ])
      assert.equal(serialized.includes(hiddenId), false, hiddenId);
    await assert.rejects(
      () =>
        read.shipmentWorkbench(
          shipmentB.shipment.id,
          identity(ids.tenantId, viewerId),
        ),
      (error) =>
        error.code === "WAREHOUSE_SCOPE_DENIED" && error.status === 404,
    );
    const full = await read.orderWorkbench(
      ids.salesOrderId,
      identity(ids.tenantId, adminId, "admin"),
    );
    assert.equal(full.scopeCoverage.status, "full");
    assert.equal(full.reconciliation.status, "matched");
    assert.equal(full.reservations.length, 2);
    assert.equal(full.shipments.length, 2);
    assert.ok(
      full.evidence.some(
        (event) => event.eventType === "sales_inventory_reserved",
      ),
    );
    assert.ok(
      full.evidence.some((event) => event.entityId === shipmentB.shipment.id),
    );
    const multipleShipmentLink = full.smartLinks.find(
      (link) => link.targetType === "shipment",
    );
    assert.deepEqual(
      [
        multipleShipmentLink.targetRouteId,
        multipleShipmentLink.targetId,
        multipleShipmentLink.filter.section,
      ],
      ["sales:order-detail", ids.salesOrderId, "shipments"],
    );

    const inventory = createInventoryAuthoritativeReadService({ prisma });
    const visibleMovement = await prisma.inventoryMovement.create({
      data: {
        id: `movement-a-${suffix}`,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: ids.warehouseId,
        location: "A-01",
        locationKey: "a-01",
        movementType: "shipment_posting",
        movementLabel: "Shipment posting",
        sourceDocumentType: "ShipmentDocument",
        sourceDocumentId: shipmentA.shipment.id,
        sourceDocumentLineId: `movement-line-a-${suffix}`,
        relatedSalesOrderId: ids.salesOrderId,
        postingBatchId: `batch-a-${suffix}`,
        quantityIn: "0",
        quantityOut: "1",
        adjustmentQty: "-1",
        status: "posted",
        unit: "EA",
      },
    });
    const filterContext = identity(ids.tenantId, viewerId);
    const byOrder = await inventory.listMovements(
      { relatedSalesOrderId: ids.salesOrderId, tenantId: "forged-tenant" },
      filterContext,
    );
    assert.deepEqual(
      byOrder.movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.equal(byOrder.movements[0].quantityOut, "1.0000");
    assert.deepEqual(
      (
        await inventory.listMovements(
          { postingBatchId: `batch-a-${suffix}` },
          filterContext,
        )
      ).movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.deepEqual(
      (
        await inventory.listMovements(
          { sourceDocumentId: shipmentA.shipment.id },
          filterContext,
        )
      ).movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.deepEqual(
      (
        await inventory.listMovements(
          {
            warehouseId: ids.warehouseId,
            locationKey: "a-01",
            movementType: "shipment_posting",
          },
          filterContext,
        )
      ).movements.map((row) => row.movementId),
      [visibleMovement.id],
    );
    assert.equal(
      (
        await inventory.listMovements(
          { warehouseId: warehouseB },
          filterContext,
        )
      ).total,
      0,
    );
    // The thresholds recorded on the item are the ones the stock pages show.
    await prisma.item.update({
      where: { id: ids.itemId },
      data: { safetyStock: "6", reorderPoint: "12" },
    });
    const balances = await inventory.listBalances(
      {
        sku: item.sku,
        warehouseId: ids.warehouseId,
        locationKey: "a-01",
        tenantId: "forged-tenant",
      },
      filterContext,
    );
    assert.deepEqual(
      balances.balances.map((row) => row.id),
      [ids.balanceId],
    );
    assert.equal(balances.balances[0].availableQuantity, "8.0000");
    assert.deepEqual(
      [balances.balances[0].safetyStock, balances.balances[0].reorderPoint],
      ["6.0000", "12.0000"],
    );
  });

  test("partial/full release, cancellation, authorization, version, and idempotency conflicts are stable", async () => {
    const ids = await seed();
    const service = command(),
      ctx = identity(ids.tenantId, ids.actorId);
    const first = await service.reserveSalesOrderInventory(
      reserveInput(ids, "6", "reserve-guards"),
      ctx,
    );
    await assert.rejects(
      () =>
        service.reserveSalesOrderInventory(
          {
            ...reserveInput(ids, "5", "reserve-over"),
            expectedOrderVersion: 1,
          },
          ctx,
        ),
      (error) =>
        error.code === "RESERVATION_INSUFFICIENT_AVAILABLE" ||
        error.code === "RESERVATION_OVER_ORDERED",
    );
    await assert.rejects(
      () =>
        service.reserveSalesOrderInventory(
          {
            ...reserveInput(ids, "6", "reserve-guards"),
            allocations: reserveInput(ids, "5").allocations,
          },
          ctx,
        ),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
    await assert.rejects(
      () =>
        service.releaseSalesOrderReservation(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 0,
            idempotencyKey: "stale-release",
            reason: "Correction",
            releases: [
              {
                reservationId: first.reservations[0].id,
                quantity: "1",
                expectedReservationVersion: 0,
              },
            ],
          },
          ctx,
        ),
      (error) => error.code === "SALES_ORDER_VERSION_CONFLICT",
    );
    const released = await service.releaseSalesOrderReservation(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 1,
        idempotencyKey: "release-partial",
        reason: "Correction",
        releases: [
          {
            reservationId: first.reservations[0].id,
            quantity: "2",
            expectedReservationVersion: 0,
          },
        ],
      },
      ctx,
    );
    assert.equal(released.reservations[0].releasedQuantity, "2.0000");
    const draft = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: "SHIP-CANCEL",
        expectedOrderVersion: 2,
        idempotencyKey: "draft-cancel",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: first.reservations[0].id, quantity: "2" },
            ],
          },
        ],
      },
      ctx,
    );
    await assert.rejects(
      () =>
        service.releaseSalesOrderReservation(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 3,
            idempotencyKey: "release-allocated",
            reason: "Not allowed",
            releases: [
              {
                reservationId: first.reservations[0].id,
                quantity: "3",
                expectedReservationVersion: 2,
              },
            ],
          },
          ctx,
        ),
      (error) => error.code === "RESERVATION_ALREADY_ALLOCATED",
    );
    await service.cancelShipmentDraft(
      {
        shipmentId: draft.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "cancel-draft",
        reason: "Draft abandoned",
      },
      ctx,
    );
    // A number the client sends is ignored: the same one twice gives two
    // drafts, each with the next server number (DN-YYYYMM-NNNN).
    const second = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        shipmentNumber: "SHIP-CANCEL",
        expectedOrderVersion: 3,
        idempotencyKey: "draft-duplicate-number",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: first.reservations[0].id, quantity: "1" },
            ],
          },
        ],
      },
      ctx,
    );
    assert.match(draft.shipment.shipmentNumber, /^DN-\d{6}-\d{4,}$/);
    assert.match(second.shipment.shipmentNumber, /^DN-\d{6}-\d{4,}$/);
    assert.notEqual(second.shipment.shipmentNumber, draft.shipment.shipmentNumber);
    assert.equal(
      await prisma.shipmentDocument.count({ where: { tenantId: ids.tenantId, shipmentNumber: "SHIP-CANCEL" } }),
      0,
    );
    await service.cancelShipmentDraft(
      {
        shipmentId: second.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "cancel-second-draft",
        reason: "Draft abandoned",
      },
      ctx,
    );
    assert.equal(
      fixed(
        (
          await prisma.inventoryReservation.findUnique({
            where: { id: first.reservations[0].id },
          })
        ).allocatedQuantity,
      ),
      "0.0000",
    );
    const balance = await prisma.inventoryBalance.findUnique({
      where: { id: ids.balanceId },
    });
    assert.deepEqual(
      [
        fixed(balance.onHandQuantity),
        fixed(balance.reservedQuantity),
        fixed(balance.availableQuantity),
      ],
      ["10.0000", "4.0000", "6.0000"],
    );
    await assert.rejects(
      () =>
        service.postShipment(
          {
            shipmentId: draft.shipment.id,
            expectedShipmentVersion: 1,
            idempotencyKey: "post-cancelled",
          },
          ctx,
        ),
      (error) => error.code === "SHIPMENT_ALREADY_CANCELLED",
    );

    for (const [role, scope] of [
      ["viewer", "operate"],
      ["buyer", "operate"],
      ["manager", "read"],
      ["manager", null],
    ]) {
      const denied = await seed({ actorRole: role, scope });
      await assert.rejects(
        () =>
          command().reserveSalesOrderInventory(
            reserveInput(denied),
            identity(denied.tenantId, denied.actorId, role),
          ),
        (error) =>
          ["PERMISSION_DENIED", "AUTHORIZATION_PERMISSION_DENIED", "WAREHOUSE_SCOPE_DENIED"].includes(error.code),
      );
    }
    await assertReconciled(ids);
  });

  test("reservation policy rejects cross-tenant, SKU and balance identity corruption, and lets an inactive item finish its order", async () => {
    const ids = await seed(),
      item = await prisma.item.findUnique({ where: { id: ids.itemId } });
    const input = reserveInput(ids, "1", "integrity-preview");
    const plan = () =>
      buildSalesOrderReservationPlan({
        prisma,
        tenantId: ids.tenantId,
        ...input,
      });
    assert.equal((await plan()).allowed, true);

    const foreign = await seed();
    await prisma.salesOrderLine.update({
      where: { id: ids.salesOrderLineId },
      data: { itemId: foreign.itemId },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.salesOrderLine.update({
      where: { id: ids.salesOrderLineId },
      data: { itemId: ids.itemId, sku: `${item.sku}-CORRUPT` },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.salesOrderLine.update({
      where: { id: ids.salesOrderLineId },
      data: { sku: item.sku },
    });
    await prisma.item.update({
      where: { id: ids.itemId },
      data: { status: "inactive" },
    });
    // Deactivating an item stops new orders, not the ones in progress (design audit L4-03).
    assert.equal((await plan()).allowed, true);
    await prisma.item.update({
      where: { id: ids.itemId },
      data: { status: "active" },
    });

    const alternateItemId = `item-alt-${randomUUID()}`;
    await prisma.item.create({
      data: {
        id: alternateItemId,
        tenantId: ids.tenantId,
        sku: `ALT-${randomUUID()}`,
        name: "Alternate",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceId },
      data: { itemId: alternateItemId },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceId },
      data: { itemId: ids.itemId, sku: `${item.sku}-CORRUPT` },
    });
    assert.ok(
      (await plan()).blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ITEM_INVALID",
      ),
    );
    await prisma.inventoryBalance.update({
      where: { id: ids.balanceId },
      data: { sku: item.sku },
    });
    assert.equal((await plan()).allowed, true);
  });

  test("reservation preview masks warehouse facts unless the signed actor has read scope", async () => {
    const ids = await seed(),
      suffix = randomUUID();
    const otherWarehouseId = `wh-other-${suffix}`;
    await prisma.warehouse.create({
      data: {
        id: otherWarehouseId,
        tenantId: ids.tenantId,
        code: `OTHER-${suffix}`,
        name: "Other",
        status: "active",
      },
    });
    const users = [
      ["none", "manager", null],
      ["other", "manager", ["read", otherWarehouseId]],
      ["read", "manager", ["read", ids.warehouseId]],
      ["operate", "manager", ["operate", ids.warehouseId]],
      ["viewer", "viewer", ["read", ids.warehouseId]],
      ["admin", "admin", null],
    ];
    for (const [name, role, scopeData] of users) {
      const userId = `preview-${name}-${suffix}`;
      await prisma.user.create({
        data: {
          id: userId,
          tenantId: ids.tenantId,
          email: `${userId}@example.com`,
          name,
          role,
        },
      });
      if (scopeData)
        await prisma.userWarehouseScope.create({
          data: {
            id: `scope-${name}-${suffix}`,
            tenantId: ids.tenantId,
            userId,
            accessLevel: scopeData[0],
            warehouseId: scopeData[1],
          },
        });
    }
    const query = createOutboundQueryService({
      prisma,
      capabilities: { "sales-reservation": { enabled: true } },
    });
    const preview = (name, role, warehouseId = ids.warehouseId) =>
      query.previewSalesOrderReservation(
        {
          ...reserveInput(ids, "1"),
          allocations: [
            {
              salesOrderLineId: ids.salesOrderLineId,
              warehouseId,
              location: "A-01",
              quantity: "1",
            },
          ],
        },
        identity(ids.tenantId, `preview-${name}-${suffix}`, role),
      );
    for (const [name, role] of [
      ["none", "manager"],
      ["other", "manager"],
    ])
      await assert.rejects(
        () => preview(name, role),
        (error) =>
          error.code === "WAREHOUSE_SCOPE_DENIED" &&
          error.status === 404 &&
          !JSON.stringify(error).includes(ids.balanceId),
      );
    for (const [name, role] of [
      ["read", "manager"],
      ["operate", "manager"],
      ["viewer", "viewer"],
      ["admin", "admin"],
    ])
      assert.equal((await preview(name, role)).allowed, true);
    const foreign = await seed();
    await assert.rejects(
      () => preview("admin", "admin", foreign.warehouseId),
      (error) =>
        error.code === "WAREHOUSE_SCOPE_DENIED" && error.status === 404,
    );
  });

  test("shipment reversal fails closed when original movement or allocation facts are corrupted", async () => {
    const ids = await seed(),
      ctx = identity(ids.tenantId, ids.actorId),
      service = command();
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "3", "tamper-reserve"),
      ctx,
    );
    const drafted = await service.createShipmentDraft(
      {
        salesOrderId: ids.salesOrderId,
        expectedOrderVersion: 1,
        idempotencyKey: "tamper-draft",
        lines: [
          {
            salesOrderLineId: ids.salesOrderLineId,
            allocations: [
              { reservationId: reserved.reservations[0].id, quantity: "3" },
            ],
          },
        ],
      },
      ctx,
    );
    const posted = await service.postShipment(
      {
        shipmentId: drafted.shipment.id,
        expectedShipmentVersion: 0,
        idempotencyKey: "tamper-post",
      },
      ctx,
    );
    const movementId = posted.movementIds[0];
    const allocation = await prisma.shipmentAllocation.findFirst({
      where: { shipmentLine: { shipmentId: drafted.shipment.id } },
    });
    const assertUnsafe = async () =>
      assert.ok(
        (
          await buildShipmentReversalPlan({
            prisma,
            tenantId: ids.tenantId,
            shipmentId: drafted.shipment.id,
            reason: "Integrity test",
          })
        ).blockingIssues.some(
          (issue) => issue.code === "SHIPMENT_REVERSAL_NOT_SAFE",
        ),
      );
    const movementCases = [
      ["quantityOut", "2"],
      ["sku", "CORRUPT-SKU"],
      ["warehouseId", "wrong-warehouse"],
      ["locationKey", "wrong-location"],
      ["relatedSalesOrderId", "wrong-order"],
      ["reversedByMovementId", `already-reversed-${randomUUID()}`],
    ];
    const original = await prisma.inventoryMovement.findUnique({
      where: { id: movementId },
    });
    for (const [field, value] of movementCases) {
      await prisma.inventoryMovement.update({
        where: { id: movementId },
        data: { [field]: value },
      });
      await assertUnsafe();
      await prisma.inventoryMovement.update({
        where: { id: movementId },
        data: { [field]: original[field] },
      });
    }
    await prisma.shipmentAllocation.update({
      where: { id: allocation.id },
      data: { status: "allocated" },
    });
    await assertUnsafe();
    await prisma.shipmentAllocation.update({
      where: { id: allocation.id },
      data: { status: "consumed" },
    });
    assert.equal(
      (
        await buildShipmentReversalPlan({
          prisma,
          tenantId: ids.tenantId,
          shipmentId: drafted.shipment.id,
          reason: "Valid reversal",
        })
      ).allowed,
      true,
    );
  });

  test("two independent clients cannot over-reserve the same inventory balance", async () => {
    const firstIds = await seed({ stock: "10", ordered: "8" });
    const secondOrderId = `so-2-${randomUUID()}`,
      secondLineId = `sol-2-${randomUUID()}`;
    await prisma.salesOrder.create({
      data: {
        id: secondOrderId,
        tenantId: firstIds.tenantId,
        orderNumber: `SO-2-${randomUUID()}`,
        customerName: "Second",
        workflowStatus: "confirmed",
        currency: "CNY",
        lines: {
          create: {
            id: secondLineId,
            itemId: firstIds.itemId,
            sku: (
              await prisma.item.findUnique({ where: { id: firstIds.itemId } })
            ).sku,
            itemName: "Outbound Item",
            orderedQuantity: "8",
            unit: "EA",
          },
        },
      },
    });
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const outcomes = await Promise.allSettled([
        command(clientA).reserveSalesOrderInventory(
          reserveInput(firstIds, "8", "race-a"),
          identity(firstIds.tenantId, firstIds.actorId),
        ),
        command(clientB).reserveSalesOrderInventory(
          {
            salesOrderId: secondOrderId,
            expectedOrderVersion: 0,
            idempotencyKey: "race-b",
            allocations: [
              {
                salesOrderLineId: secondLineId,
                warehouseId: firstIds.warehouseId,
                location: "A-01",
                quantity: "8",
              },
            ],
          },
          identity(firstIds.tenantId, firstIds.actorId),
        ),
      ]);
      assert.equal(
        outcomes.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const failure = outcomes.find(
        (entry) => entry.status === "rejected",
      ).reason;
      assert.ok(
        [
          "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT",
          "RESERVATION_INSUFFICIENT_AVAILABLE",
        ].includes(failure.code),
        failure.code,
      );
      const total = await prisma.inventoryReservation.aggregate({
        where: { tenantId: firstIds.tenantId },
        _sum: { reservedQuantity: true },
      });
      assert.equal(fixed(total._sum.reservedQuantity), "8.0000");
      await assertReconciled(firstIds);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("independent clients serialize draft allocation and shipment posting exactly once", async () => {
    const ids = await seed();
    const service = command(),
      ctx = identity(ids.tenantId, ids.actorId);
    const reserved = await service.reserveSalesOrderInventory(
      reserveInput(ids, "4", "reserve-races"),
      ctx,
    );
    const reservationId = reserved.reservations[0].id;
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const drafts = await Promise.allSettled([
        command(clientA).createShipmentDraft(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 1,
            idempotencyKey: "draft-race-a",
            lines: [
              {
                salesOrderLineId: ids.salesOrderLineId,
                allocations: [{ reservationId, quantity: "4" }],
              },
            ],
          },
          ctx,
        ),
        command(clientB).createShipmentDraft(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 1,
            idempotencyKey: "draft-race-b",
            lines: [
              {
                salesOrderLineId: ids.salesOrderLineId,
                allocations: [{ reservationId, quantity: "4" }],
              },
            ],
          },
          ctx,
        ),
      ]);
      assert.equal(
        drafts.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const shipmentId = drafts.find((entry) => entry.status === "fulfilled")
        .value.shipment.id;
      const posts = await Promise.allSettled([
        command(clientA).postShipment(
          {
            shipmentId,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-race-a",
          },
          ctx,
        ),
        command(clientB).postShipment(
          {
            shipmentId,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-race-b",
          },
          ctx,
        ),
      ]);
      assert.equal(
        posts.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      assert.equal(
        await prisma.inventoryMovement.count({
          where: { tenantId: ids.tenantId, movementType: "shipment_posting" },
        }),
        1,
      );
      assert.equal(
        fixed(
          (
            await prisma.inventoryReservation.findUnique({
              where: { id: reservationId },
            })
          ).consumedQuantity,
        ),
        "4.0000",
      );
      await assertReconciled(ids);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("same-order reserve and concurrent post-versus-release never produce negative quantities", async () => {
    const ids = await seed({ stock: "20", ordered: "10" }),
      ctx = identity(ids.tenantId, ids.actorId);
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const sameOrder = await Promise.allSettled([
        command(clientA).reserveSalesOrderInventory(
          reserveInput(ids, "6", "same-order-a"),
          ctx,
        ),
        command(clientB).reserveSalesOrderInventory(
          reserveInput(ids, "6", "same-order-b"),
          ctx,
        ),
      ]);
      assert.equal(
        sameOrder.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      const reservationId = sameOrder.find(
        (entry) => entry.status === "fulfilled",
      ).value.reservations[0].id;
      const draft = await command(clientA).createShipmentDraft(
        {
          salesOrderId: ids.salesOrderId,
          expectedOrderVersion: 1,
          idempotencyKey: "draft-post-release",
          lines: [
            {
              salesOrderLineId: ids.salesOrderLineId,
              allocations: [{ reservationId, quantity: "4" }],
            },
          ],
        },
        ctx,
      );
      const race = await Promise.allSettled([
        command(clientA).postShipment(
          {
            shipmentId: draft.shipment.id,
            expectedShipmentVersion: 0,
            idempotencyKey: "post-release-post",
          },
          ctx,
        ),
        command(clientB).releaseSalesOrderReservation(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 2,
            idempotencyKey: "post-release-release",
            reason: "Concurrent correction",
            releases: [
              { reservationId, quantity: "2", expectedReservationVersion: 1 },
            ],
          },
          ctx,
        ),
      ]);
      assert.ok(race.some((entry) => entry.status === "fulfilled"));
      for (const entry of race.filter((item) => item.status === "rejected"))
        assert.ok(
          [
            "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT",
            "SALES_ORDER_VERSION_CONFLICT",
            "RESERVATION_VERSION_CONFLICT",
            "RESERVATION_QUANTITY_CONFLICT",
          ].includes(entry.reason.code),
          entry.reason.code,
        );
      await assertReconciled(ids);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  test("multi-balance requests acquire natural keys in stable order without uncontrolled deadlock", async () => {
    const ids = await seed({ stock: "4", ordered: "8" }),
      suffix = randomUUID(),
      ctx = identity(ids.tenantId, ids.actorId);
    const warehouse2 = `wh-2-${suffix}`,
      balance2 = `bal-2-${suffix}`;
    await prisma.warehouse.create({
      data: {
        id: warehouse2,
        tenantId: ids.tenantId,
        code: `WH2-${suffix}`,
        name: "Second Warehouse",
        status: "active",
      },
    });
    await prisma.userWarehouseScope.create({
      data: {
        id: `scope-2-${suffix}`,
        tenantId: ids.tenantId,
        userId: ids.actorId,
        warehouseId: warehouse2,
        accessLevel: "operate",
      },
    });
    const item = await prisma.item.findUnique({ where: { id: ids.itemId } });
    await prisma.inventoryBalance.create({
      data: {
        id: balance2,
        tenantId: ids.tenantId,
        itemId: ids.itemId,
        sku: item.sku,
        itemName: item.name,
        warehouseId: warehouse2,
        warehouseKey: warehouse2,
        location: "B-01",
        locationKey: "b-01",
        onHandQuantity: "4",
        reservedQuantity: "0",
        availableQuantity: "4",
        unit: "EA",
      },
    });
    const order2 = `so-2-${suffix}`,
      line2 = `sol-2-${suffix}`;
    await prisma.salesOrder.create({
      data: {
        id: order2,
        tenantId: ids.tenantId,
        orderNumber: `SO-MULTI-${suffix}`,
        customerName: "Multi Balance",
        workflowStatus: "confirmed",
        currency: "CNY",
        lines: {
          create: {
            id: line2,
            itemId: ids.itemId,
            sku: item.sku,
            itemName: item.name,
            orderedQuantity: "8",
            unit: "EA",
          },
        },
      },
    });
    const allocationsA = [
      {
        salesOrderLineId: ids.salesOrderLineId,
        warehouseId: ids.warehouseId,
        location: "A-01",
        quantity: "2",
      },
      {
        salesOrderLineId: ids.salesOrderLineId,
        warehouseId: warehouse2,
        location: "B-01",
        quantity: "2",
      },
    ];
    const allocationsB = [
      {
        salesOrderLineId: line2,
        warehouseId: warehouse2,
        location: "B-01",
        quantity: "2",
      },
      {
        salesOrderLineId: line2,
        warehouseId: ids.warehouseId,
        location: "A-01",
        quantity: "2",
      },
    ];
    const clientA = await createPrismaClient(env),
      clientB = await createPrismaClient(env);
    try {
      const outcomes = await Promise.allSettled([
        command(clientA).reserveSalesOrderInventory(
          {
            salesOrderId: ids.salesOrderId,
            expectedOrderVersion: 0,
            idempotencyKey: "multi-key-a",
            allocations: allocationsA,
          },
          ctx,
        ),
        command(clientB).reserveSalesOrderInventory(
          {
            salesOrderId: order2,
            expectedOrderVersion: 0,
            idempotencyKey: "multi-key-b",
            allocations: allocationsB,
          },
          ctx,
        ),
      ]);
      assert.ok(outcomes.some((entry) => entry.status === "fulfilled"));
      for (const entry of outcomes.filter((item) => item.status === "rejected"))
        assert.equal(
          entry.reason.code,
          "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT",
        );
      for (const id of [ids.balanceId, balance2]) {
        const row = await prisma.inventoryBalance.findUnique({ where: { id } });
        assert.equal(
          fixed(row.availableQuantity),
          outboundDecimalString(
            outboundDecimalUnits(row.onHandQuantity) -
              outboundDecimalUnits(row.reservedQuantity),
          ),
        );
      }
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });

  // Cancelling a sales order: unposted shipments are cancelled, every active
  // reservation is released and the stock is available again, in one
  // transaction. An order with goods shipped is not cancelled.
  test("cancelling an order releases its reservations and cancels its unposted shipment", async () => {
    const ids = await seed({ stock: "10.0000", ordered: "6.0000" });
    const who = identity(ids.tenantId, ids.actorId);
    const reserved = await command().reserveSalesOrderInventory(reserveInput(ids, "6.0000"), who);
    const reservationId = reserved.reservations[0].id;
    const draft = await command().createShipmentDraft({ salesOrderId: ids.salesOrderId, expectedOrderVersion: reserved.salesOrder.version, idempotencyKey: `draft-${randomUUID()}`, lines: [{ salesOrderLineId: ids.salesOrderLineId, allocations: [{ reservationId, quantity: "2.0000" }] }] }, who);
    const before = await prisma.inventoryBalance.findUnique({ where: { id: ids.balanceId } });
    assert.deepEqual([fixed(before.reservedQuantity), fixed(before.availableQuantity)], ["6.0000", "4.0000"]);

    const preview = await command().previewSalesOrderCancellation({ salesOrderId: ids.salesOrderId }, who);
    assert.equal(preview.allowed, true);
    assert.equal(preview.releasedQuantity, "6.0000");
    assert.deepEqual(preview.shipmentImpacts.map((entry) => entry.shipmentId), [draft.entityId]);
    const order = await prisma.salesOrder.findUnique({ where: { id: ids.salesOrderId } });
    await assert.rejects(command().cancelSalesOrder({ salesOrderId: ids.salesOrderId, expectedOrderVersion: order.version, idempotencyKey: `cancel-${randomUUID()}` }, who), (error) => error.code === "SALES_ORDER_CANCEL_REASON_REQUIRED");
    const key = `cancel-${randomUUID()}`;
    const cancelled = await command().cancelSalesOrder({ salesOrderId: ids.salesOrderId, expectedOrderVersion: order.version, reason: "Customer cancelled", idempotencyKey: key }, who);
    assert.equal(cancelled.salesOrder.workflowStatus, "cancelled");
    assert.equal(cancelled.releasedQuantity, "6.0000");
    const replayed = await command().cancelSalesOrder({ salesOrderId: ids.salesOrderId, expectedOrderVersion: order.version, reason: "Customer cancelled", idempotencyKey: key }, who);
    assert.equal(replayed.idempotentReplay, true);

    const balance = await prisma.inventoryBalance.findUnique({ where: { id: ids.balanceId } });
    assert.deepEqual([fixed(balance.onHandQuantity), fixed(balance.reservedQuantity), fixed(balance.availableQuantity)], ["10.0000", "0.0000", "10.0000"]);
    const reservation = await prisma.inventoryReservation.findUnique({ where: { id: reservationId } });
    assert.deepEqual([reservation.status, fixed(reservation.releasedQuantity), fixed(reservation.allocatedQuantity)], ["released", "6.0000", "0.0000"]);
    const shipment = await prisma.shipmentDocument.findUnique({ where: { id: draft.entityId } });
    assert.deepEqual([shipment.workflowStatus, shipment.postingStatus], ["cancelled", "unposted"]);
    assert.equal(await prisma.shipmentAllocation.count({ where: { tenantId: ids.tenantId, status: "allocated" } }), 0);
    const after = await prisma.salesOrder.findUnique({ where: { id: ids.salesOrderId }, include: { lines: true } });
    assert.deepEqual([after.workflowStatus, after.reservationStatus, fixed(after.lines[0].reservedQuantity), after.metadata.cancelReason, after.metadata.statusBeforeCancel], ["cancelled", "not_reserved", "0.0000", "Customer cancelled", "confirmed"]);
    assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: ids.tenantId, movementType: { not: "opening_balance" } } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { tenantId: ids.tenantId, action: "sales_order_cancelled" } }), 1);
    assert.deepEqual((await prisma.inventoryReservationEvent.findMany({ where: { reservationId }, orderBy: { createdAt: "asc" } })).map((event) => event.eventType), ["reserved", "allocated", "deallocated", "released"]);
    // A cancelled order cannot be cancelled again, and the workbench offers nothing.
    const again = await command().previewSalesOrderCancellation({ salesOrderId: ids.salesOrderId }, who);
    assert.equal(again.allowed, false);
    const workbench = await createOutboundWorkbenchReadService({ prisma, capabilities: enabledWorkbenchCapabilities }).orderWorkbench(ids.salesOrderId, who);
    assert.equal(workbench.availableActions.canCancel, false);
  });

  test("an order with a posted shipment, or a role without sales_order.cancel, cannot be cancelled", async () => {
    const ids = await seed({ stock: "10.0000", ordered: "6.0000" });
    const who = identity(ids.tenantId, ids.actorId);
    const workbench = () => createOutboundWorkbenchReadService({ prisma, capabilities: enabledWorkbenchCapabilities }).orderWorkbench(ids.salesOrderId, who);
    assert.equal((await workbench()).availableActions.canCancel, true);
    const reserved = await command().reserveSalesOrderInventory(reserveInput(ids, "6.0000"), who);
    const draft = await command().createShipmentDraft({ salesOrderId: ids.salesOrderId, expectedOrderVersion: reserved.salesOrder.version, idempotencyKey: `draft-${randomUUID()}`, lines: [{ salesOrderLineId: ids.salesOrderLineId, allocations: [{ reservationId: reserved.reservations[0].id, quantity: "2.0000" }] }] }, who);
    await command().postShipment({ shipmentId: draft.entityId, expectedShipmentVersion: draft.shipment.version, idempotencyKey: `post-${randomUUID()}` }, who);
    const preview = await command().previewSalesOrderCancellation({ salesOrderId: ids.salesOrderId }, who);
    assert.equal(preview.allowed, false);
    assert.equal(preview.blockingIssues[0].code, "SALES_ORDER_HAS_POSTED_SHIPMENTS");
    const order = await prisma.salesOrder.findUnique({ where: { id: ids.salesOrderId } });
    await assert.rejects(command().cancelSalesOrder({ salesOrderId: ids.salesOrderId, expectedOrderVersion: order.version, reason: "Too late", idempotencyKey: `cancel-${randomUUID()}` }, who), (error) => error.code === "SALES_ORDER_HAS_POSTED_SHIPMENTS");
    assert.equal((await prisma.salesOrder.findUnique({ where: { id: ids.salesOrderId } })).workflowStatus, "confirmed");
    assert.equal((await workbench()).availableActions.canCancel, false);

    // A read-only viewer can read sales orders but not cancel them.
    const specialist = await seed({ actorRole: "viewer" });
    const specialistWho = identity(specialist.tenantId, specialist.actorId, "viewer");
    await assert.rejects(command().cancelSalesOrder({ salesOrderId: specialist.salesOrderId, expectedOrderVersion: 0, reason: "No", idempotencyKey: `cancel-${randomUUID()}` }, specialistWho), (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED");
  });
}
