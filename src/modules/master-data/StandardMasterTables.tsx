import { useState } from "react";
import { Copy, Eye } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { apiErrorText } from "../../lib/apiErrorText";
import { A, Chip, useConfirm } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import type { CustomerMaster, PrintTemplateCatalogItem } from "./standardData";
import { orNotProvided, paymentTermLabel, useMasterDataCopy } from "./masterDataCopy";
import { useMasterDataWriteAccess } from "./writeAccess";
import { RowMenu, RowPopover } from "../../components/ui/listLayout";
import { listTableCardsRef, tableBodyTextClass, tableMinSmClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, thClass } from "../../components/ui/workbenchTable";

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
  const { copy, language } = useMasterDataCopy();
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
      setError(apiErrorText(cause, language, ["Could not save the customer.", copy("Could not save the customer.")]));
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

// The list's search card holds Import and New customer; this table shows the
// form while a customer is being created.
export function CustomerTable({ customers, onChanged, creating = false, onCreatingDone }: { customers: CustomerMaster[]; onChanged?: () => void; creating?: boolean; onCreatingDone?: () => void }) {
  const { copy, language } = useMasterDataCopy();
  // Changing a customer's status needs master_data.customer.manage.
  const canEdit = useMasterDataWriteAccess().customers;
  const [error, setError] = useState("");
  const confirmDialog = useConfirm();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  // Changing a customer's status asks first, as it does for a supplier.
  const setStatus = async (item: CustomerMaster, active: boolean) => {
    const name = item.name || item.code;
    const confirmed = await confirmDialog.confirm({
      title: active ? say(`Set ${name} active?`, `启用 ${name}？`) : say(`Set ${name} inactive?`, `停用 ${name}？`),
      description: active
        ? say("It can be chosen for new sales orders again.", "启用后可以在新的销售订单中再次选择。")
        : say(
          "It can't be chosen for new sales orders. Orders that already use it don't change. You can set it active again later.",
          "停用后不能在新的销售订单中选择；已使用它的订单不变。之后可以重新启用。",
        ),
      confirmLabel: copy(active ? "Set active" : "Set inactive"),
      tone: active ? "primary" : "danger",
      testId: "customer-status-dialog",
    });
    if (!confirmed) return;
    setError("");
    try {
      await apiJson(`/api/master-data/customers/${encodeURIComponent(item.id || item.code)}/${active ? "activate" : "deactivate"}`, { method: "POST", body: JSON.stringify({ expectedVersion: item.version }) });
      onChanged?.();
    } catch (cause) {
      setError(apiErrorText(cause, language, ["Could not change the customer status.", copy("Could not change the customer status.")]));
    }
  };
  return (
    <div>
      {confirmDialog.element}
      {error ? <p role="alert" className="px-5 pt-3 text-xs" style={{ color: A.red }}>{error}</p> : null}
      {creating ? <NewCustomerForm onCancel={() => onCreatingDone?.()} onSaved={() => { onCreatingDone?.(); onChanged?.(); }} /> : null}
      {customers.length > 0 && (
        <div className={tableScrollClass} ref={listTableCardsRef}>
          <table className={tableMinSmClass}>
            <thead><tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
              {["Customer code", "Customer name", "Contact", "Phone", "Address", "Credit status", "Payment terms", "Status", "Actions"].map((item) => <th key={item} className={item === "Actions" ? `${thClass} sticky right-0 z-20 bg-white` : thClass} style={{ color: A.gray1 }}>{copy(item)}</th>)}
            </tr></thead>
            <tbody>{customers.map((item, index) => {
              const credit = creditStyle(item.creditStatus);
              const inactive = item.status === "停用";
              return (
                <tr key={item.code} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < customers.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                  <td className={tdIdClass}><BusinessEntityLink entityType="customer" entityId={item.code}>{item.code}</BusinessEntityLink></td>
                  <td className={`${tdNameClass} max-w-[200px] truncate font-medium`}><BusinessEntityLink entityType="customer" entityId={item.code}>{item.name}</BusinessEntityLink></td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.contact)}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.phone)}</td>
                  <td className="px-4 py-3 max-w-[160px] truncate" style={{ color: A.sub }} title={item.address || undefined}>{orNotProvided(item.address)}</td>
                  <td className={tdNowrapClass}>{item.creditStatus ? <Chip label={item.creditStatus} color={credit.color} bg={credit.bg} /> : orNotProvided(item.creditStatus)}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(paymentTermLabel(item.paymentTerms, language))}</td>
                  <td className={tdNowrapClass}><Chip label={item.status} color={inactive ? A.gray1 : A.green} bg={inactive ? A.gray6 : "#f0faf4"} /></td>
                  <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                    <div className="flex items-center gap-1.5">
                      <BusinessEntityLink entityType="customer" entityId={item.code} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">{copy("View")}</BusinessEntityLink>
                      {/* Changing the status sits in the row's menu, as on the purchase order list. */}
                      {canEdit && item.id ? (
                        <RowMenu label={say("More", "更多")} testId={`customer-row-more-${item.code}`}>
                          <button type="button" data-testid={`customer-status-${item.code}`} onClick={() => void setStatus(item, inactive)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy(inactive ? "Set active" : "Set inactive")}</button>
                        </RowMenu>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PrintTemplateTable({ templates, onCopy }: { templates: PrintTemplateCatalogItem[]; onCopy: (item: PrintTemplateCatalogItem) => void }) {
  const { copy, locale } = useMasterDataCopy();
  const updated = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : value; };
  return (
    // Phone rows become cards, as on the other master data lists.
    <div className={tableScrollClass} ref={listTableCardsRef}>
      <table className={`w-full min-w-[820px] text-left ${tableBodyTextClass}`}>
        <thead><tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
          {["Template name", "Document type", "Default", "Last updated", "Actions"].map((item) => <th key={item} className={thClass} style={{ color: A.gray1 }}>{copy(item)}</th>)}
        </tr></thead>
        <tbody>{templates.map((item, index) => {
          const name = item.copyOf ? copy("{name} (copy)", { name: copy(item.copyOf) }) : copy(item.name);
          return (
            <tr key={item.id} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < templates.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
              <td className={`${tdNameClass} font-medium`} style={{ color: A.label }}>{name}</td>
              <td className={tdNowrapClass} style={{ color: A.sub }}>{copy(item.documentType)}</td>
              <td className={tdNowrapClass}><Chip label={copy(item.isDefault ? "Default" : "Custom")} color={item.isDefault ? A.green : A.blue} bg={item.isDefault ? "#f0faf4" : "#f0f6ff"} /></td>
              <td className={tdNowrapClass} style={{ color: A.sub }}>{updated(item.updatedAt)}</td>
              <td className={tdNowrapClass}>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => onCopy(item)} className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium" style={{ color: A.label }}><Copy size={12} />{copy("Copy template")}</button>
                  <RowPopover summary={<><Eye size={12} />{copy("Preview")}</>} summaryClassName="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-900" panelClassName="w-64 p-3" testId={`print-template-preview-${item.id}`}><div className="font-semibold">{name}</div><div className="mt-2 text-slate-500">{copy("Document type: {value}", { value: copy(item.documentType) })}</div><div className="mt-1 text-slate-500">{copy("Updated: {value}", { value: updated(item.updatedAt) })}</div></RowPopover>
                </div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
