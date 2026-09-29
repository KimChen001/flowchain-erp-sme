export const GENERIC_INTERNAL_ERROR = 'Internal server error'
export const SAFE_OPERATIONAL_ERROR_CODES = new Set([
  'FLOWCHAIN_DATABASE_CONFIG_MISSING',
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

export function sanitizeErrorSummary(error) {
  const code = String(error?.code || error?.name || 'Error')
  const message = String(error?.message || error || '')
  const sanitized = SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, '[redacted]'),
    message
  )
  return `${code}: ${sanitized}`.slice(0, 240)
}

export function sendInternalServerError(res, send, error, options = {}) {
  const logger = options.logger || console
  if (typeof logger.warn === 'function') {
    logger.warn(`[server-error] ${sanitizeErrorSummary(error)}`)
  }
  if (SAFE_OPERATIONAL_ERROR_CODES.has(error?.code)) {
    return send(res, error.status || 500, {
      error: error.message,
      code: error.code,
    })
  }
  return send(res, 500, { error: GENERIC_INTERNAL_ERROR })
}
