const text = (value) => String(value ?? "").trim();

export function exactRfqDecimalString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toFixed === "function") return value.toFixed(4);
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}
