import { workspaceCopy } from "../../i18n/workspaceCopy";
import { useI18n } from "../../i18n/I18n";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { Link } from "react-router";

type ContextualImportActionsProps = { entityLabel: string; templateName?: string; compact?: boolean };

export default function ContextualImportActions({ entityLabel, compact = false }: ContextualImportActionsProps) {
  const { language } = useI18n();
  const copy = (label: string) => workspaceCopy(label, language);
  const buttonClass = compact
    ? "h-8 px-2.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
    : "h-9 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5";
  return (
    <Link
      to="/app/universal-intake"
      className={buttonClass}
      style={{ background: "#fff8f0", color: "#c2410c" }}
      title={language === 'en-US' ? `Legacy ${copy(entityLabel)} import is retired` : `旧${entityLabel}导入已停用`}
      data-testid="legacy-import-retired-link"
    >
      <ShieldAlert size={13} />{copy("旧导入已停用")}<ArrowRight size={13} />
    </Link>
  );
}
