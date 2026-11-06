// Whole labels that server responses and older records still send in the
// Chinese words the app replaced (owner's terminology, 2026-11-05), mapped to
// the current label: the English lookup then finds them, and Chinese shows the
// current word. Whole labels only: "交期" alone meant a lead time, while
// "承诺交期" is a date and must not change.
export const LEGACY_CHINESE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "开放 PO": "未结 PO",
  "承诺日期": "承诺交期",
  "查看 RFQ": "查看询价单",
  "RFQ 编号": "询价单编号",
  "交期": "提前期",
});

export function currentChineseLabel(label: string): string {
  return LEGACY_CHINESE_LABELS[label] ?? label;
}
