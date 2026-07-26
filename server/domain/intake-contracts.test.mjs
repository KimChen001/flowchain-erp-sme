import assert from "node:assert/strict";
import test from "node:test";
import {
  INTAKE_COMMIT_NOT_IMPLEMENTED,
  IntakeError,
  assertBatchTransition,
  assertSafePayload,
  assertTransformType,
  fingerprintPayload,
  sanitizeSourceUrl,
  validateGenericRecord,
} from "./intake-contracts.mjs";

test("intake batch state machine permits only Phase 5.4A transitions", () => {
  for (const [from, to] of [
    ["uploaded", "profiling"],
    ["profiling", "mapping_required"],
    ["mapping_required", "validation_required"],
    ["validation_required", "ready_for_review"],
    ["ready_for_review", "cancelled"],
  ]) assert.equal(assertBatchTransition(from, to), to);
  for (const [from, to] of [
    ["uploaded", "completed"],
    ["failed", "ready_for_review"],
    ["cancelled", "approved"],
    ["ready_for_review", "approved"],
  ]) assert.throws(() => assertBatchTransition(from, to), error => error instanceof IntakeError && error.code === "INTAKE_BATCH_TRANSITION_INVALID");
});

test("payload safety rejects prototype and exact secret fields but allows business names", () => {
  assert.deepEqual(assertSafePayload({ supplierTokenNumber: "SUP-100", nested: { quantity: 4 } }), { supplierTokenNumber: "SUP-100", nested: { quantity: 4 } });
  for (const field of ["__proto__", "prototype", "constructor"]) {
    const payload = JSON.parse(`{"${field}":{"polluted":true}}`);
    assert.throws(() => assertSafePayload(payload), error => error.code === "INTAKE_PAYLOAD_PROTOTYPE_KEY");
  }
  for (const field of ["password", "secret", "token", "access_token", "refresh_token", "private_key"]) {
    assert.throws(() => assertSafePayload({ [field]: "not-allowed" }), error => error.code === "INTAKE_PAYLOAD_SECRET_FIELD");
  }
  assert.equal({}.polluted, undefined);
});

test("payload safety rejects oversized, deep, excessive, and unsupported values", () => {
  assert.throws(() => assertSafePayload({ value: "x".repeat(70_000) }), error => error.code === "INTAKE_PAYLOAD_SIZE_LIMIT");
  assert.throws(() => assertSafePayload({ a: { b: { c: { d: { e: { f: 1 } } } } } }), error => error.code === "INTAKE_PAYLOAD_NESTING_LIMIT");
  assert.throws(() => assertSafePayload(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, i]))), error => error.code === "INTAKE_PAYLOAD_FIELD_LIMIT");
  assert.throws(() => assertSafePayload({ value: BigInt(1) }), error => error.code === "INTAKE_PAYLOAD_UNSUPPORTED_TYPE");
});

test("generic validation emits stable codes and duplicate fingerprints", () => {
  const seen = new Set();
  const rules = [
    { field: "name", required: true, maximumLength: 4 },
    { field: "date", type: "date" },
    { field: "amount", type: "decimal" },
    { field: "count", type: "integer" },
    { field: "currency", type: "currency_code" },
  ];
  const first = validateGenericRecord({ name: "", date: "not-date", amount: "x", count: "1.2", currency: "usd" }, rules, seen);
  assert.deepEqual(first.issues.map(issue => issue.code), [
    "INTAKE_REQUIRED_FIELD_MISSING",
    "INTAKE_DATE_FORMAT_INVALID",
    "INTAKE_DECIMAL_FORMAT_INVALID",
    "INTAKE_INTEGER_FORMAT_INVALID",
    "INTAKE_CURRENCY_CODE_INVALID",
  ]);
  const duplicate = validateGenericRecord(first.payload, rules, seen);
  assert.ok(duplicate.issues.some(issue => issue.code === "INTAKE_DUPLICATE_ROW_FINGERPRINT"));
  assert.equal(fingerprintPayload({ b: 2, a: 1 }), fingerprintPayload({ a: 1, b: 2 }));
});

test("mapping transforms and source URLs reject executable or secret-bearing input", () => {
  assert.equal(assertTransformType("currency_code"), "currency_code");
  for (const transform of ["javascript", "sql", "{{template}}"]) {
    assert.throws(() => assertTransformType(transform), error => error.code === "INTAKE_MAPPING_TRANSFORM_UNSUPPORTED");
  }
  assert.throws(() => sanitizeSourceUrl("https://example.com/file?access_token=no"), error => error.code === "INTAKE_SOURCE_URL_SECRET");
  assert.throws(() => sanitizeSourceUrl("https://user:pass@example.com/file"), error => error.code === "INTAKE_SOURCE_URL_UNSAFE");
  assert.equal(INTAKE_COMMIT_NOT_IMPLEMENTED, "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED");
});
