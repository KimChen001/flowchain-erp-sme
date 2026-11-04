import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { A } from "../../../../components/ui";
import { isTranslationKey, type TranslationKey } from "../../../../i18n/I18n";
import { ApiError, apiJson } from "../../../../lib/api-client";
import { RefChip, cardStyle, toneStyle, usePartCopy, type Navigate, type PartCopy } from "./partKit";
import type { PartRef, SetupFormProps, SetupItemRow, SetupReceipt, SetupRowResult, SetupSupplierRow, SetupValueSource } from "./types";

// The in-chat setup card (suggest_setup_records): the suppliers and items the
// user typed or pasted, every value editable, with where it came from and
// what the server found wrong. One click on Create makes the suppliers, then
// the items, each with its link to its preferred supplier (price, lead time),
// through the same routes as the Suppliers and Items pages, with the user's
// own session. Each row then shows its record, or its error so it can be
// fixed and tried again. Nothing is saved before the click.

export type SupplierDraft = { key: string; include: boolean; name: string; code: string; contact: string; email: string; phone: string; paymentTerms: string };
// supplier: "row:<key>" a supplier of this card, "id:<id>" an existing one,
// "none" no preferred supplier, "" one the user named that is not known yet.
export type ItemDraft = {
  key: string; include: boolean; sku: string; name: string; unit: string; category: string;
  safetyStock: string; reorderPoint: string; supplier: string; referencePrice: string; currency: string; leadTimeDays: string;
};
export type SetupIssue = { field: string; code: string; blocking: boolean; ref?: PartRef; typed?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fold = (value: string | null | undefined) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const numberText = (value: number | null) => (value === null ? "" : String(value));
const created = (result: SetupRowResult | undefined): result is Extract<SetupRowResult, { status: "created" }> => result?.status === "created";

export function supplierCodeAt(seed: SetupFormProps["codeSeed"], index: number) {
  return `${seed.prefix}${String(seed.next + index).padStart(seed.width, "0")}`;
}

// The card as it first shows: the user's values, a made-up code for a
// supplier without one, and every row ticked when the role may create it.
export function initialSetupDrafts(props: SetupFormProps): { suppliers: SupplierDraft[]; items: ItemDraft[] } {
  let generated = 0;
  const suppliers = props.suppliers.map((row) => ({
    key: row.key,
    include: props.canCreateSuppliers,
    name: row.name.value || "",
    code: row.code.value || supplierCodeAt(props.codeSeed, generated++),
    contact: row.contact.value || "",
    email: row.email.value || "",
    phone: row.phone.value || "",
    paymentTerms: row.paymentTerms.value || "",
  }));
  const items = props.items.map((row) => {
    const preferred = row.preferredSupplier;
    return {
      key: row.key,
      include: props.canCreateItems,
      sku: row.sku.value || "",
      name: row.name.value || "",
      unit: row.unit.value || "",
      category: row.category.value || "",
      safetyStock: numberText(row.safetyStock.value),
      reorderPoint: numberText(row.reorderPoint.value),
      supplier: preferred.rowKey ? `row:${preferred.rowKey}` : preferred.supplierId ? `id:${preferred.supplierId}` : preferred.typed ? "" : "none",
      referencePrice: numberText(row.referencePrice.value),
      currency: row.currency.source === "user_typed" ? row.currency.value || "" : "",
      leadTimeDays: numberText(row.leadTimeDays.value),
    };
  });
  return { suppliers, items };
}

// A server problem holds while its field keeps the value the server checked;
// the rest is checked here again on every edit.
export function supplierIssues(draft: SupplierDraft, row: SetupSupplierRow, drafts: SupplierDraft[]): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (field: string, code: string, blocking = true, ref?: PartRef, typed?: string) => issues.push({ field, code, blocking, ...(ref ? { ref } : {}), ...(typed ? { typed } : {}) });
  for (const problem of row.problems) {
    if (problem.code === "duplicate_existing" && problem.field === "name" && fold(draft.name) === fold(row.name.value)) add("name", problem.code, problem.blocking, problem.ref);
    if (problem.code === "duplicate_existing" && problem.field === "code" && fold(draft.code) === fold(row.code.value)) add("code", problem.code, problem.blocking, problem.ref);
    if (problem.code === "payment_terms_unknown" && !draft.paymentTerms) add("payment_terms", problem.code, problem.blocking, undefined, row.paymentTerms.typed || "");
  }
  const earlier = drafts.slice(0, drafts.findIndex((other) => other.key === draft.key)).filter((other) => other.include);
  if (!draft.name.trim()) add("name", "required");
  else if (earlier.some((other) => fold(other.name) === fold(draft.name))) add("name", "duplicate_in_card");
  if (!draft.code.trim()) add("code", "required");
  else if (draft.code.trim().length > 64) add("code", "invalid");
  else if (earlier.some((other) => fold(other.code) === fold(draft.code))) add("code", "duplicate_in_card");
  if (draft.email.trim() && !EMAIL.test(draft.email.trim())) add("email", "email_invalid");
  return issues;
}

const NUMBER_FIELDS: Array<[keyof ItemDraft, string]> = [["safetyStock", "safety_stock"], ["reorderPoint", "reorder_point"], ["referencePrice", "reference_price"], ["leadTimeDays", "lead_time_days"]];

export function itemIssues(draft: ItemDraft, row: SetupItemRow, drafts: ItemDraft[], suppliers: SupplierDraft[]): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (field: string, code: string, blocking = true, ref?: PartRef, typed?: string) => issues.push({ field, code, blocking, ...(ref ? { ref } : {}), ...(typed ? { typed } : {}) });
  for (const problem of row.problems) {
    if (problem.code === "duplicate_existing" && problem.field === "sku" && fold(draft.sku) === fold(row.sku.value)) add("sku", problem.code, problem.blocking, problem.ref);
    if (problem.code === "duplicate_existing" && problem.field === "name" && fold(draft.name) === fold(row.name.value)) add("name", problem.code, problem.blocking, problem.ref);
    if ((problem.code === "supplier_unknown" || problem.code === "supplier_inactive") && draft.supplier === "") add("preferred_supplier", problem.code, true, problem.ref, row.preferredSupplier.typed || "");
  }
  const earlier = drafts.slice(0, drafts.findIndex((other) => other.key === draft.key)).filter((other) => other.include);
  const sku = draft.sku.trim();
  if (!sku) add("sku", "required");
  else if (sku.length > 64 || /\s/.test(sku)) add("sku", "invalid");
  else if (earlier.some((other) => fold(other.sku) === fold(sku))) add("sku", "duplicate_in_card");
  if (!draft.name.trim()) add("name", "required");
  else if (earlier.some((other) => fold(other.name) === fold(draft.name))) add("name", "duplicate_in_card", false);
  if (!draft.unit.trim()) add("unit", "required");
  for (const [field, code] of NUMBER_FIELDS) {
    const raw = String(draft[field]).trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) add(code, "invalid");
    else if (value < 0) add(code, "negative");
    else if (field === "leadTimeDays" && !Number.isInteger(value)) add(code, "whole_number");
  }
  if (draft.supplier === "" && !issues.some((issue) => issue.field === "preferred_supplier")) add("preferred_supplier", "supplier_unknown", true, undefined, row.preferredSupplier.typed || "");
  if (draft.supplier.startsWith("row:") && !suppliers.some((other) => `row:${other.key}` === draft.supplier && other.include)) add("preferred_supplier", "supplier_excluded");
  if (draft.supplier === "none" && (draft.referencePrice.trim() || draft.leadTimeDays.trim())) add(draft.referencePrice.trim() ? "reference_price" : "lead_time_days", "needs_supplier");
  if (draft.currency.trim() && !/^[A-Za-z]{3}$/.test(draft.currency.trim())) add("currency", "currency_invalid");
  return issues;
}

// The currency of an item's price: the one the user gave, else its
// supplier's, else the workspace's (a new supplier gets the workspace's).
export function itemCurrency(draft: ItemDraft, props: SetupFormProps) {
  const typed = draft.currency.trim().toUpperCase();
  if (typed) return typed;
  const existing = draft.supplier.startsWith("id:") ? props.supplierOptions.find((option) => `id:${option.id}` === draft.supplier) : null;
  return existing?.currency || props.workspaceCurrency;
}

// What Create posts, in the shapes the Suppliers and Items pages post.
export function supplierBody(draft: SupplierDraft) {
  return {
    supplierCode: draft.code.trim(),
    supplierName: draft.name.trim(),
    status: "active",
    contactName: draft.contact.trim(),
    telephone: draft.phone.trim(),
    email: draft.email.trim(),
    ...(draft.paymentTerms ? { paymentTermsId: draft.paymentTerms } : {}),
  };
}

export function itemBody(draft: ItemDraft) {
  const unit = draft.unit.trim();
  return {
    sku: draft.sku.trim(),
    itemName: draft.name.trim(),
    baseUnit: unit,
    purchaseUnit: unit,
    category: draft.category.trim(),
    itemType: "material",
    status: "active",
    purchasable: true,
    inventoryItem: true,
    ...(draft.safetyStock.trim() ? { safetyStock: Number(draft.safetyStock) } : {}),
    ...(draft.reorderPoint.trim() ? { reorderPoint: Number(draft.reorderPoint) } : {}),
  };
}

// The item's link to its preferred supplier, as the supplier page adds one:
// a blank price or lead time is not recorded, never 0.
export function itemSupplierBody(draft: ItemDraft, supplierId: string, currency: string) {
  return {
    supplierId,
    preferred: true,
    approved: true,
    active: true,
    leadTimeDays: draft.leadTimeDays.trim() ? Number(draft.leadTimeDays) : null,
    referencePrice: draft.referencePrice.trim() ? Number(draft.referencePrice) : null,
    currency,
  };
}

// An item still to link: created, with a supplier, and no link yet.
export function itemLinkPending(draft: ItemDraft, results: Record<string, SetupRowResult>) {
  const result = results[draft.key];
  return created(result) && !result.linked && draft.supplier !== "none" && draft.supplier !== "";
}

// The ticked rows Create still has to do: not created yet, or an item whose
// supplier link failed.
export function pendingSetupRows(drafts: { suppliers: SupplierDraft[]; items: ItemDraft[] }, results: Record<string, SetupRowResult>) {
  return {
    suppliers: drafts.suppliers.filter((draft) => draft.include && !created(results[draft.key])),
    items: drafts.items.filter((draft) => draft.include && (!created(results[draft.key]) || itemLinkPending(draft, results))),
  };
}

type Post = (url: string, body: unknown) => Promise<unknown>;

// One click on Create: the suppliers first, so an item can be linked to one
// made in this card, then each item and its link to its preferred supplier.
// A row that fails keeps its error and the others go on; a retry does only
// what is still to do. Returns every row's result.
export async function createSetupRecords({ drafts, results, props, post, errorText, supplierNotCreated }: {
  drafts: { suppliers: SupplierDraft[]; items: ItemDraft[] };
  results: Record<string, SetupRowResult>;
  props: SetupFormProps;
  post: Post;
  errorText: (failure: unknown) => string;
  supplierNotCreated: string;
}) {
  const next: Record<string, SetupRowResult> = { ...results };
  const pending = pendingSetupRows(drafts, results);
  for (const draft of pending.suppliers) {
    try {
      const { supplier } = await post("/api/master-data/suppliers", supplierBody(draft)) as { supplier: { id: string; supplierName?: string; name?: string } };
      next[draft.key] = { status: "created", type: "supplier", id: supplier.id, label: supplier.supplierName || supplier.name || draft.name.trim() };
    } catch (failure) {
      next[draft.key] = { status: "failed", error: errorText(failure) };
    }
  }
  for (const draft of pending.items) {
    const rowKey = draft.supplier.startsWith("row:") ? draft.supplier.slice(4) : "";
    const cardSupplier = rowKey ? next[rowKey] : undefined;
    const supplierId = draft.supplier.startsWith("id:") ? draft.supplier.slice(3) : created(cardSupplier) ? cardSupplier.id : "";
    if (rowKey && !supplierId) {
      if (!created(next[draft.key])) next[draft.key] = { status: "failed", error: supplierNotCreated };
      continue;
    }
    let current = next[draft.key];
    if (!created(current)) {
      try {
        const { item } = await post("/api/master-data/items", itemBody(draft)) as { item: { id?: string; itemId?: string; sku?: string } };
        current = { status: "created", type: "item", id: String(item.itemId || item.id), label: item.sku || draft.sku.trim(), linked: !supplierId };
        next[draft.key] = current;
      } catch (failure) {
        next[draft.key] = { status: "failed", error: errorText(failure) };
        continue;
      }
    }
    if (supplierId && created(current) && !current.linked) {
      try {
        await post(`/api/master-data/items/${encodeURIComponent(current.id)}/suppliers`, itemSupplierBody(draft, supplierId, itemCurrency(draft, props)));
        next[draft.key] = { ...current, linked: true, linkError: undefined };
      } catch (failure) {
        next[draft.key] = { ...current, linked: false, linkError: errorText(failure) };
      }
    }
  }
  return next;
}

// The records a card created, for the next question's form results.
export function setupCreatedRecords(receipt: SetupReceipt | null | undefined) {
  return Object.values(receipt?.results || {}).flatMap((result) => (created(result) ? [{ type: result.type, id: result.id }] : []));
}

function setupErrorText(error: unknown, copy: PartCopy) {
  // Server messages are not shown: codes are worded here, a field's first.
  if (error instanceof ApiError) {
    const detail = error.details.map((entry) => String(entry?.code || "")).find((code) => code && isTranslationKey(`ai.v2.setup.error.${code}`));
    const key = [detail ? `ai.v2.setup.error.${detail}` : "", `ai.v2.setup.error.${error.code || ""}`, error.code ? `ai.v2.error.${error.code}` : ""].find((entry) => entry && isTranslationKey(entry));
    if (key) return copy.t(key as TranslationKey);
  }
  return copy.t("ai.v2.setup.error.generic");
}

function issueText(issue: SetupIssue, copy: PartCopy) {
  if (issue.code === "duplicate_existing") return copy.t(issue.blocking ? "ai.v2.setup.problem.duplicate_existing" : "ai.v2.setup.problem.same_name");
  const key = `ai.v2.setup.problem.${issue.code}`;
  return isTranslationKey(key) ? copy.t(key, { typed: issue.typed || "" }) : copy.t("ai.v2.setup.problem.invalid");
}

const ORANGE = toneStyle("warning");
const RED = toneStyle("danger");
const TEAL_TEXT = "#0F766E";
const inputClass = "w-full rounded-lg px-2 py-1.5 text-[13px]";
const inputStyle = { border: `1px solid ${A.gray4}`, background: A.white, color: A.label };
const chipStyle = { background: "#F0FDFA", color: TEAL_TEXT };
const SourceChip = ({ children }: { children: ReactNode }) => <span data-testid="ai-v2-setup-source" className="inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4" style={chipStyle}>{children}</span>;

export function SetupRecordsPart({ props, partId, language, onNavigate, receipt: initialReceipt = null, onReceipt }: {
  props: SetupFormProps;
  partId: string;
  language?: string;
  onNavigate?: Navigate;
  // What this card already created, when an earlier answer is shown again.
  receipt?: SetupReceipt | null;
  onReceipt?: (receipt: SetupReceipt) => void;
}) {
  const copy = usePartCopy(language);
  // The card as it first showed, to tell an edited value from the one given.
  const [initial] = useState(() => initialSetupDrafts(props));
  const [drafts, setDrafts] = useState(initial);
  const [receipt, setReceipt] = useState<SetupReceipt | null>(initialReceipt);
  const [busy, setBusy] = useState(false);
  const results = receipt?.results || {};
  const supplierRows = new Map(props.suppliers.map((row) => [row.key, row]));
  const itemRows = new Map(props.items.map((row) => [row.key, row]));

  const setSupplier = (key: string, patch: Partial<SupplierDraft>) => setDrafts((current) => ({ ...current, suppliers: current.suppliers.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)) }));
  const setItem = (key: string, patch: Partial<ItemDraft>) => setDrafts((current) => ({ ...current, items: current.items.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)) }));

  const linkPending = (draft: ItemDraft) => itemLinkPending(draft, results);
  const { suppliers: pendingSuppliers, items: pendingItems } = pendingSetupRows(drafts, results);
  const issuesOf = {
    supplier: (draft: SupplierDraft) => supplierIssues(draft, supplierRows.get(draft.key)!, drafts.suppliers),
    item: (draft: ItemDraft) => itemIssues(draft, itemRows.get(draft.key)!, drafts.items, drafts.suppliers),
  };
  const blocked = [...pendingSuppliers.map(issuesOf.supplier), ...pendingItems.map(issuesOf.item)].some((issues) => issues.some((issue) => issue.blocking));
  const pending = pendingSuppliers.length + pendingItems.length;
  const failed = Object.values(results).filter((result) => result.status === "failed" || (created(result) && result.linkError)).length;
  const createDisabled = busy || !pending || blocked;

  const create = async () => {
    if (createDisabled) return;
    setBusy(true);
    let next = results;
    try {
      next = await createSetupRecords({
        drafts,
        results,
        props,
        post: (url, body) => apiJson(url, { method: "POST", body: JSON.stringify(body) }),
        errorText: (failure) => setupErrorText(failure, copy),
        supplierNotCreated: copy.t("ai.v2.setup.error.supplierNotCreated"),
      });
    } finally {
      const saved = { results: next };
      setReceipt(saved);
      onReceipt?.(saved);
      setBusy(false);
    }
  };

  const issueList = (issues: SetupIssue[], field: string) => issues.filter((issue) => issue.field === field).map((issue) => (
    <span key={`${field}-${issue.code}`} data-testid="ai-v2-setup-problem" data-code={issue.code} data-blocking={issue.blocking ? "true" : "false"} className="flex flex-wrap items-center gap-1 text-[12px]" style={{ color: issue.blocking ? RED.color : ORANGE.color }}>
      {issueText(issue, copy)}
      {issue.ref ? <RefChip value={issue.ref} onNavigate={onNavigate} /> : null}
    </span>
  ));

  // One field: its input, where its value came from while unchanged, and its problems.
  const field = (name: string, label: string, value: string, original: string, source: SetupValueSource, onChange: (value: string) => void, issues: SetupIssue[], options: { kind?: "text" | "number" | "email"; disabled?: boolean } = {}) => {
    const edited = value !== original;
    const sourceLabel = edited ? copy.t("ai.v2.setup.source.edited") : source === "generated" ? copy.t("ai.v2.setup.source.generated") : "";
    return (
      <label key={name} data-testid="ai-v2-setup-field" data-field={name} data-source={edited ? "edited" : source} className="space-y-0.5">
        <span className="block text-[12px]" style={{ color: A.sub }}>{label}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <input
            type={options.kind === "number" ? "number" : options.kind === "email" ? "email" : "text"}
            {...(options.kind === "number" ? { min: "0", step: "any", inputMode: "decimal" as const } : {})}
            value={value}
            disabled={options.disabled}
            placeholder={source === "not_given" && !value ? copy.t("ai.v2.setup.notGiven") : undefined}
            onChange={(event) => onChange(event.target.value)}
            className={`${inputClass} max-w-[14rem]`}
            style={inputStyle}
          />
          {sourceLabel ? <SourceChip>{sourceLabel}</SourceChip> : null}
        </span>
        {issueList(issues, name)}
      </label>
    );
  };

  const resultLine = (key: string, type: "supplier" | "item") => {
    const result = results[key];
    if (!result) return null;
    if (result.status === "failed") return <p data-testid="ai-v2-setup-row-error" role="alert" className="text-[12px]" style={{ color: RED.color }}>{result.error}</p>;
    return (
      <p data-testid="ai-v2-setup-row-created" className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: TEAL_TEXT }}>
        <CheckCircle2 size={13} aria-hidden />
        <RefChip value={{ type, id: result.id, label: result.label }} onNavigate={onNavigate} />
        <span>{copy.t("ai.v2.setup.result.created")}</span>
        {result.linkError ? <span data-testid="ai-v2-setup-link-error" role="alert" style={{ color: RED.color }}>{copy.t("ai.v2.setup.result.linkFailed", { error: result.linkError })}</span> : null}
      </p>
    );
  };

  const rowShell = (key: string, include: boolean, canCreate: boolean, title: string, onInclude: (value: boolean) => void, body: ReactNode, type: "supplier" | "item", locked: boolean) => (
    <li key={key} data-testid="ai-v2-setup-row" data-row={key} data-type={type} data-included={include ? "true" : "false"} data-created={created(results[key]) ? "true" : "false"} className="space-y-1.5 rounded-lg p-2" style={{ border: `1px solid ${A.gray5}` }}>
      <div className="flex items-start gap-2">
        <input type="checkbox" data-testid="ai-v2-setup-include" checked={include} disabled={!canCreate || locked} onChange={(event) => onInclude(event.target.checked)} aria-label={copy.t("ai.v2.setup.form.include", { name: title || key })} className="mt-1 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {resultLine(key, type)}
          {include ? body : <p className="text-[13px]" style={{ color: A.sub }}>{title}</p>}
        </div>
      </div>
    </li>
  );

  const supplierChoices = drafts.suppliers.filter((draft) => draft.include);
  const allDone = !pending && !failed && Object.keys(results).length > 0;
  const createLabel = busy ? copy.t("ai.v2.setup.form.working")
    : failed && Object.keys(results).length ? copy.t("ai.v2.setup.form.retry", { count: pending })
    : pending === 1 ? copy.t("ai.v2.setup.form.createOne") : copy.t("ai.v2.setup.form.create", { count: pending });

  return (
    <section data-testid="ai-v2-setup-form" data-form-id={props.formId} data-part-id={partId} lang={copy.language} className="space-y-3 rounded-xl p-3 text-[13px]" style={cardStyle}>
      <div className="space-y-0.5">
        <h4 className="text-[14px] font-semibold" style={{ color: A.label }}>{copy.t("ai.v2.setup.form.title")}</h4>
        <p style={{ color: A.sub }}>{copy.t("ai.v2.setup.form.hint")}</p>
      </div>
      {drafts.suppliers.length ? (
        <div className="space-y-1.5">
          <h5 className="text-[13px] font-semibold" style={{ color: A.label }}>{copy.t("ai.v2.setup.form.suppliers")}</h5>
          {!props.canCreateSuppliers ? <p className="text-[12px]" style={{ color: ORANGE.color }}>{copy.t("ai.v2.setup.form.noSupplierPermission")}</p> : null}
          <ul className="space-y-2">
            {drafts.suppliers.map((draft) => {
              const row = supplierRows.get(draft.key)!;
              const first = initial.suppliers.find((entry) => entry.key === draft.key) || draft;
              const locked = created(results[draft.key]);
              const issues = issuesOf.supplier(draft);
              const set = (patch: Partial<SupplierDraft>) => setSupplier(draft.key, patch);
              const body = locked ? null : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {field("name", copy.t("ai.v2.setup.field.name"), draft.name, first.name, row.name.source, (name) => set({ name }), issues)}
                  {field("code", copy.t("ai.v2.setup.field.code"), draft.code, first.code, row.code.source, (code) => set({ code }), issues)}
                  {field("contact", copy.t("ai.v2.setup.field.contact"), draft.contact, first.contact, row.contact.source, (contact) => set({ contact }), issues)}
                  {field("email", copy.t("ai.v2.setup.field.email"), draft.email, first.email, row.email.source, (email) => set({ email }), issues, { kind: "email" })}
                  {field("phone", copy.t("ai.v2.setup.field.phone"), draft.phone, first.phone, row.phone.source, (phone) => set({ phone }), issues)}
                  <label data-testid="ai-v2-setup-field" data-field="payment_terms" data-source={draft.paymentTerms !== first.paymentTerms ? "edited" : row.paymentTerms.source} className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.setup.field.payment_terms")}</span>
                    <select value={draft.paymentTerms} onChange={(event) => set({ paymentTerms: event.target.value })} className={`${inputClass} max-w-[14rem]`} style={inputStyle}>
                      <option value="">{copy.t("ai.v2.setup.form.noTerms")}</option>
                      {props.paymentTerms.map((term) => <option key={term.code} value={term.code}>{term.label}</option>)}
                    </select>
                    {issueList(issues, "payment_terms")}
                  </label>
                </div>
              );
              return rowShell(draft.key, draft.include, props.canCreateSuppliers, draft.name, (include) => set({ include }), body, "supplier", locked);
            })}
          </ul>
        </div>
      ) : null}
      {drafts.items.length ? (
        <div className="space-y-1.5">
          <h5 className="text-[13px] font-semibold" style={{ color: A.label }}>{copy.t("ai.v2.setup.form.items")}</h5>
          {!props.canCreateItems ? <p className="text-[12px]" style={{ color: ORANGE.color }}>{copy.t("ai.v2.setup.form.noItemPermission")}</p> : null}
          <ul className="space-y-2">
            {drafts.items.map((draft) => {
              const row = itemRows.get(draft.key)!;
              const first = initial.items.find((entry) => entry.key === draft.key) || draft;
              const result = results[draft.key];
              const locked = created(result);
              const issues = issuesOf.item(draft);
              const set = (patch: Partial<ItemDraft>) => setItem(draft.key, patch);
              const currency = itemCurrency(draft, props);
              const supplierSelect = (
                <label data-testid="ai-v2-setup-field" data-field="preferred_supplier" className="space-y-0.5">
                  <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.setup.field.preferred_supplier")}</span>
                  <select value={draft.supplier} onChange={(event) => set({ supplier: event.target.value })} className={`${inputClass} max-w-[16rem]`} style={inputStyle}>
                    {draft.supplier === "" ? <option value="">{copy.t("ai.v2.setup.form.pickSupplier")}</option> : null}
                    <option value="none">{copy.t("ai.v2.setup.form.noSupplier")}</option>
                    {supplierChoices.map((supplier) => <option key={supplier.key} value={`row:${supplier.key}`}>{copy.t("ai.v2.setup.form.inCard", { name: supplier.name || supplier.code })}</option>)}
                    {props.supplierOptions.map((supplier) => <option key={supplier.id} value={`id:${supplier.id}`}>{supplier.name}</option>)}
                  </select>
                  {issueList(issues, "preferred_supplier")}
                </label>
              );
              const linkFields = (
                <>
                  {supplierSelect}
                  {field("reference_price", copy.t("ai.v2.setup.field.reference_price"), draft.referencePrice, first.referencePrice, row.referencePrice.source, (referencePrice) => set({ referencePrice }), issues, { kind: "number" })}
                  <label data-testid="ai-v2-setup-field" data-field="currency" data-source={draft.currency !== first.currency ? "edited" : draft.currency ? "user_typed" : "default"} className="space-y-0.5">
                    <span className="block text-[12px]" style={{ color: A.sub }}>{copy.t("ai.v2.setup.field.currency")}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <input type="text" value={draft.currency} maxLength={3} placeholder={currency} onChange={(event) => set({ currency: event.target.value.toUpperCase() })} className={`${inputClass} max-w-[6rem]`} style={inputStyle} />
                      {!draft.currency ? <SourceChip>{copy.t("ai.v2.setup.source.default", { currency })}</SourceChip> : null}
                    </span>
                    {issueList(issues, "currency")}
                  </label>
                  {field("lead_time_days", copy.t("ai.v2.setup.field.lead_time_days"), draft.leadTimeDays, first.leadTimeDays, row.leadTimeDays.source, (leadTimeDays) => set({ leadTimeDays }), issues, { kind: "number" })}
                </>
              );
              // A created item whose supplier link failed keeps the link's fields to try again.
              const body = locked
                ? (linkPending(draft) ? <div className="grid gap-2 sm:grid-cols-2">{linkFields}</div> : null)
                : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {field("sku", copy.t("ai.v2.setup.field.sku"), draft.sku, first.sku, row.sku.source, (sku) => set({ sku }), issues)}
                    {field("name", copy.t("ai.v2.setup.field.name"), draft.name, first.name, row.name.source, (name) => set({ name }), issues)}
                    {field("unit", copy.t("ai.v2.setup.field.unit"), draft.unit, first.unit, row.unit.source, (unit) => set({ unit }), issues)}
                    {field("category", copy.t("ai.v2.setup.field.category"), draft.category, first.category, row.category.source, (category) => set({ category }), issues)}
                    {field("safety_stock", copy.t("ai.v2.setup.field.safety_stock"), draft.safetyStock, first.safetyStock, row.safetyStock.source, (safetyStock) => set({ safetyStock }), issues, { kind: "number" })}
                    {field("reorder_point", copy.t("ai.v2.setup.field.reorder_point"), draft.reorderPoint, first.reorderPoint, row.reorderPoint.source, (reorderPoint) => set({ reorderPoint }), issues, { kind: "number" })}
                    {linkFields}
                  </div>
                );
              return rowShell(draft.key, draft.include, props.canCreateItems, draft.sku, (include) => set({ include }), body, "item", locked);
            })}
          </ul>
        </div>
      ) : null}
      {blocked ? <p data-testid="ai-v2-setup-blocked" className="flex items-center gap-1.5 text-[12px]" style={{ color: ORANGE.color }}><AlertTriangle size={12} aria-hidden />{copy.t("ai.v2.setup.form.blocked")}</p> : null}
      {allDone ? <p data-testid="ai-v2-setup-done" style={{ color: TEAL_TEXT }}>{copy.t("ai.v2.setup.result.allCreated")}</p> : (
        <button type="button" data-testid="ai-v2-setup-create" data-primary="true" onClick={() => void create()} disabled={createDisabled} className="inline-flex min-h-9 items-center rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{ background: A.blue }}>
          {createLabel}
        </button>
      )}
    </section>
  );
}

