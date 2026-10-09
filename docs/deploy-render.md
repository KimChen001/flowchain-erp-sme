# Deploying FlowChain on Render

This runbook takes you from no account to a running US trial on
[Render](https://render.com). It assumes no hosting experience. Every step is
done in a web browser, except where a command is shown.

The repository's `render.yaml` (a Render *Blueprint*) describes everything Render
creates. There are two environments, each with:

- one web service, `flowchain-staging` or `flowchain-production`, built from the repository `Dockerfile`, in the Virginia (US East) region;
- one 1 GB or 10 GB persistent disk for attachments, mounted at `/var/lib/flowchain/uploads`;
- one managed PostgreSQL 16 database, `flowchain-staging-db` or `flowchain-production-db`.

Each service runs as a single instance. Attachments are stored on the service's
own disk, and a Render disk can only belong to one instance, so the service
cannot be scaled out. A disk also means every deploy has a few seconds of
downtime: Render stops the old instance before it starts the new one.

Facts about Render in this document come from Render's documentation as read on
2026-09-30. Anything marked **UNVERIFIED** was not confirmed there and should be
checked the first time you do it.

> **How people sign in.** A user enters their email address and receives a
> sign-in link. The link works once and expires after 15 minutes; a session then
> lasts 8 hours and is stored in PostgreSQL. Only active users provisioned in
> the workspace receive a link. The older form that signed in with an email
> address alone exists only in local development; in production that route
> answers 404. Because sign-in depends on email, neither service (staging or
> production; both run the production profile) starts until a mail provider is
> configured (see the table in step 2).
>
> **Approval emails.** The same provider and sender also tell approvers when
> a purchase request, purchase order, bill or inventory adjustment is waiting
> for them. The email gives only the document type, its number and a link;
> it approves nothing. Every user receives them unless they turn them off in
> System Administration > My Profile, so tell users before the first deploy.
> To turn them off for the whole service, add `FLOWCHAIN_APPROVAL_EMAILS` =
> `off` on the **Environment** page (see `deploy/README.md`).

## 0. What you need

- The GitHub account that can see the `KimChen001/flowchain-erp-sme` repository.
- A payment card. Disks and pre-deploy migrations need paid plans, so neither service can use Render's free plan.
- The tenant id you want for each environment: 3 to 64 lowercase letters, digits or hyphens, for example `flowchain-staging` and the customer's short name for production. It is not secret, but it cannot easily be changed later.
- The first administrator's email address and name.
- A Postmark or Resend account with a verified sender domain. Sign-in links and approval emails are sent through it, and neither service starts without it.
- Optional: an OpenAI API key.

## 1. Create the Render account and connect GitHub

1. Go to <https://dashboard.render.com/register> and sign up with **GitHub**. This connects GitHub in the same step.
2. When GitHub asks which repositories Render may access, choose **Only select repositories** and pick `flowchain-erp-sme`.
3. Choose a workspace plan. **Hobby** ($0 a month plus usage) keeps 3 days of database point-in-time recovery and allows the two environments this Blueprint uses. **Pro** ($25 a month) keeps 7 days. For a paid trial, Pro is the safer choice. You can upgrade later, but the recovery window only grows from that point on.
4. Add the payment card under **Billing**.

## 2. Apply the Blueprint

1. In the dashboard, click **New** > **Blueprint**.
2. Select the `flowchain-erp-sme` repository and the `main` branch. Keep the Blueprint path `render.yaml`.
3. Give the Blueprint a name, for example `flowchain`.
4. Render lists what it will create (two services, two databases and a project named `flowchain`) and asks for every value marked `sync: false`. Fill them in from the table below. Render asks only this once. To change a value later, use the service's **Environment** page.
5. Click **Apply** (or **Deploy Blueprint**).

### Values you enter

Enter these for both `flowchain-staging` and `flowchain-production`.

| Variable | Secret? | What to enter |
| --- | --- | --- |
| `FLOWCHAIN_DEFAULT_TENANT_ID` | No | The tenant id for this environment, for example `flowchain-staging`. Use the same value in step 4. |
| `FLOWCHAIN_PUBLIC_BASE_URL` | No | The address users will open. Before the domain exists, use `https://flowchain-staging.onrender.com` or `https://flowchain-production.onrender.com`. Check the real address on the service page after the first deploy, because Render may add a suffix, and correct the value if it differs. |
| `FLOWCHAIN_MAIL_PROVIDER` | No | `postmark` or `resend`. Required: the service does not start without it. |
| `FLOWCHAIN_MAIL_FROM` | No | The sender address, for example `FlowChain <no-reply@getflowchain.com>`. It sends sign-in links and approval emails, so a `no-reply@` address suits both. Its domain must be verified with the mail provider. Required. |
| `POSTMARK_SERVER_TOKEN` | **Yes** | Your Postmark server API token. Required if the provider is `postmark`; otherwise leave it empty. |
| `RESEND_API_KEY` | **Yes** | Your Resend API key. Required if the provider is `resend`; otherwise leave it empty. |
| `OPENAI_API_KEY` | **Yes** | Your OpenAI API key, or leave it empty to keep the AI assistant off. |

**UNVERIFIED:** whether Render's Blueprint form accepts an empty value. If it
insists on one, enter the real value if you have it. Otherwise enter any text,
then delete that variable on the service's **Environment** page right after the
Blueprint is applied. Never leave a made-up value in a key field.

### Values Render sets for you

You do not type these:

- `FLOWCHAIN_LOCAL_SESSION_SECRET` is generated once by Render: a random 256-bit value that signs sessions. It is a secret. Do not copy it anywhere. Changing it signs everyone out.
- `DATABASE_URL` is linked to the environment's database. It contains the database password.
- The commit SHA. Render sets `RENDER_GIT_COMMIT` on every deploy and FlowChain reports it at `/api/health`. Do not add `FLOWCHAIN_COMMIT_SHA`.
- All other settings, such as `NODE_ENV=production`, database persistence, the attachment directory and the US trial capability switches, are fixed in `render.yaml`. `deploy/README.md` lists what each capability switch turns on.

## 3. First deploy

Applying the Blueprint starts the first deploy of both services. For each service:

1. Open the service and click **Events** or **Logs**. The first Docker build takes several minutes.
2. After the build, the **pre-deploy** step runs `npx prisma migrate deploy`. It creates the database tables. If it fails, the deploy stops and nothing goes live. The log shows why.
3. The service starts, and Render checks `/api/health` until it answers `200`. The deploy then shows **Live**.

Staging redeploys automatically each time a commit on `main` passes its GitHub
checks. Production never deploys on its own. To release, go to production's
**Manual Deploy** > **Deploy a specific commit** and pick a commit that has
already run well on staging.

At this point `/api/ready` still answers `503` with `"tenant": "not_ready"`.
That is expected until step 4 is done.

## 4. Provision the tenant

Do this once per environment. It is safe to repeat.

1. Open the service (start with `flowchain-staging`) and click **Shell**.
2. Run the following, with your own values (keep the quotes around values that contain spaces):

   ```sh
   npm run tenant:provision -- --tenant-id=flowchain-staging --company-name="Harbor Supply Co." --admin-email=owner@example.com --admin-name="Pat Lee"
   ```

   `--tenant-id` must equal the service's `FLOWCHAIN_DEFAULT_TENANT_ID`.

3. The output lists the tenant, warehouse and administrator it created, and the roles and permissions it granted, and ends with `result: changes applied`. If you run it again, it ends with `result: nothing to do, everything already provisioned`.

What it does:

- Creates the tenant with US defaults: country `US`, locale `en-US`, currency `USD`, time zone `America/New_York`, language `en-US`. Override any of them with `--country`, `--locale`, `--currency`, `--timezone` or `--language`.
- Creates one administrator and one warehouse (`--warehouse-code`, default `MAIN`; `--warehouse-name`, default `Main Warehouse`).
- Grants the default roles and permissions.
- Creates no other users, no suppliers, no items and no orders.
- Leaves existing records alone. If the tenant already exists, its stored name, currency, locale and other fields are kept, and the output says which flags differed. To change them on purpose, add `--update-existing`. It changes only the fields you passed as flags.
- Prints no passwords, keys or connection strings.

## 5. Smoke test

Replace the address with your service's address.

1. **Health**: open `https://flowchain-staging.onrender.com/api/health`. You should see `"live": true` and a `commitSha` that matches the latest commit on GitHub.
2. **Ready**: open `https://flowchain-staging.onrender.com/api/ready`. You should see `"ready": true`, with `configuration`, `database`, `tenant` and `attachmentStorage` all `"ready"`. See [Troubleshooting](#troubleshooting) if any of them is `not_ready`.
3. **Sign in**: open `https://flowchain-staging.onrender.com` and enter the administrator's email from step 4. Open the link in the email that arrives (check the mail provider's activity log if none does), then click the **Sign in to …** button (it names the workspace) on the page it opens: opening the link alone signs nobody in. The workspace should open in English.
4. **One procurement read**: open **Purchasing** and the purchase order list. A new workspace shows an empty list without an error.

From a terminal you can request the link for step 3 (macOS, Linux, or Git Bash or WSL on Windows; the quoting below does not work in PowerShell or cmd). The answer is the same `202` whether or not the address is provisioned, so confirm delivery in the mailbox or the provider's log:

```sh
BASE=https://flowchain-staging.onrender.com
curl -fsS -X POST "$BASE/api/auth/email-link" -H 'content-type: application/json' \
  -d '{"email":"owner@example.com"}'
```

Sessions are stored in PostgreSQL, so a deploy or restart does not sign anyone out.

Repeat steps 4 and 5 for `flowchain-production`.

Once both environments pass, set up error alerts and Render's notifications as
described in [operations-alerts.md](operations-alerts.md). It also lists the log
searches that find errors, crashes and restarts.

## 6. PostgreSQL backups

Render keeps these backups for paid databases. Both Blueprint databases are on paid plans.

- **Point-in-time recovery (PITR)** restores the database to any moment in the past 3 days (Hobby workspace) or 7 days (Pro or higher). Render does this by creating a *new* database instance, so you can check it before switching to it. The free database plan has no recovery at all.
- **Logical exports**: on the database's **Recovery** page, **Create export** makes a downloadable `.dir.tar.gz` file. Render keeps each export for 7 days. For longer retention, download the files and store them yourself.

### Restore drill (do this once before the trial, then every quarter)

Practice on staging. This drill never touches the live database.

1. Open `flowchain-staging-db` > **Recovery** > **Point-in-Time Recovery** > **Restore Database**.
2. Name the new instance `flowchain-staging-db-drill`. Pick a time at least ten minutes in the past (Render will not restore closer to now). Choose **Copy Existing Settings: Yes**, then click **Start Recovery**.
3. Wait until the instance shows **Available**.
4. Open the drill instance's **Info** page and copy its **PSQL Command**. Run it from a computer with the PostgreSQL 16 client installed, then check that your data is there:

   ```sql
   SELECT id, name, currency, timezone FROM "Tenant";
   SELECT count(*) FROM "User";
   SELECT count(*) FROM "PurchaseOrder";
   ```

5. Write down the date, the restore time you chose and how long the restore took.
6. Delete `flowchain-staging-db-drill`. It is billed like any database for as long as it exists (**UNVERIFIED**: the exact billing of recovery instances).

Also download one logical export and keep it somewhere outside Render.

**Real recovery (UNVERIFIED with Blueprints).** The services' `DATABASE_URL`
comes from `render.yaml`, and a Blueprint sync overwrites changes made in the
dashboard. Before you point production at a recovered instance, do this:

1. Open the Blueprint's **Settings** and set **Auto Sync** to **No**.
2. Contact Render support. The dashboard has a support link, and Render offers help with restores.
3. Then change `DATABASE_URL` on the service, or update `render.yaml` to match.

## 7. Attachment disk snapshots

Render takes a snapshot of each persistent disk every 24 hours and keeps each
snapshot for at least 7 days. To restore one, open the service's **Disk** page.

- A restore replaces the *whole* disk. Every file uploaded after that snapshot is lost. You cannot restore single files.
- Disk snapshots and database recovery are separate and not taken at the same moment. After restoring one, some attachment records may point to files that are missing, or files may exist with no record. Note the times you restored to.
- Rolling back a deploy never changes the disk.

## 8. Rollback

To go back to a previous version:

1. Open the service's **Deploys** page, find the last good deploy and click **Rollback**. Render reuses that build, so a rollback is faster than a rebuild. A rollback from the dashboard also turns off auto-deploy, so re-enable it in **Settings** once the problem is fixed. Production's auto-deploy is already off.
2. Alternatively, use **Manual Deploy** > **Deploy a specific commit** with the previous commit's SHA. This rebuilds the image.

Migrations never roll back:

- A migration that has already run stays in the database. `prisma migrate deploy` only adds migrations and has no automatic down step.
- Rolling back is safe when the newer release's migrations only *added* tables, columns or indexes that the older code ignores. Check `prisma/migrations/` in the release diff.
- **UNVERIFIED:** how the pre-deploy migration step behaves on a rollback when the database already has newer migrations than the older code knows about. Check the deploy log the first time.
- If the newer release changed or removed data the older code needs, do not roll back. Fix forward with a new commit, or restore the database with PITR to a time before the release (step 6) and accept the loss of changes made since then.

`deploy/README.md` has the general rollback rules.

## 9. Custom domain later: `app.getflowchain.com`

Do this after buying `getflowchain.com` and adding it to Cloudflare.

1. In Render, open `flowchain-production` > **Settings** > **Custom Domains** > **Add Custom Domain** and enter `app.getflowchain.com`. Because it is a subdomain, Render does not add a `www` version.
2. In Cloudflare, open the `getflowchain.com` zone:
   - Go to **SSL/TLS** > **Overview** and set the encryption mode to **Full**.
   - Go to **DNS** > **Records** and delete any `AAAA` record for `app`. Render does not support IPv6, and such a record breaks the domain.
   - Add a record with **Type** `CNAME`, **Name** `app`, **Target** the service's onrender address (for example `flowchain-production.onrender.com`) and **Proxy status** **DNS only** (grey cloud). Render must see the requests directly to verify the domain and issue the certificate.
3. Back in Render, click **Verify** next to the domain. DNS can take a few minutes. Once it is verified, Render issues and renews the HTTPS certificate automatically and redirects HTTP to HTTPS.
4. Update `FLOWCHAIN_PUBLIC_BASE_URL` on `flowchain-production` to `https://app.getflowchain.com` on the **Environment** page and save. Saving redeploys the service.
5. Keep the record on **DNS only**. With **Proxied** (orange cloud), every request reaches Render from a Cloudflare address, so the sign-in rate limit (20 link requests per IP per hour, read from the last `X-Forwarded-For` entry) would count all users as a handful of addresses. Proxying needs the app to trust Cloudflare's `CF-Connecting-IP` header first, which it does not do today.
6. Optional: to make the service answer only on the custom domain, add `renderSubdomainPolicy: disabled` to the production service in `render.yaml`.

For staging you can do the same with `staging.getflowchain.com` on `flowchain-staging`.

The mail provider will also ask for DNS records (SPF, DKIM and a return-path CNAME) for the sender domain. Add them in Cloudflare exactly as the provider shows them. Sign-in links and approval emails both depend on them. **UNVERIFIED**: no sender domain has been set up yet; this is an owner step.

### Security headers

Every response from the service carries browser security headers, set in
`server/bootstrap/security-headers.mjs`. There is nothing to configure:

- **Content-Security-Policy.** The browser runs scripts and makes API calls
  only to the service's own address. Images may also be `data:` or `blob:`.
  Inline styles and Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`)
  are allowed. Plugins, framing by other sites, and forms that post elsewhere
  are refused.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that
  turns off camera, microphone, location, payment, USB and ad topics.
- `Referrer-Policy: strict-origin-when-cross-origin`. The sign-in confirm page
  keeps `no-referrer`, because its address holds the single-use token.
- **HSTS:** `Strict-Transport-Security: max-age=31536000` (one year), only when
  the service runs the production profile and `FLOWCHAIN_PUBLIC_BASE_URL`
  starts with `https://`. Both Render services meet both conditions. It covers
  only the host users open. It has no `includeSubDomains` and no `preload`, so
  other names under `getflowchain.com` are not affected. A browser that has
  seen it will refuse plain HTTP for that host for a year.

If a page stops working after a release and the browser console shows
"Content Security Policy" errors, set `FLOWCHAIN_CSP_MODE` on the service's
**Environment** page and save (saving redeploys):

| Value | Effect |
| --- | --- |
| unset or `enforce` | The policy is enforced. This is the normal setting. |
| `report-only` | The browser allows everything and only lists the violations in its console. Use this while a fix is prepared. |
| `off` | No policy is sent. The other headers stay. |

Any other value enforces the policy, so a typo never turns it off. Delete the
variable once the fix is deployed. To check the headers, run
`curl -sI https://<service address>/` and read the response.

## 10. Rough monthly cost

**Estimate only**, based on the list prices at <https://render.com/pricing> on
2026-09-30, in US dollars, excluding tax. Check the pricing page before you rely
on it.

| Item | Plan in `render.yaml` | Staging | Production |
| --- | --- | ---: | ---: |
| Web service | `0.5c-512mb` / `1c-2g` | $7 | $25 |
| Attachment disk ($0.25 per GB) | 1 GB / 10 GB | $0.25 | $2.50 |
| PostgreSQL 16 | `0.1c-256mb` / `0.5c-1g` | $6 | $19 |
| Database storage ($0.30 per GB) | 5 GB / 10 GB | $1.50 | $3 |
| **Subtotal** | | **about $15** | **about $50** |

| Workspace plan | Monthly fee | Estimated total for both environments |
| --- | ---: | ---: |
| Hobby | $0 | about $65 |
| Pro | $25 | about $90 |

Not included:

- Bandwidth above the included amount (5 GB a month on Hobby, 25 GB on Pro).
- Build minutes above the included amount (500 a month on Hobby, 1,000 on Pro, then $5 per 1,000).
- PITR drill instances while they exist.
- The domain, the mail provider and OpenAI usage.

**UNVERIFIED:** how database storage is counted on these plans. The pricing
page mentions 1 GB included.

## Troubleshooting

`/api/ready` names the check that failed:

| Check | Meaning and fix |
| --- | --- |
| `configuration` | A required setting is missing or invalid. Usually you will not see this state: the server refuses to start, the deploy fails its health check, and the service log shows `FLOWCHAIN_PRODUCTION_CONFIG_INVALID` with the variable names, never their values. |
| `database` | The database is unreachable. Check that `flowchain-*-db` is **Available** and that `DATABASE_URL` is linked. |
| `tenant` | No tenant matches `FLOWCHAIN_DEFAULT_TENANT_ID`. Run step 4 with the same id, or correct the variable. |
| `attachmentStorage` | The disk at `/var/lib/flowchain/uploads` is not writable. The image runs as the unprivileged `node` user. **UNVERIFIED:** whether Render mounts the disk writable for a non-root user. If this check fails on the first deploy, contact Render support before uploading files. |

Other known gaps (see `deploy/README.md` and the release notes):

- The AI assistant's older request path sends OpenAI calls through a local proxy address when no proxy is configured. AI configuration is being consolidated separately. Until then, leave `OPENAI_API_KEY` empty in production.
