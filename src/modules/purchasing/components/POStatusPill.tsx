import type { POStatus } from "../../../types/scm";
import { StatusChip, type StatusTone } from "../../../components/ui/listLayout";
import { workspaceCopy } from "../../../i18n/workspaceCopy";
import { useI18n } from "../../../i18n/I18n";

// The shared brand tones: gray draft, orange awaiting approval, blue while the
// order is under way, teal once received, red when rejected.
const poStatusTone: Record<POStatus, StatusTone> = {
  "草稿": "neutral",
  "待审批": "warning",
  "已审批": "info",
  "已发出": "info",
  "部分到货": "info",
  "已完成": "success",
  "已驳回": "danger",
  "已取消": "neutral",
};
// The same tones for the stored status codes.
const poStatusCodeMeta: Record<string, POStatus> = {
  draft: "草稿", pending_approval: "待审批", approved: "已审批", issued: "已发出",
  partially_received: "部分到货", fully_received: "已完成", completed: "已完成", rejected: "已驳回", cancelled: "已取消",
};

export function POStatusPill({ status }: { status: string }) {
  const { language } = useI18n();
  const displayStatus = status || "未知";
  const translatedStatus = workspaceCopy(displayStatus, language);
  const visibleStatus = translatedStatus !== displayStatus
    ? translatedStatus
    : displayStatus.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const tone = poStatusTone[(poStatusCodeMeta[displayStatus] || displayStatus) as POStatus] ?? "neutral";
  return <StatusChip label={visibleStatus} tone={tone} />;
}
