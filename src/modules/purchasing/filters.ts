import type { PurchaseOrder } from "../../types/scm";
import { poLinesOf } from "../../domain/purchasing/helpers";

export type PurchaseOrderWorkbenchFilters = {
  poNumber: string;
  supplier: string;
  skuOrItem: string;
  // "全部" (all), "open" (the report definition: committed with quantity
  // still to receive), or a status code ("issued"); legacy Chinese values
  // ("已发出") still match their code.
  status: string;
  source: string;
  owner: string;
  etaFrom: string;
  etaTo: string;
};

export const defaultPurchaseOrderWorkbenchFilters: PurchaseOrderWorkbenchFilters = {
  poNumber: "",
  supplier: "",
  skuOrItem: "",
  status: "全部",
  source: "全部",
  owner: "",
  etaFrom: "",
  etaTo: "",
};

function normalizedText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function containsText(value: unknown, query: string) {
  const needle = normalizedText(query);
  if (!needle) return true;
  return normalizedText(value).includes(needle);
}

function parseWorkbenchDate(value: unknown, referenceYear = new Date().getFullYear()) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const zh = raw.match(/(\d{1,2})月(\d{1,2})日/);
  if (zh) {
    const date = new Date(referenceYear, Number(zh[1]) - 1, Number(zh[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function dateInRange(value: unknown, from: string, to: string) {
  const fromDate = parseWorkbenchDate(from);
  const toDate = parseWorkbenchDate(to);
  if (!fromDate && !toDate) return true;
  const valueDate = parseWorkbenchDate(value, fromDate?.getFullYear() || toDate?.getFullYear() || new Date().getFullYear());
  if (!valueDate) return true;
  if (fromDate && valueDate < fromDate) return false;
  if (toDate && valueDate > toDate) return false;
  return true;
}

// The stored status code of a legacy Chinese status, so a filter on "issued"
// finds orders stored either way.
const LEGACY_STATUS_CODES: Record<string, string> = {
  草稿: "draft", 待审批: "pending_approval", 已审批: "approved", 已批准: "approved", 已发出: "issued", 已下达: "issued",
  部分到货: "partially_received", 部分收货: "partially_received", 已完成: "fully_received", completed: "fully_received",
  已驳回: "rejected", 已取消: "cancelled", canceled: "cancelled", 已关闭: "closed",
};
export function purchaseOrderStatusCode(status: unknown) {
  const value = String(status ?? "").trim();
  return LEGACY_STATUS_CODES[value] || value;
}

// The statuses the list's Status filter offers, as codes; "open" first.
export const purchaseOrderStatusFilterOptions = ["全部", "open", "draft", "pending_approval", "approved", "issued", "partially_received", "fully_received", "closed", "rejected", "cancelled"] as const;

function sourceOf(order: PurchaseOrder) {
  return order.source || "manual";
}

function orderMatchesSkuOrItem(order: PurchaseOrder, query: string) {
  const needle = normalizedText(query);
  if (!needle) return true;
  const lineValues = poLinesOf(order).flatMap((line) => [
    line.sku,
    line.itemName,
    line.poLineId,
  ]);
  return [
    order.sourceSku,
    order.sourceName,
    ...lineValues,
  ].some((value) => containsText(value, needle));
}

export function purchaseOrderMatchesWorkbenchFilters(
  order: PurchaseOrder,
  filters: PurchaseOrderWorkbenchFilters,
  // The open orders by the report definition, from the server's summary.
  openOrderIds?: ReadonlySet<string>,
) {
  // The PO filter finds an order by its document number or its id.
  if (![order.number, order.orderNumber, order.po].some((value) => containsText(value, filters.poNumber))) return false;
  if (!containsText(order.supplier, filters.supplier)) return false;
  if (!orderMatchesSkuOrItem(order, filters.skuOrItem)) return false;
  if (filters.status === "open") {
    if (openOrderIds && !openOrderIds.has(order.po)) return false;
  } else if (filters.status && filters.status !== "全部" && purchaseOrderStatusCode(order.status) !== purchaseOrderStatusCode(filters.status)) return false;
  if (filters.source !== "全部" && sourceOf(order) !== filters.source) return false;
  if (!containsText(order.owner, filters.owner)) return false;
  if (!dateInRange(order.eta, filters.etaFrom, filters.etaTo)) return false;
  return true;
}

export function filterPurchaseOrdersForWorkbench(
  orders: PurchaseOrder[],
  filters: PurchaseOrderWorkbenchFilters,
  openOrderIds?: ReadonlySet<string>,
) {
  return orders.filter((order) => purchaseOrderMatchesWorkbenchFilters(order, filters, openOrderIds));
}
