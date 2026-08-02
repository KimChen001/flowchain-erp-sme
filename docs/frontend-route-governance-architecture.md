# Frontend Route Governance Architecture

FlowChain's near-term product surface is an AI-native procurement and inventory
operating system for SMEs. The typed route manifest is the executable authority
for route classification, navigation visibility, exact capability and
permission requirements, direct-access behavior, product exposure, and
independent read/write maturity.

## Default SME Core

The default primary order is:

1. Today
2. Procurement
3. Receiving
4. Inventory
5. Suppliers
6. Items
7. Universal Intake, only when its preview capability is explicitly enabled
8. Review Queue, only when its preview capability is explicitly enabled

The contextual AI Assistant is an application action, not a route. Internal,
Frozen, Legacy, and compatibility-only routes never appear in default
navigation or ordinary route search.

## One executable route authority

All 159 current route IDs occur in exactly one explicit classification group.
There is no module fallback and no default-to-CORE behavior. Adding a route
without a policy, duplicating it across groups, or retaining policy for a
nonexistent route fails manifest construction and CI.

Consumers use the governed fields:

- `requiredCapability` is the only route capability identifier.
- `requiredPermission` is checked against
  `/api/authorization/context.effectivePermissions`.
- `navigationVisibility` controls the eligible navigation surface.
- `compatibilityOnly` prevents implemented compatibility tools from becoming
  normal SME navigation.

`capabilityId` and module visibility remain declaration or backend compatibility
inputs; they are not parallel frontend authorities.

## Capability and permission load states

Capability and authorization contexts explicitly distinguish `loading`,
`ready`, and `failed`.

- Stable Core routes without a route-specific capability may retain their
  documented safe surface.
- Extension and Preview routes remain hidden and blocked until their exact
  capability is ready and enabled.
- Permission-gated entries remain hidden until the exact permission set is
  ready.
- Capability-registry failure, authorization-service failure, permission
  denial, and capability disablement render distinct truthful states.
- Frontend checks improve truthful navigation only. Tenant-scoped backend
  authorization remains authoritative.

Routes without `requiredPermission` have no matching read permission in the
current system catalog. In particular, PR and RFQ reads retain backend tenant
and authorization boundaries without inventing a frontend permission code.
Review Queue also has no dedicated review permission today, so it remains
capability-gated plus backend-authorized.

## Guard precedence

Direct access follows this deterministic order:

1. route resolution
2. exact Legacy redirect
3. root-to-canonical-child redirect
4. hard route boundary: Frozen, Internal, Legacy unavailable, Not implemented
5. authenticated application shell
6. authorization loading/failure
7. exact permission
8. capability loading/failure
9. exact capability
10. page render

Frozen routes cannot be opened through capability flags, experimental settings,
or cached module settings. `NOT_IMPLEMENTED` never falls through to an
unrelated panel.

## Independent maturity

Read and write maturity are declared independently. Core classification does
not imply an authoritative write:

- Today, RFQ list, Receiving list, and Inventory balance are authoritative
  reads with unavailable writes.
- Canonical PR and PO routes declare their supported authoritative command
  boundary explicitly.
- Transactional Extension routes are capability-gated.
- Frozen routes are unavailable for read and write.
- Legacy routes are retired for read and write.

## Truthful RFQ and Legacy semantics

The RFQ list reads tenant-scoped PostgreSQL documents. RFQ detail is recognized
but marked `NOT_IMPLEMENTED`; list identifiers are plain text and direct detail
URLs render “页面尚未接通” with a return path. They never render Procurement
Workbench.

Only `/app/imports` has an exact Legacy redirect to Universal Intake. It uses
replace navigation and preserves query and hash. The former pilot, templates,
validation, and failed subroutes have no one-to-one replacement and render a
retired-route state instead of silently redirecting.

## Operational Finance compatibility boundary

Operational Finance remains an Extension. Cashbook, Internal Settlement, Bank
Statement, and Bank Reconciliation routes are marked compatibility-only:

- classification `EXTENSION`
- navigation `HIDDEN`
- exact capability and exact permission required for direct access
- excluded from default SME navigation and ordinary Finance secondary
  navigation

Their APIs, models, migrations, and compatibility tests remain intact. The
current Cashbook surface is carried by `finance:reconciliation`; there is no
separate Cashbook route. These tools are not presented as default SME Core.

## Route search and stability audit

The static searchable projection excludes Internal, Frozen, Legacy, and
compatibility-only routes. When runtime access context is supplied, it also
excludes disabled capabilities and missing permissions. Metadata search cannot
be treated as authorization.

The “159/159 frontend route stability audit” proves only:

- route resolution
- application-shell rendering
- no frontend 404 recovery
- no render crash
- no API 5xx observed during the audit

It does not prove business semantics, data authority, permission correctness,
capability correctness, or complete page functionality. Those are covered by
focused contract and browser tests.

## Deferred stale-session issue

The global 401 recovery issue is intentionally outside PR #15. Restarting the
local API with a changed session secret can invalidate a cached token while the
shell still displays cached user state. The API correctly returns 401;
logout/login restores operation and PostgreSQL data remains intact. Global 401
interception, auth-storage cleanup, return URL recovery, and a stable
Product-Recovery secret belong to a later session-focused change.

## Connected Enterprise boundary

Future SAP, Odoo, Kingdee, accounting, messaging, or commerce connectors belong
behind explicit tenant-scoped adapters with provenance, idempotency, review,
audit, and failure semantics. This PR adds no connector, schema, migration, or
external mutation behavior.
