import { assertAuthorized, can } from "../auth/authorization-service.mjs";
import { escapeLikePattern } from "../persistence/like-pattern.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { financeFixed as fixed, financeUnits as units } from "./operational-finance-policy.mjs";

const text = (value) => String(value ?? "").trim();
const serial = (value) => value?.toISOString?.() || value || null;
const page = (query = {}) => {
  const current = Math.max(1, Number(query.page || 1));
  const size = Math.min(100, Math.max(1, Number(query.pageSize || 25)));
  return { page: current, pageSize: size, skip: (current - 1) * size };
};

function visibility(actor) {
  return {
    finance_amounts: { visible: can({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId }), permission: "finance.amounts.read" },
    finance_partner_snapshot: { visible: can({ actor, permission: "finance.partner_snapshot.read", tenantId: actor.tenantId }), permission: "finance.partner_snapshot.read" },
  };
}
function protect(value, actor) {
  const fieldVisibility = visibility(actor);
  const output = { ...value, fieldVisibility };
  if (!fieldVisibility.finance_amounts.visible) for (const key of ["amount", "cashAmount", "discountAmount", "totalSettlementAmount", "advanceCreatedAmount", "cashAppliedAmount", "openingBalance", "currentBalance", "balanceBefore", "balanceAfter", "outstandingAmount", "allocationTotal", "calculatedBalance"]) if (key in output) output[key] = null;
  if (!fieldVisibility.finance_partner_snapshot.visible) for (const key of ["counterpartyName", "counterpartyNameSnapshot", "externalReference"]) if (key in output) output[key] = null;
  return output;
}
function allowedActions(actor, capabilities, settlement, policy = {}) {
  if (!capabilities["internal-settlement"]?.enabled || !can({ actor, permission: "finance.amounts.read", tenantId: actor.tenantId })) return [];
  const actions = [];
  const workflow = capabilities["settlement-workflow"]?.enabled;
  if (["draft", "rejected"].includes(settlement.workflowStatus) && can({ actor, permission: "finance.settlement.revise", tenantId: actor.tenantId })) actions.push("revise");
  if (workflow && settlement.workflowStatus === "draft" && can({ actor, permission: "finance.settlement.submit", tenantId: actor.tenantId })) actions.push("submit");
  if (workflow && settlement.workflowStatus === "submitted" && can({ actor, permission: "finance.settlement.approve", tenantId: actor.tenantId })) actions.push("approve");
  if (workflow && settlement.workflowStatus === "submitted" && can({ actor, permission: "finance.settlement.reject", tenantId: actor.tenantId })) actions.push("reject");
  if (workflow && ["draft", "submitted"].includes(settlement.workflowStatus) && can({ actor, permission: "finance.settlement.cancel", tenantId: actor.tenantId })) actions.push("cancel");
  const threshold = (() => { try { return units(policy.settlementApprovalThreshold ?? 0); } catch { return 0n; } })();
  const approvalRequired = policy.settlementApprovalRequired !== false || units(settlement.totalSettlementAmount) > threshold;
  if (((workflow && (settlement.workflowStatus === "approved" || (!approvalRequired && settlement.workflowStatus === "draft"))) || (!workflow && settlement.status === "draft")) && can({ actor, permission: "finance.settlement.post", tenantId: actor.tenantId })) {
    if (workflow) actions.push("posting-preview");
    actions.push("post");
  }
  if (settlement.postingStatus === "posted" && can({ actor, permission: "finance.settlement.reverse", tenantId: actor.tenantId })) actions.push("reverse");
  return actions;
}

function settlementSummary(row, actor, capabilities, policy) {
  return protect({
    id: row.id,
    settlementNumber: row.settlementNumber,
    direction: row.direction,
    counterpartyType: row.counterpartyType,
    counterpartyId: row.counterpartyId,
    counterpartyNameSnapshot: row.counterpartyNameSnapshot,
    cashbookAccountId: row.cashbookAccountId,
    cashbookAccountCode: row.cashbookAccount?.accountCode,
    currency: row.currency,
    amount: fixed(units(row.amount)),
    cashAmount: fixed(units(row.cashAmount)),
    discountAmount: fixed(units(row.discountAmount)),
    totalSettlementAmount: fixed(units(row.totalSettlementAmount)),
    advanceCreatedAmount: fixed(units(row.advanceCreatedAmount)),
    settlementDate: serial(row.settlementDate),
    status: row.status,
    workflowStatus: row.workflowStatus,
    postingStatus: row.postingStatus,
    externalReference: row.externalReference,
    externalReferenceVerified: false,
    memo: row.memo,
    postedAt: serial(row.postedAt),
    submittedById: row.submittedById,
    submittedAt: serial(row.submittedAt),
    approvedById: row.approvedById,
    approvedAt: serial(row.approvedAt),
    rejectedById: row.rejectedById,
    rejectedAt: serial(row.rejectedAt),
    rejectionReason: row.rejectionReason,
    cancelledById: row.cancelledById,
    cancelledAt: serial(row.cancelledAt),
    cancellationReason: row.cancellationReason,
    attachmentCount: row.attachmentCount,
    reversedAt: serial(row.reversedAt),
    reversalReason: row.reversalReason,
    version: row.version,
    availableActions: allowedActions(actor, capabilities, row, policy),
    bankExecution: false,
    ledgerMutation: false,
    fxConverted: false,
  }, actor);
}

export function createInternalSettlementReadService({ prisma, capabilities = {} } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const actor = (context) => resolveProvisionedActor(prisma, context?.identity || context);
  const policyFor = async (tenantId) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { operationalSettings: true } });
    return tenant?.operationalSettings?.settlementPolicy || {};
  };

  async function listAccounts(query, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.cashbook.read", tenantId: current.tenantId });
    const paging = page(query);
    const where = { tenantId: current.tenantId, ...(text(query.status) ? { status: text(query.status) } : {}), ...(text(query.currency) ? { currency: text(query.currency).toUpperCase() } : {}) };
    const [total, rows] = await Promise.all([prisma.cashbookAccount.count({ where }), prisma.cashbookAccount.findMany({ where, orderBy: [{ accountCode: "asc" }, { id: "asc" }], skip: paging.skip, take: paging.pageSize })]);
    return { ...paging, total, items: rows.map((row) => protect({ id: row.id, accountCode: row.accountCode, name: row.name, accountType: row.accountType, currency: row.currency, openingBalance: fixed(units(row.openingBalance)), currentBalance: fixed(units(row.currentBalance)), status: row.status, version: row.version }, current)), capability: capabilities.cashbook };
  }

  async function listSettlements(query, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.settlement.read", tenantId: current.tenantId });
    const paging = page(query);
    const search = escapeLikePattern(text(query.search));
    const where = { tenantId: current.tenantId, ...(text(query.status) ? { OR: [{ status: text(query.status) }, { workflowStatus: text(query.status) }] } : {}), ...(text(query.direction) ? { direction: text(query.direction) } : {}), ...(text(query.currency) ? { currency: text(query.currency).toUpperCase() } : {}), ...(search ? { AND: [{ OR: [{ settlementNumber: { contains: search, mode: "insensitive" } }, { counterpartyNameSnapshot: { contains: search, mode: "insensitive" } }, { externalReference: { contains: search, mode: "insensitive" } }] }] } : {}) };
    const [total, rows, policy] = await Promise.all([prisma.settlementDocument.count({ where }), prisma.settlementDocument.findMany({ where, include: { cashbookAccount: true }, orderBy: [{ settlementDate: "desc" }, { id: "asc" }], skip: paging.skip, take: paging.pageSize }), policyFor(current.tenantId)]);
    return { ...paging, total, items: rows.map((row) => settlementSummary(row, current, capabilities, policy)), capability: capabilities["internal-settlement"], workflowCapability: capabilities["settlement-workflow"] };
  }

  async function listEntries(query, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.cashbook.read", tenantId: current.tenantId });
    const paging = page(query);
    const where = { tenantId: current.tenantId, ...(text(query.cashbookAccountId) ? { cashbookAccountId: text(query.cashbookAccountId) } : {}), ...(text(query.currency) ? { currency: text(query.currency).toUpperCase() } : {}) };
    const [total, rows] = await Promise.all([prisma.cashbookEntry.count({ where }), prisma.cashbookEntry.findMany({ where, include: { settlement: true, internalTransfer: true, cashbookAccount: true }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.pageSize })]);
    return { ...paging, total, items: rows.map((row) => protect({ id: row.id, entryNumber: row.entryNumber, entryType: row.entryType, direction: row.direction, amount: fixed(units(row.amount)), currency: row.currency, occurredAt: serial(row.occurredAt), balanceBefore: fixed(units(row.balanceBefore)), balanceAfter: fixed(units(row.balanceAfter)), cashbookAccountId: row.cashbookAccountId, cashbookAccountCode: row.cashbookAccount.accountCode, settlementId: row.settlementId, settlementNumber: row.settlement?.settlementNumber || null, internalTransferId: row.internalTransferId, transferNumber: row.internalTransfer?.transferNumber || null, reversalOfEntryId: row.reversalOfEntryId, reversedByEntryId: row.reversedByEntryId, postingBatchId: row.postingBatchId, immutable: true }, current)), capability: capabilities.cashbook };
  }

  async function detail(settlementId, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.settlement.read", tenantId: current.tenantId });
    const row = await prisma.settlementDocument.findFirst({ where: { id: text(settlementId), tenantId: current.tenantId }, include: { cashbookAccount: true, allocations: { include: { payableObligation: { include: { supplierInvoice: true } }, receivableObligation: { include: { customerInvoice: true } } } }, cashbookEntries: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } } });
    if (!row) return null;
    const summary = settlementSummary(row, current, capabilities, await policyFor(current.tenantId));
    return { ...summary, allocations: row.allocations.map((allocation) => {
      const obligation = allocation.payableObligation || allocation.receivableObligation;
      return protect({ id: allocation.id, obligationType: allocation.obligationType, obligationId: obligation?.id, obligationNumber: obligation?.obligationNumber, amount: fixed(units(allocation.amount)), cashAppliedAmount: fixed(units(allocation.cashAppliedAmount)), discountAmount: fixed(units(allocation.discountAmount)), totalSettlementAmount: fixed(units(allocation.totalSettlementAmount)), discountReason: allocation.discountReason, currency: allocation.currency, outstandingAmount: obligation ? fixed(units(obligation.outstandingAmount)) : null, status: obligation?.status, counterpartyName: allocation.payableObligation?.supplierInvoice?.supplierName || allocation.receivableObligation?.customerInvoice?.customerNameSnapshot || null }, current);
    }), cashbookEntries: row.cashbookEntries.map((entry) => protect({ id: entry.id, entryNumber: entry.entryNumber, entryType: entry.entryType, direction: entry.direction, amount: fixed(units(entry.amount)), currency: entry.currency, occurredAt: serial(entry.occurredAt), balanceBefore: fixed(units(entry.balanceBefore)), balanceAfter: fixed(units(entry.balanceAfter)), reversalOfEntryId: entry.reversalOfEntryId, reversedByEntryId: entry.reversedByEntryId, postingBatchId: entry.postingBatchId, immutable: true }, current)) };
  }

  async function listAdvances(query, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.advance.read", tenantId: current.tenantId });
    const paging = page(query);
    const where = { tenantId: current.tenantId, ...(text(query.status) ? { status: text(query.status) } : {}), ...(text(query.advanceType) ? { advanceType: text(query.advanceType) } : {}) };
    const [total, rows] = await Promise.all([prisma.partnerAdvance.count({ where }), prisma.partnerAdvance.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: paging.skip, take: paging.pageSize })]);
    return { ...paging, total, items: rows.map((row) => protect({ id: row.id, advanceNumber: row.advanceNumber, advanceType: row.advanceType, supplierId: row.supplierId, customerId: row.customerId, currency: row.currency, originalAmount: fixed(units(row.originalAmount)), appliedAmount: fixed(units(row.appliedAmount)), remainingAmount: fixed(units(row.remainingAmount)), sourceSettlementId: row.sourceSettlementId, status: row.status, version: row.version }, current)) };
  }

  async function listInternalTransfers(query, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.internal_transfer.read", tenantId: current.tenantId });
    const paging = page(query);
    const where = { tenantId: current.tenantId, ...(text(query.workflowStatus) ? { workflowStatus: text(query.workflowStatus) } : {}), ...(text(query.postingStatus) ? { postingStatus: text(query.postingStatus) } : {}) };
    const [total, rows] = await Promise.all([prisma.internalTransferDocument.count({ where }), prisma.internalTransferDocument.findMany({ where, include: { fromAccount: true, toAccount: true }, orderBy: [{ transferDate: "desc" }, { id: "asc" }], skip: paging.skip, take: paging.pageSize })]);
    return { ...paging, total, items: rows.map((row) => protect({ id: row.id, transferNumber: row.transferNumber, fromCashbookAccountId: row.fromCashbookAccountId, fromAccountCode: row.fromAccount.accountCode, toCashbookAccountId: row.toCashbookAccountId, toAccountCode: row.toAccount.accountCode, currency: row.currency, amount: fixed(units(row.amount)), transferDate: serial(row.transferDate), workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, version: row.version }, current)) };
  }

  async function internalTransferDetail(transferId, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.internal_transfer.read", tenantId: current.tenantId });
    const row = await prisma.internalTransferDocument.findFirst({ where: { id: text(transferId), tenantId: current.tenantId }, include: { fromAccount: true, toAccount: true, entries: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } } });
    if (!row) return null;
    return protect({ id: row.id, transferNumber: row.transferNumber, fromCashbookAccountId: row.fromCashbookAccountId, fromAccountCode: row.fromAccount.accountCode, toCashbookAccountId: row.toCashbookAccountId, toAccountCode: row.toAccount.accountCode, currency: row.currency, amount: fixed(units(row.amount)), transferDate: serial(row.transferDate), externalReference: row.externalReference, memo: row.memo, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, submittedById: row.submittedById, submittedAt: serial(row.submittedAt), approvedById: row.approvedById, approvedAt: serial(row.approvedAt), postedById: row.postedById, postedAt: serial(row.postedAt), reversedById: row.reversedById, reversedAt: serial(row.reversedAt), reversalReason: row.reversalReason, version: row.version, cashbookEntries: row.entries.map((entry) => ({ id: entry.id, entryNumber: entry.entryNumber, entryType: entry.entryType, direction: entry.direction, amount: fixed(units(entry.amount)), postingBatchId: entry.postingBatchId, reversalOfEntryId: entry.reversalOfEntryId, reversedByEntryId: entry.reversedByEntryId })) }, current);
  }

  async function reconciliation(settlementId, context) {
    const current = await actor(context);
    assertAuthorized({ actor: current, permission: "finance.settlement.reconciliation.read", tenantId: current.tenantId });
    const settlement = await prisma.settlementDocument.findFirst({ where: { id: text(settlementId), tenantId: current.tenantId }, include: { allocations: { include: { payableObligation: true, receivableObligation: true } }, cashbookEntries: true, cashbookAccount: true } });
    if (!settlement) return null;
    const checks = [];
    const check = (rule, matched, expected, recorded) => checks.push({ rule, status: matched ? "matched" : "mismatch", expected: String(expected ?? ""), recorded: String(recorded ?? "") });
    const amount = units(settlement.amount);
    const allocationTotal = settlement.allocations.reduce((sum, row) => sum + units(row.amount), 0n);
    check("allocation_total", allocationTotal === units(settlement.totalSettlementAmount), fixed(units(settlement.totalSettlementAmount)), fixed(allocationTotal));
    check("cash_amount", units(settlement.cashAmount) === amount, fixed(amount), fixed(units(settlement.cashAmount)));
    check("workflow_status", ["draft","submitted","approved","rejected","cancelled","posted","reversed"].includes(settlement.workflowStatus), "valid workflow status", settlement.workflowStatus);
    check("posting_status", ["unposted","posted","reversed"].includes(settlement.postingStatus), "valid posting status", settlement.postingStatus);
    const originals = settlement.cashbookEntries.filter((row) => row.entryType === "settlement");
    const reversals = settlement.cashbookEntries.filter((row) => row.entryType === "reversal");
    const original = originals[0], reversal = reversals[0];
    const expectedEntryCount = settlement.postingStatus === "unposted" ? 0 : settlement.postingStatus === "reversed" ? 2 : 1;
    check("cashbook_entry_count", settlement.cashbookEntries.length === expectedEntryCount && originals.length === (expectedEntryCount ? 1 : 0) && reversals.length === (expectedEntryCount === 2 ? 1 : 0), expectedEntryCount, settlement.cashbookEntries.length);
    if (original) check("cashbook_entry_identity", original.tenantId === settlement.tenantId && original.cashbookAccountId === settlement.cashbookAccountId && original.currency === settlement.currency && units(original.amount) === amount && original.direction === (settlement.direction === "receipt" ? "inflow" : "outflow"), `${settlement.tenantId}/${settlement.cashbookAccountId}/${settlement.currency}/${fixed(amount)}`, `${original.tenantId}/${original.cashbookAccountId}/${original.currency}/${fixed(units(original.amount))}`);
    if (settlement.status === "reversed") check("exact_reversal", Boolean(original && reversal && original.reversedByEntryId === reversal.id && reversal.reversalOfEntryId === original.id && reversal.currency === original.currency && reversal.cashbookAccountId === original.cashbookAccountId && units(reversal.amount) === units(original.amount) && reversal.direction !== original.direction && reversal.postingBatchId !== original.postingBatchId), "one exact inverse entry", reversal?.id || "missing");
    const accountEntries = await prisma.cashbookEntry.findMany({ where: { tenantId: current.tenantId, cashbookAccountId: settlement.cashbookAccountId }, orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    let running = units(settlement.cashbookAccount.openingBalance);
    for (const entry of accountEntries) {
      const calculated = entry.direction === "inflow" ? running + units(entry.amount) : running - units(entry.amount);
      check(`cashbook_balance_chain_${entry.id}`, units(entry.balanceBefore) === running && units(entry.balanceAfter) === calculated, `${fixed(running)}->${fixed(calculated)}`, `${fixed(units(entry.balanceBefore))}->${fixed(units(entry.balanceAfter))}`);
      running = calculated;
    }
    check("cashbook_current_balance", running === units(settlement.cashbookAccount.currentBalance), fixed(running), fixed(units(settlement.cashbookAccount.currentBalance)));
    for (const allocation of settlement.allocations) {
      const obligation = allocation.payableObligation || allocation.receivableObligation;
      const allocationWhere = allocation.obligationType === "payable" ? { payableObligationId: obligation.id } : { receivableObligationId: obligation.id };
      const active = await prisma.settlementAllocation.findMany({ where: { tenantId: current.tenantId, ...allocationWhere, settlement: { status: "posted" } } });
      const activeTotal = active.reduce((sum, row) => sum + units(row.amount), 0n);
      const calculated = units(obligation.originalAmount) - units(obligation.approvedCreditAmount || 0) - activeTotal;
      check(`obligation_outstanding_${obligation.id}`, calculated === units(obligation.outstandingAmount), fixed(calculated), fixed(units(obligation.outstandingAmount)));
    }
    const status = checks.every((row) => row.status === "matched") ? "matched" : "mismatch";
    return protect({ status, lineIsolation: true, crossObligationNettingAllowed: false, settlementId: settlement.id, allocationTotal: fixed(allocationTotal), amount: fixed(amount), calculatedBalance: fixed(running), checks }, current);
  }

  async function entryData(context) {
    const current = await actor(context);
    const mayReadSettlements = can({ actor: current, permission: "finance.settlement.read", tenantId: current.tenantId });
    const mayReadCashbook = can({ actor: current, permission: "finance.cashbook.read", tenantId: current.tenantId });
    const [settlementCount, accountCount] = await Promise.all([mayReadSettlements ? prisma.settlementDocument.count({ where: { tenantId: current.tenantId } }) : 0, mayReadCashbook ? prisma.cashbookAccount.count({ where: { tenantId: current.tenantId } }) : 0]);
    return { settlementCount, cashbookAccountCount: accountCount, capabilities, permissions: { settlementRead: mayReadSettlements, cashbookRead: mayReadCashbook } };
  }

  return { listAccounts, listSettlements, listEntries, listAdvances, listInternalTransfers, internalTransferDetail, detail, reconciliation, entryData };
}
