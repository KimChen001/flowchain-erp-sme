# Controlled single-instance Staging deployment

This reference keeps the current FlowChain monolith intact:

```text
HTTPS reverse proxy or cloud gateway
  -> one FlowChain Node container
  -> managed or separately operated PostgreSQL
  -> persistent local attachment volume
```

It is a reproducible Staging reference, not a managed SaaS platform. The reverse proxy, PostgreSQL backup policy, secret manager, TLS certificate, monitoring, and host hardening remain operator responsibilities.

## Prepare

1. Build and publish the repository `Dockerfile` with immutable `FLOWCHAIN_COMMIT_SHA` and `FLOWCHAIN_BRANCH` build arguments.
2. Copy `env.production.example` to the untracked `env.production` file and replace every placeholder through the deployment secret mechanism.
3. Set `FLOWCHAIN_IMAGE` to an immutable digest whenever the registry supports it.
4. Confirm the PostgreSQL backup can be restored and the attachment volume is backed up independently.

The committed Compose file does not include PostgreSQL. Staging must use a managed or separately operated PostgreSQL 16-compatible service.

## Release order

Run from this directory:

```bash
docker compose --env-file env.production -f docker-compose.staging.yml pull
docker compose --env-file env.production -f docker-compose.staging.yml --profile release run --rm migrate
docker compose --env-file env.production -f docker-compose.staging.yml up -d flowchain
curl --fail http://127.0.0.1:8787/api/health
curl --fail http://127.0.0.1:8787/api/ready
```

Then perform a login and one authenticated tenant-scoped procurement read through the HTTPS gateway before switching normal Staging traffic.

The required sequence is:

```text
backup
-> pull immutable image
-> run prisma migrate deploy
-> start/update application
-> check /api/health
-> check /api/ready
-> authenticated smoke
```

Migration is intentionally separate from application startup. If migration fails, do not update the application or switch traffic.

## Rollback boundary

- The application can be switched back to the previously known-good immutable image.
- A successfully applied migration must not be assumed to support automatic down migration.
- Destructive migrations are outside this foundation and require a separately reviewed recovery plan.
- If the newer application wrote data that the older application cannot interpret, stop and follow the release-specific recovery plan instead of blindly rolling back.
- Restore PostgreSQL or attachment data only through the operator's tested backup procedure.

## Operations

The application binds only to loopback in this reference; publish it through an HTTPS gateway. Preserve the attachment volume across application replacement. Send `SIGTERM` and allow the configured grace period before forcing termination. `/api/health` is liveness only; route traffic only while `/api/ready` returns `200`.
