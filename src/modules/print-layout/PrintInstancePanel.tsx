import { useI18n } from "../../i18n/I18n";
import { instanceElementId, printInstanceFields } from "./printLayoutElements";
import type { PrintDocumentType } from "./printLayoutTypes";

export default function PrintInstancePanel({ documentType, values, onChange }: {
  documentType: PrintDocumentType;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  return <div className="print-inspector-section" data-testid="print-instance-panel">
    <div className="print-inspector-title">{t("printLayout.instancePanelTitle")}</div>
    <p className="print-instance-help">{t("printLayout.instancePanelHelp")}</p>
    <div className="print-property-form">
      {printInstanceFields(documentType, t).map((field) => <label key={field.key}>{field.label}
        <textarea aria-label={field.label} rows={3} value={values[instanceElementId(field.key)] || ""} onChange={(event) => onChange(field.key, event.target.value)} />
      </label>)}
    </div>
  </div>;
}
