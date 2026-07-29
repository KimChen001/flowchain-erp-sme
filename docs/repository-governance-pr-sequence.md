# Repository Governance PR Sequence

Date: 2026-07-29

This plan begins only after Draft PR #14 is accepted and merged by a human.
Each PR must branch from the then-current `main`; none of these changes belongs
on `fix/phase-5-4b1-local-dev-truthfulness`.

## PR #15 — Frontend route and navigation governance

**Objective**

Create one typed, machine-readable frontend route manifest and make normal
navigation reflect the core SME supply-chain product boundary.

**Likely files/directories**

- `src/app/routeRegistry.tsx`
- `src/app/FlowChainApp.tsx` only where it consumes route metadata
- `src/app/routes/` (new explicit manifest files)
- navigation/capability/permission route tests
- `docs/` route matrix

**Excluded scope**

- No business API, schema, page redesign, historical-screen deletion,
  FlowChainApp decomposition, or capability enablement.

**Risks**

- Route precedence, direct refresh, browser history, permission checks, and
  focus/return navigation could drift.

**Required tests**

- Manifest ID/path uniqueness, classification invariants, capability and
  permission gates, legacy redirects, browser direct-route/back-forward smoke,
  typecheck, build, and full core tests.

**Rollback strategy**

- Revert the manifest-consumption commit and retain the current registry as the
  single route source; no database or API rollback is required.

**Expected measurable result**

- Substantially smaller `routeRegistry.tsx`; every registered route has an
  explicit `CORE`, `EXTENSION`, `INTERNAL`, `LEGACY`, or `FROZEN`
  classification; internal/frozen routes are absent from default navigation.

## PR #16 — Historical frontend screen retirement and test decoupling

**Objective**

Replace source-layout-coupled tests with behavioral contracts, then retire only
historical screens that have a verified canonical replacement and zero runtime
reachability.

**Likely files/directories**

- `src/modules/procurement/`
- `src/modules/purchase-requests/`
- `src/modules/suppliers/`
- `src/modules/overview/`
- `src/modules/inventory/`
- `src/modules/receiving/`
- `server/domain/*.test.mjs` source-reading contracts
- `tests/browser/`
- unused barrels/CSS identified by the deletion register

**Excluded scope**

- No new UI family, business API, schema change, route-manifest redesign, or
  dependency-security upgrade.

**Risks**

- A dynamically reached screen or source-reading acceptance contract could be
  removed prematurely.

**Required tests**

- Per-candidate import/dynamic-import/route/script/style/test scans,
  route-manifest tests, component/API/browser replacement behavior, full
  typecheck/build/tests, and a post-delete zero-reference scan.

**Rollback strategy**

- Restore an individual deleted screen and its route from the parent commit;
  deletions stay isolated from behavior-test migration commits.

**Expected measurable result**

- Fewer registered/historical routes, fewer unreachable source files, fewer
  tests asserting filenames or literal component source, and one canonical
  screen family per core object.

## PR #17 — FlowChainApp and AI host decomposition

**Objective**

Make `FlowChainApp.tsx` a thin composition shell and separate session,
authenticated layout, router, navigation, search, AI host, and error-boundary
responsibilities without visual or API changes.

**Likely files/directories**

- `src/app/FlowChainApp.tsx`
- `src/app/AppProviders.tsx`
- `src/app/AuthenticatedShell.tsx`
- `src/app/AppRouter.tsx`
- `src/app/GlobalNavigation.tsx`
- `src/app/GlobalSearchHost.tsx`
- `src/app/AiAssistantHost.tsx`
- `src/app/AppErrorBoundary.tsx`
- `src/app/app-session.ts`
- `src/app/app-navigation.ts`
- focused app-shell and browser tests

**Excluded scope**

- No AI response-contract redesign, AI panel internals, global state framework,
  visual redesign, backend API, or database work.

**Risks**

- Session restore, contextual AI navigation, focus highlighting, direct-route
  refresh, responsive navigation, and browser history could regress.

**Required tests**

- Login/logout/session restore, direct route, back/forward, permission and
  capability states, search navigation, AI-to-PO focus, mobile navigation,
  typecheck, build, and core browser acceptance.

**Rollback strategy**

- Preserve the existing public props/contracts while extracting; revert
  composition commits independently in reverse order.

**Expected measurable result**

- `FlowChainApp.tsx` owns composition only, each cross-cutting responsibility
  has one named owner, and no new state/router framework is introduced.

## PR #18 — Backend route registrar and module-boundary governance

**Objective**

Group the current ordered flat handler chain into explicit core, extension,
internal, and legacy/frozen registrars while preserving exact precedence and
guard behavior.

**Likely files/directories**

- `server/bootstrap/route-dispatcher.mjs`
- `server/bootstrap/scm-server.mjs`
- `server/bootstrap/routes/`
- `server/domain/route-dispatcher.test.mjs`
- route mutation/capability classification contracts
- `docs/backend-route-audit.md`

**Excluded scope**

- No automatic route discovery, plugin/backend framework, business-rule move,
  schema change, capability enablement, or command-service decomposition.

**Risks**

- Handler precedence and guard/dispatcher classifications can diverge; API
  errors could incorrectly reach static fallback.

**Required tests**

- Exact route-order snapshot/contract, first-handler short circuit, unmatched
  fallback, API-error propagation, mutation guards, unknown non-GET behavior,
  capability ownership, production entry reachability, full API/database tests,
  and static-asset fallback tests.

**Rollback strategy**

- Retain the flat ordered list representation until the registrar aggregate is
  proven equivalent; revert registrar consumption without altering handlers.

**Expected measurable result**

- One explicit registration source describes order, classification, mutation
  class, capability, precedence, and module owner; core cannot silently import
  frozen command implementations.

## PR #19 — Inventory command-service decomposition

**Objective**

Split the oversized inventory command service by operation while preserving
transaction, idempotency, tenant/warehouse, decimal, ledger, reversal, and
audit invariants.

**Likely files/directories**

- `server/domain/inventory-operations-command-service.mjs`
- `server/modules/inventory/application/`
- `server/modules/inventory/domain/`
- `server/modules/inventory/repositories/`
- inventory route callers and focused invariant tests

**Excluded scope**

- No schema migration, newly enabled inventory command, UI redesign, route
  governance, or inventory-policy behavior change.

**Risks**

- Transaction fragmentation, double posting, balance drift, cross-tenant
  access, rounding changes, reversal defects, and audit records that do not
  match committed mutations.

**Required tests**

- Export/caller/repository/transaction maps plus negative-availability policy,
  governed receiving limits, reversal restoration, duplicate command
  idempotency, tenant and warehouse scope, atomic rollback, audit/commit parity,
  decimal accuracy, all inventory database/API/browser suites.

**Rollback strategy**

- Keep the existing facade/export contract and move one command at a time so
  each extraction can be independently reverted.

**Expected measurable result**

- The facade delegates to operation-specific commands; every mutation has one
  explicit transaction owner and all existing invariant tests remain green.

## PR #20 — Dependency security upgrades

**Objective**

Resolve prioritized dependency advisories through reviewed, isolated upgrades:
router/HTTP/`fast-uri` first, workbook parsing separately, then Prisma
toolchain.

**Likely files/directories**

- `package.json`
- `package-lock.json`
- router integration tests
- HTTP/provider adapter tests
- Universal Intake parser and limits
- Prisma configuration/generated-client compatibility
- security documentation and CI audit checks

**Excluded scope**

- No unrelated UI cleanup, route decomposition, business capability, schema
  redesign, or blind `npm audit fix --force`.

**Risks**

- Router navigation semantics, HTTP timeout/error behavior, untrusted workbook
  resource exhaustion, Prisma generation/runtime compatibility, and lockfile
  transitive changes.

**Required tests**

- Advisory/path/version review per dependency, focused router and HTTP
  regression, workbook size/sheet/row/column/malformed/encrypted/formula safety,
  Universal Intake preview-first behavior, Prisma generation/migration/upgrade
  tests, full typecheck/build/unit/API/database/browser verification.

**Rollback strategy**

- Use separate commits/PRs for router/HTTP, workbook parser, and Prisma; restore
  the prior lockfile and package versions for only the failing upgrade.

**Expected measurable result**

- Priority advisories are removed or explicitly sandboxed with documented
  residual risk; no security upgrade changes business scope or weakens review
  boundaries.

## Sequence gates

1. Human merges PR #14.
2. PR #15 establishes route ownership before any historical screen deletion.
3. PR #16 removes only screens proven obsolete by the route manifest and
   behavior tests.
4. PR #17 decomposes the shell after route behavior is stable.
5. PR #18 governs backend route registration independently of frontend work.
6. PR #19 changes inventory internals only after route ownership is explicit.
7. PR #20 remains isolated by dependency family and may be split further when
   advisory review shows incompatible risk profiles.

Future Email, Teams, WhatsApp, WeCom, DingTalk, Feishu, SAP, Odoo, and Kingdee
work is architecture-proposal-only until this core sequence is complete.
