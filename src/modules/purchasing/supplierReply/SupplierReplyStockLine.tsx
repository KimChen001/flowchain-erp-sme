import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n/I18n";
import { apiJson } from "../../../lib/api-client";
import { formatCalendarDay } from "../../../lib/format";
import { isSupplierReplyStockDay, supplierReplyStockDatesParam, supplierReplyStockResponseSchema } from "../../../../shared/supplier-reply-stock-contract.mjs";
import { supplierReplyText, type SupplierReplyCopyKey } from "./supplierReplyCopy";

// The "Stock:" line on a proposed reply card (docs/supplier-reply-dates-design.md
// §4.6): for each item the dates being recorded leave out of stock, or below
// its reorder point, before they come, where the order's dates now would not.
// Read from the reply's stock route (shared/supplier-reply-stock-contract.mjs)
// with the dates the card would record, again when they change: after a short
// pause, the read before cancelled, and not while a date is unfinished or
// before today (a year typed digit by digit passes 0002, 0020, 0202). The line
// shown is greyed while a new read runs. Nothing shows when nothing changes,
// when the reader may not read inventory, or when the read fails: the card
// stands without it.

type Effect = { sku: string; itemName: string | null; kind: "short" | "below_reorder_point"; from: string; newDate: string; basis: "open_sales_orders" | "recorded_rate" | null; beyondAYear: boolean };
type Answer = { available: boolean; effects: Effect[] };
// What the read came to, for the card and its tests: reading, waiting for
// whole dates, shown, nothing to show, or failed.
type ReadState = "reading" | "waiting" | "shown" | "none" | "failed";
// At most this many items are named; the rest are counted.
const SHOWN = 3;

export function SupplierReplyStockLine({ reply, lines }: {
  // The reply's path, /api/procurement/orders/:id/supplier-replies/:replyId.
  reply: string;
  lines: Array<{ purchaseOrderLineId: string; promisedDate: string }>;
}) {
  const { language, locale, workspaceToday } = useI18n();
  const t = (key: SupplierReplyCopyKey, values?: Record<string, string | number>) => supplierReplyText(language, key, values);
  const day = (value: string) => formatCalendarDay(value, locale);
  const dates = supplierReplyStockDatesParam(lines);
  // Whole days, none before today: only these are read.
  const ready = lines.length > 0 && lines.every((line) => isSupplierReplyStockDay(line.promisedDate) && (!workspaceToday || line.promisedDate >= workspaceToday));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [state, setState] = useState<ReadState>("waiting");

  useEffect(() => {
    if (!dates || !ready) { setState("waiting"); return; }
    const controller = new AbortController();
    setState("reading");
    const timer = setTimeout(() => {
      apiJson<unknown>(`${reply}/stock?dates=${encodeURIComponent(dates)}`, { signal: controller.signal })
        .then((value) => {
          const parsed = supplierReplyStockResponseSchema.safeParse(value);
          const next = parsed.success ? (parsed.data as Answer) : null;
          setAnswer(next);
          setState(!parsed.success ? "failed" : next?.available && next.effects.length ? "shown" : "none");
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setAnswer(null);
          setState("failed");
        });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [reply, dates, ready]);

  const effects = answer?.available ? answer.effects : [];
  // Settled or waiting with nothing to show: a marker only.
  if (!effects.length) return <span hidden data-testid="supplier-reply-stock-read" data-state={state} />;
  const shown = effects.slice(0, SHOWN);
  const more = effects.length - shown.length;
  // Greyed while the dates changed and the line is being read again.
  const stale = state === "reading" || state === "waiting";
  return (
    <div className={`mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800 ${stale ? "opacity-50" : ""}`} role="note" aria-busy={stale} data-testid="supplier-reply-stock" data-state={state}>
      <span className="font-medium">{t("stockLabel")}</span>
      {shown.map((effect) => (
        <span key={effect.sku} className="block" data-testid="supplier-reply-stock-effect" data-kind={effect.kind} title={t(`stockBasis_${effect.basis ?? "none"}` as SupplierReplyCopyKey)}>
          {t(`stock_${effect.kind}` as SupplierReplyCopyKey, { sku: effect.itemName ? `${effect.sku} · ${effect.itemName}` : effect.sku, from: day(effect.from), date: day(effect.newDate) })}
          {effect.beyondAYear ? ` ${t("stockBeyondYear")}` : ""}
        </span>
      ))}
      {more > 0 ? <span className="block" data-testid="supplier-reply-stock-more">{more === 1 ? t("stockMoreOne") : t("stockMore", { n: more })}</span> : null}
    </div>
  );
}
