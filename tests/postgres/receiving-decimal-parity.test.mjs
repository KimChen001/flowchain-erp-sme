import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../../server/auth/authorization-backfill.mjs";
import { createMobileOperationsService } from "../../server/domain/mobile-operations-service.mjs";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";

const tenantId = "tenant-phase-5-2c1-decimal-parity";
const userId = "phase-5-2c1-decimal-admin";
const warehouseId = "decimal-warehouse";
const context = { identity: { authenticated: true, tenantId, userId, role: "admin" } };

async function seedPo(prisma, suffix, orderedQuantity, receivedQuantity = "0.0000") {
  const poId = `decimal-po-${suffix}`, lineId = `${poId}-line`, itemId = `decimal-item-${suffix}`;
  await prisma.item.create({ data: { id: itemId, tenantId, sku: `DEC-${suffix}`, name: `Decimal Item ${suffix}`, unit: "EA" } });
  await prisma.purchaseOrder.create({ data: { id: poId, tenantId, status: receivedQuantity === "0.0000" ? "issued" : "partially_received", supplierId: "decimal-supplier", supplierName: "Decimal Supplier", currency: "CNY", lines: { create: { id: lineId, itemId, sku: `DEC-${suffix}`, itemName: `Decimal Item ${suffix}`, orderedQuantity, receivedQuantity, unit: "EA" } } } });
  return { poId, lineId, itemId };
}

const draftInput = (source, suffix, acceptedQuantity) => ({
  poId: source.poId,
  warehouseId,
  idempotencyKey: `decimal-create-${suffix}`,
  lines: [{ purchaseOrderLineId: source.lineId, acceptedQuantity, rejectedQuantity: "0", damagedQuantity: "0", warehouseId, location: "A-01" }],
});

test("mobile receiving and canonical posting share exact four-decimal quantity semantics", async (t) => {
  const prisma = await createPrismaClient(process.env);
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: "Phase 5.2C.1 Decimal Parity" } });
    await prisma.user.create({ data: { id: userId, tenantId, email: "decimal-admin@phase-5-2c1.invalid", name: "Decimal Admin", role: "admin" } });
    await prisma.warehouse.create({ data: { id: warehouseId, tenantId, code: "DEC-WH", name: "Decimal Warehouse" } });
    await backfillTenantAuthorization(prisma, tenantId, { actorId: userId });
    const mobile = createMobileOperationsService({ prisma, env: process.env });

    await t.test("0.3000 ordered minus 0.1000 received accepts and posts exactly 0.2000", async () => {
      const source = await seedPo(prisma, "exact", "0.3000", "0.1000");
      const draft = await mobile.createReceivingDraft(draftInput(source, "exact", "0.2000"), context);
      const submitted = await mobile.submitReceivingDraft(draft.entityId, { expectedVersion: 0, idempotencyKey: "decimal-submit-exact" }, context);
      const preview = await mobile.previewReceiving(draft.entityId, context);
      assert.equal(preview.allowed, true);
      const posted = await mobile.postReceiving(draft.entityId, { expectedVersion: submitted.receivingDocument.version, idempotencyKey: "decimal-post-exact" }, context);
      assert.equal(posted.receivingDocument.postingStatus, "posted");
      assert.equal(String((await prisma.purchaseOrderLine.findUnique({ where: { id: source.lineId } })).receivedQuantity), "0.3");
      const movement = await prisma.inventoryMovement.findFirst({ where: { tenantId, relatedGrnId: draft.entityId } });
      assert.equal(String(movement.quantityIn), "0.2");
      const balance = await prisma.inventoryBalance.findFirst({ where: { tenantId, sku: `DEC-exact`, warehouseId, locationKey: "a-01" } });
      assert.equal(String(balance.onHandQuantity), "0.2");
    });

    await t.test("0.2001 over a 0.2000 remainder is rejected before any formal receiving facts", async () => {
      const source = await seedPo(prisma, "over", "0.3000", "0.1000");
      const before = await prisma.receivingDocument.count({ where: { tenantId } });
      await assert.rejects(() => mobile.createReceivingDraft(draftInput(source, "over", "0.2001"), context), (error) => error.code === "RECEIVING_OVER_RECEIPT" && error.details?.remainingQuantity === "0.2000");
      assert.equal(await prisma.receivingDocument.count({ where: { tenantId } }), before);
      assert.equal(await prisma.inventoryMovement.count({ where: { tenantId, sku: "DEC-over" } }), 0);
    });

    await t.test("the minimum supported 0.0001 quantity survives draft, preview, and posting", async () => {
      const source = await seedPo(prisma, "minimum", "0.0001");
      const draft = await mobile.createReceivingDraft(draftInput(source, "minimum", "0.0001"), context);
      const submitted = await mobile.submitReceivingDraft(draft.entityId, { expectedVersion: 0, idempotencyKey: "decimal-submit-minimum" }, context);
      assert.equal((await mobile.previewReceiving(draft.entityId, context)).allowed, true);
      await mobile.postReceiving(draft.entityId, { expectedVersion: submitted.receivingDocument.version, idempotencyKey: "decimal-post-minimum" }, context);
      assert.equal(String((await prisma.purchaseOrderLine.findUnique({ where: { id: source.lineId } })).receivedQuantity), "0.0001");
      assert.equal(String((await prisma.inventoryMovement.findFirst({ where: { tenantId, relatedGrnId: draft.entityId } })).quantityIn), "0.0001");
    });

    await t.test("five-decimal input is rejected instead of silently rounded", async () => {
      const source = await seedPo(prisma, "precision", "1.0000");
      const before = await prisma.receivingDocument.count({ where: { tenantId } });
      await assert.rejects(() => mobile.createReceivingDraft(draftInput(source, "precision", "0.00001"), context), (error) => error.code === "RECEIVING_VALIDATION_FAILED" && error.status === 422);
      assert.equal(await prisma.receivingDocument.count({ where: { tenantId } }), before);
    });
  } finally {
    await prisma.$disconnect();
  }
});
