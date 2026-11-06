import { A } from "../../../../components/ui";
import { RefChip, StatusPill, cardStyle, toneStyle, usePartCopy, type Navigate, type PartCopy } from "./partKit";
import type { RecordCardsProps } from "./types";

type RelativeDate = NonNullable<RecordCardsProps["cards"][number]["date"]>;

function relativeDate(date: RelativeDate, copy: PartCopy) {
  const days = date.days ?? 0;
  if (date.kind === "overdue") return days === 1 ? copy.t("ai.v2.date.overdueOne") : copy.t("ai.v2.date.overdue", { count: copy.number(days) });
  if (date.kind === "due") return days === 0 ? copy.t("ai.v2.date.dueToday") : days === 1 ? copy.t("ai.v2.date.dueOne") : copy.t("ai.v2.date.due", { count: copy.number(days) });
  if (date.kind === "waiting") return days === 1 ? copy.t("ai.v2.date.waitingOne") : copy.t("ai.v2.date.waiting", { count: copy.number(days) });
  return date.value ? copy.day(date.value) : "";
}

const EDGE = { overdue: toneStyle("danger").color, pending: "#F97316", info: A.blue };

// Up to six records, each a card: its code as a chip that opens it, its
// label and status, how late or how soon, and one or two of its figures.
export function RecordCardsPart({ props, language, onNavigate }: { props: RecordCardsProps; language?: string; onNavigate?: Navigate }) {
  const copy = usePartCopy(language);
  return (
    <ul data-testid="ai-v2-records" lang={copy.language} className="space-y-2">
      {props.cards.map((card) => (
        <li key={`${card.ref.type}:${card.ref.id}`} data-testid="ai-v2-record-card" className="rounded-xl px-3 py-2 text-[13px]" style={{ ...cardStyle, ...(props.emphasis ? { borderLeft: `3px solid ${EDGE[props.emphasis]}` } : {}) }}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <RefChip value={card.ref} onNavigate={onNavigate} />
            {card.title ? <span className="min-w-0 truncate" style={{ color: A.label }}>{card.title}</span> : null}
            {card.status ? <span className="ml-auto"><StatusPill status={card.status} copy={copy} /></span> : null}
          </div>
          {card.date || card.figures?.length ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: A.sub }}>
              {card.date ? <span data-testid="ai-v2-record-date" style={card.date.kind === "overdue" ? { color: toneStyle("danger").color, fontWeight: 500 } : undefined}>{relativeDate(card.date, copy)}</span> : null}
              {(card.figures || []).map((figure) => <span key={figure.code}>{copy.known("ai.v2.column", figure.code)} <span className="tabular-nums" style={{ color: A.label }}>{copy.value(figure.value, figure.unit, figure.currency)}{figure.unitLabel && figure.value !== null ? ` ${figure.unitLabel}` : ""}</span></span>)}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
