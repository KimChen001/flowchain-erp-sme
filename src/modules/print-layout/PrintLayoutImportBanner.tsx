import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { DocumentSettings } from "../../../shared/business-documents.mjs";
import { useI18n } from "../../i18n/I18n";
import { importCopies, importDecided, readBrowserTemplates, rememberImportDecision, removeImportedBrowserTemplates } from "./printLayoutBrowserImport";
import { saveWorkspaceLayouts } from "./printLayoutStorage";
import type { PrintLayoutTemplate } from "./printLayoutTypes";

type Stage = "banner" | "review" | "remove" | "done";

// Print templates still saved in this browser from before they became the
// workspace's. Whoever may manage the workspace settings decides what
// happens to them; nothing is imported or removed without their choice, and
// Remove takes out only the templates they imported. Everyone else is told
// the browser copies are no longer used.
export default function PrintLayoutImportBanner({ tenantId, canManage, describeFailure, onImported }: {
  tenantId: string;
  canManage: boolean;
  describeFailure: (error: unknown) => string;
  onImported: (documents: DocumentSettings) => void;
}) {
  const { t } = useI18n();
  const entries = useMemo(() => readBrowserTemplates(), []);
  const importable = useMemo(() => entries.flatMap((entry, index) => entry.template ? [{ index, template: entry.template }] : []), [entries]);
  const unreadable = entries.length - importable.length;
  const [stage, setStage] = useState<Stage>(() => (canManage && importDecided(tenantId) ? "done" : "banner"));
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(importable.map((item) => item.index)));
  const [imported, setImported] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);

  if (!entries.length || stage === "done") return null;
  if (!canManage) {
    return <div className="print-import-banner" role="note" data-testid="print-layout-import-admin-note"><span>{t("printLayout.import.adminNote")}</span></div>;
  }

  const typeLabel = (template: PrintLayoutTemplate) => t(`printLayout.documentType.${template.documentType}` as Parameters<typeof t>[0]);

  async function importChosen() {
    const selected = importable.filter((item) => chosen.has(item.index));
    if (!selected.length) return;
    setImporting(true);
    try {
      const documents = await saveWorkspaceLayouts((current) => [...current, ...importCopies(selected.map((item) => item.template), current, t("printLayout.import.suffix"))]);
      const done = new Set(selected.map((item) => item.index));
      // Asked again next time only while something in the browser was not imported.
      if (done.size === entries.length) rememberImportDecision(tenantId, "imported");
      setImported(done);
      onImported(documents);
      toast.success(t("printLayout.import.done", { count: selected.length }));
      setStage("remove");
    } catch (error) {
      toast.error(t("printLayout.saveFailed"), { description: describeFailure(error) });
    } finally {
      setImporting(false);
    }
  }

  if (stage === "remove") {
    const keeps = entries.length - imported.size;
    return <div className="print-import-banner" role="status" data-testid="print-layout-import-remove">
      <span><strong>{t("printLayout.import.removePrompt")}</strong> {t("printLayout.import.removeHelp")}{keeps > 0 ? ` ${t("printLayout.import.removeKeeps", { count: keeps })}` : ""}</span>
      <div>
        <button type="button" onClick={() => setStage("done")}>{t("printLayout.import.keep")}</button>
        <button type="button" className="danger" data-testid="print-layout-import-remove-confirm" onClick={() => { removeImportedBrowserTemplates(entries, imported); toast.success(t("printLayout.import.removed")); setStage("done"); }}>{t("printLayout.import.remove")}</button>
      </div>
    </div>;
  }

  return <>
    <div className="print-import-banner" role="status" data-testid="print-layout-import-banner">
      <span>{t("printLayout.import.banner", { count: entries.length })}</span>
      <div>
        <button type="button" className="primary" onClick={() => setStage("review")} disabled={!importable.length}>{t("printLayout.import.review")}</button>
        <button type="button" onClick={() => setStage("done")}>{t("printLayout.import.notNow")}</button>
        <button type="button" onClick={() => { rememberImportDecision(tenantId, "dont_ask"); setStage("done"); }}>{t("printLayout.import.dontAsk")}</button>
      </div>
    </div>
    {stage === "review" && <div className="print-unsaved-backdrop" data-testid="print-layout-import-review">
      <div className="print-unsaved-dialog print-import-dialog" role="dialog" aria-modal="true" aria-label={t("printLayout.import.title")}>
        <h2>{t("printLayout.import.title")}</h2>
        <p>{t("printLayout.import.help")}</p>
        {unreadable > 0 && <p>{t("printLayout.import.unreadable", { count: unreadable })}</p>}
        <ul className="print-import-list">
          {importable.map(({ index, template }) => <li key={`${template.id}-${index}`}>
            <label>
              <input type="checkbox" checked={chosen.has(index)} onChange={(event) => setChosen((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(index); else next.delete(index);
                return next;
              })} />
              <span>{template.name}</span>
              <small>{typeLabel(template)}</small>
            </label>
          </li>)}
        </ul>
        <div>
          <button type="button" onClick={() => setStage("banner")}>{t("printLayout.import.cancel")}</button>
          <button type="button" className="primary" data-testid="print-layout-import-confirm" disabled={!chosen.size || importing} onClick={() => void importChosen()}>{t("printLayout.import.confirm", { count: chosen.size })}</button>
        </div>
      </div>
    </div>}
  </>;
}
