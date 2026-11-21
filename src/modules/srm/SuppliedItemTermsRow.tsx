import { useEffect, useMemo, useState } from "react";
import { A, Field, inputStyle } from "../../components/ui";
import { rowActionClass } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";
import { asText, numberSeparators, rebaseTermsForm, suppliedItemTermsChanges, suppliedItemTermsProblems, type SuppliedItemTerms, type TermKey, type TermsForm } from "./suppliedItemTerms";

export { EDIT_TERMS_LABEL } from "./suppliedItemTerms";

// Editing a supplied item's terms on the supplier's page: lead time, minimum
// order and reference price, through the existing PATCH
// /api/master-data/items/:itemId/suppliers/:relationshipId. Only the fields
// changed are sent; a blank field is saved as not recorded, never as 0
// (master-data-commands itemSupplierInputIssues). A reader who may not see
// prices sees the price as hidden and never sends it. Request prices, the
// order plan and the suggested reorder point read these figures (product
// review 2026-11-20, item 7).

// English source copy with its Chinese translation.
const COPY = {
  title: ["Terms for {item}", "{item} 的供货条件"],
  leadTime: ["Lead time (days)", "提前期（天）"],
  moq: ["Minimum order", "最小起订量"],
  price: ["Reference price ({currency})", "参考价格（{currency}）"],
  priceNoCurrency: ["Reference price", "参考价格"],
  priceHidden: ["Hidden for your role; not changed here.", "你的角色无权查看价格，此处不会修改。"],
  blank: ["Leave a field blank when it is not known.", "未知的字段请留空。"],
  nothingChanged: ["Nothing changed yet.", "尚未修改任何字段。"],
  save: ["Save terms", "保存条件"],
  saving: ["Saving…", "正在保存…"],
  cancel: ["Cancel", "取消"],
  wholeDays: ["Enter the lead time as whole days, zero or more.", "提前期请输入不小于 0 的整数天数。"],
  positive: ["Enter a minimum order greater than zero.", "最小起订量请输入大于 0 的数量。"],
  priceAboveZero: ["Enter a price above zero, or leave it blank.", "价格请输入大于 0 的数，或留空。"],
} as const;

export function SuppliedItemTermsRow({ colSpan, itemLabel, currency, terms, priceHidden, onSave, onCancel }: {
  colSpan: number;
  itemLabel: string;
  currency: string;
  // The terms as last read; a reread (another row action, a version
  // conflict) passes new ones, which untouched fields follow.
  terms: SuppliedItemTerms;
  priceHidden: boolean;
  onSave: (changes: Partial<SuppliedItemTerms>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { language, locale } = useI18n();
  const say = (key: keyof typeof COPY, values: Record<string, string> = {}) =>
    COPY[key][language === "zh-CN" ? 1 : 0].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
  const separators = useMemo(() => numberSeparators(locale || "en-US"), [locale]);
  const [form, setForm] = useState<TermsForm>({ leadTimeDays: asText(terms.leadTimeDays), minimumOrderQuantity: asText(terms.minimumOrderQuantity), referencePrice: priceHidden ? "" : asText(terms.referencePrice) });
  const [touched, setTouched] = useState<Set<TermKey>>(new Set());
  const [saving, setSaving] = useState(false);
  // A reread: fields not touched take the latest terms.
  useEffect(() => {
    setForm((current) => rebaseTermsForm(current, touched, priceHidden ? { ...terms, referencePrice: null } : terms));
  }, [terms.leadTimeDays, terms.minimumOrderQuantity, terms.referencePrice]);
  const changes = suppliedItemTermsChanges(form, terms, { priceHidden, separators });
  const problems = suppliedItemTermsProblems(changes);
  const nothing = Object.keys(changes).length === 0;
  const save = async () => {
    if (problems.length || nothing) return;
    setSaving(true);
    try {
      if (await onSave(changes)) onCancel();
    } finally {
      setSaving(false);
    }
  };
  const input = (key: TermKey, label: string) => (
    <Field label={label}>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={form[key]}
        onChange={(event) => {
          const value = event.target.value;
          setForm((current) => ({ ...current, [key]: value }));
          setTouched((current) => new Set(current).add(key));
        }}
        style={inputStyle}
        data-testid={`supplied-item-terms-${key}`}
      />
    </Field>
  );
  const priceLabel = currency ? say("price", { currency }) : say("priceNoCurrency");
  return (
    <tr data-testid="supplied-item-terms-row">
      <td colSpan={colSpan} className="px-3 py-3" style={{ background: A.gray6 }}>
        <div className="text-xs font-semibold" style={{ color: A.label }}>{say("title", { item: itemLabel })}</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {input("leadTimeDays", say("leadTime"))}
          {input("minimumOrderQuantity", say("moq"))}
          {priceHidden
            ? <Field label={priceLabel}><p className="py-2 text-xs" style={{ color: A.sub }} data-testid="supplied-item-terms-price-hidden">{say("priceHidden")}</p></Field>
            : input("referencePrice", priceLabel)}
        </div>
        <p className="mt-1 text-xs" style={{ color: problems.length ? A.danger : A.sub }} role={problems.length ? "alert" : undefined}>
          {problems.length ? problems.map((problem) => say(problem)).join(" ") : say(nothing ? "nothingChanged" : "blank")}
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" className={rowActionClass.neutral} disabled={saving} onClick={onCancel}>{say("cancel")}</button>
          <button type="button" className={rowActionClass.primary} disabled={saving || problems.length > 0 || nothing} onClick={() => void save()} data-testid="supplied-item-terms-save">{say(saving ? "saving" : "save")}</button>
        </div>
      </td>
    </tr>
  );
}
