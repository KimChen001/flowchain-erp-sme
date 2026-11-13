// Display helpers for the sales order and shipment pages
// (OutboundWorkbench.tsx), kept free of React so they can be unit tested
// (server/domain/sales-order-facts.test.mjs). Copy is English with its Chinese
// translation; quantities, units and terms are shown, never changed: stored
// values, codes and currencies stay as recorded.
import { formatQuantity } from "../../lib/format.ts";
import { unitLabel } from "../../i18n/unitLabels.ts";

type Pair = [string, string];
const pick = (language: string, pair: Pair) => (language === "en-US" ? pair[0] : pair[1]);

// A stored four-decimal value as an exact count of ten-thousandths; null when
// it is not a plain decimal.
export function quantityUnits(value?: string | number | null): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const units = BigInt(match[2]) * 10000n + BigInt(`${match[3] || ""}0000`.slice(0, 4));
  return match[1] ? -units : units;
}

// Ten-thousandths back to a plain decimal for an input: no grouping, no
// trailing zeros ("50", "2.5").
export function unitsToPlain(units: bigint): string {
  const negative = units < 0n,
    absolute = negative ? -units : units;
  const fraction = String(absolute % 10000n).padStart(4, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / 10000n}${fraction ? `.${fraction}` : ""}`;
}

// A stored quantity as a person types it: "50.0000" → "50", "2.5000" → "2.5".
// A value that is not a plain decimal is returned as given.
export function plainQuantity(value?: string | number | null): string {
  const units = quantityUnits(value);
  return units === null ? String(value ?? "").trim() : unitsToPlain(units);
}

// The smaller of two quantities, as a plain decimal; a missing one is ignored.
export function smallerQuantity(a?: string | null, b?: string | null): string {
  const x = quantityUnits(a),
    y = quantityUnits(b);
  if (x === null) return y === null ? "" : unitsToPlain(y);
  if (y === null) return unitsToPlain(x);
  return unitsToPlain(x < y ? x : y);
}

// "30 pcs" in English, "30 件" in Chinese: the shared quantity format and the
// unit's label in the interface language (a unit not known is shown as stored).
export function quantityWithUnit(value: string | number | null | undefined, unit: string | null | undefined, language: string): string {
  const quantity = formatQuantity(value === null || value === undefined ? value : String(value));
  const label = unitLabel(unit, language, Number(value));
  return label ? `${quantity} ${label}` : quantity;
}

// Payment terms as a person reads them: a stored code such as "NET30" or
// "Net 30" is "Net 30 days"; anything else is shown as recorded.
export function paymentTermsLabel(terms: string | null | undefined, language: string): string {
  const raw = String(terms ?? "").trim();
  const net = /^net\s*-?\s*(\d{1,3})(?:\s*days?)?$/i.exec(raw) || /^n(\d{1,3})$/i.exec(raw);
  if (!net) return raw;
  const days = Number(net[1]);
  if (days === 0) return pick(language, ["Due on receipt", "收到发票即付款"]);
  return pick(language, [`Net ${days} days`, `${days} 天账期`]);
}

// How far the goods shipped on an order are invoiced. Invoices bill shipped
// goods, so the progress is against what was shipped; a customer invoice
// counts once it is submitted (the statuses that hold a shipment,
// SHIPMENT_HOLDING_CUSTOMER_INVOICE_STATUSES on the server).
export type InvoicingState = "nothing_shipped" | "not_invoiced" | "partly_invoiced" | "invoiced";
export const INVOICING_STATES: Record<InvoicingState, { label: Pair; tone: "neutral" | "warning" | "info" | "success" }> = {
  nothing_shipped: { label: ["Nothing shipped yet", "尚未发货"], tone: "neutral" },
  not_invoiced: { label: ["Not invoiced", "未开票"], tone: "warning" },
  partly_invoiced: { label: ["Partly invoiced", "部分开票"], tone: "info" },
  invoiced: { label: ["Invoiced", "已开票"], tone: "success" },
};
export function invoicingState(shipped?: string | null, invoiced?: string | null): InvoicingState {
  const shippedUnits = quantityUnits(shipped) ?? 0n,
    invoicedUnits = quantityUnits(invoiced) ?? 0n;
  if (shippedUnits <= 0n) return "nothing_shipped";
  if (invoicedUnits <= 0n) return "not_invoiced";
  return invoicedUnits < shippedUnits ? "partly_invoiced" : "invoiced";
}
// "Invoiced 40 of 60 pcs shipped"; without one shared unit, the counts alone.
export function invoicingProgressText(shipped: string | null | undefined, invoiced: string | null | undefined, unit: string | null | undefined, language: string): string {
  const of = unit ? quantityWithUnit(shipped, unit, language) : formatQuantity(shipped ?? "0");
  const done = formatQuantity(invoiced ?? "0");
  return pick(language, [`Invoiced ${done} of ${of} shipped`, `已开票 ${done}，已发货 ${of}`]);
}

// A customer the order form's picker searches (CustomerPicker.tsx).
export type PickerCustomer = {
  id: string;
  code: string;
  name: string;
  country?: string | null;
  address?: string | null;
};
// Every word typed is found somewhere in the customer's number, name, country
// or address, ignoring case.
export function customerMatches(customer: PickerCustomer, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [customer.code, customer.name, customer.country, customer.address].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

// What a line still needs reserved against the stock it can draw on: the
// shortfall when the open quantity is more than is available, else "".
export function lineShortfall(remainingToReserve?: string | null, available?: string | null): string {
  const need = quantityUnits(remainingToReserve),
    have = quantityUnits(available) ?? 0n;
  if (need === null || need <= 0n) return "";
  const short = need - (have > 0n ? have : 0n);
  return short > 0n ? unitsToPlain(short) : "";
}
