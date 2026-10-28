import { useMemo } from "react";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { workspaceCopy } from "../../i18n/workspaceCopy";
// Display copy for the inventory workbench (inventoryOperationsCopyMaps.ts).
import { chinese, chineseCodes, english, englishCodes } from "./inventoryOperationsCopyMaps";

// Server refusals shown in this page's own words. The code is matched; the
// server's English message is shown for any other code.
const errorCodeCopy: Record<string, string> = {
  ADJUSTMENT_OPENING_BALANCE_EXISTS: "This item already has stock or stock history at this location, so opening stock cannot be recorded. Use another reason to correct it.",
};

function translate(language: string, label: string, vars: Record<string, string | number> = {}): string {
  const text = language === "en-US" ? english[label] || workspaceCopy(label, language) : chinese[label] || label;
  return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);
}

// Reason codes whose wording on this page differs from the shared status
// labels: the movement type "opening_balance" reads "Opening balance"
// elsewhere, while the adjustment reason reads "Opening stock".
const ownCodes = new Set(["opening_balance"]);

// Reason and status codes shown as labels; the code itself is what is stored.
function codeLabel(language: string, code: string): string {
  if (ownCodes.has(code)) return (language === "en-US" ? englishCodes[code] : chinese[code]) || code;
  return statusCodeLabel(code, language) || (language === "en-US" ? englishCodes[code] : chineseCodes[code] || chinese[code]) || code;
}

// Reads the active language so the page re-renders when it changes (the
// workspace language arrives after the first render).
export function useInventoryOperationsCopy() {
  const { language } = useI18n();
  return useMemo(() => ({
    copy: (label: string, vars?: Record<string, string | number>) => translate(language, label, vars),
    inventoryCodeLabel: (code: string) => codeLabel(language, code),
    // A refusal code this page knows, in the active language, or undefined.
    issueText: (code?: string) => (code && errorCodeCopy[code] ? translate(language, errorCodeCopy[code]) : undefined),
    // What a failed request shows: known refusal codes are translated, other
    // errors keep the server message, and anything else uses the fallback.
    errorText: (reason: unknown, fallback: string) => {
      const code = (reason as { code?: unknown } | null)?.code;
      const known = typeof code === "string" && errorCodeCopy[code];
      if (known) return translate(language, known);
      return reason instanceof Error ? reason.message : translate(language, fallback);
    },
  }), [language]);
}
