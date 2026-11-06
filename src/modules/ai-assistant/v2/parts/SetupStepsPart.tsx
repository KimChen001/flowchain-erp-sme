import { CheckCircle2, Circle } from "lucide-react";
import { isUnavailableProductRoute } from "../../../../../shared/unavailable-product-routes.mjs";
import { A } from "../../../../components/ui";
import { cardStyle, usePartCopy, type Navigate } from "./partKit";
import type { SetupStepsProps } from "./types";

// The first-day checklist in an answer (setup_steps): the same steps, counts
// and pages as the checklist on Today. An open step the user may do links to
// its page, the import page for many rows at once when import is on.

const TEAL_TEXT = "#0F766E";

export function SetupStepsPart({ props, language, onNavigate }: { props: SetupStepsProps; language?: string; onNavigate?: Navigate }) {
  const copy = usePartCopy(language);
  const gaps = props.gaps && (props.gaps.unit || props.gaps.preferredSupplier || props.gaps.thresholds) ? props.gaps : null;
  return (
    <section data-testid="ai-v2-setup-steps" lang={copy.language} className="space-y-2 rounded-xl p-3 text-[13px]" style={cardStyle}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[14px] font-semibold" style={{ color: A.label }}>{copy.t("ai.v2.setup.title")}</h4>
        <span className="text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.setup.progress", { done: copy.number(props.done), total: copy.number(props.total) })}</span>
      </div>
      <ol className="space-y-1.5">
        {props.steps.map((step, index) => {
          const route = !step.done && step.route && onNavigate && !isUnavailableProductRoute(step.route.moduleId) ? step.route : null;
          const state = step.done
            ? copy.t("ai.v2.setup.stepDone", { count: copy.number(step.count) })
            : step.blocked
              ? copy.t(step.blocked === "unavailable" ? "ai.v2.setup.stepUnavailable" : "ai.v2.setup.stepAskAdmin")
              : copy.t("ai.v2.setup.stepOpen");
          return (
            <li key={step.id} data-testid="ai-v2-setup-step" data-step={step.id} data-done={step.done ? "true" : "false"} className="flex items-start gap-2">
              {step.done ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" style={{ color: TEAL_TEXT }} aria-hidden /> : <Circle size={15} className="mt-0.5 shrink-0" style={{ color: A.gray2 }} aria-hidden />}
              <div className="min-w-0 flex-1">
                <div style={{ color: A.label }}>{index + 1}. {copy.t(`ai.v2.setup.step.${step.id}`)}</div>
                <div className="text-[12px]" style={{ color: step.done ? TEAL_TEXT : A.sub }}>{state}</div>
              </div>
              {route ? (
                <button
                  type="button"
                  data-testid="ai-v2-setup-open"
                  data-route={route.moduleId}
                  onClick={() => onNavigate?.(route.moduleId, null, { returnTo: "ai", source: "ai", ...(route.query ? { query: route.query } : {}) })}
                  className="shrink-0 text-[13px] font-medium hover:underline"
                  style={{ color: A.blue }}
                >
                  {copy.t(route.moduleId === "master-data:import" ? "ai.v2.setup.openImport" : "ai.v2.setup.open")}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {gaps ? (
        <p data-testid="ai-v2-setup-gaps" className="text-[12px]" style={{ color: A.sub }}>
          {copy.t("ai.v2.setup.gaps", { checked: copy.number(gaps.checked), unit: copy.number(gaps.unit), supplier: copy.number(gaps.preferredSupplier), thresholds: copy.number(gaps.thresholds) })}
        </p>
      ) : null}
    </section>
  );
}
