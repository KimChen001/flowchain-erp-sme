# Backend Route Audit

Status: current as of 2026-07-29.

## Runtime composition

The production entry point is:

```text
server/index.mjs
  -> server/scm-api.mjs
  -> server/bootstrap/scm-server.mjs
  -> server/bootstrap/route-dispatcher.mjs
  -> server/routes/*.routes.mjs
  -> server/domain/* services
  -> server/repositories/db-*.mjs
  -> Prisma / PostgreSQL
```

`server/bootstrap/scm-server.mjs` is the composition root. It owns HTTP startup,
authentication context, capability and legacy-mutation guards, route-context
construction, static asset fallback, and safe top-level error handling.
`server/bootstrap/route-dispatcher.mjs` owns the ordered route-handler chain and
short-circuits after the first handler accepts the request. Neither file is a
home for new business rules.

All production repositories are created by
`server/repositories/adapter-registry.mjs`. The registry rejects removed JSON
persistence and returns PostgreSQL adapters. Test fixtures live below
`server/domain/test-fixtures/` and are not reachable from the production entry
point.

## Route authority

| Area | Main handlers | Authority |
| --- | --- | --- |
| Master data | `master-data.routes.mjs` | PostgreSQL `db-master-data-repository` |
| Procurement reads | `procurement-read.routes.mjs`, `procurement-workflow.routes.mjs` | PostgreSQL procurement repositories and command service |
| Purchase orders | `purchase-orders.routes.mjs` | PostgreSQL procurement read/authority |
| Receiving | `receiving.routes.mjs` | PostgreSQL reads; legacy mutation endpoints fail closed |
| Receiving posting | receiving routes plus posting services | Explicitly enabled PostgreSQL command service |
| Inventory | `inventory.routes.mjs`, `inventory-operations.routes.mjs` | PostgreSQL inventory read and governed command services |
| Sales/outbound | `sales-order-workbench.routes.mjs`, `outbound.routes.mjs` | PostgreSQL sales/outbound services |
| AI | `ai-runtime-gateway.routes.mjs`, `ai.routes.mjs` | Repository-backed evidence plus bounded provider adapters |
| Universal Intake | `intake.routes.mjs` | PostgreSQL intake repository; business commit remains constrained |
| Operational finance | `operational-finance.routes.mjs` | Optional PostgreSQL extension, never payment execution |
| Bank reconciliation | `bank-reconciliation.routes.mjs` | Optional evidence/reconciliation extension |

## Preview-only Routes

- `GET /api/action-drafts/schema` returns the supported draft contract.
- `POST /api/action-drafts/preview` validates and renders a reviewable text
  draft without creating or changing a business document.
- Preview routes are separate from `POST /api/action-drafts/save`; saving keeps
  an internal review draft and is not business-document execution.

## Fail-closed boundaries

- Forecast/MRP, S&OP, supplier performance, supplier recommendation, market
  prices, external signals, and legacy import routes return explicit capability
  errors where authoritative models are unavailable.
- Legacy PR/RFQ/PO/receiving mutation URLs are classified and blocked in
  database mode.
- Unknown non-GET API routes require review rather than being treated as safe.
- Empty PostgreSQL repositories return truthful empty collections; no production
  route imports a business fixture.

## Remaining architecture work

1. Split local session/authentication and static asset delivery out of
   `server/bootstrap/scm-server.mjs`.
2. Group the flat ordered handler chain into core, extension, and internal
   registrars without changing precedence.
3. Move command/read services into domain modules (`procurement`, `inventory`,
   `supplier`, `workflow`, `ai`) without rewriting their working behavior.
4. Replace broad route-context helper injection with narrow handler
   dependencies.
5. Move finance/bank/settlement composition behind an extension registrar.
6. Generate route classification from the same route registrations so the
   guard table cannot drift from the dispatcher.
