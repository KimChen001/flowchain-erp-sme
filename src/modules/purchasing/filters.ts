import type { POStatus, PurchaseOrder } from "../../types/scm";
import { poLinesOf } from "../../domain/purchasing/helpers";

export type PurchaseOrderWorkbenchFilters = {
  poNumber: string;
  supplier: string;
  skuOrItem: string;
  status: "全部" | POStatus;
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
) {
  // The PO filter finds an order by its document number or its id.
  if (![order.number, order.orderNumber, order.po].some((value) => containsText(value, filters.poNumber))) return false;
  if (!containsText(order.supplier, filters.supplier)) return false;
  if (!orderMatchesSkuOrItem(order, filters.skuOrItem)) return false;
  if (filters.status !== "全部" && order.status !== filters.status) return false;
  if (filters.source !== "全部" && sourceOf(order) !== filters.source) return false;
  if (!containsText(order.owner, filters.owner)) return false;
  if (!dateInRange(order.eta, filters.etaFrom, filters.etaTo)) return false;
  return true;
}

export function filterPurchaseOrdersForWorkbench(
  orders: PurchaseOrder[],
  filters: PurchaseOrderWorkbenchFilters,
) {
  return orders.filter((order) => purchaseOrderMatchesWorkbenchFilters(order, filters));
}
