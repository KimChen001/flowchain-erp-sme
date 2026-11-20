import { useState } from "react";
import { A, Field, inputStyle } from "../../components/ui";
import { rowActionClass } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";
import { asText, suppliedItemTermsPatch, suppliedItemTermsProblems, type SuppliedItemTerms } from "./suppliedItemTerms";

// Editing a supplied item's terms on the supplier's page: lead time, minimum
// order and reference price, through the existing PATCH
// /api/master-data/items/:itemId/suppliers/:relationshipId. A blank field is
// saved as not recorded, never as 0 (master-data-commands itemSupplierInputIssues).
// Request prices, the order plan and the suggested reorder point read these
// figures (product review 2026-11-20, item 7).

// English source copy with its Chinese translation.
const COPY = {
  title: ["Terms for {item}", "{item} 的供货条件"],
  leadTime: ["Lead time (days)", "提前期（天）"],
  moq: ["Minimum order", "最小起订量"],
  price: ["Reference price ({currency})", "参考价格（{currency}）"],
  priceNoCurrency: ["Reference price", "参考价格"],
  blank: ["Leave a field blank when it is not known.", "未知的字段请留空。"],
  save: ["Save terms", "保存条件"],
  saving: ["Saving…", "正在保存…"],
  cancel: ["Cancel", "取消"],
  wholeDays: ["Enter whole days, zero or more.", "请输入不小于 0 的整数天数。"],
  positive: ["Enter a quantity greater than zero.", "请输入大于 0 的数量。"],
  zeroOrMore: ["Enter a price of zero or more.", "请输入不小于 0 的价格。"],
} as const;

export { EDIT_TERMS_LABEL } from "./suppliedItemTerms";

export function SuppliedItemTermsRow({ colSpan, itemLabel, currency, terms, onSave, onCancel }: {
  colSpan: number;
  itemLabel: string;
  currency: string;
  terms: SuppliedItemTerms;
  onSave: (patch: SuppliedItemTerms) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { language } = useI18n();
  const say = (key: keyof typeof COPY, values: Record<string, string> = {}) =>
    COPY[key][language === "zh-CN" ? 1 : 0].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
  const [form, setForm] = useState({ leadTimeDays: asText(terms.leadTimeDays), minimumOrderQuantity: asText(terms.minimumOrderQuantity), referencePrice: asText(terms.referencePrice) });
  const [saving, setSaving] = useState(false);
  const patch = suppliedItemTermsPatch(form);
  const problems = suppliedItemTermsProblems(patch);
  const save = async () => {
    if (problems.length) return;
    setSaving(true);
    try {
      if (await onSave(patch)) onCancel();
    } finally {
      setSaving(false);
    }
  };
  const input = (key: keyof typeof form, label: string, step: string) => (
    <Field label={label}>
      <input type="number" inputMode="decimal" min={0} step={step} aria-label={label} value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} style={inputStyle} data-testid={`supplied-item-terms-${key}`} />
    </Field>
  );
  return (
    <tr data-testid="supplied-item-terms-row">
      <td colSpan={colSpan} className="px-3 py-3" style={{ background: A.gray6 }}>
        <div className="text-xs font-semibold" style={{ color: A.label }}>{say("title", { item: itemLabel })}</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {input("leadTimeDays", say("leadTime"), "1")}
          {input("minimumOrderQuantity", say("moq"), "any")}
          {input("referencePrice", currency ? say("price", { currency }) : say("priceNoCurrency"), "any")}
        </div>
        <p className="mt-1 text-xs" style={{ color: problems.length ? A.red : A.sub }} role={problems.length ? "alert" : undefined}>
          {problems.length ? problems.map((problem) => say(problem)).join(" ") : say("blank")}
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" className={rowActionClass.primary} disabled={saving || problems.length > 0} onClick={() => void save()} data-testid="supplied-item-terms-save">{say(saving ? "saving" : "save")}</button>
          <button type="button" className={rowActionClass.neutral} disabled={saving} onClick={onCancel}>{say("cancel")}</button>
        </div>
      </td>
    </tr>
  );
}
