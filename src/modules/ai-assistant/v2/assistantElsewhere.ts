import type { TranslationKey } from "../../../i18n/I18n";

// The notices after which the assistant gives no answer: AI off, no model on
// this server, the month's allowance used, or the model down. Today, the
// reorder list and Reports all work without the model, so the notice offers
// them instead of ending there (product review 2026-11-20, item 23).
export const NOTICES_WITHOUT_ANSWERS = new Set(["ai_off", "no_provider", "over_cap", "unavailable"]);

export const ELSEWHERE_LINKS: ReadonlyArray<readonly [routeId: string, key: TranslationKey]> = [
  ["overview:risks", "ai.v2.elsewhere.today"],
  ["inventory:reorder", "ai.v2.elsewhere.reorder"],
  ["reports:overview", "ai.v2.elsewhere.reports"],
];

// The links this reader may open: a role without the reorder list's
// permission (Finance Specialist) is not sent to Access denied.
export function elsewhereLinks(canOpenRoute: (routeId: string) => boolean) {
  return ELSEWHERE_LINKS.filter(([routeId]) => canOpenRoute(routeId));
}
