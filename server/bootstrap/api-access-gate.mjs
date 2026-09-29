// Every /api route needs a signed-in identity bound to a tenant, except the
// few a person must reach before they have a session. Health, readiness,
// local status and login are answered earlier in the request handler.
const PUBLIC_API_ROUTES = new Set([
  "POST /api/workspace/invitations/accept",
]);

export function apiAccessDenial({ method, pathname, identity }) {
  if (!pathname.startsWith("/api/")) return null;
  if (PUBLIC_API_ROUTES.has(`${method} ${pathname}`)) return null;
  if (!identity?.authenticated)
    return {
      status: 401,
      body: {
        code: identity?.source === "invalid_session" ? "INVALID_SESSION" : "AUTHENTICATION_REQUIRED",
        message: "Sign in to use this workspace.",
      },
    };
  if (!String(identity.tenantId || "").trim())
    return {
      status: 403,
      body: {
        code: "TENANT_CONTEXT_REQUIRED",
        message: "This session is not bound to a workspace.",
      },
    };
  return null;
}
