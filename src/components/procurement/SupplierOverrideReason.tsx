import { AlertTriangle } from "lucide-react";
import { useI18n } from "../../i18n/I18n";
import { A, inputStyle } from "../ui";
import { SUPPLIER_OVERRIDE_REASONS, type SupplierOverrideReasonCode } from "../../../shared/supplier-override-reasons.mjs";

// Why a person chose a supplier other than the item's preferred one
// (shared/supplier-override-reasons.mjs): the picker on a purchase request
// line, and the flag an approver sees on the request and on the PO made from
// it. English with its Chinese translation, chosen by the interface language.

export type SupplierOverride = {
  reasonCode: SupplierOverrideReasonCode | string;
  note?: string | null;
  preferredSupplierId?: string | null;
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

const COPY = {
  "en-US": {
    question: "Why not the preferred supplier ({name})?",
    choose: "Choose a reason",
    note: "Note (required for Other)",
    reasonRequired: "Choose a reason",
    noteLength: "Add a note of 3 to 500 characters",
    flag: "Not preferred ({name}). Reason: {reason}",
    flagNoName: "Not preferred. Reason: {reason}",
    countOne: "1 line not preferred",
    countMany: "{n} lines not preferred",
  },
  "zh-CN": {
    question: "为什么不选首选供应商（{name}）？",
    choose: "请选择原因",
    note: "备注（选择“其他”时必填）",
    reasonRequired: "请选择原因",
    noteLength: "请填写 3 到 500 个字符的备注",
    flag: "非首选供应商（{name}）。原因：{reason}",
    flagNoName: "非首选供应商。原因：{reason}",
    countOne: "1 行非首选供应商",
    countMany: "{n} 行非首选供应商",
  },
} as const;

const copyFor = (language: string) => COPY[language === "zh-CN" ? "zh-CN" : "en-US"];

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

// "Not preferred (Acme). Reason: Lead time — note".
export function supplierOverrideText(override: SupplierOverride, language: string) {
  const copy = copyFor(language);
  const reason = supplierOverrideReasonLabel(override.reasonCode, language);
  const name = String(override.preferredSupplierName || "").trim();
  const head = name ? copy.flag.replace("{name}", name).replace("{reason}", reason) : copy.flagNoName.replace("{reason}", reason);
  const note = String(override.note || "").trim();
  return note ? `${head} — ${note}` : head;
}

export function SupplierOverrideFlag({ override, testId = "supplier-override-flag" }: { override?: SupplierOverride | null; testId?: string }) {
  const { language } = useI18n();
  if (!override?.reasonCode) return null;
  return (
    <span data-testid={testId} data-reason-code={override.reasonCode} className="inline-flex max-w-full items-start gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4" style={{ background: "#fff8f0", color: A.orange }}>
      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
      <span className="break-words">{supplierOverrideText(override, language)}</span>
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
  value,
  onChange,
  issues = {},
  testId = "supplier-override-reason",
}: {
  preferredName: string;
  value?: SupplierOverride | null;
  onChange: (next: SupplierOverride) => void;
  issues?: { reasonCode?: string; note?: string };
  testId?: string;
}) {
  const { language } = useI18n();
  const copy = copyFor(language);
  const reasonCode = value?.reasonCode || "";
  const note = value?.note || "";
  return (
    <div data-testid={testId} className="mt-2 rounded-md px-2 py-2 text-xs" style={{ background: "#fff8f0", border: `0.5px solid ${A.orange}40` }}>
      <label className="block font-medium" style={{ color: A.label }}>
        {copy.question.replace("{name}", preferredName)}
        <select
          aria-label={copy.question.replace("{name}", preferredName)}
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
