import { useEffect, useState } from "react";
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
  counts: Partial<Record<"items" | "suppliers" | "customers" | "salesOrders" | "salesOrderLines" | "purchaseOrders" | "openPurchaseOrders" | "customerInvoices" | "cancellations", number>>;
  assumptions: Partial<Record<"leadTimeDays" | "reviewDays" | "holdingRatePercent" | "shortageToHolding" | "paymentTermsDays", number>>;
  citation: string | null;
  licence: string | null;
  url: string | null;
  sceneSuppliers: string[];
};

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
  const { t, formatNumber } = useI18n();
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
  const summary = note.dataset === "m5"
    ? t("publicData.m5Summary", { sourceFirst: note.sourceWindow.first, sourceLast: note.sourceWindow.last, shiftDays: formatNumber(note.shiftDays), last: note.window.last, items: formatNumber(note.counts.items ?? 0) })
    : t("publicData.uciSummary", { sourceFirst: note.sourceWindow.first, sourceLast: note.sourceWindow.last, shiftDays: formatNumber(note.shiftDays), last: note.window.last, items: formatNumber(note.counts.items ?? 0), customers: formatNumber(note.counts.customers ?? 0) });
  return (
    <section
      aria-label={t("publicData.title")}
      data-testid="public-data-note"
      className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-slate-700 sm:px-4"
    >
      <div className="flex items-start gap-2.5">
        <Database aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-sky-700" />
        <div className="min-w-0 flex-1">
          {/* On a phone the summary keeps to two lines until opened, so the
              page's own content starts on the first screen. */}
          <p className={open ? undefined : "line-clamp-2 sm:line-clamp-none"} data-testid="public-data-note-summary">
            <span className="font-semibold text-slate-900">{t("publicData.title")}</span>
            <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
            {summary}
          </p>
          {open && (
            <div className="mt-2 space-y-1.5 text-slate-600" data-testid="public-data-note-details">
              <p>{t("publicData.assumed", { leadTimeDays, reviewDays, cover: leadTimeDays + reviewDays })}</p>
              {note.dataset === "uci" && <p>{t("publicData.uciAssumed", { paymentTermsDays: note.assumptions.paymentTermsDays ?? 30 })}</p>}
              {note.sceneSuppliers?.length > 0 && <p>{t("publicData.scene", { suppliers: note.sceneSuppliers.join(", ") })}</p>}
              <p>{t("publicData.dates")}</p>
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
          <button
            type="button"
            className="mt-1 text-xs font-semibold text-sky-800 underline-offset-2 hover:underline max-sm:min-h-9"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t("publicData.less") : t("publicData.more")}
          </button>
        </div>
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
