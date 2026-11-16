import { useEffect, useState, type ReactNode } from "react";
import { Database, X } from "lucide-react";
import { useI18n } from "../i18n/I18n";

// The note of a local workspace seeded from public data
// (docs/public-data-workspaces.md), as /api/dev/local-status returns it
// (server/domain/public-data-note.mjs). Dates are calendar days (YYYY-MM-DD).
export type PublicDataNote = {
  dataset: "m5" | "uci";
  sourceWindow: { first: string; last: string };
  window: { first: string; last: string };
  shiftDays: number;
  counts: Partial<Record<"items" | "suppliers" | "customers" | "salesOrders" | "salesOrderLines" | "purchaseOrders" | "openPurchaseOrders" | "customerInvoices" | "supplierInvoices" | "cancellations", number>>;
  assumptions: Partial<Record<"leadTimeDays" | "reviewDays" | "holdingRatePercent" | "shortageToHolding" | "paymentTermsDays" | "purchasePricePercent", number>> & {
    // UCI: the rules the supplier invoices and their payments follow.
    supplierInvoices?: Partial<Record<SupplierInvoiceRule, number>>;
  };
  citation: string | null;
  licence: string | null;
  url: string | null;
  sceneSuppliers: string[];
};

type SupplierInvoiceRule = "delayDays" | "priceAbovePercent" | "priceAboveFrom" | "priceAboveTo" | "shortDeliveryPercent" | "shortByPercent" | "beforeReceiptPercent" | "beforeReceiptFrom" | "beforeReceiptTo" | "unpaidPercent" | "unpaidWithinDays";

// The seed's supplier invoice rules (PUBLIC_DATA_SUPPLIER_INVOICE_RULES in
// scripts/public-data/plan.mjs), for any rule a note leaves out. A workspace
// seeded before 2026-11-12 has no supplier invoices and shows no rules.
const SUPPLIER_INVOICE_RULES: Record<SupplierInvoiceRule, number> = {
  delayDays: 5, priceAbovePercent: 5, priceAboveFrom: 2, priceAboveTo: 5, shortDeliveryPercent: 3, shortByPercent: 5,
  beforeReceiptPercent: 2, beforeReceiptFrom: 1, beforeReceiptTo: 3, unpaidPercent: 10, unpaidWithinDays: 60,
};

// The days of demand the seed averages for safety stock, reorder points and
// minimum orders (THRESHOLD_WINDOW_DAYS in scripts/public-data/plan.mjs); the
// note does not carry it.
const THRESHOLD_WINDOW_DAYS = 90;
const SATURDAY = 6;

// One group of the details: a short heading over a list.
function NoteGroup({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId}>
      <p className="font-semibold text-slate-800">{title}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-5">{children}</ul>
    </div>
  );
}

const hiddenKey = (note: PublicDataNote) => `flowchain.publicDataNote.hidden.${note.dataset}.${note.window.last}`;

function readHidden(note: PublicDataNote) {
  try {
    return window.localStorage.getItem(hiddenKey(note)) === "1";
  } catch {
    return false;
  }
}

function writeHidden(note: PublicDataNote, hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(hiddenKey(note), "1");
    else window.localStorage.removeItem(hiddenKey(note));
  } catch {
    // The note simply shows again next time.
  }
}

// What the workspace's data is and what is assumed, above every page until
// the reader hides it; the header's "Public data" label brings it back.
export function PublicDataNoteBanner({ note, reopen }: { note: PublicDataNote; reopen: number }) {
  const { t, formatNumber, language } = useI18n();
  const [hidden, setHidden] = useState(() => readHidden(note));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!reopen) return;
    writeHidden(note, false);
    setHidden(false);
    setOpen(true);
  }, [note, reopen]);
  if (hidden) return null;
  const leadTimeDays = note.assumptions.leadTimeDays ?? 14;
  const reviewDays = note.assumptions.reviewDays ?? 7;
  // A workspace seeded before purchase prices were a share of the selling
  // price says nothing of a percent: its purchase prices are the selling prices.
  const purchasePricePercent = note.assumptions.purchasePricePercent ?? 100;
  const supplierInvoices = note.assumptions.supplierInvoices ? { ...SUPPLIER_INVOICE_RULES, ...note.assumptions.supplierInvoices } : null;
  const paymentTermsDays = note.assumptions.paymentTermsDays ?? 30;
  const last = note.window.last;
  // Sentences side by side: a space in English, none after a Chinese full stop.
  const join = (...parts: string[]) => parts.filter(Boolean).join(language === "en-US" ? " " : "");
  // The seed's stock rules (itemThresholds and simulatePurchasing in
  // scripts/public-data/plan.mjs): safety stock = review days, reorder point
  // = lead time + review days of average demand; history orders at reorder
  // point + safety stock.
  const cover = leadTimeDays + reviewDays;
  const stockRules = {
    leadTimeDays, reviewDays, cover, last, base: cover + reviewDays, window: THRESHOLD_WINDOW_DAYS,
    times: reviewDays > 0 ? formatNumber(Math.round((cover / reviewDays) * 10) / 10) : "—",
  };
  // Dates move by whole days, so weekdays move by shiftDays mod 7.
  const weekdayShift = ((note.shiftDays % 7) + 7) % 7;
  const weekdays = weekdayShift === 0
    ? t("publicData.weekdaysKept")
    : t("publicData.weekdays", { weekday: t("publicData.weekdayNames").split("|")[(SATURDAY + weekdayShift) % 7] ?? "" });
  const purchasePrice = purchasePricePercent === 100
    ? t("publicData.purchasePriceSame")
    : t(note.dataset === "m5" ? "publicData.m5PurchasePrice" : "publicData.uciPurchasePrice", { percent: purchasePricePercent });
  const summary = note.dataset === "m5"
    ? t("publicData.m5Summary", { sourceFirst: note.sourceWindow.first, sourceLast: note.sourceWindow.last, shiftDays: formatNumber(note.shiftDays), last: note.window.last, items: formatNumber(note.counts.items ?? 0) })
    : t("publicData.uciSummary", { sourceFirst: note.sourceWindow.first, sourceLast: note.sourceWindow.last, shiftDays: formatNumber(note.shiftDays), last: note.window.last, items: formatNumber(note.counts.items ?? 0), customers: formatNumber(note.counts.customers ?? 0) });
  return (
    <section
      aria-label={t("publicData.title")}
      data-testid="public-data-note"
      className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-slate-700 sm:px-4"
    >
      {/* One line until opened, on every screen (owner 11/13: pages carried
          too much above their own content); the header's "Public data" label
          and "What is assumed" open the rest. */}
      <div className={`flex gap-2.5 ${open ? "items-start" : "items-center"}`}>
        <Database aria-hidden="true" size={16} className="shrink-0 text-sky-700" />
        <div className="min-w-0 flex-1">
          <p className={open ? undefined : "truncate"} title={open ? undefined : `${t("publicData.title")} · ${summary}`} data-testid="public-data-note-summary">
            <span className="font-semibold text-slate-900">{t("publicData.title")}</span>
            <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
            {summary}
          </p>
          {open && (
            <div className="mt-2 space-y-2 text-slate-600" data-testid="public-data-note-details">
              {/* Grouped so a reader finds what is assumed without reading
                  it all (design audit B7: L14, L7-15, L7-23, L3-15, L3-16). */}
              <NoteGroup title={t("publicData.groupData")} testId="public-data-note-data">
                <li>{t(note.dataset === "m5" ? "publicData.m5Items" : "publicData.uciItems")}</li>
                <li data-testid="public-data-note-weekdays">{weekdays}</li>
                <li>{t("publicData.dates")}</li>
              </NoteGroup>
              <NoteGroup title={t("publicData.groupStock")} testId="public-data-note-stock">
                <li>{t(note.dataset === "m5" ? "publicData.m5Suppliers" : "publicData.uciSuppliers")}</li>
                <li>{join(t("publicData.deliveries", stockRules), note.dataset === "uci" ? t("publicData.deliveriesExceptions") : "")}</li>
                <li>{join(t("publicData.thresholds", stockRules), t("publicData.belowSuggestion"))}</li>
                <li>{t("publicData.lookAhead", stockRules)}</li>
                <li>{t("publicData.history", stockRules)}</li>
                <li>{join(t("publicData.reviewDay"), t("publicData.appRule"))}</li>
              </NoteGroup>
              <NoteGroup title={t("publicData.groupMoney")} testId="public-data-note-money">
                <li>{purchasePrice}</li>
                {note.dataset === "m5" && <li data-testid="public-data-note-m5-no-invoices">{t("publicData.m5NoInvoices")}</li>}
                {note.dataset === "uci" && <li data-testid="public-data-note-no-tax">{t("publicData.noTax")}</li>}
                {note.dataset === "uci" && <li>{t("publicData.uciAssumed", { paymentTermsDays, last })}</li>}
                {note.dataset === "uci" && supplierInvoices && (
                  <>
                    <li data-testid="public-data-note-supplier-invoices">{t("publicData.uciSupplierInvoices", { ...supplierInvoices, paymentTermsDays })}</li>
                    <li>{t("publicData.uciSupplierPayments", { ...supplierInvoices, last })}</li>
                  </>
                )}
              </NoteGroup>
              {note.sceneSuppliers?.length > 0 && <p>{t("publicData.scene", { suppliers: note.sceneSuppliers.join(", ") })}</p>}
              {note.citation && (
                <p className="break-words">
                  {t("publicData.source", { citation: note.citation })}
                  {note.licence ? ` ${t("publicData.licence", { licence: note.licence })}` : ""}
                  {note.url && (
                    <>
                      {" "}
                      <a href={note.url} target="_blank" rel="noreferrer" className="text-sky-800 underline underline-offset-2">{note.url}</a>
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 whitespace-nowrap text-xs font-semibold text-sky-800 underline-offset-2 hover:underline max-sm:min-h-9"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("publicData.less") : t("publicData.more")}
        </button>
        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-sky-100 hover:text-slate-800 max-sm:flex max-sm:h-9 max-sm:w-9 max-sm:items-center max-sm:justify-center"
          aria-label={t("publicData.dismiss")}
          title={t("publicData.dismiss")}
          onClick={() => {
            writeHidden(note, true);
            setHidden(true);
          }}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </section>
  );
}
