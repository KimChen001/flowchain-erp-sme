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

Results are recorded here after implementation and include startup boundaries,
static runtime boundaries, fresh database boot, restart durability, the full
unit/API/PostgreSQL matrix, browser coverage, build and typecheck.

## Known Limitations

To be finalized after implementation. Phase 5.4 Universal Intake, external
integrations, autonomous AI execution and cloud provisioning are out of scope.

## Phase 5.4 Readiness

Readiness requires every production business read and write to resolve through
PostgreSQL-backed APIs with no JSON or static business-data fallback.
