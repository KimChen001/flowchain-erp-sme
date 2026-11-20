import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n/I18n";
import { apiJson } from "../../../lib/api-client";
import { formatCalendarDay } from "../../../lib/format";
import { supplierReplyStockDatesParam, supplierReplyStockResponseSchema } from "../../../../shared/supplier-reply-stock-contract.mjs";
import { supplierReplyText, type SupplierReplyCopyKey } from "./supplierReplyCopy";

// The "Stock:" line on a proposed reply card (docs/supplier-reply-dates-design.md
// §4.6): for each item the dates being recorded leave short, or below its
// reorder point, before they come. Read from the reply's stock route
// (shared/supplier-reply-stock-contract.mjs) with the dates the card would
// record, again when they change. Nothing shows when nothing changes, when the
// reader may not read inventory, or when the read fails: the card stands
// without it.

type Effect = { sku: string; itemName: string | null; kind: "short" | "below_reorder_point"; from: string; newDate: string; basis: "open_sales_orders" | "recorded_rate" | null };
type Answer = { available: boolean; effects: Effect[] };
// At most this many items are named; the rest are counted.
const SHOWN = 3;

export function SupplierReplyStockLine({ reply, lines }: {
  // The reply's path, /api/procurement/orders/:id/supplier-replies/:replyId.
  reply: string;
  lines: Array<{ purchaseOrderLineId: string; promisedDate: string }>;
}) {
  const { language, locale } = useI18n();
  const t = (key: SupplierReplyCopyKey, values?: Record<string, string | number>) => supplierReplyText(language, key, values);
  const day = (value: string) => formatCalendarDay(value, locale);
  const dates = supplierReplyStockDatesParam(lines);
  const [answer, setAnswer] = useState<Answer | null>(null);

  // Read after a short pause, so a date being typed is read once.
  useEffect(() => {
    if (!dates) { setAnswer(null); return; }
    let current = true;
    const timer = setTimeout(() => {
      apiJson<unknown>(`${reply}/stock?dates=${encodeURIComponent(dates)}`)
        .then((value) => {
          if (!current) return;
          const parsed = supplierReplyStockResponseSchema.safeParse(value);
          setAnswer(parsed.success ? (parsed.data as Answer) : null);
        })
        .catch(() => { if (current) setAnswer(null); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [reply, dates]);

  if (!answer?.available || !answer.effects.length) return null;
  const shown = answer.effects.slice(0, SHOWN);
  const more = answer.effects.length - shown.length;
  return (
    <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800" role="note" data-testid="supplier-reply-stock">
      <span className="font-medium">{t("stockLabel")}</span>
      {shown.map((effect) => (
        <span key={effect.sku} className="block" data-testid="supplier-reply-stock-effect" data-kind={effect.kind} title={t(`stockBasis_${effect.basis ?? "none"}` as SupplierReplyCopyKey)}>
          {t(`stock_${effect.kind}` as SupplierReplyCopyKey, { sku: effect.itemName ? `${effect.sku} · ${effect.itemName}` : effect.sku, from: day(effect.from), date: day(effect.newDate) })}
        </span>
      ))}
      {more > 0 ? <span className="block" data-testid="supplier-reply-stock-more">{more === 1 ? t("stockMoreOne") : t("stockMore", { n: more })}</span> : null}
    </div>
  );
}
