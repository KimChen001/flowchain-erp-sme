# RFQ Supplier Response Command v1

## Boundary

This command kernel lets authorized internal procurement users record the first response for one RFQ/Supplier pair and append immutable quotation revisions. It is an internal capture workflow only. It does not prove that an invitation was delivered or that a supplier authenticated or submitted data externally.

The two permissions are:

- `procurement.rfq_response.create`
- `procurement.rfq_response.revise`

Both are high-risk write permissions. Tenant and actor identity come only from the resolved signed session.

## HTTP contracts

Initial response:

```text
POST /api/procurement/rfqs/:rfqId/supplier-responses
```

The body contains `supplierId`, `expectedVersion: 0`, `submissionMode`, `currency`, optional commercial dates and payment terms, and one or more lines. Each line requires an exact `rfqLineId`, positive fixed-precision quantity, non-negative fixed-precision unit price, and optional delivery date.

Append revision:

```text
POST /api/procurement/rfqs/:rfqId/supplier-responses/:supplierId/revisions
```

`expectedVersion` is the current maximum quotation `revisionNumber`. An initial response creates Revision 1. Appending after Revision 1 requires `expectedVersion: 1` and returns `entityVersion: 2` when Revision 2 commits.

Both routes accept the idempotency key in `Idempotency-Key`; the body field `idempotencyKey` remains available for existing internal clients. The header takes precedence.

## Transaction authority

Each command performs one Serializable transaction after resolving and authorizing the signed actor:

```text
canonical request hash and replay check
  -> replay check inside transaction
  -> pending BusinessCommandExecution
  -> tenant-scoped RFQ lock and status validation
  -> tenant-scoped Supplier lock
  -> Participation lock and transition validation
  -> SupplierQuotation aggregate lock and expectedVersion check
  -> exact RFQ line validation
  -> Participation write
  -> stable quotation aggregate creation when initial
  -> immutable revision and revision-line inserts
  -> current quotation summary update
  -> AuditLog and DomainChangeFeed
  -> completed BusinessCommandExecution
  -> commit
```

RFQ, Supplier, Participation, quotation, revision, revision lines, summary, audit, change feed, and command completion either commit together or all roll back. Fault-injection tests cover failures after Participation, after revision insertion, before audit, and before command completion.

## Idempotency and concurrency

The canonical request hash includes command kind, RFQ, Supplier, expected version, normalized commercial values, and RFQ lines sorted by ID. Therefore line ordering does not change request identity.

- Same key and same canonical payload returns the committed result with `idempotentReplay: true`.
- Same key and different payload returns `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` (409).
- A pending command returns `COMMAND_EXECUTION_IN_PROGRESS` (409).
- A stale `expectedVersion` returns `RFQ_RESPONSE_VERSION_CONFLICT` (409) with the expected and current revision numbers and a reload action.
- Serialization and unique-insert races return `RFQ_RESPONSE_CONCURRENCY_CONFLICT` (409).

The quotation row lock serializes normal append attempts. Database uniqueness on `tenantId + quotationId + revisionNumber` remains the final concurrent-insert authority.

## Workflow rules

Responses are accepted only for canonical RFQ status `open` or `collecting_quotes`. Draft, closed, cancelled, and unknown RFQ states reject the command.

Participation transitions are:

- Missing: create `response_recorded`, `invitedAt = null`, and set `respondedAt`.
- `planned`: transition to `response_recorded` and increment Participation version.
- `invited_internal`: transition to `response_recorded`, preserve `invitedAt`, set `respondedAt`, and increment version.
- `response_recorded`: revision append is allowed; initial create still rejects an existing quotation aggregate.
- `declined`, `withdrawn`, or `closed`: reject until a separate future reopen command exists.

## Line and Decimal policy

Every command-created line must reference an RFQ line from the signed tenant and exact target RFQ. Duplicate RFQ line IDs are rejected before writing. Submitted responses must include every RFQ line exactly once; drafts may be partial and are stored as `incomplete`, or `draft` when all lines are present.

Quantity and unit price are parsed as scaled integers with four fractional digits. The server calculates each line amount using exact integer multiplication and half-up rounding to four places, then sums the rounded line amounts. The Decimal(18,4) boundary is checked before persistence. Client totals are neither accepted nor trusted, and JavaScript floating-point arithmetic is not commercial authority.

## Quotation authority

`SupplierQuotation` is the unique stable aggregate for `tenantId + rfqId + supplierId`. Its status, currency, amount, submitted time, and safe metadata are only a current summary projection for compatibility reads.

`SupplierQuotationRevision` and `SupplierQuotationRevisionLine` are the authoritative commercial history. The latest revision is always the maximum `revisionNumber`; historical rows are never updated or deleted. The command does not dual-write legacy `SupplierQuotationLine` rows.

## Audit and errors

AuditLog records the command type, actor, RFQ, Supplier, quotation, revision, submission mode, and idempotency reference. DomainChangeFeed records the quotation entity version, actor, payload hash, procurement module, `procurement.prices.read` authorization class, and tenant scope.

Stable responses use 401 for missing authentication, 403 for missing exact permission, tenant-masked 404 for RFQ/Supplier absence, 409 for workflow/idempotency/version/concurrency conflicts, and 422 for malformed commercial input. Unexpected failures return a redacted 500 without Prisma details, SQL, environment values, paths, or stack traces.

## Non-goals

This version adds no response form or revision button, Supplier Portal, email delivery, external identity, public submission, comparison, scoring, award, approval, PO conversion, AI mutation, automatic communication, deletion, or overwrite. A later UI phase may call these commands after its interaction and authorization design is reviewed.
