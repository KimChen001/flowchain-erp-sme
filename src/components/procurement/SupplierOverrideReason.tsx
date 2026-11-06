import { AlertTriangle } from "lucide-react";
import { useI18n } from "../../i18n/I18n";
import { A, inputStyle } from "../ui";
import { SUPPLIER_OVERRIDE_REASONS, type SupplierOverrideReasonCode } from "../../../shared/supplier-override-reasons.mjs";

// Why a person chose a supplier other than the item's preferred one
// (shared/supplier-override-reasons.mjs): the picker on a purchase request
// line, and the flag an approver sees on the request and on the PO made from
// it. English with its Chinese translation, chosen by the interface language.

// missingReason: the line skips the item's preferred supplier but was saved
// before a reason was asked (marked on submit or on conversion to a PO);
// reasonCode is then null. preferredSupplierIds: every preferred source,
// when master data marks more than one.
export type SupplierOverride = {
  reasonCode: SupplierOverrideReasonCode | string | null;
  note?: string | null;
  missingReason?: boolean;
  preferredSupplierId?: string | null;
  preferredSupplierIds?: string[] | null;
  preferredSupplierName?: string | null;
};

const REASON_LABELS: Record<SupplierOverrideReasonCode, readonly [string, string]> = {
  price: ["Price", "价格"],
  lead_time: ["Lead time", "交期"],
  stock_now: ["Stock available now", "现货可供"],
  quality: ["Quality", "质量"],
  moq_fit: ["MOQ fit", "起订量合适"],
  customer_specified: ["Customer-specified", "客户指定"],
  other: ["Other", "其他"],
};

// The name in the flag is the preferred supplier the line does NOT use; the
// Chinese says so ("未使用首选供应商") so it cannot be read as calling that
// supplier non-preferred. With more than one preferred source the copy is
// plural ("one of the preferred suppliers (A, B)").
export const SUPPLIER_OVERRIDE_COPY = {
  "en-US": {
    question: "Why not the preferred supplier ({name})?",
    questionMany: "Why not one of the preferred suppliers ({name})?",
    questionNoName: "Why not the preferred supplier?",
    choose: "Choose a reason",
    note: "Note (required for Other)",
    reasonRequired: "Choose a reason",
    noteLength: "Other needs a note of at least 3 characters",
    flag: "Not preferred ({name}). Reason: {reason}",
    flagMany: "None of the preferred suppliers ({name}). Reason: {reason}",
    flagNoName: "Not preferred. Reason: {reason}",
    missing: "Not preferred ({name}). No reason recorded",
    missingMany: "None of the preferred suppliers ({name}). No reason recorded",
    missingNoName: "Not preferred. No reason recorded",
    countOne: "1 line skips the preferred supplier",
    countMany: "{n} lines skip the preferred supplier",
  },
  "zh-CN": {
    question: "为什么不选首选供应商（{name}）？",
    questionMany: "为什么不选任一首选供应商（{name}）？",
    questionNoName: "为什么不选首选供应商？",
    choose: "请选择原因",
    note: "备注（选择“其他”时必填）",
    reasonRequired: "请选择原因",
    noteLength: "选择“其他”时请填写至少 3 个字符的备注",
    flag: "未使用首选供应商（{name}）。原因：{reason}",
    flagMany: "未使用任一首选供应商（{name}）。原因：{reason}",
    flagNoName: "未使用首选供应商。原因：{reason}",
    missing: "未使用首选供应商（{name}）。未记录原因",
    missingMany: "未使用任一首选供应商（{name}）。未记录原因",
    missingNoName: "未使用首选供应商。未记录原因",
    countOne: "1 行未使用首选供应商",
    countMany: "{n} 行未使用首选供应商",
  },
} as const;

const copyFor = (language: string) => SUPPLIER_OVERRIDE_COPY[language === "zh-CN" ? "zh-CN" : "en-US"];

export function supplierOverrideReasonLabel(code: string, language: string) {
  const pair = REASON_LABELS[code as SupplierOverrideReasonCode];
  if (!pair) return code;
  return language === "zh-CN" ? pair[1] : pair[0];
}

// The message for a reason or note the server (or the form) refused.
export function supplierOverrideIssueText(code: string | undefined, language: string) {
  const copy = copyFor(language);
  return code === "NOTE_LENGTH" ? copy.noteLength : copy.reasonRequired;
}

// True when the line has a reason to show, or is marked as having none.
export const hasSupplierOverride = (override?: SupplierOverride | null) => Boolean(override?.reasonCode || override?.missingReason);

// "Not preferred (Acme). Reason: Lead time — note"; "Not preferred (Acme).
// No reason recorded" for a line saved before reasons were asked.
export function supplierOverrideText(override: SupplierOverride, language: string) {
  const copy = copyFor(language);
  const name = String(override.preferredSupplierName || "").trim();
  const many = (override.preferredSupplierIds?.length || 0) > 1;
  if (!override.reasonCode) return name ? (many ? copy.missingMany : copy.missing).replace("{name}", name) : copy.missingNoName;
  const reason = supplierOverrideReasonLabel(override.reasonCode, language);
  const head = name ? (many ? copy.flagMany : copy.flag).replace("{name}", name).replace("{reason}", reason) : copy.flagNoName.replace("{reason}", reason);
  const note = String(override.note || "").trim();
  return note ? `${head} — ${note}` : head;
}

// prefix: what the line is, where the flag stands apart from it (a list row).
export function SupplierOverrideFlag({ override, prefix, testId = "supplier-override-flag" }: { override?: SupplierOverride | null; prefix?: string; testId?: string }) {
  const { language } = useI18n();
  if (!override || !hasSupplierOverride(override)) return null;
  const text = supplierOverrideText(override, language);
  return (
    <span data-testid={testId} data-reason-code={override.reasonCode || "none"} className="inline-flex max-w-full items-start gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4" style={{ background: "#fff8f0", color: A.orange }}>
      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
      <span className="break-words">{prefix ? `${prefix}: ${text}` : text}</span>
    </span>
  );
}

// How many lines of a document use a supplier other than the preferred one.
export function SupplierOverrideCount({ count, testId = "supplier-override-count" }: { count: number; testId?: string }) {
  const { language } = useI18n();
  if (!count) return null;
  const copy = copyFor(language);
  return (
    <span data-testid={testId} className="ml-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: "#fff8f0", color: A.orange }}>
      <AlertTriangle size={11} aria-hidden />
      {count === 1 ? copy.countOne : copy.countMany.replace("{n}", String(count))}
    </span>
  );
}

// The picker under a purchase request line's supplier. issues: the codes the
// server or the form returned for this line's reason and note.
export function SupplierOverrideReason({
  preferredName,
  preferredCount = 1,
  value,
  onChange,
  issues = {},
  testId = "supplier-override-reason",
}: {
  preferredName: string;
  preferredCount?: number;
  value?: SupplierOverride | null;
  onChange: (next: SupplierOverride) => void;
  issues?: { reasonCode?: string; note?: string };
  testId?: string;
}) {
  const { language } = useI18n();
  const copy = copyFor(language);
  const reasonCode = value?.reasonCode || "";
  const note = value?.note || "";
  const question = preferredName ? (preferredCount > 1 ? copy.questionMany : copy.question).replace("{name}", preferredName) : copy.questionNoName;
  return (
    <div data-testid={testId} className="mt-2 rounded-md px-2 py-2 text-xs" style={{ background: "#fff8f0", border: `0.5px solid ${A.orange}40` }}>
      <label className="block font-medium" style={{ color: A.label }}>
        {question}
        <select
          aria-label={question}
          data-testid={`${testId}-code`}
          value={reasonCode}
          onChange={(event) => onChange({ ...(value || {}), reasonCode: event.target.value, note })}
          aria-invalid={Boolean(issues.reasonCode)}
          style={{ ...inputStyle, marginTop: 4 }}
        >
          <option value="">{copy.choose}</option>
          {SUPPLIER_OVERRIDE_REASONS.map((code) => (
            <option key={code} value={code}>{supplierOverrideReasonLabel(code, language)}</option>
          ))}
        </select>
      </label>
      {issues.reasonCode ? <div role="alert" className="mt-1 text-red-700">{supplierOverrideIssueText(issues.reasonCode, language)}</div> : null}
      <label className="mt-2 block" style={{ color: A.sub }}>
        {copy.note}
        <input
          aria-label={copy.note}
          data-testid={`${testId}-note`}
          value={note}
          maxLength={500}
          onChange={(event) => onChange({ ...(value || {}), reasonCode, note: event.target.value })}
          aria-invalid={Boolean(issues.note)}
          style={{ ...inputStyle, marginTop: 4 }}
        />
      </label>
      {issues.note ? <div role="alert" className="mt-1 text-red-700">{supplierOverrideIssueText(issues.note, language)}</div> : null}
    </div>
  );
}
