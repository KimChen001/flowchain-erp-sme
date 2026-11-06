# Error tracking and alerts

How to find out that FlowChain on Render is failing, without adding a paid
monitoring service. It builds on the JSON log lines described in
[server-error-health-safety-v1.md](server-error-health-safety-v1.md) and on the
Render setup in [deploy-render.md](deploy-render.md).

There are three layers:

1. **Logs.** Every unexpected error writes one `server_error` line, every crash
   one `process_error` line, and every API request one `http_request` line.
   They are in the service's **Logs** page on Render.
2. **Error alerts.** When `FLOWCHAIN_ERROR_WEBHOOK_URL` is set, the server posts
   a short alert for each new error to a chat channel (Slack, Discord or any
   endpoint that accepts JSON).
3. **Platform alerts.** Render's own notifications for failed deploys and
   failed health checks, and an outside uptime check on `/api/ready`. These are
   settings the owner turns on; nothing in the code does it.

Anything marked **UNVERIFIED** was not confirmed in Render's documentation and
should be checked the first time you do it.

## What gets logged

| Line | When | Main fields |
| --- | --- | --- |
| `"event":"http_request"` | Every API request (not `/api/health` or `/api/ready`), and any other request that fails with 5xx | `method`, `path`, `status`, `durationMs`, `tenantId`, `userId` |
| `"event":"server_error"` | An error the server did not expect: thrown out of a route, caught by a route that then answered 500, or a 500 answered without any error being reported | `requestId`, `method`, `path`, `status`, `phase`, `error`, `errorName`, `errorCode`, `stack`, `tenantId`, `userId`, `commitSha` |
| `"event":"process_error"` | An uncaught exception or unhandled promise rejection. The line carries `"fatal":true`; the process then exits with code 1 and Render restarts it | `phase` (`uncaughtException` or `unhandledRejection`), `error`, `errorName`, `errorCode`, `stack`, `commitSha` |
| `"event":"error_webhook_failed"` | The alert endpoint refused or did not answer. At most one line per 5 minutes | `status` (0 when unreachable) |
| `"event":"error_webhook_disabled"` | At start, when `FLOWCHAIN_ERROR_WEBHOOK_URL` is set but is not an https URL | `reason` |

`phase` says where a `server_error` was caught: `boundary` (thrown out of the
request handler), `route` (a route caught it and answered 500), `after_headers`
(thrown after the response had started, so the caller saw a cut-off response),
`response` (a 500 that no code reported; `errorName` is
`UnreportedServerError` and there is no stack).

What is and is not in the logs:

- Never logged: request headers (so cookies and bearer tokens), request
  bodies, query strings, and the webhook URL.
- Error messages and stacks *are* logged, after known secret shapes are
  redacted (`server/observability/redact.mjs`): bearer and basic credentials,
  `Authorization:` values, `sk-` keys, `x-api-key`/`apiKey`/`accessToken`-style
  and `..._API_KEY=`, `..._SECRET=`, `..._TOKEN=`, `..._PASSWORD=` values, JSON
  `"password"`/`"secret"`/`"token"`/`"apiKey"` fields, PostgreSQL, MySQL, Redis
  and MongoDB connection strings, credentials in any other URL, and Slack and
  Discord webhook URLs. Redaction knows shapes, not values, so a message can
  still hold other text, such as a value from a failed database constraint.
- Paths are logged as requested, so record ids in them (a purchase order or
  supplier id) appear.
- Signed-in tenant and user ids appear as ids; names and emails are not added
  by the logger.
- In production a stack keeps its first 8 frames; elsewhere it is complete.
- Client errors (4xx) that reach the error reporter, such as the 403 for a
  request without a workspace, are logged at `level: "warn"` and never alert.

To follow one failure, take the `requestId` from the error response or the
`X-Request-Id` header and search the logs for it: the `server_error` line and
the `http_request` line share it.

## Searching the Render logs

Open the service, then **Logs**, and type into the search box:

| Search for | Finds |
| --- | --- |
| `"event":"server_error"` | Every unexpected error |
| `"status":5` | Every API request that ended with a 5xx status |
| `process_error` | Crashes. Each one is followed by a restart |
| `FlowChain listening` | Every start of the server: deploys, restarts after a crash, restarts after a failed health check |
| `FLOWCHAIN_PRODUCTION_CONFIG_INVALID` | A start refused because a setting is missing or invalid. The line names the variables, never their values |
| `UnreportedServerError` | 500 responses whose route did not report the error. Worth a code fix: the line has no stack |
| `error_webhook_failed` | Alerts that did not reach the channel |
| a request id | Everything about one request |

Health check failures, restarts and deploys also appear on the service's
**Events** page.

**UNVERIFIED:** how long Render keeps logs on the Hobby and Pro workspace
plans, and whether log streams (forwarding logs to an outside syslog
endpoint) are available on those plans. Check **Logs** and the workspace's
**Log Streams** settings once the services exist.

## Setting up error alerts

The alert goes to an *incoming webhook*: a secret URL that posts whatever it
receives into one chat channel. Both Slack and Discord offer them for free.

### Slack

1. Go to <https://api.slack.com/apps>, click **Create New App** >
   **From scratch**, name it `FlowChain alerts` and pick the workspace.
2. Open **Incoming Webhooks**, switch **Activate Incoming Webhooks** on, click
   **Add New Webhook to Workspace** and choose the channel (for example
   `#flowchain-alerts`).
3. Copy the URL. It starts with `https://hooks.slack.com/services/`.

Slack shows the alert's `text` field.

### Discord

1. In the server, open **Server Settings** > **Integrations** > **Webhooks** >
   **New Webhook**, name it `FlowChain alerts` and choose the channel.
2. Click **Copy Webhook URL**. It starts with `https://discord.com/api/webhooks/`.

Discord shows the alert's `content` field.

### Turning it on

1. In Render, open the service (start with `flowchain-staging`) >
   **Environment**, set `FLOWCHAIN_ERROR_WEBHOOK_URL` to the copied URL and
   save. Saving redeploys the service.
2. From a checkout of the repository, send a test alert (macOS, Linux, Git
   Bash):

   ```sh
   FLOWCHAIN_ERROR_WEBHOOK_URL='https://hooks.slack.com/services/...' node scripts/send-test-alert.mjs
   ```

   In PowerShell:

   ```powershell
   $env:FLOWCHAIN_ERROR_WEBHOOK_URL = 'https://hooks.slack.com/services/...'; node scripts/send-test-alert.mjs
   ```

   It prints whether the channel accepted the alert. The script is not in the
   Docker image, so it runs from your own computer, not from the Render shell.
3. Repeat for `flowchain-production`, ideally with a separate channel.

Treat the URL as a password: anyone holding it can post into the channel. Do
not paste it into tickets, chat or `render.yaml`, and do not set it in a local
`.env` (local test runs would then post alerts). If it leaks, delete the
webhook in Slack or Discord and create a new one.

**UNVERIFIED:** the alert JSON carries fields besides `text` and `content`
(`event`, `service`, `path`, `errorCode` and so on). Slack and Discord are
expected to ignore fields they do not use; the test alert has the same shape,
so a successful test confirms it.

### What an alert contains

```text
FlowChain flowchain-production: server_error P1001 on 500 GET /api/home/overview (request 3f0c2c8e-...)
```

The JSON body also has `event`, `service` (Render's service name), `commitSha`,
`requestId`, `method`, `path`, `status`, `errorName`, `errorCode`, `time` and
`suppressed`. It never has the error message, the stack, tenant or user ids,
or anything from the request. A path segment that contains `@` or `%40` is
replaced by `[redacted]`. To see the details, search the logs for the request
id.

### How often alerts are sent

- Only server-side failures alert: 5xx responses, errors after a response had
  started, and crashes. Client errors (4xx) are logged but never alert, so
  they cannot use up the hourly limit.
- One alert per error code and path in any 5 minutes, and at most 10 alerts an
  hour in total.
- Alerts held back are counted; the next alert for the same code and path says
  `N more held back` and carries the count in `suppressed`. Counts for code and
  path pairs that stay quiet are folded into the next alert of any kind, and
  the server tracks at most 500 pairs, so memory stays bounded.
- The limits are per running process, so they start again after a restart.
- Sending never delays or fails a request. It runs after the error is logged,
  gives up after 3 seconds, refuses redirects (so it cannot be sent on to a
  plain http address), and a failure only writes one `error_webhook_failed`
  line per 5 minutes.
- On a crash the server waits up to 2 seconds for the alert to leave, then
  exits with code 1 as before.

## Health checks

| Path | Meaning | Use |
| --- | --- | --- |
| `/api/health` | Liveness: the process is up and answering. Touches no database | Render's health check (`healthCheckPath` in `render.yaml`). If it fails, Render restarts the instance |
| `/api/ready` | Readiness: configuration, database, default tenant and attachment storage are all ready. 503 names the check that failed | The smoke test after a deploy, and the outside uptime check below |

Neither is written to the access log, so frequent probes do not bury real
traffic.

## Owner actions

These are settings, not code. Do them once per environment unless noted.

1. **Render notifications.** In the Render dashboard, open the workspace's
   **Notifications** settings (and each service's notification settings) and
   turn on email or Slack notifications for failed deploys and for service
   failures. **UNVERIFIED:** the exact event names Render offers (for example
   deploy failed, health check failed, server unhealthy) and whether Slack
   delivery is available on the Hobby plan.
2. **Error alert webhook.** Create the webhook and set
   `FLOWCHAIN_ERROR_WEBHOOK_URL` as described above.
3. **Uptime check on `/api/ready`.** Use any free uptime monitor that can
   request a URL every few minutes and email you on failure (for example the
   free tier of an uptime monitoring service). Point it at
   `https://<service>.onrender.com/api/ready` and alert on any status other
   than 200. This catches a database outage or a lost tenant, which
   `/api/health` deliberately does not check.
4. **Monthly test alert.** On the first working day of each month, run
   `node scripts/send-test-alert.mjs` with the production URL and confirm the
   message arrives. A webhook can stop working silently when the Slack app or
   the Discord integration is removed.

## For developers

- `server/observability/error-reporter.mjs` holds the reporter: the log line,
  the webhook, its rate limit, `flush()` and `sendTestAlert()`. Redaction is in
  `server/observability/redact.mjs`, shared with `server/utils/safe-errors.mjs`.
- One reporter is built per server in `createScmServer` and shared by the
  error boundary and the route context, so all alerts share one rate limit.
- A route that catches an error and answers 500 itself must call
  `ctx.reportError?.(error)` before sending, so the error is logged with its
  stack. A 500 without that call is still logged, as `UnreportedServerError`.
- **Known follow-up:** routes that answer `error.status || 500` (or similar)
  without calling `ctx.reportError` yet, among them master-data (about ten
  sites), data-import, settings-runtime, authorization, exception-cases,
  inventory-operations, user-confirmed-actions and ai-knowledge, show up only
  as `UnreportedServerError`: no error name, code or stack, and the alert's
  code is `HTTP_500`. Adding `if (status >= 500) ctx.reportError?.(error)`
  before each send fixes that without changing any response.
- `registerProcessErrorHandlers` in `server/bootstrap/server-lifecycle.mjs`
  handles crashes; `startScmServer` registers it.
- Tests: `server/domain/error-reporter.test.mjs`.
