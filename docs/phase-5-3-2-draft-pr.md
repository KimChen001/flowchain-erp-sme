# Phase 5.3.2 Draft Pull Request Body

## What changed

- Removed remaining production static and in-memory business facts from RFQ,
  MRP, supplier recommendations, market data, sales demand, reports, inventory,
  receiving, sales, finance initialization, and AI insight surfaces.
- Connected `GET /api/rfqs` to the authenticated tenant-scoped PostgreSQL
  procurement read model.
- Connected `GET /api/inventory-movements` to the authenticated tenant-scoped
  PostgreSQL inventory read model.
- Added one stable capability gate for planning, supplier recommendation,
  supplier performance, forecast, market price, and external signal routes that
  do not yet have an authoritative model.
- Moved the retained standard business scenario into
  `server/domain/test-fixtures/`; production routes do not import it.
- Strengthened contract coverage with source-boundary, handler, fail-closed,
  and fresh migrated PostgreSQL API gates.

## Why

The first Phase 5.3.2 cutover removed JSON persistence but left route-local and
frontend fixture facts that could still appear as production truth. The root cause
was treating read-only static projections as harmless even though they bypassed
tenant-scoped PostgreSQL authority.

## User and developer impact

Fresh databases now return honest empty collections for PostgreSQL-backed
domains. Modules without an authoritative model return HTTP 501 with
`FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED`, capability, message, and limitations;
they no longer return synthetic operational results.

## Route authority

PostgreSQL-backed:

- `GET /api/rfqs`
- `GET /api/inventory-movements`

Capability-disabled:

- `GET /api/mrp-plan`
- `GET/POST /api/sop-cycle`
- `GET /api/supplier-performance`
- `GET /api/supplier-recommendations`
- `GET/POST /api/forecast-plans`
- `GET /api/external-signals`
- `GET /api/market-prices`
- `POST /api/market-prices/refresh`

## Removed test mapping

| Removed test suite | Reason | Replacement PostgreSQL or capability gate |
| --- | --- | --- |
| JSON adapter and DB parity harnesses | Retired JSON authority and fixture parity. | PostgreSQL-only contract, repository, migration, and fresh API gates. |
| MRP BOM/net-requirement/read-model suites | Asserted static planning profiles and BOM facts. | MRP capability gate; pure calculation tests use explicit preview input. No PostgreSQL MRP model yet. |
| Procurement transaction/workflow prototype suites | Asserted duplicate in-memory RFQ/quotation/award state. | PostgreSQL procurement read/command coverage and DB-backed `GET /api/rfqs`. |
| Supplier recommendation fixture coverage | Asserted hardcoded quote, capacity, contract-price, and FX facts. | Supplier recommendation capability gate. No PostgreSQL recommendation model yet. |
| Legacy JSON import/dry-run parity coverage | Targeted the retired JSON business dataset. | PostgreSQL pilot import service, correction, database, and API gates. |
| File-backed settings tests | Targeted removed runtime files. | PostgreSQL settings API restart smoke. |

## Verification

- PostgreSQL-only contract: 14 passed, 0 failed, 0 skipped.
- Fresh empty PostgreSQL API gate: 16 assertions passed, 0 failed, 0 skipped.
- Full `npm test`: 1,063 passed, 0 failed, 14 conditionally skipped out of
  1,077 tests. The corresponding PostgreSQL paths passed in isolated embedded
  database gates with zero skips.
- Typecheck and production build passed.
- Fresh migration, additive upgrades, API smoke, authorization, bank security,
  mobile, attachment restart, and targeted Chromium gates passed.
- `git diff --check` passed (line-ending conversion advisories only).

This PR must remain Draft.
