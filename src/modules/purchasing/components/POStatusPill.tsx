import type { POStatus } from "../../../types/scm";
import { StatusChip, statusToneOf, type StatusTone } from "../../../components/ui/listLayout";
import { workspaceCopy } from "../../../i18n/workspaceCopy";
import { statusCodeLabel } from "../../../i18n/statusLabels";
import { useI18n } from "../../../i18n/I18n";

// The stored status code of each older Chinese PO status.
const poStatusCodeMeta: Record<string, POStatus> = {
  draft: "草稿", pending_approval: "待审批", approved: "已审批", issued: "已发出",
  partially_received: "部分到货", fully_received: "已完成", completed: "已完成", rejected: "已驳回", cancelled: "已取消",
};

// The code of a legacy Chinese status value (已审批 -> approved), so both
// read with the app's one set of status words (已批准, 已下达).
const poStatusCodeOf: Record<string, string> = Object.fromEntries(Object.entries(poStatusCodeMeta).map(([code, value]) => [value, code]));

// The tone of a PO status, for other places that show it (the detail
// header): the shared tone of its code, as every list colours it (design
// audit U-05).
export function poStatusToneOf(status?: string | null): StatusTone {
  const value = String(status || "");
  return statusToneOf(poStatusCodeOf[value] || value);
}

export function POStatusPill({ status }: { status: string }) {
  const { language } = useI18n();
  // No status recorded reads "—", not 未知 (design audit L16).
  if (!status) return <StatusChip label="—" tone="neutral" />;
  const displayStatus = status;
  const translatedStatus = statusCodeLabel(poStatusCodeOf[displayStatus] || displayStatus, language) ?? workspaceCopy(displayStatus, language);
  const visibleStatus = translatedStatus !== displayStatus
    ? translatedStatus
    : displayStatus.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const tone = poStatusToneOf(displayStatus);
  return <StatusChip label={visibleStatus} tone={tone} />;
}
