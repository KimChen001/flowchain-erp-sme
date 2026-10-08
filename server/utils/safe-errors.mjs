import { createErrorReporter, logOnlyEnv } from '../observability/error-reporter.mjs'

export const GENERIC_INTERNAL_ERROR = 'Internal server error'
export const SAFE_OPERATIONAL_ERROR_CODES = new Set([
  'FLOWCHAIN_DATABASE_CONFIG_MISSING',
  // A read repository was called without a workspace; answered as its 403.
  'TENANT_CONTEXT_REQUIRED',
])

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /sk-[A-Za-z0-9._-]+/gi,
  // Any NAME=value or NAME: value whose name ends like a credential, so new
  // provider keys (DASHSCOPE_API_KEY, FLOWCHAIN_AI_PROVIDER_API_KEY, ...) and
  // session secrets are covered without listing each one.
  /\b(?:[A-Z0-9]+_)*(?:API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)\s*[:=]\s*[^,\s;]+/gi,
  /postgres(?:ql)?:\/\/[^,\s;]+/gi,
  /mysql:\/\/[^,\s;]+/gi,
]

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[redacted]'),
    String(text ?? '')
  )
}

export function sanitizeErrorSummary(error) {
  const code = String(error?.code || error?.name || 'Error')
  const message = String(error?.message || error || '')
  return `${code}: ${redactSecrets(message)}`.slice(0, 240)
}

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
