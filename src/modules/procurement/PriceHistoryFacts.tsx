import { useEffect, useMemo, useState } from "react";
import { A } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { PRICE_HISTORY_MAX_KEYS, priceHistoryKeyString, type PriceFact, type PriceHistory } from "../../../shared/price-history.mjs";
import { procurementApi } from "./procurementApi";
import { usePriceHistoryCopy } from "./priceHistoryCopy";

// What the workspace ordered the same item for on its own issued purchase
// orders, shown beside a price a person enters or reviews. Display only:
// nothing here writes to an input. Rules in shared/price-history.mjs.

export type PriceHistoryKeyInput = { itemId?: string | null; unit?: string | null; currency?: string | null };
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

// A PO price as "USD 4.20": the currency code, then the stored decimal with
// 2 to 4 decimals in the interface locale. Never converted.
export function usePoPrice() {
  const { locale } = useI18n();
  const copy = usePriceHistoryCopy();
  return (value: string | null | undefined, currency: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return copy("pricesHidden");
    const amount = Number(value);
    const number = Number.isFinite(amount) ? new Intl.NumberFormat(locale || "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount) : value;
    return `${currency || ""} ${number}`.trim();
  };
}

export function usePriceFactText() {
  const copy = usePriceHistoryCopy();
  const price = usePoPrice();
  const date = (fact: PriceFact) => {
    const day = fact.date || copy("dateNotRecorded");
    return fact.dateSource === "order_date" ? copy("orderedNoIssueDate", { date: day }) : day;
  };
  return {
    date,
    price,
    fact: (key: "lastPoPrice" | "earlierPo", fact: PriceFact) => copy(fact.unitPrice === null ? (key === "lastPoPrice" ? "lastPoPriceHidden" : "earlierPoHidden") : key, {
      price: price(fact.unitPrice, fact.currency),
      unit: fact.unit || "—",
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
}: {
  history: PriceHistory | null | undefined;
  state?: LoadState;
  compact?: boolean;
  testId?: string;
}) {
  const copy = usePriceHistoryCopy();
  const text = usePriceFactText();
  if (state === "hidden" || state === "idle") return null;
  const box = (children: React.ReactNode) => (
    <div className="mt-1 space-y-0.5 text-[11px] leading-4" style={{ color: A.sub }} data-testid={testId} data-price-history-status={history?.status || state}>
      {children}
    </div>
  );
  if (state === "loading") return box(<div>{copy("loading")}</div>);
  if (state === "error") return box(<div>{copy("error")}</div>);
  if (!history) return null;
  const notes = [
    ...(history.otherCurrencies.length ? [copy("otherCurrency", { list: history.otherCurrencies.join(", ") })] : []),
    ...(history.otherUnits.length ? [copy("otherUnit", { list: history.otherUnits.join(", ") })] : []),
    ...(history.unitNotRecordedCount ? [copy.count("unitNotRecordedLines", history.unitNotRecordedCount)] : []),
  ];
  return box(
    <>
      {history.status === "unit_not_recorded" ? (
        <div>{copy("unitNotRecorded")}</div>
      ) : history.latest ? (
        <>
          <div className="font-medium" style={{ color: A.label }} data-testid={testId ? `${testId}-latest` : undefined}>{text.fact("lastPoPrice", history.latest)}</div>
          {!compact && history.earlier.map((fact) => <div key={fact.lineId}>{text.fact("earlierPo", fact)}</div>)}
          {history.average?.unitPrice && <div>{copy("averageOf", { n: history.average.n, price: text.price(history.average.unitPrice, history.currency) })}</div>}
        </>
      ) : notes.length ? null : (
        <div>{copy("noIssuedPo")}</div>
      )}
      {notes.map((note) => <div key={note}>{note}</div>)}
    </>,
  );
}
