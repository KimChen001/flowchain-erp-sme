# RFQ Supplier Comparison Read v1

## Boundary

`GET /api/procurement/rfqs/:rfqId/comparison` is an internal, tenant-scoped, read-only comparison contract. It requires authentication and `procurement.prices.read`. In one Repeatable Read snapshot it performs three bounded reads: the exact RFQ with lines, SupplierQuotation aggregates with only each maximum revision, and exact-RFQ Supplier Participation with Supplier identity.

The endpoint displays facts side by side. It does not rank suppliers, calculate a score, recommend a winner, create an award, approve anything, or convert an RFQ to a purchase order.

## Authority

For every quotation, the only commercial authority is the maximum `revisionNumber`. The mutable `SupplierQuotation` header is not used for current amount, currency, status, or line values. A quotation without a revision is returned as `revision_missing` with no commercial fallback.

Response lines are mapped to the target RFQ by exact `rfqLineId`. Each line declares `exact_target_rfq_line`, `different_rfq_line`, or `unlinked`. Coverage is `complete`, `partial`, `none`, or `not_applicable`, with missing target line IDs listed explicitly.

Amounts, prices, and quantities are returned as four-decimal strings. The comparison contract never converts Decimal values to JavaScript numbers. When eligible revisions use multiple currencies, the response state is `multi_currency_unconverted`; no exchange rate or normalized total is invented.

## Comparison eligibility

Visibility and eligibility are separate. Every quotation remains visible, but only a latest `submitted` or `shortlisted` revision with complete exact RFQ-line coverage is `eligible`. A `draft` or `incomplete` revision is `not_ready`; `not_selected` is `historical_only`; `withdrawn` is `withdrawn`; a submitted/shortlisted revision without complete coverage is `incomplete_coverage`; a missing revision is `authority_missing`; and an unrecognized canonical state is `unknown_status`. Each response includes stable `eligibilityReasons`.

`comparisonAvailability` is derived only from `eligible` responses: zero is `no_eligible_responses`, one is `single_eligible_response`, two or more in one currency is `side_by_side_available`, and two or more across currencies is `multi_currency_unconverted`. Non-eligible amounts never influence that state.

## Participation context

`participationSummary` counts exact-RFQ internal Participation facts by `planned`, `invited_internal`, `response_recorded`, `declined`, `withdrawn`, and `closed`. `nonResponseParticipants` lists only participants without a SupplierQuotation aggregate; it never creates a synthetic quotation response.

Participation authority is internal only. `invitationDeliveryAuthority` and `externalSupplierIdentityAuthority` remain `unavailable`; `invited_internal` does not prove email delivery, a Supplier Portal identity, an external login, or online submission.

## Contract facts

The response includes:

- RFQ identity, canonical status, currency, and exact RFQ lines;
- deterministic SupplierQuotation order by Supplier ID;
- latest revision ID, number, status, dates, payment terms, currency, amount, and lines;
- per-response `comparisonEligibility` and stable reasons without hiding non-eligible evidence;
- exact coverage and missing-line facts;
- summary counts for quotations, authoritative revisions, submitted responses, complete coverage, and eligible responses;
- internal Participation summary plus suppliers with Participation but no quotation aggregate;
- `rankingAuthority`, `recommendationAuthority`, `awardAuthority`, and `poConversionAuthority`, each explicitly `unavailable`;
- limitations for missing revisions, partial coverage, and multi-currency data.

The availability state is descriptive only: `no_eligible_responses`, `single_eligible_response`, `side_by_side_available`, or `multi_currency_unconverted`.

## Error and security boundary

Missing authentication returns 401. Missing price permission returns 403. An RFQ outside the signed tenant is masked as 404. Unexpected persistence failures return a redacted 500. The route never trusts tenant, actor, role, supplier, amount, rank, or recommendation values from the request.

## Next phase

An internal UI may consume this contract after the command kernel and process-level HTTP gates remain green. Evaluation criteria, human recommendation review, award commands, and PO conversion require separate authority designs and are not part of this read model.
