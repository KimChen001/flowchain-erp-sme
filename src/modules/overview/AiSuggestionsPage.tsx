import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, RefreshCw, Sparkles } from "lucide-react";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";
import { useDocumentNumbers } from "../../lib/documentNumbers";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import { todayDateText, todayDateTone, useTodayCopy, type TodayCopyKey, type TodayDated } from "./todayCopy";
import { firstRowsByKind } from "./todayRows";

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: unknown) => void;
type WorkItem = TodayDated & { id: string; entityType: string; recordId: string; label: string; name: string | null; href: string };
type HomeOverview = { today?: string; workItems: WorkItem[]; workTotal: number; overdue: number; decisions?: { available: boolean; waiting?: Array<{ key: string }>; setAside?: Array<{ key: string }> } };

// AI priorities: the first rows of Today's work (GET /api/home/overview, the
// rules the rest of the app uses), the same rows Today shows before "Show
// all": the earliest row of every kind of work, then the next earliest
// (firstRowsByKind), each with its date and opening its record, with links to
// Today and the reorder list and to the assistant. Nothing is made up here:
// no row appears that Today does not list.
const SHOWN = 5;
// English source copy with its Chinese translation.
const COPY = {
  en: {
    title: "Priorities from Today's work",
    body: "The actions below come from Today's work: purchase orders past or near their date, items to reorder, supplier and customer invoices and sales orders to ship. Each row opens its record.",
    summary: "{total} actions need attention, {overdue} of them overdue.",
    summaryOne: "1 action needs attention.",
    summaryOneOverdue: "1 action needs attention, and it is overdue.",
    shownNote: "The first {shown} of {total}, as Today shows them: every kind of work, earliest date first.",
    openToday: "Open Today's work",
    openReorder: "Open the reorder list",
    ask: "Ask the AI assistant",
    askNote: "The assistant reads the same records and can draft the next step for you to confirm.",
    none: "Nothing needs attention right now",
    noneNote: "When a purchase order is due, an item needs reordering or an invoice waits, it is listed here.",
    loading: "Loading priorities",
    failed: "Could not load priorities",
    retry: "Retry",
  },
  zh: {
    title: "今日需处理中的重点",
    body: "以下事项来自今日需处理：逾期或即将到期的采购订单、需补货物料、采购发票和销售发票，以及待发货的销售订单。每行可打开对应记录。",
    summary: "共有 {total} 项需处理，其中 {overdue} 项已逾期。",
    summaryOne: "共有 1 项需处理。",
    summaryOneOverdue: "共有 1 项需处理，且已逾期。",
    shownNote: "显示 {total} 项中的前 {shown} 项，与今日需处理相同：包含每一类事项，日期最早的在前。",
    openToday: "打开今日需处理",
    openReorder: "打开补货清单",
    ask: "询问 AI 助手",
    askNote: "AI 助手读取同样的记录，可以起草下一步操作供你确认。",
    none: "暂无需要处理的事项",
    noneNote: "采购订单到期、物料需要补货或发票待处理时，会显示在这里。",
    loading: "正在加载重点事项",
    failed: "重点事项加载失败",
    retry: "重试",
  },
};

export default function AiSuggestionsPage({ onOpenAi }: { onNavigate: NavigateFn; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; onOpenAi?: () => void }) {
  const { language, locale } = useI18n();
  const copy = COPY[language === "zh-CN" ? "zh" : "en"];
  // A whole sentence with its figures filled in.
  const fill = (template: string, values: Record<string, string>) => Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template);
  const t = useTodayCopy();
  const count = new Intl.NumberFormat(locale);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const load = async () => {
    setState("loading");
    try { setOverview(await apiJson<HomeOverview>("/api/home/overview")); setState("loaded"); } catch { setOverview(null); setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  // A row with a decision card, or set aside, has left Today's work list
  // (DecisionCards.tsx), so it is not among these rows either.
  const decided = new Set(overview?.decisions?.available ? [...(overview.decisions.waiting || []), ...(overview.decisions.setAside || [])].map((entry) => entry.key) : []);
  const items = (overview?.workItems || []).filter((item) => !decided.has(`${item.kind}:${item.recordId}`));
  const today = overview?.today || "";
  // Today's first rows: the earliest of every kind, then the next earliest.
  const shown = firstRowsByKind(items, SHOWN);
  const shownNumber = useDocumentNumbers(shown.filter((item) => item.label === item.recordId).map((item) => [item.entityType, item.recordId] as const));
  const labelOf = (item: WorkItem) => item.label === item.recordId ? shownNumber(item.entityType, item.recordId) || item.label : item.label;
  const total = overview?.workTotal ?? items.length;
  const overdue = overview?.overdue ?? 0;
  const reorder = items.some((item) => item.kind === "reorder_now");
  const linkClass = "text-xs font-semibold text-blue-600 hover:underline";

  return <div className="space-y-4" data-testid="ai-priorities">
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <Sparkles size={20} color={A.blue} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{copy.title}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy.body}</p>
          {state === "loaded" && total > 0 && <p className="mt-2 text-sm font-medium" data-testid="ai-priorities-summary">{total === 1 ? (overdue ? copy.summaryOneOverdue : copy.summaryOne) : fill(copy.summary, { total: count.format(total), overdue: count.format(overdue) })}</p>}
        </div>
      </div>
      {state === "loading" && <p className="py-8 text-center text-xs" style={{ color: A.sub }}>{copy.loading}</p>}
      {state === "error" && <div className="py-8 text-center"><p className="text-sm font-semibold">{copy.failed}</p><button type="button" onClick={() => void load()} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600"><RefreshCw size={13} />{copy.retry}</button></div>}
      {state === "loaded" && !items.length && <div className="py-8 text-center"><p className="text-sm" style={{ color: A.sub }}>{copy.none}</p><p className="mx-auto mt-1 max-w-md text-xs" style={{ color: A.gray2 }}>{copy.noneNote}</p></div>}
      {state === "loaded" && items.length > 0 && <>
        <ul className="mt-4 divide-y" data-testid="ai-priorities-list">
          {shown.map((item) => <li key={item.id} className="flex items-start gap-3 py-3" data-kind={item.kind}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{t(`kind_${item.kind}` as TodayCopyKey)}<span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={todayDateTone(item, today)} data-testid="ai-priorities-date">{todayDateText(t.language, locale, item, today)}</span></div>
              <Link to={item.href} className="mt-0.5 inline-block text-xs font-semibold text-blue-600 hover:underline">{labelOf(item)}</Link>
              {item.name && <div className="text-xs" style={{ color: A.sub }}>{item.name}</div>}
            </div>
            <Link to={item.href} className="p-1" aria-label={labelOf(item)}><ArrowRight size={16} /></Link>
          </li>)}
        </ul>
        {total > shown.length && <p className="text-[11px]" style={{ color: A.gray2 }}>{fill(copy.shownNote, { shown: count.format(shown.length), total: count.format(total) })}</p>}
        <div className="mt-3 flex flex-wrap gap-4"><Link to="/app/overview/risks" className={linkClass}>{copy.openToday} →</Link>{reorder && <Link to="/app/inventory/reorder" className={linkClass}>{copy.openReorder} →</Link>}</div>
      </>}
    </Card>
    {onOpenAi && <Card className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-xs" style={{ color: A.sub }}>{copy.askNote}</p><button type="button" onClick={onOpenAi} className="rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white">{copy.ask}</button></Card>}
  </div>;
}
