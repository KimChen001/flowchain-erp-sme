import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, CheckCircle2, Circle, RefreshCw } from "lucide-react";
import { A, Card } from "../../components/ui";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import AiSuggestionsPage from "./AiSuggestionsPage";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";
import { formatDateTimeInTimeZone, formatLocaleAmount, formatQuantity } from "../../lib/format";
import { useTodayCopy, type TodayCopyKey } from "./todayCopy";

// Today: the work that needs doing, from the rules the rest of the app uses
// (GET /api/home/overview, server/domain/today-work.mjs), earliest date first;
// the first-day checklist while any setup step is open; and the documents
// changed most recently. Every row links to its record.

type Navigate = (moduleId: string, focus?: { entityType: string; entityId: string } | null, options?: any) => void;
type WorkKind =
  | "purchase_order_overdue" | "purchase_order_due" | "reorder_now" | "bill_exception" | "bill_to_approve" | "bill_to_match"
  | "bill_awaiting_receipt" | "customer_invoice_to_issue" | "receivable_overdue" | "sales_order_to_reserve" | "sales_order_to_ship"
  | "purchase_order_to_approve" | "purchase_request_to_approve" | "purchase_request_to_convert" | "draft_purchase_order"
  | "contract_notice_due" | "contract_ending" | "contract_past_end";
type WorkItem = {
  id: string;
  kind: WorkKind;
  entityType: string;
  recordId: string;
  label: string;
  name: string | null;
  href: string;
  actionHref: string | null;
  date: string | null;
  dateKind: "due" | "order_by" | "invoice" | "promised" | "required" | "notice_by" | "ends" | "ended";
  overdueDays: number;
  detail: Record<string, any>;
};
type DocumentRow = { type: string; id: string; number: string; status: string; partner: string | null; amount: number | null; currency: string; updatedAt: string; canonicalRoute: string };
type SetupStep = { id: "items" | "suppliers" | "customers" | "opening_stock" | "teammates"; count: number; done: boolean; href: string | null; blocked: "permission" | "unavailable" | null };
type HomeOverview = {
  today: string;
  workItems: WorkItem[];
  workTotal: number;
  overdue: number;
  todayChanges: number;
  recentDocuments: DocumentRow[];
  firstRun: { steps: SetupStep[]; done: number; total: number } | null;
  hidden: string[];
  limitations: string[];
  generatedAt: string;
};

// Today shows its five earliest rows; "Show all" opens the rest.
const COLLAPSED = 5;
const HIDDEN_KEYS: Record<string, TodayCopyKey> = {
  purchasing: "hiddenPurchasing",
  inventory: "hiddenInventory",
  bills: "hiddenBills",
  sales_orders: "hiddenSalesOrders",
  customer_invoices: "hiddenCustomerInvoices",
  receivables: "hiddenReceivables",
  contracts: "hiddenContracts",
};
const SOURCE_KEYS: Record<string, TodayCopyKey> = {
  reorder_list: "sourceReorder",
  customer_invoices: "sourceCustomerInvoices",
  receivables: "sourceReceivables",
  purchase_orders: "sourcePurchaseOrders",
  setup_counts: "sourceSetup",
  database: "sourceDatabase",
  contracts: "sourceContracts",
};
const LINK = "fc-entity-link font-semibold text-blue-600 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

// A workspace calendar day (YYYY-MM-DD) in the interface locale. The day is
// already the workspace's, so it is formatted as a date, not an instant.
function formatDay(day: string, locale: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(locale || "en-US", { timeZone: "UTC", dateStyle: "medium" }).format(date);
  } catch {
    return day;
  }
}

export default function OverviewPanel({ initialView = "", onNavigate, onOpenAi, onReviewActionDraft }: { initialView?: string; onNavigate: Navigate; onOpenAi: () => void; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void }) {
  if (initialView === "ai") return <AiSuggestionsPage onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} onOpenAi={onOpenAi} />;
  return <RuntimeHomepage />;
}

function RuntimeHomepage() {
  const { locale, timezone } = useI18n();
  const t = useTodayCopy();
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [filter, setFilter] = useState<"all" | "overdue">("all");
  const [expanded, setExpanded] = useState(false);
  const load = async () => {
    setState("loading");
    try {
      setOverview(await apiJson<HomeOverview>("/api/home/overview"));
      setState("loaded");
    } catch {
      setOverview(null);
      setState("error");
    }
  };
  useEffect(() => { void load(); }, []);

  if (state === "error") {
    return (
      <Card className="p-12 text-center">
        <h2 className="text-lg font-semibold">{t("loadFailed")}</h2>
        <button onClick={load} className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600"><RefreshCw size={14} />{t("retry")}</button>
      </Card>
    );
  }

  const today = overview?.today || "";
  const items = overview?.workItems || [];
  const shown = filter === "overdue" ? items.filter((item) => item.overdueDays > 0) : items;
  const visible = expanded ? shown : shown.slice(0, COLLAPSED);
  const recent = overview?.recentDocuments || [];
  const quantity = (value: unknown, unit?: string | null) => `${formatQuantity(value as number)}${unit ? ` ${unit}` : ""}`;
  // Amounts use the document currency; a hidden amount (null) is never shown as 0.
  const money = (value: unknown, currency?: string | null) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "—" : formatLocaleAmount(Number(value), currency, locale, { maximumFractionDigits: 2 });
  const day = (value: string) => formatDay(value, locale);

  const dateText = (item: WorkItem) => {
    if (!item.date) return t("noDate");
    if (item.dateKind === "due") return item.overdueDays > 0 ? t.count("overdueDays", item.overdueDays) : item.date === today ? t("dueToday") : t("dueOn", { date: day(item.date) });
    if (item.dateKind === "order_by") return item.date <= today ? t("orderToday") : t("orderBy", { date: day(item.date) });
    if (item.dateKind === "promised") return item.overdueDays > 0 ? t.count("lateDays", item.overdueDays) : item.date === today ? t("promisedToday") : t("promisedOn", { date: day(item.date) });
    if (item.dateKind === "required") return t("neededBy", { date: day(item.date) });
    if (item.dateKind === "notice_by") return item.date === today ? t("noticeToday") : t("noticeBy", { date: day(item.date) });
    if (item.dateKind === "ends") return item.date === today ? t("endsToday") : t("endsOn", { date: day(item.date) });
    if (item.dateKind === "ended") return t.count("endedDays", item.overdueDays);
    return t("invoiceOn", { date: day(item.date) });
  };
  // Red for what is late or an exception, orange for today and for approvals
  // and stock warnings, blue for the rest, gray without a date.
  const tone = (item: WorkItem) => {
    if (item.overdueDays > 0 || item.kind === "bill_exception") return { color: "#b91c1c", background: "#fef2f2" };
    if (item.date === today || item.kind === "reorder_now" || item.kind.endsWith("_to_approve")) return { color: "#b45309", background: "#fffbeb" };
    if (!item.date) return { color: A.gray1, background: A.gray6 };
    return { color: "#1d4ed8", background: "#eff6ff" };
  };

  const reasons = (item: WorkItem): string[] => {
    const d = item.detail || {};
    const supplier = item.name ? t("supplier", { name: item.name }) : null;
    const customer = item.name ? t("customer", { name: item.name }) : null;
    const amount = d.amount === null || d.amount === undefined ? null : t("amount", { amount: money(d.amount, d.currency) });
    const lines: Array<string | null> = (() => {
      switch (item.kind) {
        case "purchase_order_overdue":
        case "purchase_order_due":
          return [
            d.remaining !== null && d.remaining !== undefined ? t("stillToReceive", { qty: quantity(d.remaining, d.unit) }) : t.count("linesToReceive", Number(d.openLines) || 0),
            d.received > 0 && d.ordered !== null && d.ordered !== undefined ? t("receivedOf", { received: formatQuantity(d.received), ordered: quantity(d.ordered, d.unit) }) : null,
            d.notIssued ? t("notIssued") : null,
            supplier,
          ];
        case "reorder_now":
          return [
            item.name,
            t("position", { position: quantity(d.position, d.unit), reorderPoint: quantity(d.reorderPoint, d.unit) }),
            d.stockSignal === "stock_below_safety" ? t("belowSafety") : d.stockSignal === "stock_shortage" ? t("shortage") : null,
          ];
        case "bill_awaiting_receipt": return [t("billAwaitingReceipt"), amount, supplier];
        case "bill_to_match": return [t("billToMatch"), amount, supplier];
        case "bill_to_approve": return [t("billToApprove"), amount, supplier];
        case "bill_exception": return [t("billException"), amount, supplier];
        case "customer_invoice_to_issue": return [t("issueToCustomer"), amount, customer];
        case "receivable_overdue": return [d.outstanding === null || d.outstanding === undefined ? t("owedHidden") : t("owed", { amount: money(d.outstanding, d.currency) }), d.disputed ? t("disputed") : null, customer];
        case "sales_order_to_reserve": return [d.quantity === null || d.quantity === undefined ? t.count("linesToReserve", Number(d.lines) || 0) : t("toReserve", { qty: quantity(d.quantity, d.unit) }), customer];
        case "sales_order_to_ship": return [d.quantity === null || d.quantity === undefined ? t.count("linesToShip", Number(d.lines) || 0) : t("toShip", { qty: quantity(d.quantity, d.unit) }), customer];
        case "purchase_order_to_approve": return [t("awaitingApproval"), supplier];
        case "purchase_request_to_approve": return [amount === null ? null : t("requestAmount", { amount: money(d.amount, d.currency) })];
        case "purchase_request_to_convert": return [t("requestConvert")];
        case "draft_purchase_order": return [supplier];
        case "contract_notice_due": return [d.title, supplier, d.endDate ? t("renewsUnlessNotice", { date: day(d.endDate) }) : null];
        case "contract_ending": return [d.title, supplier, d.renewal === "by_agreement" ? t("renewByAgreement") : null];
        case "contract_past_end": return [d.title, supplier, d.renewal === "automatic" ? t("recordNewEnd") : t("recordOutcome")];
        default: return [];
      }
    })();
    return lines.filter((line): line is string => Boolean(line));
  };

  const notes: ReactNode[] = [];
  if (overview?.hidden?.length) notes.push(t("hiddenNote", { kinds: overview.hidden.map((code) => (HIDDEN_KEYS[code] ? t(HIDDEN_KEYS[code]) : code)).join(", ") }));
  if (overview?.limitations?.includes("reorder_not_checked_for_warehouse_scope")) notes.push(t("reorderScope"));
  const unavailable = (overview?.limitations || []).filter((code) => code.startsWith("today_source_unavailable:")).map((code) => code.slice("today_source_unavailable:".length));
  if (overview?.limitations?.includes("today_database_sources_unavailable")) unavailable.push("database");
  if (unavailable.length) notes.push(t("notChecked", { sources: [...new Set(unavailable)].map((code) => (SOURCE_KEYS[code] ? t(SOURCE_KEYS[code]) : code)).join(", ") }));
  const truncated = (overview?.limitations || []).filter((code) => /^truncated:(customer_invoices|receivables|contracts)$/.test(code));
  if (truncated.length) notes.push(t("truncated", { subjects: truncated.map((code) => t(code.endsWith("contracts") ? "sourceContracts" : code.endsWith("receivables") ? "sourceReceivables" : "sourceCustomerInvoices")).join(", ") }));

  const tiles = [
    { id: "all" as const, label: t("tileWork"), note: t("tileWorkNote"), value: overview?.workTotal ?? 0 },
    { id: "overdue" as const, label: t("tileOverdue"), note: t("tileOverdueNote"), value: overview?.overdue ?? 0 },
  ];

  // The tiles read like the cards on top of every list page, white and
  // full-width; the two counts filter the list below.
  const tileClass = "flex flex-col items-start justify-start rounded-xl border bg-white p-4 text-left";
  const tileStyle = { borderColor: A.border, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" };

  return (
    <div data-testid="runtime-homepage" className="space-y-4">
      {overview?.firstRun ? (
        <Card className="p-5" data-testid="first-run-checklist">
          <h2 className="text-sm font-semibold">{t("setupTitle")}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("setupNote", { done: overview.firstRun.done, total: overview.firstRun.total })}</p>
          <ol className="mt-3 grid gap-2 md:grid-cols-5">
            {overview.firstRun.steps.map((step, index) => (
              <li key={step.id} data-testid={`first-run-step-${step.id}`} data-done={step.done ? "true" : "false"} className="rounded-md border p-3" style={{ borderColor: A.gray4 }}>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {step.done ? <CheckCircle2 size={16} style={{ color: "#0F766E" }} aria-hidden /> : <Circle size={16} style={{ color: A.gray2 }} aria-hidden />}
                  <span>{index + 1}. {t(`step_${step.id}` as TodayCopyKey)}</span>
                </div>
                <div className="mt-1 text-xs" style={{ color: step.done ? "#0F766E" : A.sub }}>{step.done ? t("stepDone", { n: step.count }) : t("stepOpen")}</div>
                {!step.done ? (step.href ? <Link to={step.href} className={`mt-2 inline-block text-xs ${LINK}`}>{t("stepStart")}</Link> : <div className="mt-2 text-xs" style={{ color: A.sub }}>{t(step.blocked === "unavailable" ? "stepUnavailable" : "stepAskAdmin")}</div>) : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3" data-testid="today-tiles">
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            aria-pressed={filter === tile.id}
            onClick={() => { setFilter(tile.id); setExpanded(false); }}
            className={`${tileClass} outline-none transition hover:bg-slate-50 focus:ring-2 focus:ring-blue-500`}
            style={{ ...tileStyle, background: filter === tile.id ? "#f0f6ff" : A.white, borderColor: filter === tile.id ? "#bfdbfe" : A.border }}
            data-testid={`today-tile-${tile.id}`}
          >
            <div className="text-xs" style={{ color: A.sub }}>{tile.label}</div>
            <div className="mt-1 text-2xl font-semibold">{tile.value}</div>
            <div className="mt-1 text-xs" style={{ color: A.gray2 }}>{tile.note}</div>
          </button>
        ))}
        <div className={tileClass} style={tileStyle} data-testid="today-tile-changes" title={today ? t("changesNote", { date: day(today) }) : undefined}>
          <div className="text-xs" style={{ color: A.sub }}>{t("tileChanges")}</div>
          <div className="mt-1 text-2xl font-semibold">{overview?.todayChanges ?? 0}</div>
          {today ? <div className="mt-1 text-xs" style={{ color: A.gray2 }}>{t("changesShort", { date: day(today) })}</div> : null}
        </div>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t("workTitle")}</h2>
            <p className="mt-0.5 text-xs" style={{ color: A.sub }}>{t("workNote")}</p>
          </div>
          <button onClick={load} aria-label={t("refresh")}><RefreshCw size={15} /></button>
        </div>
        {state === "loading" ? (
          <div className="py-10 text-center text-xs">{t("loading")}</div>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: A.sub }}>
            <p>{filter === "overdue" ? t("noOverdueWork") : t("noWork")}</p>
            {filter === "all" ? <div className="mx-auto mt-1 max-w-md text-xs">{t("noWorkHint")}</div> : null}
          </div>
        ) : (
          <ul className="mt-3 divide-y" data-testid="today-work-list">
            {visible.map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-3" data-testid="today-work-item" data-kind={item.kind}>
                {/* A fixed column, so every row's title starts at the same place;
                    on a phone the date sits above the title instead. */}
                <div className="mt-0.5 hidden w-48 shrink-0 sm:block" data-testid="today-work-date">
                  <span className="inline-block max-w-full rounded px-2 py-1 text-xs font-medium" style={tone(item)}>{dateText(item)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <span className="mb-1 inline-block rounded px-2 py-0.5 text-xs font-medium sm:hidden" style={tone(item)}>{dateText(item)}</span>
                  <div className="text-sm font-medium">{t(`kind_${item.kind}` as TodayCopyKey)}</div>
                  <Link to={item.href} className={`mt-0.5 inline-block text-xs ${LINK}`}>{item.label}</Link>
                  <div className="text-xs" style={{ color: A.sub }}>{reasons(item).join(" · ")}</div>
                  {item.actionHref ? <Link to={item.actionHref} className={`text-xs ${LINK}`}>{t("openReorderList")}</Link> : null}
                </div>
                <Link to={item.href} className="p-1" aria-label={item.label}><ArrowRight size={16} /></Link>
              </li>
            ))}
          </ul>
        )}
        {state === "loaded" && shown.length > COLLAPSED ? (
          <button className="mt-2 text-xs text-blue-600" onClick={() => setExpanded((value) => !value)}>{expanded ? t("showFewer") : t("showAll", { n: shown.length })}</button>
        ) : null}
        {state === "loaded" && filter === "all" && overview && overview.workTotal > items.length ? (
          <div className="mt-2 text-xs" style={{ color: A.sub }}>{t("moreNotShown", { n: overview.workTotal - items.length })}</div>
        ) : null}
        {state === "loaded" && notes.length ? (
          <div className="mt-3 space-y-1 border-t pt-3 text-xs" style={{ color: A.sub }} data-testid="today-work-notes">
            {notes.map((note, index) => <p key={index}>{note}</p>)}
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b p-5">
          <h2 className="text-sm font-semibold">{t("recentTitle")}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("recentNote")}</p>
        </div>
        {state === "loading" ? (
          <div className="py-10 text-center text-xs">{t("loading")}</div>
        ) : recent.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: A.sub }}><p>{t("recentEmpty")}</p><p className="text-xs">{t("recentEmptyHint")}</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="recent-documents">
              <thead>
                <tr>{(["colType", "colNumber", "colStatus", "colPartner", "colAmount", "colUpdated"] as const).map((key) => <th key={key} className="p-3 text-left">{t(key)}</th>)}</tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={`${row.type}-${row.id}`} className="border-t">
                    <td className="p-3">{t(`type_${row.type}` as TodayCopyKey) || row.type}</td>
                    <td className="p-3"><Link to={row.canonicalRoute} className={LINK}>{row.number}</Link></td>
                    <td className="p-3">{t.status(row.status)}</td>
                    <td className="p-3">{row.partner || "—"}</td>
                    <td className="p-3">{money(row.amount, row.currency)}</td>
                    <td className="p-3">{formatDateTimeInTimeZone(row.updatedAt, locale, timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
