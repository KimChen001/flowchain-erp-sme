import { useEffect, useMemo, useRef, useState } from "react";
import { FileSignature } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, inputStyle } from "../../components/ui";
import { orderedCurrencyCodes } from "../../lib/currencyOptions";
import { useWorkspaceCurrency } from "../../lib/useWorkspaceCurrency";
import { CONTRACT_DEFAULT_REMINDER_DAYS, CONTRACT_MAX_NOTICE_DAYS, CONTRACT_MAX_REMINDER_DAYS, CONTRACT_RENEWALS, CONTRACT_TYPES } from "../../../shared/contract-status.mjs";
import {
  RENEWAL_LABEL,
  TYPE_LABEL,
  contractErrorText,
  contractsApi,
  fieldIssueText,
  fieldIssues,
  isVersionConflict,
  useContractCopy,
  type ContractView,
  type FieldIssue,
  type Person,
} from "./contractShared";

// The new and edit form (docs/contracts-module-design.md §2). Saving a new
// contract creates a draft; an edit sends only the fields that changed, with
// the version it was opened at, so two people cannot overwrite each other.
// An active contract keeps its supplier and type (renew it to change them).
// Field errors come from the 422's details, in the interface language.

type Form = {
  title: string;
  externalReference: string;
  type: string;
  supplierId: string;
  ownerId: string;
  startDate: string;
  endDate: string;
  signedOn: string;
  renewal: string;
  noticeDays: string;
  reminderDays: string;
  paymentTermsId: string;
  currency: string;
  totalValue: string;
  notes: string;
};
type Option = { id: string; label: string };

const fromContract = (contract?: ContractView | null, supplierId = ""): Form => ({
  title: contract?.title || "",
  externalReference: contract?.externalReference || "",
  type: contract?.type || "",
  supplierId: contract?.supplierId || supplierId,
  ownerId: contract?.ownerId || "",
  startDate: contract?.startDate || "",
  endDate: contract?.endDate || "",
  signedOn: contract?.signedOn || "",
  renewal: contract?.renewal || "none",
  noticeDays: String(contract?.noticeDays ?? 0),
  reminderDays: String(contract?.reminderDays ?? CONTRACT_DEFAULT_REMINDER_DAYS),
  paymentTermsId: contract?.paymentTermsId || "",
  currency: contract?.currency || "",
  totalValue: contract?.totalValue === null || contract?.totalValue === undefined ? "" : String(Number(contract.totalValue)),
  notes: contract?.notes || "",
});
// The amount as the API takes it: digits and a decimal point.
const cleanAmount = (value: string) => value.replace(/[,\s]/g, "");

export function ContractForm({ contract = null, initialSupplierId = "", onSaved, onCancel, onReload }: {
  contract?: ContractView | null;
  initialSupplierId?: string;
  onSaved: (saved: ContractView) => void;
  onCancel: () => void;
  onReload?: () => void;
}) {
  const t = useContractCopy();
  const editing = Boolean(contract);
  const locked = contract?.status === "active";
  const valueHidden = Boolean(contract?.restrictedFields?.includes("totalValue"));
  const initial = useMemo(() => fromContract(contract, initialSupplierId), [contract, initialSupplierId]);
  const [form, setForm] = useState<Form>(initial);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [suppliers, setSuppliers] = useState<Option[] | null>(null);
  const [owners, setOwners] = useState<Person[] | null>([]);
  const [terms, setTerms] = useState<Option[] | null>([]);
  const workspace = useWorkspaceCurrency();
  // One key per opened form: a double click creates one draft, not two.
  const createKey = useRef(`contract-create-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`);

  useEffect(() => { setForm(initial); setIssues([]); setError(null); }, [initial]);
  useEffect(() => {
    apiJson<{ suppliers: Array<{ id: string; supplierName?: string; name?: string; supplierCode?: string }> }>("/api/master-data/suppliers")
      .then(({ suppliers: rows }) => setSuppliers((rows || []).map((row) => ({ id: row.id, label: String(row.supplierName || row.name || row.id) }))))
      .catch(() => setSuppliers(null));
    apiJson<{ owners: Person[] }>("/api/master-data/supplier-owners")
      .then(({ owners: rows }) => setOwners(rows || []))
      .catch(() => setOwners(null));
    apiJson<{ options: Array<{ id: string; code?: string; label?: string }> }>("/api/master-data/payment-terms/select")
      .then(({ options }) => setTerms((options || []).map((option) => ({ id: option.code || option.id, label: option.label || option.code || option.id }))))
      .catch(() => setTerms(null));
  }, []);

  const set = (key: keyof Form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setIssues((current) => current.filter((issue) => issue.field !== key));
  };
  const issueFor = (field: string) => issues.find((issue) => issue.field === field);

  // A stored value that is not in a loaded list stays selectable.
  const supplierOptions = useMemo(() => {
    const rows = suppliers || [];
    const current = contract?.supplier;
    return current && !rows.some((row) => row.id === current.id) ? [...rows, { id: current.id, label: current.name }] : rows;
  }, [suppliers, contract]);
  const ownerOptions = useMemo(() => {
    const rows = owners || [];
    const current = contract?.owner;
    return current && !rows.some((row) => row.id === current.id) ? [...rows, current] : rows;
  }, [owners, contract]);
  const termOptions = useMemo(() => {
    const rows = terms || [];
    return form.paymentTermsId && !rows.some((row) => row.id === form.paymentTermsId) ? [...rows, { id: form.paymentTermsId, label: form.paymentTermsId }] : rows;
  }, [terms, form.paymentTermsId]);
  const currencies = orderedCurrencyCodes(workspace.currency, null, form.currency);

  const payload = () => {
    const values: Record<string, unknown> = {
      title: form.title.trim(),
      externalReference: form.externalReference.trim(),
      type: form.type,
      supplierId: form.supplierId,
      ownerId: form.ownerId,
      startDate: form.startDate,
      endDate: form.endDate,
      renewal: form.renewal,
      noticeDays: form.renewal === "automatic" ? form.noticeDays : initial.noticeDays,
      reminderDays: form.reminderDays,
      paymentTermsId: form.paymentTermsId,
      currency: form.currency,
      totalValue: cleanAmount(form.totalValue),
      notes: form.notes.trim(),
    };
    if (editing && locked) values.signedOn = form.signedOn;
    if (valueHidden) { delete values.totalValue; delete values.currency; }
    if (!editing) {
      // On create an empty owner means the supplier's business owner.
      if (!form.ownerId) delete values.ownerId;
      return values;
    }
    // On edit only what changed goes, so the audit row names it.
    const before: Record<string, unknown> = { ...initial, totalValue: cleanAmount(initial.totalValue) };
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => String(value ?? "") !== String(before[key] ?? "")));
  };

  const save = async () => {
    setSaving(true);
    setIssues([]);
    setError(null);
    try {
      const values = payload();
      const result = editing
        ? await contractsApi.update(contract!.id, { ...values, expectedVersion: contract!.version })
        : await contractsApi.create({ ...values, idempotencyKey: createKey.current });
      if (result.contract) onSaved(result.contract);
    } catch (caught) {
      setIssues(fieldIssues(caught));
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const label = (field: string, text: string, required = false) => (
    <label htmlFor={`contract-${field}`} className="text-[13px] font-semibold" style={{ color: A.sub }}>
      {t(text)}{required && <span className="ml-1 text-blue-600">*</span>}
    </label>
  );
  const fieldError = (field: string) => {
    const issue = issueFor(field);
    return issue ? <p id={`contract-error-${field}`} className="mt-1 text-xs text-red-600" data-testid={`contract-error-${field}`}>{fieldIssueText(issue, t)}</p> : null;
  };
  const control = (field: keyof Form) => ({
    id: `contract-${field}`,
    value: form[field],
    "aria-invalid": Boolean(issueFor(field)),
    "aria-describedby": issueFor(field) ? `contract-error-${field}` : undefined,
    style: inputStyle,
  });
  const hint = (text: string) => <p className="mt-1 text-[12px]" style={{ color: A.gray2 }}>{t(text)}</p>;

  return (
    <form noValidate data-testid="contract-form" onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/60 p-5">
        <FileSignature className="mt-1 text-blue-600" size={22} />
        <div>
          {/* A new contract's page already carries its title. */}
          {editing && <h2 className="mb-1 text-lg font-semibold" style={{ color: A.label }}>{`${t("Edit contract")} ${contract!.number}`}</h2>}
          <p className="text-sm" style={{ color: A.sub }}>{t("Record a signed agreement. It is saved as a draft; activate it once the signed date and start date are in.")}</p>
          <p className="mt-2 text-xs" style={{ color: A.sub }}>* {t("Required fields")}</p>
        </div>
      </div>

      <Card className="p-5">
        <h3 className="fc-section-title" style={{ color: A.label }}>{t("Terms")}</h3>
        <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">
          <div className="md:col-span-2">
            {label("title", "Title", true)}
            <input {...control("title")} maxLength={200} onChange={(event) => set("title", event.target.value)} />
            {fieldError("title")}
          </div>
          <div>
            {label("externalReference", "Their reference")}
            <input {...control("externalReference")} maxLength={100} onChange={(event) => set("externalReference", event.target.value)} />
            {fieldError("externalReference")}
          </div>
          <div>
            {label("type", "Type", true)}
            <select {...control("type")} disabled={locked} onChange={(event) => set("type", event.target.value)}>
              <option value="">{t("Choose a type")}</option>
              {CONTRACT_TYPES.map((value) => <option key={value} value={value}>{t(TYPE_LABEL[value])}</option>)}
            </select>
            {fieldError("type")}
          </div>
          <div>
            {label("supplierId", "Supplier", true)}
            <select {...control("supplierId")} disabled={locked} onChange={(event) => set("supplierId", event.target.value)}>
              <option value="">{t("Choose a supplier")}</option>
              {supplierOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {suppliers === null && <p className="mt-1 text-xs text-amber-700">{t("Could not load suppliers.")}</p>}
            {locked && hint("An active contract keeps its supplier and type. Renew it to change them.")}
            {fieldError("supplierId")}
          </div>
          <div>
            {label("ownerId", "Owner")}
            <select {...control("ownerId")} onChange={(event) => set("ownerId", event.target.value)}>
              <option value="">{t(editing ? "No owner" : "The supplier's business owner")}</option>
              {ownerOptions.map((person) => <option key={person.id} value={person.id}>{person.name || person.id}</option>)}
            </select>
            {hint(owners === null ? "Could not load the workspace users. The owner defaults to the supplier's business owner." : "Gets the reminders on Today.")}
            {fieldError("ownerId")}
          </div>
          <div>
            {label("paymentTermsId", "Payment terms")}
            <select {...control("paymentTermsId")} onChange={(event) => set("paymentTermsId", event.target.value)}>
              <option value="">{t("Not recorded")}</option>
              {termOptions.map((option) => <option key={option.id} value={option.id}>{option.label === option.id ? option.id : `${option.label} (${option.id})`}</option>)}
            </select>
            {terms === null && <p className="mt-1 text-xs text-amber-700">{t("Could not load the workspace payment terms.")}</p>}
            {fieldError("paymentTermsId")}
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="fc-section-title" style={{ color: A.label }}>{t("Dates and renewal")}</h3>
        <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-3">
          <div>
            {label("startDate", "Start date")}
            <input {...control("startDate")} type="date" onChange={(event) => set("startDate", event.target.value)} />
            {fieldError("startDate")}
          </div>
          <div>
            {label("endDate", "End date")}
            <input {...control("endDate")} type="date" onChange={(event) => set("endDate", event.target.value)} />
            {hint("Leave empty for an open-ended contract.")}
            {fieldError("endDate")}
          </div>
          {editing && locked && (
            <div>
              {label("signedOn", "Signed on")}
              <input {...control("signedOn")} type="date" onChange={(event) => set("signedOn", event.target.value)} />
              {fieldError("signedOn")}
            </div>
          )}
          <div>
            {label("renewal", "Renewal")}
            <select {...control("renewal")} onChange={(event) => set("renewal", event.target.value)}>
              {CONTRACT_RENEWALS.map((value) => <option key={value} value={value}>{t(RENEWAL_LABEL[value])}</option>)}
            </select>
            {fieldError("renewal")}
          </div>
          {form.renewal === "automatic" && (
            <div>
              {label("noticeDays", "Notice period")}
              <input {...control("noticeDays")} type="number" min={0} max={CONTRACT_MAX_NOTICE_DAYS} step={1} onChange={(event) => set("noticeDays", event.target.value)} />
              {hint("Days before the end date by which notice must be given.")}
              {fieldError("noticeDays")}
            </div>
          )}
          <div>
            {label("reminderDays", "Remind me")}
            <input {...control("reminderDays")} type="number" min={0} max={CONTRACT_MAX_REMINDER_DAYS} step={1} onChange={(event) => set("reminderDays", event.target.value)} />
            {hint("Days before the key date that it shows on Today and Ending soon.")}
            {fieldError("reminderDays")}
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="fc-section-title" style={{ color: A.label }}>{t("Value")}</h3>
        {valueHidden ? (
          <p className="mt-3 text-sm" style={{ color: A.sub }}>{t("Hidden for your role")}</p>
        ) : (
          <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-3">
            <div>
              {label("currency", "Currency")}
              <select {...control("currency")} onChange={(event) => set("currency", event.target.value)}>
                <option value="">{t("Choose currency")}</option>
                {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
              {fieldError("currency")}
            </div>
            <div>
              {label("totalValue", "Total value")}
              <input {...control("totalValue")} inputMode="decimal" onChange={(event) => set("totalValue", event.target.value)} />
              {fieldError("totalValue")}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-5">
        {label("notes", "Notes")}
        <textarea {...control("notes")} rows={3} maxLength={4000} onChange={(event) => set("notes", event.target.value)} />
        {fieldError("notes")}
      </Card>

      {Boolean(error) && (
        <div role="alert" data-testid="contract-form-error" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{contractErrorText(error, t)}</span>
          {isVersionConflict(error) && onReload && <button type="button" className="fc-action-button fc-action-secondary fc-action-compact" onClick={onReload}>{t("Reload")}</button>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="fc-action-button fc-action-quiet" onClick={onCancel}>{t("Cancel")}</button>
        <button type="submit" data-testid="contract-save" className="fc-action-button fc-action-primary" disabled={saving}>{t(saving ? "Saving…" : editing ? "Save changes" : "Save draft")}</button>
      </div>
    </form>
  );
}
