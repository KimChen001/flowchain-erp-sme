import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";
import { useUnsavedChanges } from "../navigation/UnsavedChangesProvider";
import { A, Card } from "../ui";
import { useI18n } from "../../i18n/I18n";
import { todayInTimeZone } from "../../lib/format";
import { useReturnsCopy } from "../../modules/inventory/returnsCopy";

// Used only by /app/sales/returns/new. Nothing on this form is stored, so it
// offers no save action: typed input stays in the page and the leave guard
// warns before it is discarded. Customer returns are requested under
// Inventory › Returns.
export function BusinessDocumentForm({ documentLabel, documentId, listPath, mode = "new" }: {
  documentLabel: string;
  documentId?: string;
  listPath: string;
  mode?: "new" | "edit";
}) {
  const navigate = useNavigate();
  const { timezone } = useI18n();
  const { copy } = useReturnsCopy();
  const [reference, setReference] = useState(documentId || "");
  const [businessDate, setBusinessDate] = useState(() => todayInTimeZone(timezone));
  const [party, setParty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [dirty, setDirty] = useState(false);
  const label = copy(documentLabel);

  useUnsavedChanges({ key: `business-form:${listPath}:${documentId || "new"}`, label: mode === "new" ? copy("New {label}", { label }) : copy("Edit {label}", { label }), dirty });
  const change = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setter(event.target.value); setDirty(true); };

  return <Card className="p-6" data-testid="business-document-form">
    <div className="mb-5 flex items-center justify-between gap-4">
      <button type="button" className="fc-action-button fc-action-secondary" onClick={() => navigate(listPath)}><ArrowLeft size={14} />{copy("Back to list")}</button>
      <span className="fc-caption" style={{ color: dirty ? A.orange : A.gray2 }}>{dirty ? copy("Unsaved changes") : copy("Drafts are not stored here")}</span>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <label className="fc-label">{copy("Document number")}<input className="mt-1 h-9 w-full rounded-lg border px-3 fc-input-text" value={reference} onChange={change(setReference)} /></label>
      <label className="fc-label">{copy("Business date")}<input type="date" className="mt-1 h-9 w-full rounded-lg border px-3 fc-input-text" value={businessDate} onChange={change(setBusinessDate)} /></label>
      <label className="fc-label md:col-span-2">{copy("Party")}<input className="mt-1 h-9 w-full rounded-lg border px-3 fc-input-text" value={party} placeholder={copy("Customer, supplier or warehouse")} onChange={change(setParty)} /></label>
      <label className="fc-label md:col-span-2">{copy("Notes")}<textarea className="mt-1 min-h-28 w-full rounded-lg border p-3 fc-input-text" value={remarks} onChange={change(setRemarks)} /></label>
    </div>
    <div className="mt-5 flex items-center justify-between gap-4">
      <p className="fc-caption" style={{ color: A.gray2 }}>{copy("This form does not store anything. Customer returns are requested under Inventory › Returns.")}</p>
      <button type="button" className="fc-action-button fc-action-secondary" onClick={() => navigate(listPath)}>{copy("Cancel")}</button>
    </div>
  </Card>;
}
