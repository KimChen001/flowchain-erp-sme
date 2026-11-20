// A supplied item's terms as the supplier page edits them (SuppliedItemTermsRow):
// what to send, and what to refuse before sending. Pure, so
// server/domain/supplied-item-terms.test.mjs can run it.

// The row button that opens the terms form.
export const EDIT_TERMS_LABEL = ["Edit terms", "编辑条件"] as const;

export type SuppliedItemTerms = { leadTimeDays: number | null; minimumOrderQuantity: number | null; referencePrice: number | null };

export const asText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

// What to send: a field left blank is null (not recorded); a changed field its number.
export function suppliedItemTermsPatch(form: { leadTimeDays: string; minimumOrderQuantity: string; referencePrice: string }) {
  const value = (raw: string) => (raw.trim() === "" ? null : Number(raw));
  return { leadTimeDays: value(form.leadTimeDays), minimumOrderQuantity: value(form.minimumOrderQuantity), referencePrice: value(form.referencePrice) };
}

// Checked before sending, with the server's rules; the server checks again.
export function suppliedItemTermsProblems(patch: SuppliedItemTerms) {
  const problems: Array<"wholeDays" | "positive" | "zeroOrMore"> = [];
  if (patch.leadTimeDays !== null && (!Number.isInteger(patch.leadTimeDays) || patch.leadTimeDays < 0)) problems.push("wholeDays");
  if (patch.minimumOrderQuantity !== null && (!Number.isFinite(patch.minimumOrderQuantity) || patch.minimumOrderQuantity <= 0)) problems.push("positive");
  if (patch.referencePrice !== null && (!Number.isFinite(patch.referencePrice) || patch.referencePrice < 0)) problems.push("zeroOrMore");
  return problems;
}

