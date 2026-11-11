// Whether a stored supplier or customer name already says what it is, so
// Today shows it without "Supplier" or "Customer" in front: a name that
// starts with the word in either interface language ("Customer 18236 (United
// Kingdom)"), or a supplier named as a vendor ("Foods 1 vendor (assumed)").
// The name itself is shown as recorded.
const ROLE_WORDS: Record<"supplier" | "customer", Array<[string, string]>> = {
  supplier: [["Supplier", "供应商"]],
  customer: [["Customer", "客户"]],
};

export function nameSaysRole(role: "supplier" | "customer", name: string) {
  const value = String(name || "").trim().toLowerCase();
  if (!value) return false;
  if (ROLE_WORDS[role].some((words) => words.some((word) => value.startsWith(word.toLowerCase())))) return true;
  return role === "supplier" && /\b(supplier|vendor)\b/i.test(value);
}
