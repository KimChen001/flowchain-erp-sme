import { randomUUID } from 'node:crypto';

// Supplier tiers and business owners (docs/supplier-tiers-design.md).
// A tier is the supplier's importance to the business: 1 Strategic, 2 Core,
// 3 Transactional, or null for not tiered. A person sets it with a reason, and
// every change is a tier_change audit row; that row is the tier's history. A
// change bumps the supplier version, as a profile save does, so an edit opened
// before it is refused instead of silently undoing it.
export const SUPPLIER_TIERS = Object.freeze([1, 2, 3]);
export const TIER_REASON_LIMITS = Object.freeze({ min: 3, max: 500 });

const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details });
const text = (value) => String(value ?? '').trim();
const versionOf = (supplier) => Number(supplier?.metadata?.version || 1);

function parseTier(value) {
  if (value === null || value === '' || value === 'none') return null;
  const tier = Number(value);
  if (!SUPPLIER_TIERS.includes(tier)) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', [{ field: 'tier', message: 'Choose Tier 1, 2 or 3, or Not tiered.' }]);
  return tier;
}

// Writes one tier change inside the caller's transaction. Also used by the
// walkthrough seed, which has no signed-in user (actorId null).
export async function applySupplierTierChange(tx, supplier, { tier, reason, actorId = null, acceptedSuggestion = false, source = 'supplier-master', now = new Date() }) {
  const version = versionOf(supplier) + 1;
  const saved = await tx.supplier.update({
    where: { id: supplier.id },
    data: {
      tier,
      tierReason: tier === null ? null : reason,
      tierSetById: actorId,
      tierSetAt: now,
      metadata: { ...(supplier.metadata || {}), version, ...(actorId ? { updatedBy: actorId } : {}) },
    },
  });
  await tx.auditLog.create({ data: {
    id: randomUUID(), tenantId: supplier.tenantId, source, module: 'srm', action: 'tier_change', entityType: 'supplier', entityId: supplier.id, actorId,
    summary: `Supplier tier changed from ${supplier.tier ? `Tier ${supplier.tier}` : 'not tiered'} to ${tier ? `Tier ${tier}` : 'not tiered'}`,
    metadata: { fromTier: supplier.tier ?? null, toTier: tier, reason, acceptedSuggestion: Boolean(acceptedSuggestion), version },
  } });
  return saved;
}

async function inTransaction(prisma, id, input, scope, work) {
  if (!scope?.tenantId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  try {
    return await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id, tenantId: scope.tenantId } });
      if (!supplier) throw fail(404, 'NOT_FOUND', 'Supplier not found.');
      if (Number(input?.expectedVersion) !== versionOf(supplier)) throw fail(409, 'VERSION_CONFLICT', 'This supplier changed. Reopen it and try again.');
      return work(tx, supplier);
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error.code === 'P2034') throw fail(409, 'VERSION_CONFLICT', 'This supplier changed. Reopen it and try again.');
    throw error;
  }
}

export async function changeSupplierTier(prisma, id, input = {}, actorId, scope) {
  if (!actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  const tier = parseTier(input.tier);
  const reason = text(input.reason);
  if (reason.length < TIER_REASON_LIMITS.min || reason.length > TIER_REASON_LIMITS.max) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', [{ field: 'reason', message: 'Enter a reason of 3 to 500 characters.' }]);
  return inTransaction(prisma, id, input, scope, async (tx, supplier) => {
    if ((supplier.tier ?? null) === tier) throw fail(422, 'TIER_UNCHANGED', tier ? `This supplier is already Tier ${tier}.` : 'This supplier is already not tiered.', [{ field: 'tier', message: 'Choose a different tier.' }]);
    return applySupplierTierChange(tx, supplier, { tier, reason, actorId, acceptedSuggestion: input.acceptedSuggestion === true });
  });
}

// The owner is an active user of the supplier's own workspace, or nobody.
export async function changeSupplierOwner(prisma, id, input = {}, actorId, scope) {
  if (!actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  const ownerId = text(input.businessOwnerId) || null;
  return inTransaction(prisma, id, input, scope, async (tx, supplier) => {
    if (ownerId) {
      const owner = await tx.user.findFirst({ where: { id: ownerId, tenantId: scope.tenantId, status: 'active' }, select: { id: true } });
      if (!owner) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', [{ field: 'businessOwnerId', message: 'Choose an active user of this workspace.' }]);
    }
    if ((supplier.businessOwnerId ?? null) === ownerId) throw fail(422, 'OWNER_UNCHANGED', 'This supplier already has this owner.', [{ field: 'businessOwnerId', message: 'Choose a different owner.' }]);
    const version = versionOf(supplier) + 1;
    const saved = await tx.supplier.update({ where: { id: supplier.id }, data: { businessOwnerId: ownerId, metadata: { ...(supplier.metadata || {}), version, updatedBy: actorId } } });
    await tx.auditLog.create({ data: {
      id: randomUUID(), tenantId: scope.tenantId, source: 'supplier-master', module: 'srm', action: 'owner_change', entityType: 'supplier', entityId: supplier.id, actorId,
      summary: ownerId ? 'Supplier business owner changed' : 'Supplier business owner removed',
      metadata: { fromOwnerId: supplier.businessOwnerId ?? null, toOwnerId: ownerId, version },
    } });
    return saved;
  });
}
