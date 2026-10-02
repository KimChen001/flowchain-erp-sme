# FlowChain Pilot Readiness Foundation

This runbook covers the PostgreSQL-backed Pilot foundation for the first transaction loop: Purchase Order → Receiving Document → Inventory Movement / Balance → PO progress and audit.

## Supported Pilot boundary

- Profile and workspace setup are stored in PostgreSQL.
- Provisioned users, roles, invitation state and warehouse read/operate scope are authoritative.
- Receiving posting and reversal enforce tenant, user and warehouse scope in both reads and commands.
- Pilot imports support items, suppliers, warehouses, locations, open purchase orders and opening inventory balances.
- Pilot exports are tenant-scoped and warehouse-scoped where the dataset has a warehouse dimension.
- Outbound, accounting execution, automatic email delivery and broad ERP expansion remain out of scope.

The JSON runtime is not an authoritative fallback for these Pilot capabilities. Run with `FLOWCHAIN_PERSISTENCE_MODE=database`.

## Deployment order

1. Back up PostgreSQL and verify the target workspace id.
2. Run `npm ci` and `npm run db:generate`.
3. Run `npx prisma migrate deploy`. Do not bypass a migration preflight failure.
4. Run `npm run pilot:check` with the production environment loaded.
5. Provision the initial workspace with `npm run pilot:setup -- --tenant-id=... --workspace-name=... --admin-email=... --admin-name=... --warehouse-code=... --warehouse-name=... --confirm-production=true`.
6. Run the setup command a second time and confirm it reports existing records without overwriting operator edits.
7. Start the API, sign in as the provisioned admin and open Pilot Setup Status and Admin Diagnostics.
8. Assign each user at least one warehouse read or operate scope before operational use. An administrator's role does not grant warehouse access by itself.

Never put passwords, database URLs, session secrets or invitation tokens in command output, documentation or source control.

## Required environment

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | PostgreSQL URL for the Pilot database |
| `FLOWCHAIN_PERSISTENCE_MODE` | `database` |
| `FLOWCHAIN_DEFAULT_TENANT_ID` | Provisioned workspace id |
| `FLOWCHAIN_LOCAL_SESSION_SECRET` | Random value of at least 32 characters |
| `FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING` | `true` |
| `FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT` | `true` for Phase 5.2 Internal Settlement and Cashbook |
| `FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP` | unset or `false` outside disposable local tests |

## User and invitation operations

- The database role assignments and tenant win over all client-supplied fields. Roles are assigned in Settings > Users & Roles (Roles & permissions); `PATCH /api/workspace/users/{id}` changes status only and refuses a role change with 422. A role assignment change or a status change invalidates the user's sessions.
- Disabled or unprovisioned users cannot sign in.
- A user cannot be disabled when that would leave no active user holding `settings.roles.manage`. Status changes run as Serializable transactions and are retried when a concurrent change in the same workspace aborts them; a change that still collides returns 409 `USER_CHANGE_CONFLICT`.
- Whoever holds `settings.users.read` or `settings.users.manage` gets every workspace warehouse from `GET /api/workspace/warehouses`, so a member's warehouse access shows in full. Everyone else gets only the warehouses in their own scope.
- Creating an invitation needs `settings.roles.assign` as well as `settings.users.manage`, because accepting it assigns the invited role.
- Invitation tokens are stored only as hashes. The raw invitation path is returned once for manual copy.
- Pilot does not send invitation email. An administrator must copy the invitation link through an approved channel and can revoke a pending invitation.

## Warehouse scope coverage

Receiving list/detail, preview, posting, reversal, evidence, links and reconciliation are scope-enforced. Pilot opening balances require `operate`; operational exports require at least `read`. Existence is masked on scoped receiving reads.

Legacy modules that have not moved to the PostgreSQL Pilot boundary may have their own visibility model. Do not treat their UI visibility as proof of warehouse authorization. The authoritative scope in this phase covers receiving, Pilot opening inventory and Pilot exports only.

## Import controls

- Accepted formats: CSV and XLSX; maximum 10 MB and 5000 data rows.
- Every commit requires a successful server-side Dry Run and a new idempotency key.
- The server revalidates authorization and commits all rows in a Serializable transaction.
- Raw files are not stored. File hash, mapping, normalized valid rows, issues, summary and audit evidence are stored.
- References are never auto-created. Invalid status, unknown SKU/supplier/warehouse, duplicate natural keys and scope failures block the entire batch.
- Opening quantities use four-decimal fixed-scale rules and cannot be negative.
- A successful opening balance creates immutable `opening_balance` movements, updates balances, records audit evidence and locks the workspace against a second opening import.
- Correct imported business data through governed business actions; do not mutate or delete inventory history.

## Exports and diagnostics

`GET /api/pilot/exports/{receiving_documents|inventory_movements|inventory_balances|import_issues}` returns at most 5000 tenant-scoped rows and declares truncation. Warehouse-bearing datasets honor the caller's read scope.

`GET /api/admin/pilot-diagnostics` requires `settings.diagnostics.read` and is read-only. It reports safe readiness signals for migrations, workspace completion, warehouses, active users and users who can manage roles, users without a warehouse scope, and import state. It never returns environment values, secrets, invitation tokens or database connection details.

## Verification and rollback

Before Pilot use, run `npm run typecheck`, `npm run build`, `npm test`, `npm run test:db:receiving`, `npm run test:api:receiving` and `npm run test:browser:receiving`.

Application rollback means deploying the preceding compatible application revision. Database migrations in this phase are additive; do not manually drop columns or tables during an incident. Restore from a tested backup only under an approved database recovery procedure. Posted receiving and opening movements are immutable and must be corrected with governed reversal/adjustment flows.
