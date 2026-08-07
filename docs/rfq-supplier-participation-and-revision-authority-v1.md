# RFQ Supplier Participation and Quotation Revision Authority v1

## Problem

The legacy procurement schema represented an RFQ and a mutable supplier quotation, but it had no independent RFQ-to-supplier participation fact and no immutable quotation history. The canonical RFQ detail could only report suppliers attached to quotations and could not determine a latest revision.

## Authority model

The additive model is:

```text
Rfq
  -> RfqSupplierParticipation
      -> Supplier

Rfq
  -> SupplierQuotation
      -> SupplierQuotationRevision
          -> SupplierQuotationRevisionLine
```

`RfqSupplierParticipation` is unique by `tenantId + rfqId + supplierId`. Its status catalog is `planned`, `invited_internal`, `response_recorded`, `declined`, `withdrawn`, and `closed`. These are internal participation facts. The read contract exposes `participationAuthority: authoritative`, while `invitationDeliveryAuthority` and `externalSupplierIdentityAuthority` are explicitly `unavailable`. In particular, `invited_internal` does not prove email delivery, a Supplier Portal identity, an external login, or an online submission.

`SupplierQuotation` requires tenant-scoped RFQ and Supplier parents and is unique by `tenantId + rfqId + supplierId`; it is the stable quotation aggregate identity. `SupplierQuotationRevision` is unique by `tenantId + quotationId + revisionNumber`. A revision owns snapshot lines with Decimal quantity, unit price, and amount fields plus exact provenance IDs. The legacy quotation and quotation-line tables remain in place for compatibility.

`RfqLine` now has a tenant-scoped composite identity. `SupplierQuotationRevisionLine.rfqLineId` is nullable for legacy backfill, but new non-null values are protected by `tenantId + rfqLineId -> RfqLine(tenantId, id)` and by `tenantId + revisionId + rfqLineId` uniqueness. The database cannot express the revision's RFQ and the line's RFQ in one Prisma relation without duplicating the RFQ key; future response commands must validate that same-RFQ invariant transactionally. No legacy line is fuzzy-linked by SKU, item name, supplier, amount, position, or text similarity.

## Tenant isolation

Supplier, RFQ, quotation, revision, revision-line, and participation authority relations use composite tenant-scoped keys. The migration fails before DDL or backfill when a legacy quotation points to a missing or cross-tenant RFQ/Supplier. Repository predicates always include the signed `tenantId` and exact RFQ ID.

## Status authority

Both new status domains live in `server/domain/procurement-status-authority.mjs`. Historical quotation `received` maps to canonical `submitted` during Revision 1 backfill. Unknown legacy quotation statuses fail migration; unknown runtime values are returned as `null` canonical status with the raw value kept separately.

## Immutability and latest selection

PostgreSQL triggers reject every UPDATE or DELETE on `SupplierQuotationRevision` and `SupplierQuotationRevisionLine`. INSERT remains available for a future authorized append command.

The only latest authority is the maximum `revisionNumber` for a quotation. The model deliberately has no mutable `isLatest` column and no `currentRevisionId` pointer, so two latest authorities cannot diverge. The read projection sorts revisions by revision number descending, with created time and ID only as deterministic tie breakers behind the uniqueness constraint.

## Migration and backfill

Migration `20260728010000_rfq_participation_revision_authority` is additive. Before changing schema it rejects:

- missing or empty RFQ/Supplier IDs;
- duplicate tenant/RFQ/Supplier quotation groups;
- missing or cross-tenant RFQ/Supplier/quotation parents;
- unknown quotation statuses;
- negative quotation or line Decimal values.

Each safe legacy quotation produces deterministic Revision 1 and `response_recorded` participation IDs. A backfilled response has no invitation evidence (`invitedAt = null`) and therefore is not included in `invitedInternalCount`. Each legacy quotation line produces one revision line with its source line ID and a deliberately NULL `rfqLineId`; it remains compatibility data until an exact future command-created relationship exists. Header/line Decimal values and metadata are copied without conversion, while every legacy table, field, and ID remains unchanged.

The upgrade verifier covers successful parity plus each fail-closed class. The fresh PostgreSQL test covers full migration deployment, composite tenant FKs, append-only triggers, deterministic latest selection, historical ordering, and no-response projection.

## Read query plan

Canonical RFQ detail uses exactly three bounded Prisma calls:

1. `Rfq.findFirst` for signed `tenantId` plus exact decoded RFQ ID, including RFQ lines.
2. `SupplierQuotation.findMany` for the same `tenantId + rfqId`, including revisions and their lines.
3. `RfqSupplierParticipation.findMany` for the same `tenantId + rfqId`, including Supplier identity.

There is no RFQ list scan, procurement snapshot, fixture fallback, fuzzy join, or N+1 revision/line query.

The detail projection derives quotation status, currency, amount, submitted time, payment terms, validity, delivery date, and line prices/quantities from the maximum `revisionNumber`. It returns `authorityState: revision_authoritative` only when that revision exists. If a quotation has no revision, it returns `authorityState: revision_missing`, null/empty commercial fields, and an explicit limitation instead of falling back to the mutable compatibility header. A quotation with no participation is likewise surfaced as a quotation-only compatibility record.

## Current non-goals

This version adds no Supplier Response UI, response/revision HTTP write command, comparison, award, PO conversion, Supplier Portal, email delivery, external supplier identity, or AI mutation. The next phase must introduce an authorized, idempotent append command with audit/change-feed facts before new revisions can be recorded through HTTP.
