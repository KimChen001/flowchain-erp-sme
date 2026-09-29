import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";
import { masterDataCopy } from "./masterDataFormat";

export { dueDateRule, formatPercent, masterDataCopy, NOT_PROVIDED, orNotProvided, taxTypeLabel } from "./masterDataFormat";
export function useMasterDataCopy() {
  const { language, locale } = useI18n();
  const copy = useCallback(
    (value: string, params?: Record<string, string | number>) => masterDataCopy(value, language, params),
    [language],
  );
  return { copy, language, locale };
}
