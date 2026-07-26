import { createHash } from "node:crypto";

export const INTAKE_COMMIT_NOT_IMPLEMENTED = "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED";
export const INTAKE_COMMIT_MESSAGE = "Governed business commit adapters are not implemented in Phase 5.4A.";

export const INTAKE_LIMITS = Object.freeze({
  maximumArtifactSizeBytes: 10 * 1024 * 1024,
  maximumRecordCount: 5_000,
  maximumRowPayloadBytes: 64 * 1024,
  maximumFieldCount: 200,
  maximumNestingDepth: 5,
  maximumRequestBytes: 14 * 1024 * 1024,
});

export const ALLOWED_SOURCE_TYPES = Object.freeze(["manual_upload"]);
export const RESERVED_SOURCE_TYPES = Object.freeze(["email_attachment", "api", "system_export"]);
export const ALLOWED_MIME_TYPES = Object.freeze([
  "text/csv",
  "text/plain",
  "application/json",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const ALLOWED_TRANSFORMS = Object.freeze([
  "identity",
  "trim",
  "uppercase",
  "lowercase",
  "date",
  "decimal",
  "integer",
  "boolean",
  "currency_code",
]);

const FORBIDDEN_PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_SECRET_FIELDS = new Set([
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
]);
const IMPLEMENTED_BATCH_STATES = new Set([
  "uploaded",
  "profiling",
  "mapping_required",
  "validation_required",
  "ready_for_review",
  "failed",
  "cancelled",
]);
const BATCH_TRANSITIONS = Object.freeze({
  uploaded: new Set(["profiling", "failed", "cancelled"]),
  profiling: new Set(["mapping_required", "validation_required", "failed", "cancelled"]),
  mapping_required: new Set(["validation_required", "failed", "cancelled"]),
  validation_required: new Set(["mapping_required", "ready_for_review", "failed", "cancelled"]),
  ready_for_review: new Set(["failed", "cancelled"]),
  failed: new Set(),
  cancelled: new Set(),
});

export class IntakeError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "IntakeError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const failIntake = (code, message, status = 400, details) => {
  throw new IntakeError(code, message, status, details);
};

export function requireTenantId(value) {
  const tenantId = String(value || "").trim();
  if (!tenantId) failIntake("TENANT_CONTEXT_REQUIRED", "A tenant context is required.", 403);
  return tenantId;
}

export function safePage(input = {}) {
  const limit = Math.min(100, Math.max(1, Number(input.limit || 25)));
  const cursor = String(input.cursor || "").trim() || null;
  return { limit, cursor };
}

function normalizedFieldName(value) {
  return String(value || "").trim().toLowerCase();
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    failIntake("INTAKE_PAYLOAD_NOT_SERIALIZABLE", "Payload must be JSON serializable.", 422);
  }
}

function assertSafeValue(value, depth, fieldCount) {
  if (depth > INTAKE_LIMITS.maximumNestingDepth) {
    failIntake("INTAKE_PAYLOAD_NESTING_LIMIT", "Payload nesting exceeds the supported limit.", 422);
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      failIntake("INTAKE_PAYLOAD_UNSUPPORTED_VALUE", "Payload numbers must be finite.", 422);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeValue(entry, depth + 1, fieldCount);
    return;
  }
  if (typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    failIntake("INTAKE_PAYLOAD_UNSUPPORTED_TYPE", "Payload contains an unsupported value type.", 422);
  }
  for (const [key, entry] of Object.entries(value)) {
    fieldCount.count += 1;
    if (fieldCount.count > INTAKE_LIMITS.maximumFieldCount) {
      failIntake("INTAKE_PAYLOAD_FIELD_LIMIT", "Payload contains too many fields.", 422);
    }
    const normalized = normalizedFieldName(key);
    if (FORBIDDEN_PROTOTYPE_KEYS.has(normalized)) {
      failIntake("INTAKE_PAYLOAD_PROTOTYPE_KEY", "Payload contains a forbidden prototype key.", 422, { field: key });
    }
    if (FORBIDDEN_SECRET_FIELDS.has(normalized)) {
      failIntake("INTAKE_PAYLOAD_SECRET_FIELD", "Payload contains a forbidden secret field.", 422, { field: key });
    }
    assertSafeValue(entry, depth + 1, fieldCount);
  }
}

export function assertSafePayload(value, { maximumBytes = INTAKE_LIMITS.maximumRowPayloadBytes } = {}) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    failIntake("INTAKE_PAYLOAD_OBJECT_REQUIRED", "A JSON object payload is required.", 422);
  }
  assertSafeValue(value, 0, { count: 0 });
  if (jsonSize(value) > maximumBytes) {
    failIntake("INTAKE_PAYLOAD_SIZE_LIMIT", "Payload exceeds the supported size limit.", 413);
  }
  return structuredClone(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function fingerprintPayload(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function assertBatchTransition(from, to) {
  if (!IMPLEMENTED_BATCH_STATES.has(from) || !IMPLEMENTED_BATCH_STATES.has(to) || !BATCH_TRANSITIONS[from]?.has(to)) {
    failIntake("INTAKE_BATCH_TRANSITION_INVALID", `Batch cannot transition from ${from} to ${to}.`, 409, { from, to });
  }
  return to;
}

export function assertTransformType(value) {
  const transform = String(value || "identity").trim();
  if (!ALLOWED_TRANSFORMS.includes(transform)) {
    failIntake("INTAKE_MAPPING_TRANSFORM_UNSUPPORTED", "Only declarative allowlisted transforms are supported.", 422);
  }
  return transform;
}

function typeIssue(field, code, message) {
  return { severity: "error", code, field, message, details: null };
}

export function validateGenericRecord(payload, rules = [], seenFingerprints = new Set()) {
  const safe = assertSafePayload(payload);
  const issues = [];
  for (const rule of rules) {
    const field = String(rule?.field || "").trim();
    if (!field) continue;
    const value = safe[field];
    if (rule.required && (value === undefined || value === null || value === "")) {
      issues.push(typeIssue(field, "INTAKE_REQUIRED_FIELD_MISSING", "A required field is missing."));
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") {
      issues.push(typeIssue(field, "INTAKE_UNSUPPORTED_FIELD_TYPE", "The field type is not supported by this validator."));
      continue;
    }
    if (rule.maximumLength && String(value).length > Number(rule.maximumLength)) {
      issues.push(typeIssue(field, "INTAKE_MAXIMUM_LENGTH_EXCEEDED", "The field exceeds its maximum length."));
    }
    const text = String(value).trim();
    const type = String(rule.type || "").trim();
    if (type === "date" && Number.isNaN(Date.parse(text))) issues.push(typeIssue(field, "INTAKE_DATE_FORMAT_INVALID", "The date format is invalid."));
    if (type === "decimal" && !/^[+-]?(?:\d+|\d*\.\d+)$/.test(text)) issues.push(typeIssue(field, "INTAKE_DECIMAL_FORMAT_INVALID", "The decimal format is invalid."));
    if (type === "integer" && !/^[+-]?\d+$/.test(text)) issues.push(typeIssue(field, "INTAKE_INTEGER_FORMAT_INVALID", "The integer format is invalid."));
    if (type === "boolean" && !/^(?:true|false|0|1|yes|no)$/i.test(text)) issues.push(typeIssue(field, "INTAKE_BOOLEAN_FORMAT_INVALID", "The boolean format is invalid."));
    if (type === "currency_code" && !/^[A-Z]{3}$/.test(text)) issues.push(typeIssue(field, "INTAKE_CURRENCY_CODE_INVALID", "The currency code must be three uppercase letters."));
  }
  const fingerprint = fingerprintPayload(safe);
  if (seenFingerprints.has(fingerprint)) {
    issues.push({ severity: "error", code: "INTAKE_DUPLICATE_ROW_FINGERPRINT", field: null, message: "This row duplicates another row in the batch.", details: null });
  }
  seenFingerprints.add(fingerprint);
  return { payload: safe, fingerprint, issues };
}

export function sanitizeSourceUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    failIntake("INTAKE_SOURCE_URL_INVALID", "Source URL is invalid.", 422);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    failIntake("INTAKE_SOURCE_URL_UNSAFE", "Source URL must not contain credentials.", 422);
  }
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_SECRET_FIELDS.has(normalizedFieldName(key))) {
      failIntake("INTAKE_SOURCE_URL_SECRET", "Source URL must not contain secret query parameters.", 422);
    }
  }
  return url.toString();
}

export function sanitizeAuditValue(value) {
  if (value === undefined) return null;
  const safe = assertSafePayload(value, { maximumBytes: 8 * 1024 });
  return safe;
}
