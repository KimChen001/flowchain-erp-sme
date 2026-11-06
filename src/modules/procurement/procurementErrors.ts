import { apiErrorView } from "../../lib/apiErrorText";

// Errors from the purchasing endpoints in the interface language. The shared
// rules in src/lib/apiErrorText.ts cover sign-in, access, not found, conflicts
// and the network; this file adds the purchasing codes that have a sentence of
// their own, and keeps two status rules the purchasing pages relied on before
// the helpers were merged: a rejected input (400/422) and a server failure
// (500 and up) get a general sentence rather than the page's fallback.
export type ErrorPair = readonly [english: string, chinese: string];

const PURCHASING_CODES: Record<string, ErrorPair> = {
  CAPABILITY_NOT_AVAILABLE: ["This action is turned off for this workspace. Ask an administrator to turn it on.", "当前工作区未开启此功能，请联系管理员开启。"],
  SYNC_VERSION_CONFLICT: ["This record was changed elsewhere. Reload it and try again.", "该记录已在别处被更改，请重新加载后重试。"],
  PURCHASE_ORDER_WORKFLOW_CONFLICT: ["This purchase order was changed elsewhere. Reload it and try again.", "该采购订单已在别处被更改，请重新加载后重试。"],
  PURCHASE_ORDER_VERSION_INVALID: ["This purchase order was changed elsewhere. Reload it and try again.", "该采购订单已在别处被更改，请重新加载后重试。"],
  PURCHASE_ORDER_NOT_FOUND: ["This purchase order is not available in this workspace.", "此工作区中找不到该采购订单。"],
  PURCHASE_ORDER_LINE_NOT_FOUND: ["This purchase order line no longer exists. Reload the order.", "该采购订单行已不存在，请重新加载订单。"],
  PURCHASE_ORDER_NOT_ISSUED: ["The purchase order has not been issued yet.", "该采购订单尚未下达。"],
  PURCHASE_ORDER_PROMISE_CLOSED: ["Promised dates can no longer be changed on this order.", "该订单已不能修改承诺交期。"],
  PURCHASE_ORDER_LINE_ALREADY_RECEIVED: ["This line has been received in full, so its promised date cannot change.", "该行已全部收货，不能修改承诺交期。"],
  PURCHASE_ORDER_HAS_OPEN_RECEIPTS: ["This purchase order has receipts that are not posted yet. Post or cancel them first.", "该采购订单还有未过账的收货单，请先过账或取消。"],
  // The shared rules call this "not turned on"; the purchasing pages have
  // always said "try again" here, so they keep it.
  FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE: ["Purchasing records cannot be read right now. Try again shortly.", "暂时无法读取采购记录，请稍后重试。"],
};

const INVALID: ErrorPair = ["Some details are not valid. Check them and try again.", "部分信息无效，请检查后重试。"];
const SERVER_FAILED: ErrorPair = ["The service is unavailable right now. Try again shortly.", "服务暂时不可用，请稍后重试。"];

/** The sentence to show for an error, in the interface language. */
export function procurementErrorText(error: unknown, language: string, fallback: ErrorPair, codes: Record<string, ErrorPair> = {}) {
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : 0;
  const byStatus = status === 400 || status === 422 ? INVALID : status >= 500 ? SERVER_FAILED : fallback;
  return apiErrorView(error, language, byStatus, { ...PURCHASING_CODES, ...codes }).message;
}

/** The error's code and HTTP status for a title attribute, or undefined. */
export function procurementErrorCode(error: unknown) {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return [typeof code === "string" ? code : "", typeof status === "number" && status ? `HTTP ${status}` : ""].filter(Boolean).join(" · ") || undefined;
}
