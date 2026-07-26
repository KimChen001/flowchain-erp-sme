# Phase 5.3.2 PostgreSQL-only Runtime Cutover

## Baseline

- Base branch: `main`
- Base SHA: `fb665ec3968752cfd1dc10d08415db30b91c4d30`
- Previous release: `v0.5.3.1-bank-data-security-hardening`
- Cutover branch: `release/phase-5-3-2-postgres-only-runtime`

## Previous State

The Phase 5.3.1 application had a split runtime authority. PostgreSQL was already
authoritative for most operational workflows, but the composition root still
loaded `data/scm-demo.json` on every request, selected either JSON or database
repositories through `FLOWCHAIN_PERSISTENCE_MODE`, and exposed JSON runtime
adapter details in the health response. Several frontend modules also imported
static demo business records as runtime fallbacks.

The following legacy runtime paths were present at the start of this phase:

- `server/repositories/json-db.mjs`
- `server/repositories/json-*-repository.mjs`
- file-backed durable repositories and `runtime-file-mutex.mjs`
- `server/repositories/adapter-registry.mjs` JSON/database mode branching
- `server/routes/scm-legacy.routes.mjs` JSON bootstrap and write path
- `data/scm-demo.json`
- `src/data/demo-data.ts` imports in production modules

## Authority Matrix

| Domain | Baseline classification | Phase 5.3.2 target | Notes |
| --- | --- | --- | --- |
| Tenant / Workspace | PostgreSQL authoritative | PostgreSQL authoritative | `Tenant`, workspace bootstrap and tenant-scoped access |
| Users / Roles / Permissions | PostgreSQL authoritative | PostgreSQL authoritative | `User`, `TenantRole`, permissions and assignments |
| Settings | Legacy runtime to delete | PostgreSQL authoritative | Move workspace settings into tenant-scoped PostgreSQL state |
| Master Data | PostgreSQL authoritative | PostgreSQL authoritative | Suppliers, items, warehouses, payment terms and tax codes |
| Suppliers | PostgreSQL authoritative | PostgreSQL authoritative | `Supplier` |
| Customers | PostgreSQL authoritative | PostgreSQL authoritative | Customer master support is API/database-backed; no JSON fallback is allowed |
| Items | PostgreSQL authoritative | PostgreSQL authoritative | `Item` |
| Warehouses | PostgreSQL authoritative | PostgreSQL authoritative | `Warehouse`, locations and user scopes |
| Procurement | PostgreSQL authoritative with legacy adapters | PostgreSQL authoritative | PR, RFQ, quotation, PO and receiving models already exist; retire duplicate JSON/in-memory transaction adapters |
| Purchase Orders | PostgreSQL authoritative | PostgreSQL authoritative | `PurchaseOrder` and lines |
| Receiving | PostgreSQL authoritative | PostgreSQL authoritative | `ReceivingDocument` and lines |
| Inventory | PostgreSQL authoritative with frontend fallback | PostgreSQL authoritative | Balances, lots, serials, movements and exception documents |
| Sales Orders | PostgreSQL authoritative with frontend fallback | PostgreSQL authoritative | `SalesOrder` and lines |
| Outbound | PostgreSQL authoritative | PostgreSQL authoritative | reservations, shipments and allocations |
| Returns / Quarantine | PostgreSQL authoritative | PostgreSQL authoritative | return and quarantine models |
| Operational Finance | PostgreSQL authoritative with frontend fallback | PostgreSQL authoritative | invoices, obligations, matching and credit documents |
| Settlement | PostgreSQL authoritative | PostgreSQL authoritative | settlement, allocation, advance and transfer models |
| Cashbook | PostgreSQL authoritative | PostgreSQL authoritative | accounts and entries |
| Bank Reconciliation | PostgreSQL authoritative | PostgreSQL authoritative | statement imports, candidates, groups, exceptions and evidence |
| Mobile Sync | PostgreSQL authoritative | PostgreSQL authoritative | sync clients, snapshots and change feed |
| Attachments | PostgreSQL metadata plus configured blob storage | Same | Database metadata is authoritative; binary storage remains provider-backed |
| Audit | PostgreSQL authoritative with JSON alternative | PostgreSQL authoritative | retire JSON audit adapter |
| Action Drafts | PostgreSQL authoritative with JSON alternative | PostgreSQL authoritative | `ActionDraft`, validation and audit trail |
| Confirmed Actions | Transient process state | PostgreSQL authoritative or retired | In-memory records cannot remain a formal business record |
| Exception Cases | Transient process state | PostgreSQL authoritative or retired | User-visible case mutations require durable tenant scope |
| Procurement Transaction Prototype | Transient process state | Retired in favor of formal PostgreSQL procurement models | Duplicate draft/response state must not become a second authority |
| User Import Runtime | Transient process state | Disabled until database-backed intake | Phase 5.4 owns Universal Intake; no in-memory committed business dataset |
| AI Conversation State | Not implemented | Transient process state | Conversation history is not durable business evidence and cannot authorize commands |
| Forecast Plans | Legacy runtime to delete | Not implemented | JSON mutation endpoint is retired; future planning persistence needs an explicit model |

## Cutover Contract

The formal server process will require `DATABASE_URL`. The removed
`FLOWCHAIN_PERSISTENCE_MODE=json` value will fail with a stable startup error.
There will be no database-to-JSON fallback, development fallback, or demo-data
bootstrap. A fresh migrated database must return honest empty collections.

## Audited Runtime Route Classification

| Route | Classification | Authority / limitation |
| --- | --- | --- |
| `GET /api/rfqs` | PostgreSQL-backed | Authenticated, tenant-scoped `procurementRead`; an empty database returns `[]`. |
| `GET /api/inventory-movements` | PostgreSQL-backed | Authenticated, tenant-scoped `inventoryRead`; an empty database returns `[]`. |
| `GET /api/mrp-plan` | Capability-disabled | No authoritative PostgreSQL planning profile or BOM model. |
| `GET/POST /api/sop-cycle` | Capability-disabled | No authoritative S&OP cycle model or persistence. |
| `GET /api/supplier-performance` | Capability-disabled | No authoritative supplier-performance projection. |
| `GET /api/supplier-recommendations` | Capability-disabled | No authoritative quote, capacity, contract-price, or FX model. |
| `GET/POST /api/forecast-plans` | Capability-disabled | No authoritative forecast-plan model or persistence. |
| `GET /api/external-signals` | Capability-disabled | No external provider with explicit provenance is configured. |
| `GET /api/market-prices` and `POST /api/market-prices/refresh` | Capability-disabled | No external market-data provider with explicit provenance is configured. |

Every capability-disabled route returns HTTP 501 with
`FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED`, a stable capability identifier, a
business-readable message, and non-empty limitations. Pure MRP calculation
helpers remain available only for caller-supplied preview facts and do not read
runtime fixtures.

## Removed Test Mapping

| Removed test suite | Reason | Replacement PostgreSQL or capability gate |
| --- | --- | --- |
| `json-adapter-contracts.test.mjs`, `json-adapter-contract-helpers.test.mjs` | JSON persistence is no longer a supported production authority. | `postgres-only-runtime.test.mjs` rejects JSON mode and scans the production composition root; the fresh-database API gate proves PostgreSQL-only behavior. |
| `db-adapter-parity-harness.test.mjs`, `inventory-db-parity-harness.test.mjs`, `procurement-db-parity-harness.test.mjs` | JSON/database parity would preserve the retired fixture contract. | Database repository tests plus `test:db:postgres-only-runtime`, fresh migration, additive upgrade, and API smoke gates. |
| `demo-data-dry-run.test.mjs`, `demo-data-isolation-readiness.test.mjs` | Demo dataset selection and dry-run bootstrap were removed. | Source-boundary checks and fresh empty PostgreSQL API assertions with no fixture identifiers. |
| `mrp-bom-explosion.test.mjs`, `mrp-net-requirements.test.mjs`, `mrp-read-model-contract.test.mjs` | They asserted route-local `mrpProfiles`/`bomMaster` facts that are not authoritative. | `GET /api/mrp-plan` capability gate plus unit coverage for pure calculations using explicit preview input. There is no PostgreSQL MRP replacement yet. |
| `procurement-transaction-core.test.mjs`, `procurement-workflow-foundation.test.mjs` | They exercised duplicate in-memory RFQ/quotation/award state. | PostgreSQL procurement repository/command tests; `GET /api/rfqs` now uses tenant-scoped `procurementRead`. Unsupported RFQ mutations remain fail-closed. |
| Supplier recommendation fixture assertions formerly embedded in procurement/MRP coverage | Static quotes, capacity calendars, contract prices, and FX tables were removed. | `GET /api/supplier-recommendations` capability gate. There is no PostgreSQL recommendation model yet. |
| Legacy import/parity coverage tied to JSON runtime (`demo-data-*`, adapter parity helpers) | Importing into the retired JSON business dataset is no longer valid. | PostgreSQL `pilot-import-service.test.mjs`, durable import correction tests, and PostgreSQL pilot import API/database gates. |
| `master-data-repository.test.mjs`, `procurement-inventory-read-repositories.test.mjs` | They targeted superseded combined/in-memory adapter contracts. | Focused PostgreSQL master-data, procurement-read, inventory-read, selector, and fresh-database API tests. |
| `settings-runtime-persistence.test.mjs`, `settings-runtime.routes.test.mjs` | File-backed settings persistence was retired. | PostgreSQL workspace settings API smoke and restart persistence gate. |

No production route was removed merely to make a legacy test pass. Routes that
do not have an authoritative model remain registered and fail closed through
the capability gate.

## Migration Impact

Existing PostgreSQL deployments use forward-only Prisma migrations. Legacy UAT
JSON data is deliberately not imported because it is synthetic release data,
not customer data. Settings that were previously saved only in a runtime JSON
file need to be configured again through the PostgreSQL-backed settings API.

## Rollback Method

Rollback means deploying the immutable Phase 5.3.1 release and its matching
database-compatible application version. Do not recreate the deleted JSON
runtime in this branch and do not move the Phase 5.3.1 tag. Database backups and
normal migration rollback procedures remain the authority for customer data.

## Empty Database Behavior

After `prisma migrate deploy`, the API must start without loading demo records.
An administrator uses the database bootstrap/setup commands to create the first
tenant and user, then creates warehouses, items, suppliers and customers through
the existing database-backed APIs. Modules with no records return empty results.

## Remaining Transient State

- Local signed-session cache: authentication session transport only; not a
  business record and not audit evidence.
- AI conversation context: request/session context only; not durable evidence
  and not permitted to execute irreversible commands.
- Import preview parsing: may be transient until explicitly committed through a
  future PostgreSQL-backed intake workflow.

## Test Results

Validated locally on 2026-07-26 against the branch working tree:

- PostgreSQL-only contract gate: 14 passed, 0 failed, 0 skipped. The fresh
  PostgreSQL-only API gate additionally passed 16 assertions with 0 failures
  and 0 skips. Together they cover missing database configuration, rejection
  of `FLOWCHAIN_PERSISTENCE_MODE=json`, production-source boundaries,
  capability fail-closed behavior, and empty fresh-database responses.
- Full Node test suite: 1,063 passed, 0 failed, 14 conditionally skipped out of
  1,077 tests. Every skipped PostgreSQL transaction path was also exercised by
  an isolated Embedded PostgreSQL gate with zero skips.
- Typecheck and production build passed. The build emitted only the existing
  large-chunk advisory.
- Real-server API smoke passed for receiving, outbound, inventory operations,
  returns/quarantine, operational finance, workspace settings, authorization,
  and internal settlement. Persistence-sensitive flows were verified across
  an API process restart.
- Fresh and additive-upgrade PostgreSQL gates passed for receiving, outbound,
  inventory operations, returns/quarantine, operational finance, internal
  settlement, settlement/mobile, authorization, bank reconciliation, and the
  v0.5.2B and v0.5.2C.1 upgrade boundaries.
- Bank security gates passed for recursive projection redaction, mapping-secret
  rejection before persistence, same-batch duplicate detection, read-only GET
  services, tenant composite foreign keys, candidate v1.1 remaining-amount
  scoring, and independent reconciliation-evidence recomputation.
- Additional database gates passed for purchase-order fault-injection
  atomicity, mobile sync controls, advance/dispute eligibility, receiving
  decimal parity, and mobile authority policy.
- Targeted Chromium gates passed for bank security/reconciliation,
  authorization, settings/localization, receiving, outbound, inventory,
  returns/quarantine, operational finance, internal settlement, governed
  settlement, mobile operations/sync, and attachment durability across API
  process restart.

## Known Limitations

- The full Node suite reports 14 conditional PostgreSQL skips when a shared
  `DATABASE_URL_TEST` is not supplied. The corresponding transaction suites
  pass against isolated Embedded PostgreSQL databases, but the aggregate suite
  still reports those skips by design.
- Node/PostgreSQL test runs emit the existing `pg` deprecation warning for a
  `client.query()` call issued while that client is already executing a query.
  It does not currently fail a gate, but should be removed before upgrading to
  `pg` 9.
- The production build retains the existing large JavaScript chunk advisory.
- Synthetic legacy JSON data is not migrated. Existing installations must use
  normal PostgreSQL backup/migration procedures and reconfigure settings that
  existed only in the retired runtime file.
- Phase 5.4 Universal Intake, external integrations, autonomous AI execution,
  cloud provisioning, and durable AI conversation history remain out of scope.

## Phase 5.4 Readiness

Readiness requires every production business read and write to resolve through
PostgreSQL-backed APIs with no JSON or static business-data fallback.
