import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";
import { InternalSettlementError } from "./internal-settlement-command-service.mjs";
import { assertAdvanceApplicationEligibility, derivePayableSettlementStatus, deriveReceivableSettlementStatus } from "./obligation-status-policy.mjs";

const text = (value) => String(value ?? "").trim();
const fail = (code, message, status = 400, details) => { throw new InternalSettlementError(code, message, status, details); };
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const version = (value) => { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) fail("ADVANCE_VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422); return parsed; };
const permissions = { create: "finance.advance.create", submit: "finance.advance.submit", approve: "finance.advance.approve", post: "finance.advance.post", reverse: "finance.advance.reverse" };

export function createAdvanceApplicationCommandService({ prisma, env = process.env, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const actorFor = async (db, context, permission) => { const actor = await resolveProvisionedActor(db, context?.identity || context); assertAuthorized({ actor, permission, tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId }); return actor; };
  const enabled = () => { if (text(env.FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW).toLowerCase() !== "true") fail("SETTLEMENT_WORKFLOW_CAPABILITY_NOT_AVAILABLE", "Advance application requires the settlement workflow capability.", 409); };
  async function execute(command, input, context, payload, work) {
    enabled(); const initial = await actorFor(prisma, context, permissions[command]); const key = text(input.idempotencyKey); if (!key) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const commandType = `${command}_advance_application`, requestHash = digest(payload), where = { tenantId_commandType_idempotencyKey: { tenantId: initial.tenantId, commandType, idempotencyKey: key } };
    const prior = await prisma.businessCommandExecution.findUnique({ where });
    if (prior) { if (prior.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with a different payload.", 409); return { ...prior.resultPayload, idempotentReplay: true }; }
    return prisma.$transaction(async (tx) => {
      const actor = await actorFor(tx, context, permissions[command]);
      const inside = await tx.businessCommandExecution.findUnique({ where });
      if (inside) { if (inside.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with a different payload.", 409); return { ...inside.resultPayload, idempotentReplay: true }; }
      const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: "pending" } });
      const result = await work(tx, actor, { commandType, idempotencyKey: key });
      await tx.domainChangeFeed.createMany({ data: [{ tenantId: actor.tenantId, entityType: "AdvanceApplicationDocument", entityId: result.entityId, operation: "upsert", entityVersion: result.application.version, actorId: actor.user.id, source: "advance_application_command", requestId: key, payloadHash: digest({ id: result.entityId, version: result.application.version }), sensitivityGroups: ["finance_amounts"], moduleKey: "finance", authorizationClass: "finance.advance.read", resourceTenantId: actor.tenantId }, ...(result.advance ? [{ tenantId: actor.tenantId, entityType: "PartnerAdvance", entityId: result.advance.id, operation: "upsert", entityVersion: result.advance.version, actorId: actor.user.id, source: "advance_application_command", requestId: key, payloadHash: digest({ id: result.advance.id, version: result.advance.version }), sensitivityGroups: ["finance_amounts"], moduleKey: "finance", authorizationClass: "finance.advance.read", resourceTenantId: actor.tenantId }] : [])] });
      await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", entityType: "AdvanceApplicationDocument", entityId: result.entityId, resultPayload: result, completedAt: now() } });
      return { ...result, idempotentReplay: false };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  }
  async function resolveFacts(db, tenantId, input) {
    const advance = await db.partnerAdvance.findFirst({ where: { id: text(input.advanceId), tenantId } });
    if (!advance || advance.status === "reversed") fail("ADVANCE_NOT_AVAILABLE", "An open tenant-owned advance is required.", 404);
    const payableId = text(input.payableObligationId), receivableId = text(input.receivableObligationId);
    if (Boolean(payableId) === Boolean(receivableId)) fail("ADVANCE_APPLICATION_OBLIGATION_INVALID", "Exactly one payable or receivable is required.", 422);
    const obligation = payableId ? await db.payableObligation.findFirst({ where: { id: payableId, tenantId }, include: { supplierInvoice: true } }) : await db.receivableObligation.findFirst({ where: { id: receivableId, tenantId }, include: { customerInvoice: true } });
    if (!obligation) fail("ADVANCE_APPLICATION_OBLIGATION_NOT_FOUND", "The tenant-owned obligation was not found.", 404);
    try { assertAdvanceApplicationEligibility(obligation, payableId ? "payable" : "receivable"); } catch (error) { fail(error.code, error.message, error.status, error.details); }
    if (obligation.currency !== advance.currency) fail("ADVANCE_APPLICATION_CURRENCY_MISMATCH", "Advance and obligation currencies must match; FX is unavailable.", 409);
    const partnerId = payableId ? obligation.supplierInvoice.supplierId : obligation.customerInvoice.customerId;
    if ((payableId && (advance.advanceType !== "supplier_advance" || advance.supplierId !== partnerId)) || (receivableId && (advance.advanceType !== "customer_advance" || advance.customerId !== partnerId))) fail("ADVANCE_APPLICATION_PARTNER_MISMATCH", "An advance cannot be applied across partners.", 409);
    let amount; try { amount = units(input.appliedAmount); } catch { fail("ADVANCE_APPLICATION_AMOUNT_INVALID", "Applied amount must be valid.", 422); }
    if (amount <= 0n || amount > units(advance.remainingAmount) || amount > units(obligation.outstandingAmount)) fail("ADVANCE_APPLICATION_AMOUNT_INVALID", "Applied amount exceeds the advance or obligation balance.", 409);
    return { advance, obligation, amount, payableId, receivableId };
  }
  async function createAdvanceApplication(input, context) {
    const payload = { applicationNumber: text(input.applicationNumber), advanceId: text(input.advanceId), payableObligationId: text(input.payableObligationId), receivableObligationId: text(input.receivableObligationId), appliedAmount: text(input.appliedAmount), currency: text(input.currency).toUpperCase(), clientMutationId: text(input.clientMutationId), sourceDeviceId: text(input.sourceDeviceId) };
    return execute("create", input, context, payload, async (tx, actor, command) => {
      if (!payload.applicationNumber) fail("ADVANCE_APPLICATION_NUMBER_REQUIRED", "Application number is required.", 422);
      const facts = await resolveFacts(tx, actor.tenantId, payload);
      if (payload.currency && payload.currency !== facts.advance.currency) fail("ADVANCE_APPLICATION_CURRENCY_MISMATCH", "Application currency must match the advance.", 409);
      const row = await tx.advanceApplicationDocument.create({ data: { id: idFactory(), tenantId: actor.tenantId, applicationNumber: payload.applicationNumber, advanceId: facts.advance.id, payableObligationId: facts.payableId || null, receivableObligationId: facts.receivableId || null, appliedAmount: fixed(facts.amount), currency: facts.advance.currency, clientMutationId: payload.clientMutationId || null, sourceDeviceId: payload.sourceDeviceId || null, metadata: { createdById: actor.user.id } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "advance_application_command_service", module: "finance", action: "advance_application_created", entityType: "AdvanceApplicationDocument", entityId: row.id, summary: `Created advance application ${row.applicationNumber}.`, metadata: command } });
      return { entityId: row.id, application: { id: row.id, applicationNumber: row.applicationNumber, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, version: row.version } };
    });
  }
  async function workflow(id, input, context, name) {
    const payload = { id: text(id), expectedVersion: version(input.expectedVersion) };
    return execute(name, input, context, payload, async (tx, actor, command) => {
      const row = await tx.advanceApplicationDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId } });
      if (!row) fail("ADVANCE_APPLICATION_NOT_FOUND", "Advance application was not found.", 404);
      if (row.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Advance application changed concurrently.", 409, { entityId: row.id, expectedVersion: payload.expectedVersion, currentVersion: row.version });
      const required = name === "submit" ? "draft" : "submitted"; if (row.workflowStatus !== required) fail("ADVANCE_APPLICATION_WORKFLOW_CONFLICT", `Advance application cannot be ${name}ted from ${row.workflowStatus}.`, 409);
      await resolveFacts(tx, actor.tenantId, row);
      if (name === "approve" && row.metadata?.createdById === actor.user.id) fail("ADVANCE_APPLICATION_SELF_APPROVAL_BLOCKED", "The creator may not approve this application.", 409);
      const at = now(), data = name === "submit" ? { workflowStatus: "submitted", submittedById: actor.user.id, submittedAt: at, version: { increment: 1 } } : { workflowStatus: "approved", approvedById: actor.user.id, approvedAt: at, version: { increment: 1 } };
      const updated = await tx.advanceApplicationDocument.update({ where: { id: row.id }, data });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "advance_application_command_service", module: "finance", action: `advance_application_${name === "submit" ? "submitted" : "approved"}`, entityType: "AdvanceApplicationDocument", entityId: row.id, summary: `${name} advance application ${row.applicationNumber}.`, metadata: command } });
      return { entityId: row.id, application: { id: row.id, applicationNumber: row.applicationNumber, workflowStatus: updated.workflowStatus, postingStatus: updated.postingStatus, version: updated.version } };
    });
  }
  async function postAdvanceApplication(id, input, context) {
    const payload = { id: text(id), expectedVersion: version(input.expectedVersion) };
    return execute("post", input, context, payload, async (tx, actor, command) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "AdvanceApplicationDocument" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.id);
      const row = await tx.advanceApplicationDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId } });
      if (!row) fail("ADVANCE_APPLICATION_NOT_FOUND", "Advance application was not found.", 404);
      if (row.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Advance application changed concurrently.", 409, { entityId: row.id, expectedVersion: payload.expectedVersion, currentVersion: row.version });
      if (row.workflowStatus !== "approved" || row.postingStatus !== "unposted") fail("ADVANCE_APPLICATION_NOT_POSTABLE", "Only an approved unposted application may be posted.", 409);
      await tx.$queryRawUnsafe('SELECT "id" FROM "PartnerAdvance" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, row.advanceId);
      const obligationTable = row.payableObligationId ? "PayableObligation" : "ReceivableObligation", obligationId = row.payableObligationId || row.receivableObligationId;
      await tx.$queryRawUnsafe(`SELECT "id" FROM "${obligationTable}" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE`, actor.tenantId, obligationId);
      const facts = await resolveFacts(tx, actor.tenantId, row);
      const remaining = units(facts.advance.remainingAmount) - facts.amount, applied = units(facts.advance.appliedAmount) + facts.amount, outstanding = units(facts.obligation.outstandingAmount) - facts.amount;
      const advanceStatus = remaining === 0n ? "fully_applied" : "partially_applied", obligationStatus = row.payableObligationId ? derivePayableSettlementStatus({ ...facts.obligation, outstandingAmount: fixed(outstanding) }) : deriveReceivableSettlementStatus({ ...facts.obligation, outstandingAmount: fixed(outstanding) });
      const advance = await tx.partnerAdvance.update({ where: { id: facts.advance.id }, data: { remainingAmount: fixed(remaining), appliedAmount: fixed(applied), status: advanceStatus, version: { increment: 1 } } });
      const model = row.payableObligationId ? tx.payableObligation : tx.receivableObligation;
      await model.update({ where: { id: obligationId }, data: { outstandingAmount: fixed(outstanding), status: obligationStatus, version: { increment: 1 } } });
      const posted = await tx.advanceApplicationDocument.update({ where: { id: row.id }, data: { workflowStatus: "posted", postingStatus: "posted", postedById: actor.user.id, postedAt: now(), version: { increment: 1 }, metadata: { ...row.metadata, beforeAdvanceRemaining: fixed(units(facts.advance.remainingAmount)), afterAdvanceRemaining: fixed(remaining), beforeObligationOutstanding: fixed(units(facts.obligation.outstandingAmount)), afterObligationOutstanding: fixed(outstanding) } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "advance_application_command_service", module: "finance", action: "advance_application_posted", entityType: "AdvanceApplicationDocument", entityId: row.id, summary: `Posted advance application ${row.applicationNumber} without a cashbook entry.`, metadata: { ...command, cashbookEntryCount: 0 } } });
      return { entityId: row.id, application: { id: row.id, applicationNumber: row.applicationNumber, workflowStatus: posted.workflowStatus, postingStatus: posted.postingStatus, version: posted.version }, advance: { id: advance.id, remainingAmount: fixed(remaining), appliedAmount: fixed(applied), version: advance.version }, cashbookEntryCount: 0 };
    });
  }
  async function reverseAdvanceApplication(id, input, context) {
    const payload = { id: text(id), expectedVersion: version(input.expectedVersion), reason: text(input.reason) };
    return execute("reverse", input, context, payload, async (tx, actor, command) => {
      if (!payload.reason) fail("ADVANCE_APPLICATION_REVERSAL_REASON_REQUIRED", "A reversal reason is required.", 422);
      await tx.$queryRawUnsafe('SELECT "id" FROM "AdvanceApplicationDocument" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.id);
      const row = await tx.advanceApplicationDocument.findFirst({ where: { id: payload.id, tenantId: actor.tenantId } });
      if (!row) fail("ADVANCE_APPLICATION_NOT_FOUND", "Advance application was not found.", 404);
      if (row.version !== payload.expectedVersion) fail("SYNC_VERSION_CONFLICT", "Advance application changed concurrently.", 409, { entityId: row.id, expectedVersion: payload.expectedVersion, currentVersion: row.version });
      if (row.postingStatus !== "posted") fail("ADVANCE_APPLICATION_NOT_REVERSIBLE", "Only a posted application may be reversed.", 409);
      await tx.$queryRawUnsafe('SELECT "id" FROM "PartnerAdvance" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, row.advanceId);
      const advance = await tx.partnerAdvance.findFirst({ where: { id: row.advanceId, tenantId: actor.tenantId } }), model = row.payableObligationId ? tx.payableObligation : tx.receivableObligation, obligationId = row.payableObligationId || row.receivableObligationId;
      const obligation = await model.findFirst({ where: { id: obligationId, tenantId: actor.tenantId } }), amount = units(row.appliedAmount);
      const restoredAdvance = units(advance.remainingAmount) + amount, restoredOutstanding = units(obligation.outstandingAmount) + amount;
      if (restoredAdvance > units(advance.originalAmount) || restoredOutstanding > units(obligation.originalAmount) - units(obligation.approvedCreditAmount || 0)) fail("ADVANCE_APPLICATION_REVERSAL_NOT_SAFE", "Current facts cannot accept an exact reversal.", 409);
      const updatedAdvance = await tx.partnerAdvance.update({ where: { id: advance.id }, data: { remainingAmount: fixed(restoredAdvance), appliedAmount: fixed(units(advance.appliedAmount) - amount), status: restoredAdvance === units(advance.originalAmount) ? "open" : "partially_applied", version: { increment: 1 } } });
      const restoredStatus = row.payableObligationId ? derivePayableSettlementStatus({ ...obligation, outstandingAmount: fixed(restoredOutstanding) }) : deriveReceivableSettlementStatus({ ...obligation, outstandingAmount: fixed(restoredOutstanding) });
      await model.update({ where: { id: obligation.id }, data: { outstandingAmount: fixed(restoredOutstanding), status: restoredStatus, version: { increment: 1 } } });
      const reversed = await tx.advanceApplicationDocument.update({ where: { id: row.id }, data: { workflowStatus: "reversed", postingStatus: "reversed", reversedById: actor.user.id, reversedAt: now(), reversalReason: payload.reason, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "advance_application_command_service", module: "finance", action: "advance_application_reversed", entityType: "AdvanceApplicationDocument", entityId: row.id, summary: `Reversed advance application ${row.applicationNumber}.`, metadata: { ...command, exactInverse: true, cashbookEntryCount: 0 } } });
      return { entityId: row.id, application: { id: row.id, applicationNumber: row.applicationNumber, workflowStatus: reversed.workflowStatus, postingStatus: reversed.postingStatus, version: reversed.version }, advance: { id: updatedAdvance.id, remainingAmount: fixed(restoredAdvance), appliedAmount: fixed(units(updatedAdvance.appliedAmount)), version: updatedAdvance.version }, cashbookEntryCount: 0 };
    });
  }
  return { createAdvanceApplication, submitAdvanceApplication: (id, input, context) => workflow(id, input, context, "submit"), approveAdvanceApplication: (id, input, context) => workflow(id, input, context, "approve"), postAdvanceApplication, reverseAdvanceApplication };
}
