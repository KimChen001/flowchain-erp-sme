import { useCallback } from 'react';
import { useI18n } from './I18n';
import { workspaceCopy } from './workspaceCopy';

export function useWorkspaceCopy() {
  const { language } = useI18n();
  return useCallback((label: string) => workspaceCopy(label, language), [language]);
}
