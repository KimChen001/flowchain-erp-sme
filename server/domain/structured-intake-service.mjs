import { randomUUID } from "node:crypto";
import { SUPPORTED_INTAKE_RECORD_TYPES } from "./canonical-master-data-schemas.mjs";
import { INTAKE_LIMITS, assertSafePayload, failIntake, fingerprintPayload } from "./intake-contracts.mjs";
import {
  normalizeStructuredRecord,
  sourceSignature,
  suggestFieldMappings,
  validateConfirmedMappings,
  validateNormalizedRecord,
} from "./structured-intake-mapping.mjs";
import {
  parseCsvArtifact,
  parsePasteJson,
  parsePasteTable,
  parseXlsxArtifact,
} from "./structured-intake-parser.mjs";
import { resolveTenantEntitySchema } from "./tenant-schema-resolver.mjs";

const text = (value, maximum = 255) => String(value ?? "").trim().slice(0, maximum);
const actorOf = context => {
  const actor = context?.actor;
  if (!actor?.tenantId || !actor?.user?.id) failIntake("TENANT_CONTEXT_REQUIRED", "A tenant-scoped actor is required.", 403);
  return actor;
};
const batchDto = batch => ({
  id: batch.id,
  artifactId: batch.artifactId,
  batchType: batch.batchType,
  status: batch.status,
  recordCount: batch.recordCount,
  validRecordCount: batch.validRecordCount,
  warningCount: batch.warningCount,
  errorCount: batch.errorCount,
  parserVersion: batch.parserVersion,
  selectedSheet: batch.selectedSheet,
  headerRowNumber: batch.headerRowNumber,
  mappingProfileId: batch.mappingProfileId,
  version: batch.version,
});
const profileDto = profile => ({
  sourceFormat: profile.sourceFormat,
  encoding: profile.encoding,
  delimiter: profile.delimiter,
  sheetList: profile.sheetList || [],
  selectedSheet: profile.selectedSheet || null,
  headerCandidates: profile.headerCandidates || [],
  selectedHeaderRow: profile.selectedHeaderRow,
  rowCount: profile.rowCount,
  columnCount: profile.columnCount,
  sourceFieldNames: profile.sourceFieldNames,
  duplicateHeaders: profile.duplicateHeaders || [],
  emptyColumns: profile.emptyColumns || [],
  sampleRows: profile.sampleRows || [],
  warnings: profile.warnings || [],
  parserVersion: profile.parserVersion,
  checksumSha256: profile.checksumSha256,
});
const audit = ({ idFactory, actor, action, entityType, entityId, requestId, after = {} }) => ({
  id: idFactory(),
  tenantId: actor.tenantId,
  source: "structured_intake",
  module: "universal-intake",
  action,
  entityType,
  entityId,
  actorId: actor.user.id,
  summary: `${action} ${entityType} ${entityId}.`,
  metadata: { requestId: text(requestId, 128) || null, after },
});

function assertRecordType(value) {
  const recordType = text(value, 40);
  if (!SUPPORTED_INTAKE_RECORD_TYPES.includes(recordType)) {
    failIntake("INTAKE_RECORD_TYPE_UNSUPPORTED", "Phase 5.4B supports only supplier, item, and customer.", 422);
  }
  return recordType;
}

function formatForArtifact(artifact, requested) {
  if (requested) return text(requested, 32).toLowerCase();
  const name = String(artifact.originalFilename || "").toLowerCase();
  if (name.endsWith(".xlsx")) return "xlsx";
  if (artifact.mimeType === "application/json" || name.endsWith(".json")) return "paste_json";
  return "csv";
}

export function createStructuredIntakeService({ repository, storage, baseServices, idFactory = randomUUID, clock = () => new Date() } = {}) {
  if (!repository || !storage || !baseServices) throw new Error("Structured Intake requires repository, storage, and base services.");

  async function requireBatch(actor, id) {
    const batch = await repository.getBatch(actor.tenantId, id);
    if (!batch) failIntake("INTAKE_BATCH_NOT_FOUND", "Intake batch was not found.", 404);
    return batch;
  }
  async function requireSnapshot(actor, batch) {
    const row = await repository.getSchemaSnapshot(actor.tenantId, batch.id);
    if (!row) failIntake("INTAKE_SCHEMA_SNAPSHOT_REQUIRED", "A captured schema snapshot is required.", 409);
    return row.snapshot;
  }
  async function parseArtifact(artifact, input) {
    const bytes = await storage.getBytes(artifact.storageKey);
    const format = formatForArtifact(artifact, input?.sourceFormat);
    if (format === "csv") return parseCsvArtifact(bytes, input);
    if (format === "xlsx") return parseXlsxArtifact(bytes, input);
    if (format === "paste_table") return parsePasteTable(bytes.toString("utf8"), input);
    if (format === "paste_json") return parsePasteJson(bytes.toString("utf8"));
    failIntake("INTAKE_SOURCE_FORMAT_UNSUPPORTED", "The requested structured source format is not supported.", 415);
  }

  async function profileBatch(batchId, input, context) {
    const actor = actorOf(context);
    const batch = await requireBatch(actor, batchId);
    assertRecordType(batch.batchType);
    const artifact = await repository.getArtifact(actor.tenantId, batch.artifactId);
    if (!artifact) failIntake("INTAKE_ARTIFACT_NOT_FOUND", "Artifact was not found.", 404);
    if (!["uploaded", "profiling", "mapping_required"].includes(batch.status)) failIntake("INTAKE_PROFILE_STATE_INVALID", "Batch cannot be profiled in its current state.", 409);
    await repository.updateBatch(actor.tenantId, batch.id, { status: "profiling", version: { increment: 1 } });
    await repository.createAudit(audit({ idFactory, actor, action: "artifact_profile_started", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId }));
    let parsed;
    try {
      parsed = await parseArtifact(artifact, input);
    } catch (error) {
      await repository.updateBatch(actor.tenantId, batch.id, { status: "failed", failureCode: error.code || "INTAKE_PROFILE_FAILED", failureMessage: text(error.message, 500), version: { increment: 1 } });
      await repository.createAudit(audit({ idFactory, actor, action: "artifact_profile_failed", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { code: error.code || "INTAKE_PROFILE_FAILED" } }));
      throw error;
    }
    let snapshot = await repository.getSchemaSnapshot(actor.tenantId, batch.id);
    if (!snapshot) {
      const resolved = await resolveTenantEntitySchema({ repository, tenantId: actor.tenantId, recordType: batch.batchType, clock });
      snapshot = await repository.createSchemaSnapshot({
        id: idFactory(), tenantId: actor.tenantId, batchId: batch.id, recordType: batch.batchType,
        coreSchemaId: resolved.coreSchemaId, coreSchemaVersion: resolved.coreSchemaVersion,
        tenantSchemaHash: resolved.tenantSchemaHash, snapshot: resolved,
        customFieldRevisionIds: resolved.customFieldRevisionIds,
      });
      await repository.createAudit(audit({ idFactory, actor, action: "schema_snapshot_created", entityType: "IntakeSchemaSnapshot", entityId: snapshot.id, requestId: context.requestId, after: { batchId: batch.id, tenantSchemaHash: resolved.tenantSchemaHash } }));
    }
    const compactProfile = profileDto(parsed);
    assertSafePayload(compactProfile, { maximumBytes: 256 * 1024 });
    await repository.transaction(async tx => {
      await tx.deleteBatchParseResults(actor.tenantId, batch.id);
      for (const record of parsed.records) {
        await tx.createRecord({
          id: idFactory(),
          tenantId: actor.tenantId,
          batchId: batch.id,
          rowNumber: record.rowNumber,
          sourcePayload: record.source,
          normalizedPayload: null,
          recordType: batch.batchType,
          status: "mapping_required",
          fingerprint: fingerprintPayload(record.source),
          sourceFormat: parsed.sourceFormat,
          sheetName: parsed.selectedSheet || null,
          headerRowNumber: parsed.headerRowNumber || parsed.selectedHeaderRow || 1,
          sourceLocator: record.sourceLocator,
          normalizationEvidence: null,
        });
      }
      await tx.updateBatch(actor.tenantId, batch.id, {
        status: "mapping_required",
        sourceProfile: compactProfile,
        parserVersion: parsed.parserVersion,
        selectedSheet: parsed.selectedSheet || null,
        headerRowNumber: parsed.headerRowNumber || parsed.selectedHeaderRow || 1,
        recordCount: parsed.records.length,
        validRecordCount: 0,
        warningCount: 0,
        errorCount: 0,
        failureCode: null,
        failureMessage: null,
        version: { increment: 1 },
      });
      await tx.createAudit(audit({ idFactory, actor, action: "artifact_profile_completed", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { sourceFormat: parsed.sourceFormat, rowCount: parsed.rowCount, columnCount: parsed.columnCount, parserVersion: parsed.parserVersion } }));
    });
    return { batch: batchDto(await requireBatch(actor, batch.id)), profile: compactProfile };
  }

  return {
    paste: async (kind, input, context) => {
      const actor = actorOf(context);
      const recordType = assertRecordType(input?.recordType);
      const raw = kind === "json"
        ? typeof input?.content === "string" ? input.content : JSON.stringify(input?.content)
        : String(input?.content || "");
      if (!raw) failIntake("INTAKE_PASTE_EMPTY", "Paste content is required.", 422);
      if (Buffer.byteLength(raw, "utf8") > INTAKE_LIMITS.maximumArtifactSizeBytes) failIntake("INTAKE_PASTE_SIZE_LIMIT", "Paste content exceeds 10 MB.", 413);
      const artifact = await baseServices.artifacts.register({
        sourceType: "manual_paste",
        originalFilename: kind === "json" ? "pasted-records.json" : "pasted-table.txt",
        mimeType: kind === "json" ? "application/json" : "text/plain",
        contentBase64: Buffer.from(raw, "utf8").toString("base64"),
      }, context);
      const batch = await baseServices.batches.create({ artifactId: artifact.id, batchType: recordType }, context);
      return profileBatch(batch.id, { sourceFormat: kind === "json" ? "paste_json" : "paste_table", delimiter: input?.delimiter }, context);
    },
    profile: profileBatch,
    getProfile: async (batchId, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      if (!batch.sourceProfile) failIntake("INTAKE_PROFILE_NOT_AVAILABLE", "Source profile is not available.", 404);
      return { batch: batchDto(batch), profile: batch.sourceProfile };
    },
    selectProfile: async (batchId, input, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      await repository.createAudit(audit({ idFactory, actor, action: input?.selectedSheet ? "intake_sheet_selected" : "intake_header_selected", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { selectedSheet: text(input?.selectedSheet, 120) || null, headerRowNumber: Number(input?.headerRowNumber) || null } }));
      return profileBatch(batch.id, input, context);
    },
    schema: async (batchId, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      return requireSnapshot(actor, batch);
    },
    suggestions: async (batchId, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      const schema = await requireSnapshot(actor, batch);
      const sourceFields = batch.sourceProfile?.sourceFieldNames || [];
      const signature = sourceSignature(batch.sourceProfile?.sourceFormat, sourceFields);
      const previous = await repository.findActiveMapping(actor.tenantId, batch.batchType, signature);
      const suggestions = suggestFieldMappings({ sourceFields, schema, previousProfile: previous });
      await repository.createAudit(audit({ idFactory, actor, action: "mapping_suggestions_generated", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { suggestionCount: suggestions.length } }));
      return { sourceSignature: signature, suggestions };
    },
    confirmMapping: async (batchId, input, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      if (batch.status !== "mapping_required") failIntake("INTAKE_MAPPING_STATE_INVALID", "Batch is not awaiting mapping.", 409);
      const schema = await requireSnapshot(actor, batch);
      const mappings = validateConfirmedMappings({ mappings: input?.mappings, schema });
      const signature = sourceSignature(batch.sourceProfile?.sourceFormat, batch.sourceProfile?.sourceFieldNames || []);
      const version = await repository.nextMappingVersion(actor.tenantId, batch.batchType, signature);
      const id = idFactory();
      await repository.transaction(async tx => {
        await tx.createMappingProfile({
          id, tenantId: actor.tenantId, name: text(input?.name, 120) || `${batch.batchType} structured mapping`,
          recordType: batch.batchType, sourceSignature: signature, version, status: "active", createdByUserId: actor.user.id,
          targetSchemaId: schema.coreSchemaId, targetSchemaVersion: schema.coreSchemaVersion,
          tenantSchemaHash: schema.tenantSchemaHash, sourceFormat: batch.sourceProfile?.sourceFormat,
        });
        await tx.createFieldMappings(mappings.map(mapping => ({ id: idFactory(), tenantId: actor.tenantId, mappingProfileId: id, ...mapping })));
        await tx.retireActiveMappings(actor.tenantId, batch.batchType, signature, id);
        await tx.updateBatch(actor.tenantId, batch.id, { mappingProfileId: id, version: { increment: 1 } });
        await tx.createAudit(audit({ idFactory, actor, action: "mapping_confirmed", entityType: "MappingProfile", entityId: id, requestId: context.requestId, after: { batchId: batch.id, version, fieldCount: mappings.length, tenantSchemaHash: schema.tenantSchemaHash } }));
      });
      return repository.getMappingProfile(actor.tenantId, id);
    },
    normalize: async (batchId, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      if (!batch.mappingProfileId) failIntake("INTAKE_MAPPING_REQUIRED", "A confirmed mapping is required.", 409);
      const schema = await requireSnapshot(actor, batch);
      const profile = await repository.getMappingProfile(actor.tenantId, batch.mappingProfileId);
      if (!profile || profile.tenantSchemaHash !== schema.tenantSchemaHash) failIntake("INTAKE_MAPPING_SCHEMA_MISMATCH", "Mapping does not match the captured schema.", 409);
      const records = await repository.listAllRecords(actor.tenantId, batch.id);
      await repository.updateBatch(actor.tenantId, batch.id, { status: "normalizing", version: { increment: 1 } });
      await repository.createAudit(audit({ idFactory, actor, action: "normalization_started", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { recordCount: records.length } }));
      await repository.transaction(async tx => {
        await tx.deleteIssues(actor.tenantId, batch.id);
        for (const record of records) {
          const result = normalizeStructuredRecord({ source: record.sourcePayload, recordType: batch.batchType, schema, mappingProfile: profile });
          await tx.updateRecord(actor.tenantId, record.id, { normalizedPayload: result.normalizedPayload, normalizationEvidence: result.evidence, fingerprint: result.fingerprint, status: result.issues.length ? "invalid" : "parsed" });
          for (const issue of result.issues) await tx.createIssue({ id: idFactory(), tenantId: actor.tenantId, batchId: batch.id, recordId: record.id, ...issue, details: null });
        }
        await tx.updateBatch(actor.tenantId, batch.id, { status: "validation_required", version: { increment: 1 } });
        await tx.createAudit(audit({ idFactory, actor, action: "normalization_completed", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { recordCount: records.length } }));
      });
      return { batch: batchDto(await requireBatch(actor, batch.id)), normalized: records.length };
    },
    validate: async (batchId, context) => {
      const actor = actorOf(context);
      const batch = await requireBatch(actor, batchId);
      if (batch.status !== "validation_required") failIntake("INTAKE_VALIDATION_STATE_INVALID", "Batch is not ready for validation.", 409);
      const schema = await requireSnapshot(actor, batch);
      const records = await repository.listAllRecords(actor.tenantId, batch.id);
      const seen = new Set();
      let valid = 0;
      let warnings = 0;
      let errors = 0;
      await repository.transaction(async tx => {
        await tx.deleteIssues(actor.tenantId, batch.id);
        for (const record of records) {
          if (record.status === "excluded") continue;
          const issues = validateNormalizedRecord({ normalizedPayload: record.normalizedPayload || { fields: {}, customFields: {} }, schema });
          if (seen.has(record.fingerprint)) issues.push({ severity: "error", code: "INTAKE_DUPLICATE_WITHIN_BATCH", field: null, message: "Record duplicates another normalized row in this batch." });
          seen.add(record.fingerprint);
          const hasError = issues.some(issue => issue.severity === "error");
          const hasWarning = issues.some(issue => issue.severity === "warning");
          const status = hasError ? "invalid" : hasWarning ? "warning" : "valid";
          await tx.updateRecord(actor.tenantId, record.id, { status });
          for (const issue of issues) await tx.createIssue({ id: idFactory(), tenantId: actor.tenantId, batchId: batch.id, recordId: record.id, ...issue, details: null });
          if (hasError) errors += 1; else if (hasWarning) warnings += 1; else valid += 1;
        }
        await tx.updateBatch(actor.tenantId, batch.id, { status: errors ? "validation_required" : "ready_for_review", validRecordCount: valid, warningCount: warnings, errorCount: errors, version: { increment: 1 } });
        await tx.createAudit(audit({ idFactory, actor, action: "validation_completed", entityType: "IntakeBatch", entityId: batch.id, requestId: context.requestId, after: { valid, warnings, errors, excluded: records.filter(record => record.status === "excluded").length } }));
      });
      return { batch: batchDto(await requireBatch(actor, batch.id)), counts: { total: records.length, valid, warnings, errors, excluded: records.filter(record => record.status === "excluded").length } };
    },
    exclude: async (recordId, excluded, context) => {
      const actor = actorOf(context);
      const record = await repository.getRecord(actor.tenantId, recordId);
      if (!record) failIntake("INTAKE_RECORD_NOT_FOUND", "Intake record was not found.", 404);
      await repository.updateRecord(actor.tenantId, record.id, excluded
        ? { status: "excluded", excludedByUserId: actor.user.id, excludedAt: clock() }
        : { status: "parsed", excludedByUserId: null, excludedAt: null });
      await repository.createAudit(audit({ idFactory, actor, action: excluded ? "record_excluded" : "record_restored", entityType: "IntakeRecord", entityId: record.id, requestId: context.requestId, after: { batchId: record.batchId } }));
      return { id: record.id, status: excluded ? "excluded" : "parsed" };
    },
    issueReport: async (batchId, context) => {
      const actor = actorOf(context);
      await requireBatch(actor, batchId);
      const rows = await repository.listAllIssues(actor.tenantId, batchId);
      const escape = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
      return { filename: `intake-issues-${batchId}.csv`, contentType: "text/csv; charset=utf-8", content: ["recordId,severity,code,field,message", ...rows.map(row => [row.recordId, row.severity, row.code, row.field, row.message].map(escape).join(","))].join("\r\n") };
    },
  };
}
