import { useMemo } from "react";
import { useI18n } from "../../i18n/I18n";
import { movementTypeLabel, statusCodeLabel } from "../../i18n/statusLabels";
import {
  returnsChinese,
  returnsCodeLabels,
  returnsErrorLabels,
  returnsLinkLabels,
  returnsRuleLabels,
  salesReturnStatusLabels,
} from "./returnsCopyData";

type Vars = Record<string, string | number | null | undefined>;

function fill(text: string, vars: Vars = {}): string {
  return Object.entries(vars).reduce(
    (out, [name, value]) => out.replaceAll(`{${name}}`, value == null ? "" : String(value)),
    text,
  );
}

function pick(pair: [string, string], english: boolean) {
  return pair[english ? 0 : 1];
}

function translate(english: boolean, key: string, vars?: Vars): string {
  return fill(english ? key : returnsChinese[key] ?? key, vars);
}

// Returns codes first (they keep their own wording), then the shared status
// and movement labels, then the raw code.
function codeLabel(english: boolean, language: string, value: unknown): string {
  const code = String(value ?? "").trim();
  if (!code) return "—";
  const own = returnsCodeLabels[code];
  if (own) return pick(own, english);
  const shared = statusCodeLabel(code, language);
  if (shared) return shared;
  const movement = movementTypeLabel(code, language);
  if (movement !== movementTypeLabel("", language)) return movement;
  return code;
}

function ruleLabel(english: boolean, language: string, rule: string): string {
  const fixed = returnsRuleLabels[rule];
  if (fixed) return pick(fixed, english);
  const movement = /^movement_(.+)_(count|identity|quantity_direction)$/.exec(rule);
  if (movement)
    return fill(pick(returnsRuleLabels[`movement_{type}_${movement[2]}`], english), {
      type: codeLabel(english, language, movement[1]),
    });
  const balance = /^balance_(available|quarantine)_/.exec(rule);
  if (balance)
    return fill(pick(returnsRuleLabels["balance_{type}"], english), {
      type: codeLabel(english, language, balance[1]),
    });
  if (rule.startsWith("reversal_")) return pick(returnsRuleLabels["reversal_{id}"], english);
  return rule;
}

// A known code gets its label in the active language. Otherwise English shows
// the server message, and Chinese shows the localized fallback with the code.
function codeMessage(english: boolean, code: string, message: string, fallbackKey: string): string {
  const pair = code ? returnsErrorLabels[code] : undefined;
  if (pair) return pick(pair, english);
  if (english) return message || fallbackKey;
  const text = returnsChinese[fallbackKey] ?? fallbackKey;
  return code ? `${text}（${code}）` : text;
}

function errorText(english: boolean, reason: unknown, fallbackKey: string): string {
  const error = reason as { code?: unknown; message?: unknown } | null;
  const code = typeof error?.code === "string" ? error.code : "";
  const message = reason instanceof Error && typeof error?.message === "string" ? error.message : "";
  return codeMessage(english, code, message, fallbackKey);
}

// Reads the active language so the page re-renders when it changes (the
// workspace language arrives after the first render).
export function useReturnsCopy() {
  const { language } = useI18n();
  return useMemo(() => {
    const english = language === "en-US";
    return {
      english,
      copy: (key: string, vars?: Vars) => translate(english, key, vars),
      codeLabel: (code: unknown) => codeLabel(english, language, code),
      ruleLabel: (rule: string) => ruleLabel(english, language, rule),
      errorText: (reason: unknown, fallbackKey: string) => errorText(english, reason, fallbackKey),
      errorLabel: (code: string) => {
        const pair = returnsErrorLabels[code];
        return pair ? pick(pair, english) : code;
      },
      // A client-side issue (localized: true) already carries display text.
      issueText: (issue: { code?: string; message?: string; localized?: boolean }, fallbackKey: string) =>
        issue?.localized && issue.message
          ? issue.message
          : codeMessage(english, String(issue?.code || ""), String(issue?.message || ""), fallbackKey),
      linkLabel: (link: { id?: string; label?: string }) => {
        const pair = returnsLinkLabels[String(link?.id || "")];
        return pair ? pick(pair, english) : String(link?.label || "");
      },
      salesStatusLabel: (status: string) => {
        const pair = salesReturnStatusLabels[status];
        return pair ? pick(pair, english) : status;
      },
      listSeparator: english ? ", " : "、",
    };
  }, [language]);
}
