import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { InternalSettlementError } from "./internal-settlement-command-service.mjs";
import { createLocalDurableAttachmentStorage } from "./attachment-storage-provider.mjs";
import { CONTRACT_FILE_MIME_TYPES, CONTRACT_PERMISSIONS } from "./contract-policy.mjs";

const text = (value) => String(value ?? "").trim();
const fail = (code, message, status = 400, details) => { throw new InternalSettlementError(code, message, status, details); };
const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"]);
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
// What a staged upload is for. Mobile and settlement evidence (no purpose)
// needs mobile.sync.use; a contract's signed file needs
// contracts.contract.manage and is a PDF or an image
// (docs/contracts-module-design.md §6). The purpose is kept on the upload.
const CONTRACT_PURPOSE = "contract";
const stagePolicy = (purpose) => purpose === CONTRACT_PURPOSE
  ? { permission: CONTRACT_PERMISSIONS.manage, mimeTypes: new Set(CONTRACT_FILE_MIME_TYPES) }
  : { permission: "mobile.sync.use", mimeTypes: allowedMime };

export function createAttachmentService({ prisma, env = process.env, idFactory = randomUUID, now = () => new Date(), storageProvider } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const storage = storageProvider || createLocalDurableAttachmentStorage({ env, digest });
  const actorFor = (context) => resolveProvisionedActor(prisma, context?.identity || context);
  async function cleanupExpiredUploads() {
    const expired = await prisma.stagedUpload.findMany({ where: { status: "staged", expiresAt: { lte: now() } }, take: 100 });
    for (const upload of expired) {
      // Keep the bytes for forensic recovery; expiry only removes the upload's bindability.
      await prisma.stagedUpload.updateMany({ where: { id: upload.id, tenantId: upload.tenantId, status: "staged" }, data: { status: "expired", deletedAt: now() } });
    }
    return { expired: expired.length };
  }
  async function stageUpload(input, context) {
    const actor = await actorFor(context);
    const purpose = text(input.purpose) === CONTRACT_PURPOSE ? CONTRACT_PURPOSE : null;
    const policy = stagePolicy(purpose);
    assertAuthorized({ actor, permission: policy.permission, tenantId: actor.tenantId });
    const fileName = text(input.fileName), mimeType = text(input.mimeType).toLowerCase();
    if (!fileName || !policy.mimeTypes.has(mimeType)) fail("UPLOAD_TYPE_NOT_ALLOWED", "The file type is not allowed.", 422);
    let bytes; try { bytes = Buffer.from(text(input.contentBase64), "base64"); } catch { fail("UPLOAD_CONTENT_INVALID", "Upload content is invalid.", 422); }
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail("UPLOAD_SIZE_INVALID", "Upload size must be between 1 byte and 20 MB.", 422);
    const sha256 = digest(bytes), suppliedHash = text(input.sha256).toLowerCase();
    if (suppliedHash && suppliedHash !== sha256) fail("UPLOAD_HASH_MISMATCH", "The supplied SHA-256 does not match the file.", 422);
    await cleanupExpiredUploads();
    const replay = await prisma.stagedUpload.findFirst({ where: { tenantId: actor.tenantId, createdById: actor.user.id, sha256, status: "staged", expiresAt: { gt: now() } }, orderBy: { createdAt: "desc" } });
    // A contract file replays only an upload of a type a contract takes.
    if (replay && (!purpose || policy.mimeTypes.has(replay.mimeType))) return { uploadId: replay.id, fileName: replay.fileName, mimeType: replay.mimeType, sizeBytes: replay.sizeBytes, sha256: replay.sha256, status: replay.status, expiresAt: replay.expiresAt.toISOString(), idempotentReplay: true };
    const id = idFactory(), storageKey = `${actor.tenantId}/${id}`;
    await storage.put(storageKey, bytes, sha256);
    const upload = await prisma.stagedUpload.create({ data: { id, tenantId: actor.tenantId, fileName, mimeType, sizeBytes: bytes.length, sha256, storageKey, storageProvider: storage.provider, storageVersion: "v1", persistedAt: now(), storageHealthStatus: "healthy", createdById: actor.user.id, expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000), metadata: { binaryInBusinessJson: false, ...(purpose ? { purpose } : {}) } } });
    return { uploadId: upload.id, fileName, mimeType, sizeBytes: bytes.length, sha256, status: upload.status, expiresAt: upload.expiresAt.toISOString() };
  }
  async function status(uploadId, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.sync.use", tenantId: actor.tenantId });
    const upload = await prisma.stagedUpload.findFirst({ where: { id: text(uploadId), tenantId: actor.tenantId } });
    if (!upload || upload.createdById !== actor.user.id) fail("UPLOAD_NOT_FOUND", "Upload was not found.", 404);
    return { uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256, status: upload.status, expiresAt: upload.expiresAt.toISOString() };
  }
  async function ownedUpload(tx, actor, uploadId) {
    const upload = await tx.stagedUpload.findFirst({ where: { id: text(uploadId), tenantId: actor.tenantId } });
    if (!upload || upload.createdById !== actor.user.id) fail("UPLOAD_NOT_FOUND", "Upload was not found.", 404);
    if (upload.status !== "staged" || upload.expiresAt <= now()) fail("UPLOAD_NOT_BINDABLE", "Upload is expired or already bound.", 409);
    return upload;
  }
  async function bindSettlement(settlementId, input, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "finance.settlement_attachment.manage", tenantId: actor.tenantId });
    const attachmentType = text(input.attachmentType) || "other"; if (!new Set(["payment_proof", "receipt_proof", "approval_evidence", "other"]).has(attachmentType)) fail("SETTLEMENT_ATTACHMENT_TYPE_INVALID", "Attachment type is invalid.", 422);
    return prisma.$transaction(async (tx) => {
      const settlement = await tx.settlementDocument.findFirst({ where: { id: text(settlementId), tenantId: actor.tenantId } }); if (!settlement) fail("SETTLEMENT_NOT_FOUND", "Settlement was not found.", 404);
      const upload = await ownedUpload(tx, actor, input.uploadId), id = idFactory();
      const attachment = await tx.settlementAttachment.create({ data: { id, tenantId: actor.tenantId, settlementId: settlement.id, uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256, attachmentType, sourceDeviceId: text(input.sourceDeviceId) || null, createdById: actor.user.id, metadata: { supplementalEvidence: settlement.postingStatus === "posted" } } });
      await tx.stagedUpload.update({ where: { id: upload.id }, data: { status: "bound", boundAt: now() } });
      await tx.settlementDocument.update({ where: { id: settlement.id }, data: { attachmentCount: { increment: 1 } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "attachment_service", module: "finance", action: "settlement_attachment_added", entityType: "SettlementAttachment", entityId: attachment.id, summary: `Added evidence to settlement ${settlement.settlementNumber}.`, metadata: { settlementId: settlement.id, sha256: upload.sha256, attachmentType } } });
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "SettlementDocument", entityId: settlement.id, operation: "upsert", entityVersion: settlement.version, actorId: actor.user.id, source: "attachment_service", requestId: upload.id, payloadHash: digest(Buffer.from(`${attachment.id}:${upload.sha256}`)), sensitivityGroups: ["finance_partner_snapshot"], moduleKey: "finance", authorizationClass: "finance.settlement.read", resourceTenantId: actor.tenantId } });
      return { attachmentId: attachment.id, settlementId: settlement.id, uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256, attachmentType, status: attachment.status };
    }, { isolationLevel: "Serializable" });
  }
  async function bindReceiving(receivingId, input, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.prepare", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.prepare", tenantId: actor.tenantId });
    return prisma.$transaction(async (tx) => {
      const receiving = await tx.receivingDocument.findFirst({ where: { id: text(receivingId), tenantId: actor.tenantId } }); if (!receiving) fail("RECEIVING_NOT_FOUND", "Receiving draft was not found.", 404);
      if (receiving.postingStatus !== "unposted") fail("RECEIVING_IMMUTABLE", "Posted receiving evidence cannot be replaced.", 409);
      const upload = await ownedUpload(tx, actor, input.uploadId), id = idFactory();
      const attachment = await tx.receivingAttachment.create({ data: { id, tenantId: actor.tenantId, receivingDocumentId: receiving.id, uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256, sourceDeviceId: text(input.sourceDeviceId) || null, createdById: actor.user.id } });
      await tx.stagedUpload.update({ where: { id: upload.id }, data: { status: "bound", boundAt: now() } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "attachment_service", module: "procurement_receiving", action: "receiving_attachment_added", entityType: "ReceivingAttachment", entityId: attachment.id, summary: `Added evidence to receiving ${receiving.documentNumber || receiving.id}.`, metadata: { receivingDocumentId: receiving.id, sha256: upload.sha256 } } });
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "ReceivingDocument", entityId: receiving.id, operation: "upsert", entityVersion: receiving.version, actorId: actor.user.id, source: "attachment_service", requestId: upload.id, payloadHash: digest(Buffer.from(`${attachment.id}:${upload.sha256}`)), sensitivityGroups: [], moduleKey: "receiving", authorizationClass: "receiving.read", scopeWarehouseIds: [receiving.warehouseId].filter(Boolean), resourceTenantId: actor.tenantId } });
      return { attachmentId: attachment.id, receivingDocumentId: receiving.id, uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256, status: attachment.status };
    }, { isolationLevel: "Serializable" });
  }
  // A contract's signed file needs contracts.contract.read and the contracts
  // capability; settlement and receiving evidence need their own permission
  // and mobile operations or the settlement workflow, as before (with those
  // off they are not looked up). Every lookup is in the reader's workspace.
  async function download(attachmentId, context, { legacyEnabled = true, contractsEnabled = false } = {}) {
    const actor = await actorFor(context);
    let attachment = null, module = "finance", entityType = "SettlementAttachment";
    if (contractsEnabled) {
      attachment = await prisma.contractAttachment.findFirst({ where: { id: text(attachmentId), tenantId: actor.tenantId, status: "active" }, include: { upload: true } });
      if (attachment) { module = "contracts"; entityType = "ContractAttachment"; assertAuthorized({ actor, permission: CONTRACT_PERMISSIONS.read, tenantId: actor.tenantId }); }
    }
    if (!attachment && legacyEnabled) {
      attachment = await prisma.settlementAttachment.findFirst({ where: { id: text(attachmentId), tenantId: actor.tenantId, status: "active" }, include: { upload: true } });
      if (attachment) assertAuthorized({ actor, permission: "finance.settlement_attachment.read", tenantId: actor.tenantId });
      if (!attachment) { attachment = await prisma.receivingAttachment.findFirst({ where: { id: text(attachmentId), tenantId: actor.tenantId, status: "active" }, include: { upload: true } }); module = "procurement_receiving"; entityType = "ReceivingAttachment"; if (attachment) assertAuthorized({ actor, permission: "receiving.read", tenantId: actor.tenantId }); }
    }
    if (!attachment) fail("ATTACHMENT_NOT_FOUND", "Attachment was not found.", 404);
    const bytes = await storage.get(attachment.upload.storageKey);
    if (digest(bytes) !== attachment.sha256) fail("ATTACHMENT_HASH_MISMATCH", "Attachment evidence failed integrity verification.", 409);
    await prisma.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "attachment_service", module, action: "attachment_downloaded", entityType, entityId: attachment.id, summary: `Downloaded attachment ${attachment.fileName}.`, metadata: { sha256: attachment.sha256, ...(attachment.contractId ? { contractId: attachment.contractId } : {}) } } });
    return { bytes, fileName: attachment.fileName, mimeType: attachment.mimeType, sha256: attachment.sha256 };
  }
  async function deleteAttachment(attachmentId, context) {
    const actor = await actorFor(context);
    return prisma.$transaction(async (tx) => {
      const settlementAttachment = await tx.settlementAttachment.findFirst({ where: { id: text(attachmentId), tenantId: actor.tenantId, status: "active" }, include: { settlement: true } });
      if (settlementAttachment) {
        assertAuthorized({ actor, permission: "finance.settlement_attachment.manage", tenantId: actor.tenantId });
        if (settlementAttachment.settlement.postingStatus !== "unposted") fail("POSTED_ATTACHMENT_IMMUTABLE", "Posted settlement evidence cannot be deleted.", 409);
        await tx.settlementAttachment.update({ where: { id: settlementAttachment.id }, data: { status: "deleted", deletedAt: now() } });
        await tx.settlementDocument.update({ where: { id: settlementAttachment.settlementId }, data: { attachmentCount: { decrement: 1 } } });
        await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "attachment_service", module: "finance", action: "settlement_attachment_deleted", entityType: "SettlementAttachment", entityId: settlementAttachment.id, summary: `Deleted draft evidence ${settlementAttachment.fileName}.`, metadata: { settlementId: settlementAttachment.settlementId, sha256: settlementAttachment.sha256 } } });
        await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "SettlementAttachment", entityId: settlementAttachment.id, operation: "tombstone", actorId: actor.user.id, source: "attachment_service", requestId: settlementAttachment.uploadId, payloadHash: digest(Buffer.from(`${settlementAttachment.id}:deleted`)), sensitivityGroups: ["finance_partner_snapshot"], moduleKey: "finance", authorizationClass: "finance.settlement_attachment.read", resourceTenantId: actor.tenantId } });
        return { attachmentId: settlementAttachment.id, status: "deleted" };
      }
      const receivingAttachment = await tx.receivingAttachment.findFirst({ where: { id: text(attachmentId), tenantId: actor.tenantId, status: "active" }, include: { receivingDocument: true } });
      if (!receivingAttachment) fail("ATTACHMENT_NOT_FOUND", "Attachment was not found.", 404);
      assertAuthorized({ actor, permission: "mobile.receiving.prepare", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.prepare", tenantId: actor.tenantId });
      if (receivingAttachment.receivingDocument.postingStatus !== "unposted") fail("POSTED_ATTACHMENT_IMMUTABLE", "Posted receiving evidence cannot be deleted.", 409);
      await tx.receivingAttachment.update({ where: { id: receivingAttachment.id }, data: { status: "deleted", deletedAt: now() } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "attachment_service", module: "procurement_receiving", action: "receiving_attachment_deleted", entityType: "ReceivingAttachment", entityId: receivingAttachment.id, summary: `Deleted draft evidence ${receivingAttachment.fileName}.`, metadata: { receivingDocumentId: receivingAttachment.receivingDocumentId, sha256: receivingAttachment.sha256 } } });
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "ReceivingAttachment", entityId: receivingAttachment.id, operation: "tombstone", actorId: actor.user.id, source: "attachment_service", requestId: receivingAttachment.uploadId, payloadHash: digest(Buffer.from(`${receivingAttachment.id}:deleted`)), sensitivityGroups: [], moduleKey: "receiving", authorizationClass: "receiving.read", scopeWarehouseIds: [receivingAttachment.receivingDocument.warehouseId].filter(Boolean), resourceTenantId: actor.tenantId } });
      return { attachmentId: receivingAttachment.id, status: "deleted" };
    }, { isolationLevel: "Serializable" });
  }
  async function healthCheck() { return storage.healthCheck(); }
  async function orphanCheck() {
    const uploads = await prisma.stagedUpload.findMany({ select: { storageKey: true, sha256: true, status: true, expiresAt: true } });
    const byKey = new Map(uploads.map((upload) => [upload.storageKey, upload]));
    const missingFiles = [], hashMismatches = [], expiredStagedUploads = [];
    for (const upload of uploads) {
      if (upload.status === "staged" && upload.expiresAt <= now()) expiredStagedUploads.push(upload.storageKey);
      if (!await storage.exists(upload.storageKey)) { missingFiles.push(upload.storageKey); continue; }
      if (!await storage.verifyHash(upload.storageKey, upload.sha256)) hashMismatches.push(upload.storageKey);
    }
    const orphanFiles = (await storage.listFiles()).filter((file) => !byKey.has(file.storageKey)).map((file) => file.storageKey);
    return { provider: storage.provider, root: storage.root, missingFiles, orphanFiles, hashMismatches, expiredStagedUploads, ok: !missingFiles.length && !orphanFiles.length && !hashMismatches.length && !expiredStagedUploads.length };
  }
  return { stageUpload, status, bindSettlement, bindReceiving, download, deleteAttachment, cleanupExpiredUploads, healthCheck, orphanCheck };
}
