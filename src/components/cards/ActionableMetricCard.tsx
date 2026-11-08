import type React from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { A, Card } from "../ui";
import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";

export function ActionableMetricCard({
  label,
  value,
  description,
  to,
  icon: Icon,
  color = A.blue,
  state,
}: {
  label: string;
  value: string;
  description: string;
  to: string;
  icon: React.ElementType;
  color?: string;
  state?: Record<string, unknown>;
}) {
  const copy = useWorkspaceCopy();
  return (
    <Link
      to={to}
      state={state}
      className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      aria-label={`${copy(label)}: ${value}, ${copy(description)}`}
    >
      <Card className="flex h-full flex-col gap-3 p-4 transition-transform group-hover:-translate-y-0.5">
        <div className="flex items-center justify-between">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${color}12`, color }}>
            <Icon size={15} strokeWidth={1.8} />
          </span>
          <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" style={{ color }} />
        </div>
        {/* A long value (a currency total) steps down a size when its card is
            narrow (two cards to a row on a phone) and wraps rather than run
            past the card; short values keep the KPI size. */}
        <div className="@container min-w-0">
          <div className={`fc-kpi-value [overflow-wrap:anywhere] ${value.length > 9 ? "@max-[200px]:text-[18px] @max-[200px]:leading-6 @max-[135px]:text-[16px] @max-[135px]:leading-5" : ""}`} style={{ color: A.label }}>{value}</div>
          <div className="fc-label mt-0.5" style={{ color: A.sub }}>{copy(label)}</div>
          <div className="fc-caption mt-1" style={{ color: A.gray2 }}>{copy(description)}</div>
        </div>
      </Card>
    </Link>
  );
}
