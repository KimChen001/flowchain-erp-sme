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

const isActive = (status?: string | null) => (status || "active") === "active";
const labelOf = (value: string, name?: string | null) => (name && name !== value ? `${value} · ${name}` : value);

// GET /api/master-data/warehouses: { id, code, name, status }. The value is
// the id, which the server checks; the label the code and name.
export function warehouseOptions(rows: Array<{ id?: string; code?: string; name?: string; status?: string }> = []): LinkedOption[] {
  return rows.filter((row) => row.id && isActive(row.status)).map((row) => ({ value: String(row.id), label: [row.code, row.name].filter(Boolean).join(" · ") || String(row.id) }));
}

// GET /api/master-data/tax-codes: { id, label, rate, status }, where id is the
// tax code ("VAT20") and label its name (db-master-data-repository mapTaxCode,
// master-data listTaxCodes). The value is the code.
export function taxCodeOptions(rows: Array<{ id?: string; label?: string; status?: string }> = []): LinkedOption[] {
  return rows.filter((row) => row.id && isActive(row.status)).map((row) => ({ value: String(row.id), label: labelOf(String(row.id), row.label) }));
}

// GET /api/master-data/payment-terms/select: { options: [{ id, code, label }] }.
// The value is the code, which a customer invoice's due date reads.
export function paymentTermOptions(options: Array<{ id?: string; code?: string; label?: string }> = []): LinkedOption[] {
  return options.filter((option) => option.code || option.id).map((option) => {
    const value = String(option.code || option.id);
    return { value, label: option.label && option.label !== value ? `${option.label} (${value})` : value };
  });
}
