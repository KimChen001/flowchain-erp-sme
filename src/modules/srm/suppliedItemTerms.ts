// A supplied item's terms as the supplier page edits them (SuppliedItemTermsRow):
// how a typed number is read, what to send, and what to refuse before
// sending. Pure, so server/domain/supplied-item-terms.test.mjs can run it.

// The row button that opens the terms form.
export const EDIT_TERMS_LABEL = ["Edit terms", "编辑条件"] as const;

export type SuppliedItemTerms = { leadTimeDays: number | null; minimumOrderQuantity: number | null; referencePrice: number | null };
export type TermKey = keyof SuppliedItemTerms;
export type TermsForm = Record<TermKey, string>;
export const TERM_KEYS: readonly TermKey[] = ["leadTimeDays", "minimumOrderQuantity", "referencePrice"];

export const asText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

// The separators a locale writes numbers with ("1,000.5" in en-US, "1.000,5" in de-DE).
export function numberSeparators(locale: string) {
  const parts = (value: number) => new Intl.NumberFormat(locale).formatToParts(value);
  return {
    decimal: parts(1.1).find((part) => part.type === "decimal")?.value || ".",
    group: parts(10000).find((part) => part.type === "group")?.value || ",",
  };
}

// A typed number: blank is null (not recorded); a number in the locale's
// separators, or with a plain point, its value; anything else NaN, which the
// form refuses (a number field would have read it as blank and cleared it).
export function parseTermNumber(raw: string, separators = { decimal: ".", group: "," }) {
  const text = String(raw ?? "").trim().replace(/[\s  ]/g, "");
  if (!text) return null;
  const { decimal, group } = separators;
  let normal = text;
  if (normal.includes(decimal)) normal = normal.split(group).join("").replace(decimal, ".");
  // A locale with a decimal comma and none typed: points are thousands only in
  // groups of three ("1.000"); otherwise a plain decimal point ("2.5").
  else if (group === ".") normal = /^\d{1,3}(\.\d{3})+$/.test(normal) ? normal.split(".").join("") : normal;
  else normal = normal.split(group).join("");
  return /^\d+(\.\d+)?$/.test(normal) ? Number(normal) : Number.NaN;
}

const same = (a: number | null, b: number | null | undefined) => (a === null ? b === null || b === undefined : a === b);

// What to send: only the fields the person changed from the terms as last
// read, never the price when this reader may not see it (the server sends it
// as null: sending that back would clear it).
export function suppliedItemTermsChanges(form: TermsForm, current: SuppliedItemTerms, { priceHidden = false, separators }: { priceHidden?: boolean; separators?: { decimal: string; group: string } } = {}) {
  const changes: Partial<SuppliedItemTerms> = {};
  for (const key of TERM_KEYS) {
    if (key === "referencePrice" && priceHidden) continue;
    const value = parseTermNumber(form[key], separators);
    if (!same(value, current[key])) changes[key] = value;
  }
  return changes;
}

// Checked before sending, with the server's rules; the server checks again.
// A price of 0 is stored as not recorded, so a price must be above zero.
export function suppliedItemTermsProblems(changes: Partial<SuppliedItemTerms>) {
  const problems: Array<"wholeDays" | "positive" | "priceAboveZero"> = [];
  const { leadTimeDays, minimumOrderQuantity, referencePrice } = changes;
  if (leadTimeDays !== undefined && leadTimeDays !== null && (!Number.isInteger(leadTimeDays) || leadTimeDays < 0)) problems.push("wholeDays");
  if (minimumOrderQuantity !== undefined && minimumOrderQuantity !== null && (!Number.isFinite(minimumOrderQuantity) || minimumOrderQuantity <= 0)) problems.push("positive");
  if (referencePrice !== undefined && referencePrice !== null && (!Number.isFinite(referencePrice) || referencePrice <= 0)) problems.push("priceAboveZero");
  return problems;
}

// A form open while the row is reread (another action, or a version
// conflict): fields the person has not touched follow the latest terms;
// typed ones are kept.
export function rebaseTermsForm(form: TermsForm, touched: ReadonlySet<TermKey>, latest: SuppliedItemTerms): TermsForm {
  return Object.fromEntries(TERM_KEYS.map((key) => [key, touched.has(key) ? form[key] : asText(latest[key])])) as TermsForm;
}
