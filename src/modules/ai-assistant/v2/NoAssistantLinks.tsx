import { Fragment } from "react";
import { A } from "../../../components/ui";
import { translate, useI18n, type TranslationKey } from "../../../i18n/I18n";
import type { Navigate } from "./parts/partKit";

// The notices after which the assistant gives no answer: AI off, no model on
// this server, the month's allowance used, or the model down. Today, the
// reorder list and Reports all work without the model, so the notice offers
// them instead of ending there (product review 2026-11-20, item 23).
export const NOTICES_WITHOUT_ANSWERS = new Set(["ai_off", "no_provider", "over_cap", "unavailable"]);

const LINKS: Array<[routeId: string, key: TranslationKey]> = [
  ["overview:risks", "ai.v2.elsewhere.today"],
  ["inventory:reorder", "ai.v2.elsewhere.reorder"],
  ["reports:overview", "ai.v2.elsewhere.reports"],
];

export function NoAssistantLinks({ onNavigate }: { onNavigate?: Navigate }) {
  const { language } = useI18n();
  if (!onNavigate) return null;
  return (
    <p data-testid="ai-elsewhere" className="mt-2 text-[13px] leading-relaxed" style={{ color: A.gray1 }}>
      {translate(language, "ai.v2.elsewhere.lead")}{" "}
      {LINKS.map(([routeId, key], index) => (
        <Fragment key={routeId}>
          {index ? " · " : ""}
          <button type="button" className="font-medium text-blue-600 hover:underline" data-testid={`ai-elsewhere-${routeId.replace(":", "-")}`} onClick={() => onNavigate(routeId)}>
            {translate(language, key)}
          </button>
        </Fragment>
      ))}
    </p>
  );
}
