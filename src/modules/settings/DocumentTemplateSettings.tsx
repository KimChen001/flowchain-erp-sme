import { useEffect, useMemo, useState } from "react";
import { FileText, Save } from "lucide-react";
import { DOCUMENT_SETTINGS_LIMITS, validateDocumentSettings, type DocumentSettings } from "../../../shared/business-documents.mjs";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ApiError } from "../../lib/api-client";
import { fetchDocumentSettings, saveDocumentSettings } from "./settingsRuntime";

type Translate = ReturnType<typeof useI18n>["t"];
type TranslationKey = Parameters<Translate>[0];

const field = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50";
const COLUMN_KEYS = ["supplierSku", "requestedDate", "promisedDate"] as const;

// The form label a validation error names, from the field path the shared
// check reports ("purchaseOrder.termsText", "letterhead.addressLines.2").
const FIELD_LABELS: Array<[RegExp, TranslationKey]> = [
  [/^letterhead\.companyName/, "documents.templates.companyName"],
  [/^letterhead\.addressLines/, "documents.templates.letterhead"],
  [/^letterhead\.phone/, "documents.templates.phone"],
  [/^letterhead\.email/, "documents.templates.email"],
  [/^letterhead\.taxId/, "documents.templates.taxId"],
  [/^purchaseOrder\.title/, "documents.templates.poTitle"],
  [/^purchaseOrder\.termsText/, "documents.templates.termsText"],
  [/^purchaseOrder\.footerText/, "documents.templates.footerText"],
  [/^customerInvoice\.title/, "documents.templates.poTitle"],
  [/^customerInvoice\.paymentInstructions/, "documents.templates.paymentInstructions"],
  [/^customerInvoice\.termsText/, "documents.templates.termsText"],
  [/^customerInvoice\.footerText/, "documents.templates.footerText"],
  [/^customerInvoice\.showPaymentSummary/, "documents.templates.showPaymentSummary"],
  [/^customerInvoice\.columns\.tax/, "documents.templates.column.tax"],
  [/^documentLanguage/, "documents.templates.documentLanguage"],
];

type FieldDetails = { field?: string; limit?: number };

// One message for a refused value, from the shared check here or the same
// check on the server (its code and { field, limit } details).
function fieldMessage(t: Translate, code: string | undefined, details: FieldDetails) {
  const label = FIELD_LABELS.find(([pattern]) => pattern.test(details.field || ""))?.[1];
  const name = label ? t(label) : details.field || "";
  if (code === "DOCUMENT_SETTING_TOO_LONG") return t("documents.templates.tooLong", { field: name, limit: details.limit ?? "" });
  if (code === "DOCUMENT_SETTING_TOO_MANY_LINES") return t("documents.templates.tooManyLines", { field: name, limit: details.limit ?? "" });
  return t("documents.templates.invalid", { field: name });
}

function problem(t: Translate, draft: DocumentSettings) {
  try {
    validateDocumentSettings(draft);
    return "";
  } catch (error) {
    return fieldMessage(t, (error as { code?: string }).code, (error as { details?: FieldDetails }).details || {});
  }
}

// Why a save failed: a refused value named as the form names it, a missing
// permission, or the general failure with the server's own message.
function saveFailure(t: Translate, error: unknown) {
  if (error instanceof ApiError) {
    const details = (error.payload as { details?: FieldDetails }).details;
    if (error.status === 403) return t("documents.templates.forbidden");
    if (error.status === 400 && details && typeof details === "object" && !Array.isArray(details) && details.field) return fieldMessage(t, error.code, details);
    return error.message ? `${t("settings.saveFailed")} (${error.message})` : t("settings.saveFailed");
  }
  return t("settings.saveFailed");
}

// Letterhead, purchase order and invoice templates for printed documents, under
// Settings › Company & workspace. Whoever may manage workspace settings
// edits them; everyone else sees them read-only. The server checks the
// permission and the same limits again.
export default function DocumentTemplateSettings({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<DocumentSettings | null>(null);
  const [draft, setDraft] = useState<DocumentSettings | null>(null);
  const [addressText, setAddressText] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [failure, setFailure] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    fetchDocumentSettings()
      .then((settings) => { setSaved(settings); setDraft(settings); setAddressText(settings.letterhead.addressLines.join("\n")); })
      .catch(() => setLoadFailed(true));
  }, []);

  // The address is edited as text, one line per row.
  const next = useMemo(() => draft && { ...draft, letterhead: { ...draft.letterhead, addressLines: addressText.split(/\r?\n/) } }, [draft, addressText]);
  const error = next ? problem(t, next) : "";
  const dirty = Boolean(next && saved && JSON.stringify(validatedOrNull(next)) !== JSON.stringify(saved));

  if (loadFailed) return <Card className="p-5 text-sm text-red-600">{t("settings.loadFailed")}</Card>;
  if (!draft || !next) return <Card className="p-5"><div className="h-24 animate-pulse rounded-xl bg-slate-100" /></Card>;

  const letterhead = (patch: Partial<DocumentSettings["letterhead"]>) => { setDraft({ ...draft, letterhead: { ...draft.letterhead, ...patch } }); setState("idle"); };
  const purchaseOrder = (patch: Partial<DocumentSettings["purchaseOrder"]>) => { setDraft({ ...draft, purchaseOrder: { ...draft.purchaseOrder, ...patch } }); setState("idle"); };
  const customerInvoice = (patch: Partial<DocumentSettings["customerInvoice"]>) => { setDraft({ ...draft, customerInvoice: { ...draft.customerInvoice, ...patch } }); setState("idle"); };
  const save = async () => {
    setState("saving");
    try {
      // PATCH replaces the whole section. Print layouts are saved from the
      // print-layout editor, so the ones stored now are sent back unchanged.
      const latest = await fetchDocumentSettings();
      const result = await saveDocumentSettings(validateDocumentSettings({ ...next, layouts: latest.layouts, unreadableLayouts: latest.unreadableLayouts }));
      setSaved(result.settings); setDraft(result.settings); setAddressText(result.settings.letterhead.addressLines.join("\n"));
      setState("saved");
    } catch (saveError) {
      setFailure(saveFailure(t, saveError));
      setState("failed");
    }
  };
  const cancel = () => { if (saved) { setDraft(saved); setAddressText(saved.letterhead.addressLines.join("\n")); setState("idle"); } };
  const count = (value: string, max: number) => <span className="text-xs text-slate-500">{t("documents.templates.count", { count: value.length, max })}</span>;

  return (
    <Card className="p-5" data-testid="document-template-settings">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><FileText size={18} />{t("documents.templates.title")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("documents.templates.description")}</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {dirty && <button type="button" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold" onClick={cancel}>{t("settings.cancel")}</button>}
            <button type="button" data-testid="document-template-save" disabled={!dirty || Boolean(error) || state === "saving"} onClick={() => void save()} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: A.blue }}>
              <Save size={15} />{state === "saving" ? t("settings.saving") : dirty ? t("settings.save") : t("settings.saved")}
            </button>
          </div>
        )}
      </div>
      {!canEdit && <p data-testid="document-template-read-only" className="mt-3 text-sm text-amber-700">{t("settings.workspaceOnly")}</p>}
      {error && <p role="alert" data-testid="document-template-error" className="mt-3 text-sm text-red-600">{error}</p>}
      {state === "failed" && <p role="status" data-testid="document-template-save-failed" className="mt-3 text-sm text-red-600">{failure || t("settings.saveFailed")}</p>}

      <fieldset disabled={!canEdit} className="mt-5 space-y-6">
        <label className="block max-w-sm text-sm">{t("documents.templates.documentLanguage")}
          <select aria-label={t("documents.templates.documentLanguage")} className={`${field} mt-1`} value={draft.documentLanguage} onChange={(event) => { setDraft({ ...draft, documentLanguage: event.target.value === "zh-CN" ? "zh-CN" : "en-US" }); setState("idle"); }}>
            <option value="en-US">{t("settings.english")} — en-US</option>
            <option value="zh-CN">{t("settings.chinese")} — zh-CN</option>
          </select>
        </label>

        <section>
          <h3 className="mb-3 font-medium" style={{ color: A.label }}>{t("documents.templates.letterhead")}</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm">{t("documents.templates.companyName")}
              <input className={`${field} mt-1`} value={draft.letterhead.companyName || ""} maxLength={DOCUMENT_SETTINGS_LIMITS.companyName} onChange={(event) => letterhead({ companyName: event.target.value })} />
              <span className="mt-1 block text-xs text-slate-500">{t("documents.templates.companyNameHelp")}</span>
            </label>
            <label className="text-sm">{t("documents.templates.addressLines", { max: DOCUMENT_SETTINGS_LIMITS.addressLines })}
              <textarea data-testid="document-template-address" rows={4} className={`${field} mt-1`} value={addressText} onChange={(event) => { setAddressText(event.target.value); setState("idle"); }} />
            </label>
            <label className="text-sm">{t("documents.templates.phone")}<input className={`${field} mt-1`} value={draft.letterhead.phone || ""} maxLength={DOCUMENT_SETTINGS_LIMITS.phone} onChange={(event) => letterhead({ phone: event.target.value })} /></label>
            <label className="text-sm">{t("documents.templates.email")}<input type="email" className={`${field} mt-1`} value={draft.letterhead.email || ""} maxLength={DOCUMENT_SETTINGS_LIMITS.email} onChange={(event) => letterhead({ email: event.target.value })} /></label>
            <label className="text-sm">{t("documents.templates.taxId")}<input className={`${field} mt-1`} value={draft.letterhead.taxId || ""} maxLength={DOCUMENT_SETTINGS_LIMITS.taxId} onChange={(event) => letterhead({ taxId: event.target.value })} /></label>
          </div>
        </section>

        <section>
          <h3 className="mb-3 font-medium" style={{ color: A.label }}>{t("documents.templates.purchaseOrder")}</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm">{t("documents.templates.poTitle")}
              <input className={`${field} mt-1`} value={draft.purchaseOrder.title || ""} maxLength={DOCUMENT_SETTINGS_LIMITS.title} onChange={(event) => purchaseOrder({ title: event.target.value })} />
              <span className="mt-1 block text-xs text-slate-500">{t("documents.templates.poTitleHelp")}</span>
            </label>
            <div className="text-sm">
              <div>{t("documents.templates.columns")}</div>
              <div className="mt-2 flex flex-wrap gap-4">
                {COLUMN_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-2">
                    <input type="checkbox" data-testid={`document-template-column-${key}`} checked={draft.purchaseOrder.columns[key]} onChange={(event) => purchaseOrder({ columns: { ...draft.purchaseOrder.columns, [key]: event.target.checked } })} />
                    {t(`documents.templates.column.${key}` as TranslationKey)}
                  </label>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={draft.purchaseOrder.signatureBlock} onChange={(event) => purchaseOrder({ signatureBlock: event.target.checked })} />{t("documents.templates.signatureBlock")}</label>
            </div>
            <label className="text-sm md:col-span-2">{t("documents.templates.termsText")}
              <textarea data-testid="document-template-terms" rows={4} className={`${field} mt-1`} value={draft.purchaseOrder.termsText} onChange={(event) => purchaseOrder({ termsText: event.target.value })} />
              <span className="mt-1 flex justify-between gap-3 text-xs text-slate-500"><span>{t("documents.templates.termsHelp")}</span>{count(draft.purchaseOrder.termsText, DOCUMENT_SETTINGS_LIMITS.termsText)}</span>
            </label>
            <label className="text-sm md:col-span-2">{t("documents.templates.footerText")}
              <textarea rows={2} className={`${field} mt-1`} value={draft.purchaseOrder.footerText} onChange={(event) => purchaseOrder({ footerText: event.target.value })} />
              <span className="mt-1 flex justify-end">{count(draft.purchaseOrder.footerText, DOCUMENT_SETTINGS_LIMITS.footerText)}</span>
            </label>
          </div>
        </section>

        {/* The customer invoice: printed once issued; FlowChain adds no payment terms or bank details of its own. */}
        <section className="rounded-xl border border-slate-200 p-4" data-testid="document-template-invoice">
          <h3 className="mb-3 font-medium" style={{ color: A.label }}>{t("documents.templates.customerInvoice")}</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm">{t("documents.templates.poTitle")}
              <input data-testid="document-template-invoice-title" className={`${field} mt-1`} value={draft.customerInvoice.title || ""} maxLength={DOCUMENT_SETTINGS_LIMITS.title} onChange={(event) => customerInvoice({ title: event.target.value })} />
              <span className="mt-1 block text-xs text-slate-500">{t("documents.templates.invoiceTitleHelp")}</span>
            </label>
            <div className="text-sm">
              <div>{t("documents.templates.columns")}</div>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" data-testid="document-template-invoice-column-tax" checked={draft.customerInvoice.columns.tax} onChange={(event) => customerInvoice({ columns: { ...draft.customerInvoice.columns, tax: event.target.checked } })} />
                {t("documents.templates.column.tax")}
              </label>
              <label className="mt-3 flex items-center gap-2">
                <input type="checkbox" data-testid="document-template-invoice-payment-summary" checked={draft.customerInvoice.showPaymentSummary} onChange={(event) => customerInvoice({ showPaymentSummary: event.target.checked })} />
                {t("documents.templates.showPaymentSummary")}
              </label>
              <span className="mt-1 block text-xs text-slate-500">{t("documents.templates.paymentSummaryHelp")}</span>
            </div>
            <label className="text-sm md:col-span-2">{t("documents.templates.paymentInstructions")}
              <textarea data-testid="document-template-invoice-payment-instructions" rows={3} className={`${field} mt-1`} value={draft.customerInvoice.paymentInstructions} onChange={(event) => customerInvoice({ paymentInstructions: event.target.value })} />
              <span className="mt-1 flex justify-between gap-3 text-xs text-slate-500"><span>{t("documents.templates.paymentInstructionsHelp")}</span>{count(draft.customerInvoice.paymentInstructions, DOCUMENT_SETTINGS_LIMITS.paymentInstructions)}</span>
            </label>
            <label className="text-sm md:col-span-2">{t("documents.templates.termsText")}
              <textarea data-testid="document-template-invoice-terms" rows={3} className={`${field} mt-1`} value={draft.customerInvoice.termsText} onChange={(event) => customerInvoice({ termsText: event.target.value })} />
              <span className="mt-1 flex justify-between gap-3 text-xs text-slate-500"><span>{t("documents.templates.invoiceTermsHelp")}</span>{count(draft.customerInvoice.termsText, DOCUMENT_SETTINGS_LIMITS.termsText)}</span>
            </label>
            <label className="text-sm md:col-span-2">{t("documents.templates.footerText")}
              <textarea rows={2} className={`${field} mt-1`} value={draft.customerInvoice.footerText} onChange={(event) => customerInvoice({ footerText: event.target.value })} />
              <span className="mt-1 flex justify-end">{count(draft.customerInvoice.footerText, DOCUMENT_SETTINGS_LIMITS.footerText)}</span>
            </label>
          </div>
        </section>
      </fieldset>
    </Card>
  );
}

// The form as it would be saved (trimmed, blanks dropped), or null while it
// does not pass the check; compared with the saved settings to tell a change.
function validatedOrNull(value: DocumentSettings) {
  try { return validateDocumentSettings(value); } catch { return null; }
}
