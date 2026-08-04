# Canonical RFQ Detail Boundary

The canonical RFQ detail route is `/app/procurement/rfq/:id`. It is a read-only Procurement Core surface backed by `GET /api/procurement/documents/rfq/:id`.

## Authority

The database repository performs only these procurement reads for a detail request:

1. `Rfq.findFirst` with `tenantId` and the exact decoded RFQ `id`, including `RfqLine` rows.
2. `SupplierQuotation.findMany` with the same `tenantId` and exact `rfqId`, including `SupplierQuotationLine` rows.

The repository never loads a bounded procurement snapshot or RFQ list to locate the requested record. A record outside the signed tenant returns the same 404 contract as a missing record.

RFQ and quotation statuses are normalized at the repository boundary through `server/domain/procurement-status-authority.mjs`. Historical aliases are accepted only as input; the detail DTO emits canonical values or `null` for an invalid status.

## Current model limits

The Prisma model has no independent invitation/participation relation and no quotation revision/version model. The UI therefore shows invitation counts and suppliers that have an associated quotation, while explicitly labelling the invitation and revision limits. It does not claim supplier portal accounts, external submissions, latest revisions, awards, or PO conversion.

Related PR, PO, RFQ, and quotation IDs are emitted only when the corresponding explicit relation exists on the RFQ or quotation record. No supplier, SKU, amount, or evidence relationship is inferred by name matching.

## Failure contract

The route preserves the procurement read contract: 400 for an unsupported type, 401 for an invalid session or missing tenant context, 404 for a missing or tenant-invisible RFQ, and 500 for an unhandled service failure after the normal runtime redaction boundary. The page distinguishes loading, malformed ID, not found, unauthenticated, forbidden, temporary service failure, and network-unavailable states.

This change adds no RFQ write command, response capture, comparison, award, PO draft conversion, supplier portal, external identity, AI mutation, or Prisma migration.
