import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card } from "../../components/ui";
import { listButtonClass } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";
import { SUPPLIER_TIER_DEFINITIONS } from "../../../shared/supplier-tiers.mjs";
import { supplierCopy } from "./supplierCopy";

// Supplier tiers and business owners (docs/supplier-tiers-design.md, T1). A
// tier is importance to the business, set by a person with a reason; the
// server keeps every change as an audit row, shown here as the history.
// FlowChain never suggests a tier: what makes a supplier Tier 1 differs per
// company (owner decision 2026-10-09). The tiers' meanings come from
// shared/supplier-tiers.mjs, which the assistant's tools read too. A person
// can record a review that keeps the tier, with a reason and the next review
// day (design audit L9-12).
export type Tier = 1 | 2 | 3 | null;
type Person = { id: string; name: string | null };
export type TierHistoryRow = {
  kind: "tier" | "review" | "owner";
  at: string;
  by: Person | null;
  fromTier?: Tier;
  toTier?: Tier;
  // A review: the tier it kept.
  tier?: Tier;
  reason?: string | null;
  nextReviewOn?: string | null;
  // Set on changes saved before system suggestions were removed.
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
  tierReviewedAt?: string | null;
  tierNextReviewOn?: string | null;
  businessOwner: Person | null;
  tierHistory?: TierHistoryRow[];
};
type FieldError = { field?: string; message?: string };

export const TIER_OPTIONS: Array<{ tier: Tier; label: string; meaning: string }> = [
  ...SUPPLIER_TIER_DEFINITIONS.map((definition) => ({ tier: definition.tier as Tier, label: `Tier ${definition.tier} · ${definition.name}`, meaning: definition.meaning })),
  { tier: null, label: "Not tiered", meaning: "Nobody has decided yet." },
];
// A calendar day such as a next review date, in the reader's locale.
const useCalendarDay = () => {
  const { locale } = useI18n();
  return (day: string | null | undefined) => (day ? new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(new Date(`${day.slice(0, 10)}T12:00:00Z`)) : "");
};
export const tierLabel = (tier: Tier) => TIER_OPTIONS.find((option) => option.tier === tier)?.label || "Not tiered";
export const shortTierLabel = (tier: Tier) => (tier ? `Tier ${tier}` : "Not tiered");

export function TierChip({ tier, short = false, testId = "supplier-tier-chip" }: { tier: Tier; short?: boolean; testId?: string }) {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const style = tier === 1
    ? { background: "#2563EB", color: "#FFFFFF", border: "1px solid #2563EB" }
    : tier === 2
      ? { background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" }
      : tier === 3
        ? { background: "#F1F5F9", color: "#334155", border: "1px solid #E2E8F0" }
        : { background: "transparent", color: "#64748B", border: "1px dashed #CBD5E1" };
  return <span data-testid={testId} data-tier={tier ?? "none"} className="fc-status-chip whitespace-nowrap" style={style}>
    {t(short ? shortTierLabel(tier) : tierLabel(tier))}
  </span>;
}

// Choosing a tier with a reason, saved through the tier PATCH endpoint with
// its audit row. Keeping the tier records a review instead, through the
// tier-review endpoint (design audit L9-12). Either can set the next review
// day. Used on the supplier's detail page and on Supplier evaluation.
export function TierForm({ supplier, onSaved, onCancel, className = "" }: { supplier: Pick<SupplierTierFields, "id" | "version" | "tier"> & { businessOwner?: Person | null; tierNextReviewOn?: string | null }; onSaved: () => void | Promise<void>; onCancel: () => void; className?: string }) {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const [tierChoice, setTierChoice] = useState<Tier>(supplier.tier);
  const [reason, setReason] = useState("");
  const [nextReviewOn, setNextReviewOn] = useState(supplier.tierNextReviewOn || "");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  // The tier kept: the save records a review.
  const reviewing = tierChoice === supplier.tier;
  const submit = async () => {
    if (saving) return;
    if (reason.trim().length < 3) { setErrors([{ field: "reason", message: "Enter a reason of 3 to 500 characters." }]); return; }
    setSaving(true);
    try {
      const id = encodeURIComponent(supplier.id);
      if (reviewing) await apiJson(`/api/master-data/suppliers/${id}/tier-review`, { method: "POST", body: JSON.stringify({ reason: reason.trim(), nextReviewOn: nextReviewOn || null, expectedVersion: supplier.version }) });
      else await apiJson(`/api/master-data/suppliers/${id}/tier`, { method: "PATCH", body: JSON.stringify({ tier: tierChoice, reason: reason.trim(), nextReviewOn: nextReviewOn || null, expectedVersion: supplier.version }) });
      toast.success(t(reviewing ? "Review recorded" : "Tier saved"));
      await onSaved();
    } catch (error) {
      setErrors(error instanceof ApiError && error.details.length ? error.details : [{ message: error instanceof Error ? error.message : "Could not save. Please try again." }]);
    } finally { setSaving(false); }
  };
  const fieldError = (field: string) => errors.find((error) => error.field === field)?.message;
  const generalErrors = errors.filter((error) => !error.field || !["tier", "reason", "nextReviewOn"].includes(error.field));
  const reasonId = `supplier-tier-reason-input-${supplier.id}`;
  const reviewDayId = `supplier-tier-next-review-${supplier.id}`;
  return <form noValidate data-testid="supplier-tier-form" className={`space-y-3 rounded-lg border p-4 ${className}`} onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <fieldset>
      <legend className="text-xs font-semibold">{t("Tier")}</legend>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {TIER_OPTIONS.map((option) => <label key={String(option.tier)} className="flex cursor-pointer gap-2 rounded border p-3 text-xs" style={{ borderColor: tierChoice === option.tier ? A.blue : A.border }}>
          <input type="radio" name={`supplier-tier-${supplier.id}`} checked={tierChoice === option.tier} onChange={() => setTierChoice(option.tier)} aria-label={t(option.label)} />
          <span><span className="font-semibold">{t(option.label)}</span><br /><span style={{ color: A.sub }}>{t(option.meaning)}</span></span>
        </label>)}
      </div>
      {fieldError("tier") && <p className="mt-1 text-xs text-red-600">{t(fieldError("tier") || "")}</p>}
      {reviewing && <p className="mt-2 text-xs" style={{ color: A.sub }} data-testid="supplier-tier-review-note">{t("Keeping this tier records a review, with your reason and the next review date.")}</p>}
      {tierChoice === 1 && supplier.businessOwner === null && <p className="mt-2 text-xs" style={{ color: A.orange }} data-testid="supplier-tier-owner-note">{t("Tier 1 needs a named owner. Set one under Business owner.")}</p>}
    </fieldset>
    <div>
      <label htmlFor={reasonId} className="text-xs font-semibold">{t("Reason")}<span className="ml-1 text-blue-600">*</span></label>
      <textarea id={reasonId} value={reason} maxLength={500} rows={3} onChange={(event) => { setReason(event.target.value); setErrors((current) => current.filter((error) => error.field !== "reason")); }}
        aria-invalid={!!fieldError("reason")} placeholder={t("Why this tier? For example: the only approved source of our best-selling item.")} className="mt-1 block w-full rounded border p-2 text-xs" />
      {fieldError("reason") && <p className="mt-1 text-xs text-red-600">{t(fieldError("reason") || "")}</p>}
    </div>
    <div>
      <label htmlFor={reviewDayId} className="text-xs font-semibold">{t("Next review on")}<span className="ml-1 font-normal" style={{ color: A.sub }}>{t("Optional")}</span></label>
      <input id={reviewDayId} type="date" data-testid="supplier-tier-next-review" value={nextReviewOn} onChange={(event) => { setNextReviewOn(event.target.value); setErrors((current) => current.filter((error) => error.field !== "nextReviewOn")); }}
        aria-invalid={!!fieldError("nextReviewOn")} className="mt-1 block rounded border p-2 text-xs" />
      {fieldError("nextReviewOn") && <p className="mt-1 text-xs text-red-600">{t(fieldError("nextReviewOn") || "")}</p>}
    </div>
    {generalErrors.map((error, index) => <p key={index} role="alert" className="text-xs text-red-600">{t(error.message || "Could not save. Please try again.")}</p>)}
    <div className="flex gap-2">
      <button type="button" onClick={onCancel} className={listButtonClass.secondary}>{t("Cancel")}</button>
      <button type="submit" disabled={saving} data-testid="supplier-tier-save" className={`${listButtonClass.primary} disabled:opacity-60`}>{t(saving ? "Saving…" : reviewing ? "Record review" : "Save tier")}</button>
    </div>
  </form>;
}

export function SupplierTierPanel({ supplier, canEdit, onChanged }: { supplier: SupplierTierFields; canEdit: boolean; onChanged: () => void | Promise<void> }) {
  const { language, formatDateTime } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const calendarDay = useCalendarDay();
  const [editing, setEditing] = useState<"tier" | "owner" | null>(null);
  const [owners, setOwners] = useState<Person[] | null>(null);
  const [ownerChoice, setOwnerChoice] = useState(supplier.businessOwner?.id || "");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const history = supplier.tierHistory || [];
  const person = (value: Person | null | undefined) => value?.name || t("Workspace setup");

  const openOwner = async () => {
    setErrors([]);
    setEditing("owner");
    setOwnerChoice(supplier.businessOwner?.id || "");
    try { setOwners((await apiJson<{ owners: Person[] }>("/api/master-data/supplier-owners")).owners); }
    catch { setOwners([]); setErrors([{ message: "Could not load workspace users." }]); }
  };
  const submitOwner = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await apiJson(`/api/master-data/suppliers/${encodeURIComponent(supplier.id)}/owner`, { method: "PATCH", body: JSON.stringify({ businessOwnerId: ownerChoice || null, expectedVersion: supplier.version }) });
      toast.success(t("Owner saved"));
      setEditing(null);
      await onChanged();
    } catch (error) {
      setErrors(error instanceof ApiError && error.details.length ? error.details : [{ message: error instanceof Error ? error.message : "Could not save. Please try again." }]);
    } finally { setSaving(false); }
  };
  const fieldError = (field: string) => errors.find((error) => error.field === field)?.message;
  const generalErrors = errors.filter((error) => !error.field || error.field !== "businessOwnerId");

  return <Card className="p-4 sm:p-5" data-testid="supplier-tier-panel">
    <div className="grid gap-5 md:grid-cols-2">
      <section className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Tier")}</h2>
          {canEdit && editing !== "tier" && <button type="button" data-testid="supplier-change-tier" onClick={() => setEditing("tier")} className={listButtonClass.secondary}>{t("Change tier")}</button>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><TierChip tier={supplier.tier} /></div>
        <p className="mt-2 text-xs leading-5" style={{ color: A.sub }}>{t(TIER_OPTIONS.find((option) => option.tier === supplier.tier)?.meaning || "")}</p>
        {supplier.tierReason && <p className="mt-2 text-xs leading-5"><span className="font-semibold">{t("Reason")}: </span><span data-testid="supplier-tier-reason">{supplier.tierReason}</span></p>}
        {supplier.tierSetAt && <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("Set by")} {person(supplier.tierSetBy)} · {formatDateTime(supplier.tierSetAt)}</p>}
        {supplier.tierReviewedAt && supplier.tierReviewedAt !== supplier.tierSetAt && <p className="mt-1 text-xs" style={{ color: A.sub }} data-testid="supplier-tier-reviewed">{t("Last reviewed")} {formatDateTime(supplier.tierReviewedAt)}</p>}
        {supplier.tierNextReviewOn && <p className="mt-1 text-xs" data-testid="supplier-tier-next-review-on">{t("Next review on")} {calendarDay(supplier.tierNextReviewOn)}</p>}
      </section>
      <section className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Business owner")}</h2>
          {canEdit && editing !== "owner" && <button type="button" data-testid="supplier-change-owner" onClick={openOwner} className={listButtonClass.secondary}>{t("Change owner")}</button>}
        </div>
        <p className="mt-2 text-sm" data-testid="supplier-owner">{supplier.businessOwner?.name || t("No owner")}</p>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("The person who manages this supplier relationship.")}</p>
      </section>
    </div>

    {editing === "tier" && <TierForm className="mt-5" supplier={supplier} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />}

    {editing === "owner" && <form noValidate data-testid="supplier-owner-form" className="mt-5 space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); submitOwner(); }}>
      <label htmlFor="supplier-owner-select" className="text-xs font-semibold">{t("Business owner")}</label>
      <select id="supplier-owner-select" value={ownerChoice} onChange={(event) => setOwnerChoice(event.target.value)} disabled={owners === null} className="block w-full rounded border p-2 text-xs">
        <option value="">{t("No owner")}</option>
        {(owners || []).map((owner) => <option key={owner.id} value={owner.id}>{owner.name || owner.id}</option>)}
      </select>
      {fieldError("businessOwnerId") && <p className="text-xs text-red-600">{t(fieldError("businessOwnerId") || "")}</p>}
      {generalErrors.map((error, index) => <p key={index} role="alert" className="text-xs text-red-600">{t(error.message || "Could not save. Please try again.")}</p>)}
      <div className="flex gap-2">
        <button type="button" onClick={() => setEditing(null)} className={listButtonClass.secondary}>{t("Cancel")}</button>
        <button type="submit" disabled={saving || owners === null} className={`${listButtonClass.primary} disabled:opacity-60`}>{t(saving ? "Saving…" : "Save owner")}</button>
      </div>
    </form>}

    {history.length > 0 && <section className="mt-5">
      <h3 className="text-[13px] font-semibold leading-5" style={{ color: A.label }}>{t("Tier and owner history")}</h3>
      <ol data-testid="supplier-tier-history" className="mt-2 space-y-2">
        {history.map((row, index) => <li key={index} className="border-l-2 pl-3 text-xs" style={{ borderColor: A.border }}>
          <div style={{ color: A.sub }}>{formatDateTime(row.at)} · {person(row.by)}</div>
          {row.kind === "tier"
            ? <div><span className="font-semibold">{t(shortTierLabel(row.fromTier ?? null))} → {t(shortTierLabel(row.toTier ?? null))}</span>{row.acceptedSuggestion ? ` · ${t("Suggestion accepted")}` : ""}{row.reason ? <span>: {row.reason}</span> : null}</div>
            : row.kind === "review"
              ? <div data-testid="supplier-tier-history-review"><span className="font-semibold">{t("Reviewed, kept {tier}").replace("{tier}", t(shortTierLabel(row.tier ?? null)))}</span>{row.reason ? <span>: {row.reason}</span> : null}</div>
              : <div><span className="font-semibold">{t("Business owner")}</span>: {row.fromOwner?.name || t("No owner")} → {row.toOwner?.name || t("No owner")}</div>}
          {row.kind !== "owner" && row.nextReviewOn ? <div style={{ color: A.sub }}>{t("Next review on")} {calendarDay(row.nextReviewOn)}</div> : null}
        </li>)}
      </ol>
    </section>}
  </Card>;
}
