// What a page shows when a request fails: a message in the interface language
// for the error codes and HTTP statuses every page meets, and the page's own
// generic message otherwise. The server's message is never shown as is, since
// it is written in English for developers; its code is returned so the page
// can keep it in a tooltip for support. No imports, so tests run it under Node.

export type ApiErrorView = { message: string; code: string };

type Pair = readonly [english: string, chinese: string];

const SIGNED_OUT: Pair = ["Your session has expired. Sign in again to continue.", "登录已失效，请重新登录后继续。"];
const NO_ACCESS: Pair = ["Your role cannot view or change this.", "你的角色无权查看或修改此内容。"];
const NOT_FOUND: Pair = ["This record was not found. It may have been removed.", "未找到该记录，可能已被删除。"];
const CHANGED: Pair = ["This record was changed by someone else. Refresh and try again.", "该记录已被他人修改，请刷新后重试。"];
const NOT_ON: Pair = ["This feature is not turned on for this workspace.", "当前工作区未开启此功能。"];
const OFFLINE: Pair = ["Could not connect. Check your connection and try again.", "无法连接，请检查网络后重试。"];
const UNAVAILABLE: Pair = ["The service is temporarily unavailable. Try again shortly.", "服务暂时不可用，请稍后重试。"];

const CODES: Record<string, Pair> = {
  AUTHENTICATION_REQUIRED: SIGNED_OUT,
  INVALID_SESSION: SIGNED_OUT,
  SESSION_EXPIRED: SIGNED_OUT,
  TENANT_CONTEXT_REQUIRED: SIGNED_OUT,
  PERMISSION_DENIED: NO_ACCESS,
  AUTHORIZATION_PERMISSION_DENIED: NO_ACCESS,
  FORBIDDEN: NO_ACCESS,
  TRANSACTION_CONFLICT: CHANGED,
  VERSION_CONFLICT: CHANGED,
  FLOWCHAIN_CAPABILITY_DISABLED: NOT_ON,
  FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED: NOT_ON,
  FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE: NOT_ON,
  OUTBOUND_CAPABILITY_NOT_AVAILABLE: NOT_ON,
  AUTHORITATIVE_INVENTORY_READ_NOT_AVAILABLE: NOT_ON,
};

const IN_USE: Pair = ["This code or number is already in use. Choose another.", "该编号已被使用，请换一个。"];

function known(code: string, status: number): Pair | undefined {
  if (CODES[code]) return CODES[code];
  if (/_NOT_FOUND$/.test(code)) return NOT_FOUND;
  if (/(^|_)DUPLICATE(_|$)/.test(code)) return IN_USE;
  if (/_(VERSION_)?CONFLICT$/.test(code)) return CHANGED;
  if (status === 401) return SIGNED_OUT;
  if (status === 403) return NO_ACCESS;
  if (status === 404) return NOT_FOUND;
  // A 409 with its own code (a rule the record breaks) is the page's to explain.
  if (status === 409 && !code) return CHANGED;
  if (status === 502 || status === 503 || status === 504) return UNAVAILABLE;
  return undefined;
}

/**
 * The message for a failed request in the interface language. `fallback` is
 * the page's own [English, Chinese] message for anything not listed above;
 * `own` holds the page's messages for its own error codes, checked first.
 */
export function apiErrorView(reason: unknown, language: string, fallback: Pair, own: Record<string, Pair> = {}): ApiErrorView {
  const english = language === "en-US";
  const error = (reason ?? {}) as { code?: unknown; status?: unknown; name?: unknown };
  const code = typeof error.code === "string" ? error.code : "";
  const status = typeof error.status === "number" ? error.status : 0;
  // fetch rejects with a TypeError when the server cannot be reached.
  const pair = own[code] || known(code, status) || (reason instanceof TypeError ? OFFLINE : fallback);
  return { message: english ? pair[0] : pair[1], code: code || (status ? `HTTP ${status}` : "") };
}

/** The same message as plain text, for a toast or a one-line notice. */
export function apiErrorText(reason: unknown, language: string, fallback: Pair, own: Record<string, Pair> = {}): string {
  return apiErrorView(reason, language, fallback, own).message;
}
