# Receiving Posting Workbench

## Scope

Phase 2.5 turns the PostgreSQL-verified PO → GRN → movement → balance → PO progress → audit → reversal slice into a database-backed user workflow. It does not add outbound posting, transfer, costing, MRP, finance, quality-hold, supplier return, or full lot/serial posting.

## API and read model

Writes remain compatible:

- `POST /api/procurement/receiving/:id/post`
- `POST /api/procurement/receiving/:id/reverse`

Desktop receipts are drafted from a PO before posting. These commands share the draft core in `server/domain/receiving-draft-command-service.mjs` with the mobile receiving facade, need `receiving.prepare` and operate access to the warehouse, and are gated only by `FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING`. Each is idempotent, checks the expected version (409 `SYNC_VERSION_CONFLICT`), refuses accepted quantity above the PO's open quantity (409 `RECEIVING_OVER_RECEIPT`), requires a reason for rejected quantity, and writes one audit row:

- `POST /api/procurement/receiving` (create a draft from an approved, issued or partially received PO)
- `PATCH /api/procurement/receiving/:id` (revise a draft)
- `POST /api/procurement/receiving/:id/submit` (draft → ready_for_receiving)

The retired `POST /api/receiving-docs` and `PATCH /api/receiving-docs/:id` stay refused by the database-mode gate.

Database-only reads are:

- `GET /api/procurement/receiving` (receipts the user may read, optional `?poId=`)
- `GET /api/procurement/purchase-orders/:id/receivable-lines` (open quantities and receiving warehouses for the receipt form)
- `GET /api/procurement/receiving/:id`
- `GET /api/procurement/receiving/:id/impact-preview?operation=post|reverse`
- `GET /api/procurement/receiving/:id/evidence`
- `GET /api/procurement/receiving/:id/links`
- `GET /api/procurement/purchase-orders/:id/receiving-summary`

All reads use server-resolved identity and tenant scope. Cross-tenant records return 404. Decimal quantities are fixed four-place strings. The route never exposes Prisma models or accepts a client tenant override.

The Read Model separates GRN workflow/posting and PO workflow/fulfillment. Fulfillment is derived from PO lines; see `docs/adr/receiving-po-status-separation.md`.

## Impact preview and idempotency

Post and reverse actions first call the read-only preview. It shows balance, PO quantity, fulfillment and fact-count changes. Blocking issues disable confirmation. Preview creates no movement, balance, audit, or command record.

Each confirmed action generates one idempotency key. Network retry reuses that key; closing the preview and beginning a new review creates a new key. A 409 refreshes Detail and requires another review.

Reverse preview checks original movements, downstream consumption, available/on-hand balance, and PO received quantity. A reason is mandatory before confirmation.

## Evidence and smart links

Timeline records distinguish `business_fact`, `audit`, `human_activity`, and `limitation`. AI inference, if connected later, must use `ai_inference` and state that it is not a posted business fact. Smart links include navigable PO plus GRN-filtered movements, balances, audit, and reversal counts.

## Capability, actor, and lot/serial rules

`receiving-posting` and `receiving-reversal` remain beta, database-only, and explicitly enabled by `FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING=true`. Disabled capability renders Detail read-only and blocks preview/action.

Actors must already be provisioned. Missing actors return `ACTOR_NOT_PROVISIONED`/403. Bootstrap is allowed only in tests or with explicit `FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP=true`; never enable it as a production default.

Lot/serial columns are schema-ready only. The page states: “Lot/Serial posting is not connected in this beta.” No InventoryLot or InventorySerial fact is promised.

Posted movement quantities, sources and type are immutable. Reversal appends a new reversal movement and only adds `reversedByMovementId` to the original.

## Errors

The UI maps authentication, permission, tenant, actor, validation, over-receipt, already-posted/reversed, version/concurrency, idempotency and unsafe-reversal codes. Raw SQLSTATE, Prisma codes and stacks are never displayed.

## Local verification

```sh
npm install
DATABASE_URL=postgresql://generate_only:generate_only@127.0.0.1:55432/flowchain_generate_only?schema=public npm run db:generate
npm run typecheck
npm run build
npm test
npm run test:db:receiving
npm run test:api:receiving
npm run test:browser:receiving
```

The DB, API and browser commands create isolated Embedded PostgreSQL databases, use local-only generated credentials, and clean them automatically. The API smoke starts a real server, logs in with a signed session, posts/replays/reverses, checks PostgreSQL, restarts the server and verifies persistence. The browser flow uses the same database mode and confirms state after refresh.

GitHub Actions runs Node 20, generation, typecheck, build, full Node tests, real DB verification, API smoke, and a separate Chromium job. A workflow file is not proof of CI success; use the actual run result.

## Known limitations and next boundary

PO persisted status remains mixed transitional debt, lot/serial posting is unavailable, and reconciliation is represented by connected movement facts rather than a new persisted status. The next phase requires separate authorization; do not infer permission to begin outbound posting.
