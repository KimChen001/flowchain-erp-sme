// Plain sentences that say what a reserve, release, delivery draft, post or
// reverse preview will do, built from the server's preview. English is the
// source; zh-CN is chosen by the interface language. SKUs, units, warehouse
// names, locations and shipment numbers are shown as stored; quantities use the
// shared quantity format. Display only: nothing here is sent to the server.
import { formatQuantity } from "../../lib/format.ts";

type Row = Record<string, unknown>;

export type OutboundPreviewFacts = {
  operation: string;
  allowed?: boolean;
  normalizedPlan?: Row | null;
  balanceImpacts?: Row[];
  reservationImpacts?: Row[];
};

export type OutboundPreviewLookup = {
  // A warehouse and location as the page shows them, e.g. "Main Warehouse / A-01".
  place: (warehouseId: string, location: string) => string;
  reservation?: (id: string) => { warehouseId: string; location: string; sku?: string; unit?: string } | undefined;
  line?: (id: string) => { sku: string; unit?: string } | undefined;
  unit?: (sku: string) => string | undefined;
};

const COPY = {
  "en-US": {
    reserve: "Reserves {amount} at {place}. Available stock there goes down by {q}.",
    release: "Releases {amount} reserved at {place}. Available stock there goes up by {q}.",
    draft: "Creates delivery {number} for {amount} from {place}. Stock does not change until the shipment is posted.",
    cancelDraft: "Cancels this delivery draft. {amount} at {place} stays reserved for the order.",
    post: "Ships {amount} from {place}. On hand and reserved both go down by {q}.",
    reverse: "Returns {amount} to {place}. On hand and reserved both go up by {q}.",
    amount: "{q} {unit} of {sku}",
    amountNoUnit: "{q} of {sku}",
    unknownPlace: "the reserved location",
  },
  "zh-CN": {
    reserve: "在 {place} 预留 {amount}。该库位可用量减少 {q}。",
    release: "释放 {place} 的预留 {amount}。该库位可用量增加 {q}。",
    draft: "创建发货单 {number}：从 {place} 发出 {amount}。发货过账前库存不变。",
    cancelDraft: "取消该发货草稿。{place} 的 {amount} 仍为该订单预留。",
    post: "从 {place} 发出 {amount}。在库量和预留量各减少 {q}。",
    reverse: "将 {amount} 退回 {place}。在库量和预留量各增加 {q}。",
    amount: "{sku} {q} {unit}",
    amountNoUnit: "{sku} {q}",
    unknownPlace: "原预留库位",
  },
} as const;

type CopyKey = keyof (typeof COPY)["en-US"];

function text(language: string, key: CopyKey, params: Record<string, string> = {}) {
  const table = language === "zh-CN" ? COPY["zh-CN"] : COPY["en-US"];
  return table[key].replace(/\{(\w+)\}/g, (match, name) => (name in params ? params[name] : match));
}

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

// The difference of two decimal strings ("10.0000" - "0.0000"), exact, as a
// decimal string. A value that is not a plain decimal gives "".
export function decimalDifference(minuend: unknown, subtrahend: unknown) {
  const parse = (value: unknown) => /^(-?)(\d+)(?:\.(\d+))?$/.exec(str(value));
  const a = parse(minuend), b = parse(subtrahend);
  if (!a || !b) return "";
  const scale = Math.max((a[3] || "").length, (b[3] || "").length);
  const units = (m: RegExpExecArray) => BigInt(`${m[1]}${m[2]}${(m[3] || "").padEnd(scale, "0")}`);
  const diff = units(a) - units(b);
  const sign = diff < 0n ? "-" : "";
  const digits = (diff < 0n ? -diff : diff).toString().padStart(scale + 1, "0");
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`;
}

function amount(language: string, quantity: string, sku: string, unit?: string) {
  const q = formatQuantity(quantity);
  return text(language, unit ? "amount" : "amountNoUnit", { q, sku: sku || "—", unit: unit || "" });
}

/**
 * One or two sentences per affected stock location, in the interface
 * language. A blocked preview has none: the page shows why it is blocked.
 */
export function outboundPreviewSentences(language: string, preview: OutboundPreviewFacts, lookup: OutboundPreviewLookup): string[] {
  if (!preview || preview.allowed === false) return [];
  const plan = (preview.normalizedPlan || {}) as Row;
  const unitFor = (sku: string, fallback?: string) => fallback || lookup.unit?.(sku) || "";
  const reservationPlace = (id: string) => {
    const reservation = lookup.reservation?.(id);
    return reservation ? lookup.place(reservation.warehouseId, reservation.location) : text(language, "unknownPlace");
  };
  const sentences: string[] = [];
  switch (preview.operation) {
    case "reserve":
      for (const entry of rows(plan.allocations)) {
        const sku = str(entry.sku), q = str(entry.quantity);
        sentences.push(text(language, "reserve", {
          amount: amount(language, q, sku, unitFor(sku, str(entry.unit))),
          place: lookup.place(str(entry.warehouseId), str(entry.location)),
          q: formatQuantity(q),
        }));
      }
      break;
    case "release":
      for (const entry of rows(plan.releases)) {
        const id = str(entry.reservationId), reservation = lookup.reservation?.(id), sku = str(reservation?.sku), q = str(entry.quantity);
        sentences.push(text(language, "release", {
          amount: amount(language, q, sku, unitFor(sku, reservation?.unit)),
          place: reservationPlace(id),
          q: formatQuantity(q),
        }));
      }
      break;
    case "create_shipment_draft":
      for (const line of rows(plan.lines)) {
        const orderLine = lookup.line?.(str(line.salesOrderLineId));
        for (const allocation of rows(line.allocations)) {
          const id = str(allocation.reservationId), sku = str(orderLine?.sku || lookup.reservation?.(id)?.sku);
          sentences.push(text(language, "draft", {
            number: str(plan.shipmentNumber) || "—",
            amount: amount(language, str(allocation.quantity), sku, unitFor(sku, orderLine?.unit)),
            place: reservationPlace(id),
          }));
        }
      }
      break;
    case "cancel_shipment_draft":
      for (const impact of rows(preview.reservationImpacts)) {
        const id = str(impact.reservationId), reservation = lookup.reservation?.(id), sku = str(reservation?.sku);
        sentences.push(text(language, "cancelDraft", {
          amount: amount(language, str(impact.quantity), sku, unitFor(sku, reservation?.unit)),
          place: reservationPlace(id),
        }));
      }
      break;
    case "post_shipment":
    case "reverse_shipment":
      for (const impact of rows(preview.balanceImpacts)) {
        const sku = str(impact.sku);
        const q = preview.operation === "post_shipment"
          ? decimalDifference(impact.onHandBefore, impact.onHandAfter)
          : decimalDifference(impact.onHandAfter, impact.onHandBefore);
        sentences.push(text(language, preview.operation === "post_shipment" ? "post" : "reverse", {
          amount: amount(language, q, sku, unitFor(sku)),
          place: lookup.place(str(impact.warehouseId), str(impact.location)),
          q: formatQuantity(q),
        }));
      }
      break;
  }
  return sentences;
}
