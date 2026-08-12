# RFQ Supplier Comparison UI v1

## Canonical surface

- Route: `/app/procurement/rfq/:id/comparison`
- Navigation entry: read-only `比较供应商报价` from canonical RFQ detail
- API: `GET /api/procurement/rfqs/:rfqId/comparison`
- Permission: `procurement.prices.read`
- Classification: Procurement Core
- Read maturity: `AUTHORITATIVE`
- Write maturity: `UNAVAILABLE`

The page reads one authoritative Comparison read model. It does not load the RFQ list or reconstruct quotations in the browser. Supplier display order follows the API's `supplier_id_ascending` authority.

## Eligibility and display

Only complete latest `submitted` or `shortlisted` revisions are eligible for active comparison. `draft` and `incomplete` remain visible as `not_ready`; `withdrawn` remains visible as `withdrawn`; `not_selected` remains visible as `historical_only`; partial line coverage is `incomplete_coverage`; missing revisions are `authority_missing`. The UI never hides non-eligible evidence.

Decimal amounts are rendered as exact backend strings with their original currency. No browser-side arithmetic, price sorting, ranking, score, recommendation, or winner highlighting is performed.

`validUntil` and `deliveryDate` are rendered as date-only `YYYY-MM-DD` facts without local timezone conversion. `submittedAt` and `generatedAt` remain UTC timestamps.

When eligible responses use more than one currency, the page displays: “报价币种不同，当前未进行汇率换算，因此不能直接比较总金额。” No FX endpoint is called and no conversion is attempted.

## Participation context

The Participation summary and `已参与但尚无报价` section use the same authoritative snapshot as the comparison response. This section only contains suppliers with an authoritative Participation record and no SupplierQuotation aggregate. Suppliers with draft, incomplete, withdrawn, or otherwise non-eligible quotations remain in the quotation response matrix and are not synthetic non-response rows. The section shows internal participation states and internal invitation timestamps only. It does not claim email delivery, portal acceptance, supplier login, or external submission, and it does not create synthetic quotation rows.

## Failure states and non-goals

The route has explicit loading, malformed ID, 401, 403, 404, 500, network, empty, draft-only, single-response, multi-response, and multi-currency states. There is no fallback reconstruction in the page.

This version is read-only. Award Command, recommendation, scoring, supplier selection, PO conversion, Supplier Portal, external supplier login/public submission, email delivery, FX conversion, and AI mutation are intentionally unavailable.

## Next phase

The next governed phase is a Reviewed Award Decision. This document does not define its command, persistence, approval, or conversion design.

## Acceptance

`tests/browser/canonical-rfq-comparison.spec.ts` runs against PostgreSQL-backed scenario data and checks the canonical API, browser history/direct refresh, line matrix, commercial terms, non-response participants, multi-currency messaging, failure states, no writes, no Award/PO controls, and zero console/page errors.
