import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../../server/auth/authorization-backfill.mjs";
import { createAdvanceApplicationCommandService } from "../../server/domain/advance-application-command-service.mjs";
import { createOperationalFinanceO2cCommandService } from "../../server/domain/operational-finance-o2c-command-service.mjs";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";

const tenantId = "tenant-phase-5-2c1-dispute-advance";
const userId = "phase-5-2c1-dispute-admin";
const context = { identity: { authenticated: true, tenantId, userId, role: "admin" } };

test("formal receivable disputes block advance application until formally resolved", async () => {
  const prisma = await createPrismaClient(process.env);
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: "Phase 5.2C.1 Dispute Eligibility" } });
    await prisma.user.create({ data: { id: userId, tenantId, email: "dispute-admin@phase-5-2c1.invalid", name: "Dispute Admin", role: "admin" } });
    await backfillTenantAuthorization(prisma, tenantId, { actorId: userId });
    await prisma.item.create({ data: { id: "dispute-item", tenantId, sku: "DSP-ITEM", name: "Dispute Item", unit: "EA" } });
    await prisma.salesOrder.create({ data: { id: "dispute-so", tenantId, orderNumber: "SO-DSP", customerId: "customer-dispute", customerName: "Dispute Customer", workflowStatus: "confirmed", reservationStatus: "fully_reserved", fulfillmentStatus: "fully_fulfilled", currency: "CNY", lines: { create: { id: "dispute-so-line", itemId: "dispute-item", sku: "DSP-ITEM", itemName: "Dispute Item", orderedQuantity: "10.0000", fulfilledQuantity: "10.0000", unit: "EA", unitPrice: "10.0000", amount: "100.0000" } } } });
    await prisma.shipmentDocument.create({ data: { id: "dispute-shipment", tenantId, shipmentNumber: "SHIP-DSP", salesOrderId: "dispute-so", workflowStatus: "ready", postingStatus: "posted", postedAt: new Date("2026-07-20T00:00:00.000Z"), postedById: userId, lines: { create: { id: "dispute-shipment-line", salesOrderLineId: "dispute-so-line", itemId: "dispute-item", sku: "DSP-ITEM", requestedQuantity: "10.0000", postedQuantity: "10.0000", unit: "EA" } } } });

    const o2c = createOperationalFinanceO2cCommandService({ prisma, env: process.env, now: () => new Date("2026-07-22T00:00:00.000Z") });
    const created = await o2c.createCustomerInvoice({ shipmentId: "dispute-shipment", currency: "CNY", invoiceDate: "2026-07-22", dueDate: "2026-08-22", totalAmount: "42.0000", lines: [{ shipmentLineId: "dispute-shipment-line", quantity: "4.0000", enteredTaxAmount: "2.0000" }], idempotencyKey: "dispute-invoice-create" }, context);
    await o2c.submitCustomerInvoice(created.invoice.id, { expectedVersion: 0, idempotencyKey: "dispute-invoice-submit" }, context);
    await o2c.approveCustomerInvoice(created.invoice.id, { expectedVersion: 1, idempotencyKey: "dispute-invoice-approve" }, context);
    const issued = await o2c.issueCustomerInvoice(created.invoice.id, { expectedVersion: 2, obligationNumber: "AR-DSP", idempotencyKey: "dispute-invoice-issue" }, context);
    assert.equal(issued.receivable.status, "open");

    await prisma.cashbookAccount.create({ data: { id: "dispute-cashbook", tenantId, accountCode: "DSP-CASH", name: "Dispute Cashbook", accountType: "bank", currency: "CNY", openingBalance: "50.0000", currentBalance: "50.0000" } });
    await prisma.settlementDocument.create({ data: { id: "dispute-settlement", tenantId, settlementNumber: "SET-DSP", direction: "receipt", counterpartyType: "customer", counterpartyId: "customer-dispute", cashbookAccountId: "dispute-cashbook", currency: "CNY", amount: "20.0000", cashAmount: "20.0000", totalSettlementAmount: "20.0000", advanceCreatedAmount: "20.0000", settlementDate: new Date("2026-07-22T00:00:00.000Z"), status: "posted", workflowStatus: "posted", postingStatus: "posted", postedAt: new Date("2026-07-22T00:00:00.000Z"), postedById: userId } });
    await prisma.partnerAdvance.create({ data: { id: "dispute-advance", tenantId, advanceNumber: "ADV-DSP", advanceType: "customer_advance", customerId: "customer-dispute", currency: "CNY", originalAmount: "20.0000", remainingAmount: "20.0000", sourceSettlementId: "dispute-settlement", createdById: userId } });

    const disputed = await o2c.disputeReceivable(issued.receivable.id, { expectedVersion: 0, reason: "Customer formally disputes delivered quantity", idempotencyKey: "receivable-dispute" }, context);
    assert.equal(disputed.receivable.status, "disputed");
    assert.equal(disputed.receivable.disputeStatus, "open");

    const applications = createAdvanceApplicationCommandService({ prisma, env: process.env, now: () => new Date("2026-07-22T00:00:00.000Z") });
    const input = { applicationNumber: "AAP-DSP", advanceId: "dispute-advance", receivableObligationId: issued.receivable.id, appliedAmount: "10.0000", currency: "CNY", idempotencyKey: "disputed-application" };
    await assert.rejects(() => applications.createAdvanceApplication(input, context), (error) => error.code === "ADVANCE_APPLICATION_OBLIGATION_NOT_ELIGIBLE" && error.details?.status === "disputed" && error.details?.disputeStatus === "open");
    assert.equal(await prisma.advanceApplicationDocument.count({ where: { tenantId } }), 0);

    const resolved = await o2c.resolveReceivableDispute(issued.receivable.id, { expectedVersion: 1, reason: "Customer accepted the delivery evidence", idempotencyKey: "receivable-resolve" }, context);
    assert.equal(resolved.receivable.status, "open");
    assert.equal(resolved.receivable.disputeStatus, "resolved");
    const allowed = await applications.createAdvanceApplication({ ...input, idempotencyKey: "resolved-application" }, context);
    assert.equal(allowed.application.workflowStatus, "draft");
    assert.equal(await prisma.advanceApplicationDocument.count({ where: { tenantId } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});
