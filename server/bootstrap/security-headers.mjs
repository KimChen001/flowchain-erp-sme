// Browser security headers sent on every response: the SPA shell, static
// assets, API JSON, preflight answers and error responses.
//
// They are set with res.setHeader before the request is handled, so a header
// a route passes to res.writeHead for the same name still wins. That keeps
// Referrer-Policy: no-referrer on /sign-in/confirm (static-assets.mjs).

const text = (value) => String(value ?? "").trim();

// The same production rule as validateProductionRuntimeConfig: the release
// image sets FLOWCHAIN_DEPLOYMENT_PROFILE=production even if NODE_ENV is changed.
const isProduction = (env) => text(env.NODE_ENV).toLowerCase() === "production"
  || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === "production";

// What the built SPA needs and nothing more:
// - scripts only from the app's own origin (the build has no inline scripts);
// - inline styles, because index.html, the chart component and the toast and
//   dialog libraries inject <style> elements and style attributes;
// - Google Fonts for the Inter stylesheet (src/styles/fonts.css) and its files;
// - data: images (the image fallback, the report chart PNG export) and blob:
//   images;
// - API calls to the same origin only.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
].join("; ");

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()";

// One year. Subdomains and the preload list are left out on purpose: the
// apex domain and its other hosts are not all served over HTTPS yet.
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

export const CSP_MODES = Object.freeze(["enforce", "report-only", "off"]);

// FLOWCHAIN_CSP_MODE: enforce (default), report-only or off. Any other value
// enforces, so a typo never switches the policy off.
export function cspMode(env = process.env) {
  const mode = text(env.FLOWCHAIN_CSP_MODE).toLowerCase();
  return CSP_MODES.includes(mode) ? mode : "enforce";
}

function hasHttpsPublicOrigin(env) {
  try {
    return new URL(text(env.FLOWCHAIN_PUBLIC_BASE_URL)).protocol === "https:";
  } catch {
    return false;
  }
}

// HSTS only where the public address is HTTPS in production. Locally and over
// plain HTTP it would pin a browser to HTTPS for a year on that host.
export function strictTransportSecurityEnabled(env = process.env) {
  return isProduction(env) && hasHttpsPublicOrigin(env);
}

export function securityHeaders(env = process.env) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  const mode = cspMode(env);
  if (mode === "enforce") headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY;
  else if (mode === "report-only") headers["Content-Security-Policy-Report-Only"] = CONTENT_SECURITY_POLICY;
  if (strictTransportSecurityEnabled(env)) headers["Strict-Transport-Security"] = STRICT_TRANSPORT_SECURITY;
  return headers;
}

// The headers are worked out once, when the server is created, from the
// environment it starts with.
export function withSecurityHeaders(handleRequest, { env = process.env } = {}) {
  const headers = Object.entries(securityHeaders(env));
  return function handleRequestWithSecurityHeaders(req, res) {
    for (const [name, value] of headers) res.setHeader(name, value);
    return handleRequest(req, res);
  };
}
