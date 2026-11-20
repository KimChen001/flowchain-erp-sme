import { useState } from "react";
import { Download } from "lucide-react";
import { A } from "../../components/ui";
import { apiJson } from "../../lib/api-client";
import { apiErrorText } from "../../lib/apiErrorText";
import { exportWorkbookSheets } from "../../lib/excel/excelWorkbookService";
import { useI18n } from "../../i18n/I18n";

// The supplier reply outcome export (GET /api/admin/supplier-reply-export,
// server/services/supplier-reply-export.mjs): one sheet of replies with their
// outcomes, one of the promised-date changes in the same window with their
// source. Column names are codes, the same in both languages, so a script
// reads any export. Reply text and notes come only from a public-data
// workspace (DD-7). A third sheet, About, says what the export holds and
// whether a sheet was cut. Shown to people with settings.export.read and
// procurement.purchase_order.read, the two the server checks.

type ExportAnswer = {
  window: { from: string; to: string };
  timeZone: string | null;
  textIncluded: boolean;
  truncated: { replies: boolean; revisions: boolean };
  limit: number;
  about: Array<{ field: string; value: unknown }>;
  replies: Record<string, unknown>[];
  revisions: Record<string, unknown>[];
};
type Pair = readonly [english: string, chinese: string];

const COPY = {
  title: ["Supplier reply export", "供应商回复导出"],
  intro: ["One row per supplier reply received in the window, with what became of it, and a second sheet of the promised-date changes made in the window, by hand or from a reply.", "每条在所选期间收到的供应商回复一行，含处理结果；第二个工作表列出期间内的承诺日期修改，注明是手工修改还是来自回复。"],
  privacy: ["Codes, ids and dates only. Reply text, decision notes, supplier names and the reasons for date changes are included on public-data workspaces only.", "只含代码、编号和日期。回复原文、处理备注、供应商名称和日期修改原因只在公开数据工作区导出。"],
  from: ["From", "开始日期"],
  to: ["To", "结束日期"],
  defaultWindow: ["Leave both empty for the last 90 days.", "两项都留空则导出最近 90 天。"],
  export: ["Export", "导出"],
  exporting: ["Exporting…", "正在导出…"],
  repliesSheet: ["Supplier replies", "供应商回复"],
  revisionsSheet: ["Promise revisions", "承诺日期修改"],
  aboutSheet: ["About", "说明"],
  failed: ["Could not export the supplier replies.", "无法导出供应商回复。"],
  invalidDay: ["Enter both dates as calendar dates.", "请输入有效的日期。"],
  invalidWindow: ["The start date is after the end date.", "开始日期晚于结束日期。"],
  tooLong: ["Choose a window of at most a year.", "所选期间最长为一年。"],
} as const satisfies Record<string, Pair>;

const ERRORS: Record<string, Pair> = {
  SUPPLIER_REPLY_EXPORT_DAY_INVALID: COPY.invalidDay,
  SUPPLIER_REPLY_EXPORT_WINDOW_INVALID: COPY.invalidWindow,
  SUPPLIER_REPLY_EXPORT_WINDOW_TOO_LONG: COPY.tooLong,
};

const field = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";

export default function SupplierReplyExport() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const say = (pair: Pair) => pair[zh ? 1 : 0];
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "done" | "warn" | "error"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setStatus(null);
    try {
      // The About sheet's notes follow the interface language; codes and values do not.
      const params = new URLSearchParams({ language: zh ? "zh-CN" : "en-US" });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const answer = await apiJson<ExportAnswer>(`/api/admin/supplier-reply-export?${params}`);
      await exportWorkbookSheets(`supplier-replies-${answer.window.from}-to-${answer.window.to}`, [
        { name: say(COPY.repliesSheet), rows: answer.replies },
        { name: say(COPY.revisionsSheet), rows: answer.revisions },
        { name: say(COPY.aboutSheet), rows: answer.about },
      ], answer.timeZone || undefined);
      const counts = zh
        ? `已导出 ${answer.replies.length} 条回复和 ${answer.revisions.length} 次日期修改（${answer.window.from} 至 ${answer.window.to}）。`
        : `Exported ${answer.replies.length} ${answer.replies.length === 1 ? "reply" : "replies"} and ${answer.revisions.length} date ${answer.revisions.length === 1 ? "change" : "changes"}, ${answer.window.from} to ${answer.window.to}.`;
      // Said only of a sheet that was cut, with the rows it holds.
      const cut = [
        answer.truncated.replies && (zh ? `回复只导出了期间内最早的 ${answer.replies.length} 条。` : `The replies sheet holds only the earliest ${answer.replies.length.toLocaleString("en-US")} of the window.`),
        answer.truncated.revisions && (zh ? `日期修改只导出了期间内最早的 ${answer.revisions.length} 次。` : `The date changes sheet holds only the earliest ${answer.revisions.length.toLocaleString("en-US")} of the window.`),
      ].filter(Boolean);
      const shorter = zh ? "请缩短期间再导出其余部分。" : "Choose a shorter window for the rest.";
      setStatus(cut.length ? { tone: "warn", text: [counts, ...cut, shorter].join(" ") } : { tone: "done", text: counts });
    } catch (reason) {
      setStatus({ tone: "error", text: apiErrorText(reason, language, COPY.failed, ERRORS) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border p-4" data-testid="supplier-reply-export">
      <h2 className="text-lg font-semibold">{say(COPY.title)}</h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">{say(COPY.intro)}</p>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">{say(COPY.privacy)}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{say(COPY.from)}</span>
          <input type="date" aria-label={say(COPY.from)} data-testid="supplier-reply-export-from" className={field} value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{say(COPY.to)}</span>
          <input type="date" aria-label={say(COPY.to)} data-testid="supplier-reply-export-to" className={field} value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button type="button" data-testid="supplier-reply-export-run" disabled={busy} onClick={run} className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: A.blue }}>
          <Download size={15} />{say(busy ? COPY.exporting : COPY.export)}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">{say(COPY.defaultWindow)}</p>
      {status && <p role="status" className="mt-2 text-sm" style={{ color: status.tone === "error" ? A.red : status.tone === "warn" ? A.orange : A.green }}>{status.text}</p>}
    </div>
  );
}
