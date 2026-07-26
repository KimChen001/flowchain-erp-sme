import { createHash, randomUUID } from "node:crypto";
import {
  ALLOWED_MIME_TYPES,
  ALLOWED_SOURCE_TYPES,
  INTAKE_COMMIT_MESSAGE,
  INTAKE_COMMIT_NOT_IMPLEMENTED,
  INTAKE_LIMITS,
  IntakeError,
  assertBatchTransition,
  assertSafePayload,
  assertTransformType,
  failIntake,
  sanitizeAuditValue,
  sanitizeSourceUrl,
  validateGenericRecord,
} from "./intake-contracts.mjs";

const text = (value, maximum = 255) => String(value ?? "").trim().slice(0, maximum);
const nowIso = clock => clock().toISOString();

function requireText(value, field, maximum = 255) {
  const result = text(value, maximum);
  if (!result) failIntake("INTAKE_FIELD_REQUIRED", `${field} is required.`, 422, { field });
  return result;
}

function publicArtifact(row) {
  return {
    id: row.id,
    sourceType: row.sourceType,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    checksumSha256: row.checksumSha256,
    sourceExternalId: row.sourceExternalId,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function publicBatch(row) {
  return {
    id: row.id,
    artifactId: row.artifactId,
    batchType: row.batchType,
    status: row.status,
    recordCount: row.recordCount,
    validRecordCount: row.validRecordCount,
    warningCount: row.warningCount,
    errorCount: row.errorCount,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    version: row.version,
  };
}

function publicRecord(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    rowNumber: row.rowNumber,
    sourcePayload: row.sourcePayload,
    normalizedPayload: row.normalizedPayload,
    recordType: row.recordType,
    status: row.status,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicMapping(row) {
  return {
    id: row.id,
    name: row.name,
    recordType: row.recordType,
    sourceSignature: row.sourceSignature,
    version: row.version,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    fieldMappings: (row.fieldMappings || []).map(field => ({
      id: field.id,
      sourceField: field.sourceField,
      targetField: field.targetField,
      transformType: field.transformType,
      required: field.required,
      defaultValue: field.defaultValue,
      position: field.position,
    })),
  };
}

function publicIssue(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    recordId: row.recordId,
    severity: row.severity,
    code: row.code,
    field: row.field,
    message: row.message,
    details: row.details,
    resolved: row.resolved,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

function publicReview(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    status: row.status,
    reviewedByUserId: row.reviewedByUserId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    decision: row.decision,
    comment: row.comment,
  };
}

function auditData({ idFactory, clock, actor, action, resourceType, resourceId, requestId, before = {}, after = {} }) {
  return {
    id: idFactory(),
    tenantId: actor.tenantId,
    source: "universal_intake",
    module: "universal-intake",
    action,
    entityType: resourceType,
    entityId: resourceId,
    actorId: actor.user.id,
    summary: `${action} ${resourceType} ${resourceId}.`,
    metadata: {
      requestId: text(requestId, 128) || null,
      before: sanitizeAuditValue(before),
      after: sanitizeAuditValue(after),
      timestamp: nowIso(clock),
    },
  };
}

function actorContext(context) {
  const actor = context?.actor;
  if (!actor?.tenantId || !actor?.user?.id) failIntake("TENANT_CONTEXT_REQUIRED", "A tenant-scoped actor is required.", 403);
  return actor;
}

function decodeArtifact(input) {
  const encoded = requireText(input?.contentBase64, "contentBase64", Math.ceil(INTAKE_LIMITS.maximumArtifactSizeBytes * 1.4) + 16);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    failIntake("INTAKE_ARTIFACT_BASE64_INVALID", "Artifact content must be valid base64.", 422);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > INTAKE_LIMITS.maximumArtifactSizeBytes) {
    failIntake("INTAKE_ARTIFACT_SIZE_LIMIT", "Artifact exceeds the supported size limit.", 413);
  }
  return bytes;
}

function safeFilename(value) {
  const filename = requireText(value, "originalFilename", 255).replaceAll("\\", "/").split("/").pop();
  if (!filename || filename === "." || filename === "..") failIntake("INTAKE_FILENAME_INVALID", "Artifact filename is invalid.", 422);
  return filename;
}

export function createIntakeServices({ repository, storage, idFactory = randomUUID, clock = () => new Date() } = {}) {
  if (!repository) throw new IntakeError("INTAKE_REPOSITORY_REQUIRED", "Intake repository is required.", 500);

  const artifacts = {
    register: async (input, context) => {
      const actor = actorContext(context);
      const sourceType = text(input?.sourceType || "manual_upload", 40);
      if (!ALLOWED_SOURCE_TYPES.includes(sourceType)) {
        failIntake("INTAKE_SOURCE_NOT_ENABLED", `${sourceType || "source"} is not enabled in Phase 5.4A.`, 501);
      }
      if (!storage) failIntake("ARTIFACT_STORAGE_NOT_CONFIGURED", "Artifact storage is not configured.", 503);
      const mimeType = requireText(input?.mimeType, "mimeType", 160).toLowerCase();
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) failIntake("INTAKE_MIME_UNSUPPORTED", "Artifact MIME type is not supported.", 415);
      const bytes = decodeArtifact(input);
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      if (input?.checksumSha256 && text(input.checksumSha256, 64).toLowerCase() !== checksumSha256) {
        failIntake("INTAKE_CHECKSUM_MISMATCH", "Artifact checksum does not match its content.", 422);
      }
      const duplicate = await repository.findArtifactByChecksum(actor.tenantId, checksumSha256);
      if (duplicate) failIntake("INTAKE_ARTIFACT_DUPLICATE", "An artifact with this checksum already exists.", 409, { artifactId: duplicate.id });
      const artifactId = idFactory();
      const sourceUrl = sanitizeSourceUrl(input?.sourceUrl);
      const stored = await storage.put({ bytes });
      try {
        return await repository.transaction(async tx => {
          const row = await tx.createArtifact({
            id: artifactId,
            tenantId: actor.tenantId,
            sourceType,
            originalFilename: safeFilename(input?.originalFilename),
            mimeType,
            sizeBytes: bytes.byteLength,
            checksumSha256,
            storageProvider: stored.provider,
            storageKey: stored.key,
            sourceExternalId: text(input?.sourceExternalId, 255) || null,
            uploadedByUserId: actor.user.id,
          });
          await tx.createSourceReference({
            id: idFactory(),
            tenantId: actor.tenantId,
            artifactId,
            externalSystem: "manual_upload",
            externalReference: text(input?.sourceExternalId, 255) || null,
            externalMessageId: null,
            externalThreadId: null,
            sourceUrl,
          });
          await tx.createAudit(auditData({
            idFactory, clock, actor, action: "artifact_registered", resourceType: "InboundArtifact", resourceId: artifactId,
            requestId: context.requestId, after: { sourceType, mimeType, sizeBytes: bytes.byteLength, checksumSha256 },
          }));
          return publicArtifact(row);
        });
      } catch (error) {
        await storage.delete(stored.key).catch(() => {});
        throw error;
      }
    },
    get: async (id, context) => {
      const actor = actorContext(context);
      const row = await repository.getArtifact(actor.tenantId, id);
      if (!row) failIntake("INTAKE_ARTIFACT_NOT_FOUND", "Artifact was not found.", 404);
      return publicArtifact(row);
    },
    list: async (query, context) => {
      const actor = actorContext(context);
      const result = await repository.listArtifacts(actor.tenantId, query);
      return { artifacts: result.rows.map(publicArtifact), nextCursor: result.nextCursor };
    },
  };

  const batches = {
    create: async (input, context) => {
      const actor = actorContext(context);
      const artifact = await repository.getArtifact(actor.tenantId, requireText(input?.artifactId, "artifactId"));
      if (!artifact) failIntake("INTAKE_ARTIFACT_NOT_FOUND", "Artifact was not found.", 404);
      const id = idFactory();
      const batchType = requireText(input?.batchType, "batchType", 80);
      return repository.transaction(async tx => {
        const row = await tx.createBatch({ id, tenantId: actor.tenantId, artifactId: artifact.id, batchType, createdByUserId: actor.user.id });
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "intake_batch_created", resourceType: "IntakeBatch", resourceId: id,
          requestId: context.requestId, after: { artifactId: artifact.id, batchType, status: "uploaded" },
        }));
        return publicBatch(row);
      });
    },
    get: async (id, context) => {
      const actor = actorContext(context);
      const row = await repository.getBatch(actor.tenantId, id);
      if (!row) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      return publicBatch(row);
    },
    list: async (query, context) => {
      const actor = actorContext(context);
      const result = await repository.listBatches(actor.tenantId, query);
      return { batches: result.rows.map(publicBatch), nextCursor: result.nextCursor };
    },
    transition: async (id, to, input, context) => {
      const actor = actorContext(context);
      const current = await repository.getBatch(actor.tenantId, id);
      if (!current) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      assertBatchTransition(current.status, to);
      if (to === "ready_for_review" && await repository.unresolvedErrorCount(actor.tenantId, id) > 0) {
        failIntake("INTAKE_UNRESOLVED_ERRORS", "Unresolved validation errors block review readiness.", 409);
      }
      const expectedVersion = Number(input?.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version) {
        failIntake("INTAKE_VERSION_CONFLICT", "Intake batch version is stale.", 409, { expectedVersion: current.version });
      }
      const data = to === "failed"
        ? { failureCode: requireText(input?.failureCode, "failureCode", 100), failureMessage: text(input?.failureMessage, 500) || null }
        : {};
      await repository.transaction(async tx => {
        const count = await tx.transitionBatch({ tenantId: actor.tenantId, id, from: current.status, to, expectedVersion, data });
        if (count !== 1) failIntake("INTAKE_VERSION_CONFLICT", "Intake batch changed before the transition completed.", 409);
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "intake_batch_status_changed", resourceType: "IntakeBatch", resourceId: id,
          requestId: context.requestId, before: { status: current.status, version: current.version }, after: { status: to, version: current.version + 1 },
        }));
      });
      return batches.get(id, context);
    },
    cancel: async (id, input, context) => batches.transition(id, "cancelled", input, context),
    addRecords: async (id, input, context) => {
      const actor = actorContext(context);
      const batch = await repository.getBatch(actor.tenantId, id);
      if (!batch) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      if (!["profiling", "mapping_required", "validation_required"].includes(batch.status)) {
        failIntake("INTAKE_RECORDS_NOT_ACCEPTED", "The batch is not accepting record previews.", 409);
      }
      const rows = Array.isArray(input?.records) ? input.records : [];
      if (!rows.length) failIntake("INTAKE_RECORDS_REQUIRED", "At least one record is required.", 422);
      if (rows.length + batch.recordCount > INTAKE_LIMITS.maximumRecordCount) failIntake("INTAKE_RECORD_COUNT_LIMIT", "Batch record count exceeds the supported limit.", 413);
      const rules = Array.isArray(input?.rules) ? input.rules : [];
      const seen = new Set((await repository.listRecordFingerprints(actor.tenantId, id)).map(row => row.fingerprint));
      let valid = 0;
      let warnings = 0;
      let errors = 0;
      const records = [];
      await repository.transaction(async tx => {
        for (let index = 0; index < rows.length; index += 1) {
          const result = validateGenericRecord(rows[index], rules, seen);
          const rowNumber = batch.recordCount + index + 1;
          const hasError = result.issues.some(issue => issue.severity === "error");
          const hasWarning = result.issues.some(issue => issue.severity === "warning");
          const status = hasError ? "invalid" : hasWarning ? "warning" : "valid";
          const record = await tx.createRecord({
            id: idFactory(), tenantId: actor.tenantId, batchId: id, rowNumber,
            sourcePayload: result.payload, normalizedPayload: null, recordType: batch.batchType,
            status, fingerprint: result.fingerprint,
          });
          records.push(publicRecord(record));
          if (hasError) errors += 1;
          else if (hasWarning) warnings += 1;
          else valid += 1;
          for (const issue of result.issues) {
            await tx.createIssue({
              id: idFactory(), tenantId: actor.tenantId, batchId: id, recordId: record.id,
              severity: issue.severity, code: issue.code, field: issue.field, message: issue.message, details: issue.details,
            });
          }
        }
        await tx.updateBatchCounts(actor.tenantId, id, {
          recordCount: { increment: rows.length },
          validRecordCount: { increment: valid },
          warningCount: { increment: warnings },
          errorCount: { increment: errors },
        });
      });
      return { records, counts: { added: rows.length, valid, warnings, errors } };
    },
    listRecords: async (id, query, context) => {
      const actor = actorContext(context);
      if (!await repository.getBatch(actor.tenantId, id)) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      const result = await repository.listRecords(actor.tenantId, id, query);
      return { records: result.rows.map(publicRecord), nextCursor: result.nextCursor };
    },
  };

  const mappings = {
    create: async (input, context) => {
      const actor = actorContext(context);
      const name = requireText(input?.name, "name", 120);
      const recordType = requireText(input?.recordType, "recordType", 80);
      const sourceSignature = requireText(input?.sourceSignature, "sourceSignature", 128);
      const fields = Array.isArray(input?.fieldMappings) ? input.fieldMappings : [];
      const normalizedFields = fields.map((field, index) => ({
        id: idFactory(),
        tenantId: actor.tenantId,
        sourceField: requireText(field?.sourceField, "sourceField", 120),
        targetField: requireText(field?.targetField, "targetField", 120),
        transformType: assertTransformType(field?.transformType),
        required: Boolean(field?.required),
        defaultValue: field?.defaultValue === undefined ? null : assertSafePayload({ value: field.defaultValue }).value,
        position: Number.isInteger(field?.position) && field.position >= 0 ? field.position : index,
      }));
      const version = await repository.nextMappingVersion(actor.tenantId, recordType, sourceSignature);
      const id = idFactory();
      await repository.transaction(async tx => {
        await tx.createMappingProfile({ id, tenantId: actor.tenantId, name, recordType, sourceSignature, version, status: "draft", createdByUserId: actor.user.id });
        if (normalizedFields.length) await tx.createFieldMappings(normalizedFields.map(field => ({ ...field, mappingProfileId: id })));
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "mapping_profile_created", resourceType: "MappingProfile", resourceId: id,
          requestId: context.requestId, after: { name, recordType, sourceSignature, version, fieldCount: normalizedFields.length },
        }));
      });
      return mappings.get(id, context);
    },
    get: async (id, context) => {
      const actor = actorContext(context);
      const row = await repository.getMappingProfile(actor.tenantId, id);
      if (!row) failIntake("INTAKE_MAPPING_NOT_FOUND", "Mapping profile was not found.", 404);
      return publicMapping(row);
    },
    list: async (query, context) => {
      const actor = actorContext(context);
      const result = await repository.listMappingProfiles(actor.tenantId, query);
      return { mappingProfiles: result.rows.map(publicMapping), nextCursor: result.nextCursor };
    },
    activate: async (id, context) => {
      const actor = actorContext(context);
      const current = await repository.getMappingProfile(actor.tenantId, id);
      if (!current) failIntake("INTAKE_MAPPING_NOT_FOUND", "Mapping profile was not found.", 404);
      if (current.status !== "draft") failIntake("INTAKE_MAPPING_ACTIVATION_INVALID", "Only a draft mapping can be activated.", 409);
      await repository.transaction(async tx => {
        await tx.retireActiveMappings(actor.tenantId, current.recordType, current.sourceSignature, id);
        await tx.updateMappingStatus(actor.tenantId, id, "active");
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "mapping_profile_activated", resourceType: "MappingProfile", resourceId: id,
          requestId: context.requestId, before: { status: current.status }, after: { status: "active", version: current.version },
        }));
      });
      return mappings.get(id, context);
    },
    retire: async (id, context) => {
      const actor = actorContext(context);
      const current = await repository.getMappingProfile(actor.tenantId, id);
      if (!current) failIntake("INTAKE_MAPPING_NOT_FOUND", "Mapping profile was not found.", 404);
      if (current.status === "retired") return publicMapping(current);
      await repository.transaction(async tx => {
        await tx.updateMappingStatus(actor.tenantId, id, "retired");
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "mapping_profile_retired", resourceType: "MappingProfile", resourceId: id,
          requestId: context.requestId, before: { status: current.status }, after: { status: "retired" },
        }));
      });
      return mappings.get(id, context);
    },
  };

  const issues = {
    list: async (batchId, query, context) => {
      const actor = actorContext(context);
      if (!await repository.getBatch(actor.tenantId, batchId)) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      const result = await repository.listIssues(actor.tenantId, batchId, query);
      return { issues: result.rows.map(publicIssue), nextCursor: result.nextCursor };
    },
    resolve: async (issueId, context) => {
      const actor = actorContext(context);
      const completedAt = clock();
      const count = await repository.transaction(async tx => {
        const changed = await tx.resolveIssue(actor.tenantId, issueId, actor.user.id, completedAt);
        if (changed.count !== 1) failIntake("INTAKE_ISSUE_NOT_FOUND", "Open validation issue was not found.", 404);
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "validation_issue_resolved", resourceType: "ValidationIssue", resourceId: issueId,
          requestId: context.requestId, before: { resolved: false }, after: { resolved: true, resolvedByUserId: actor.user.id },
        }));
        return changed.count;
      });
      return { id: issueId, resolved: count === 1, resolvedByUserId: actor.user.id, resolvedAt: completedAt };
    },
  };

  const reviews = {
    open: async (batchId, input, context) => {
      const actor = actorContext(context);
      const batch = await repository.getBatch(actor.tenantId, batchId);
      if (!batch) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      if (batch.status !== "ready_for_review") failIntake("INTAKE_REVIEW_NOT_READY", "Batch is not ready for review.", 409);
      if (await repository.unresolvedErrorCount(actor.tenantId, batchId) > 0) failIntake("INTAKE_UNRESOLVED_ERRORS", "Unresolved validation errors block review.", 409);
      const id = idFactory();
      return repository.transaction(async tx => {
        const row = await tx.createReview({ id, tenantId: actor.tenantId, batchId, status: "open", reviewedByUserId: actor.user.id, comment: text(input?.comment, 1000) || null });
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "review_opened", resourceType: "ReviewSession", resourceId: id,
          requestId: context.requestId, after: { batchId, status: "open" },
        }));
        return publicReview(row);
      });
    },
    decide: async (id, decision, input, context) => {
      const actor = actorContext(context);
      const current = await repository.getReview(actor.tenantId, id);
      if (!current) failIntake("INTAKE_REVIEW_NOT_FOUND", "Review session was not found.", 404);
      if (current.status !== "open") failIntake("INTAKE_REVIEW_ALREADY_COMPLETED", "Review session is already completed.", 409);
      if (decision === "approved" && await repository.unresolvedErrorCount(actor.tenantId, current.batchId) > 0) {
        failIntake("INTAKE_UNRESOLVED_ERRORS", "Unresolved validation errors block approval.", 409);
      }
      const comment = text(input?.comment, 1000) || null;
      const completedAt = clock();
      await repository.transaction(async tx => {
        const changed = await tx.completeReview(actor.tenantId, id, decision, decision, comment, completedAt);
        if (changed.count !== 1) failIntake("INTAKE_REVIEW_ALREADY_COMPLETED", "Review session changed before the decision completed.", 409);
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: decision === "approved" ? "review_approved" : "review_rejected",
          resourceType: "ReviewSession", resourceId: id, requestId: context.requestId,
          before: { status: "open" }, after: { status: decision, decision, comment },
        }));
      });
      return publicReview({ ...current, status: decision, decision, comment, completedAt });
    },
  };

  const commits = {
    attempt: async (batchId, input, context) => {
      const actor = actorContext(context);
      if (!await repository.getBatch(actor.tenantId, batchId)) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
      const idempotencyKey = requireText(input?.idempotencyKey, "idempotencyKey", 128);
      const existing = await repository.findCommitAttempt(actor.tenantId, idempotencyKey);
      if (existing) return { code: INTAKE_COMMIT_NOT_IMPLEMENTED, message: INTAKE_COMMIT_MESSAGE, attemptId: existing.id, status: "blocked", idempotentReplay: true };
      const id = idFactory();
      await repository.transaction(async tx => {
        await tx.createCommitAttempt({
          id, tenantId: actor.tenantId, batchId, status: "blocked", idempotencyKey,
          requestedByUserId: actor.user.id, completedAt: clock(),
          failureCode: INTAKE_COMMIT_NOT_IMPLEMENTED, failureMessage: INTAKE_COMMIT_MESSAGE,
        });
        await tx.createAudit(auditData({
          idFactory, clock, actor, action: "commit_attempt_blocked", resourceType: "CommitAttempt", resourceId: id,
          requestId: context.requestId, after: { batchId, status: "blocked", failureCode: INTAKE_COMMIT_NOT_IMPLEMENTED },
        }));
      });
      return { code: INTAKE_COMMIT_NOT_IMPLEMENTED, message: INTAKE_COMMIT_MESSAGE, attemptId: id, status: "blocked", idempotentReplay: false };
    },
  };

  return { artifacts, batches, mappings, issues, reviews, commits };
}

export const intakeDto = Object.freeze({ publicArtifact, publicBatch, publicRecord, publicMapping, publicIssue, publicReview });
