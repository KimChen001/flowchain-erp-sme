import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";
import { InternalSettlementError } from "./internal-settlement-command-service.mjs";

const fail = (code, message, status = 400, details) => { throw new InternalSettlementError(code, message, status, details); };
const text = (value) => String(value ?? "").trim();
const hash = (value) => createHash("sha256").update(JSON.stringify(value, Object.keys(value).sort())).digest("hex");
const expectedVersion = (value) => { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) fail("TRANSFER_VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422); return parsed; };
const date = (value) => { const parsed = new Date(value); if (!text(value) || Number.isNaN(parsed.getTime())) fail("TRANSFER_DATE_INVALID", "transferDate must be a valid date.", 422); return parsed; };
const replay = (row, requestHash) => {
  if (!row) return null;
  if (row.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with a different payload.", 409);
  if (row.status !== "completed" || !row.resultPayload) fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is already in progress.", 409);
  return { ...row.resultPayload, idempotentReplay: true };
};
const permissions = {
  create_internal_transfer: "finance.internal_transfer.create", revise_internal_transfer: "finance.internal_transfer.create",
  submit_internal_transfer: "finance.internal_transfer.submit", approve_internal_transfer: "finance.internal_transfer.approve",
  reject_internal_transfer: "finance.internal_transfer.approve", cancel_internal_transfer: "finance.internal_transfer.create",
  post_internal_transfer: "finance.internal_transfer.post", reverse_internal_transfer: "finance.internal_transfer.reverse",
};

export function createInternalTransferCommandService({ prisma, env = process.env, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const enabled = () => {
    if (text(env.FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW).toLowerCase() !== "true") fail("SETTLEMENT_WORKFLOW_CAPABILITY_NOT_AVAILABLE", "Internal transfers require the settlement workflow capability.", 409);
  };
  const actorFor = async (db, context, permission) => {
    const actor = await resolveProvisionedActor(db, context?.identity || context);
    assertAuthorized({ actor, permission, tenantId: actor.tenantId });
    assertAuthorized({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId });
    return actor;
  };
  async function execute(type, input, context, payload, work) {
    enabled();
    const initial = await actorFor(prisma, context, permissions[type]);
    const key = text(input.idempotencyKey);
    if (!key) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const requestHash = hash({ ...payload, key });
    const where = { tenantId_commandType_idempotencyKey: { tenantId: initial.tenantId, commandType: type, idempotencyKey: key } };
    const prior = replay(await prisma.businessCommandExecution.findUnique({ where }), requestHash);
    if (prior) return prior;
    return prisma.$transaction(async (tx) => {
      const actor = await actorFor(tx, context, permissions[type]);
      const inside = replay(await tx.businessCommandExecution.findUnique({ where }), requestHash);
      if (inside) return inside;
      const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType: type, idempotencyKey: key, requestHash, status: "pending" } });
      const result = await work(tx, actor, { commandType: type, idempotencyKey: key });
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "InternalTransferDocument", entityId: result.entityId, operation: "upsert", entityVersion: result.transfer.version, actorId: actor.user.id, source: "internal_transfer_command", requestId: key, payloadHash: hash({ id: result.entityId, version: result.transfer.version }), sensitivityGroups: ["finance_amounts"] } });
      await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", entityType: "InternalTransferDocument", entityId: result.entityId, resultPayload: result, completedAt: now() } });
      return { ...result, idempotentReplay: false };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  }
  const normalize = (input) => ({ transferNumber: text(input.transferNumber), fromCashbookAccountId: text(input.fromCashbookAccountId), toCashbookAccountId: text(input.toCashbookAccountId), currency: text(input.currency).toUpperCase(), amount: text(input.amount), transferDate: text(input.transferDate), externalReference: text(input.externalReference), memo: text(input.memo), clientMutationId: text(input.clientMutationId), sourceDeviceId: text(input.sourceDeviceId) });
  async function validate(db, tenantId, value) {
    if (!value.transferNumber || !value.fromCashbookAccountId || !value.toCashbookAccountId) fail("TRANSFER_REQUIRED_FIELDS", "Transfer number and both accounts are required.", 422);
    if (value.fromCashbookAccountId === value.toCashbookAccountId) fail("TRANSFER_SAME_ACCOUNT", "Transfer accounts must be different.", 422);
    let amount; try { amount = units(value.amount); } catch { fail("TRANSFER_AMOUNT_INVALID", "Transfer amount must be valid.", 422); }
    if (amount <= 0n) fail("TRANSFER_AMOUNT_INVALID", "Transfer amount must be positive.", 422);
    const accounts = await db.cashbookAccount.findMany({ where: { tenantId, id: { in: [value.fromCashbookAccountId, value.toCashbookAccountId] }, status: "active" } });
    if (accounts.length !== 2) fail("TRANSFER_ACCOUNT_NOT_AVAILABLE", "Both tenant-owned active accounts are required.", 404);
    if (accounts.some((account) => account.currency !== value.currency)) fail("TRANSFER_CURRENCY_MISMATCH", "Both accounts and the transfer must use one currency; FX is unavailable.", 409);
    return { amount, accounts: new Map(accounts.map((account) => [account.id, account])) };
  }
  async function previewInternalTransferPosting(input, context) {
    enabled(); const actor = await actorFor(prisma, context, "finance.internal_transfer.post"); const value = normalize(input); const plan = await validate(prisma, actor.tenantId, value);
    return { allowed: true, transfer: value, amount: fixed(plan.amount), cashbookEntries: [{ accountId: value.fromCashbookAccountId, direction: "outflow" }, { accountId: value.toCashbookAccountId, direction: "inflow" }], postingBatchCount: 1, fxConverted: false, bankExecution: false };
  }
  async function createInternalTransfer(input, context) {
    const value = normalize(input);
    return execute("create_internal_transfer", input, context, value, async (tx, actor, command) => {
      const plan = await validate(tx, actor.tenantId, value);
      const row = await tx.internalTransferDocument.create({ data: { id: idFactory(), tenantId: actor.tenantId, ...value, amount: fixed(plan.amount), transferDate: date(value.transferDate), externalReference: value.externalReference || null, memo: value.memo || null, clientMutationId: value.clientMutationId || null, sourceDeviceId: value.sourceDeviceId || null, metadata: { createdById: actor.user.id } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_transfer_command_service", module: "finance", action: "internal_transfer_created", entityType: "InternalTransferDocument", entityId: row.id, summary: `Created internal transfer ${row.transferNumber}.`, metadata: command } });
      return { entityId: row.id, transfer: { id: row.id, transferNumber: row.transferNumber, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, version: row.version } };
    });
  }
  async function reviseInternalTransfer(id, input, context) {
    const value = normalize(input); const payload = { id: text(id), expectedVersion: expectedVersion(input.expectedVersion), ...value };
    return execute("revise_internal_transfer", input, context, payload, async (tx, actor) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "InternalTransferDocument" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.id);
      const current = await tx.internalTransferDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId } });
      if (!current) fail("TRANSFER_NOT_FOUND", "Internal transfer was not found.", 404);
      if (current.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Internal transfer changed concurrently.", 409, { entityId: current.id, expectedVersion: payload.expectedVersion, currentVersion: current.version });
      if (!["draft", "rejected"].includes(current.workflowStatus)) fail("TRANSFER_NOT_REVISABLE", "Only draft or rejected transfers may be revised.", 409);
      const plan = await validate(tx, actor.tenantId, value);
      const row = await tx.internalTransferDocument.update({ where: { id: current.id }, data: { ...value, amount: fixed(plan.amount), transferDate: date(value.transferDate), externalReference: value.externalReference || null, memo: value.memo || null, workflowStatus: "draft", rejectedById: null, rejectedAt: null, rejectionReason: null, version: { increment: 1 } } });
      return { entityId: row.id, transfer: { id: row.id, transferNumber: row.transferNumber, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, version: row.version } };
    });
  }
  async function action(id, input, context, name) {
    const payload = { id: text(id), expectedVersion: expectedVersion(input.expectedVersion), reason: text(input.reason) };
    return execute(`${name}_internal_transfer`, input, context, payload, async (tx, actor, command) => {
      const current = await tx.internalTransferDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId } });
      if (!current) fail("TRANSFER_NOT_FOUND", "Internal transfer was not found.", 404);
      if (current.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Internal transfer changed concurrently.", 409, { entityId: current.id, expectedVersion: payload.expectedVersion, currentVersion: current.version });
      const allowed = { submit: ["draft"], approve: ["submitted"], reject: ["submitted"], cancel: ["draft", "submitted"] }[name];
      if (!allowed.includes(current.workflowStatus)) fail("TRANSFER_WORKFLOW_CONFLICT", `Transfer cannot be ${name}ed from ${current.workflowStatus}.`, 409);
      if (["reject", "cancel"].includes(name) && !payload.reason) fail("TRANSFER_REASON_REQUIRED", "A reason is required.", 422);
      if (name === "approve" && current.metadata?.createdById === actor.user.id) fail("TRANSFER_SELF_APPROVAL_BLOCKED", "The transfer creator may not approve this transfer.", 409);
      const at = now(); const next = { submit: "submitted", approve: "approved", reject: "rejected", cancel: "cancelled" }[name];
      const data = { workflowStatus: next, version: { increment: 1 } };
      if (name === "submit") Object.assign(data, { submittedById: actor.user.id, submittedAt: at });
      if (name === "approve") Object.assign(data, { approvedById: actor.user.id, approvedAt: at });
      if (name === "reject") Object.assign(data, { rejectedById: actor.user.id, rejectedAt: at, rejectionReason: payload.reason });
      if (name === "cancel") Object.assign(data, { cancelledById: actor.user.id, cancelledAt: at, cancellationReason: payload.reason });
      const row = await tx.internalTransferDocument.update({ where: { id: current.id }, data });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_transfer_command_service", module: "finance", action: `internal_transfer_${next}`, entityType: "InternalTransferDocument", entityId: row.id, summary: `${name} internal transfer ${row.transferNumber}.`, metadata: command } });
      return { entityId: row.id, transfer: { id: row.id, transferNumber: row.transferNumber, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, version: row.version } };
    });
  }
  async function postInternalTransfer(id, input, context) {
    const payload = { id: text(id), expectedVersion: expectedVersion(input.expectedVersion) };
    return execute("post_internal_transfer", input, context, payload, async (tx, actor, command) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "InternalTransferDocument" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.id);
      const row = await tx.internalTransferDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId } });
      if (!row) fail("TRANSFER_NOT_FOUND", "Internal transfer was not found.", 404);
      if (row.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Internal transfer changed concurrently.", 409, { entityId: row.id, expectedVersion: payload.expectedVersion, currentVersion: row.version });
      if (row.workflowStatus !== "approved" || row.postingStatus !== "unposted") fail("TRANSFER_NOT_POSTABLE", "Only an approved unposted transfer may be posted.", 409);
      const ids = [row.fromCashbookAccountId, row.toCashbookAccountId].sort();
      for (const accountId of ids) await tx.$queryRawUnsafe('SELECT "id" FROM "CashbookAccount" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, accountId);
      const plan = await validate(tx, actor.tenantId, { ...row, amount: fixed(units(row.amount)), transferDate: row.transferDate.toISOString() });
      const from = plan.accounts.get(row.fromCashbookAccountId), to = plan.accounts.get(row.toCashbookAccountId), amount = plan.amount;
      const fromBefore = units(from.currentBalance), toBefore = units(to.currentBalance);
      if (fromBefore < amount) fail("CASHBOOK_INSUFFICIENT_BALANCE", "The source cashbook account cannot become negative.", 409);
      const batch = idFactory();
      const [outEntry, inEntry] = await Promise.all([
        tx.cashbookEntry.create({ data: { id: idFactory(), tenantId: actor.tenantId, cashbookAccountId: from.id, internalTransferId: row.id, entryNumber: `CB-${row.transferNumber}-OUT`, entryType: "transfer_out", direction: "outflow", amount: fixed(amount), currency: row.currency, occurredAt: row.transferDate, balanceBefore: fixed(fromBefore), balanceAfter: fixed(fromBefore - amount), postingBatchId: batch, actorId: actor.user.id, metadata: { bankExecution: false, exactPair: true } } }),
        tx.cashbookEntry.create({ data: { id: idFactory(), tenantId: actor.tenantId, cashbookAccountId: to.id, internalTransferId: row.id, entryNumber: `CB-${row.transferNumber}-IN`, entryType: "transfer_in", direction: "inflow", amount: fixed(amount), currency: row.currency, occurredAt: row.transferDate, balanceBefore: fixed(toBefore), balanceAfter: fixed(toBefore + amount), postingBatchId: batch, actorId: actor.user.id, metadata: { bankExecution: false, exactPair: true } } }),
      ]);
      await Promise.all([tx.cashbookAccount.update({ where: { id: from.id }, data: { currentBalance: fixed(fromBefore - amount), version: { increment: 1 } } }), tx.cashbookAccount.update({ where: { id: to.id }, data: { currentBalance: fixed(toBefore + amount), version: { increment: 1 } } })]);
      const posted = await tx.internalTransferDocument.update({ where: { id: row.id }, data: { workflowStatus: "posted", postingStatus: "posted", postedById: actor.user.id, postedAt: now(), version: { increment: 1 } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_transfer_command_service", module: "finance", action: "internal_transfer_posted", entityType: "InternalTransferDocument", entityId: row.id, summary: `Posted internal transfer ${row.transferNumber}.`, metadata: { ...command, postingBatchId: batch, entryIds: [outEntry.id, inEntry.id] } } });
      return { entityId: row.id, transfer: { id: row.id, transferNumber: row.transferNumber, workflowStatus: posted.workflowStatus, postingStatus: posted.postingStatus, version: posted.version }, postingBatchId: batch, cashbookEntryIds: [outEntry.id, inEntry.id] };
    });
  }
  async function reverseInternalTransfer(id, input, context) {
    const payload = { id: text(id), expectedVersion: expectedVersion(input.expectedVersion), reason: text(input.reason) };
    return execute("reverse_internal_transfer", input, context, payload, async (tx, actor, command) => {
      if (!payload.reason) fail("TRANSFER_REVERSAL_REASON_REQUIRED", "A reversal reason is required.", 422);
      await tx.$queryRawUnsafe('SELECT "id" FROM "InternalTransferDocument" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.id);
      const row = await tx.internalTransferDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId }, include: { entries: true } });
      if (!row) fail("TRANSFER_NOT_FOUND", "Internal transfer was not found.", 404);
      if (row.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Internal transfer changed concurrently.", 409, { entityId: row.id, expectedVersion: payload.expectedVersion, currentVersion: row.version });
      if (row.postingStatus !== "posted") fail("TRANSFER_NOT_REVERSIBLE", "Only a posted transfer may be reversed.", 409);
      const ids = [row.fromCashbookAccountId, row.toCashbookAccountId].sort();
      for (const accountId of ids) await tx.$queryRawUnsafe('SELECT "id" FROM "CashbookAccount" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, accountId);
      const accounts = new Map((await tx.cashbookAccount.findMany({ where: { tenantId: actor.tenantId, id: { in: ids } } })).map((account) => [account.id, account]));
      const originalOut = row.entries.find((entry) => entry.entryType === "transfer_out"), originalIn = row.entries.find((entry) => entry.entryType === "transfer_in");
      if (!originalOut || !originalIn || originalOut.reversedByEntryId || originalIn.reversedByEntryId) fail("TRANSFER_EVIDENCE_MISMATCH", "The original transfer pair is missing or reversed.", 409);
      const amount = units(row.amount), from = accounts.get(row.fromCashbookAccountId), to = accounts.get(row.toCashbookAccountId);
      const fromBefore = units(from.currentBalance), toBefore = units(to.currentBalance);
      if (toBefore < amount) fail("TRANSFER_REVERSAL_NOT_SAFE", "The destination account cannot fund the exact reversal.", 409);
      const batch = idFactory();
      const reverseOut = await tx.cashbookEntry.create({ data: { id: idFactory(), tenantId: actor.tenantId, cashbookAccountId: from.id, internalTransferId: row.id, entryNumber: `${originalOut.entryNumber}-R`, entryType: "transfer_reversal_out", direction: "inflow", amount: fixed(amount), currency: row.currency, occurredAt: now(), balanceBefore: fixed(fromBefore), balanceAfter: fixed(fromBefore + amount), postingBatchId: batch, reversalOfEntryId: originalOut.id, actorId: actor.user.id, metadata: { reason: payload.reason, exactInverse: true } } });
      const reverseIn = await tx.cashbookEntry.create({ data: { id: idFactory(), tenantId: actor.tenantId, cashbookAccountId: to.id, internalTransferId: row.id, entryNumber: `${originalIn.entryNumber}-R`, entryType: "transfer_reversal_in", direction: "outflow", amount: fixed(amount), currency: row.currency, occurredAt: now(), balanceBefore: fixed(toBefore), balanceAfter: fixed(toBefore - amount), postingBatchId: batch, reversalOfEntryId: originalIn.id, actorId: actor.user.id, metadata: { reason: payload.reason, exactInverse: true } } });
      await Promise.all([
        tx.cashbookEntry.update({ where: { id: originalOut.id }, data: { reversedByEntryId: reverseOut.id } }),
        tx.cashbookEntry.update({ where: { id: originalIn.id }, data: { reversedByEntryId: reverseIn.id } }),
        tx.cashbookAccount.update({ where: { id: from.id }, data: { currentBalance: fixed(fromBefore + amount), version: { increment: 1 } } }),
        tx.cashbookAccount.update({ where: { id: to.id }, data: { currentBalance: fixed(toBefore - amount), version: { increment: 1 } } }),
      ]);
      const reversed = await tx.internalTransferDocument.update({ where: { id: row.id }, data: { workflowStatus: "reversed", postingStatus: "reversed", reversedById: actor.user.id, reversedAt: now(), reversalReason: payload.reason, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "internal_transfer_command_service", module: "finance", action: "internal_transfer_reversed", entityType: "InternalTransferDocument", entityId: row.id, summary: `Reversed internal transfer ${row.transferNumber}.`, metadata: { ...command, postingBatchId: batch, exactInverse: true } } });
      return { entityId: row.id, transfer: { id: row.id, transferNumber: row.transferNumber, workflowStatus: reversed.workflowStatus, postingStatus: reversed.postingStatus, version: reversed.version }, postingBatchId: batch, cashbookEntryIds: [reverseOut.id, reverseIn.id] };
    });
  }
  return {
    createInternalTransfer, reviseInternalTransfer,
    submitInternalTransfer: (id, input, context) => action(id, input, context, "submit"),
    approveInternalTransfer: (id, input, context) => action(id, input, context, "approve"),
    rejectInternalTransfer: (id, input, context) => action(id, input, context, "reject"),
    cancelInternalTransfer: (id, input, context) => action(id, input, context, "cancel"),
    previewInternalTransferPosting, postInternalTransfer, reverseInternalTransfer,
  };
}
