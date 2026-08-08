# RFQ Supplier Comparison Read v1

## Boundary

`GET /api/procurement/rfqs/:rfqId/comparison` is an internal, tenant-scoped, read-only comparison contract. It requires authentication and `procurement.prices.read`. It reads the RFQ and each `SupplierQuotation` aggregate in one Repeatable Read snapshot.

The endpoint displays facts side by side. It does not rank suppliers, calculate a score, recommend a winner, create an award, approve anything, or convert an RFQ to a purchase order.

## Authority

For every quotation, the only commercial authority is the maximum `revisionNumber`. The mutable `SupplierQuotation` header is not used for current amount, currency, status, or line values. A quotation without a revision is returned as `revision_missing` with no commercial fallback.

Response lines are mapped to the target RFQ by exact `rfqLineId`. Each line declares `exact_target_rfq_line`, `different_rfq_line`, or `unlinked`. Coverage is `complete`, `partial`, `none`, or `not_applicable`, with missing target line IDs listed explicitly.

Amounts, prices, and quantities are returned as four-decimal strings. The comparison contract never converts Decimal values to JavaScript numbers. When authoritative revisions use multiple currencies, the response state is `multi_currency_unconverted`; no exchange rate or normalized total is invented.

## Contract facts

The response includes:

- RFQ identity, canonical status, currency, and exact RFQ lines;
- deterministic SupplierQuotation order by Supplier ID;
- latest revision ID, number, status, dates, payment terms, currency, amount, and lines;
- exact coverage and missing-line facts;
- summary counts for quotations, authoritative revisions, submitted responses, and complete coverage;
- `rankingAuthority`, `recommendationAuthority`, `awardAuthority`, and `poConversionAuthority`, each explicitly `unavailable`;
- limitations for missing revisions, partial coverage, and multi-currency data.

The availability state is descriptive only: `no_authoritative_responses`, `single_authoritative_response`, `side_by_side_available`, or `multi_currency_unconverted`.

## Error and security boundary

Missing authentication returns 401. Missing price permission returns 403. An RFQ outside the signed tenant is masked as 404. Unexpected persistence failures return a redacted 500. The route never trusts tenant, actor, role, supplier, amount, rank, or recommendation values from the request.

## Next phase

An internal UI may consume this contract after the command kernel and process-level HTTP gates remain green. Evaluation criteria, human recommendation review, award commands, and PO conversion require separate authority designs and are not part of this read model.
