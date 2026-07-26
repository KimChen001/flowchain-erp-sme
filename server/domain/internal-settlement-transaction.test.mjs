import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../auth/authorization-backfill.mjs";
import { createPrismaClient } from "../persistence/prisma-client.mjs";
import { createInternalSettlementCommandService, InternalSettlementError } from "./internal-settlement-command-service.mjs";
import { createInternalSettlementReadService } from "./internal-settlement-read-service.mjs";

const databaseUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-internal-settlement";
const otherTenantId = "tenant-internal-settlement-other";
const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_TEST: databaseUrl, FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: "true", FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false", NODE_ENV: "test" };
const signed = (userId, role, currentTenantId = tenantId) => ({ identity: { authenticated: true, tenantId: currentTenantId, userId, role, source: "test" } });
const admin = signed("settlement-admin", "admin");
const finance = signed("settlement-finance", "finance-specialist");
const manager = signed("settlement-manager", "manager");
const viewer = signed("settlement-viewer", "viewer");

async function seed(prisma) {
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: "Internal Settlement" }, { id: otherTenantId, name: "Other Settlement" }] });
  await prisma.user.createMany({ data: [
    { id: "settlement-admin", tenantId, email: "admin-settlement@flowchain.invalid", name: "Settlement Admin", role: "admin" },
    { id: "settlement-finance", tenantId, email: "finance-settlement@flowchain.invalid", name: "Settlement Finance", role: "finance-specialist" },
    { id: "settlement-manager", tenantId, email: "manager-settlement@flowchain.invalid", name: "Settlement Manager", role: "manager" },
    { id: "settlement-viewer", tenantId, email: "viewer-settlement@flowchain.invalid", name: "Settlement Viewer", role: "viewer" },
    { id: "settlement-other-admin", tenantId: otherTenantId, email: "other-settlement@flowchain.invalid", name: "Other Settlement", role: "admin" },
  ] });
  await backfillTenantAuthorization(prisma, tenantId, { actorId: "settlement-admin" });
  await backfillTenantAuthorization(prisma, otherTenantId, { actorId: "settlement-other-admin" });
  await prisma.supplierInvoice.createMany({ data: [
    { id: "settlement-supplier-invoice-60", tenantId, invoiceNumber: "SI-SETTLE-60", supplierId: "supplier-settle", supplierName: "Settlement Supplier", totalAmount: "60.0000", amount: "60.0000", currency: "CNY", status: "approved" },
    { id: "settlement-supplier-invoice-40", tenantId, invoiceNumber: "SI-SETTLE-40", supplierId: "supplier-settle", supplierName: "Settlement Supplier", totalAmount: "40.0000", amount: "40.0000", currency: "CNY", status: "approved" },
    { id: "settlement-supplier-invoice-held", tenantId, invoiceNumber: "SI-HELD", supplierId: "supplier-settle", supplierName: "Settlement Supplier", totalAmount: "10.0000", amount: "10.0000", currency: "CNY", status: "approved" },
  ] });
  await prisma.payableObligation.createMany({ data: [
    { id: "payable-settle-60", tenantId, supplierInvoiceId: "settlement-supplier-invoice-60", obligationNumber: "AP-SETTLE-60", originalAmount: "60.0000", outstandingAmount: "60.0000", currency: "CNY", dueDate: new Date("2026-08-01"), status: "approved" },
    { id: "payable-settle-40", tenantId, supplierInvoiceId: "settlement-supplier-invoice-40", obligationNumber: "AP-SETTLE-40", originalAmount: "40.0000", outstandingAmount: "40.0000", currency: "CNY", dueDate: new Date("2026-08-01"), status: "approved" },
    { id: "payable-held", tenantId, supplierInvoiceId: "settlement-supplier-invoice-held", obligationNumber: "AP-HELD", originalAmount: "10.0000", outstandingAmount: "10.0000", currency: "CNY", dueDate: new Date("2026-08-01"), status: "held" },
  ] });
  await prisma.item.create({ data: { id: "item-settlement", tenantId, sku: "SETTLE", name: "Settlement Item", unit: "EA" } });
  await prisma.salesOrder.create({ data: { id: "sales-order-settlement", tenantId, orderNumber: "SO-SETTLE", customerId: "customer-settle", customerName: "Settlement Customer", workflowStatus: "confirmed", currency: "CNY", lines: { create: { id: "sales-order-line-settlement", itemId: "item-settlement", sku: "SETTLE", itemName: "Settlement Item", orderedQuantity: "10.0000", fulfilledQuantity: "10.0000", unit: "EA", unitPrice: "8.0000", amount: "80.0000" } } } });
  await prisma.shipmentDocument.create({ data: { id: "shipment-settlement", tenantId, shipmentNumber: "SHIP-SETTLE", salesOrderId: "sales-order-settlement", workflowStatus: "ready", postingStatus: "posted", lines: { create: { id: "shipment-line-settlement", salesOrderLineId: "sales-order-line-settlement", itemId: "item-settlement", sku: "SETTLE", requestedQuantity: "10.0000", postedQuantity: "10.0000", unit: "EA" } } } });
  await prisma.customerInvoice.create({ data: { id: "customer-invoice-settlement", tenantId, invoiceNumber: "CI-SETTLE", salesOrderId: "sales-order-settlement", shipmentId: "shipment-settlement", customerId: "customer-settle", customerNameSnapshot: "Settlement Customer", invoiceDate: new Date("2026-07-01"), dueDate: new Date("2026-08-01"), subtotalAmount: "80.0000", totalAmount: "80.0000", currency: "CNY", status: "issued" } });
  await prisma.receivableObligation.createMany({ data: [
    { id: "receivable-settle", tenantId, customerInvoiceId: "customer-invoice-settlement", obligationNumber: "AR-SETTLE", originalAmount: "80.0000", outstandingAmount: "80.0000", currency: "CNY", dueDate: new Date("2026-08-01"), status: "open" },
  ] });
  await prisma.supplierInvoice.create({ data: { id: "other-supplier-invoice", tenantId: otherTenantId, invoiceNumber: "SI-OTHER", supplierId: "other-supplier", supplierName: "Other Supplier", totalAmount: "20.0000", amount: "20.0000", currency: "CNY", status: "approved" } });
  await prisma.payableObligation.create({ data: { id: "other-payable", tenantId: otherTenantId, supplierInvoiceId: "other-supplier-invoice", obligationNumber: "AP-OTHER", originalAmount: "20.0000", outstandingAmount: "20.0000", currency: "CNY", dueDate: new Date("2026-08-01"), status: "approved" } });
}

test("internal settlement and cashbook are atomic, authorized, reconcilable, and safely reversible", { skip: !enabled }, async () => {
  const prisma = await createPrismaClient(env);
  try {
    await seed(prisma);
    const command = createInternalSettlementCommandService({ prisma, env });
    const read = createInternalSettlementReadService({ prisma, capabilities: { cashbook: { enabled: true }, "internal-settlement": { enabled: true } } });
    const approveForPosting = async (settlement, key) => {
      const submitted = await command.submitSettlement(settlement.entityId, { expectedVersion: 0, idempotencyKey: `${key}-submit` }, finance);
      return command.approveSettlement(settlement.entityId, { expectedVersion: submitted.settlement.version, idempotencyKey: `${key}-approve` }, admin);
    };
    const disabledCommand = createInternalSettlementCommandService({
      prisma,
      env: { ...env, FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: "false" },
    });
    await assert.rejects(
      () => disabledCommand.createCashbookAccount({ accountCode: "DISABLED", name: "Disabled", accountType: "cash", currency: "CNY", openingBalance: "0", idempotencyKey: "disabled-account" }, admin),
      (error) => error.code === "INTERNAL_SETTLEMENT_CAPABILITY_NOT_AVAILABLE",
    );
    assert.equal(await prisma.cashbookAccount.count({ where: { tenantId } }), 0);
    const account = await command.createCashbookAccount({ accountCode: "CNY-OPERATING", name: "CNY Operating Cash", accountType: "bank", currency: "CNY", openingBalance: "200.0000", idempotencyKey: "account-main" }, admin);
    assert.equal(account.account.currentBalance, "200.0000");
    assert.equal((await command.createCashbookAccount({ accountCode: "CNY-OPERATING", name: "CNY Operating Cash", accountType: "bank", currency: "CNY", openingBalance: "200.0000", idempotencyKey: "account-main" }, admin)).idempotentReplay, true);
    await assert.rejects(() => command.createCashbookAccount({ accountCode: "CHANGED", name: "Changed", accountType: "cash", currency: "CNY", openingBalance: "1", idempotencyKey: "account-main" }, admin), (error) => error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
    const payload = { settlementNumber: "SET-DISB-100", direction: "disbursement", counterpartyType: "supplier", counterpartyId: "supplier-settle", cashbookAccountId: account.account.id, currency: "CNY", amount: "100.0000", settlementDate: "2026-07-20", allocations: [{ obligationType: "payable", obligationId: "payable-settle-60", amount: "60.0000" }, { obligationType: "payable", obligationId: "payable-settle-40", amount: "40.0000" }] };
    assert.equal((await command.previewSettlement(payload, finance)).allowed, true);
    const draft = await command.createSettlement({ ...payload, idempotencyKey: "create-disb-100" }, finance);
    assert.equal((await command.createSettlement({ ...payload, idempotencyKey: "create-disb-100" }, finance)).idempotentReplay, true);
    const approvedDraft = await approveForPosting(draft, "disb-100");
    const posted = await command.postSettlement(draft.entityId, { expectedVersion: approvedDraft.settlement.version, idempotencyKey: "post-disb-100" }, finance);
    assert.equal(posted.cashbookEntry.balanceAfter, "100.0000");
    assert.deepEqual((await prisma.payableObligation.findMany({ where: { id: { in: ["payable-settle-60", "payable-settle-40"] } }, orderBy: { id: "asc" } })).map((row) => [row.status, String(row.outstandingAmount)]), [["settled", "0"], ["settled", "0"]]);
    assert.equal((await read.reconciliation(draft.entityId, finance)).status, "matched");
    const viewerDetail = await read.detail(draft.entityId, viewer);
    assert.equal(viewerDetail.amount, null);
    assert.deepEqual(viewerDetail.availableActions, []);
    await assert.rejects(() => command.reverseSettlement(draft.entityId, { expectedVersion: posted.settlement.version, reason: "manager lacks amount visibility", idempotencyKey: "manager-reverse" }, manager), (error) => error.name === "AuthorizationError");
    const reversed = await command.reverseSettlement(draft.entityId, { expectedVersion: posted.settlement.version, reason: "correct internal posting", idempotencyKey: "reverse-disb-100" }, finance);
    assert.equal(reversed.cashbookEntry.balanceAfter, "200.0000");
    assert.equal((await read.reconciliation(draft.entityId, finance)).status, "matched");
    await assert.rejects(() => prisma.cashbookEntry.update({ where: { id: posted.cashbookEntry.id }, data: { amount: "99.0000" } }), /immutable/i);
    await assert.rejects(() => prisma.cashbookEntry.delete({ where: { id: posted.cashbookEntry.id } }), /immutable/i);

    const receiptAccount = await command.createCashbookAccount({ accountCode: "CNY-RECEIPTS", name: "CNY Receipts", accountType: "bank", currency: "CNY", openingBalance: "0", idempotencyKey: "account-receipt" }, admin);
    const receiptPayload = { settlementNumber: "SET-RECEIPT-50", direction: "receipt", counterpartyType: "customer", counterpartyId: "customer-settle", cashbookAccountId: receiptAccount.account.id, currency: "CNY", amount: "50.0000", settlementDate: "2026-07-20", allocations: [{ obligationType: "receivable", obligationId: "receivable-settle", amount: "50.0000" }] };
    const receipt = await command.createSettlement({ ...receiptPayload, idempotencyKey: "create-receipt" }, finance);
    const approvedReceipt = await approveForPosting(receipt, "receipt-50");
    const postedReceipt = await command.postSettlement(receipt.entityId, { expectedVersion: approvedReceipt.settlement.version, idempotencyKey: "post-receipt" }, finance);
    assert.equal(String((await prisma.receivableObligation.findUnique({ where: { id: "receivable-settle" } })).outstandingAmount), "30");
    await command.reverseSettlement(receipt.entityId, { expectedVersion: postedReceipt.settlement.version, reason: "receipt correction", idempotencyKey: "reverse-receipt" }, finance);
    assert.equal(String((await prisma.receivableObligation.findUnique({ where: { id: "receivable-settle" } })).outstandingAmount), "80");

    assert.equal((await command.previewSettlement({ ...payload, settlementNumber: "HELD", amount: "10", allocations: [{ obligationType: "payable", obligationId: "payable-held", amount: "10" }] }, finance)).allowed, false);
    assert.equal((await command.previewSettlement({ ...payload, settlementNumber: "OTHER", amount: "20", allocations: [{ obligationType: "payable", obligationId: "other-payable", amount: "20" }] }, finance)).allowed, false);
    assert.equal((await command.previewSettlement({ ...payload, settlementNumber: "FX", currency: "USD" }, finance)).allowed, false);

    const low = await command.createCashbookAccount({ accountCode: "LOW", name: "Low Cash", accountType: "cash", currency: "CNY", openingBalance: "0", idempotencyKey: "account-low" }, admin);
    const lowDraft = await command.createSettlement({ ...payload, settlementNumber: "LOW-DISB", cashbookAccountId: low.account.id, amount: "10", allocations: [{ obligationType: "payable", obligationId: "payable-settle-60", amount: "10" }], idempotencyKey: "create-low" }, finance);
    const approvedLow = await approveForPosting(lowDraft, "low-disb");
    await assert.rejects(() => command.postSettlement(lowDraft.entityId, { expectedVersion: approvedLow.settlement.version, idempotencyKey: "post-low" }, finance), (error) => error instanceof InternalSettlementError && error.code === "CASHBOOK_INSUFFICIENT_BALANCE");

    const concurrentDrafts = [];
    for (const suffix of ["A", "B"]) {
      concurrentDrafts.push(await command.createSettlement({ ...payload, settlementNumber: `CONCURRENT-${suffix}`, amount: "40", allocations: [{ obligationType: "payable", obligationId: "payable-settle-60", amount: "40" }], idempotencyKey: `create-concurrent-${suffix}` }, finance));
    }
    const approvedConcurrent = [];
    for (const [index, row] of concurrentDrafts.entries()) approvedConcurrent.push(await approveForPosting(row, `concurrent-${index}`));
    const concurrent = await Promise.allSettled(approvedConcurrent.map((row, index) => command.postSettlement(row.entityId, { expectedVersion: row.settlement.version, idempotencyKey: `post-concurrent-${index}` }, finance)));
    assert.equal(concurrent.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((row) => row.status === "rejected").length, 1);
    const winner = concurrent.find((row) => row.status === "fulfilled").value;
    await command.reverseSettlement(winner.entityId, { expectedVersion: winner.settlement.version, reason: "concurrency cleanup", idempotencyKey: "reverse-concurrent" }, finance);
    assert.ok(await prisma.auditLog.count({ where: { tenantId, source: "internal_settlement_command_service" } }) >= 8);
    assert.equal(await prisma.cashbookEntry.count({ where: { tenantId } }), 6);
  } finally {
    await prisma.$disconnect();
  }
});
