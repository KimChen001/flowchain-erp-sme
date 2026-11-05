import { ApiError } from "../../lib/api-client";

// Errors from the purchasing endpoints in the interface language. The server's
// own message is English and may name internal fields, so it is never shown;
// a known code gets its sentence, anything else a sentence by HTTP status or
// the caller's fallback. The code stays available for a title, for support.
export type ErrorPair = readonly [english: string, chinese: string];

const BY_CODE: Record<string, ErrorPair> = {
  AUTHENTICATION_REQUIRED: ["Your session has expired. Sign in again.", "登录已过期，请重新登录。"],
  PERMISSION_DENIED: ["Your role does not allow this action.", "您的角色无权执行此操作。"],
  AUTHORIZATION_DENIED: ["Your role does not allow this action.", "您的角色无权执行此操作。"],
  TENANT_CONTEXT_REQUIRED: ["No workspace is selected for this session. Sign in again.", "当前会话未选择工作区，请重新登录。"],
  CAPABILITY_NOT_AVAILABLE: ["This action is turned off for this workspace. Ask an administrator to turn it on.", "当前工作区未开启此功能，请联系管理员开启。"],
  SYNC_VERSION_CONFLICT: ["This record was changed elsewhere. Reload it and try again.", "该记录已在别处被更改，请重新加载后重试。"],
  PURCHASE_ORDER_WORKFLOW_CONFLICT: ["This purchase order was changed elsewhere. Reload it and try again.", "该采购订单已在别处被更改，请重新加载后重试。"],
  TRANSACTION_CONFLICT: ["Someone else saved a change at the same moment. Try again.", "他人同时保存了更改，请重试。"],
  PURCHASE_ORDER_NOT_FOUND: ["This purchase order is not available in this workspace.", "此工作区中找不到该采购订单。"],
  PURCHASE_ORDER_LINE_NOT_FOUND: ["This purchase order line no longer exists. Reload the order.", "该采购订单行已不存在，请重新加载订单。"],
  PURCHASE_ORDER_NOT_ISSUED: ["The purchase order has not been issued yet.", "该采购订单尚未下达。"],
  PURCHASE_ORDER_PROMISE_CLOSED: ["Promised dates can no longer be changed on this order.", "该订单已不能修改承诺交期。"],
  PURCHASE_ORDER_LINE_ALREADY_RECEIVED: ["This line has been received in full, so its promised date cannot change.", "该行已全部收货，不能修改承诺交期。"],
  PURCHASE_ORDER_HAS_OPEN_RECEIPTS: ["This purchase order has receipts that are not posted yet. Post or cancel them first.", "该采购订单还有未过账的收货单，请先过账或取消。"],
  PURCHASE_ORDER_VERSION_INVALID: ["This purchase order was changed elsewhere. Reload it and try again.", "该采购订单已在别处被更改，请重新加载后重试。"],
  FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE: ["Purchasing records cannot be read right now. Try again shortly.", "暂时无法读取采购记录，请稍后重试。"],
};

const BY_STATUS: Array<[test: (status: number) => boolean, pair: ErrorPair]> = [
  [(status) => status === 401, BY_CODE.AUTHENTICATION_REQUIRED],
  [(status) => status === 403, BY_CODE.PERMISSION_DENIED],
  [(status) => status === 404, ["The record was not found, or you cannot see it.", "未找到该记录，或您无权查看。"]],
  [(status) => status === 409, BY_CODE.SYNC_VERSION_CONFLICT],
  [(status) => status === 400 || status === 422, ["Some details are not valid. Check them and try again.", "部分信息无效，请检查后重试。"]],
  [(status) => status >= 500, ["The service is unavailable right now. Try again shortly.", "服务暂时不可用，请稍后重试。"]],
];

const NETWORK: ErrorPair = ["The service could not be reached. Check your connection and try again.", "无法连接服务，请检查网络后重试。"];

/** The sentence to show for an error, in the interface language. */
export function procurementErrorText(error: unknown, language: string, fallback: ErrorPair, codes: Record<string, ErrorPair> = {}) {
  const index = language === "en-US" ? 0 : 1;
  if (error instanceof ApiError) {
    const code = error.code || "";
    const pair = codes[code] || BY_CODE[code] || BY_STATUS.find(([test]) => test(error.status))?.[1] || fallback;
    return pair[index];
  }
  if (error instanceof TypeError) return NETWORK[index];
  return fallback[index];
}

/** The error's code and HTTP status for a title attribute, or undefined. */
export function procurementErrorCode(error: unknown) {
  if (!(error instanceof ApiError)) return undefined;
  return [error.code, error.status ? `HTTP ${error.status}` : ""].filter(Boolean).join(" · ") || undefined;
}
