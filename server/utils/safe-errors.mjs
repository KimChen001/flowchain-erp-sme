import { createErrorReporter, logOnlyEnv } from '../observability/error-reporter.mjs'

export const GENERIC_INTERNAL_ERROR = 'Internal server error'
export const SAFE_OPERATIONAL_ERROR_CODES = new Set([
  'FLOWCHAIN_DATABASE_CONFIG_MISSING',
  // A read repository was called without a workspace; answered as its 403.
  'TENANT_CONTEXT_REQUIRED',
  // readBody refused the body: over its byte cap (413) or not JSON (400).
  'REQUEST_BODY_TOO_LARGE',
  'REQUEST_BODY_INVALID_JSON',
])

// The redaction lives in its own module, so the error reporter can use it
// without importing this file.
export { redactSecrets, sanitizeErrorSummary } from '../observability/redact.mjs'

// One JSON line per unhandled error, carrying the request id so it can be
// matched to the access log line and to what the caller was shown. The line
// is written by the server's error reporter (server/observability/
// error-reporter.mjs), which adds the method, path, status, stack and actor
// ids and may send an alert. Without one, the line goes to options.logger
// and no alert is sent.
export function logServerError(error, options = {}) {
  const reporter = options.reporter
    || createErrorReporter({ logger: options.logger || console, env: logOnlyEnv() })
  reporter.report(error, {
    req: options.req,
    requestId: options.requestId,
    status: options.status,
    phase: options.phase,
  })
}

export function sendInternalServerError(res, send, error, options = {}) {
  const safe = SAFE_OPERATIONAL_ERROR_CODES.has(error?.code)
  logServerError(error, { ...options, status: safe ? error.status || 500 : 500 })
  const reference = options.requestId ? { requestId: options.requestId } : {}
  if (safe) {
    return send(res, error.status || 500, {
      error: error.message,
      code: error.code,
      ...reference,
    })
  }
  return send(res, 500, { error: GENERIC_INTERNAL_ERROR, ...reference })
}
