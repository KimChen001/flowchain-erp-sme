import { AUTH_TOKEN_KEY, apiJson } from "./api-client";

// The signed-in person's authorization context, fetched once for the parts
// of a page that ask for it at the same time (a page asked up to six times).
// A request made more than a few seconds later fetches it again, so a role
// change shows without a reload; a failed request is not reused.
type AuthorizationContextPayload = { tenantId?: string; userId?: string; effectivePermissions?: string[]; [key: string]: unknown };
const REUSE_MS = 5000;
let shared: { token: string; at: number; promise: Promise<AuthorizationContextPayload> } | null = null;

export function readAuthorizationContext(): Promise<AuthorizationContextPayload> {
  const token = typeof localStorage === "undefined" ? "" : localStorage.getItem(AUTH_TOKEN_KEY) || "";
  if (shared && shared.token === token && Date.now() - shared.at < REUSE_MS) return shared.promise;
  const promise = apiJson<AuthorizationContextPayload>("/api/authorization/context");
  shared = { token, at: Date.now(), promise };
  promise.catch(() => { if (shared?.promise === promise) shared = null; });
  return promise;
}
