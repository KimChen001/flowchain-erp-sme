import { useEffect, useState, type ReactNode } from "react";
import { A, Card } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { listRowClass } from "../../components/ui/listLayout";
import { listTableCardsRef, tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNumericRightClass, thClass } from "../../components/ui/workbenchTable";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";
import { formatCalendarDay } from "../../lib/format";
import { SUPPLIER_RELIABILITY_ROUTE, supplierReliabilityResponseSchema } from "../../../shared/supplier-reliability-contract.mjs";
import { supplierCopy } from "./supplierCopy";
import {
  manualReplies, notRecordedReplies, openReplies, recordedReplies, reliabilityRows,
  type ReliabilityReplies, type ReliabilityRevisions, type SupplierReliability,
} from "./supplierReliability";

// Promised dates and supplier replies over 90 days, per supplier, below the
// indicator table on Supplier evaluation (docs/supplier-reply-dates-design.md
// §4.12). It is kept apart from on time and OTIF, which stay on each order's
// original promise. Each figure under the minimum sample shows "—" with its
// counts in the tooltip, as the page does for on time. A part the reader may
// not read is left out, never shown as zeros.

type Listed = { id: string; supplierCode: string; supplierName: string };

// The headers, each with what it counts.
const REVISION_HEADERS = [
  ["Orders due", "Orders sent to the supplier with a line due in these 90 days, by the line's first promised date."],
  ["Date changes per order", "Changes to those orders' promised dates, from the order page or a supplier reply, per order. A first promise is not a change."],
  ["Average days moved", "How far a change moved the promised date on average: later is positive, earlier negative. Below it, the share of changes that moved the date later."],
] as const;
const REPLY_HEADERS = [
  ["Replies received", "Supplier replies pasted into FlowChain with a received day in these 90 days. A reply replaced by a later paste is not counted."],
  ["Replies with a date", "Share of the replies read for dates that gave at least one delivery date that passed the checks."],
  ["Reply outcomes", "What became of each reply. The tooltip on each cell lists every outcome."],
] as const;

export function SupplierReliabilityCard({ suppliers, loadKey = 0 }: { suppliers: Listed[]; loadKey?: number }) {
  const { language, locale } = useI18n();
  const t = (value: string, values: Record<string, string | number> = {}) =>
    Object.entries(values).reduce((text, [key, filled]) => text.split(`{${key}}`).join(String(filled)), supplierCopy(value, language));
  const [data, setData] = useState<SupplierReliability | null>(null);
  const [failed, setFailed] = useState(false);

  // Read once per page load and on Refresh, as the indicators are. An answer
  // that does not match the contract is not shown half-read.
  useEffect(() => {
    let current = true;
    apiJson<unknown>(SUPPLIER_RELIABILITY_ROUTE)
      .then((value) => {
        if (!current) return;
        const parsed = supplierReliabilityResponseSchema.safeParse(value);
        setData(parsed.success ? (parsed.data as SupplierReliability) : null);
        setFailed(!parsed.success);
      })
      .catch(() => { if (current) { setData(null); setFailed(true); } });
    return () => { current = false; };
  }, [loadKey]);

  // Nothing to show to a reader who may read neither part.
  if (data && !data.visibility.revisions && !data.visibility.replies) return null;

  const minimum = data?.minimumSample ?? 5;
  const number = (value: number, options: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(locale, options).format(value);
  const oneDecimal = (value: number, options: Intl.NumberFormatOptions = {}) => number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1, ...options });
  const percent = (share: number) => number(share, { style: "percent", maximumFractionDigits: 0 });
  const dash = (title: string, small = false) => <span title={title} style={{ color: A.sub }} data-testid={small ? "supplier-reliability-small" : undefined}>—</span>;
  const hidden = dash(t("Hidden for your role"));

  const revisionCells = (part: ReliabilityRevisions | null): ReactNode[] => {
    if (!part) return [hidden, hidden, hidden];
    const changes = t("Orders due: {orders}. Orders with a date change: {revised}. Date changes: {revisions}.", { revisions: part.revisions, orders: part.orders, revised: part.revisedOrders });
    const later = t("{count} of {of} changes moved the date later.", { count: part.movedLater.count, of: part.movedLater.of });
    const perOrder = !part.orders ? dash(t("No orders due in these 90 days."))
      : part.perOrder === null ? dash(`${changes} ${t("A figure needs {n} orders.", { n: minimum })}`, true)
        : <span className="tabular-nums" title={changes}>{oneDecimal(part.perOrder)}</span>;
    const moved = !part.revisions ? dash(part.orders ? t("No date changes in these 90 days.") : t("No orders due in these 90 days."))
      : part.averageDaysMoved === null ? dash(`${changes} ${later} ${t("A figure needs {n} date changes.", { n: minimum })}`, true)
        : (
          <span className="tabular-nums" title={later} data-testid="supplier-reliability-moved">
            {t("{n} days", { n: oneDecimal(part.averageDaysMoved, { signDisplay: "exceptZero" }) })}
            {part.movedLater.share !== null ? <span className="block text-[11px]" style={{ color: A.sub }}>{t("{share} later", { share: percent(part.movedLater.share) })}</span> : null}
          </span>
        );
    return [<span className="tabular-nums">{part.orders}</span>, perOrder, moved];
  };

  const replyCells = (part: ReliabilityReplies | null): ReactNode[] => {
    if (!part) return [hidden, hidden, hidden];
    const none = t("No replies in these 90 days.");
    const received = <span className="tabular-nums" title={t("{read} of them were read for dates.", { read: part.read })}>{part.received}</span>;
    const counts = t("{count} of {of} replies read gave a date that passed the checks.", { count: part.withStatedDate.count, of: part.withStatedDate.of });
    const stated = !part.received ? dash(none)
      : !part.withStatedDate.of ? dash(t("No reply was read for dates."))
        : part.withStatedDate.share === null ? dash(`${counts} ${t("A percentage needs {n} replies read.", { n: minimum })}`, true)
          : <span className="tabular-nums" title={counts}>{percent(part.withStatedDate.share)}</span>;
    const outcomes = part.outcomes;
    const lines = [
      t("Recorded as read: {n}", { n: outcomes.recordedUnchanged }),
      t("Recorded after an edit: {n}", { n: outcomes.recordedEdited }),
      t("Recorded by hand: {n}", { n: outcomes.recordedManual }),
      t("Not recorded, wrong reading: {n}", { n: outcomes.notRecorded.wrong_reading }),
      t("Not recorded, supplier will confirm: {n}", { n: outcomes.notRecorded.supplier_will_confirm }),
      t("Not recorded, other reason: {n}", { n: outcomes.notRecorded.other }),
      t("Needs you: {n}", { n: outcomes.needsYou }),
      t("Proposed, not decided: {n}", { n: outcomes.proposed }),
      t("Nothing to record: {n}", { n: outcomes.nothingToRecord }),
      part.medianHoursToRecord === null
        ? t("Median time to record needs {n} recorded replies.", { n: minimum })
        : t("Median time to record: {n} hours", { n: oneDecimal(part.medianHoursToRecord) }),
    ];
    const summary = [
      t("{n} recorded", { n: recordedReplies(outcomes) }),
      manualReplies(outcomes) ? t("{n} recorded by hand", { n: manualReplies(outcomes) }) : null,
      notRecordedReplies(outcomes) ? t("{n} not recorded", { n: notRecordedReplies(outcomes) }) : null,
      openReplies(outcomes) ? t("{n} open", { n: openReplies(outcomes) }) : null,
    ].filter(Boolean).join(" · ");
    const outcome = !part.received ? dash(none) : <span title={lines.join("\n")} data-testid="supplier-reliability-outcomes">{summary}</span>;
    return [received, stated, outcome];
  };

  const showRevisions = data?.visibility.revisions ?? false;
  const showReplies = data?.visibility.replies ?? false;
  const headers = [...(showRevisions ? REVISION_HEADERS : []), ...(showReplies ? REPLY_HEADERS : [])];
  const rows = data ? reliabilityRows(suppliers, data) : { listed: [], quiet: 0 };

  return (
    <Card data-testid="supplier-reliability">
      <div className="px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
        <div className="text-sm font-semibold" style={{ color: A.label }}>{t("Promised dates and supplier replies, 90 days")}</div>
        <div className="mt-0.5 text-[11px]" style={{ color: A.sub }} data-testid="supplier-reliability-note">
          {data ? `${t("{from} to {to}.", { from: formatCalendarDay(data.window.from, locale), to: formatCalendarDay(data.window.to, locale) })} ` : ""}
          {t("A measure of its own: on time and OTIF above stay on each order's original promise.")}
        </div>
      </div>
      {failed ? (
        <p role="alert" className="px-5 py-4 text-xs" style={{ color: A.red }}>{t("Promised-date changes and replies could not be loaded. Refresh to try again.")}</p>
      ) : !data ? (
        <div className="p-6 text-center text-xs" style={{ color: A.sub }}>{t("Loading…")}</div>
      ) : rows.listed.length === 0 ? (
        <p className="px-5 py-6 text-center text-xs" style={{ color: A.sub }} data-testid="supplier-reliability-empty">{t("No orders due and no supplier replies in these 90 days.")}</p>
      ) : (
        <div className={tableScrollClass} ref={listTableCardsRef}>
          <table className={`w-full min-w-[880px] text-left ${tableBodyTextClass}`} data-testid="supplier-reliability-table">
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                <th className={`${thClass} sticky left-0 z-20 bg-white align-bottom`} style={{ color: A.gray1 }}>{t("Supplier code")}</th>
                <th className={`${thClass} align-bottom`} style={{ color: A.gray1 }}>{t("Supplier name")}</th>
                {headers.map(([label, tip]) => <th key={label} title={t(tip)} className={`${thClass} align-bottom !whitespace-normal !px-3 min-w-[84px] max-w-[130px] text-right`} style={{ color: A.gray1 }}>{t(label)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.listed.map((supplier, index) => {
                const row = data.suppliers[supplier.id];
                const cells = [...(showRevisions ? revisionCells(row?.revisions ?? null) : []), ...(showReplies ? replyCells(row?.replies ?? null) : [])];
                return (
                  <tr key={supplier.id} className={listRowClass} data-testid={`supplier-reliability-row-${supplier.id}`} style={{ borderBottom: index < rows.listed.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}><EntityLink kind="supplier" id={supplier.id} className={tableLinkClass}>{supplier.supplierCode}</EntityLink></td>
                    <td className={`${tdNameClass} max-w-[170px]`} title={supplier.supplierName}><div className="truncate font-medium" style={{ color: A.label }}>{supplier.supplierName}</div></td>
                    {cells.map((cell, column) => <td key={column} className={`${tdNumericRightClass} !px-3`}>{cell}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && !failed && rows.listed.length > 0 && rows.quiet > 0 ? (
        <p className="px-5 pb-3 pt-2 text-[11px]" style={{ color: A.sub }} data-testid="supplier-reliability-quiet">
          {rows.quiet === 1 ? t("1 supplier with no orders due and no replies in these 90 days is not listed.") : t("{n} suppliers with no orders due and no replies in these 90 days are not listed.", { n: rows.quiet })}
        </p>
      ) : null}
    </Card>
  );
}
