import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { isPrismaConcurrencyError } from "./prisma-concurrency-error.mjs";
import { OperationalFinanceError } from "./operational-finance-command-service.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";
import {
  derivePayableSettlementStatus,
  deriveReceivableSettlementStatus,
} from "./obligation-status-policy.mjs";

// Light payment records (docs/bills-invoices-and-accounting-handoff.md, step 2):
// someone paid a bill or a customer paid an invoice outside FlowChain, and the
// record says so. A payment lowers the outstanding amount of one bill to pay
// or one receivable and moves its status to partially settled or settled; a
// wrong record is voided with a reason, which restores the amount. FlowChain
// never moves money, and nothing here touches a cashbook or a ledger.
//
// A bill to pay exists only once its bill passed the three-way match and was
// approved, so a payment can never be recorded against goods that were not
// received or a bill that was not matched.

export const PAYMENT_METHODS = Object.freeze(["check", "ach", "wire", "card", "cash", "other"]);

const KINDS = {
  payable: {
    table: "PayableObligation",
    model: "payableObligation",
    foreignKey: "payableObligationId",
    permission: "finance.payable.record_payment",
    notFound: "PAYABLE_OBLIGATION_NOT_FOUND",
    payable: ["approved", "export_ready", "partially_settled"],
    derive: derivePayableSettlementStatus,
  },
  receivable: {
    table: "ReceivableObligation",
    model: "receivableObligation",
    foreignKey: "receivableObligationId",
    permission: "finance.receivable.record_payment",
    notFound: "RECEIVABLE_NOT_FOUND",
    payable: ["open", "overdue", "partially_settled"],
    derive: deriveReceivableSettlementStatus,
  },
};

const text = (value) => String(value ?? "").trim();
const fail = (code, message, status = 400, details) => {
  throw new OperationalFinanceError(code, message, status, details);
};
const issue = (code, message, status = 422, details) => ({
  code,
  message,
  status,
  ...(details ? { details } : {}),
});
const REFERENCE_LIMIT = 120;
const NOTE_LIMIT = 500;
const VOID_REASON_LIMIT = 500;

function kindOf(kind) {
  const config = KINDS[text(kind)];
  if (!config) fail("PAYMENT_OBLIGATION_TYPE_INVALID", "Payments are recorded on a supplier invoice to pay or a receivable.", 404);
  return config;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const requestHash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

function expectedVersion(value, label = "expectedVersion") {
  const parsed = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isInteger(parsed) || parsed < 0)
    fail("FINANCE_VERSION_INVALID", `${label} must be a non-negative integer.`, 422);
  return parsed;
}

// A calendar date, YYYY-MM-DD or an ISO timestamp, kept as UTC midnight.
function paymentDay(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${match[1]}-${match[2]}-${match[3]}` ? null : date;
}

export function normalizedPaymentInput(input = {}) {
  return {
    expectedVersion: input.expectedVersion,
    paymentDate: text(input.paymentDate),
    amount: text(input.amount),
    currency: text(input.currency).toUpperCase(),
    method: text(input.method).toLowerCase(),
    reference: text(input.reference),
    note: text(input.note),
  };
}

const obligationView = (row) => ({
  id: row.id,
  obligationNumber: row.obligationNumber,
  status: row.status,
  originalAmount: fixed(units(row.originalAmount)),
  approvedCreditAmount: fixed(units(row.approvedCreditAmount || 0)),
  outstandingAmount: fixed(units(row.outstandingAmount)),
  currency: row.currency,
  version: row.version,
});

const paymentView = (row) => ({
  id: row.id,
  obligationType: row.obligationType,
  payableObligationId: row.payableObligationId,
  receivableObligationId: row.receivableObligationId,
  paymentDate: row.paymentDate?.toISOString?.().slice(0, 10) ?? row.paymentDate,
  amount: fixed(units(row.amount)),
  currency: row.currency,
  method: row.method,
  reference: row.reference,
  note: row.note,
  status: row.status,
  voidReason: row.voidReason,
  version: row.version,
});

// What recording this payment would do, or why it cannot be recorded. The
// command runs the same plan inside its transaction after locking the row.
export function buildPaymentPlan({ kind, obligation, input, asOf, expected }) {
  const config = KINDS[kind];
  const blockingIssues = [];
  if (expected !== undefined && obligation.version !== expected)
    blockingIssues.push(issue("FINANCE_VERSION_CONFLICT", "The supplier invoice to pay or receivable changed concurrently. Reload and retry.", 409));
  if (kind === "payable" && obligation.status === "held")
    blockingIssues.push(issue("PAYMENT_OBLIGATION_HELD", "This supplier invoice to pay is on hold. Release it before recording a payment.", 409));
  else if (kind === "receivable" && (obligation.status === "disputed" || obligation.disputeStatus === "open"))
    blockingIssues.push(issue("PAYMENT_OBLIGATION_DISPUTED", "This receivable is disputed. Resolve the dispute before recording a payment.", 409));
  else if (obligation.status === "settled")
    blockingIssues.push(issue("PAYMENT_OBLIGATION_SETTLED", "This is already paid in full.", 409));
  else if (!config.payable.includes(obligation.status))
    blockingIssues.push(issue("PAYMENT_OBLIGATION_STATUS_INVALID", `A payment cannot be recorded while the status is ${obligation.status}.`, 409, { status: obligation.status }));

  const outstanding = units(obligation.outstandingAmount);
  let amount = null;
  try {
    amount = units(input.amount);
  } catch {
    amount = null;
  }
  if (amount === null || !text(input.amount))
    blockingIssues.push(issue("PAYMENT_AMOUNT_INVALID", "Enter the amount as a number with at most four decimals."));
  else if (amount <= 0n)
    blockingIssues.push(issue("PAYMENT_AMOUNT_INVALID", "The amount must be more than zero."));
  else if (amount > outstanding)
    blockingIssues.push(issue("PAYMENT_AMOUNT_EXCEEDS_OUTSTANDING", `The amount is more than the ${fixed(outstanding)} ${obligation.currency} still outstanding.`, 409, { outstandingAmount: fixed(outstanding), requestedAmount: fixed(amount) }));
  if (input.currency && input.currency !== obligation.currency)
    blockingIssues.push(issue("FINANCE_CURRENCY_MISMATCH", `Payments on this document are in ${obligation.currency}; no currency is converted.`, 409));

  const day = paymentDay(input.paymentDate);
  if (!day) blockingIssues.push(issue("PAYMENT_DATE_INVALID", "Enter the payment date as YYYY-MM-DD."));
  // A day of slack covers a workspace ahead of UTC.
  else if (day.getTime() > asOf.getTime() + 86_400_000)
    blockingIssues.push(issue("PAYMENT_DATE_IN_FUTURE", "The payment date cannot be in the future."));
  if (!PAYMENT_METHODS.includes(input.method))
    blockingIssues.push(issue("PAYMENT_METHOD_INVALID", `The method must be one of ${PAYMENT_METHODS.join(", ")}.`));
  if (input.reference.length > REFERENCE_LIMIT)
    blockingIssues.push(issue("PAYMENT_REFERENCE_TOO_LONG", `The reference can have at most ${REFERENCE_LIMIT} characters.`));
  if (input.note.length > NOTE_LIMIT)
    blockingIssues.push(issue("PAYMENT_NOTE_TOO_LONG", `The note can have at most ${NOTE_LIMIT} characters.`));

  const next = amount !== null && amount > 0n && amount <= outstanding ? outstanding - amount : outstanding;
  return {
    operation: `record_${kind}_payment`,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    before: obligationView(obligation),
    after: {
      outstandingAmount: fixed(next),
      status: blockingIssues.length ? obligation.status : config.derive({ ...obligation, outstandingAmount: fixed(next) }),
    },
    payment: {
      paymentDate: day ? day.toISOString().slice(0, 10) : null,
      amount: amount === null ? null : fixed(amount),
      currency: obligation.currency,
      method: input.method,
      reference: input.reference || null,
      note: input.note || null,
    },
    paymentExecution: false,
    ledgerMutation: false,
  };
}

// What voiding a recorded payment would do. The amount goes back to the
// outstanding balance; a credit approved since then can make that unsafe.
export function buildVoidPlan({ kind, obligation, payment, reason, expected }) {
  const config = KINDS[kind];
  const blockingIssues = [];
  if (expected !== undefined && payment.version !== expected)
    blockingIssues.push(issue("FINANCE_VERSION_CONFLICT", "The payment changed concurrently. Reload and retry.", 409));
  if (payment.status !== "recorded")
    blockingIssues.push(issue("PAYMENT_ALREADY_VOIDED", "This payment is already voided.", 409));
  if (!text(reason))
    blockingIssues.push(issue("PAYMENT_VOID_REASON_REQUIRED", "Enter why the payment is voided."));
  else if (text(reason).length > VOID_REASON_LIMIT)
    blockingIssues.push(issue("PAYMENT_VOID_REASON_TOO_LONG", `The reason can have at most ${VOID_REASON_LIMIT} characters.`));
  const maximum = units(obligation.originalAmount) - units(obligation.approvedCreditAmount || 0);
  const restored = units(obligation.outstandingAmount) + (payment.status === "recorded" ? units(payment.amount) : 0n);
  if (restored > maximum)
    blockingIssues.push(issue("PAYMENT_VOID_NOT_SAFE", "The document changed since this payment was recorded, so its amount cannot be restored safely.", 409));
  return {
    operation: `void_${kind}_payment`,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    before: obligationView(obligation),
    after: {
      outstandingAmount: fixed(blockingIssues.length ? units(obligation.outstandingAmount) : restored),
      status: blockingIssues.length ? obligation.status : config.derive({ ...obligation, outstandingAmount: fixed(restored) }),
    },
    payment: paymentView(payment),
    paymentExecution: false,
    ledgerMutation: false,
  };
}

const isConcurrency = (error) =>
  isPrismaConcurrencyError(error) || /serialization|deadlock|write conflict/i.test(text(error?.message));

export function createPaymentRecordCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  function assertEnabled() {
    if (text(env.FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE).toLowerCase() !== "true")
      fail("OPERATIONAL_FINANCE_CAPABILITY_NOT_AVAILABLE", "Operational finance requires database persistence and explicit enablement.", 409);
  }

  function signedIdentity(context) {
    const identity = context?.identity || context;
    if (!identity?.authenticated || !text(identity.tenantId))
      fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    return identity;
  }

  async function previewActor(context, config) {
    assertEnabled();
    const actor = await resolveProvisionedActor(prisma, signedIdentity(context));
    assertAuthorized({ actor, permission: config.permission, tenantId: actor.tenantId });
    return actor;
  }

  async function findObligation(db, config, tenantId, id) {
    const row = await db[config.model].findFirst({ where: { id: text(id), tenantId } });
    if (!row) fail(config.notFound, "The supplier invoice to pay or receivable was not found.", 404);
    return row;
  }

  async function findPayment(db, config, tenantId, obligationId, paymentId) {
    const row = await db.paymentRecord.findFirst({
      where: { id: text(paymentId), tenantId, [config.foreignKey]: text(obligationId) },
    });
    if (!row) fail("PAYMENT_NOT_FOUND", "The payment was not found on this document.", 404);
    return row;
  }

  // Idempotent and serializable like the other finance commands: a retried
  // request with the same key returns the first result, and a key reused for
  // a different request is refused.
  async function execute(commandType, permission, input, context, payload, work) {
    assertEnabled();
    const identity = signedIdentity(context);
    const idempotencyKey = text(input.idempotencyKey);
    if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const hash = requestHash(payload);
    const where = { tenantId_commandType_idempotencyKey: { tenantId: identity.tenantId, commandType, idempotencyKey } };
    const replay = (execution) => {
      if (!execution) return null;
      if (execution.requestHash !== hash)
        fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was already used with a different payload.", 409);
      if (execution.status !== "completed" || !execution.resultPayload)
        fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is already in progress.", 409);
      return { ...execution.resultPayload, idempotentReplay: true };
    };
    const outside = replay(await prisma.businessCommandExecution.findUnique({ where }));
    if (outside) return outside;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await prisma.$transaction(
          async (tx) => {
            const actor = await resolveProvisionedActor(tx, identity);
            assertAuthorized({ actor, permission, tenantId: actor.tenantId });
            const inside = replay(await tx.businessCommandExecution.findUnique({ where }));
            if (inside) return inside;
            const execution = await tx.businessCommandExecution.create({
              data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey, requestHash: hash, status: "pending" },
            });
            const result = await work(tx, actor, { commandType, idempotencyKey });
            await tx.businessCommandExecution.update({
              where: { id: execution.id },
              data: { status: "completed", entityType: result.entityType, entityId: result.entityId, resultPayload: result, completedAt: now() },
            });
            return { ...result, idempotentReplay: false };
          },
          { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
        );
      } catch (error) {
        if (!(error instanceof OperationalFinanceError) && isConcurrency(error) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
          continue;
        }
        if (error instanceof OperationalFinanceError) throw error;
        if (isConcurrency(error))
          fail("FINANCE_CONCURRENCY_CONFLICT", "Payments on this document changed concurrently. Reload and retry.", 409);
        throw error;
      }
    }
  }

  async function lockRow(tx, table, tenantId, id, notFound) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
      tenantId,
      id,
    );
    if (!rows.length) fail(notFound, "The document was not found.", 404);
  }

  function audit({ actor, action, entityId, summary, command, before, after, evidence }) {
    return {
      id: idFactory(),
      tenantId: actor.tenantId,
      actorId: actor.user.id,
      source: "payment_record_command_service",
      module: "finance",
      action,
      entityType: "PaymentRecord",
      entityId,
      summary,
      metadata: { ...command, before, after, evidence, paymentExecution: false, ledgerMutation: false },
    };
  }

  async function previewRecordPayment(kind, obligationId, input, context) {
    const config = kindOf(kind);
    const actor = await previewActor(context, config);
    const obligation = await findObligation(prisma, config, actor.tenantId, obligationId);
    const normalized = normalizedPaymentInput(input);
    return buildPaymentPlan({ kind, obligation, input: normalized, asOf: now(), expected: expectedVersion(normalized.expectedVersion) });
  }

  async function recordPayment(kind, obligationId, input, context) {
    const config = kindOf(kind);
    const normalized = normalizedPaymentInput(input);
    const payload = { kind, obligationId: text(obligationId), ...normalized, expectedVersion: expectedVersion(normalized.expectedVersion) };
    return execute(`record_${kind}_payment`, config.permission, input, context, payload, async (tx, actor, command) => {
      await lockRow(tx, config.table, actor.tenantId, payload.obligationId, config.notFound);
      const obligation = await findObligation(tx, config, actor.tenantId, payload.obligationId);
      const plan = buildPaymentPlan({ kind, obligation, input: normalized, asOf: now(), expected: payload.expectedVersion });
      if (!plan.allowed) {
        const first = plan.blockingIssues[0];
        fail(first.code, first.message, first.status, first.details);
      }
      const payment = await tx.paymentRecord.create({
        data: {
          id: idFactory(),
          tenantId: actor.tenantId,
          obligationType: kind,
          [config.foreignKey]: obligation.id,
          paymentDate: new Date(`${plan.payment.paymentDate}T00:00:00.000Z`),
          amount: plan.payment.amount,
          currency: obligation.currency,
          method: plan.payment.method,
          reference: plan.payment.reference,
          note: plan.payment.note,
          status: "recorded",
          recordedById: actor.user.id,
        },
      });
      const updated = await tx[config.model].update({
        where: { id: obligation.id },
        data: { outstandingAmount: plan.after.outstandingAmount, status: plan.after.status, version: { increment: 1 } },
      });
      const result = {
        entityType: "PaymentRecord",
        entityId: payment.id,
        payment: paymentView(payment),
        obligation: obligationView(updated),
      };
      await tx.auditLog.create({
        data: audit({
          actor,
          action: `${kind}_payment_recorded`,
          entityId: payment.id,
          summary: `Payment of ${plan.payment.amount} ${obligation.currency} recorded on ${obligation.obligationNumber}; no money was moved.`,
          command,
          before: plan.before,
          after: result.obligation,
          evidence: { [config.foreignKey]: obligation.id, method: payment.method, reference: payment.reference },
        }),
      });
      return result;
    });
  }

  async function previewVoidPayment(kind, obligationId, paymentId, input, context) {
    const config = kindOf(kind);
    const actor = await previewActor(context, config);
    const obligation = await findObligation(prisma, config, actor.tenantId, obligationId);
    const payment = await findPayment(prisma, config, actor.tenantId, obligationId, paymentId);
    return buildVoidPlan({ kind, obligation, payment, reason: input.reason, expected: expectedVersion(input.expectedVersion) });
  }

  async function voidPayment(kind, obligationId, paymentId, input, context) {
    const config = kindOf(kind);
    const payload = {
      kind,
      obligationId: text(obligationId),
      paymentId: text(paymentId),
      expectedVersion: expectedVersion(input.expectedVersion),
      reason: text(input.reason),
    };
    return execute(`void_${kind}_payment`, config.permission, input, context, payload, async (tx, actor, command) => {
      await lockRow(tx, config.table, actor.tenantId, payload.obligationId, config.notFound);
      await lockRow(tx, "PaymentRecord", actor.tenantId, payload.paymentId, "PAYMENT_NOT_FOUND");
      const obligation = await findObligation(tx, config, actor.tenantId, payload.obligationId);
      const payment = await findPayment(tx, config, actor.tenantId, payload.obligationId, payload.paymentId);
      const plan = buildVoidPlan({ kind, obligation, payment, reason: payload.reason, expected: payload.expectedVersion });
      if (!plan.allowed) {
        const first = plan.blockingIssues[0];
        fail(first.code, first.message, first.status, first.details);
      }
      const voided = await tx.paymentRecord.update({
        where: { id: payment.id },
        data: { status: "voided", voidedAt: now(), voidedById: actor.user.id, voidReason: payload.reason, version: { increment: 1 } },
      });
      const updated = await tx[config.model].update({
        where: { id: obligation.id },
        data: { outstandingAmount: plan.after.outstandingAmount, status: plan.after.status, version: { increment: 1 } },
      });
      const result = {
        entityType: "PaymentRecord",
        entityId: voided.id,
        payment: paymentView(voided),
        obligation: obligationView(updated),
      };
      await tx.auditLog.create({
        data: audit({
          actor,
          action: `${kind}_payment_voided`,
          entityId: voided.id,
          summary: `Payment of ${plan.payment.amount} ${obligation.currency} on ${obligation.obligationNumber} voided; the amount is outstanding again.`,
          command,
          before: plan.before,
          after: result.obligation,
          evidence: { [config.foreignKey]: obligation.id, reason: payload.reason },
        }),
      });
      return result;
    });
  }

  return { previewRecordPayment, recordPayment, previewVoidPayment, voidPayment };
}

// Payments shown on a bill to pay or a receivable, newest first. Amounts
// follow the same finance.amounts.read rule as the document itself.
export function paymentRecordsView(rows = [], { amountsVisible, canRecord }) {
  return rows
    .slice()
    .sort((left, right) => right.paymentDate - left.paymentDate || right.createdAt - left.createdAt)
    .map((row) => ({
      ...paymentView(row),
      amount: amountsVisible ? fixed(units(row.amount)) : null,
      availableActions: canRecord && row.status === "recorded" ? ["void"] : [],
    }));
}

export function paidAmount(rows = []) {
  return fixed(rows.filter((row) => row.status === "recorded").reduce((sum, row) => sum + units(row.amount), 0n));
}
