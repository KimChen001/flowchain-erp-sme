import assert from "node:assert/strict";
import test from "node:test";
import { isPrismaConcurrencyError } from "./prisma-concurrency-error.mjs";

// The P2010 shape below is the error actually produced by a losing concurrent
// RFQ Award Decision under Serializable isolation against real PostgreSQL 16.
// It escaped the previous `P2002 || P2034` check in
// server/domain/rfq-award-decision-service.mjs and reached the caller unmapped
// (status undefined), which is what made the two-supplier award race assertion
// in tests/postgres/rfq-award-decision.test.mjs fail intermittently in CI.
const rawSerializationFailure = () => {
  const error = new Error(
    "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. " +
      "Code: `40001`. Message: `could not serialize access due to read/write dependencies among transactions`",
  );
  error.name = "PrismaClientKnownRequestError";
  error.code = "P2010";
  error.meta = {
    code: "40001",
    message: "could not serialize access due to read/write dependencies among transactions",
  };
  return error;
};

test("PostgreSQL concurrency conflicts are recognised under every Prisma code they arrive with", () => {
  assert.equal(isPrismaConcurrencyError(rawSerializationFailure()), true);

  assert.equal(isPrismaConcurrencyError(Object.assign(new Error("write conflict"), { code: "P2034" })), true);
  assert.equal(isPrismaConcurrencyError({ code: "P2034" }), true);

  // SQLSTATE carried on `cause` by the pg driver adapter rather than in `meta`.
  assert.equal(isPrismaConcurrencyError({ code: "P2010", cause: { code: "40001" } }), true);
  assert.equal(isPrismaConcurrencyError({ code: "P2010", cause: { originalCode: "40P01" } }), true);

  // Deadlock, reported textually.
  assert.equal(
    isPrismaConcurrencyError(Object.assign(new Error("deadlock detected"), { code: "P2010" })),
    true,
  );
});

test("unrelated failures are not misread as concurrency conflicts", () => {
  assert.equal(isPrismaConcurrencyError(null), false);
  assert.equal(isPrismaConcurrencyError(undefined), false);
  assert.equal(isPrismaConcurrencyError("40001"), false);
  assert.equal(isPrismaConcurrencyError(new Error("Raw query failed. Code: `23505`.")), false);

  // A unique-constraint violation is a distinct condition the award service
  // handles separately; it must not be folded into the concurrency branch.
  assert.equal(isPrismaConcurrencyError({ code: "P2002", meta: { target: ["tenantId", "rfqId"] } }), false);

  // Guards against matching the bare word "serializable".
  assert.equal(
    isPrismaConcurrencyError(
      Object.assign(new Error("Payload must be JSON serializable."), { code: "INTAKE_PAYLOAD_NOT_SERIALIZABLE" }),
    ),
    false,
  );

  // Must not throw on a self-referencing meta object.
  const circular = { code: "P2010", meta: {} };
  circular.meta.self = circular.meta;
  assert.equal(isPrismaConcurrencyError(circular), false);
});
