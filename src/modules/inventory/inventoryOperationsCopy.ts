import { useMemo } from "react";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { workspaceCopy } from "../../i18n/workspaceCopy";
// Display copy for the inventory workbench (inventoryOperationsCopyMaps.ts).
import { chinese, chineseCodes, english, englishCodes } from "./inventoryOperationsCopyMaps";

function translate(language: string, label: string, vars: Record<string, string | number> = {}): string {
  const text = language === "en-US" ? english[label] || workspaceCopy(label, language) : chinese[label] || label;
  return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);
}

// Reason and status codes shown as labels; the code itself is what is stored.
function codeLabel(language: string, code: string): string {
  return statusCodeLabel(code, language) || (language === "en-US" ? englishCodes[code] : chineseCodes[code] || chinese[code]) || code;
}

// Reads the active language so the page re-renders when it changes (the
// workspace language arrives after the first render).
export function useInventoryOperationsCopy() {
  const { language } = useI18n();
  return useMemo(() => ({
    copy: (label: string, vars?: Record<string, string | number>) => translate(language, label, vars),
    inventoryCodeLabel: (code: string) => codeLabel(language, code),
  }), [language]);
}
