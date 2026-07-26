import { createHash } from "node:crypto";
import { assertSafePayload, failIntake, fingerprintPayload } from "./intake-contracts.mjs";

const normalizedName = value => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/[\s._-]+/g, "");
const fieldKey = path => String(path).split(".").at(-1);

export function sourceSignature(sourceFormat, sourceFields) {
  return createHash("sha256").update(JSON.stringify({
    sourceFormat: String(sourceFormat || ""),
    sourceFields: [...sourceFields].map(String),
  })).digest("hex");
}

export function suggestFieldMappings({ sourceFields, schema, previousProfile }) {
  const previous = new Map((previousProfile?.fieldMappings || []).map(mapping => [mapping.sourceField, mapping]));
  return sourceFields.map(sourceField => {
    const source = String(sourceField);
    const exactPath = schema.fields.find(field => field.fieldPath === source);
    const caseInsensitive = schema.fields.find(field => field.fieldPath.toLowerCase() === source.toLowerCase());
    const normalized = schema.fields.find(field => normalizedName(field.fieldPath) === normalizedName(source) || normalizedName(fieldKey(field.fieldPath)) === normalizedName(source));
    const alias = schema.fields.find(field => (field.aliases || []).some(value => normalizedName(value) === normalizedName(source)));
    const prior = previous.get(source);
    const candidate = exactPath || caseInsensitive || normalized || alias || (prior && schema.fields.find(field => field.fieldPath === prior.targetField));
    const suggestionSource = exactPath ? "exact_field_path"
      : caseInsensitive ? "case_insensitive"
        : normalized ? "normalized_name"
          : alias ? (/[^\u0000-\u007f]/.test(source) ? "chinese_alias" : "canonical_alias")
            : prior && candidate ? "previous_active_mapping" : "none";
    const confidenceTier = exactPath ? "exact" : caseInsensitive || normalized || prior && candidate ? "strong" : alias ? "possible" : "none";
    return {
      sourceField: source,
      targetFieldPath: candidate?.fieldPath || null,
      suggestionSource,
      confidenceTier,
      explanation: candidate
        ? `${source} matched ${candidate.fieldPath} using ${suggestionSource}.`
        : "No deterministic mapping target was found.",
    };
  });
}

export function validateConfirmedMappings({ mappings, schema }) {
  if (!Array.isArray(mappings) || !mappings.length) failIntake("INTAKE_MAPPING_REQUIRED", "At least one field mapping is required.", 422);
  const fields = new Map(schema.fields.map(field => [field.fieldPath, field]));
  const sourceSeen = new Set();
  const targetSeen = new Set();
  const normalized = mappings.map((mapping, index) => {
    const sourceField = String(mapping?.sourceField || "").trim();
    const targetField = String(mapping?.targetFieldPath || mapping?.targetField || "").trim();
    if (!sourceField || !targetField) failIntake("INTAKE_MAPPING_FIELD_REQUIRED", "Mapping source and target fields are required.", 422);
    if (sourceSeen.has(sourceField)) failIntake("INTAKE_MAPPING_SOURCE_DUPLICATE", "A source field can be mapped only once.", 422, { sourceField });
    if (targetSeen.has(targetField)) failIntake("INTAKE_MAPPING_TARGET_DUPLICATE", "A single-value target field can be mapped only once.", 422, { targetField });
    const field = fields.get(targetField);
    if (!field) failIntake("INTAKE_MAPPING_TARGET_UNKNOWN", "Mapping target is not present in the captured schema snapshot.", 422, { targetField });
    sourceSeen.add(sourceField);
    targetSeen.add(targetField);
    return {
      sourceField,
      targetField,
      transformType: String(mapping?.transformType || "identity"),
      required: Boolean(field.required),
      defaultValue: mapping?.defaultValue === undefined ? null : assertSafePayload({ value: mapping.defaultValue }).value,
      position: index,
    };
  });
  const missing = schema.fields.filter(field => field.required && !targetSeen.has(field.fieldPath) && field.defaultValue == null);
  if (missing.length) failIntake("INTAKE_MAPPING_REQUIRED_TARGET_MISSING", "All required schema fields must be covered.", 422, { fields: missing.map(field => field.fieldPath) });
  return normalized;
}

function convert(value, field, transform) {
  const raw = value == null ? "" : value;
  let transformed = raw;
  if (transform === "trim") transformed = String(raw).trim();
  if (transform === "uppercase") transformed = String(raw).trim().toUpperCase();
  if (transform === "lowercase") transformed = String(raw).trim().toLowerCase();
  if (transform === "currency_code") transformed = String(raw).trim().toUpperCase();
  if (raw === "" || raw == null) return field.defaultValue ?? null;
  if (field.dataType === "integer" || transform === "integer") {
    if (!/^[+-]?\d+$/.test(String(transformed).trim())) throw new Error("integer");
    return Number.parseInt(String(transformed), 10);
  }
  if (field.dataType === "decimal" || transform === "decimal") {
    if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(String(transformed).trim())) throw new Error("decimal");
    return String(transformed).trim();
  }
  if (field.dataType === "boolean" || transform === "boolean") {
    const text = String(transformed).trim().toLowerCase();
    if (["true", "1", "yes", "y", "是"].includes(text)) return true;
    if (["false", "0", "no", "n", "否"].includes(text)) return false;
    throw new Error("boolean");
  }
  if (field.dataType === "date" || transform === "date") {
    const date = new Date(transformed);
    if (Number.isNaN(date.valueOf())) throw new Error("date");
    return date.toISOString().slice(0, 10);
  }
  const text = String(transformed);
  return transform === "identity" && typeof raw !== "string" ? raw : text;
}

export function normalizeStructuredRecord({ source, recordType, schema, mappingProfile }) {
  const schemaFields = new Map(schema.fields.map(field => [field.fieldPath, field]));
  const fields = {};
  const customFields = {};
  const evidence = [];
  const issues = [];
  for (const mapping of mappingProfile.fieldMappings || []) {
    const field = schemaFields.get(mapping.targetField);
    if (!field) continue;
    try {
      const value = convert(source[mapping.sourceField] ?? mapping.defaultValue, field, mapping.transformType);
      const key = fieldKey(field.fieldPath);
      if (field.custom) customFields[key] = value;
      else fields[key] = value;
      evidence.push({
        targetFieldPath: field.fieldPath,
        sourceColumn: mapping.sourceField,
        sourceCell: null,
        transform: mapping.transformType,
        mappingProfileId: mappingProfile.id,
        mappingProfileVersion: mappingProfile.version,
        suggestionSource: "user_confirmed",
      });
    } catch (error) {
      issues.push({ severity: "error", code: `INTAKE_${String(error.message).toUpperCase()}_FORMAT_INVALID`, field: field.fieldPath, message: `Value cannot be converted to ${field.dataType}.` });
    }
  }
  for (const field of schema.fields) {
    const key = fieldKey(field.fieldPath);
    const target = field.custom ? customFields : fields;
    if (!(key in target) && field.defaultValue != null) {
      target[key] = field.defaultValue;
      evidence.push({
        targetFieldPath: field.fieldPath,
        sourceColumn: null,
        sourceCell: null,
        transform: "schema_default",
        mappingProfileId: mappingProfile.id,
        mappingProfileVersion: mappingProfile.version,
        suggestionSource: "canonical_default",
      });
    }
  }
  const normalizedPayload = {
    recordType,
    schema: { core: schema.coreSchemaId, tenantSchemaHash: schema.tenantSchemaHash },
    fields,
    customFields,
  };
  assertSafePayload(normalizedPayload);
  assertSafePayload({ evidence }, { maximumBytes: 64 * 1024 });
  return { normalizedPayload, evidence, issues, fingerprint: fingerprintPayload(normalizedPayload) };
}

export function validateNormalizedRecord({ normalizedPayload, schema }) {
  const issues = [];
  for (const field of schema.fields) {
    const value = field.custom ? normalizedPayload.customFields?.[fieldKey(field.fieldPath)] : normalizedPayload.fields?.[fieldKey(field.fieldPath)];
    if (field.required && (value === null || value === undefined || value === "")) {
      issues.push({ severity: "error", code: "INTAKE_REQUIRED_FIELD_MISSING", field: field.fieldPath, message: "A required field is missing." });
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    if (field.maximumLength && String(value).length > field.maximumLength) issues.push({ severity: "error", code: "INTAKE_MAXIMUM_LENGTH_EXCEEDED", field: field.fieldPath, message: "The value exceeds its maximum length." });
    if (field.allowedValues?.length && !field.allowedValues.includes(value)) issues.push({ severity: "error", code: "INTAKE_ALLOWED_VALUE_INVALID", field: field.fieldPath, message: "The value is not in the allowlist." });
    if (field.dataType === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value))) issues.push({ severity: "error", code: "INTAKE_EMAIL_INVALID", field: field.fieldPath, message: "Email format is invalid." });
  }
  return issues;
}
