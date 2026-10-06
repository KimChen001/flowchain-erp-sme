import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";

// Display copy for purchase order issue dates and price history. English is
// the source; zh-CN is chosen by the interface language. Codes, currencies,
// numbers and dates are passed in already formatted and are never translated.
const COPY = {
  "en-US": {
    issued: "Issued",
    issuedOn: "Issued {date}",
    issueDateNotRecorded: "Issue date not recorded",
  },
  "zh-CN": {
    issued: "下达日期",
    issuedOn: "{date} 下达",
    issueDateNotRecorded: "未记录下达日期",
  },
} as const;

export type PriceHistoryCopyKey = keyof (typeof COPY)["en-US"];

export function priceHistoryText(language: string, key: PriceHistoryCopyKey, params: Record<string, string | number> = {}) {
  const table = COPY[language === "zh-CN" ? "zh-CN" : "en-US"];
  return Object.entries(params).reduce((value, [name, replacement]) => value.split(`{${name}}`).join(String(replacement)), table[key] as string);
}

export function usePriceHistoryCopy() {
  const { language } = useI18n();
  return useCallback((key: PriceHistoryCopyKey, params?: Record<string, string | number>) => priceHistoryText(language, key, params), [language]);
}
