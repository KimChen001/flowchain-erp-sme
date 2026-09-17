// Shared classification for PostgreSQL concurrency conflicts surfaced through Prisma.
//
// Under `isolationLevel: "Serializable"` a losing transaction does not always
// reach the caller as Prisma's own `P2034`. When the conflict is raised by a raw
// statement (for example a `SELECT ... FOR UPDATE` row lock issued through
// `$queryRawUnsafe`), Prisma reports `P2010` ("Raw query failed") and carries the
// PostgreSQL SQLSTATE in the message/meta instead:
//
//   PrismaClientKnownRequestError | code=P2010 | status=undefined
//   Raw query failed. Code: `40001`.
//   Message: `could not serialize access due to read/write dependencies among transactions`
//
// Observed empirically against real PostgreSQL 16 under six-way award contention.
// Callers must treat both shapes as the same retryable/conflict condition.
//
// SQLSTATE references: 40001 serialization_failure, 40P01 deadlock_detected.

const CONFLICT_TEXT = /\b40001\b|\b40P01\b|could not serialize|serialization failure|deadlock detected|write conflict/i;

const safeJson = (value) => {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

/**
 * True when the error represents a PostgreSQL serialization failure or deadlock,
 * whichever Prisma error code it arrives under.
 *
 * Deliberately does not match the bare word "serializable"/"serializable" so
 * unrelated domain errors (for example INTAKE_PAYLOAD_NOT_SERIALIZABLE) are not
 * misread as concurrency conflicts.
 */
export function isPrismaConcurrencyError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === "P2034") return true;

  const sqlState = String(
    error.cause?.originalCode ?? error.cause?.code ?? error.meta?.code ?? "",
  );
  if (sqlState === "40001" || sqlState === "40P01") return true;

  return CONFLICT_TEXT.test(
    `${String(error.message ?? "")} ${safeJson(error.meta)} ${safeJson(error.cause)}`,
  );
}
