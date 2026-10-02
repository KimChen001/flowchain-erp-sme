import { useState } from "react";
import { Copy, Eye } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Chip } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import type { CustomerMaster, PrintTemplateCatalogItem } from "./standardData";
import { orNotProvided, useMasterDataCopy } from "./masterDataCopy";

function creditStyle(status: string) {
  if (status === "正常") return { color: A.green, bg: "#f0faf4" };
  if (status === "受限") return { color: A.red, bg: "#fff1f0" };
  return { color: A.orange, bg: "#fff8f0" };
}

const EMPTY_CUSTOMER = { code: "", name: "", currency: "", contact: "", email: "", phone: "", address: "", paymentTerms: "" };
type CustomerField = keyof typeof EMPTY_CUSTOMER;
const CUSTOMER_FIELDS: Array<{ key: CustomerField; label: string; required?: boolean }> = [
  { key: "code", label: "Customer code", required: true },
  { key: "name", label: "Customer name", required: true },
  { key: "currency", label: "Currency" },
  { key: "contact", label: "Contact" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Address" },
  { key: "paymentTerms", label: "Payment terms" },
];

// The customer form writes through /api/master-data/customers; the server
// checks the fields and answers each problem by field.
function NewCustomerForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { copy } = useMasterDataCopy();
  const [form, setForm] = useState(EMPTY_CUSTOMER);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const save = async () => {
    setSaving(true);
    setError("");
    setFieldErrors({});
    try {
      await apiJson("/api/master-data/customers", { method: "POST", body: JSON.stringify(form) });
      onSaved();
    } catch (cause) {
      const details = cause instanceof ApiError ? cause.details : [];
      setFieldErrors(Object.fromEntries(details.map((item) => [String(item.field || ""), String(item.message || "")])));
      setError(cause instanceof Error ? cause.message : copy("Could not save the customer."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-testid="customer-form" className="space-y-3 border-b px-4 py-4" style={{ borderColor: A.border }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {CUSTOMER_FIELDS.map((field) => (
          <label key={field.key} className="grid gap-1 text-xs">
            <span style={{ color: A.gray1 }}>{copy(field.label)}{field.required ? " *" : ""}</span>
            <input
              aria-label={copy(field.label)}
              data-testid={`customer-field-${field.key}`}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: fieldErrors[field.key] ? A.red : A.border }}
              value={form[field.key]}
              onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
            />
            {fieldErrors[field.key] ? <span style={{ color: A.red }}>{fieldErrors[field.key]}</span> : null}
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="text-xs" style={{ color: A.red }}>{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" data-testid="customer-save" disabled={saving} onClick={() => void save()} className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-60">{saving ? copy("Saving…") : copy("Save customer")}</button>
        <button type="button" onClick={onCancel} className="rounded-md bg-slate-100 px-3 py-2 text-xs">{copy("Cancel")}</button>
      </div>
    </div>
  );
}

export function CustomerTable({ customers, onChanged }: { customers: CustomerMaster[]; onChanged?: () => void }) {
  const { copy } = useMasterDataCopy();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const setStatus = async (item: CustomerMaster, active: boolean) => {
    setError("");
    try {
      await apiJson(`/api/master-data/customers/${encodeURIComponent(item.id || item.code)}/${active ? "activate" : "deactivate"}`, { method: "POST", body: JSON.stringify({ expectedVersion: item.version }) });
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy("Could not change the customer status."));
    }
  };
  const toolbar = (
    <div className="flex items-center justify-end gap-2 px-4 py-3">
      {error ? <p role="alert" className="mr-auto text-xs" style={{ color: A.red }}>{error}</p> : null}
      {!creating ? <button type="button" data-testid="customer-new" onClick={() => setCreating(true)} className="rounded-md bg-blue-600 px-3 py-2 text-xs text-white">{copy("New customer")}</button> : null}
    </div>
  );
  const form = creating ? <NewCustomerForm onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); onChanged?.(); }} /> : null;
  if (customers.length === 0) return <div>{toolbar}{form}{creating ? null : <div className="px-6 py-12 text-center text-sm text-slate-500">{copy("No customers yet. Create or import customers to continue.")}</div>}</div>;
  return <div>{toolbar}{form}<div className="overflow-x-auto"><table className="w-full min-w-[980px] text-xs"><thead><tr>{["Customer code", "Customer name", "Contact", "Phone", "Address", "Credit status", "Payment terms", "Status", "Actions"].map((item) => <th key={item} className="px-4 py-3 text-left" style={{ color: A.gray1 }}>{copy(item)}</th>)}</tr></thead><tbody>{customers.map((item) => {
    const credit = creditStyle(item.creditStatus);
    const inactive = item.status === "停用";
    return <tr key={item.code} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-4 py-3 font-semibold"><BusinessEntityLink entityType="customer" entityId={item.code}>{item.code}</BusinessEntityLink></td><td className="px-4 py-3 font-medium"><BusinessEntityLink entityType="customer" entityId={item.code}>{item.name}</BusinessEntityLink></td><td className="px-4 py-3">{orNotProvided(item.contact)}</td><td className="px-4 py-3">{orNotProvided(item.phone)}</td><td className="px-4 py-3 max-w-[260px] truncate">{orNotProvided(item.address)}</td><td className="px-4 py-3">{item.creditStatus ? <Chip label={item.creditStatus} color={credit.color} bg={credit.bg} /> : orNotProvided(item.creditStatus)}</td><td className="px-4 py-3">{orNotProvided(item.paymentTerms)}</td><td className="px-4 py-3"><Chip label={item.status} color={inactive ? A.red : A.green} bg={inactive ? "#fff1f0" : "#f0faf4"} /></td><td className="px-4 py-3"><div className="flex gap-2"><BusinessEntityLink entityType="customer" entityId={item.code} className="rounded-md bg-slate-100 px-2.5 py-1.5">{copy("View details")}</BusinessEntityLink>{item.id ? <button type="button" data-testid={`customer-status-${item.code}`} onClick={() => void setStatus(item, inactive)} className="rounded-md bg-slate-100 px-2.5 py-1.5">{copy(inactive ? "Set active" : "Set inactive")}</button> : null}</div></td></tr>;
  })}</tbody></table></div></div>;
}

export function PrintTemplateTable({ templates, onCopy }: { templates: PrintTemplateCatalogItem[]; onCopy: (item: PrintTemplateCatalogItem) => void }) {
  const { copy, locale } = useMasterDataCopy();
  const updated = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : value; };
  return <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-xs"><thead><tr>{["Template name", "Document type", "Default", "Last updated", "Actions"].map((item) => <th key={item} className="px-4 py-3 text-left" style={{ color: A.gray1 }}>{copy(item)}</th>)}</tr></thead><tbody>{templates.map((item) => {
    const name = item.copyOf ? copy("{name} (copy)", { name: copy(item.copyOf) }) : copy(item.name);
    return <tr key={item.id} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-4 py-3 font-semibold" style={{ color: A.label }}>{name}</td><td className="px-4 py-3">{copy(item.documentType)}</td><td className="px-4 py-3"><Chip label={copy(item.isDefault ? "Default" : "Custom")} color={item.isDefault ? A.green : A.blue} bg={item.isDefault ? "#f0faf4" : "#f0f6ff"} /></td><td className="px-4 py-3">{updated(item.updatedAt)}</td><td className="px-4 py-3"><div className="flex gap-2"><button onClick={() => onCopy(item)} className="px-2.5 py-1.5 rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.label }}><Copy size={12} />{copy("Copy template")}</button><details className="relative"><summary className="list-none cursor-pointer px-2.5 py-1.5 rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.label }}><Eye size={12} />{copy("Preview")}</summary><div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border bg-white p-3 shadow-lg"><div className="font-semibold">{name}</div><div className="mt-2 text-slate-500">{copy("Document type: {value}", { value: copy(item.documentType) })}</div><div className="mt-1 text-slate-500">{copy("Updated: {value}", { value: updated(item.updatedAt) })}</div></div></details></div></td></tr>;
  })}</tbody></table></div>;
}
