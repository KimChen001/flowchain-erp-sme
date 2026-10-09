import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";
import { usePhone } from "../../lib/usePhone";

/**
 * A list page's filter fields. On wider screens they render in place, in the
 * grid `className` gives them. On phones they sit behind one Filters button
 * (with the number of filters on) and open as a bottom sheet, as Fiori's
 * filter bar does. The fields are the page's own controlled inputs, so the
 * values stay the same in both places.
 */
export function ResponsiveFilters({
  children,
  className = "",
  activeCount = 0,
  onReset,
  leading,
}: {
  children: React.ReactNode;
  className?: string;
  activeCount?: number;
  onReset?: () => void;
  /** Shown next to the Filters button on phones, such as the search box. */
  leading?: React.ReactNode;
}) {
  const { t } = useI18n();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!phone) setOpen(false); }, [phone]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const panel = (
    <div className={`fc-filters-panel ${className}`} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={open ? t("mobile.filters") : undefined}>
      <div className="fc-filters-sheet-head">
        <b className="text-base" style={{ color: A.label }}>{t("mobile.filters")}</b>
        <button type="button" onClick={() => setOpen(false)} aria-label={t("mobile.close")} className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: A.gray1 }}>
          <X size={18} />
        </button>
      </div>
      {/* On wider screens the search box is the first field of the grid. */}
      {phone ? null : leading}
      {children}
      <div className="fc-filters-sheet-foot">
        {onReset && (
          <button type="button" onClick={onReset} className="h-11 flex-1 rounded-xl border text-sm font-semibold" style={{ borderColor: A.border, color: A.label }}>
            {t("mobile.reset")}
          </button>
        )}
        <button type="button" data-testid="filters-sheet-done" onClick={() => setOpen(false)} className="h-11 flex-[2] rounded-xl text-sm font-semibold text-white" style={{ background: A.blue }}>
          {t("mobile.showResults")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fc-filters" data-open={open}>
      {phone && (
        <div className="flex items-center gap-2">
          {leading ? <div className="min-w-0 flex-1">{leading}</div> : null}
          <button type="button" data-testid="filters-sheet-open" onClick={() => setOpen(true)} className="fc-filters-toggle" aria-label={activeCount ? t("mobile.filtersOn", { count: activeCount }) : t("mobile.filters")}>
            <SlidersHorizontal size={15} />
            {t("mobile.filters")}
            {activeCount > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] text-white" style={{ background: A.blue }}>{activeCount}</span>}
          </button>
        </div>
      )}
      {phone
        ? open && createPortal(
            <div className="fc-filters-portal" data-testid="filters-sheet">
              <button type="button" aria-label={t("mobile.close")} className="fc-filters-backdrop" onClick={() => setOpen(false)} />
              {panel}
            </div>,
            document.body,
          )
        : panel}
    </div>
  );
}
