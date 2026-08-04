# Production Deployment Foundation v1

## Status and authority

FlowChain is a PostgreSQL-only Node 24 monolith. This foundation makes its current runtime repeatable and observable without changing business routes, authority, Prisma schema, authentication design, or product capabilities.

## Runtime ownership

Production lifecycle support follows the decomposed server runtime:

```text
scm-server.mjs
  -> composition and production validation only
http-request-handler.mjs
  -> HTTP orchestration and established route precedence
runtime-routes.mjs
  -> health, readiness, and local diagnostics
server-lifecycle.mjs
  -> SIGTERM/SIGINT, HTTP drain, forced connection close, and Prisma disconnect
```

The runtime route owner executes before repository construction, Session
identity parsing, and business route context creation. `scm-server.mjs` does
not contain an inline HTTP route chain or lifecycle implementation.

## Container contract

The repository `Dockerfile` uses a locked multi-stage build. The build stage runs `npm ci`, generates Prisma Client, and builds the Vite frontend. The final image runs as the non-root `node` user and contains only the built frontend, server/shared runtime, Prisma schema and migrations, package metadata, and locked Node modules required by the application and the separate migration release step. It contains no Git directory, environment file, local JSON data, local attachment data, browser artifacts, or test sources.

Supply immutable build identity at image build time:

```bash
docker build \
  --build-arg FLOWCHAIN_COMMIT_SHA=<full-commit-sha> \
  --build-arg FLOWCHAIN_BRANCH=<release-branch> \
  -t <registry>/<image>:<version> .
```

No database migration runs during image build. No secret is accepted as a build argument.

## Production configuration contract

With `NODE_ENV=production`, the server validates configuration before it starts listening. Required settings are:

| Setting | Contract |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string, supplied at runtime only |
| `FLOWCHAIN_PERSISTENCE_MODE` | Must explicitly equal `database` |
| `FLOWCHAIN_DEFAULT_TENANT_ID` | Must identify the provisioned runtime tenant |
| `FLOWCHAIN_LOCAL_SESSION_SECRET` | Runtime secret of at least 32 characters |
| `FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER` | Must explicitly select the supported `local` durable provider |
| `FLOWCHAIN_UPLOAD_STORAGE_DIR` | Absolute, non-temporary durable volume path |
| `FLOWCHAIN_COMMIT_SHA` | Immutable build commit identity |
| `FLOWCHAIN_BRANCH` | Recommended release branch identity; health reports `unknown` only when omitted outside the reference release |

When Mobile Sync is explicitly enabled, its current cursor key id and a cursor secret of at least 32 characters are also required. Disabled capabilities do not force unrelated secrets. Configuration failures list setting names, never setting values, database URLs, or attachment paths.

The local signed Session mechanism is unchanged in this PR. Production Identity, durable sessions, password/OIDC authentication, invitation, and revoke flows remain future work.

## Liveness and readiness

`GET /api/health` is unauthenticated and lightweight. It reports process liveness, service/build identity, Node version, PostgreSQL authority, and a timestamp. It does not construct repositories or query PostgreSQL/filesystem health.

`GET /api/ready` is unauthenticated and performs the traffic-readiness checks:

- validated runtime configuration;
- PostgreSQL connection and `SELECT 1`;
- existence of `FLOWCHAIN_DEFAULT_TENANT_ID`;
- writable attachment storage health;
- PostgreSQL authority.

Success is `200`. Failure is `503` with `FLOWCHAIN_RUNTIME_NOT_READY` and only `ready`/`not_ready` check states. Raw Prisma errors, connection strings, credentials, absolute paths, and stack traces are not returned.

## Migration and attachment contracts

Use the same immutable image for the migration release step and the application. Run `npx prisma migrate deploy` before changing the application container. A failed migration blocks the release. Application startup never applies migrations.

The supported v1 attachment provider is a durable local filesystem mounted at `FLOWCHAIN_UPLOAD_STORAGE_DIR`. The volume lifecycle is independent from the application container lifecycle and requires its own backup/restore checks. S3/OSS is not added by this release.

## Graceful shutdown

The formal server entry registers `SIGTERM` and `SIGINT` handlers only when the server is started. Shutdown is idempotent: it stops accepting connections, allows HTTP requests to drain, closes idle/remaining connections at the bounded timeout, disconnects the shared Prisma client, and emits concise redacted lifecycle logs. Importing server modules does not register signal handlers.

## CI image smoke

The `production-container` CI job builds the final image and creates an isolated PostgreSQL 16 container, network, and attachment volume. It then:

1. runs `prisma migrate deploy` separately from application startup;
2. provisions an isolated tenant, user, and one PO in PostgreSQL;
3. starts the final image with non-production test credentials;
4. verifies `/api/health` and `/api/ready`;
5. logs in and reads a tenant-scoped procurement document;
6. sends `SIGTERM` and requires exit code `0` plus the graceful shutdown completion signal.

The smoke does not call external AI providers or any cloud environment and cleans up its isolated Docker resources.

## Controlled Staging flow

See [`deploy/README.md`](../deploy/README.md) and [`deploy/docker-compose.staging.yml`](../deploy/docker-compose.staging.yml). The release boundary is backup, immutable pull, migration, application update, liveness, readiness, and authenticated smoke. The application image can be rolled back; applied migrations are not automatically reversible.

## Current limitations

- Single application instance and durable local attachment volume only.
- No managed identity or durable Session model.
- No S3/OSS, Kubernetes, Redis, queue, or microservice split.
- No automated database down migration.
- No change to business authority or capability enablement.
- HTTPS termination, managed PostgreSQL, backups, monitoring, secret delivery, and host hardening are external operator responsibilities.

The next production foundation should address Production Identity and durable Session lifecycle without weakening the PostgreSQL-only or tenant-scoped contracts established here.
