import { useEffect, type ReactNode } from "react";
import { ArrowLeft, Lock, Printer } from "lucide-react";
import { Link } from "react-router";
import type { DocumentLanguage } from "../../../shared/business-documents.mjs";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import "./business-documents.css";

export type DocumentBlock = null | "status" | "prices_hidden";

// The frame of a printable business document: back link, the document
// language for this print only (never saved), "Print or save as PDF", and
// the reminder that FlowChain does not send the document; a person does.
// When the document cannot be printed, a notice says why, Print is off, and
// the browser's own print prints the notice instead of the document.
export function DocumentShell({
  backTo,
  backLabel,
  blocked,
  language,
  onLanguageChange,
  children,
}: {
  backTo: string;
  backLabel: string;
  blocked: DocumentBlock;
  language: DocumentLanguage;
  onLanguageChange: (language: DocumentLanguage) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  // Print styles hide everything but the document while this page is open.
  useEffect(() => {
    document.body.classList.add("fc-business-document-open");
    return () => document.body.classList.remove("fc-business-document-open");
  }, []);
  const printable = blocked === null;
  return (
    <div className="space-y-4" data-testid="business-document" data-printable={printable ? "true" : "false"}>
      <style>{"@media print { @page { size: A4; margin: 12mm; } }"}</style>
      <Card className="p-4">
        <div className="business-document-toolbar" data-testid="business-document-toolbar">
          <Link to={backTo} className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: A.blue }}>
            <ArrowLeft size={16} />{backLabel}
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm" title={t("documents.languageHint")}>
              <span style={{ color: A.label }}>{t("documents.language")}</span>
              <select
                data-testid="business-document-language"
                aria-label={t("documents.language")}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                value={language}
                onChange={(event) => onLanguageChange(event.target.value === "zh-CN" ? "zh-CN" : "en-US")}
              >
                <option value="en-US">{t("settings.english")} — en-US</option>
                <option value="zh-CN">{t("settings.chinese")} — zh-CN</option>
              </select>
            </label>
            <button
              type="button"
              data-testid="business-document-print"
              disabled={!printable}
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: A.blue }}
            >
              <Printer size={15} />{t("documents.print")}
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs" data-testid="business-document-send-note" style={{ color: A.sub }}>{t("documents.sendNote")}</p>
      </Card>
      {!printable && (
        <div role="alert" data-testid="business-document-blocked" className="business-document-print-target flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <Lock size={16} className="mt-0.5 shrink-0" />
          <span>{t(blocked === "status" ? "documents.blocked.status" : "documents.blocked.prices")}</span>
        </div>
      )}
      <div className="business-document-stage">
        <article
          data-testid="business-document-sheet"
          lang={language}
          className={`business-document-sheet${printable ? " business-document-print-target" : ""}`}
        >
          {children}
        </article>
      </div>
    </div>
  );
}
