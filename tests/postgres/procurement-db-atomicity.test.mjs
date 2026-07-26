import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../../server/auth/authorization-backfill.mjs";
import { createDbProcurementCommandService } from "../../server/domain/procurement-db-command-service.mjs";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";

const tenantId = "tenant-phase-5-2c1-po-atomicity";
const userId = "phase-5-2c1-po-admin";
const identity = { authenticated: true, tenantId, userId, role: "admin" };
const context = { identity };

test("real PostgreSQL PO command fault injection rolls back every formal fact", async (t) => {
  const prisma = await createPrismaClient(process.env);
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: "Phase 5.2C.1 PO Atomicity" } });
    await prisma.user.create({ data: { id: userId, tenantId, email: "po-admin@phase-5-2c1.invalid", name: "PO Admin", role: "admin" } });
    await backfillTenantAuthorization(prisma, tenantId, { actorId: userId });

    const faultPoints = ["after_po_update", "before_audit", "before_change_feed", "before_commit"];
    for (const [index, faultPoint] of faultPoints.entries()) {
      await t.test(`${faultPoint} is atomic`, async () => {
        const poId = `PO-FAULT-${index}`;
        const key = `po-fault-${index}`;
        await prisma.purchaseOrder.create({ data: { id: poId, tenantId, status: "pending_approval", supplierId: "supplier-a", supplierName: "Supplier A", amount: "100.0000", currency: "CNY", version: 7, lines: { create: { id: `${poId}-line`, sku: "PO-ITEM", itemName: "PO Item", orderedQuantity: "1.0000", receivedQuantity: "0.0000", unit: "EA", unitPrice: "100.0000", amount: "100.0000" } } } });
        const service = createDbProcurementCommandService({ prisma, env: process.env, faultInjection: faultPoint });
        await assert.rejects(() => service.approvePurchaseOrder(poId, { expectedVersion: 7, idempotencyKey: key }, context), (error) => error.code === "PROCUREMENT_FAULT_INJECTED" && error.details?.stage === faultPoint);
        const row = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
        assert.equal(row.status, "pending_approval");
        assert.equal(row.version, 7);
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId, entityType: "PurchaseOrder", entityId: poId } }), 0);
        assert.equal(await prisma.auditLog.count({ where: { tenantId, entityType: "PurchaseOrder", entityId: poId } }), 0);
        assert.equal(await prisma.domainChangeFeed.count({ where: { tenantId, entityType: "PurchaseOrder", entityId: poId } }), 0);
      });
    }

    await t.test("the same formal command succeeds exactly once after fault injection is disabled", async () => {
      const poId = "PO-SUCCESS";
      await prisma.purchaseOrder.create({ data: { id: poId, tenantId, status: "pending_approval", supplierId: "supplier-a", supplierName: "Supplier A", amount: "25.0000", currency: "CNY", version: 0 } });
      const service = createDbProcurementCommandService({ prisma, env: process.env });
      const result = await service.approvePurchaseOrder(poId, { expectedVersion: 0, idempotencyKey: "po-success" }, context);
      assert.equal(result.status, "approved");
      assert.equal(result.entityVersion, 1);
      assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId, entityType: "PurchaseOrder", entityId: poId, status: "completed" } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { tenantId, entityType: "PurchaseOrder", entityId: poId } }), 1);
      assert.equal(await prisma.domainChangeFeed.count({ where: { tenantId, entityType: "PurchaseOrder", entityId: poId } }), 1);
      const replay = await service.approvePurchaseOrder(poId, { expectedVersion: 0, idempotencyKey: "po-success" }, context);
      assert.equal(replay.idempotentReplay, true);
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: poId } })).version, 1);
    });
  } finally {
    await prisma.$disconnect();
  }
});
