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

## US trial capability set

Capabilities outside the stable core stay off until their switch is `true`. `env.production.example`, `.env.example` and `.env.local.example` define the US trial set, using the environment names that `server/domain/capability-registry.mjs` reads:

| Switch | Capabilities it enables |
| --- | --- |
| `FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING` | `receiving-posting`, `receiving-reversal`: desktop receiving. A user with `receiving.prepare` drafts a receipt from an issued or partially received PO (Receive on the PO page), submits it, and a user with `receiving.post` posts it to inventory. |
| `FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING` | `sales-order-lifecycle`, `sales-reservation`, `sales-shipment-draft`, `sales-shipment-posting`, `sales-shipment-reversal` |
| `FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS` | `stock-transfer`, `cycle-count`, `inventory-adjustment-document` |
| `FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE` | `finance` (main navigation entry), `supplier-invoice`, `three-way-match`, `payable-obligation`, `supplier-credit-memo`, `customer-invoice`, `receivable-obligation`, `customer-credit-note` |
| `FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS` | `mobile-operations`: mobile tasks, PO approval and receiving, plus attachment evidence. Optional for receiving: the desktop approves POs and creates receipts without it, and the mobile facade uses the same receiving draft commands when it is on. |

Operational finance records invoices, matching, payables and receivables; it does not execute payments, collections, refunds, FX, tax filing or general-ledger postings. Returns and quarantine, internal settlement, settlement workflow, bank reconciliation, Mobile Sync and Universal Intake stay off in the trial. When a capability is off, its navigation entry and in-page links are hidden; a direct link still shows "Capability unavailable". `server/domain/us-trial-capabilities.test.mjs` keeps the three example files and the registry in step.

## Sign-in email

People sign in with a single-use link sent to their provisioned email address. The link is valid for 15 minutes and works once. Opening it shows a "Sign in to <workspace>" button; nothing signs in until that button is clicked, so mail scanners that fetch links in advance cannot use them. A signed-in session is stored in PostgreSQL, lasts 8 hours, survives deploys and restarts, and ends on sign-out, when the user is disabled, or when their role changes.

The server sends the email through the provider named by `FLOWCHAIN_MAIL_PROVIDER`. Production refuses to start unless all of these are set:

| Variable | Value |
| --- | --- |
| `FLOWCHAIN_MAIL_PROVIDER` | `postmark` or `resend`. `outbox` (the local-development default) is refused in production. |
| `POSTMARK_SERVER_TOKEN` | With `postmark`: the Server API token of the Postmark server that sends sign-in mail. Sent on its transactional (`outbound`) stream. |
| `RESEND_API_KEY` | With `resend`: an API key with sending access. |
| `FLOWCHAIN_MAIL_FROM` | Sender, for example `FlowChain <sign-in@your-domain.com>`, on a domain or sender signature verified with the provider. |
| `FLOWCHAIN_PUBLIC_BASE_URL` | The public https origin of this deployment, for example `https://flowchain.your-domain.com`. Sign-in links point to `<origin>/sign-in/confirm`. |

Also set `FLOWCHAIN_TRUST_PROXY=true` behind the HTTPS gateway, so the client IP comes from the last `X-Forwarded-For` entry the gateway appended. Without it every request appears to come from the gateway, and the per-IP limit below applies to everyone at once.

Keep provider keys in the secret mechanism that fills `env.production`; never commit them. Tests never call Postmark or Resend: the adapters are tested with an injected `fetch`, and local development and tests use the outbox provider, which writes each message to a JSON file in the OS temp directory (or `FLOWCHAIN_MAIL_OUTBOX_PATH`).

The older email-only sign-in, `POST /api/auth/login`, exists only in local development (`NODE_ENV=development`, `FLOWCHAIN_DEV_LOCAL=true` and a localhost database) and in test mode (`NODE_ENV=test`). In production it answers `404`, and the server refuses to start with `NODE_ENV=test` or `FLOWCHAIN_DEV_LOCAL=true`.

`POST /api/auth/email-link` always answers `202` with the same body, whether or not the address belongs to an active user, so it cannot be used to discover accounts. It accepts at most 5 requests per email address and 20 per client IP per hour, counted in PostgreSQL; requests over the limit still get `202`, send nothing, and are logged. Issuing a link invalidates the user's earlier unused links. Requests, used links, new sessions, sign-outs and revoked sessions are written to the audit log by user id, without the email address.

## Release order

Run from this directory:

```bash
docker compose --env-file env.production -f docker-compose.staging.yml pull
docker compose --env-file env.production -f docker-compose.staging.yml --profile release run --rm migrate
docker compose --env-file env.production -f docker-compose.staging.yml up -d flowchain
curl --fail http://127.0.0.1:8787/api/health
curl --fail http://127.0.0.1:8787/api/ready
```

Then sign in with an emailed link and perform one authenticated tenant-scoped procurement read through the HTTPS gateway before switching normal Staging traffic.

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
