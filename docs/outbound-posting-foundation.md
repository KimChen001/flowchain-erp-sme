# Outbound Posting Foundation

> Phase 3.1 stabilization (2026-07-15): all outbound previews now enforce tenant-owned warehouse read scope; order Item/SKU and balance identity are revalidated; reversal verifies immutable posting movement facts; duplicate shipment numbers have a stable 409; reservation events link to command executions through an additive nullable/restrict FK; posting movements use authoritative item names; and Node 24 is the verified runtime. The product Workbench and lifecycle contracts are documented in `docs/outbound-posting-workbench.md`.

## Scope

Phase 3 adds the authoritative PostgreSQL transaction path from a confirmed Sales Order through reservation, shipment allocation, physical outbound posting, fulfillment, audit, and reversal. It deliberately does not add an Outbound Workbench UI.

## Authoritative data boundary

Formal outbound commands only use PostgreSQL `SalesOrder` aggregates. The legacy file Sales runtime remains a read-only compatibility path and is never copied, converted, or used as a fallback by these commands. Authoritative Sales Order creation/maintenance experience is a Phase 3.5 boundary.

## Inventory mathematics

`availableQuantity = onHandQuantity - reservedQuantity` is checked by policy before every balance mutation. Quantities use four-place scaled `BigInt` arithmetic in policy and `DECIMAL(18,4)` in PostgreSQL; JavaScript floating point is never authoritative.

- Reserve Q: on hand unchanged; reserved `+Q`; available `-Q`.
- Release Q: on hand unchanged; reserved `-Q`; available `+Q`.
- Draft allocation: no balance change.
- Post Q: on hand `-Q`; reserved `-Q`; available unchanged.
- Reverse Q: on hand `+Q`; reserved `+Q`; available unchanged.

Negative inventory and shipment without an active reservation are rejected.

## Sales Order status separation

`workflowStatus`, `reservationStatus`, and `fulfillmentStatus` are independent dimensions. Workflow values are `draft`, `confirmed`, `on_hold`, `cancelled`, and `closed`. Reservation values are `not_reserved`, `partially_reserved`, and `fully_reserved`. Fulfillment values are `not_fulfilled`, `partially_fulfilled`, and `fully_fulfilled`.

## Reservation lifecycle

A reservation records original reserved quantity plus allocated, consumed, and released quantities. Current status is derived as active, partially allocated, allocated, partially consumed, consumed, or released. Rows are retained as history.

Every quantity transition appends an immutable `InventoryReservationEvent`: `reserved`, `released`, `allocated`, `deallocated`, `consumed`, or `restored`.

## Active and allocatable quantities

`activeReservedQuantity = reservedQuantity - consumedQuantity - releasedQuantity`.

`allocatableQuantity = activeReservedQuantity - allocatedQuantity`.

The database and policy enforce non-negative components, `consumed + released <= reserved`, and `allocated <= activeReserved`.

## Shipment Draft allocation

Draft creation validates that each reservation belongs to the same tenant, Sales Order, and Sales Order Line. Repeated reservation entries are checked cumulatively. It creates a ready/unposted Shipment, lines, allocations, and allocated events, but does not change balances, consume reservations, or create movements.

## Shipment cancellation

Only draft/ready and unposted shipments can be cancelled. Cancellation deallocates every allocation, appends deallocated events, and leaves balances and Sales Order Line quantities unchanged.

## Shipment posting

Posting requires ready/unposted state, allocated reservations, sufficient on-hand and reserved balance, warehouse operate scope, and no over-fulfillment. Each allocation becomes one `shipment_posting` movement so a line can ship from multiple warehouse/location keys. Posting consumes reservation allocation, moves Sales Order Line quantity from reserved to fulfilled, and recalculates order statuses.

## Shipment reversal

Reversal requires a reason and a posted, unreversed shipment. It preserves the original movement, appends a `shipment_reversal` movement, links both facts, restores on-hand and reserved inventory, decreases consumed and fulfilled quantities, and does not restore allocated quantity. The original reservation becomes active reserved inventory; it is not automatically released to available.

A shipment billed by a submitted, approved, issued or disputed customer invoice cannot be reversed (`SHIPMENT_REVERSAL_BLOCKED_BY_INVOICE`, 409), because an issued invoice has already produced a receivable for those goods. Customer invoices have no cancel, so the correction for billed goods is a customer return and credit note. A draft invoice does not hold the shipment; submitting it re-validates that the shipment is still posted. `SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES` defines the holding statuses for both this rule and the customer invoice quantity check.

## Inventory Movement facts

Posting movements use `sourceDocumentType=ShipmentDocument`, Shipment ID as `sourceDocumentId`, and Shipment Allocation ID as `sourceDocumentLineId`. They use `quantityOut` and a common posting batch. Reversal movements use `quantityIn`, a new batch, and `reversalOfMovementId`; the original only receives `reversedByMovementId`. Original quantities, source identity, SKU, warehouse, and location remain immutable.

## Balance and Sales Order quantity updates

Balance, reservation, Sales Order Line, Shipment Line, Shipment Allocation, Shipment, and Sales Order updates occur in the same serializable transaction. The line invariant is `reserved >= 0`, `fulfilled >= 0`, and `reserved + fulfilled <= ordered`.

## Shared policy and preview behavior

`outbound-transaction-policy.mjs` supplies six read-only policy builders for reserve, release, draft, cancel, post, and reverse. They accept a Prisma client or transaction client and return normalized input, `allowed`, blocking issues, warnings, balance/reservation/line/order/shipment impacts, and facts to create. Preview APIs call these same builders. Commands lock state and rerun the same policy inside the transaction.

## Idempotency

Every mutation requires an idempotency key. `(tenantId, commandType, idempotencyKey)` is unique in `BusinessCommandExecution`. Object keys and business arrays are stably sorted before SHA-256 hashing. Same key and payload returns the durable prior result, including after restart. A changed payload returns `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`; pending execution returns `COMMAND_EXECUTION_IN_PROGRESS`.

## Concurrency and stable lock ordering

Commands use PostgreSQL `SERIALIZABLE`, version checks, unique constraints, and explicit `SELECT ... FOR UPDATE`. Natural balance keys normalize and sort by tenant, SKU, warehouse, and location. Sales Order Line IDs, Shipment/Allocation IDs, and Reservation IDs are sorted. Cross-command order is Sales Order, Sales Order Lines, Shipment aggregate, Reservations, then Inventory Balances. PostgreSQL serialization and deadlock failures are mapped to `OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT` without exposing Prisma codes, SQLSTATE, SQL, or stacks.

## Tenant isolation and Warehouse Scope

Tenant and actor identity come only from the signed session. Body, query, and header overrides are ignored. Reads without warehouse access are masked as not found. Admin has tenant-wide access. Manager and Business Specialist need operate scope for every affected warehouse. Viewer and Buyer cannot mutate. Disabled, unprovisioned, or stale-session users are rejected.

## Database models

The additive migration creates `SalesOrder`, `SalesOrderLine`, `InventoryReservation`, `InventoryReservationEvent`, `ShipmentDocument`, `ShipmentLine`, and `ShipmentAllocation`, with indexes, tenant relations, status checks, and decimal constraints. Existing `InventoryBalance`, `InventoryMovement`, `BusinessCommandExecution`, `AuditLog`, `UserWarehouseScope`, and historical migrations are reused unchanged.

## APIs

- `GET /api/sales/orders/:id/outbound-state`
- `POST /api/sales/orders/:id/reservations/preview`
- `POST /api/sales/orders/:id/reservations/reserve`
- `POST /api/sales/orders/:id/reservations/release-preview`
- `POST /api/sales/orders/:id/reservations/release`
- `POST /api/sales/orders/:id/shipments/preview`
- `POST /api/sales/orders/:id/shipments`
- `GET /api/sales/shipments/:id/posting-state`
- `POST /api/sales/shipments/:id/cancel-preview`
- `POST /api/sales/shipments/:id/cancel`
- `POST /api/sales/shipments/:id/post-preview`
- `POST /api/sales/shipments/:id/post`
- `POST /api/sales/shipments/:id/reverse-preview`
- `POST /api/sales/shipments/:id/reverse`

Read and preview routes are classified `allowed-db-read`; mutations are `allowed-db-persistence`. Errors return only `code`, `message`, and optional `details`.

## Error codes

Stable families include capability, Sales Order existence/state/version, reservation validation/availability/allocation/version, shipment state/version/reversal safety, concurrency, idempotency, actor/session/permission, and warehouse-scope errors. Business validation uses 422, authorization 403, masked/not-found reads 404, and state/version/concurrency/idempotency conflicts 409.

## Local PostgreSQL verification

Run `npm run test:db:outbound`. The harness creates an isolated embedded PostgreSQL cluster and database, applies every migration, runs transaction and independent-client concurrency tests, requires zero skipped tests, then destroys the cluster. It never uses a production `DATABASE_URL`.

## API Smoke

Run `npm run test:api:outbound`. The harness creates another isolated PostgreSQL database, seeds a provisioned actor, operate scope, item, warehouse, opening balance, confirmed Sales Order and line, starts the real Node server, signs in, runs previews and the full posting/reversal chain, verifies durable facts and restart replay, then cleans up server and database processes.

## Capability flags

`sales-reservation`, `sales-shipment-draft`, `sales-shipment-posting`, and `sales-shipment-reversal` are `beta`, `databaseOnly`, and explicitly enabled. Formal mutation requires both:

```text
FLOWCHAIN_PERSISTENCE_MODE=database
FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING=true
```

Disabled capabilities fail closed and never fall back to JSON.

## Known limitations

This foundation does not support negative inventory, direct shipment without reservation, lot/serial allocation, pick waves, pick confirmation, mobile picking, barcode, carrier/tracking, shipping labels, customer returns, Sales Invoice, Accounts Receivable, costing, COGS, FIFO, average cost, landed cost, ATP promise engine, automatic cross-warehouse optimization, stock transfer/count/adjustment, or an Outbound Workbench UI.

## Phase 3.5 boundary

Phase 3.5 should add the product experience for authoritative Sales Order creation/maintenance and the Outbound Workbench over these APIs. It should not duplicate policy calculations in UI code.
