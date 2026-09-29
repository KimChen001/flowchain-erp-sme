# FlowChain Prisma Scaffold

Database persistence is opt-in. The default JSON runtime remains available for
the existing UAT and preview modules, while formal receiving posting/reversal is
database-only and requires `FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING=true`.

## Commands

- `npm run db:generate`: generate Prisma Client.
- `npm run db:push`: push schema to an explicitly configured database.
- `npm run db:migrate`: create/apply a development migration.
- `npm run db:studio`: open Prisma Studio.
- `npm run db:check-drift`: fail if `schema.prisma` no longer describes what
  `migrations/` creates. Needs no `DATABASE_URL`; see below.

All commands require an explicit `DATABASE_URL` through `prisma.config.ts`, except `db:check-drift`. Normal `npm test`, `npm run typecheck`, and `npm run build` do not require a database.

## Schema drift check

The migrations are hand-written SQL, and they are the source of truth.
`schema.prisma` must describe the database they produce. Otherwise
`prisma db push` changes that database to match the schema, and
`prisma migrate dev` adds the same changes to its next migration. Those
changes can include dropping foreign keys, indexes, and column defaults.

`npm run db:check-drift` runs `prisma migrate deploy` against a throwaway
embedded PostgreSQL on a random port. It then runs
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
The check fails if the diff has any statement not listed in `ALLOWED_DRIFT` in
`scripts/check-prisma-schema-drift.mjs`. It also fails if an allowed statement
no longer appears. It never reads `.env` files or connects to a configured
database. Pass `--print` to see the whole diff.

When the check fails, fix it in one of two ways:

- Update `schema.prisma` if the migrations are right. Declare the relation,
  `@@index`, default, or `map:` name that the migration SQL creates. That
  includes `onDelete`/`onUpdate`: a `REFERENCES` clause without `ON UPDATE`
  is `onUpdate: NoAction`, not Prisma's default `Cascade`. PostgreSQL
  truncates identifiers to 63 bytes, so a long constraint or index name needs
  `map:` with the truncated name.
- Add a migration if the database itself is wrong.

Add an `ALLOWED_DRIFT` entry, with its reason, only when Prisma cannot express
an object and a migration should not change it. The list is currently empty.
One such case came up: PostgreSQL had truncated an index and a foreign key to
the same name, which Prisma cannot declare. It was fixed by renaming the index
in `20260929020000_bank_line_allocation_index_name`.

The diff does not cover these objects, which Prisma leaves alone:

- Check constraints, triggers, and functions.
- Partial unique indexes, such as `SupplierInvoice_tenant_supplier_number_key`
  (the `partialIndexes` preview feature is not enabled).
- The expression index `WorkspaceInvitation_active_email_key`.

`AiKnowledgeChunk.embeddingVector` and its HNSW indexes exist only where the
pgvector extension is installed (`20260910100000_optional_pgvector_knowledge`
and `server/domain/ai-pgvector-store.mjs`). They are intentionally absent from
`schema.prisma`. The embedded check database has no pgvector, so it cannot see
them. `prisma db push` against a pgvector database would still drop that
column.

## Migration rollout

- Empty database: run `prisma migrate deploy`; the baseline migration creates
  the pre-existing schema and the following additive migration installs the
  receiving posting foundation.
- Existing database previously managed with `prisma db push`: back up the
  database, verify it matches `20260715010000_baseline`, then mark only that
  baseline as applied with `prisma migrate resolve --applied
  20260715010000_baseline`. Run the additive migration normally afterward.
- Before the additive migration, run
  `migrations/20260715011000_receiving_posting_foundation/preflight.sql`.
  Returned rows represent duplicate inventory-balance natural keys and require
  business-approved remediation. The migration fails closed and never removes
  or merges these records automatically.

Never mark the additive receiving migration as applied unless its columns,
indexes, constraints, and command-execution table already exist.

## Current Scope

The initial schema covers low-risk persistence foundations:

- tenant/user context;
- master data references;
- action draft preview shell;
- action draft validation and audit trail;
- audit log;
- compact AI evidence;
- transactional receiving posting and reversal;
- immutable receipt/reversal movements, balance reconciliation, PO received
  quantities, structured audit, database idempotency, and tenant isolation.

It does not add outbound posting, transfer, stock count, costing, AP/GL, tax
filing, supplier-message writes, or a complete warehouse UI.
