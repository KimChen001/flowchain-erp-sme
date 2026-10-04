import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { supplierCopy } from "./supplierCopy";

// Supplier tiers and business owners (docs/supplier-tiers-design.md, T1). A
// tier is importance to the business, set by a person with a reason; the
// server keeps every change as an audit row, shown here as the history.
export type Tier = 1 | 2 | 3 | null;
type Person = { id: string; name: string | null };
export type TierHistoryRow = {
  kind: "tier" | "owner";
  at: string;
  by: Person | null;
  fromTier?: Tier;
  toTier?: Tier;
  reason?: string | null;
  acceptedSuggestion?: boolean;
  fromOwner?: Person | null;
  toOwner?: Person | null;
};
export type SupplierTierFields = {
  id: string;
  version: number;
  tier: Tier;
  tierReason: string | null;
  tierSetAt: string | null;
  tierSetBy: Person | null;
  businessOwner: Person | null;
  tierHistory?: TierHistoryRow[];
};

export const TIER_OPTIONS: Array<{ tier: Tier; label: string; meaning: string }> = [
  { tier: 1, label: "Tier 1 Strategic", meaning: "Losing this supplier would stop sales or operations soon. Needs a named owner and regular review." },
  { tier: 2, label: "Tier 2 Core", meaning: "A regular, approved source, with alternatives or limited impact." },
  { tier: 3, label: "Tier 3 Transactional", meaning: "Occasional or low-impact purchases." },
  { tier: null, label: "Not tiered", meaning: "Nobody has decided yet." },
];
export const tierLabel = (tier: Tier) => TIER_OPTIONS.find((option) => option.tier === tier)?.label || "Not tiered";
const shortTier = (tier: Tier) => (tier ? `Tier ${tier}` : "Not tiered");

export function TierChip({ tier, short = false }: { tier: Tier; short?: boolean }) {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const style = tier === 1
    ? { background: "#2563EB", color: "#FFFFFF", border: "1px solid #2563EB" }
    : tier === 2
      ? { background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" }
      : tier === 3
        ? { background: "#F1F5F9", color: "#334155", border: "1px solid #E2E8F0" }
        : { background: "transparent", color: "#64748B", border: "1px dashed #CBD5E1" };
  return <span data-testid="supplier-tier-chip" data-tier={tier ?? "none"} className="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={style}>
    {t(short ? shortTier(tier) : tierLabel(tier))}
  </span>;
}

export function SupplierTierPanel({ supplier, canEdit, onChanged }: { supplier: SupplierTierFields; canEdit: boolean; onChanged: () => void | Promise<void> }) {
  const { language, formatDateTime } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const [editing, setEditing] = useState<"tier" | "owner" | null>(null);
  const [tierChoice, setTierChoice] = useState<Tier>(supplier.tier);
  const [reason, setReason] = useState("");
  const [owners, setOwners] = useState<Person[] | null>(null);
  const [ownerChoice, setOwnerChoice] = useState(supplier.businessOwner?.id || "");
  const [errors, setErrors] = useState<Array<{ field?: string; message?: string }>>([]);
  const [saving, setSaving] = useState(false);
  const history = supplier.tierHistory || [];
  const person = (value: Person | null | undefined) => value?.name || t("Workspace setup");

  const open = async (what: "tier" | "owner") => {
    setErrors([]);
    setEditing(what);
    if (what === "tier") { setTierChoice(supplier.tier); setReason(""); }
    if (what === "owner") {
      setOwnerChoice(supplier.businessOwner?.id || "");
      try { setOwners((await apiJson<{ owners: Person[] }>("/api/master-data/supplier-owners")).owners); }
      catch { setOwners([]); setErrors([{ message: "Could not load workspace users." }]); }
    }
  };
  const submit = async () => {
    if (saving) return;
    if (editing === "tier" && reason.trim().length < 3) { setErrors([{ field: "reason", message: "Enter a reason of 3 to 500 characters." }]); return; }
    setSaving(true);
    try {
      const body = editing === "tier"
        ? { tier: tierChoice, reason: reason.trim(), expectedVersion: supplier.version }
        : { businessOwnerId: ownerChoice || null, expectedVersion: supplier.version };
      await apiJson(`/api/master-data/suppliers/${encodeURIComponent(supplier.id)}/${editing}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(t(editing === "tier" ? "Tier saved" : "Owner saved"));
      setEditing(null);
      await onChanged();
    } catch (error) {
      setErrors(error instanceof ApiError && error.details.length ? error.details : [{ message: error instanceof Error ? error.message : "Could not save. Please try again." }]);
    } finally { setSaving(false); }
  };
  const fieldError = (field: string) => errors.find((error) => error.field === field)?.message;
  const generalErrors = errors.filter((error) => !error.field || !["tier", "reason", "businessOwnerId"].includes(error.field));

  return <Card className="p-5" data-testid="supplier-tier-panel">
    <div className="grid gap-5 md:grid-cols-2">
      <section className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("Tier")}</h2>
          {canEdit && editing !== "tier" && <button type="button" data-testid="supplier-change-tier" onClick={() => open("tier")} className="rounded border px-3 py-1 text-xs">{t("Change tier")}</button>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><TierChip tier={supplier.tier} /></div>
        <p className="mt-2 text-xs leading-5" style={{ color: A.sub }}>{t(TIER_OPTIONS.find((option) => option.tier === supplier.tier)?.meaning || "")}</p>
        {supplier.tierReason && <p className="mt-2 text-xs leading-5"><span className="font-semibold">{t("Reason")}: </span><span data-testid="supplier-tier-reason">{supplier.tierReason}</span></p>}
        {supplier.tierSetAt && <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("Set by")} {person(supplier.tierSetBy)} · {formatDateTime(supplier.tierSetAt)}</p>}
      </section>
      <section className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("Business owner")}</h2>
          {canEdit && editing !== "owner" && <button type="button" data-testid="supplier-change-owner" onClick={() => open("owner")} className="rounded border px-3 py-1 text-xs">{t("Change owner")}</button>}
        </div>
        <p className="mt-2 text-sm" data-testid="supplier-owner">{supplier.businessOwner?.name || t("No owner")}</p>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("The person who manages this supplier relationship.")}</p>
      </section>
    </div>

    {editing === "tier" && <form noValidate data-testid="supplier-tier-form" className="mt-5 space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset>
        <legend className="text-xs font-semibold">{t("Tier")}</legend>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {TIER_OPTIONS.map((option) => <label key={String(option.tier)} className="flex cursor-pointer gap-2 rounded border p-3 text-xs" style={{ borderColor: tierChoice === option.tier ? A.blue : A.border }}>
            <input type="radio" name="supplier-tier" checked={tierChoice === option.tier} onChange={() => setTierChoice(option.tier)} aria-label={t(option.label)} />
            <span><span className="font-semibold">{t(option.label)}</span><br /><span style={{ color: A.sub }}>{t(option.meaning)}</span></span>
          </label>)}
        </div>
        {fieldError("tier") && <p className="mt-1 text-xs text-red-600">{t(fieldError("tier") || "")}</p>}
      </fieldset>
      <div>
        <label htmlFor="supplier-tier-reason-input" className="text-xs font-semibold">{t("Reason")}<span className="ml-1 text-blue-600">*</span></label>
        <textarea id="supplier-tier-reason-input" value={reason} maxLength={500} rows={3} onChange={(event) => { setReason(event.target.value); setErrors((current) => current.filter((error) => error.field !== "reason")); }}
          aria-invalid={!!fieldError("reason")} placeholder={t("Why this tier? For example: the only approved source of our best-selling item.")} className="mt-1 block w-full rounded border p-2 text-xs" />
        {fieldError("reason") && <p className="mt-1 text-xs text-red-600">{t(fieldError("reason") || "")}</p>}
      </div>
      {generalErrors.map((error, index) => <p key={index} role="alert" className="text-xs text-red-600">{t(error.message || "Could not save. Please try again.")}</p>)}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">{t(saving ? "Saving…" : "Save tier")}</button>
        <button type="button" onClick={() => setEditing(null)} className="rounded border px-3 py-1.5 text-xs">{t("Cancel")}</button>
      </div>
    </form>}

    {editing === "owner" && <form noValidate data-testid="supplier-owner-form" className="mt-5 space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <label htmlFor="supplier-owner-select" className="text-xs font-semibold">{t("Business owner")}</label>
      <select id="supplier-owner-select" value={ownerChoice} onChange={(event) => setOwnerChoice(event.target.value)} disabled={owners === null} className="block w-full rounded border p-2 text-xs">
        <option value="">{t("No owner")}</option>
        {(owners || []).map((owner) => <option key={owner.id} value={owner.id}>{owner.name || owner.id}</option>)}
      </select>
      {fieldError("businessOwnerId") && <p className="text-xs text-red-600">{t(fieldError("businessOwnerId") || "")}</p>}
      {generalErrors.map((error, index) => <p key={index} role="alert" className="text-xs text-red-600">{t(error.message || "Could not save. Please try again.")}</p>)}
      <div className="flex gap-2">
        <button type="submit" disabled={saving || owners === null} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">{t(saving ? "Saving…" : "Save owner")}</button>
        <button type="button" onClick={() => setEditing(null)} className="rounded border px-3 py-1.5 text-xs">{t("Cancel")}</button>
      </div>
    </form>}

    {history.length > 0 && <section className="mt-5">
      <h3 className="text-xs font-semibold">{t("Tier and owner history")}</h3>
      <ol data-testid="supplier-tier-history" className="mt-2 space-y-2">
        {history.map((row, index) => <li key={index} className="border-l-2 pl-3 text-xs" style={{ borderColor: A.border }}>
          <div style={{ color: A.sub }}>{formatDateTime(row.at)} · {person(row.by)}</div>
          {row.kind === "tier"
            ? <div><span className="font-semibold">{t(shortTier(row.fromTier ?? null))} → {t(shortTier(row.toTier ?? null))}</span>{row.acceptedSuggestion ? ` · ${t("Suggestion accepted")}` : ""}{row.reason ? <span>: {row.reason}</span> : null}</div>
            : <div><span className="font-semibold">{t("Business owner")}</span>: {row.fromOwner?.name || t("No owner")} → {row.toOwner?.name || t("No owner")}</div>}
        </li>)}
      </ol>
    </section>}
  </Card>;
}
