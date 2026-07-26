import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";

export class InternalSettlementError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "InternalSettlementError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new InternalSettlementError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const commandPermissions = Object.freeze({
  create_cashbook_account: "finance.cashbook.manage",
  create_settlement: "finance.settlement.create",
  revise_settlement: "finance.settlement.revise",
  submit_settlement: "finance.settlement.submit",
  approve_settlement: "finance.settlement.approve",
  reject_settlement: "finance.settlement.reject",
  cancel_settlement: "finance.settlement.cancel",
  post_settlement: "finance.settlement.post",
  reverse_settlement: "finance.settlement.reverse",
});
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const hash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const whereExecution = (tenantId, commandType, idempotencyKey) => ({ tenantId_commandType_idempotencyKey: { tenantId, commandType, idempotencyKey } });
const asDate = (value, label) => {
  const date = new Date(value);
  if (!text(value) || Number.isNaN(date.getTime())) fail("SETTLEMENT_DATE_INVALID", `${label} must be a valid date.`, 422);
  return date;
};
const amountUnits = (value, label, { allowZero = false } = {}) => {
  try {
    const parsed = units(value);
    if (allowZero ? parsed < 0n : parsed <= 0n) fail("SETTLEMENT_AMOUNT_INVALID", `${label} must be ${allowZero ? "non-negative" : "positive"}.`, 422);
    return parsed;
  } catch (error) {
    if (error instanceof InternalSettlementError) throw error;
    fail("SETTLEMENT_AMOUNT_INVALID", `${label} must be a fixed four-decimal amount.`, 422);
  }
};
const expectedVersion = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail("SETTLEMENT_VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422);
  return parsed;
};
const identity = (context) => {
  const value = context?.identity || context;
  if (!value?.authenticated || !text(value.tenantId)) fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  return value;
};
const enabled = (env) => {
  if (text(env.FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT).toLowerCase() !== "true")
    fail("INTERNAL_SETTLEMENT_CAPABILITY_NOT_AVAILABLE", "Internal settlement requires database persistence and explicit enablement.", 409);
};
const authorize = (actor, permission) => {
  assertAuthorized({ actor, permission, tenantId: actor.tenantId });
  if (permission === "finance.cashbook.manage" || permission.startsWith("finance.settlement") || permission.startsWith("finance.advance") || permission.startsWith("finance.internal_transfer"))
    assertAuthorized({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId });
};
const replay = (row, requestHash) => {
  if (!row) return null;
  if (row.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was already used with a different payload.", 409);
  if (row.status !== "completed" || !row.resultPayload) fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is already in progress.", 409);
  return { ...row.resultPayload, idempotentReplay: true };
};
const concurrency = (error) => error?.code === "P2034" || /serialization|deadlock|write conflict/i.test(text(error?.message));
const workflowEnabled = (env) => text(env.FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW).toLowerCase() === "true";
const defaultSettlementPolicy = Object.freeze({ settlementApprovalRequired: true, settlementSelfApprovalAllowed: false, settlementSelfPostingAllowed: true, settlementApprovalThreshold: "0", settlementDiscountThreshold: "0" });
const settlementPolicy = async (db, tenantId) => {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { operationalSettings: true } });
  return { ...defaultSettlementPolicy, ...(tenant?.operationalSettings?.settlementPolicy || {}) };
};
const thresholdUnits = (value) => {
  try { return units(value ?? 0); } catch { return 0n; }
};
const assertDiscountPolicy = (actor, policy, discountAmount) => {
  if (units(discountAmount) > thresholdUnits(policy.settlementDiscountThreshold)) authorize(actor, "finance.settlement_discount.apply");
};

function normalizeSettlement(input = {}) {
  return {
    settlementNumber: text(input.settlementNumber),
    direction: text(input.direction).toLowerCase(),
    counterpartyType: text(input.counterpartyType).toLowerCase(),
    counterpartyId: text(input.counterpartyId),
    cashbookAccountId: text(input.cashbookAccountId),
    currency: text(input.currency).toUpperCase(),
    amount: text(input.amount),
    settlementDate: text(input.settlementDate),
    externalReference: text(input.externalReference),
    memo: text(input.memo),
    allocations: (Array.isArray(input.allocations) ? input.allocations : []).map((row) => ({
      obligationType: text(row.obligationType).toLowerCase(),
      obligationId: text(row.obligationId || row.payableObligationId || row.receivableObligationId),
      cashAppliedAmount: text(row.cashAppliedAmount ?? row.amount),
      discountAmount: text(row.discountAmount || "0"),
      amount: text(row.totalSettlementAmount ?? row.amount),
      discountReason: text(row.discountReason),
    })).sort((a, b) => `${a.obligationType}:${a.obligationId}`.localeCompare(`${b.obligationType}:${b.obligationId}`)),
  };
}

async function settlementPlan(db, tenantId, input) {
  const issues = [];
  const add = (code, message, status = 422, details) => issues.push({ code, message, status, ...(details ? { details } : {}) });
  if (!input.settlementNumber) add("SETTLEMENT_NUMBER_REQUIRED", "Settlement number is required.");
  if (!input.cashbookAccountId) add("CASHBOOK_ACCOUNT_REQUIRED", "Cashbook account is required.");
  if (!/^[A-Z]{3}$/.test(input.currency)) add("SETTLEMENT_CURRENCY_INVALID", "Currency must be a three-letter ISO code.");
  if (!input.allocations.length) add("SETTLEMENT_ALLOCATIONS_REQUIRED", "At least one allocation is required.");
  const expectedType = input.direction === "disbursement" ? "payable" : input.direction === "receipt" ? "receivable" : null;
  const expectedCounterparty = input.direction === "disbursement" ? "supplier" : input.direction === "receipt" ? "customer" : null;
  if (!expectedType) add("SETTLEMENT_DIRECTION_INVALID", "Direction must be receipt or disbursement.");
  if (expectedCounterparty && input.counterpartyType !== expectedCounterparty) add("SETTLEMENT_COUNTERPARTY_INVALID", `A ${input.direction} requires a ${expectedCounterparty} counterparty.`);
  let total = 0n;
  let cashAllocationTotal = 0n;
  let discountTotal = 0n;
  try { amountUnits(input.amount, "Settlement amount"); } catch (error) { add(error.code, error.message, error.status); }
  const keys = new Set();
  for (const row of input.allocations) {
    const key = `${row.obligationType}:${row.obligationId}`;
    if (!row.obligationId || keys.has(key)) add("SETTLEMENT_ALLOCATION_DUPLICATE", "Each obligation may be allocated once per settlement.");
    keys.add(key);
    if (expectedType && row.obligationType !== expectedType) add("SETTLEMENT_OBLIGATION_TYPE_INVALID", `A ${input.direction} may allocate only ${expectedType} obligations.`);
    try {
      const cash = amountUnits(row.cashAppliedAmount, "Allocation cash amount", { allowZero: true });
      const discount = amountUnits(row.discountAmount, "Allocation discount", { allowZero: true });
      const settlementTotal = amountUnits(row.amount, "Allocation total");
      if (cash + discount !== settlementTotal) add("SETTLEMENT_ALLOCATION_TOTAL_MISMATCH", "Each allocation total must equal cash plus discount.");
      if (discount > 0n && !row.discountReason) add("SETTLEMENT_DISCOUNT_REASON_REQUIRED", "A settlement discount requires a reason.");
      cashAllocationTotal += cash;
      discountTotal += discount;
      total += settlementTotal;
    } catch (error) { add(error.code, error.message, error.status); }
  }
  let requested = 0n;
  try { requested = amountUnits(input.amount, "Settlement amount"); } catch {}
  if (requested && cashAllocationTotal > requested) add("SETTLEMENT_ALLOCATION_TOTAL_MISMATCH", "Allocation cash cannot exceed the settlement cash amount.", 422, { settlementAmount: fixed(requested), allocationCashTotal: fixed(cashAllocationTotal) });
  const advanceAmount = requested > cashAllocationTotal ? requested - cashAllocationTotal : 0n;
  const account = input.cashbookAccountId ? await db.cashbookAccount.findFirst({ where: { id: input.cashbookAccountId, tenantId } }) : null;
  if (!account || account.status !== "active") add("CASHBOOK_ACCOUNT_NOT_AVAILABLE", "An active tenant cashbook account is required.", 409);
  if (account && account.currency !== input.currency) add("SETTLEMENT_CURRENCY_MISMATCH", "Settlement and cashbook account currencies must match; FX conversion is unavailable.", 409);
  const payableIds = input.allocations.filter((row) => row.obligationType === "payable").map((row) => row.obligationId);
  const receivableIds = input.allocations.filter((row) => row.obligationType === "receivable").map((row) => row.obligationId);
  const [payables, receivables] = await Promise.all([
    db.payableObligation.findMany({ where: { tenantId, id: { in: payableIds } }, include: { supplierInvoice: true } }),
    db.receivableObligation.findMany({ where: { tenantId, id: { in: receivableIds } }, include: { customerInvoice: true } }),
  ]);
  if (payables.length !== new Set(payableIds).size || receivables.length !== new Set(receivableIds).size) add("SETTLEMENT_OBLIGATION_NOT_FOUND", "Every allocation requires a tenant-owned obligation.", 404);
  const obligations = new Map([
    ...payables.map((row) => [`payable:${row.id}`, { ...row, type: "payable", counterpartyId: row.supplierInvoice.supplierId, counterpartyName: row.supplierInvoice.supplierName }]),
    ...receivables.map((row) => [`receivable:${row.id}`, { ...row, type: "receivable", counterpartyId: row.customerInvoice.customerId, counterpartyName: row.customerInvoice.customerNameSnapshot }]),
  ]);
  const counterparties = new Set();
  for (const allocation of input.allocations) {
    const obligation = obligations.get(`${allocation.obligationType}:${allocation.obligationId}`);
    if (!obligation) continue;
    if (obligation.currency !== input.currency) add("SETTLEMENT_CURRENCY_MISMATCH", "All obligations must use the cashbook currency; FX conversion is unavailable.", 409);
    if (obligation.type === "payable" && !["approved", "export_ready", "partially_settled"].includes(obligation.status)) add("PAYABLE_NOT_SETTLEABLE", "Only approved, export-ready, or partially settled payables may be allocated.", 409, { obligationId: obligation.id, status: obligation.status });
    if (obligation.type === "receivable" && (obligation.disputeStatus !== "none" || !["open", "overdue", "partially_settled"].includes(obligation.status))) add("RECEIVABLE_NOT_SETTLEABLE", "Disputed or closed receivables may not be allocated.", 409, { obligationId: obligation.id, status: obligation.status, disputeStatus: obligation.disputeStatus });
    const allocated = (() => { try { return units(allocation.amount); } catch { return 0n; } })();
    if (allocated > units(obligation.outstandingAmount)) add("SETTLEMENT_OVER_ALLOCATION", "Allocation may not exceed the current outstanding amount.", 409, { obligationId: obligation.id, outstandingAmount: fixed(units(obligation.outstandingAmount)), requestedAmount: fixed(allocated) });
    if (obligation.counterpartyId) counterparties.add(obligation.counterpartyId);
    if (input.counterpartyId && obligation.counterpartyId && input.counterpartyId !== obligation.counterpartyId) add("SETTLEMENT_COUNTERPARTY_MISMATCH", "Every obligation must belong to the selected counterparty.", 409);
  }
  if (counterparties.size > 1) add("SETTLEMENT_COUNTERPARTY_MISMATCH", "One settlement cannot net multiple counterparties.", 409);
  const first = obligations.values().next().value;
  return {
    operation: "internal_settlement",
    allowed: issues.length === 0,
    blockingIssues: issues,
    account,
    obligations,
    normalized: { ...input, amount: requested ? fixed(requested) : "0.0000", cashAmount: fixed(requested), discountAmount: fixed(discountTotal), totalSettlementAmount: fixed(total), advanceCreatedAmount: fixed(advanceAmount), counterpartyId: input.counterpartyId || first?.counterpartyId || "", counterpartyNameSnapshot: first?.counterpartyName || "" },
    factsToCreate: { settlementDocuments: 1, settlementAllocations: input.allocations.length, cashbookEntries: 0, bankTransactions: 0, journalEntries: 0 },
    bankExecution: false,
    fxConverted: false,
    ledgerMutation: false,
  };
}

export function createInternalSettlementCommandService({ prisma, env = process.env, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error("prisma is required");

  const recordChange = (tx, actor, command, result) => tx.domainChangeFeed.create({ data: {
    tenantId: actor.tenantId, entityType: result.entityType, entityId: result.entityId,
    operation: "upsert", entityVersion: result.settlement?.version ?? result.account?.version ?? null,
    actorId: actor.user.id, source: "settlement_command", requestId: command.idempotencyKey,
    payloadHash: hash({ entityType: result.entityType, entityId: result.entityId, version: result.settlement?.version ?? null }),
    sensitivityGroups: result.entityType === "SettlementDocument" ? ["finance_amounts", "finance_partner_snapshot"] : ["finance_amounts"],
  } });

  async function execute(commandType, input, context, payload, work) {
    enabled(env);
    const signed = identity(context);
    const initialActor = await resolveProvisionedActor(prisma, signed);
    authorize(initialActor, commandPermissions[commandType]);
    const idempotencyKey = text(input.idempotencyKey);
    if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const requestHash = hash(payload);
    const where = whereExecution(signed.tenantId, commandType, idempotencyKey);
    const prior = replay(await prisma.businessCommandExecution.findUnique({ where }), requestHash);
    if (prior) return prior;
    try {
      return await prisma.$transaction(async (tx) => {
        const actor = await resolveProvisionedActor(tx, signed);
        authorize(actor, commandPermissions[commandType]);
        const inside = replay(await tx.businessCommandExecution.findUnique({ where }), requestHash);
        if (inside) return inside;
        const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey, requestHash, status: "pending" } });
        const result = await work(tx, actor, { commandType, idempotencyKey });
        await recordChange(tx, actor, { commandType, idempotencyKey }, result);
        await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", entityType: result.entityType, entityId: result.entityId, resultPayload: result, completedAt: now() } });
        return { ...result, idempotentReplay: false };
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof InternalSettlementError || error?.name === "AuthorizationError") throw error;
      if (error?.code === "P2002") fail("SETTLEMENT_UNIQUE_CONFLICT", "A governed settlement identifier or idempotency key already exists.", 409);
      if (concurrency(error)) fail("SETTLEMENT_CONCURRENCY_CONFLICT", "Settlement facts changed concurrently. Reload and retry.", 409);
      throw error;
    }
  }

  async function previewSettlement(input, context) {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    authorize(actor, "finance.settlement.create");
    return settlementPlan(prisma, actor.tenantId, normalizeSettlement(input));
  }

  async function createCashbookAccount(input, context) {
    const payload = { accountCode: text(input.accountCode).toUpperCase(), name: text(input.name), accountType: text(input.accountType).toLowerCase(), currency: text(input.currency).toUpperCase(), openingBalance: text(input.openingBalance || "0"), metadata: input.metadata || undefined };
    return execute("create_cashbook_account", input, context, payload, async (tx, actor, command) => {
      if (!payload.accountCode || !payload.name) fail("CASHBOOK_ACCOUNT_INVALID", "Account code and name are required.", 422);
      if (!["cash", "bank", "clearing"].includes(payload.accountType) || !/^[A-Z]{3}$/.test(payload.currency)) fail("CASHBOOK_ACCOUNT_INVALID", "Account type and ISO currency are invalid.", 422);
      const opening = amountUnits(payload.openingBalance, "Opening balance", { allowZero: true });
      const account = await tx.cashbookAccount.create({ data: { id: idFactory(), tenantId: actor.tenantId, ...payload, openingBalance: fixed(opening), currentBalance: fixed(opening) } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_settlement_command_service", module: "finance", action: "cashbook_account_created", entityType: "CashbookAccount", entityId: account.id, summary: `Created internal cashbook account ${account.accountCode}.`, metadata: { ...command, accountType: account.accountType, currency: account.currency, openingBalance: fixed(opening), bankConnection: false, ledgerMutation: false } } });
      return { entityType: "CashbookAccount", entityId: account.id, account: { id: account.id, accountCode: account.accountCode, name: account.name, accountType: account.accountType, currency: account.currency, openingBalance: fixed(opening), currentBalance: fixed(opening), status: account.status, version: account.version } };
    });
  }

  async function createSettlement(input, context) {
    const payload = normalizeSettlement(input);
    return execute("create_settlement", input, context, payload, async (tx, actor, command) => {
      const plan = await settlementPlan(tx, actor.tenantId, payload);
      if (!plan.allowed) { const issue = plan.blockingIssues[0]; fail(issue.code, issue.message, issue.status, issue.details); }
      const created = await tx.settlementDocument.create({ data: {
        id: idFactory(), tenantId: actor.tenantId, settlementNumber: plan.normalized.settlementNumber, direction: plan.normalized.direction, counterpartyType: plan.normalized.counterpartyType, counterpartyId: plan.normalized.counterpartyId || null, counterpartyNameSnapshot: plan.normalized.counterpartyNameSnapshot || null, cashbookAccountId: plan.normalized.cashbookAccountId, currency: plan.normalized.currency, amount: plan.normalized.amount, cashAmount: plan.normalized.cashAmount, discountAmount: plan.normalized.discountAmount, totalSettlementAmount: plan.normalized.totalSettlementAmount, advanceCreatedAmount: plan.normalized.advanceCreatedAmount, settlementDate: asDate(plan.normalized.settlementDate, "settlementDate"), clientMutationId: text(input.clientMutationId) || null, sourceDeviceId: text(input.sourceDeviceId) || null, lastWorkflowActionAt: now(), externalReference: plan.normalized.externalReference || null, memo: plan.normalized.memo || null, metadata: { createdById: actor.user.id, externalReferenceVerified: false, bankExecution: false, ledgerMutation: false },
      } });
      await tx.settlementAllocation.createMany({ data: plan.normalized.allocations.map((row) => ({ id: idFactory(), tenantId: actor.tenantId, settlementId: created.id, obligationType: row.obligationType, payableObligationId: row.obligationType === "payable" ? row.obligationId : null, receivableObligationId: row.obligationType === "receivable" ? row.obligationId : null, amount: fixed(units(row.amount)), cashAppliedAmount: fixed(units(row.cashAppliedAmount)), discountAmount: fixed(units(row.discountAmount)), totalSettlementAmount: fixed(units(row.amount)), discountReason: row.discountReason || null, discountApprovedById: units(row.discountAmount) > 0n && actor.permissionCodes?.has("finance.settlement_discount.apply") ? actor.user.id : null, currency: plan.normalized.currency })) });
      assertDiscountPolicy(actor, await settlementPolicy(tx, actor.tenantId), plan.normalized.discountAmount);
      const settlement = await tx.settlementDocument.findUnique({ where: { id: created.id }, include: { allocations: true } });
      await Promise.all(settlement.allocations.map((row) => tx.documentLink.create({ data: { id: idFactory(), tenantId: actor.tenantId, sourceType: "SettlementDocument", sourceId: settlement.id, targetType: row.obligationType === "payable" ? "PayableObligation" : "ReceivableObligation", targetId: row.payableObligationId || row.receivableObligationId, relationship: "allocates", status: "draft" } })));
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_settlement_command_service", module: "finance", action: "settlement_created", entityType: "SettlementDocument", entityId: settlement.id, summary: `Created internal ${settlement.direction} ${settlement.settlementNumber}.`, metadata: { ...command, amount: fixed(units(settlement.amount)), currency: settlement.currency, allocationIds: settlement.allocations.map((row) => row.id), externalReferenceVerified: false, bankExecution: false } } });
      return { entityType: "SettlementDocument", entityId: settlement.id, settlement: { id: settlement.id, settlementNumber: settlement.settlementNumber, direction: settlement.direction, status: settlement.status, currency: settlement.currency, amount: fixed(units(settlement.amount)), version: settlement.version } };
    });
  }

  async function reviseSettlement(settlementId, input, context) {
    const normalized = normalizeSettlement(input);
    const payload = { settlementId: text(settlementId), expectedVersion: expectedVersion(input.expectedVersion), ...normalized };
    return execute("revise_settlement", input, context, payload, async (tx, actor, command) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "SettlementDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, payload.settlementId);
      const current = await tx.settlementDocument.findFirst({ where: { id: payload.settlementId, tenantId: actor.tenantId } });
      if (!current) fail("SETTLEMENT_NOT_FOUND", "Settlement was not found.", 404);
      if (current.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Settlement changed concurrently. Reload and retry.", 409, { entityId: current.id, expectedVersion: payload.expectedVersion, currentVersion: current.version, conflictFields: ["version"], availableActions: ["reload"], serverTime: now().toISOString() });
      if (!["draft", "rejected"].includes(current.workflowStatus)) fail("SETTLEMENT_NOT_REVISABLE", "Only a draft or rejected settlement may be revised.", 409);
      const plan = await settlementPlan(tx, actor.tenantId, normalized);
      if (!plan.allowed) { const issue = plan.blockingIssues[0]; fail(issue.code, issue.message, issue.status, issue.details); }
      assertDiscountPolicy(actor, await settlementPolicy(tx, actor.tenantId), plan.normalized.discountAmount);
      await tx.settlementAllocation.deleteMany({ where: { tenantId: actor.tenantId, settlementId: current.id } });
      await tx.documentLink.deleteMany({ where: { tenantId: actor.tenantId, sourceType: "SettlementDocument", sourceId: current.id, status: "draft" } });
      await tx.settlementAllocation.createMany({ data: plan.normalized.allocations.map((row) => ({ id: idFactory(), tenantId: actor.tenantId, settlementId: current.id, obligationType: row.obligationType, payableObligationId: row.obligationType === "payable" ? row.obligationId : null, receivableObligationId: row.obligationType === "receivable" ? row.obligationId : null, amount: fixed(units(row.amount)), cashAppliedAmount: fixed(units(row.cashAppliedAmount)), discountAmount: fixed(units(row.discountAmount)), totalSettlementAmount: fixed(units(row.amount)), discountReason: row.discountReason || null, discountApprovedById: units(row.discountAmount) > 0n ? actor.user.id : null, currency: plan.normalized.currency })) });
      const revised = await tx.settlementDocument.update({ where: { id: current.id }, data: { settlementNumber: plan.normalized.settlementNumber, direction: plan.normalized.direction, counterpartyType: plan.normalized.counterpartyType, counterpartyId: plan.normalized.counterpartyId || null, counterpartyNameSnapshot: plan.normalized.counterpartyNameSnapshot || null, cashbookAccountId: plan.normalized.cashbookAccountId, currency: plan.normalized.currency, amount: plan.normalized.amount, cashAmount: plan.normalized.cashAmount, discountAmount: plan.normalized.discountAmount, totalSettlementAmount: plan.normalized.totalSettlementAmount, advanceCreatedAmount: plan.normalized.advanceCreatedAmount, settlementDate: asDate(plan.normalized.settlementDate, "settlementDate"), externalReference: plan.normalized.externalReference || null, memo: plan.normalized.memo || null, workflowStatus: "draft", status: "draft", rejectedById: null, rejectedAt: null, rejectionReason: null, lastWorkflowActionAt: now(), clientMutationId: text(input.clientMutationId) || current.clientMutationId, sourceDeviceId: text(input.sourceDeviceId) || current.sourceDeviceId, version: { increment: 1 } } });
      const allocations = await tx.settlementAllocation.findMany({ where: { tenantId: actor.tenantId, settlementId: current.id } });
      await Promise.all(allocations.map((row) => tx.documentLink.create({ data: { id: idFactory(), tenantId: actor.tenantId, sourceType: "SettlementDocument", sourceId: current.id, targetType: row.obligationType === "payable" ? "PayableObligation" : "ReceivableObligation", targetId: row.payableObligationId || row.receivableObligationId, relationship: "allocates", status: "draft" } })));
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_settlement_command_service", module: "finance", action: "settlement_revised", entityType: "SettlementDocument", entityId: current.id, summary: `Revised settlement ${current.settlementNumber}.`, metadata: command } });
      return { entityType: "SettlementDocument", entityId: revised.id, settlement: { id: revised.id, settlementNumber: revised.settlementNumber, status: revised.status, workflowStatus: revised.workflowStatus, postingStatus: revised.postingStatus, version: revised.version } };
    });
  }

  async function workflowAction(settlementId, input, context, action) {
    const commandType = `${action}_settlement`;
    const payload = { settlementId: text(settlementId), expectedVersion: expectedVersion(input.expectedVersion), reason: text(input.reason) };
    return execute(commandType, input, context, payload, async (tx, actor, command) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "SettlementDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, payload.settlementId);
      const current = await tx.settlementDocument.findFirst({ where: { id: payload.settlementId, tenantId: actor.tenantId } });
      if (!current) fail("SETTLEMENT_NOT_FOUND", "Settlement was not found.", 404);
      if (current.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Settlement changed concurrently. Reload and retry.", 409, { entityId: current.id, expectedVersion: payload.expectedVersion, currentVersion: current.version, conflictFields: ["workflowStatus"], availableActions: ["reload"], serverTime: now().toISOString() });
      const rules = { submit: ["draft"], approve: ["submitted"], reject: ["submitted"], cancel: ["draft", "submitted"] };
      if (!rules[action]?.includes(current.workflowStatus)) fail("SETTLEMENT_WORKFLOW_CONFLICT", `Settlement cannot be ${action}ed from ${current.workflowStatus}.`, 409);
      if (["reject", "cancel"].includes(action) && !payload.reason) fail("SETTLEMENT_REASON_REQUIRED", `A reason is required to ${action} a settlement.`, 422);
      if (action === "approve") {
        const policy = await settlementPolicy(tx, actor.tenantId);
        if (current.metadata?.createdById === actor.user.id && policy.settlementSelfApprovalAllowed !== true) fail("SETTLEMENT_SELF_APPROVAL_BLOCKED", "The settlement creator may not approve this settlement.", 409);
      }
      const at = now();
      const next = action === "submit" ? "submitted" : action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled";
      const data = { workflowStatus: next, lastWorkflowActionAt: at, version: { increment: 1 } };
      if (action === "submit") Object.assign(data, { submittedById: actor.user.id, submittedAt: at });
      if (action === "approve") Object.assign(data, { approvedById: actor.user.id, approvedAt: at });
      if (action === "reject") Object.assign(data, { rejectedById: actor.user.id, rejectedAt: at, rejectionReason: payload.reason });
      if (action === "cancel") Object.assign(data, { status: "cancelled", cancelledById: actor.user.id, cancelledAt: at, cancellationReason: payload.reason });
      const updated = await tx.settlementDocument.update({ where: { id: current.id }, data });
      await tx.documentLink.updateMany({ where: { tenantId: actor.tenantId, sourceType: "SettlementDocument", sourceId: current.id }, data: { status: next } });
      const auditAction = { submit: "settlement_submitted", approve: "settlement_approved", reject: "settlement_rejected", cancel: "settlement_cancelled" }[action];
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_settlement_command_service", module: "finance", action: auditAction, entityType: "SettlementDocument", entityId: current.id, summary: `${action} settlement ${current.settlementNumber}.`, metadata: { ...command, reason: payload.reason || undefined } } });
      return { entityType: "SettlementDocument", entityId: updated.id, settlement: { id: updated.id, settlementNumber: updated.settlementNumber, status: updated.status, workflowStatus: updated.workflowStatus, postingStatus: updated.postingStatus, version: updated.version } };
    });
  }

  const submitSettlement = (id, input, context) => workflowAction(id, input, context, "submit");
  const approveSettlement = (id, input, context) => workflowAction(id, input, context, "approve");
  const rejectSettlement = (id, input, context) => workflowAction(id, input, context, "reject");
  const cancelSettlement = (id, input, context) => workflowAction(id, input, context, "cancel");
  const previewSettlementPosting = async (settlementId, context) => {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    authorize(actor, "finance.settlement.post");
    const settlement = await prisma.settlementDocument.findFirst({ where: { id: text(settlementId), tenantId: actor.tenantId }, include: { allocations: true } });
    if (!settlement) fail("SETTLEMENT_NOT_FOUND", "Settlement was not found.", 404);
    const planInput = normalizeSettlement({ ...settlement, amount: fixed(units(settlement.amount)), settlementDate: settlement.settlementDate.toISOString(), allocations: settlement.allocations.map((row) => ({ obligationType: row.obligationType, obligationId: row.payableObligationId || row.receivableObligationId, cashAppliedAmount: fixed(units(row.cashAppliedAmount)), discountAmount: fixed(units(row.discountAmount)), totalSettlementAmount: fixed(units(row.totalSettlementAmount)), discountReason: row.discountReason })) });
    const policy = await settlementPolicy(prisma, actor.tenantId);
    const approvalRequired = policy.settlementApprovalRequired !== false || units(settlement.totalSettlementAmount) > thresholdUnits(policy.settlementApprovalThreshold);
    const postingAllowed = workflowEnabled(env) ? (approvalRequired ? settlement.workflowStatus === "approved" : ["draft", "approved"].includes(settlement.workflowStatus)) : ["draft", "approved"].includes(settlement.workflowStatus);
    return { ...(await settlementPlan(prisma, actor.tenantId, planInput)), workflowStatus: settlement.workflowStatus, postingAllowed, approvalRequired };
  };

  async function postSettlement(settlementId, input, context) {
    const payload = { settlementId: text(settlementId), expectedVersion: expectedVersion(input.expectedVersion) };
    return execute("post_settlement", input, context, payload, async (tx, actor, command) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "SettlementDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, payload.settlementId);
      const settlement = await tx.settlementDocument.findFirst({ where: { id: payload.settlementId, tenantId: actor.tenantId }, include: { allocations: true } });
      if (!settlement) fail("SETTLEMENT_NOT_FOUND", "Settlement was not found.", 404);
      if (settlement.version !== payload.expectedVersion) fail("SETTLEMENT_VERSION_CONFLICT", "Settlement changed concurrently. Reload and retry.", 409);
      const policy = await settlementPolicy(tx, actor.tenantId);
      const approvalRequired = policy.settlementApprovalRequired !== false || units(settlement.totalSettlementAmount) > thresholdUnits(policy.settlementApprovalThreshold);
      const postable = workflowEnabled(env) ? (approvalRequired ? settlement.workflowStatus === "approved" : ["draft", "approved"].includes(settlement.workflowStatus)) : settlement.status === "draft" && ["draft", "approved"].includes(settlement.workflowStatus);
      if (!postable) fail("SETTLEMENT_NOT_POSTABLE", workflowEnabled(env) ? "Only an approved settlement may be posted." : "Only a draft settlement may be posted.", 409);
      if (settlement.metadata?.createdById === actor.user.id && policy.settlementSelfPostingAllowed === false) fail("SETTLEMENT_SELF_POSTING_BLOCKED", "The settlement creator may not post this settlement.", 409);
      await tx.$queryRawUnsafe('SELECT "id" FROM "CashbookAccount" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, settlement.cashbookAccountId);
      for (const row of [...settlement.allocations].sort((a, b) => (a.payableObligationId || a.receivableObligationId).localeCompare(b.payableObligationId || b.receivableObligationId))) {
        const table = row.obligationType === "payable" ? "PayableObligation" : "ReceivableObligation";
        await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`, actor.tenantId, row.payableObligationId || row.receivableObligationId);
      }
      const planInput = normalizeSettlement({ ...settlement, amount: fixed(units(settlement.amount)), settlementDate: settlement.settlementDate.toISOString(), allocations: settlement.allocations.map((row) => ({ obligationType: row.obligationType, obligationId: row.payableObligationId || row.receivableObligationId, cashAppliedAmount: fixed(units(row.cashAppliedAmount)), discountAmount: fixed(units(row.discountAmount)), totalSettlementAmount: fixed(units(row.totalSettlementAmount)), discountReason: row.discountReason })) });
      const plan = await settlementPlan(tx, actor.tenantId, planInput);
      if (!plan.allowed) { const issue = plan.blockingIssues[0]; fail(issue.code, issue.message, issue.status, issue.details); }
      const account = plan.account;
      const amount = units(settlement.amount);
      const before = units(account.currentBalance);
      const after = settlement.direction === "receipt" ? before + amount : before - amount;
      if (after < 0n) fail("CASHBOOK_INSUFFICIENT_BALANCE", "The internal cashbook account cannot become negative.", 409, { currentBalance: fixed(before), settlementAmount: fixed(amount) });
      for (const allocation of settlement.allocations) {
        const obligation = plan.obligations.get(`${allocation.obligationType}:${allocation.payableObligationId || allocation.receivableObligationId}`);
        const next = units(obligation.outstandingAmount) - units(allocation.amount);
        const status = next === 0n ? "settled" : "partially_settled";
        const model = allocation.obligationType === "payable" ? tx.payableObligation : tx.receivableObligation;
        await model.update({ where: { id: obligation.id }, data: { outstandingAmount: fixed(next), status, version: { increment: 1 } } });
        await tx.settlementAllocation.update({ where: { id: allocation.id }, data: { metadata: { beforeOutstandingAmount: fixed(units(obligation.outstandingAmount)), afterOutstandingAmount: fixed(next), beforeStatus: obligation.status, afterStatus: status } } });
      }
      let advance = null;
      if (units(settlement.advanceCreatedAmount) > 0n) advance = await tx.partnerAdvance.create({ data: { id: idFactory(), tenantId: actor.tenantId, advanceNumber: `ADV-${settlement.settlementNumber}`, advanceType: settlement.direction === "disbursement" ? "supplier_advance" : "customer_advance", supplierId: settlement.direction === "disbursement" ? settlement.counterpartyId : null, customerId: settlement.direction === "receipt" ? settlement.counterpartyId : null, currency: settlement.currency, originalAmount: settlement.advanceCreatedAmount, remainingAmount: settlement.advanceCreatedAmount, sourceSettlementId: settlement.id, createdById: actor.user.id } });
      await tx.cashbookAccount.update({ where: { id: account.id }, data: { currentBalance: fixed(after), version: { increment: 1 } } });
      const entry = await tx.cashbookEntry.create({ data: { id: idFactory(), tenantId: actor.tenantId, cashbookAccountId: account.id, settlementId: settlement.id, entryNumber: `CB-${settlement.settlementNumber}`, entryType: "settlement", direction: settlement.direction === "receipt" ? "inflow" : "outflow", amount: fixed(amount), currency: settlement.currency, occurredAt: settlement.settlementDate, balanceBefore: fixed(before), balanceAfter: fixed(after), postingBatchId: idFactory(), actorId: actor.user.id, metadata: { externalReference: settlement.externalReference, externalReferenceVerified: false, bankExecution: false, ledgerMutation: false } } });
      const posted = await tx.settlementDocument.update({ where: { id: settlement.id }, data: { status: "posted", workflowStatus: "posted", postingStatus: "posted", postedAt: now(), postedById: actor.user.id, lastWorkflowActionAt: now(), version: { increment: 1 } } });
      await tx.documentLink.updateMany({ where: { tenantId: actor.tenantId, sourceType: "SettlementDocument", sourceId: settlement.id }, data: { status: "posted" } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_settlement_command_service", module: "finance", action: "settlement_posted", entityType: "SettlementDocument", entityId: settlement.id, summary: `Posted internal ${settlement.direction} ${settlement.settlementNumber}.`, metadata: { ...command, cashbookEntryId: entry.id, postingBatchId: entry.postingBatchId, balanceBefore: fixed(before), balanceAfter: fixed(after), amount: fixed(amount), currency: settlement.currency, bankExecution: false, ledgerMutation: false } } });
      return { entityType: "SettlementDocument", entityId: settlement.id, settlement: { id: posted.id, settlementNumber: posted.settlementNumber, status: posted.status, workflowStatus: posted.workflowStatus, postingStatus: posted.postingStatus, version: posted.version }, cashbookEntry: { id: entry.id, entryNumber: entry.entryNumber, direction: entry.direction, amount: fixed(amount), currency: entry.currency, balanceBefore: fixed(before), balanceAfter: fixed(after) }, partnerAdvance: advance ? { id: advance.id, advanceNumber: advance.advanceNumber, advanceType: advance.advanceType, remainingAmount: fixed(units(advance.remainingAmount)) } : null };
    });
  }

  async function reverseSettlement(settlementId, input, context) {
    const payload = { settlementId: text(settlementId), expectedVersion: expectedVersion(input.expectedVersion), reason: text(input.reason) };
    return execute("reverse_settlement", input, context, payload, async (tx, actor, command) => {
      if (!payload.reason) fail("SETTLEMENT_REVERSAL_REASON_REQUIRED", "A reversal reason is required.", 422);
      await tx.$queryRawUnsafe('SELECT "id" FROM "SettlementDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, payload.settlementId);
      const settlement = await tx.settlementDocument.findFirst({ where: { id: payload.settlementId, tenantId: actor.tenantId }, include: { allocations: true, cashbookEntries: true } });
      if (!settlement) fail("SETTLEMENT_NOT_FOUND", "Settlement was not found.", 404);
      if (settlement.version !== payload.expectedVersion) fail("SETTLEMENT_VERSION_CONFLICT", "Settlement changed concurrently. Reload and retry.", 409);
      if (settlement.status !== "posted") fail("SETTLEMENT_NOT_REVERSIBLE", "Only a posted, unreversed settlement may be reversed.", 409);
      const advance = await tx.partnerAdvance.findFirst({ where: { tenantId: actor.tenantId, sourceSettlementId: settlement.id } });
      if (advance && units(advance.appliedAmount) !== 0n) fail("SETTLEMENT_REVERSAL_NOT_SAFE", "An applied advance must be reversed before its source settlement.", 409);
      const original = settlement.cashbookEntries.find((row) => row.entryType === "settlement");
      if (!original || original.reversedByEntryId) fail("SETTLEMENT_EVIDENCE_MISMATCH", "The original cashbook evidence is missing or already reversed.", 409);
      await tx.$queryRawUnsafe('SELECT "id" FROM "CashbookAccount" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, settlement.cashbookAccountId);
      const account = await tx.cashbookAccount.findFirst({ where: { id: settlement.cashbookAccountId, tenantId: actor.tenantId } });
      const amount = units(settlement.amount);
      const before = units(account.currentBalance);
      const after = settlement.direction === "receipt" ? before - amount : before + amount;
      if (after < 0n) fail("SETTLEMENT_REVERSAL_NOT_SAFE", "Reversal would make the internal cashbook negative.", 409);
      for (const allocation of [...settlement.allocations].sort((a, b) => (a.payableObligationId || a.receivableObligationId).localeCompare(b.payableObligationId || b.receivableObligationId))) {
        const table = allocation.obligationType === "payable" ? "PayableObligation" : "ReceivableObligation";
        const id = allocation.payableObligationId || allocation.receivableObligationId;
        await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`, actor.tenantId, id);
        const model = allocation.obligationType === "payable" ? tx.payableObligation : tx.receivableObligation;
        const obligation = await model.findFirst({ where: { id, tenantId: actor.tenantId } });
        const maximum = units(obligation.originalAmount) - units(obligation.approvedCreditAmount || 0);
        const restored = units(obligation.outstandingAmount) + units(allocation.amount);
        if (restored > maximum) fail("SETTLEMENT_REVERSAL_NOT_SAFE", "Obligation facts changed and cannot be restored safely.", 409, { obligationId: id });
        const status = restored === maximum ? (allocation.obligationType === "payable" ? "approved" : "open") : restored === 0n ? "settled" : "partially_settled";
        await model.update({ where: { id }, data: { outstandingAmount: fixed(restored), status, version: { increment: 1 } } });
      }
      await tx.cashbookAccount.update({ where: { id: account.id }, data: { currentBalance: fixed(after), version: { increment: 1 } } });
      const reversalId = idFactory();
      const reversal = await tx.cashbookEntry.create({ data: { id: reversalId, tenantId: actor.tenantId, cashbookAccountId: account.id, settlementId: settlement.id, entryNumber: `${original.entryNumber}-R`, entryType: "reversal", direction: original.direction === "inflow" ? "outflow" : "inflow", amount: fixed(amount), currency: original.currency, occurredAt: now(), balanceBefore: fixed(before), balanceAfter: fixed(after), postingBatchId: idFactory(), reversalOfEntryId: original.id, actorId: actor.user.id, metadata: { reason: payload.reason, exactInverse: true, bankExecution: false, ledgerMutation: false } } });
      await tx.cashbookEntry.update({ where: { id: original.id }, data: { reversedByEntryId: reversal.id } });
      if (advance) await tx.partnerAdvance.update({ where: { id: advance.id }, data: { status: "reversed", reversedAt: now(), version: { increment: 1 } } });
      const reversed = await tx.settlementDocument.update({ where: { id: settlement.id }, data: { status: "reversed", workflowStatus: "reversed", postingStatus: "reversed", reversedAt: now(), reversedById: actor.user.id, reversalReason: payload.reason, lastWorkflowActionAt: now(), version: { increment: 1 } } });
      await tx.documentLink.updateMany({ where: { tenantId: actor.tenantId, sourceType: "SettlementDocument", sourceId: settlement.id }, data: { status: "reversed" } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_settlement_command_service", module: "finance", action: "settlement_reversed", entityType: "SettlementDocument", entityId: settlement.id, summary: `Reversed internal settlement ${settlement.settlementNumber}.`, metadata: { ...command, originalCashbookEntryId: original.id, reversalCashbookEntryId: reversal.id, balanceBefore: fixed(before), balanceAfter: fixed(after), amount: fixed(amount), exactInverse: true, bankExecution: false, ledgerMutation: false } } });
      return { entityType: "SettlementDocument", entityId: settlement.id, settlement: { id: reversed.id, settlementNumber: reversed.settlementNumber, status: reversed.status, version: reversed.version }, cashbookEntry: { id: reversal.id, entryNumber: reversal.entryNumber, direction: reversal.direction, amount: fixed(amount), currency: reversal.currency, balanceBefore: fixed(before), balanceAfter: fixed(after), reversalOfEntryId: original.id } };
    });
  }

  return { previewSettlement, previewSettlementPosting, createCashbookAccount, createSettlement, reviseSettlement, submitSettlement, approveSettlement, rejectSettlement, cancelSettlement, postSettlement, reverseSettlement };
}
