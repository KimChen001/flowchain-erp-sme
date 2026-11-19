# Phase 4B Return & Quarantine Foundation — Architecture Audit and Delivery Plan

Status: approved; Phase 4B.0 through Phase 4B.3 passed; Phase 4B.4 local gate passed and remote gate pending

Branch base: `origin/main` at `81bc6ce23a7be8c0d3ca5f057cb2fa2a5b07b4ff`

Implementation branch: `codex/returns-finance-foundation`

## 1. Reusable capabilities

### Receiving transaction kernel

The Receiving kernel already provides the required inbound transaction pattern:

- PostgreSQL-only authoritative commands with no JSON fallback.
- Shared preview and command policy.
- `DECIMAL(18,4)` persistence and scaled-integer transaction arithmetic.
- `SERIALIZABLE` transactions, row locks, optimistic versions, and stable conflicts.
- Durable idempotency through `BusinessCommandExecution`.
- Immutable `InventoryMovement` facts grouped by `postingBatchId`.
- Compensating reversal movements linked through `reversalOfMovementId` and
  `reversedByMovementId`.
- Signed tenant identity, warehouse scope, audit events, evidence, smart links,
  and reconciliation.

Customer return receipt can reuse this command shape, but must post into a
quarantine balance rather than an available inventory balance.

### Outbound transaction kernel

The Outbound kernel provides the required physical decrease pattern:

- Cumulative quantity validation across lines and allocations.
- Stable balance locking and versioned updates.
- Safe decrease of on-hand inventory without consuming reserved stock.
- Strict original-movement validation before reversal.
- Document, line, reservation, balance, movement, and audit updates in one
  serializable transaction.
- Fail-closed tenant, role, warehouse read, and warehouse operate scope.

Supplier return dispatch can reuse this structure, but it must be authorized by
a Return Authorization and must support either an available-inventory source or
a quarantine source.

### Inventory Operations kernel

Phase 4A and 4A.1 provide:

- Shared balance-impact aggregation by balance ID.
- One lock and one update per affected balance.
- Deterministic fixed-scale net impacts.
- Preview/command parity.
- Strict per-line movement identity checks.
- Reversal that appends compensation and never edits original quantities.
- Per-line reconciliation where offsetting errors cannot produce `matched`.
- Partial-scope reconciliation as `unavailable`, not a false success.
- Capability-default fail closed and sanitized internal database failures.

Return posting should reuse these utilities or extract a common internal
transaction utility without weakening the existing three kernels.

### Shared platform capabilities

The following existing models and services are directly reusable:

- `BusinessCommandExecution` for idempotency.
- `InventoryMovement` for immutable physical facts.
- `AuditLog` for human and command evidence.
- `UserWarehouseScope`, signed pilot identity, and read/operate authorization.
- Capability registry conventions: `beta`, `databaseOnly`,
  `requiresExplicitEnable`.
- Workbench conventions for detail, preview, evidence, links, reconciliation,
  disabled capability, loading, empty, and error states.
- Isolated embedded PostgreSQL verification harnesses.

## 2. Recommended data model

### Architectural decision: quarantine is a separate balance type

Do not represent quarantine by:

- an ordinary `InventoryBalance.status`;
- a special location name;
- an inventory adjustment;
- a negative reservation;
- a metadata-only flag.

`InventoryBalance` currently means sellable/operational inventory and enforces:

```text
available = onHand - reserved
```

Quarantine has no available quantity and cannot be reserved. Adding quarantine
to the existing natural key would require changing every frozen Receiving,
Outbound, Transfer, Count, and Adjustment lookup. A dedicated balance prevents
quarantine from entering selectors, ATP, reservation, or available inventory by
accident.

### `QuarantineInventoryBalance`

Recommended fields:

```text
id
tenantId
itemId
sku
itemName
warehouseId
warehouseKey
location
locationKey
onHandQuantity Decimal(18,4)
unit
status: active | closed
version
metadata
createdAt
updatedAt
```

Natural key:

```text
tenantId + sku + warehouseKey + locationKey
```

Hard invariants:

- `onHandQuantity >= 0`
- no reserved field;
- no available field;
- never returned by the available inventory selector;
- never accepted by Sales Reservation;
- warehouse and item identity must match every movement.

### `ReturnRequest`

Represents the business request, not the physical inventory event.

Recommended fields:

```text
id
tenantId
requestNumber
returnType: supplier_return | customer_return
partnerId
partnerNameSnapshot
sourceDocumentType
sourceDocumentId
reasonCode
reasonDetail
workflowStatus
requestedAt
requestedById
submittedAt
submittedById
cancelledAt
cancelledById
cancellationReason
version
metadata
createdAt
updatedAt
```

Source document rules:

- Supplier Return normally references a Receiving Document, Purchase Order, or
  supplier-facing source explicitly approved by policy.
- Customer Return references a Sales Order or Shipment Document.
- A source snapshot is retained so later master-data changes do not rewrite the
  return evidence.

### `ReturnRequestLine`

Recommended fields:

```text
id
returnRequestId
sourceDocumentLineId
itemId
sku
itemName
requestedQuantity Decimal(18,4)
unit
reasonCode
conditionCode
version
metadata
```

Line quantities are cumulative against the referenced source line. Duplicate
source lines are either rejected or aggregated by a shared request policy; the
recommended contract is to reject duplicates in the same request to keep
authorization evidence unambiguous.

### `ReturnAuthorization`

Authorization is separate from the request so approval facts remain explicit.

Recommended fields:

```text
id
tenantId
authorizationNumber
returnRequestId
workflowStatus
authorizedAt
authorizedById
rejectedAt
rejectedById
rejectionReason
expiresAt
version
metadata
createdAt
updatedAt
```

One request has at most one active authorization. Rejected or expired
authorizations remain historical.

### `ReturnAuthorizationLine`

Recommended fields:

```text
id
returnAuthorizationId
returnRequestLineId
authorizedQuantity Decimal(18,4)
dispositionRoute:
  receive_to_quarantine |
  return_from_available |
  return_from_quarantine |
  release_quarantine_to_available |
  retain_in_quarantine
version
metadata
```

Authorization quantity cannot exceed requested quantity or the remaining
unexecuted authorized quantity.

### `ReturnPostingDocument`

Represents one physical execution. Multiple partial postings may consume one
authorization.

Recommended fields:

```text
id
tenantId
postingNumber
returnAuthorizationId
postingType:
  customer_return_receipt |
  supplier_return_dispatch |
  quarantine_release
workflowStatus: draft | ready | cancelled
postingStatus: unposted | posted | reversed
warehouseId
version
postedAt
postedById
reversedAt
reversedById
reversalReason
metadata
createdAt
updatedAt
```

### `ReturnPostingLine`

Recommended fields:

```text
id
returnPostingId
returnAuthorizationLineId
itemId
sku
itemName
quantity Decimal(18,4)
unit
warehouseId
location
locationKey
inventoryBalanceId nullable
quarantineBalanceId nullable
destinationInventoryBalanceId nullable
version
metadata
```

Exactly the balance references required by the posting type must be present.
The command must not infer a balance from SKU alone.

### Existing `InventoryMovement`

Reuse the existing movement table with new formal movement types:

```text
customer_return_quarantine_in
customer_return_quarantine_reversal_out
supplier_return_out
supplier_return_reversal_in
quarantine_release_out
quarantine_release_available_in
quarantine_release_reversal_available_out
quarantine_release_reversal_in
```

Movement requirements:

- `sourceDocumentType = ReturnPostingDocument`
- `sourceDocumentId = posting.id`
- `sourceDocumentLineId = postingLine.id`
- common `postingBatchId` per command
- `relatedReturnId = returnRequest.id`
- metadata identifies `inventoryBalanceId` or `quarantineBalanceId`
- original movements are immutable
- reversal links are mandatory

## 3. Inventory mathematics

All quantities use four-decimal scaled integer arithmetic. JavaScript floating
point is never authoritative.

### Customer return receipt

Customer return receipt must enter quarantine:

```text
quarantine.onHandAfter = quarantine.onHandBefore + Q
available inventory change = 0
reserved inventory change = 0
```

It must never create or increase an ordinary `InventoryBalance`.

### Supplier return from available inventory

```text
inventory.onHandAfter = inventory.onHandBefore - Q
inventory.reservedAfter = inventory.reservedBefore
inventory.availableAfter = inventory.availableBefore - Q
```

Required safety:

```text
Q > 0
availableBefore >= Q
onHandAfter >= reservedBefore
```

### Supplier return from quarantine

```text
quarantine.onHandAfter = quarantine.onHandBefore - Q
```

Required safety:

```text
Q > 0
quarantine.onHandBefore >= Q
```

### Quarantine release to available inventory

This is a controlled disposition, not an adjustment:

```text
quarantine.onHandAfter = quarantine.onHandBefore - Q
inventory.onHandAfter = inventory.onHandBefore + Q
inventory.reservedAfter = inventory.reservedBefore
inventory.availableAfter = inventory.availableBefore + Q
```

The two legs share one posting batch. Tenant, item, SKU, unit, warehouse, and
location policy must match the approved disposition.

### Aggregate rules

- Aggregate impacts by balance ID and balance type.
- Lock natural keys in deterministic order.
- Update each balance once.
- Validate cumulative outbound demand, not individual lines only.
- Reject a posting whose net plan creates no physical movement.
- Never allow positive and negative line errors to cancel in reconciliation.

## 4. State machines

### Return Request

```text
draft
  -> submitted
  -> cancelled

submitted
  -> authorized
  -> rejected
  -> cancelled

authorized
  -> partially_executed
  -> executed
  -> cancelled only when no posting exists

partially_executed
  -> executed
```

Request lines are editable only in `draft`. Submission freezes source identity,
reason, item, SKU, unit, and requested quantity.

### Return Authorization

```text
draft
  -> approved
  -> rejected
  -> cancelled

approved
  -> partially_executed
  -> executed
  -> expired
  -> cancelled only when no posting exists

partially_executed
  -> executed
  -> executed by "close remaining": the unexecuted remainder is recorded
     as closedQuantity per line (2026-11-15, audit batch A9)
```

Approval freezes authorized quantity and disposition route. Cancel and expire
ignore cancelled drafts and reversed postings; open drafts must be cancelled or
posted first. After a close the request is executed while any receipt or
supplier dispatch stays posted, otherwise submitted.

### Return Posting

```text
draft -> ready -> posted -> reversed
draft -> cancelled
ready -> cancelled
```

Posting and reversal are immutable transaction boundaries. A posted document is
never edited back to draft.

### Quarantine disposition

Quarantine balance itself is not a workflow document. Its quantity changes only
through posted Return Posting documents. The authorization line records the
governed disposition decision.

## 5. API commands and read surfaces

### Request and authorization

```text
POST /api/returns/requests/preview
POST /api/returns/requests
PATCH /api/returns/requests/:id
POST /api/returns/requests/:id/submit-preview
POST /api/returns/requests/:id/submit
POST /api/returns/requests/:id/cancel-preview
POST /api/returns/requests/:id/cancel

POST /api/returns/requests/:id/authorization-preview
POST /api/returns/requests/:id/authorize
POST /api/returns/requests/:id/reject
```

### Physical posting

```text
POST /api/returns/authorizations/:id/postings/preview
POST /api/returns/authorizations/:id/postings
PATCH /api/returns/postings/:id
POST /api/returns/postings/:id/ready-preview
POST /api/returns/postings/:id/ready
POST /api/returns/postings/:id/post-preview
POST /api/returns/postings/:id/post
POST /api/returns/postings/:id/reverse-preview
POST /api/returns/postings/:id/reverse
```

Every mutation requires:

- signed tenant and actor identity;
- explicit capability;
- expected document version;
- idempotency key for state-changing commands;
- warehouse operate scope for every physical balance;
- the same shared policy for preview and command.

### Read surfaces

```text
GET /api/returns/requests
GET /api/returns/requests/:id/workbench
GET /api/returns/authorizations/:id/workbench
GET /api/returns/postings/:id/workbench
GET /api/returns/postings/:id/evidence
GET /api/returns/postings/:id/links
GET /api/returns/postings/:id/reconciliation
GET /api/inventory/quarantine-balances
GET /api/inventory/quarantine-balances/:id
```

Reads remain available when mutation capability is disabled. Available actions
must be false and direct mutation must return a stable 409.

## 6. Reversal rules

Reversal must verify every original movement before any balance update:

- tenant ID;
- source document type, ID, and line ID;
- movement type;
- item ID and SKU;
- warehouse and location;
- quantity direction and exact four-decimal amount;
- posting batch;
- balance metadata;
- original movement is not already reversed;
- posting and authorization remain linked;
- no later disposition has consumed the same quarantine quantity.

### Customer receipt reversal

- Decrease the exact quarantine balance.
- Require sufficient quarantine on-hand.
- Refuse reversal after any downstream supplier return or release-to-available
  disposition consumes the received quantity.

### Supplier return reversal

- Restore the exact source balance type.
- Available-source reversal increases on-hand and available; reserved remains
  unchanged.
- Quarantine-source reversal increases quarantine on-hand.

### Quarantine release reversal

- Decrease available inventory only when available inventory is sufficient and
  on-hand remains at least reserved.
- Restore quarantine quantity.
- Append both compensating legs under a new posting batch.

Any mismatch returns a stable 409 such as:

```text
RETURN_REVERSAL_NOT_SAFE
```

No balance update, audit success event, or compensating movement may remain
after failure.

## 7. Scope and role matrix

| Role | Read | Create/revise request | Submit request | Authorize/reject | Physical post | Reverse |
| --- | --- | --- | --- | --- | --- | --- |
| Admin | All tenant warehouses | Yes | Yes | Yes | Yes | Yes |
| Manager | Warehouse read scope | Yes | Yes | Yes | Operate scope | Operate scope |
| Business Specialist | Warehouse read scope | Yes | Yes | No | Operate scope with approved authorization | No |
| Buyer | Relevant supplier-return scope | Supplier return only | Supplier return only | No | No | No |
| Viewer | Warehouse read scope | No | No | No | No | No |

Additional rules:

- Supplier Return from available inventory requires operate scope on the source
  warehouse.
- Customer Return receipt requires operate scope on the quarantine warehouse.
- Quarantine release requires operate scope for both quarantine and available
  balance effects.
- Cross-scope reads are masked as not found.
- Partial-scope evidence returns `unavailable` with
  `PARTIAL_WAREHOUSE_SCOPE`.
- Request partner or source-document access never grants warehouse permission.
- Reversal is Manager/Admin only because it changes already-posted physical
  facts.

## 8. PostgreSQL and browser tests

The dedicated command must require zero failed and zero skipped tests.

### Migration tests

- Fresh deployment applies all migrations.
- Upgrade from the Phase 4A main schema preserves existing balances, movements,
  reservations, and documents.
- Quarantine natural-key duplicate preflight fails without modifying rows.
- Existing Receiving, Outbound, Transfer, Count, and Adjustment behavior remains
  unchanged.

### Request and authorization tests

- Supplier request cannot exceed received/source quantity.
- Customer request cannot exceed shipped/source quantity.
- Cross-tenant source documents fail closed.
- Authorization cannot exceed request quantity.
- Duplicate source line and changed source identity are rejected.
- Rejected, expired, cancelled, or exhausted authorization cannot post.

### Customer return receipt tests

- Receipt increases quarantine only.
- Ordinary available inventory remains unchanged.
- Same key replays once; changed payload conflicts.
- Concurrent receipts cannot exceed authorized quantity.
- A customer receipt can never select `InventoryBalance` as its destination.

### Supplier return tests

- Available-source return decreases on-hand and available, never reserved.
- Available-source return cannot consume reserved stock.
- Quarantine-source return decreases quarantine.
- Repeated lines aggregate by source balance and update it once.
- Concurrent supplier returns cannot overdraw the source.

### Quarantine release tests

- Release decreases quarantine and increases available inventory atomically.
- Two legs share one posting batch and reconcile to zero total tenant inventory
  change.
- Release cannot exceed quarantine quantity.
- Release does not change reserved inventory.

### Reversal integrity tests

Tampering with any of the following must fail closed:

- quantity;
- movement type;
- item or SKU;
- warehouse or location;
- available/quarantine balance ID;
- posting batch;
- source document or line;
- reversal link.

Downstream-consumed quarantine blocks customer receipt reversal.

### Scope and capability tests

- Missing capability leaves reads available and every action false.
- Disabled direct mutation returns 409.
- Viewer and Buyer physical mutations are denied.
- Missing warehouse read scope masks the document.
- Missing operate scope blocks posting.
- Partial scope reconciliation is unavailable.
- Prisma codes, SQL, constraint names, URLs, and stacks never leak.

### Reconciliation tests

- Per-line movement and balance facts match.
- Different line errors cannot offset.
- Reversed chains require exact original and compensating links.
- Customer receipt proves no available-inventory increase.
- Supplier return proves the correct source bucket decreased.
- Quarantine release proves paired balance effects.

### Playwright

One real PostgreSQL workbench flow should cover:

1. create and submit a request;
2. manager authorization;
3. customer receipt into quarantine;
4. quarantine displayed separately from available inventory;
5. controlled release or supplier return;
6. evidence and reconciliation;
7. safe reversal;
8. disabled capability;
9. role and warehouse-scope denial.

Stateful PostgreSQL specs must not retry against a database already mutated by a
failed attempt.

## 9. Phased delivery plan

### Phase 4B.0 — Quarantine data foundation

- Add `QuarantineInventoryBalance`.
- Add Return Request, Authorization, Posting, and line models.
- Add check constraints, indexes, relations, and upgrade preflight.
- Add beta/database-only capabilities and environment flag.
- Add selectors that explicitly separate available and quarantine stock.
- Add migration fresh/upgrade tests.

Gate: schema, migration, capability, selectors, and all Phase 4A regression
tests pass.

### Phase 4B.1 — Request and authorization kernel

- Implement formal request and authorization policies.
- Add state transitions, source-document validation, roles, scopes, audit, and
  workbench reads.
- No inventory mutation in this phase.

Gate: Node/API tests prove request/authorization governance and non-mutation.

### Phase 4B.2 — Supplier Return transaction kernel

- Implement preview-first dispatch from available or quarantine source.
- Add cumulative balance aggregation, serializable posting, movements, evidence,
  reconciliation, and reversal.

Gate: real PostgreSQL/API tests, zero failures and zero skips.

### Phase 4B.3 — Customer Return Receipt transaction kernel

- Implement receipt only into quarantine.
- Prove ordinary available inventory is unchanged.
- Add downstream-consumption-aware reversal.

Gate: real PostgreSQL/API tests plus existing Receiving and Outbound regression.

### Phase 4B.4 — Controlled quarantine disposition

- Implement approved release from quarantine to available inventory.
- Add paired movements, strict reversal, and partial-scope reconciliation.
- Do not add scrap or accounting behavior.

Gate: real PostgreSQL/API tests and line-level reconciliation tests.

### Phase 4B.5 — Product workbench and acceptance

- Add Return and Quarantine navigation, lists, detail workbenches, previews,
  evidence, links, reconciliation, and explicit read-only disabled states.
- Add real PostgreSQL Playwright.
- Run the full Receiving, Reports, Outbound, Inventory Operations, Return, and
  Pilot gates locally and in CI.

## 10. Explicitly out of scope

Phase 4B will not implement:

- lot or serial tracking;
- barcode or mobile scanning;
- carrier, parcel, label, or tracking integration;
- refunds, payments, or settlement;
- credit memo or debit memo;
- Accounts Receivable or Accounts Payable posting;
- COGS, valuation, FIFO, average cost, landed cost, or full accounting;
- automatic AI authorization, posting, disposition, or reversal;
- two-step or in-transit warehouse transfer;
- automatic restocking of customer returns;
- automatic supplier claims;
- repair, refurbishment, scrap, or destruction execution;
- RMA portal or external partner self-service;
- images, inspection devices, or quality laboratory integration.

These exclusions must remain visible in capability metadata, product copy, API
errors, and acceptance documentation. No unsupported behavior may be simulated
with adjustments, invented exchange rates, metadata-only inventory, or JSON
authoritative transactions.
