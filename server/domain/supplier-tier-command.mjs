import { randomUUID } from 'node:crypto';
import { SUPPLIER_TIERS } from '../../shared/supplier-tiers.mjs';

// Supplier tiers and business owners (docs/supplier-tiers-design.md).
// A tier is the supplier's importance to the business: 1 Strategic, 2 Core,
// 3 Transactional, or null for not tiered (shared/supplier-tiers.mjs). A person
// sets it with a reason, and every change is a tier_change audit row; that row
// is the tier's history. A change bumps the supplier version, as a profile
// save does, so an edit opened before it is refused instead of silently
// undoing it.
//
// A review keeps the tier and records that someone looked at it again, with a
// reason, as a tier_reviewed audit row (design audit L9-12). A change and a
// review can each set the next review day, kept on the supplier
// (metadata.tierReview), and each audit row keeps the supplier's indicators
// as the reviewer saw them (on time, OTIF, overdue orders, open issues), read
// by the route. FlowChain never suggests the tier itself.
export { SUPPLIER_TIERS };
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The next review day: a calendar date, or none.
function parseReviewDay(value) {
  const day = text(value);
  if (!day) return null;
  if (!DAY.test(day) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', [{ field: 'nextReviewOn', message: 'Enter the next review date as a calendar date.' }]);
  return day;
}
function parseReason(value) {
  const reason = text(value);
  if (reason.length < TIER_REASON_LIMITS.min || reason.length > TIER_REASON_LIMITS.max) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', [{ field: 'reason', message: 'Enter a reason of 3 to 500 characters.' }]);
  return reason;
}
const tierName = (tier) => (tier ? `Tier ${tier}` : 'not tiered');
// When the tier was last decided, by whom, and when it is due again.
const tierReviewOf = (actorId, now, nextReviewOn) => ({ reviewedAt: now.toISOString(), reviewedById: actorId, nextReviewOn });

// Writes one tier change inside the caller's transaction. Also used by the
// walkthrough seed, which has no signed-in user (actorId null).
// indicators: the supplier's figures as the person saw them, or null.
export async function applySupplierTierChange(tx, supplier, { tier, reason, actorId = null, acceptedSuggestion = false, source = 'supplier-master', now = new Date(), nextReviewOn = null, indicators = null }) {
  const version = versionOf(supplier) + 1;
  const saved = await tx.supplier.update({
    where: { id: supplier.id },
    data: {
      tier,
      tierReason: tier === null ? null : reason,
      tierSetById: actorId,
      tierSetAt: now,
      metadata: { ...(supplier.metadata || {}), version, ...(actorId ? { updatedBy: actorId } : {}), tierReview: tierReviewOf(actorId, now, nextReviewOn) },
    },
  });
  await tx.auditLog.create({ data: {
    id: randomUUID(), tenantId: supplier.tenantId, source, module: 'srm', action: 'tier_change', entityType: 'supplier', entityId: supplier.id, actorId,
    summary: `Supplier tier changed from ${tierName(supplier.tier)} to ${tierName(tier)}`,
    metadata: { fromTier: supplier.tier ?? null, toTier: tier, reason, acceptedSuggestion: Boolean(acceptedSuggestion), version, nextReviewOn, ...(indicators ? { indicators } : {}) },
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

// options.indicators: the supplier's figures for the audit row, read by the
// route with the person's own access; never taken from the request body.
export async function changeSupplierTier(prisma, id, input = {}, actorId, scope, { indicators = null, now = new Date() } = {}) {
  if (!actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  const tier = parseTier(input.tier);
  const reason = parseReason(input.reason);
  const nextReviewOn = parseReviewDay(input.nextReviewOn);
  return inTransaction(prisma, id, input, scope, async (tx, supplier) => {
    if ((supplier.tier ?? null) === tier) throw fail(422, 'TIER_UNCHANGED', tier ? `This supplier is already Tier ${tier}.` : 'This supplier is already not tiered.', [{ field: 'tier', message: 'Choose a different tier, or record a review to keep this one.' }]);
    return applySupplierTierChange(tx, supplier, { tier, reason, actorId, acceptedSuggestion: input.acceptedSuggestion === true, now, nextReviewOn, indicators });
  });
}

// Records a review that keeps the supplier's tier (design audit L9-12): who,
// when, why, the next review day and the indicators then. Bumps the version.
export async function reviewSupplierTier(prisma, id, input = {}, actorId, scope, { indicators = null, now = new Date() } = {}) {
  if (!actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  const reason = parseReason(input.reason);
  const nextReviewOn = parseReviewDay(input.nextReviewOn);
  return inTransaction(prisma, id, input, scope, async (tx, supplier) => {
    const version = versionOf(supplier) + 1;
    const tier = supplier.tier ?? null;
    const saved = await tx.supplier.update({ where: { id: supplier.id }, data: { metadata: { ...(supplier.metadata || {}), version, updatedBy: actorId, tierReview: tierReviewOf(actorId, now, nextReviewOn) } } });
    await tx.auditLog.create({ data: {
      id: randomUUID(), tenantId: scope.tenantId, source: 'supplier-master', module: 'srm', action: 'tier_reviewed', entityType: 'supplier', entityId: supplier.id, actorId,
      summary: `Supplier tier reviewed and kept at ${tierName(tier)}`,
      metadata: { tier, reason, version, nextReviewOn, ...(indicators ? { indicators } : {}) },
    } });
    return saved;
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
