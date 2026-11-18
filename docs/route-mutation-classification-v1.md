# Route Mutation Classification v1

Round 24 classifies API route behavior and adds a database-mode guard for un-migrated legacy JSON write routes.

## Classification Terms

- `read-only`: returns current read-model or demo state and should not write business records.
- `preview-only`: prepares reviewable draft output and must not create business records.
- `controlled-persistence`: explicit persistence of a safe shell record that does not create business records.
- `legacy-mutation`: existing manual/demo workflow write route that mutates JSON-backed demo data.
- `future-mutation`: reserved for a future draft-confirm write workflow.
- `diagnostics`: health, preflight, or operational status.
- `static`: frontend/static asset request.

## Database Mode v1 Rule

When `FLOWCHAIN_PERSISTENCE_MODE=database`:

- read-only routes remain available;
- preview-only routes remain available;
- default health remains available;
- legacy mutation routes are blocked before route handlers can call `writeDb`;
- blocked routes return:

```json
{ "error": "This mutation is not available in database persistence mode yet." }
```

The block response uses HTTP `501` and contains no stack trace, provider details, or database configuration.

Database mode uses migrated DB read adapters where available and JSON read fallback where not yet migrated. It does not write JSON in database mode.

## Route Classification

### Diagnostics / Static

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `OPTIONS` | `*` | diagnostics | No | Allowed | Allowed | CORS preflight. |
| `GET` | `/api/health` | diagnostics | No | Allowed | Allowed | Safe fields only. |
| `GET/HEAD` | non-API paths | static | No | Allowed | Allowed | Static assets. |

### Auth / Context

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `GET` | `/api/me` | read-only | No | Allowed | Allowed | Demo context. |
| `GET` | `/api/tenants/current` | read-only | No | Allowed | Allowed | Demo tenant settings. |
| `POST` | `/api/auth/login` | legacy-mutation | Yes | Allowed | Blocked | Creates/updates demo user login and event. |
| `GET` | `/api/auth/me` | read-only | No | Allowed | Allowed | Legacy token lookup. |

### AI

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `GET` | `/api/ai/tools` | read-only | No | Allowed | Allowed | Tool registry only. |
| `POST` | `/api/ai/chat` | read-only / draft-prep | Best-effort audit only | Allowed | Allowed without JSON persistence | Deterministic/read paths and draft prep remain available; `writeDb` is not injected in database mode. |

### Read Model APIs

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `GET` | `/api/search` | read-only | No | Allowed | Allowed | Global search. |
| `GET` | `/api/today-cockpit` | read-only | No | Allowed | Allowed | Aggregated read model. |
| `GET` | `/api/master-data/*` | read-only | No | Allowed | Allowed with DB read adapter | Repository-compatible. |
| `GET` | `/api/procurement/*` | read-only | No | Allowed | Allowed with DB read adapter | Repository-compatible. |
| `GET` | `/api/inventory/*` | read-only | No | Allowed | Allowed with DB read adapter | Repository-compatible. |
| `GET` | `/api/inventory-movements` | read-only | No | Allowed | Allowed | Compatibility read endpoint. |
| `GET` | `/api/audit-log` | read-only | No | Allowed | Allowed | Existing audit list. |

### Action Drafts

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `POST` | `/api/action-drafts/used` | not classified | No | Removed | Audit row only | Records that a text draft was copied or opened in the mail app; sends nothing. The schema, preview and save routes were removed in November 2026. |

### Planning / Market / Forecast

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `GET` | `/api/mrp-plan` | read-only | No | Allowed | Allowed | MRP read output. |
| `GET` | `/api/sop-cycle` | read-only | No | Allowed | Allowed | S&OP draft/history read. |
| `POST` | `/api/sop-cycle` | legacy-mutation | Yes | Allowed | Blocked | Saves demo S&OP cycle. |
| `GET` | `/api/external-signals` | read-only | No JSON write | Allowed | Allowed | Demo signal/cache only. |
| `GET` | `/api/market-prices` | read-only | No persisted write | Allowed | Allowed | Demo market cards. |
| `POST` | `/api/market-prices/refresh` | legacy-mutation | Yes | Allowed | Blocked | Refreshes JSON demo market prices. |
| `GET` | `/api/forecast-plans` | read-only | No | Allowed | Allowed | Forecast plan list. |
| `POST` | `/api/forecast-plans` | legacy-mutation | Yes | Allowed | Blocked | Saves demo forecast plan. |

### Supplier Reads

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Notes |
|---|---|---|---|---|---|---|
| `GET` | `/api/supplier-performance` | read-only | No | Allowed | Allowed | Supplier score helper. |
| `GET` | `/api/supplier-recommendations` | read-only | No | Allowed | Allowed | Sourcing recommendation helper. |

### Legacy Procurement Workflow Routes

| Method | Path | Class | Calls `writeDb` | JSON mode | Database mode v1 | Draft-first notes |
|---|---|---|---|---|---|---|
| `GET` | `/api/purchase-requests` | read-only | No | Allowed | Allowed | Legacy read endpoint. |
| `POST` | `/api/purchase-requests` | legacy-mutation | Yes | Allowed | Blocked | Future confirm workflow should replace direct creation. |
| `PATCH` | `/api/purchase-requests/:id/status` | legacy-mutation | Yes | Allowed | Blocked | Future controlled approval flow needed. |
| `POST` | `/api/purchase-requests/:id/convert-to-po` | legacy-mutation | Yes | Allowed | Blocked | Future confirm workflow should create PO. |
| `GET` | `/api/rfqs` | read-only | No | Allowed | Allowed | Legacy read endpoint. |
| `POST` | `/api/rfqs` | legacy-mutation | Yes | Allowed | Blocked | Future confirm workflow should create RFQ. |
| `PATCH` | `/api/rfqs/:id/status` | legacy-mutation | Yes | Allowed | Blocked | Award can create PO, so blocked. |
| `GET` | `/api/purchase-orders` | read-only | No | Allowed | Allowed | Legacy read endpoint. |
| `POST` | `/api/purchase-orders` | legacy-mutation | Yes | Allowed | Blocked | Future confirm workflow should create PO. |
| `PATCH` | `/api/purchase-orders/:id/status` | legacy-mutation | Yes | Allowed | Blocked | Approval/issue/close writes. |
| `GET` | `/api/receiving-docs` | read-only | No | Allowed | Allowed | Legacy read endpoint. |
| `POST` | `/api/receiving-docs` | legacy-mutation | Yes | Allowed | Blocked | Creates GRN. |
| `PATCH` | `/api/receiving-docs/:id` | legacy-mutation | Yes | Allowed | Blocked | Can post receiving and inventory movements. |

## Implementation

New module:

- `server/domain/route-classification.mjs`

Exports:

- `ROUTE_CLASSES`
- `DATABASE_MODE_MUTATION_BLOCKED_ERROR`
- `listRouteClassifications()`
- `classifyRoute(method, pathname)`
- `isLegacyMutationRoute(method, pathname)`
- `isDatabaseModeWriteBlocked({ persistenceMode, method, pathname })`
- `databaseModeMutationBlockedPayload()`
- `sendDatabaseModeMutationBlocked(res, send)`

`server/routes/scm-legacy.routes.mjs` applies the guard after health handling and before legacy auth, forecast, and route dispatch write paths.

## JSON Compatibility

Default JSON mode is unchanged:

- legacy manual/demo mutations still work as before;
- read routes keep their response shapes;
- action draft preview remains preview-only;
- normal test/typecheck/build does not require `DATABASE_URL`.

## Non-Goals

This round does not:

- remove legacy routes;
- implement DB write workflows;
- add Prisma, Drizzle, or any ORM;
- add a database connection;
- create real PR/RFQ/PO/GRN/inventory postings through DB;
- add auth/RBAC;
- change default JSON behavior;
- mutate `data/scm-demo.json`.
