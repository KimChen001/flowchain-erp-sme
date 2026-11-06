// Redaction of credential-shaped text in error messages and stacks before
// they are logged. It knows shapes, not values: anything that looks like a
// token, key, password, connection string with credentials or webhook URL is
// replaced with [redacted]. Text in other shapes is kept, so this is a
// safety net, not a guarantee.
//
// Shared by server/utils/safe-errors.mjs and the error reporter; it imports
// nothing, so neither depends on the other for it.

const REDACTED = "[redacted]";

const SECRET_PATTERNS = [
  // Chat webhook URLs are credentials in themselves.
  /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[^\s,;"'<>]+/gi,
  /https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s,;"'<>]+/gi,
  // Authorization headers of any scheme, and bare bearer/basic credentials.
  /\bAuthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s,;]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // Case-sensitive and needing a digit or base64 symbol, so prose such as
  // "Basic authentication" is left alone.
  /\bBasic\s+(?=[A-Za-z0-9+/=._-]*[0-9+/=])[A-Za-z0-9+/=._-]{12,}/g,
  /sk-[A-Za-z0-9._-]+/gi,
  // Any NAME=value or NAME: value whose name ends like a credential, so new
  // provider keys (DASHSCOPE_API_KEY, FLOWCHAIN_AI_PROVIDER_API_KEY, ...) and
  // session secrets are covered without listing each one.
  /\b(?:[A-Z0-9]+_)*(?:API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)\s*[:=]\s*[^,\s;]+/gi,
  // JSON-style "password": "...", "clientSecret": "...", "apiKey": "..." pairs.
  /"[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
  // camelCase and header-style names: accessToken=..., apiKey=..., x-api-key: ...
  /\b[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^,\s;]+/gi,
  // Connection strings: the whole URL for databases and caches.
  /postgres(?:ql)?:\/\/[^,\s;]+/gi,
  /mysql:\/\/[^,\s;]+/gi,
  /rediss?:\/\/[^,\s;]+/gi,
  /mongodb(?:\+srv)?:\/\/[^,\s;]+/gi,
  // Any other URL with user:password@ keeps its host but loses the credentials.
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, (match, scheme) => (
      typeof scheme === "string" && match.startsWith(scheme) ? `${scheme}${REDACTED}@` : REDACTED
    )),
    String(text ?? ""),
  );
}

export function sanitizeErrorSummary(error) {
  const code = String(error?.code || error?.name || "Error");
  const message = String(error?.message || error || "");
  return `${code}: ${redactSecrets(message)}`.slice(0, 240);
}
