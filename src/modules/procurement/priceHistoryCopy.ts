import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";
import { priceHistoryCount, priceHistoryText, type PriceHistoryCopyKey } from "./priceHistoryText";

// The price history copy in the interface language (texts in priceHistoryText.ts).
export function usePriceHistoryCopy() {
  const { language } = useI18n();
  const t = useCallback((key: PriceHistoryCopyKey, params?: Record<string, string | number>) => priceHistoryText(language, key, params), [language]);
  const count = useCallback((key: PriceHistoryCopyKey, n: number, params?: Record<string, string | number>) => priceHistoryCount(language, key, n, params), [language]);
  return Object.assign(t, { count, language });
}
