# Server Error and Health Safety v1

Round 23 sanitizes server-level error responses and removes provider diagnostics from the default health endpoint.

## Error Policy

Unexpected server errors now return a generic user-facing response:

```json
{ "error": "Internal server error", "requestId": "3f0c2c8e-..." }
```

`requestId` matches the `X-Request-Id` response header and the server's log lines (see "Request IDs and Logs" below). It is present whenever the request passed through the composed server.

The response must not include:

- raw exception messages;
- stack traces;
- provider token values;
- environment variable names and values;
- database connection strings;
- filesystem paths from future database or ORM errors.

Internal error logs may include a short sanitized summary through `sanitizeErrorSummary`, with credential-like patterns redacted.

## Safe Error Helper

New helper:

- `server/utils/safe-errors.mjs`

Exports:

- `GENERIC_INTERNAL_ERROR`
- `sanitizeErrorSummary(error)`
- `redactSecrets(text)`
- `logServerError(error, options)`, which hands the error to `options.reporter` (or a log-only reporter for `options.logger`)
- `sendInternalServerError(res, send, error, options)`

`server/routes/scm-legacy.routes.mjs` now uses this helper in the global catch block.

Route-level validation errors remain unchanged where they are intentional business or workflow feedback. Future rounds can review individual route messages separately if they become database or provider-backed.

## Request IDs and Logs

Every response carries an `X-Request-Id` header. A forwarded `X-Request-Id` is kept when it is 8–128 characters of letters, digits, `.`, `_`, `:` or `-`. Otherwise the server generates a UUID.

`startScmServer`, the production and local entry point, writes one JSON line per API request once the response ends:

```json
{"time":"2026-09-28T10:15:02.114Z","level":"info","event":"http_request","requestId":"3f0c2c8e-...","method":"GET","path":"/api/home/overview","status":200,"durationMs":41.7,"tenantId":"tenant-a","userId":"user-1"}
```

- `path` never includes the query string. Headers, cookies, tokens and bodies are never logged.
- `tenantId` and `userId` appear only for signed-in requests, and only as ids. Names and emails are never logged.
- `/api/health` and `/api/ready` probes are not logged. Static assets and the SPA shell are logged only when they fail with 5xx.
- Requests with status 5xx are logged at `level: "error"`. A request the client abandoned carries `"aborted": true`.
- Set `FLOWCHAIN_REQUEST_LOG=off` to disable the access log. In-process servers from `createScmServer()`, used by tests and browser runners, do not write it unless a `requestLogger` is passed.

Unhandled errors are always logged as one JSON line, by the error reporter in `server/observability/error-reporter.mjs`:

```json
{"time":"...","level":"error","event":"server_error","requestId":"3f0c2c8e-...","method":"GET","path":"/api/home/overview","status":500,"phase":"boundary","error":"P1001: connect failed [redacted]","errorName":"PrismaClientInitializationError","errorCode":"P1001","stack":"at ...
at ...","tenantId":"tenant-a","userId":"user-1","commitSha":"..."}
```

This includes errors thrown after the response has started streaming. The caller cannot be told about those, and they used to go unrecorded. The `error` summary passes through `sanitizeErrorSummary`, which redacts bearer tokens, `sk-` keys, database URLs, and any `NAME=value` or `NAME: value` whose name ends in `API_KEY`, `SECRET`, `TOKEN` or `PASSWORD`. Since the error tracking round the patterns live in `server/observability/redact.mjs` and also cover `Authorization:` and basic credentials, camelCase and header-style key names, JSON secret fields, Redis and MongoDB connection strings, credentials in any URL, and Slack and Discord webhook URLs ([operations-alerts.md](operations-alerts.md) has the list).

Fields added in the error tracking round:

- `method`, `path` (no query string) and `status` (what the caller was sent) when the error belongs to a request.
- `phase`: `boundary` (thrown out of the request handler), `route` (a route caught it and answered 500 after calling `ctx.reportError`), `after_headers` (thrown after the response started), `response` (a 500 that no code reported, logged as `UnreportedServerError` without a stack).
- `errorName` and `errorCode`: the error's class name and code, limited to identifier characters.
- `stack`: the stack frames only (the message is already in `error`), with the same redaction. Production keeps the first 8 frames; other environments keep all of them.
- `tenantId` and `userId` for signed-in requests, as ids only, as in the access log.
- `commitSha` of the running build.

Uncaught exceptions and unhandled promise rejections are logged the same way with `"event":"process_error"` and `"fatal":true`; the process then exits with code 1, as it did before.

When `FLOWCHAIN_ERROR_WEBHOOK_URL` is an https URL, each logged error also sends a short, rate-limited alert without the message, stack or ids. See [operations-alerts.md](operations-alerts.md).

To trace a report, take the `requestId` from the 500 response or the response header and search the logs for it.

## Health Endpoint

Default `GET /api/health` remains available and now returns only safe runtime readiness fields:

- `ok`
- `persistenceMode`
- `timestamp`
- current demo/read-model counts:
  - `purchaseOrders`
  - `purchaseRequests`
  - `inventoryMovements`
  - `receivingDocs`

The default health endpoint no longer returns:

- OpenAI key presence;
- Doubao/ARK key presence;
- selected AI provider;
- selected model;
- proxy availability flags;
- database URL or database credential state.

## Persistence Mode Note

Health computes the safe persistence mode through `getPersistenceMode(process.env)`.

Repository registry creation remains after health handling, so the explicit database-mode placeholder does not make `/api/health` itself fail before a real database adapter exists.

Business routes still create `createRepositoryRegistry({ db, env: process.env })` during normal dispatch.

## Diagnostics

No diagnostics endpoint is added in this round.

If future diagnostics are needed, they should be:

- disabled by default;
- enabled only by explicit dev/test configuration;
- sanitized;
- free of key presence, model names, proxy values, and database credential details unless there is a strong reviewed reason.

## Tests

R23 tests verify:

- global 500 responses use the generic error payload;
- raw error text, keys, and database URLs are not returned;
- sanitized log summaries redact secret-like strings;
- default health source no longer includes provider/key/model/proxy fields;
- the global catch calls the safe error helper.

## Non-Goals

This round does not:

- change business route validation semantics broadly;
- remove dev logging entirely;
- add auth or RBAC around health;
- add diagnostics endpoints;
- add a database;
- add an ORM;
- enable external AI providers;
- mutate `data/scm-demo.json`.
