# Reviewed RFQ Award Decision v1

## Purpose and boundary

This authority records an explicit human decision to award one RFQ to one Supplier using one exact `SupplierQuotationRevision`. It does not rank, score, recommend, automatically select a Supplier, mutate quotations, close the RFQ, communicate with Suppliers, or create a Purchase Order.

The canonical persistence authority is the immutable `RfqAwardDecision` row. Legacy `Rfq.awardedSupplier`, `Rfq.supplierId`, and `Rfq.bestPrice` fields are compatibility data and are not inferred or backfilled into formal Award Decisions.

## Pilot invariants

- One tenant-scoped RFQ has at most one formal Award Decision.
- The Award references one exact Supplier, SupplierQuotation, Revision id, and revision number.
- Composite foreign keys prove that the Quotation belongs to the selected RFQ and Supplier, and that the Revision belongs to the selected Quotation at the recorded revision number.
- The exact Revision must still be the latest revision when the Serializable transaction runs.
- Only complete `submitted` or `shortlisted` revisions are eligible, using the same shared eligibility authority as the Comparison read model.
- The RFQ must canonically be `collecting_quotes`.
- `decisionReason` is required, human-authored text with a maximum length of 2000 characters.
- `currency` and `quotedAmount` are copied from the authoritative Revision. Client commercial values are rejected.
- PostgreSQL rejects UPDATE and DELETE against `RfqAwardDecision`.
- Once an Award exists, initial Supplier Responses and appended Revisions for that RFQ return `409 RFQ_RESPONSE_AWARD_EXISTS`. This write freeze uses the RFQ row lock shared by both command kernels; it does not change RFQ status.

## Authorization

The command requires the high-risk permission `procurement.rfq_award.create`. Fresh and upgraded default role grants are limited to Workspace Administrator and Operations Manager. Procurement Specialist and Read-only Viewer do not receive this permission.

The exact read uses the existing sensitive commercial permission `procurement.prices.read`.

## Command API

`POST /api/procurement/rfqs/:rfqId/award-decisions`

```json
{
  "supplierId": "SUP-001",
  "quotationId": "SQ-001",
  "quotationRevisionId": "SQR-003",
  "expectedQuotationRevisionNumber": 3,
  "decisionReason": "Commercial terms and delivery commitment reviewed.",
  "idempotencyKey": "uuid"
}
```

`Idempotency-Key` may supply the key as an HTTP header. The canonical request hash excludes the key and includes the selected exact authority plus the decision reason.

The command resolves signed identity and tenant, checks the exact permission, replays completed executions, opens a Serializable transaction, locks the RFQ, Supplier, Quotation, and latest Revision, validates workflow and eligibility, creates the immutable Award, writes AuditLog and DomainChangeFeed evidence, and completes BusinessCommandExecution atomically.

Award and Supplier Response commands both lock the RFQ first. Therefore an Award selecting Revision N and an append of Revision N+1 cannot both commit: the append either commits first and makes the Award stale, or the Award commits first and freezes the append.

Same key and same canonical payload returns the original Award with `idempotentReplay: true`. Same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`. A different key for an RFQ that already has an Award returns `409 RFQ_AWARD_ALREADY_EXISTS`. Concurrent commands can commit at most one Award.

## Exact read API

`GET /api/procurement/rfqs/:rfqId/award-decision`

An RFQ with no Award returns `200 { "awardDecision": null }`. An existing Award returns the exact Revision reference, actor and timestamps, reason, currency, and four-decimal `quotedAmount` string. Missing or cross-tenant RFQs return 404.

## Evidence

AuditLog records the command type, Award/RFQ/Supplier/Quotation/Revision identities, revision number, actor, decision reason, exact currency and amount, and request id. DomainChangeFeed records `RfqAwardDecision`, operation `create`, entity version 1, actor, source, request id, procurement module, authorization class, and payload hash. Credentials, tokens, database URLs, secrets, and stack traces are excluded.

## Future governed capabilities

The RFQ comparison page exposes this authority only to users with `procurement.rfq_award.create`. The user selects one eligible latest revision, enters a decision reason, confirms the exact supplier, amount, and revision, and accepts a final immutable-record confirmation before the command is sent. Existing decisions are displayed as read-only facts.

Split Award, Re-award, Reversal, and Supersede require separate future authorities. Exactly-once PO Draft Conversion remains a later independent command scope.
