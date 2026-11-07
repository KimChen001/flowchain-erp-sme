// Display labels for the unit codes items and order lines store, as
// [one, many, Chinese]: "1 box", "300 boxes", "300 箱". Only the label
// changes; the stored code stays the record's value, in any case ("BOX",
// "Pairs"). A unit not listed is shown as stored. The first sixteen mirror
// aiSkillUnitLabel (server/domain/ai-skill-copy.mjs), so the assistant's
// prose and the panel word units alike; the rest are units imports carry.
const UNIT_LABELS: Record<string, [string, string, string]> = (() => {
  const labels: Record<string, [string, string, string]> = {};
  const add = (codes: string[], entry: [string, string, string]) => { for (const code of codes) labels[code] = entry; };
  add(["pcs", "pc", "piece", "pieces"], ["pcs", "pcs", "件"]);
  add(["ea", "each"], ["ea", "ea", "个"]);
  add(["unit", "units"], ["unit", "units", "个"]);
  add(["box", "boxes"], ["box", "boxes", "箱"]);
  add(["case", "cases"], ["case", "cases", "箱"]);
  add(["carton", "cartons", "ctn"], ["carton", "cartons", "箱"]);
  add(["roll", "rolls"], ["roll", "rolls", "卷"]);
  add(["ft", "foot", "feet"], ["ft", "ft", "英尺"]);
  add(["m", "meter", "meters", "metre", "metres"], ["m", "m", "米"]);
  add(["kg", "kgs"], ["kg", "kg", "千克"]);
  add(["set", "sets"], ["set", "sets", "套"]);
  add(["pack", "packs", "pk"], ["pack", "packs", "包"]);
  add(["bag", "bags"], ["bag", "bags", "袋"]);
  add(["pair", "pairs"], ["pair", "pairs", "双"]);
  add(["pallet", "pallets"], ["pallet", "pallets", "托"]);
  add(["sheet", "sheets"], ["sheet", "sheets", "张"]);
  add(["dozen", "dozens", "doz", "dz"], ["dozen", "dozen", "打"]);
  add(["g", "gram", "grams"], ["g", "g", "克"]);
  add(["lb", "lbs", "pound", "pounds"], ["lb", "lb", "磅"]);
  add(["l", "liter", "liters", "litre", "litres"], ["L", "L", "升"]);
  add(["ml", "milliliter", "milliliters", "millilitre", "millilitres"], ["mL", "mL", "毫升"]);
  add(["cm", "centimeter", "centimeters"], ["cm", "cm", "厘米"]);
  add(["mm", "millimeter", "millimeters"], ["mm", "mm", "毫米"]);
  add(["in", "inch", "inches"], ["in", "in", "英寸"]);
  add(["yd", "yard", "yards"], ["yd", "yd", "码"]);
  add(["gal", "gallon", "gallons"], ["gal", "gal", "加仑"]);
  add(["bottle", "bottles"], ["bottle", "bottles", "瓶"]);
  add(["can", "cans"], ["can", "cans", "罐"]);
  add(["drum", "drums"], ["drum", "drums", "桶"]);
  add(["tube", "tubes"], ["tube", "tubes", "支"]);
  return labels;
})();

// The label for a unit code in the interface language; English takes the
// singular for a quantity of 1 and the plural otherwise (no quantity: plural).
export function unitLabel(unit: string | null | undefined, language: string, quantity?: number | null) {
  const code = String(unit ?? "").trim();
  const entry = UNIT_LABELS[code.toLowerCase()];
  if (!entry) return code;
  if (language !== "en-US") return entry[2];
  return quantity === 1 ? entry[0] : entry[1];
}
