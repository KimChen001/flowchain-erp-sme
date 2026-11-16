import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backfillTenantAuthorization } from "../auth/authorization-backfill.mjs";
import { createPrismaClient } from "../persistence/prisma-client.mjs";
import { createAdvanceApplicationCommandService } from "./advance-application-command-service.mjs";
import { createAttachmentService } from "./attachment-service.mjs";
import { createInternalSettlementCommandService } from "./internal-settlement-command-service.mjs";
import { createInternalTransferCommandService } from "./internal-transfer-command-service.mjs";
import { loadAuthorizedSyncProjection } from "./mobile-sync-entity-policy.mjs";
import { createMobileSyncService } from "./mobile-sync-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";

const databaseUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-phase-52b";
const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_TEST: databaseUrl, FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: "true", FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "true", FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "true", FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "true", FLOWCHAIN_SYNC_CURSOR_SECRET: "phase-52b-test-sync-secret-at-least-32", NODE_ENV: "test" };
const context = (userId, role) => ({ identity: { authenticated: true, tenantId, userId, role, source: "test" } });
const admin = context("phase52b-admin", "admin"), finance = context("phase52b-finance", "finance-specialist");

async function seed(prisma) {
  await prisma.tenant.create({ data: { id: tenantId, name: "Phase 5.2B", operationalSettings: { settlementPolicy: { settlementApprovalRequired: true, settlementSelfApprovalAllowed: false, settlementSelfPostingAllowed: true, settlementApprovalThreshold: 0, settlementDiscountThreshold: 0 } } } });
  await prisma.user.createMany({ data: [{ id: "phase52b-admin", tenantId, email: "phase52b-admin@example.invalid", name: "Phase 52B Admin", role: "admin" }, { id: "phase52b-finance", tenantId, email: "phase52b-finance@example.invalid", name: "Phase 52B Finance", role: "finance-specialist" }] });
  await backfillTenantAuthorization(prisma, tenantId, { actorId: "phase52b-admin" });
  await prisma.supplierInvoice.create({ data: { id: "phase52b-invoice", tenantId, invoiceNumber: "SI-52B", supplierId: "supplier-52b", supplierName: "Phase Supplier", totalAmount: "100", amount: "100", currency: "CNY", status: "approved" } });
  await prisma.payableObligation.create({ data: { id: "phase52b-payable", tenantId, supplierInvoiceId: "phase52b-invoice", obligationNumber: "AP-52B", originalAmount: "100", outstandingAmount: "100", currency: "CNY", dueDate: new Date("2026-08-20"), status: "approved" } });
}

test("settlement workflow, advance application, internal transfer, and sync feed remain atomic", { skip: !enabled }, async () => {
  const uploadDirectory = await mkdtemp(join(tmpdir(), "flowchain-phase52b-uploads-"));
  const testEnv = { ...env, FLOWCHAIN_UPLOAD_STORAGE_DIR: uploadDirectory };
  const prisma = await createPrismaClient(testEnv);
  try {
    await seed(prisma);
    const settlement = createInternalSettlementCommandService({ prisma, env });
    const transfer = createInternalTransferCommandService({ prisma, env });
    const application = createAdvanceApplicationCommandService({ prisma, env });
    const sync = createMobileSyncService({ prisma, env: testEnv });
    const attachments = createAttachmentService({ prisma, env: testEnv });
    const from = await settlement.createCashbookAccount({ accountCode: "FROM", name: "From", accountType: "bank", currency: "CNY", openingBalance: "500", idempotencyKey: "account-from" }, admin);
    const to = await settlement.createCashbookAccount({ accountCode: "TO", name: "To", accountType: "bank", currency: "CNY", openingBalance: "0", idempotencyKey: "account-to" }, admin);
    const draft = await settlement.createSettlement({ settlementNumber: "SET-52B", direction: "disbursement", counterpartyType: "supplier", counterpartyId: "supplier-52b", cashbookAccountId: from.entityId, currency: "CNY", amount: "100", settlementDate: "2026-07-20", allocations: [{ obligationType: "payable", obligationId: "phase52b-payable", cashAppliedAmount: "70", discountAmount: "0", totalSettlementAmount: "70" }], idempotencyKey: "settlement-create" }, finance);
    const submitted = await settlement.submitSettlement(draft.entityId, { expectedVersion: 0, idempotencyKey: "settlement-submit" }, finance);
    await assert.rejects(() => settlement.approveSettlement(draft.entityId, { expectedVersion: submitted.settlement.version, idempotencyKey: "settlement-self-approve" }, finance), (error) => error.code === "SETTLEMENT_SELF_APPROVAL_BLOCKED");
    const approved = await settlement.approveSettlement(draft.entityId, { expectedVersion: submitted.settlement.version, idempotencyKey: "settlement-approve" }, admin);
    const posted = await settlement.postSettlement(draft.entityId, { expectedVersion: approved.settlement.version, idempotencyKey: "settlement-post" }, finance);
    assert.equal(posted.settlement.workflowStatus, "posted");
    assert.equal(posted.partnerAdvance.remainingAmount, "30.0000");
    assert.equal(String((await prisma.payableObligation.findUnique({ where: { id: "phase52b-payable" } })).outstandingAmount), "30");

    const appDraft = await application.createAdvanceApplication({ applicationNumber: "AAP-52B", advanceId: posted.partnerAdvance.id, payableObligationId: "phase52b-payable", appliedAmount: "20", currency: "CNY", idempotencyKey: "application-create" }, finance);
    const appSubmitted = await application.submitAdvanceApplication(appDraft.entityId, { expectedVersion: 0, idempotencyKey: "application-submit" }, finance);
    const appApproved = await application.approveAdvanceApplication(appDraft.entityId, { expectedVersion: appSubmitted.application.version, idempotencyKey: "application-approve" }, admin);
    const appPosted = await application.postAdvanceApplication(appDraft.entityId, { expectedVersion: appApproved.application.version, idempotencyKey: "application-post" }, finance);
    assert.equal(appPosted.cashbookEntryCount, 0);
    assert.equal(appPosted.advance.remainingAmount, "10.0000");
    const appReversed = await application.reverseAdvanceApplication(appDraft.entityId, { expectedVersion: appPosted.application.version, reason: "test exact reversal", idempotencyKey: "application-reverse" }, finance);
    assert.equal(appReversed.advance.remainingAmount, "30.0000");

    const transferDraft = await transfer.createInternalTransfer({ transferNumber: "TR-52B", fromCashbookAccountId: from.entityId, toCashbookAccountId: to.entityId, currency: "CNY", amount: "50", transferDate: "2026-07-20", idempotencyKey: "transfer-create" }, finance);
    const transferSubmitted = await transfer.submitInternalTransfer(transferDraft.entityId, { expectedVersion: 0, idempotencyKey: "transfer-submit" }, finance);
    const transferApproved = await transfer.approveInternalTransfer(transferDraft.entityId, { expectedVersion: transferSubmitted.transfer.version, idempotencyKey: "transfer-approve" }, admin);
    const transferPosted = await transfer.postInternalTransfer(transferDraft.entityId, { expectedVersion: transferApproved.transfer.version, idempotencyKey: "transfer-post" }, finance);
    assert.equal(new Set((await prisma.cashbookEntry.findMany({ where: { internalTransferId: transferDraft.entityId } })).map((entry) => entry.postingBatchId)).size, 1);
    const transferReversed = await transfer.reverseInternalTransfer(transferDraft.entityId, { expectedVersion: transferPosted.transfer.version, reason: "test exact reversal", idempotencyKey: "transfer-reverse" }, finance);
    assert.equal(transferReversed.cashbookEntryIds.length, 2);

    const registered = await sync.register({ deviceId: "phase52b-device-a", platform: "pwa", appVersion: "0.5.2b" }, admin);
    assert.notEqual(registered.deviceIdHash, "phase52b-device-a");
    const initial = await sync.initial({ clientId: registered.clientId, deviceId: "phase52b-device-a", limit: 200 }, admin);
    assert.ok(initial.changes.some((change) => change.entityType === "SettlementDocument"));
    assert.equal(initial.changes.some((change) => "amount" in change || "payload" in change), false);
    assert.ok(await prisma.domainChangeFeed.count({ where: { tenantId } }) > 0);

    const [cursorPayload, cursorSignature] = initial.cursor.split(".");
    const tamperedCursor = `${cursorPayload}.${cursorSignature.startsWith("A") ? "B" : "A"}${cursorSignature.slice(1)}`;
    assert.notEqual(tamperedCursor, initial.cursor);
    await assert.rejects(() => sync.changes({ clientId: registered.clientId, deviceId: "phase52b-device-a", cursor: tamperedCursor }, admin), (error) => error.code === "SYNC_CURSOR_TAMPERED");
    const deviceB = await sync.register({ deviceId: "phase52b-device-b", platform: "ios" }, admin);
    await assert.rejects(() => sync.changes({ clientId: deviceB.clientId, deviceId: "phase52b-device-b", cursor: initial.cursor }, admin), (error) => error.code === "SYNC_CURSOR_DEVICE_MISMATCH");

    const client = await prisma.syncClient.findUnique({ where: { id: registered.clientId } });
    const beforeSensitive = await prisma.domainChangeFeed.aggregate({ where: { tenantId }, _max: { sequence: true } });
    const financeFingerprint = await sync.authorizationFingerprint(await (await import("./pilot-identity.mjs")).resolveProvisionedActor(prisma, finance.identity));
    const financeClient = await sync.register({ deviceId: "phase52b-finance-device", platform: "android" }, finance);
    const financeRow = await prisma.syncClient.findUnique({ where: { id: financeClient.clientId } });
    await prisma.domainChangeFeed.createMany({ data: [
      { tenantId, entityType: "PurchaseOrder", entityId: "hidden-price-event", operation: "upsert", entityVersion: 1, source: "test", payloadHash: "1".repeat(64), sensitivityGroups: ["procurement_prices"] },
      { tenantId, entityType: "ReceivingDocument", entityId: "visible-receiving-event", operation: "upsert", entityVersion: 1, source: "test", payloadHash: "2".repeat(64), sensitivityGroups: [] },
    ] });
    const startCursor = sync.issueCursor({ v: 1, tenantId, userId: finance.identity.userId, clientId: financeRow.id, deviceIdHash: financeRow.deviceIdHash, lastSequence: String(beforeSensitive._max.sequence || 0), authorizationFingerprint: financeFingerprint }, testEnv);
    const hiddenPage = await sync.changes({ clientId: financeClient.clientId, deviceId: "phase52b-finance-device", cursor: startCursor, limit: 1 }, finance);
    assert.equal(hiddenPage.changes.length, 0);
    const receivingFilteredPage = await sync.changes({ clientId: financeClient.clientId, deviceId: "phase52b-finance-device", cursor: hiddenPage.cursor, limit: 1 }, finance);
    assert.equal(receivingFilteredPage.changes.length, 0);
    const acknowledged = await sync.acknowledge({ clientId: financeClient.clientId, deviceId: "phase52b-finance-device", cursor: receivingFilteredPage.cursor }, finance);
    assert.ok(BigInt(acknowledged.acknowledgedSequence) > BigInt(beforeSensitive._max.sequence || 0));

    await prisma.tenant.update({ where: { id: tenantId }, data: { version: { increment: 1 } } });
    const reset = await sync.changes({ clientId: registered.clientId, deviceId: "phase52b-device-a", cursor: initial.cursor }, admin);
    assert.equal(reset.code, "SYNC_AUTHORIZATION_CHANGED");
    assert.equal(reset.resetRequired, true);
    const revoked = await sync.revoke(deviceB.clientId, { deviceId: "phase52b-device-b" }, admin);
    assert.equal(revoked.status, "revoked");
    await assert.rejects(() => sync.initial({ clientId: deviceB.clientId, deviceId: "phase52b-device-b" }, admin), (error) => error.code === "SYNC_CLIENT_REVOKED");
    assert.equal(client.deviceIdHash.length, 64);

    const proof = Buffer.from("phase-52b-posted-payment-proof");
    const staged = await attachments.stageUpload({ fileName: "proof.txt", mimeType: "text/plain", contentBase64: proof.toString("base64") }, finance);
    const stagedReplay = await attachments.stageUpload({ fileName: "proof-copy.txt", mimeType: "text/plain", contentBase64: proof.toString("base64") }, finance);
    assert.equal(stagedReplay.uploadId, staged.uploadId);
    assert.equal(stagedReplay.idempotentReplay, true);
    const boundPosted = await attachments.bindSettlement(draft.entityId, { uploadId: staged.uploadId, attachmentType: "payment_proof" }, finance);
    const downloaded = await attachments.download(boundPosted.attachmentId, finance);
    assert.deepEqual(downloaded.bytes, proof);
    await assert.rejects(() => attachments.deleteAttachment(boundPosted.attachmentId, finance), (error) => error.code === "POSTED_ATTACHMENT_IMMUTABLE");

    const draftForDeletion = await settlement.createSettlement({ settlementNumber: "SET-52B-ATTACHMENT-DRAFT", direction: "disbursement", counterpartyType: "supplier", counterpartyId: "supplier-52b", cashbookAccountId: from.entityId, currency: "CNY", amount: "5", settlementDate: "2026-07-20", allocations: [{ obligationType: "payable", obligationId: "phase52b-payable", cashAppliedAmount: "5", discountAmount: "0", totalSettlementAmount: "5" }], idempotencyKey: "settlement-attachment-draft" }, finance);
    const draftProof = Buffer.from("phase-52b-draft-proof");
    const stagedDraft = await attachments.stageUpload({ fileName: "draft.txt", mimeType: "text/plain", contentBase64: draftProof.toString("base64") }, finance);
    const boundDraft = await attachments.bindSettlement(draftForDeletion.entityId, { uploadId: stagedDraft.uploadId, attachmentType: "other" }, finance);
    const deleted = await attachments.deleteAttachment(boundDraft.attachmentId, finance);
    assert.equal(deleted.status, "deleted");
    assert.equal(await prisma.domainChangeFeed.count({ where: { tenantId, entityType: "SettlementAttachment", entityId: boundDraft.attachmentId, operation: "tombstone" } }), 1);

    const otherTenantId = "tenant-phase-52b-other";
    await prisma.tenant.create({ data: { id: otherTenantId, name: "Phase 5.2B Other" } });
    await prisma.user.create({ data: { id: "phase52b-other-admin", tenantId: otherTenantId, email: "phase52b-other@example.invalid", name: "Other Admin", role: "admin" } });
    await backfillTenantAuthorization(prisma, otherTenantId, { actorId: "phase52b-other-admin" });
    const otherAdmin = context("phase52b-other-admin", "admin"); otherAdmin.identity.tenantId = otherTenantId;
    await assert.rejects(() => attachments.status(stagedDraft.uploadId, otherAdmin), (error) => error.code === "UPLOAD_NOT_FOUND");

    const orphan = await attachments.stageUpload({ fileName: "orphan.txt", mimeType: "text/plain", contentBase64: Buffer.from("orphan").toString("base64") }, finance);
    await prisma.stagedUpload.update({ where: { id: orphan.uploadId }, data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") } });
    assert.equal((await attachments.cleanupExpiredUploads()).expired, 1);
    assert.equal((await prisma.stagedUpload.findUnique({ where: { id: orphan.uploadId } })).status, "expired");
    await assert.rejects(() => attachments.stageUpload({ fileName: "bad.txt", mimeType: "text/plain", contentBase64: Buffer.from("bad").toString("base64"), sha256: "0".repeat(64) }, finance), (error) => error.code === "UPLOAD_HASH_MISMATCH");
  } finally {
    await prisma.$disconnect();
    await rm(uploadDirectory, { recursive: true, force: true });
  }
});

// Design audit L10-02, L10-03 and V-C-02: receiving evidence belongs to every
// warehouse its receipt touches, the header's and each line's. A clerk who
// operates only warehouse A cannot download, attach to or delete evidence of a
// receipt in warehouse B, or of a warehouse A receipt with a line received
// into B (403), and mobile sync hides those receipts, lines and files.
test("receiving evidence and receipt sync follow every warehouse of the receipt", { skip: !enabled }, async () => {
  const uploadDirectory = await mkdtemp(join(tmpdir(), "flowchain-phase52b-receiving-uploads-"));
  const testEnv = { ...env, FLOWCHAIN_UPLOAD_STORAGE_DIR: uploadDirectory, FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true" };
  const prisma = await createPrismaClient(testEnv);
  const scopedTenant = "tenant-phase-52b-warehouses";
  const as = (userId, role) => ({ identity: { authenticated: true, tenantId: scopedTenant, userId, role, source: "test" } });
  const admin = as("wh52b-admin", "admin"), clerk = as("wh52b-clerk", "manager");
  try {
    await prisma.tenant.create({ data: { id: scopedTenant, name: "Phase 5.2B Warehouses" } });
    await prisma.warehouse.createMany({ data: [{ id: "wh-52b-a", tenantId: scopedTenant, code: "WH-A", name: "Warehouse A" }, { id: "wh-52b-b", tenantId: scopedTenant, code: "WH-B", name: "Warehouse B" }] });
    await prisma.user.createMany({ data: [{ id: "wh52b-admin", tenantId: scopedTenant, email: "wh52b-admin@example.invalid", name: "Warehouse Admin", role: "admin" }, { id: "wh52b-clerk", tenantId: scopedTenant, email: "wh52b-clerk@example.invalid", name: "Warehouse A Clerk", role: "manager" }] });
    await backfillTenantAuthorization(prisma, scopedTenant, { actorId: "wh52b-admin" });
    await prisma.userWarehouseScope.create({ data: { id: "wh52b-clerk-a", tenantId: scopedTenant, userId: "wh52b-clerk", warehouseId: "wh-52b-a", accessLevel: "operate" } });
    await prisma.receivingDocument.createMany({ data: [
      { id: "rcv-52b-a", tenantId: scopedTenant, documentNumber: "RCV-52B-A", warehouseId: "wh-52b-a" },
      { id: "rcv-52b-b", tenantId: scopedTenant, documentNumber: "RCV-52B-B", warehouseId: "wh-52b-b" },
      { id: "rcv-52b-mixed", tenantId: scopedTenant, documentNumber: "RCV-52B-MIXED", warehouseId: "wh-52b-a" },
    ] });
    await prisma.receivingLine.createMany({ data: [
      { id: "rcv-52b-a-1", receivingDocumentId: "rcv-52b-a", sku: "SKU-A", acceptedQty: "2", warehouseId: "wh-52b-a" },
      { id: "rcv-52b-mixed-1", receivingDocumentId: "rcv-52b-mixed", sku: "SKU-A", acceptedQty: "1", warehouseId: "wh-52b-a" },
      { id: "rcv-52b-mixed-2", receivingDocumentId: "rcv-52b-mixed", sku: "SKU-B", acceptedQty: "7", warehouseId: "wh-52b-b" },
    ] });
    const attachments = createAttachmentService({ prisma, env: testEnv });
    const stage = (who, label) => attachments.stageUpload({ fileName: `${label}.txt`, mimeType: "text/plain", contentBase64: Buffer.from(label).toString("base64") }, who);
    const evidence = async (who, receiptId, label) => attachments.bindReceiving(receiptId, { uploadId: (await stage(who, label)).uploadId }, who);
    const own = await evidence(clerk, "rcv-52b-a", "own evidence");
    const other = await evidence(admin, "rcv-52b-b", "other warehouse evidence");
    const mixed = await evidence(admin, "rcv-52b-mixed", "mixed receipt evidence");
    const denied = (error) => error.code === "WAREHOUSE_SCOPE_DENIED" && error.status === 403;

    assert.deepEqual((await attachments.download(own.attachmentId, clerk)).bytes, Buffer.from("own evidence"));
    await assert.rejects(() => attachments.download(other.attachmentId, clerk), denied);
    await assert.rejects(() => attachments.download(mixed.attachmentId, clerk), denied);
    assert.deepEqual((await attachments.download(mixed.attachmentId, admin)).bytes, Buffer.from("mixed receipt evidence"));
    assert.equal(await prisma.auditLog.count({ where: { tenantId: scopedTenant, action: "attachment_downloaded", actorId: "wh52b-clerk" } }), 1);

    const late = await stage(clerk, "late evidence");
    await assert.rejects(() => attachments.bindReceiving("rcv-52b-b", { uploadId: late.uploadId }, clerk), denied);
    await assert.rejects(() => attachments.bindReceiving("rcv-52b-mixed", { uploadId: late.uploadId }, clerk), denied);
    assert.equal((await prisma.stagedUpload.findUnique({ where: { id: late.uploadId } })).status, "staged");
    await assert.rejects(() => attachments.deleteAttachment(other.attachmentId, clerk), denied);
    await assert.rejects(() => attachments.deleteAttachment(mixed.attachmentId, clerk), denied);
    assert.equal(await prisma.receivingAttachment.count({ where: { tenantId: scopedTenant, status: "active" } }), 3);
    const mixedFeed = await prisma.domainChangeFeed.findFirst({ where: { tenantId: scopedTenant, entityType: "ReceivingDocument", entityId: "rcv-52b-mixed" } });
    assert.deepEqual([...mixedFeed.scopeWarehouseIds].sort(), ["wh-52b-a", "wh-52b-b"]);

    // The same rule on a device, read through the real Prisma client.
    const clerkActor = await resolveProvisionedActor(prisma, clerk.identity);
    const sync = (entityType, entityId) => loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: clerkActor, entityType, entityId, env: testEnv });
    assert.equal((await sync("ReceivingDocument", "rcv-52b-a")).documentNumber, "RCV-52B-A");
    assert.equal(await sync("ReceivingDocument", "rcv-52b-mixed"), null);
    assert.equal(await sync("ReceivingDocument", "rcv-52b-b"), null);
    assert.equal((await sync("ReceivingLine", "rcv-52b-a-1")).sku, "SKU-A");
    assert.equal(await sync("ReceivingLine", "rcv-52b-mixed-1"), null);
    assert.equal((await sync("ReceivingAttachment", own.attachmentId)).fileName, "own evidence.txt");
    assert.equal(await sync("ReceivingAttachment", other.attachmentId), null);
    assert.equal(await sync("ReceivingAttachment", mixed.attachmentId), null);

    assert.equal((await attachments.deleteAttachment(own.attachmentId, clerk)).status, "deleted");
  } finally {
    await prisma.$disconnect();
    await rm(uploadDirectory, { recursive: true, force: true });
  }
});
