import { Fragment } from "react";
import { A } from "../../../components/ui";
import { useRouteAvailability } from "../../../app/routeAvailability";
import { translate, useI18n, type SupportedLanguage } from "../../../i18n/I18n";
import type { Navigate } from "./parts/partKit";
import { elsewhereLinks } from "./assistantElsewhere";

export { NOTICES_WITHOUT_ANSWERS } from "./assistantElsewhere";

// Under a notice that leaves no answer: the pages that work without the
// assistant and that this reader may open (the panel sits inside the app's
// RouteAvailabilityProvider). `language` is the answer's own, so an older
// answer keeps its language; the interface language otherwise.
export function NoAssistantLinks({ onNavigate, language: answerLanguage }: { onNavigate?: Navigate; language?: SupportedLanguage }) {
  const { language: interfaceLanguage } = useI18n();
  const canOpenRoute = useRouteAvailability();
  const language = answerLanguage || interfaceLanguage;
  const links = elsewhereLinks(canOpenRoute);
  if (!onNavigate || !links.length) return null;
  return (
    <p data-testid="ai-elsewhere" className="mt-2 text-[13px] leading-relaxed" style={{ color: A.gray1 }}>
      {translate(language, "ai.v2.elsewhere.lead")}{" "}
      {links.map(([routeId, key], index) => (
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
