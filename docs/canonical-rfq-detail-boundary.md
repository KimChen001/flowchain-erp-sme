# Canonical RFQ Detail Boundary

The canonical RFQ detail route is `/app/procurement/rfq/:id`. It is a read-only Procurement Core surface backed by `GET /api/procurement/documents/rfq/:id`.

## Authority

The database repository performs exactly these three bounded procurement reads for a detail request:

1. `Rfq.findFirst` with `tenantId` and the exact decoded RFQ `id`, including `RfqLine` rows.
2. `SupplierQuotation.findMany` with the same `tenantId` and exact `rfqId`, including quotation revisions and revision lines.
3. `RfqSupplierParticipation.findMany` with the same `tenantId` and exact `rfqId`, including Supplier identity.

The repository never loads a bounded procurement snapshot or RFQ list to locate the requested record. A record outside the signed tenant returns the same 404 contract as a missing record.

RFQ, participation, quotation, and revision statuses are normalized at the repository boundary through `server/domain/procurement-status-authority.mjs`. Historical aliases are accepted only as input; the detail DTO emits canonical values or `null` for an invalid status.

## Participation and revision authority

Supplier participation now comes from `RfqSupplierParticipation`; it is no longer inferred from legacy RFQ counters. A quotation-linked supplier remains visible as a response fact even if a future inconsistent record lacks participation, but that fallback is labelled as quotation-sourced rather than invitation authority. Internal participation does not claim email delivery, Supplier Portal identity, external login, or online submission.

Quotation history now comes from append-only `SupplierQuotationRevision` rows. The maximum `revisionNumber` is the sole latest authority. The DTO exposes the latest revision, ordered history, revision lines, and `revisionAuthority.available=true`; it does not maintain or infer a separate `isLatest` database flag.

Related PR, PO, RFQ, and quotation IDs are emitted only when the corresponding explicit relation exists on the RFQ or quotation record. No supplier, SKU, amount, or evidence relationship is inferred by name matching.

## Failure contract

The route preserves the procurement read contract: 400 for an unsupported type, 401 for an invalid session or missing tenant context, 404 for a missing or tenant-invisible RFQ, and 500 for an unhandled service failure after the normal runtime redaction boundary. The page distinguishes loading, malformed ID, not found, unauthenticated, forbidden, temporary service failure, and network-unavailable states.

RFQ response/revision HTTP writes are now available only through the internal authorized command kernel. The separate Comparison read contract is tenant-scoped and fact-only; it does not rank or recommend. This UI phase still adds no response/revision form, award, PO draft conversion, Supplier Portal, external identity, email, or AI mutation.
