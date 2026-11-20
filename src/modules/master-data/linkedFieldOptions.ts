// Options for a field that names another record (a warehouse, a tax code, a
// payment term, a currency), so it is chosen, not typed (product review
// 2026-11-20, item 28). A value already stored that is not among the options
// (an inactive warehouse, a term typed before) stays offered, marked, so
// opening a record never changes it. Pure, so
// server/domain/linked-field-selects.test.mjs can run it.

export type LinkedOption = { value: string; label: string; unknown?: boolean };

export function linkedFieldOptions(options: LinkedOption[], current: string | null | undefined): LinkedOption[] {
  const stored = String(current ?? "").trim();
  const known = options.filter((option) => option.value);
  if (!stored || known.some((option) => option.value === stored)) return known;
  return [{ value: stored, label: stored, unknown: true }, ...known];
}
