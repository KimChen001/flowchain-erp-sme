import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { A, Card, Chip, Modal, SectionHeader } from "../ui";
import { workspaceCopy } from "../../i18n/workspaceCopy";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

export type DetailField = {
  label: string;
  value: string | number | undefined | null;
  tone?: "default" | "good" | "warning" | "danger" | "info";
};

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
