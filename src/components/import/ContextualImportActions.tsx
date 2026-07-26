import { ArrowRight, ShieldAlert } from "lucide-react";
import { Link } from "react-router";

type ContextualImportActionsProps = { entityLabel: string; templateName?: string; compact?: boolean };

export default function ContextualImportActions({ entityLabel, compact = false }: ContextualImportActionsProps) {
  const buttonClass = compact
    ? "h-8 px-2.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
    : "h-9 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5";
  return (
    <Link
      to="/app/universal-intake"
      className={buttonClass}
      style={{ background: "#fff8f0", color: "#c2410c" }}
      title={`Legacy ${entityLabel} import is retired`}
      data-testid="legacy-import-retired-link"
    >
      <ShieldAlert size={13} />旧导入已停用<ArrowRight size={13} />
    </Link>
  );
}
