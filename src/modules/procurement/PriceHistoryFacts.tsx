import { useEffect, useMemo, useState } from "react";
import { A } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { formatCalendarDay, formatLocaleAmount } from "../../lib/format";
import { unitLabel } from "../../i18n/unitLabels";
import { PRICE_HISTORY_MAX_KEYS, compareQuote, priceHistoryKeyString, type PriceFact, type PriceHistory, type QuoteComparison } from "../../../shared/price-history.mjs";
import { procurementApi } from "./procurementApi";
import { usePriceHistoryCopy } from "./priceHistoryCopy";

// What the workspace ordered the same item for on its own issued purchase
// orders, shown beside a price a person enters or reviews. Display only:
// nothing here writes to an input. Rules in shared/price-history.mjs.

// A supplierId reads that supplier's POs only (a supplier's page); without
// one, every supplier's, each named.
export type PriceHistoryKeyInput = { itemId?: string | null; unit?: string | null; currency?: string | null; supplierId?: string | null };
type LoadState = "idle" | "loading" | "loaded" | "hidden" | "error";

// The key the server answers under, or "" when the line names no item or currency.
export function priceHistoryKey(input: PriceHistoryKeyInput) {
  return input.itemId && String(input.currency || "").trim() ? priceHistoryKeyString(input) : "";
}

// Reads the history of every key a page shows in one request (per 50 keys).
// A role that cannot read purchase orders gets no block at all.
export function usePriceHistory(keys: string[], { excludePurchaseOrderId }: { excludePurchaseOrderId?: string | null } = {}) {
  const wanted = useMemo(() => [...new Set(keys.filter(Boolean))].sort(), [keys]);
  const signature = `${excludePurchaseOrderId || ""}#${wanted.join("\n")}`;
  const [state, setState] = useState<LoadState>("idle");
  const [histories, setHistories] = useState<Map<string, PriceHistory>>(() => new Map());
  useEffect(() => {
    if (!wanted.length) {
      setState("idle");
      setHistories(new Map());
      return;
    }
    let current = true;
    setState("loading");
    const chunks: string[][] = [];
    for (let index = 0; index < wanted.length; index += PRICE_HISTORY_MAX_KEYS) chunks.push(wanted.slice(index, index + PRICE_HISTORY_MAX_KEYS));
    Promise.all(chunks.map((chunk) => procurementApi.priceHistory(chunk, excludePurchaseOrderId)))
      .then((responses) => {
        if (!current) return;
        setHistories(new Map(responses.flatMap((response) => response.histories.map((history) => [history.key, history] as const))));
        setState("loaded");
      })
      .catch((error) => {
        if (!current) return;
        setHistories(new Map());
        setState(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "hidden" : "error");
      });
    return () => { current = false; };
    // The signature holds every input of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return { state, histories };
}

// A unit price in the workspace money format ("$4.20", "$71.7778"): the
// currency's own decimals (2 for USD), and up to 4 only when the stored
// price has them. Never converted.
export function formatUnitPrice(amount: number, currency: string | null | undefined, locale?: string) {
  let digits = 2;
  try { digits = new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency || "").trim().toUpperCase() || "USD" }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* an unknown code keeps 2 */ }
  return formatLocaleAmount(amount, currency, locale, { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) });
}

export function usePoPrice() {
  const { locale } = useI18n();
  const copy = usePriceHistoryCopy();
  return (value: string | null | undefined, currency: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return copy("pricesHidden");
    const amount = Number(value);
    return Number.isFinite(amount) ? formatUnitPrice(amount, currency, locale) : `${currency || ""} ${value}`.trim();
  };
}

export function usePriceFactText() {
  const { locale, language } = useI18n();
  const copy = usePriceHistoryCopy();
  const price = usePoPrice();
  const date = (fact: PriceFact) => {
    const day = fact.date ? formatCalendarDay(fact.date, locale) : copy("dateNotRecorded");
    if (fact.dateSource === "order_date_not_issued") return copy("orderedNotIssued", { date: day });
    return fact.dateSource === "order_date" ? copy("orderedNoIssueDate", { date: day }) : day;
  };
  return {
    date,
    price,
    fact: (key: "lastPoPrice" | "earlierPo", fact: PriceFact) => copy(fact.unitPrice === null ? (key === "lastPoPrice" ? "lastPoPriceHidden" : "earlierPoHidden") : key, {
      price: price(fact.unitPrice, fact.currency),
      // A price per one unit: "$4.20 / box", "/ 箱".
      unit: fact.unit ? unitLabel(fact.unit, language, 1) : "—",
      po: fact.orderNumber,
      date: date(fact),
      supplier: fact.supplierName || copy("supplierNotRecorded"),
    }),
  };
}

export function PriceHistoryFacts({
  history,
  state = "loaded",
  compact = false,
  testId,
  excludesThisOrder = false,
  supplierId,
}: {
  history: PriceHistory | null | undefined;
  state?: LoadState;
  compact?: boolean;
  testId?: string;
  // On a purchase order: the history leaves this order out, so an empty one
  // means no earlier orders, not that the item was never ordered.
  excludesThisOrder?: boolean;
  // The supplier of the document beside it. The compact line names the last
  // PO's supplier only when it was someone else.
  supplierId?: string | null;
}) {
  const copy = usePriceHistoryCopy();
  const text = usePriceFactText();
  if (state === "hidden" || state === "idle") return null;
  // A named group, so the heading is announced; the compact form keeps the
  // note on what these prices are as a tooltip.
  const box = (children: React.ReactNode) => (
    <div role="group" aria-label={copy("title")} title={compact ? copy("poPriceNote") : undefined} className="mt-1 space-y-0.5 text-[11px] leading-4" style={{ color: A.sub }} data-testid={testId} data-price-history-status={history?.status || state}>
      {children}
    </div>
  );
  if (state === "loading") return box(<div>{copy("loading")}</div>);
  if (state === "error") return box(<div>{copy("error")}</div>);
  if (!history) return null;
  const notes = [
    ...(history.otherCurrencies.length ? [copy("otherCurrency", { list: history.otherCurrencies.join(", ") })] : []),
    ...(history.otherUnits.length ? [copy("otherUnit", { list: history.otherUnits.map((unit) => unitLabel(unit, copy.language, 1)).join(", ") })] : []),
    ...(history.unitNotRecordedCount ? [copy.count("unitNotRecordedLines", history.unitNotRecordedCount)] : []),
  ];
  // One line beside a row: the last price, its PO and date; the supplier only
  // when it is not the row's own; the average only when it differs.
  if (compact && history.status !== "unit_not_recorded" && history.latest && history.latest.unitPrice !== null) {
    const latest = history.latest;
    const otherSupplier = !history.supplierId && (!supplierId || latest.supplierId !== supplierId);
    const averagePrice = history.average?.unitPrice;
    const averageDiffers = Boolean(averagePrice) && history.average!.n > 1 && Number(averagePrice) !== Number(latest.unitPrice);
    const line = copy(otherSupplier ? "lastPoShortFrom" : "lastPoShort", {
      price: text.price(latest.unitPrice, latest.currency),
      unit: latest.unit ? unitLabel(latest.unit, copy.language, 1) : "—",
      po: latest.orderNumber,
      date: text.date(latest),
      supplier: latest.supplierName || copy("supplierNotRecorded"),
    });
    return box(
      <>
        <div data-testid={testId ? `${testId}-latest` : undefined}>
          <span className="font-medium" style={{ color: A.label }}>{line}</span>
          {averageDiffers && <span>{` · ${copy("averageShort", { n: history.average!.n, price: text.price(averagePrice, history.currency) })}`}</span>}
        </div>
        {notes.map((note) => <div key={note}>{note}</div>)}
      </>,
    );
  }
  return box(
    <>
      {history.status === "unit_not_recorded" ? (
        <div>{copy("unitNotRecorded")}</div>
      ) : history.latest ? (
        <>
          <div className="font-medium" style={{ color: A.label }} data-testid={testId ? `${testId}-latest` : undefined}>{text.fact("lastPoPrice", history.latest)}</div>
          {!compact && history.earlier.map((fact) => <div key={fact.lineId}>{text.fact("earlierPo", fact)}</div>)}
          {history.average?.unitPrice && <div>{copy("averageOf", { n: history.average.n, price: text.price(history.average.unitPrice, history.currency) })}</div>}
          {!compact && <div className="italic" data-testid={testId ? `${testId}-note` : undefined}>{copy("poPriceNote")}</div>}
        </>
      ) : notes.length ? null : (
        <div>{copy(history.supplierId ? "noIssuedPoFromSupplier" : excludesThisOrder ? "noEarlierPoForItem" : "noIssuedPo")}</div>
      )}
      {notes.map((note) => <div key={note}>{note}</div>)}
    </>,
  );
}

// A quoted price set against the same item's last PO price and the average of
// up to 3 in the same currency and unit, as plain text: "vs last PO $4.20
// (PO-0031, Sep 14, 2026): +7.1%; average of 3: $4.31". No colour, ranking
// or action.
export function useQuoteComparisonText() {
  const copy = usePriceHistoryCopy();
  const text = usePriceFactText();
  return (comparison: QuoteComparison) => {
    switch (comparison.status) {
      case "compared": {
        const last = copy("vsLastPo", { price: text.price(comparison.lastPo.unitPrice, comparison.lastPo.currency), po: comparison.lastPo.orderNumber, date: text.date(comparison.lastPo), pct: `${comparison.percent}%` });
        return comparison.average?.unitPrice ? copy("withAverage", { last, average: copy("averageShort", { n: comparison.average.n, price: text.price(comparison.average.unitPrice, comparison.lastPo.currency) }) }) : last;
      }
      case "zero_base":
        return copy("zeroBase");
      case "hidden":
        return copy("quoteHidden");
      case "no_quote_price":
        return copy("noQuotePrice");
      case "not_comparable":
        // Says what the earlier POs were in, not only a code beside the quote.
        return comparison.reason === "unit_not_recorded"
          ? copy("notComparable", { what: copy("unitNotRecordedShort") })
          : copy("notComparableEarlierIn", { list: (comparison.values || []).join(", ") });
      default:
        return copy("noEarlierPo");
    }
  };
}

export function QuoteVsHistory({ unitPrice, history, state, testId }: { unitPrice: string | null | undefined; history: PriceHistory | null | undefined; state: LoadState; testId?: string }) {
  const describe = useQuoteComparisonText();
  if (state !== "loaded") return null;
  const comparison = compareQuote({ unitPrice, history });
  return <div className="text-[11px] leading-4" style={{ color: A.sub }} data-testid={testId} data-quote-comparison={comparison.status}>{describe(comparison)}</div>;
}
