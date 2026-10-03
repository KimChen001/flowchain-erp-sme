import type { POStatus } from "../../../types/scm";
import { A } from "../../../components/ui";
import { workspaceCopy } from "../../../i18n/workspaceCopy";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

const poStatusMeta: Record<POStatus, { color: string; bg: string }> = {
  "草稿":     { color: A.gray1,  bg: A.gray6  },
  "待审批":   { color: A.orange, bg: "#fff8f0" },
  "已审批":   { color: A.indigo, bg: "#eef0ff" },
  "已发出":   { color: A.blue,   bg: "#f0f6ff" },
  "部分到货": { color: A.teal,   bg: "#e8f6fc" },
  "已完成":   { color: A.green,  bg: "#f0faf4" },
  "已驳回":   { color: A.red,    bg: "#fff1f0" },
  "已取消":   { color: A.red,    bg: "#fff1f0" },
};
// The same colours for the stored status codes.
const poStatusCodeMeta: Record<string, POStatus> = {
  draft: "草稿", pending_approval: "待审批", approved: "已审批", issued: "已发出",
  partially_received: "部分到货", fully_received: "已完成", completed: "已完成", rejected: "已驳回", cancelled: "已取消",
};

export function POStatusPill({ status }: { status: string }) {
  const displayStatus = status || "未知";
  const translatedStatus = copy(displayStatus);
  const visibleStatus = translatedStatus !== displayStatus
    ? translatedStatus
    : displayStatus.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const m = poStatusMeta[(poStatusCodeMeta[displayStatus] || displayStatus) as POStatus] ?? { color: A.gray1, bg: A.gray6 };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ color: m.color, background: m.bg }}>{visibleStatus}</span>
  );
}
