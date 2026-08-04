import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-outbound-api-smoke",
  email = "outbound-smoke@flowchain.invalid";
const actorId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer().on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}
async function waitFor(url, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("API server did not become ready");
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
function startApi(env) {
  const child = spawn(node, ["server/index.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const safe = String(chunk).replace(
      /postgres(?:ql)?:\/\/[^\s]+/gi,
      "[REDACTED_DATABASE_URL]",
    );
    if (safe.trim()) process.stderr.write(safe);
  });
  return child;
}

async function raw(base, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}
async function request(base, path, options) {
  const result = await raw(base, path, options);
  if (!result.response.ok)
    throw new Error(
      `${options?.method || "GET"} ${path} failed: ${result.payload.code || result.response.status} ${result.payload.message || ""}`,
    );
  return result.payload;
}
async function login(base) {
  const result = await request(base, "/api/auth/login", {
    method: "POST",
    body: { email, name: "Outbound Smoke Manager", company: "FlowChain Test" },
  });
  assert.equal(result.user.id, actorId);
  assert.equal(result.user.tenantId, tenantId);
  return result.token;
}

async function main() {
  const pgPort = await freePort(),
    apiPort = await freePort(),
    password = `local-${randomUUID()}`,
    database = "flowchain_outbound_api_smoke_test";
  const directory = await mkdtemp(join(tmpdir(), "flowchain-outbound-api-"));
  const url = `postgresql://flowchain_outbound_smoke:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
  const pg = new EmbeddedPostgres({
    databaseDir: directory,
    user: "flowchain_outbound_smoke",
    password,
    port: pgPort,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  let api, prisma;
  const env = {
    ...process.env,
    DATABASE_URL: url,
    DATABASE_URL_TEST: url,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "true",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `smoke-${randomUUID()}`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_COMMIT_SHA: "outbound-api-smoke",
    FLOWCHAIN_BRANCH: "test/outbound-api-smoke",
    FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false",
    SCM_API_PORT: String(apiPort),
    NODE_ENV: "production",
  };
  const base = `http://127.0.0.1:${apiPort}`;
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(database);
    await execFileAsync(node, [prismaCli, "migrate", "deploy"], {
      cwd: root,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    prisma = await createPrismaClient(env);
    await prisma.tenant.create({
      data: { id: tenantId, name: "Outbound API Smoke" },
    });
    await prisma.user.create({
      data: {
        id: actorId,
        tenantId,
        email,
        name: "Outbound Smoke Manager",
        role: "manager",
      },
    });
    await prisma.warehouse.create({
      data: {
        id: "outbound-smoke-warehouse",
        tenantId,
        code: "OUT-SMOKE",
        name: "Outbound Smoke Warehouse",
        status: "active",
      },
    });
    const scope = await prisma.userWarehouseScope.create({
      data: {
        id: randomUUID(),
        tenantId,
        userId: actorId,
        warehouseId: "outbound-smoke-warehouse",
        accessLevel: "operate",
      },
    });
    await prisma.item.create({
      data: {
        id: "outbound-smoke-item",
        tenantId,
        sku: "OUT-SMOKE-SKU",
        name: "Outbound Smoke Item",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        id: "outbound-smoke-balance",
        tenantId,
        itemId: "outbound-smoke-item",
        sku: "OUT-SMOKE-SKU",
        itemName: "Outbound Smoke Item",
        warehouseId: "outbound-smoke-warehouse",
        warehouseKey: "outbound-smoke-warehouse",
        location: "A-01",
        locationKey: "a-01",
        onHandQuantity: "10",
        reservedQuantity: "0",
        availableQuantity: "10",
        unit: "EA",
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        id: "outbound-opening",
        tenantId,
        itemId: "outbound-smoke-item",
        sku: "OUT-SMOKE-SKU",
        warehouseId: "outbound-smoke-warehouse",
        location: "A-01",
        locationKey: "a-01",
        movementType: "opening_balance",
        sourceDocument: "Smoke Seed",
        sourceDocumentType: "TestSeed",
        sourceDocumentId: "outbound-smoke-balance",
        sourceDocumentLineId: "outbound-smoke-balance",
        quantityIn: "10",
        quantityOut: "0",
        adjustmentQty: "0",
        status: "posted",
        unit: "EA",
      },
    });
    await prisma.salesOrder.create({
      data: {
        id: "outbound-smoke-order",
        tenantId,
        orderNumber: "SO-OUT-SMOKE",
        customerName: "Smoke Customer",
        workflowStatus: "confirmed",
        currency: "CNY",
        lines: {
          create: {
            id: "outbound-smoke-line",
            itemId: "outbound-smoke-item",
            sku: "OUT-SMOKE-SKU",
            itemName: "Outbound Smoke Item",
            orderedQuantity: "4",
            unit: "EA",
          },
        },
      },
    });

    api = startApi(env);
    await waitFor(`${base}/api/health`);
    let token = await login(base);
    const entryData = await request(base, "/api/sales/order-entry-data", {
      token,
    });
    assert.equal(entryData.items[0].id, "outbound-smoke-item");
    const lifecycleNumber = `SO-ENTRY-${randomUUID()}`;
    const lifecycle = await request(base, "/api/sales/orders", {
      token,
      method: "POST",
      body: {
        orderNumber: lifecycleNumber,
        customerName: "API Entry Customer",
        currency: "USD",
        idempotencyKey: "api-entry-create",
        lines: [{ itemId: "outbound-smoke-item", quantity: "2" }],
      },
    });
    assert.equal(
      (
        await request(base, "/api/sales/orders", {
          token,
          method: "POST",
          body: {
            orderNumber: lifecycleNumber,
            customerName: "API Entry Customer",
            currency: "USD",
            idempotencyKey: "api-entry-create",
            lines: [{ itemId: "outbound-smoke-item", quantity: "2" }],
          },
        })
      ).idempotentReplay,
      true,
    );
    const revised = await request(
      base,
      `/api/sales/orders/${lifecycle.order.id}`,
      {
        token,
        method: "PATCH",
        body: {
          expectedOrderVersion: 0,
          idempotencyKey: "api-entry-revise",
          revisionMode: "replace_all",
          expectedLineIds: lifecycle.order.lines.map((line) => line.id),
          header: { customerName: "API Entry Revised", currency: "CNY" },
          lines: [{ itemId: "outbound-smoke-item", quantity: "3" }],
        },
      },
    );
    const confirmed = await request(
      base,
      `/api/sales/orders/${lifecycle.order.id}/confirm`,
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: revised.order.version,
          idempotencyKey: "api-entry-confirm",
        },
      },
    );
    assert.equal(confirmed.order.workflowStatus, "confirmed");
    assert.equal(
      (
        await request(base, `/api/sales/orders/${lifecycle.order.id}/confirm`, {
          token,
          method: "POST",
          body: {
            expectedOrderVersion: revised.order.version,
            idempotencyKey: "api-entry-confirm",
          },
        })
      ).idempotentReplay,
      true,
    );
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders?search=API%20Entry%20Revised&page=1&pageSize=1",
          { token },
        )
      ).total,
      1,
    );
    assert.equal(
      (
        await request(
          base,
          `/api/sales/orders/${lifecycle.order.id}/workbench`,
          { token },
        )
      ).dataSource,
      "Authoritative PostgreSQL",
    );
    assert.equal(
      (await raw(base, "/api/sales/orders/outbound-smoke-order/outbound-state"))
        .response.status,
      401,
    );
    let state = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/outbound-state?tenantId=forged",
      { token },
    );
    assert.equal(state.salesOrder.id, "outbound-smoke-order");
    assert.equal(state.lines[0].orderedQuantity, "4.0000");
    const allocation = {
      salesOrderLineId: "outbound-smoke-line",
      warehouseId: "outbound-smoke-warehouse",
      location: "A-01",
      quantity: "4",
    };
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders/outbound-smoke-order/reservations/preview",
          {
            token,
            method: "POST",
            body: { tenantId: "forged", allocations: [allocation] },
          },
        )
      ).allowed,
      true,
    );
    const reserveKey = `reserve-${randomUUID()}`;
    const reserved = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/reservations/reserve",
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: 0,
          idempotencyKey: reserveKey,
          allocations: [allocation],
        },
      },
    );
    const reservationId = reserved.reservations[0].id;
    state = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/outbound-state",
      { token },
    );
    assert.equal(state.reservations[0].allocatableQuantity, "4.0000");
    const changed = await raw(
      base,
      "/api/sales/orders/outbound-smoke-order/reservations/reserve",
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: 0,
          idempotencyKey: reserveKey,
          allocations: [{ ...allocation, quantity: "3" }],
        },
      },
    );
    assert.equal(changed.response.status, 409);
    assert.equal(
      changed.payload.code,
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
    const draftBody = {
      shipmentNumber: "SHIP-OUT-SMOKE",
      expectedOrderVersion: 1,
      idempotencyKey: `draft-${randomUUID()}`,
      lines: [
        {
          salesOrderLineId: "outbound-smoke-line",
          allocations: [{ reservationId, quantity: "4" }],
        },
      ],
    };
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders/outbound-smoke-order/shipments/preview",
          { token, method: "POST", body: draftBody },
        )
      ).allowed,
      true,
    );
    const balanceBeforeDraft = await prisma.inventoryBalance.findUnique({
      where: { id: "outbound-smoke-balance" },
    });
    const drafted = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/shipments",
      { token, method: "POST", body: draftBody },
    );
    const shipmentId = drafted.shipment.id;
    const duplicate = await raw(
      base,
      "/api/sales/orders/outbound-smoke-order/shipments",
      {
        token,
        method: "POST",
        body: {
          ...draftBody,
          expectedOrderVersion: 2,
          idempotencyKey: `duplicate-${randomUUID()}`,
        },
      },
    );
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.payload.code, "SHIPMENT_NUMBER_CONFLICT");
    const balanceAfterDraft = await prisma.inventoryBalance.findUnique({
      where: { id: "outbound-smoke-balance" },
    });
    assert.deepEqual(
      [
        balanceBeforeDraft.onHandQuantity.toString(),
        balanceBeforeDraft.availableQuantity.toString(),
      ],
      [
        balanceAfterDraft.onHandQuantity.toString(),
        balanceAfterDraft.availableQuantity.toString(),
      ],
    );
    const held = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/hold",
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: 2,
          idempotencyKey: "api-hold-before-post",
        },
      },
    );
    assert.equal(held.order.workflowStatus, "on_hold");
    const heldPreview = await request(
      base,
      `/api/sales/shipments/${shipmentId}/post-preview`,
      { token, method: "POST", body: {} },
    );
    assert.equal(heldPreview.allowed, false);
    assert.ok(
      heldPreview.blockingIssues.some(
        (issue) => issue.code === "SALES_ORDER_ON_HOLD",
      ),
    );
    const heldPost = await raw(
      base,
      `/api/sales/shipments/${shipmentId}/post`,
      {
        token,
        method: "POST",
        body: { expectedShipmentVersion: 0, idempotencyKey: "api-held-post" },
      },
    );
    assert.equal(heldPost.response.status, 409);
    assert.equal(heldPost.payload.code, "SALES_ORDER_ON_HOLD");
    const resumed = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/resume",
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: held.order.version,
          idempotencyKey: "api-resume-before-post",
        },
      },
    );
    assert.equal(resumed.order.workflowStatus, "confirmed");
    assert.equal(
      (
        await request(base, `/api/sales/shipments/${shipmentId}/post-preview`, {
          token,
          method: "POST",
          body: {},
        })
      ).allowed,
      true,
    );
    const postKey = `post-${randomUUID()}`;
    const posted = await request(
      base,
      `/api/sales/shipments/${shipmentId}/post`,
      {
        token,
        method: "POST",
        body: { expectedShipmentVersion: 0, idempotencyKey: postKey },
      },
    );
    assert.equal(posted.shipment.postingStatus, "posted");
    assert.equal(
      (
        await request(base, `/api/sales/shipments/${shipmentId}/post`, {
          token,
          method: "POST",
          body: { expectedShipmentVersion: 0, idempotencyKey: postKey },
        })
      ).idempotentReplay,
      true,
    );
    let postingState = await request(
      base,
      `/api/sales/shipments/${shipmentId}/posting-state`,
      { token },
    );
    assert.equal(postingState.allocations[0].movementId !== null, true);
    const movementFilter = await request(
      base,
      "/api/inventory/movements?relatedSalesOrderId=outbound-smoke-order&tenantId=forged",
      { token },
    );
    assert.equal(movementFilter.movements.length, 1);
    assert.equal(
      movementFilter.movements[0].relatedSalesOrderId,
      "outbound-smoke-order",
    );
    assert.equal(movementFilter.movements[0].quantityOut, "4.0000");
    assert.equal(
      (
        await request(
          base,
          `/api/inventory/movements?postingBatchId=${encodeURIComponent(posted.postingBatchId)}`,
          { token },
        )
      ).movements.length,
      1,
    );
    assert.equal(
      (
        await request(
          base,
          `/api/inventory/movements?sourceDocumentId=${encodeURIComponent(shipmentId)}`,
          { token },
        )
      ).movements.length,
      1,
    );
    assert.equal(
      (
        await request(
          base,
          "/api/inventory/movements?warehouseId=outbound-smoke-warehouse&locationKey=a-01&movementType=shipment_posting",
          { token },
        )
      ).movements.length,
      1,
    );
    const balanceFilter = await request(
      base,
      "/api/inventory/balances?sku=OUT-SMOKE-SKU&warehouseId=outbound-smoke-warehouse&locationKey=a-01&tenantId=forged",
      { token },
    );
    assert.equal(balanceFilter.balances.length, 1);
    assert.equal(balanceFilter.balances[0].availableQuantity, "6.0000");
    let balance = await prisma.inventoryBalance.findUnique({
      where: { id: "outbound-smoke-balance" },
    });
    assert.deepEqual(
      [
        balance.onHandQuantity.toString(),
        balance.reservedQuantity.toString(),
        balance.availableQuantity.toString(),
      ],
      ["6", "0", "6"],
    );
    assert.equal(
      await prisma.inventoryReservationEvent.count({ where: { tenantId } }),
      3,
    );
    assert.ok((await prisma.auditLog.count({ where: { tenantId } })) >= 6);
    assert.ok(
      (await prisma.businessCommandExecution.count({
        where: { tenantId, status: "completed" },
      })) >= 6,
    );
    assert.equal(
      (
        await request(
          base,
          `/api/sales/shipments/${shipmentId}/reverse-preview`,
          { token, method: "POST", body: { reason: "API smoke correction" } },
        )
      ).allowed,
      true,
    );
    await request(base, `/api/sales/shipments/${shipmentId}/reverse`, {
      token,
      method: "POST",
      body: {
        expectedShipmentVersion: 1,
        idempotencyKey: `reverse-${randomUUID()}`,
        reason: "API smoke correction",
      },
    });
    balance = await prisma.inventoryBalance.findUnique({
      where: { id: "outbound-smoke-balance" },
    });
    assert.deepEqual(
      [
        balance.onHandQuantity.toString(),
        balance.reservedQuantity.toString(),
        balance.availableQuantity.toString(),
      ],
      ["10", "4", "6"],
    );
    postingState = await request(
      base,
      `/api/sales/shipments/${shipmentId}/posting-state`,
      { token },
    );
    assert.equal(postingState.shipment.postingStatus, "reversed");
    assert.equal(postingState.allocations[0].reversalMovementId !== null, true);
    const workbench = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/workbench",
      { token },
    );
    assert.equal(workbench.reconciliation.status, "matched");
    assert.ok(workbench.evidence.some((row) => row.commandExecutionId));
    assert.ok(
      workbench.smartLinks.some(
        (row) => row.filter?.relatedSalesOrderId === "outbound-smoke-order",
      ),
    );
    const links = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/links",
      { token },
    );
    assert.ok(Array.isArray(links));
    assert.deepEqual(links, workbench.smartLinks);
    assert.equal(
      links.find((row) => row.targetType === "shipment").targetId,
      shipmentId,
    );
    const shipmentWorkbench = await request(
      base,
      `/api/sales/shipments/${shipmentId}/workbench`,
      { token },
    );
    assert.equal(shipmentWorkbench.movements.length, 2);
    assert.equal(shipmentWorkbench.availableActions.canReverse, false);
    assert.ok(
      Array.isArray(
        await request(base, "/api/sales/orders/outbound-smoke-order/evidence", {
          token,
        }),
      ),
    );
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders/outbound-smoke-order/reconciliation",
          { token },
        )
      ).status,
      "matched",
    );

    await stop(api);
    api = startApi(env);
    await waitFor(`${base}/api/health`);
    token = await login(base);
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders/outbound-smoke-order/outbound-state",
          { token },
        )
      ).salesOrder.fulfillmentStatus,
      "not_fulfilled",
    );
    assert.equal(
      (
        await request(
          base,
          `/api/sales/shipments/${shipmentId}/posting-state`,
          { token },
        )
      ).shipment.postingStatus,
      "reversed",
    );
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders/outbound-smoke-order/reservations/reserve",
          {
            token,
            method: "POST",
            body: {
              expectedOrderVersion: 0,
              idempotencyKey: reserveKey,
              allocations: [allocation],
            },
          },
        )
      ).idempotentReplay,
      true,
    );
    await stop(api);
    api = startApi({ ...env, FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "false" });
    await waitFor(`${base}/api/health`);
    token = await login(base);
    const readOnlyWorkbench = await request(
      base,
      "/api/sales/orders/outbound-smoke-order/workbench",
      { token },
    );
    assert.ok(
      Object.entries(readOnlyWorkbench.availableActions)
        .filter(([, value]) => typeof value === "boolean")
        .every(([, value]) => value === false),
    );
    const readOnlyList = await request(base, "/api/sales/orders", { token });
    assert.equal(readOnlyList.capabilities.salesOrderLifecycle.enabled, false);
    const readOnlyEntry = await request(base, "/api/sales/order-entry-data", {
      token,
    });
    assert.equal(readOnlyEntry.capabilities.salesOrderLifecycle.enabled, false);
    assert.deepEqual(readOnlyEntry.items, []);
    const disabledCreate = await raw(base, "/api/sales/orders", {
      token,
      method: "POST",
      body: {
        orderNumber: "SO-DISABLED-API",
        customerName: "Disabled",
        currency: "CNY",
        idempotencyKey: "disabled-create-api",
        lines: [{ itemId: "outbound-smoke-item", quantity: "1" }],
      },
    });
    assert.equal(disabledCreate.response.status, 409);
    assert.equal(
      disabledCreate.payload.code,
      "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
    );
    const disabledLifecycle = await raw(
      base,
      `/api/sales/orders/${lifecycle.order.id}/hold`,
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: confirmed.order.version,
          idempotencyKey: "disabled-hold",
        },
      },
    );
    assert.equal(disabledLifecycle.response.status, 409);
    assert.equal(
      disabledLifecycle.payload.code,
      "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
    );
    await stop(api);
    api = startApi(env);
    await waitFor(`${base}/api/health`);
    token = await login(base);
    await prisma.userWarehouseScope.update({
      where: { id: scope.id },
      data: { accessLevel: "read" },
    });
    assert.equal(
      (
        await request(
          base,
          "/api/sales/orders/outbound-smoke-order/reservations/preview",
          { token, method: "POST", body: { allocations: [allocation] } },
        )
      ).allowed,
      false,
    );
    const deniedOrder = await prisma.salesOrder.findUnique({
        where: { id: "outbound-smoke-order" },
      }),
      deniedReservation = await prisma.inventoryReservation.findUnique({
        where: { id: reservationId },
      });
    const denied = await raw(
      base,
      "/api/sales/orders/outbound-smoke-order/reservations/release",
      {
        token,
        method: "POST",
        body: {
          expectedOrderVersion: deniedOrder.version,
          idempotencyKey: "denied-release",
          reason: "Scope test",
          releases: [
            {
              reservationId,
              quantity: "1",
              expectedReservationVersion: deniedReservation.version,
            },
          ],
        },
      },
    );
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.code, "WAREHOUSE_SCOPE_DENIED");
    console.log(
      "Outbound API smoke: PASS (real server, PostgreSQL, signed session, restart persistence)",
    );
  } finally {
    await stop(api);
    await prisma?.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    `Outbound API smoke: FAIL\n${String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")}`,
  );
  process.exit(1);
});
