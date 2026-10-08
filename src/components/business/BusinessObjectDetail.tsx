import { useState, type ReactNode } from "react";
import { CheckCircle2, FileText, ShieldCheck } from "lucide-react";
import { A, Card, Chip, Modal, SectionHeader } from "../ui";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { useI18n } from "../../i18n/I18n";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

export type DetailField = {
  label: string;
  value: string | number | undefined | null;
  tone?: "default" | "good" | "warning" | "danger" | "info";
};

type ReviewDecision = "approve" | "reject" | "request_changes" | "defer" | "cancel";

// Review decisions in English and Chinese.
const decisionLabels: Record<ReviewDecision, [string, string]> = {
  approve: ["Approve", "通过复核"],
  reject: ["Reject", "拒绝"],
  request_changes: ["Request changes", "要求补充"],
  defer: ["Defer", "暂缓"],
  cancel: ["Cancel", "取消"],
};

const decisionRequiresReason = new Set<ReviewDecision>(["reject", "request_changes", "cancel"]);

function toneColor(tone: DetailField["tone"] = "default") {
  if (tone === "good") return A.green;
  if (tone === "warning") return A.orange;
  if (tone === "danger") return A.red;
  if (tone === "info") return A.blue;
  return A.label;
}

export function BusinessObjectDetailModal({
  open,
  onClose,
  title,
  subtitle,
  width = 1080,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} width={width}>
      {children}
    </Modal>
  );
}

export function CompactKpiStrip({ items }: { items: DetailField[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg p-3" style={{ background: A.gray6 }}>
          <div className="fc-caption" style={{ color: A.gray2 }}>{copy(item.label)}</div>
          <div className="mt-1 text-sm font-semibold tabular-nums truncate" style={{ color: toneColor(item.tone) }}>
            {typeof item.value === "string" ? copy(item.value) : item.value ?? copy("待确认")}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DetailSection({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Card className="p-4" style={{ boxShadow: "none", background: A.gray6 }}>
      <SectionHeader title={title} right={right} />
      {children}
    </Card>
  );
}

export function DetailFieldGrid({ fields, columns = 4 }: { fields: DetailField[]; columns?: 2 | 3 | 4 }) {
  const grid = columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-3" : "grid-cols-2 md:grid-cols-4";
  return (
    <div className={`grid ${grid} gap-2`}>
      {fields.map((field) => (
        <div key={field.label} className="rounded-lg p-2.5" style={{ background: A.white }}>
          <div className="fc-caption" style={{ color: A.gray2 }}>{copy(field.label)}</div>
          <div className="mt-1 text-xs font-semibold truncate" style={{ color: toneColor(field.tone) }}>
            {typeof field.value === "string" ? copy(field.value) : field.value ?? copy("待确认")}
          </div>
        </div>
      ))}
    </div>
  );
}

export function EvidenceSummaryPanel({
  groups,
}: {
  groups: Array<{ label: string; value: string; tone?: DetailField["tone"] }>;
}) {
  return (
    <DetailSection title="证据链摘要" right={<Chip label="只读证据" color={A.blue} bg="#f0f6ff" />}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {groups.map((item) => (
          <div key={item.label} className="flex items-start gap-2 rounded-lg p-2.5" style={{ background: A.white }}>
            <FileText size={13} className="mt-0.5 shrink-0" style={{ color: toneColor(item.tone || "info") }} />
            <div className="min-w-0">
              <div className="fc-caption font-semibold" style={{ color: A.gray1 }}>{copy(item.label)}</div>
              <div className="mt-0.5 text-[11px] leading-5" style={{ color: A.sub }}>{item.value}</div>
            </div>
          </div>
        ))}
      </div>
    </DetailSection>
  );
}

export function DataLimitationsPanel({
  items,
  labelFor,
}: {
  items: string[];
  labelFor: (item: string) => string;
}) {
  const visible = items.length ? items : ["current_workspace_data_limited"];
  return (
    <DetailSection title="数据限制" right={<Chip label="需人工复核" color={A.orange} bg="#fff8f0" />}>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((item) => (
          <span key={item} className="rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: A.white, color: A.orange }}>
            {copy(labelFor(item))}
          </span>
        ))}
      </div>
    </DetailSection>
  );
}

// The preview is kept as its parts and written out when shown, so it follows
// the interface language. objectLabel is passed in the interface language.
type ReviewPreview = { decision: ReviewDecision; reason: string; missingReason: boolean };

export function ReviewActionPanel({ objectLabel }: { objectLabel: string }) {
  const { language } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const decisionLabel = (item: ReviewDecision) => say(...decisionLabels[item]);
  const [decision, setDecision] = useState<ReviewDecision>("approve");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ReviewPreview | null>(null);

  function preview() {
    const trimmed = reason.trim();
    setResult({ decision, reason: trimmed, missingReason: decisionRequiresReason.has(decision) && !trimmed });
  }

  function previewMessage(preview: ReviewPreview) {
    const label = decisionLabel(preview.decision);
    if (preview.missingReason) return say(`${label} needs a reason. Nothing is written to business records.`, `${label}需要填写原因，当前不会写入业务数据。`);
    const reasonText = preview.reason ? say(`, reason: ${preview.reason}`, `，原因：${preview.reason}`) : "";
    return say(
      `Review record preview for ${objectLabel}: ${label}${reasonText}. For the owner to check before confirming; nothing is written.`,
      `${objectLabel}已生成${label}复核记录预览${reasonText}。该操作仅供负责人确认前查看。`,
    );
  }

  return (
    <DetailSection title="复核动作" right={<Chip label="预览模式" color={A.green} bg="#f0faf4" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-5 gap-2">
          {(Object.keys(decisionLabels) as ReviewDecision[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setDecision(item)}
              className="h-8 rounded-lg text-[11px] font-semibold"
              style={decision === item ? { background: "#0f172a", color: A.white } : { background: A.white, color: A.gray1 }}
            >
              {decisionLabel(item)}
            </button>
          ))}
        </div>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="w-full min-h-[72px] rounded-lg px-3 py-2 text-xs outline-none"
          style={{ background: A.white, color: A.label, boxShadow: "0 0 0 0.5px rgba(15,23,42,0.12)" }}
          placeholder={copy("填写复核原因、补充资料要求或暂缓说明")}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: A.sub }}>
            <ShieldCheck size={13} /> {copy("所有动作仅生成内部复核预览，不自动改主档、不发外部通知。")}
          </div>
          <button
            type="button"
            onClick={preview}
            className="h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
            style={{ background: "#f0f6ff", color: A.blue }}
          >
            <CheckCircle2 size={13} /> {copy("生成复核预览")}
          </button>
        </div>
        {result && (
          <div className="rounded-lg px-3 py-2 text-[11px] leading-5" style={{ background: A.white, color: result.missingReason ? A.red : A.green }}>
            {previewMessage(result)}
          </div>
        )}
      </div>
    </DetailSection>
  );
}
