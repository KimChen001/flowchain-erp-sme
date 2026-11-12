import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, CheckCircle2, Circle, RefreshCw } from "lucide-react";
import { A, Card } from "../../components/ui";
import { StatusChip, listHeadRowStyle, listRowClass, listRowStyle, statusToneOf } from "../../components/ui/listLayout";
import { listTableCardsRef, tableBodyTextClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import AiSuggestionsPage from "./AiSuggestionsPage";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";
import { useDocumentNumbers } from "../../lib/documentNumbers";
import { formatDateTimeInTimeZone, formatLocaleAmount, formatQuantity, instantDayInTimeZone } from "../../lib/format";
import { unitLabel } from "../../i18n/unitLabels";
import { reorderListText } from "../inventory/reorderListCopy";
import { formatTodayDay, todayDateText, todayDateTone, useTodayCopy, type TodayCopyKey } from "./todayCopy";
import { firstRowsByKind, reorderRequestHref, rowsPerKind, type ReorderRequest } from "./todayRows";
import { DecisionSection, type TodayDecisions } from "./DecisionCards";
import { useDecisionCopy } from "./decisionCopy";

// Today: the work that needs doing, from the rules the rest of the app uses
// (GET /api/home/overview, server/domain/today-work.mjs), earliest date first,
// with the earliest row of every kind among the first rows; the first-day
// checklist while any setup step is open; and the documents changed most
// recently. Every row links to its record.

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
  // The rows FlowChain prepared a next step for, and those set aside
  // (DecisionCards.tsx); without a database, { available: false } and
  // every row stays in Today's work.
  decisions?: TodayDecisions;
  hidden: string[];
  limitations: string[];
  generatedAt: string;
};

// Today shows five rows, the earliest of every kind among them (more when
// there are more kinds); "Show all" opens the rest.
const COLLAPSED = 5;

// One request for the overview at a time. Opening Today from the menu
// (/app/overview) draws the page, then the redirect to /app/overview/risks
// draws it again: the second waits for the answer the first asked for
// instead of asking again (two at once made each take twice as long).
let overviewRequest: Promise<HomeOverview> | null = null;
function requestOverview() {
  if (!overviewRequest) overviewRequest = apiJson<HomeOverview>("/api/home/overview").finally(() => { overviewRequest = null; });
  return overviewRequest;
}
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
// A text link or button at least 36 px tall on a phone, for a finger.
const PHONE_TAP = "max-sm:inline-flex max-sm:min-h-9 max-sm:items-center";
// An approved supplier invoice still to pay is in progress (blue); the
// shared tones do not know the code.
const documentTone = (status: string) => (status === "to_pay" ? "info" : statusToneOf(status));

export default function OverviewPanel({ initialView = "", onNavigate, onOpenAi, onReviewActionDraft }: { initialView?: string; onNavigate: Navigate; onOpenAi: () => void; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void }) {
  if (initialView === "ai") return <AiSuggestionsPage onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} onOpenAi={onOpenAi} />;
  return <RuntimeHomepage />;
}

function RuntimeHomepage() {
  const { locale, timezone } = useI18n();
  const t = useTodayCopy();
  const d = useDecisionCopy();
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [filter, setFilter] = useState<"all" | "overdue">("all");
  // One kind of work only, chosen from a row's "{n} in all".
  const [kindFilter, setKindFilter] = useState<WorkKind | null>(null);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);
  // After a decision Today reloads quietly, so the cards do not flash.
  const load = async (quiet = false) => {
    if (!quiet) setState("loading");
    try {
      const next = await requestOverview();
      if (!mounted.current) return;
      setOverview(next);
      setState("loaded");
    } catch {
      if (!mounted.current) return;
      setOverview(null);
      setState("error");
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, []);
  const decisions = overview?.decisions?.available ? overview.decisions : null;
  const waiting = decisions?.waiting || [];
  const setAside = decisions?.setAside || [];
  // A work item labelled with a purchase request's, RFQ's or order's id shows its document number.
  const labelled = [...(overview?.workItems || []), ...waiting.map((entry) => entry.row as WorkItem), ...setAside.map((entry) => entry.row as WorkItem)];
  const shownNumber = useDocumentNumbers(labelled.filter((item) => item.label === item.recordId).map((item) => [item.entityType, item.recordId] as const));
  const labelOf = (item: WorkItem) => item.label === item.recordId ? shownNumber(item.entityType, item.recordId) || item.label : item.label;

  if (state === "error") {
    return (
      <Card className="p-12 text-center">
        <h2 className="text-lg font-semibold">{t("loadFailed")}</h2>
        <button onClick={() => load()} className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600"><RefreshCw size={14} />{t("retry")}</button>
      </Card>
    );
  }

  const today = overview?.today || "";
  // Rows with a decision card, or set aside, leave Today's work.
  const decisionKeys = new Set([...waiting, ...setAside].map((entry) => entry.key));
  const items = (overview?.workItems || []).filter((item) => !decisionKeys.has(`${item.kind}:${item.recordId}`));
  const workTotal = Math.max(0, (overview?.workTotal ?? 0) - decisionKeys.size);
  const overdueTotal = Math.max(0, (overview?.overdue ?? 0) - setAside.filter((entry) => entry.row.overdueDays > 0).length);
  const byTile = filter === "overdue" ? items.filter((item) => item.overdueDays > 0) : items;
  const shown = kindFilter ? byTile.filter((item) => item.kind === kindFilter) : byTile;
  // Collapsed: the earliest row of every kind, then the next earliest.
  const firstRows = kindFilter ? shown.slice(0, COLLAPSED) : firstRowsByKind(shown, COLLAPSED);
  const visible = expanded ? shown : firstRows;
  // A kind's count shows once, on its first row in the list.
  const leadRows = new Set(visible.filter((item, index) => visible.findIndex((other) => other.kind === item.kind) === index).map((item) => item.id));
  const perKind = rowsPerKind(byTile);
  // The response holds every row, so a kind's count is its true total.
  const complete = !overview || overview.workTotal <= (overview.workItems || []).length;
  const recent = overview?.recentDocuments || [];
  // A unit reads in the interface language (unitLabel): "35 pcs" in English.
  const quantity = (value: unknown, unit?: string | null) => `${formatQuantity(value as number)}${unit ? ` ${unitLabel(unit, t.language, Number(value))}` : ""}`;
  // Amounts use the document currency; a hidden amount (null) is never shown as 0.
  const money = (value: unknown, currency?: string | null) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "—" : formatLocaleAmount(Number(value), currency, locale, { maximumFractionDigits: 2 });
  const day = (value: string) => formatTodayDay(value, locale);
  // A reorder row opens the purchase request the reorder list's "Create
  // purchase request" opens for the item, with the same reason.
  const reorderHref = (item: WorkItem) => {
    const request = item.detail?.purchaseRequest as ReorderRequest | null | undefined;
    if (!request?.itemId) return null;
    const reason = reorderListText(t.language, "reason", { position: quantity(item.detail.position, item.detail.unit), reorderPoint: quantity(item.detail.reorderPoint, item.detail.unit), date: item.date || "" });
    return reorderRequestHref(request, reason, item.detail.shortfall);
  };
  const showKind = (kind: WorkKind) => { setKindFilter(kind); setExpanded(true); };

  // The date and its colour, as AI priorities shows them too (todayCopy.ts).
  const dateText = (item: WorkItem) => todayDateText(t.language, locale, item, today);
  const tone = (item: WorkItem) => todayDateTone(item, today);

  const reasons = (item: WorkItem): string[] => {
    const d = item.detail || {};
    const supplier = item.name ? t.partner("supplier", item.name) : null;
    const customer = item.name ? t.partner("customer", item.name) : null;
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
    { id: "all" as const, label: t("tileWork"), note: t("tileWorkNote"), value: workTotal },
    { id: "overdue" as const, label: t("tileOverdue"), note: t("tileOverdueNote"), value: overdueTotal },
  ];
  // Under the count of documents changed today: when the last change was, from
  // the newest recent document (the same documents the count reads), never
  // just today's date. With none today it says so, with the last change's day.
  const lastChange = recent[0]?.updatedAt || "";
  const lastChangeDay = instantDayInTimeZone(lastChange, timezone);
  const changesSub = !today
    ? ""
    : (overview?.todayChanges ?? 0) > 0
      ? (lastChange ? t("changesShort", { when: formatDateTimeInTimeZone(lastChange, locale, timezone) }) : "")
      : lastChangeDay && lastChangeDay < today
        ? t("changesNoneLast", { date: day(lastChangeDay) })
        : t("changesNone");

  // The tiles read like the cards on top of every list page, white and
  // full-width; the two counts filter the list below. On a phone the three
  // sit in one short row without their notes, so the first task shows on the
  // first screen.
  const tileClass = "flex min-w-0 flex-col items-start justify-start rounded-xl border bg-white p-3 text-left sm:p-4";
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

      <div className={`grid gap-2 sm:gap-4 ${decisions ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`} data-testid="today-tiles">
        {decisions ? (
          <a href="#today-decisions" className={`${tileClass} outline-none transition hover:bg-slate-50 focus:ring-2 focus:ring-blue-500 !no-underline`} style={{ ...tileStyle, borderColor: waiting.length ? "#bfdbfe" : A.border }} data-testid="today-tile-decisions">
            <div className="text-xs" style={{ color: A.sub }}>{d("tile")}</div>
            <div className="mt-1 text-xl font-semibold sm:text-2xl" style={{ color: waiting.length ? "#1d4ed8" : undefined }}>{waiting.length}</div>
            <div className="mt-1 hidden text-xs sm:block" style={{ color: A.gray2 }}>{d("tileNote")}</div>
          </a>
        ) : null}
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            aria-pressed={filter === tile.id && !kindFilter}
            onClick={() => { setFilter(tile.id); setKindFilter(null); setExpanded(false); }}
            className={`${tileClass} outline-none transition hover:bg-slate-50 focus:ring-2 focus:ring-blue-500`}
            style={{ ...tileStyle, background: filter === tile.id && !kindFilter ? "#f0f6ff" : A.white, borderColor: filter === tile.id && !kindFilter ? "#bfdbfe" : A.border }}
            data-testid={`today-tile-${tile.id}`}
          >
            <div className="text-xs" style={{ color: A.sub }}>{tile.label}</div>
            <div className="mt-1 text-xl font-semibold sm:text-2xl">{tile.value}</div>
            <div className="mt-1 hidden text-xs sm:block" style={{ color: A.gray2 }}>{tile.note}</div>
          </button>
        ))}
        <div className={tileClass} style={tileStyle} data-testid="today-tile-changes" title={today ? t("changesNote", { date: day(today) }) : undefined}>
          <div className="text-xs" style={{ color: A.sub }}>{t("tileChanges")}</div>
          <div className="mt-1 text-xl font-semibold sm:text-2xl">{overview?.todayChanges ?? 0}</div>
          {changesSub ? <div className="mt-1 hidden text-xs sm:block" style={{ color: A.gray2 }} data-testid="today-tile-changes-note">{changesSub}</div> : null}
        </div>
      </div>

      {decisions && state === "loaded" ? (
        <div id="today-decisions" className="scroll-mt-4">
          <DecisionSection
            decisions={decisions}
            overdueOnly={filter === "overdue"}
            today={today}
            day={day}
            dateText={(row) => dateText(row as WorkItem)}
            tone={(row) => tone(row as WorkItem)}
            kindLabel={(row) => t(`kind_${row.kind}` as TodayCopyKey)}
            labelOf={(row) => labelOf(row as WorkItem)}
            onChanged={() => { void load(true); }}
          />
        </div>
      ) : null}

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t("workTitle")}</h2>
            <p className="mt-0.5 text-xs" style={{ color: A.sub }}>{t("workNote")}</p>
          </div>
          <button onClick={() => load()} aria-label={t("refresh")} title={t("refresh")} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100"><RefreshCw size={15} /></button>
        </div>
        {state === "loaded" && kindFilter ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs" style={{ background: "#f0f6ff", color: A.label }} data-testid="today-kind-filter">
            <span>{t("kindShowing", { kind: t(`kind_${kindFilter}` as TodayCopyKey) })}</span>
            <button type="button" className="font-semibold text-blue-600 hover:underline" onClick={() => { setKindFilter(null); setExpanded(false); }}>{t("kindShowEvery")}</button>
          </div>
        ) : null}
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
                <div className="mt-0.5 hidden w-36 shrink-0 sm:block" data-testid="today-work-date">
                  <span className="inline-block max-w-full rounded px-2 py-1 text-xs font-medium" style={tone(item)}>{dateText(item)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <span className="mb-1 inline-block rounded px-2 py-0.5 text-xs font-medium sm:hidden" style={tone(item)}>{dateText(item)}</span>
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                    <span>{t(`kind_${item.kind}` as TodayCopyKey)}</span>
                    {/* How many rows of this kind there are, on the kind's first row; it lists only those. */}
                    {!kindFilter && leadRows.has(item.id) && (perKind.get(item.kind) || 0) > 1 ? (
                      <button type="button" onClick={() => showKind(item.kind)} className={`text-xs font-medium text-blue-600 hover:underline ${PHONE_TAP} max-sm:px-1`} data-testid="today-kind-all">
                        {complete ? t("kindAll", { n: perKind.get(item.kind) || 0 }) : t("kindOnly")}
                      </button>
                    ) : null}
                  </div>
                  <Link to={item.href} className={`mt-0.5 inline-block text-xs ${LINK}`}>{labelOf(item)}</Link>
                  <div className="text-xs" style={{ color: A.sub }}>{reasons(item).join(" · ")}</div>
                  {item.kind === "reorder_now" || item.actionHref ? (
                    // Each link 36 px tall on a phone, with room between them.
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs max-sm:gap-x-6">
                      {item.kind === "reorder_now" && reorderHref(item) ? <Link to={reorderHref(item)!} className={`${LINK} ${PHONE_TAP}`} data-testid="today-reorder-request">{t("createRequest")}</Link> : null}
                      {item.actionHref ? <Link to={item.actionHref} className={`${LINK} ${PHONE_TAP}`} data-testid="today-reorder-list">{t("openReorderList")}</Link> : null}
                    </div>
                  ) : null}
                </div>
                <Link to={item.href} className="p-1" aria-label={labelOf(item)}><ArrowRight size={16} /></Link>
              </li>
            ))}
          </ul>
        )}
        {state === "loaded" && shown.length > firstRows.length ? (
          <button className="mt-2 text-xs text-blue-600" onClick={() => setExpanded((value) => !value)}>{expanded ? t("showFewer") : t("showAll", { n: shown.length })}</button>
        ) : null}
        {state === "loaded" && filter === "all" && overview && workTotal > items.length ? (
          <div className="mt-2 text-xs" style={{ color: A.sub }}>{t("moreNotShown", { n: workTotal - items.length })}</div>
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
          // On a phone each document is a card: its number and status on top,
          // the other columns as labelled lines (listTableCardsRef).
          <div className="overflow-x-auto" ref={listTableCardsRef}>
            <table className={`w-full min-w-[860px] text-left ${tableBodyTextClass}`} data-testid="recent-documents">
              <thead>
                <tr style={listHeadRowStyle}>{(["colType", "colNumber", "colStatus", "colPartner", "colAmount", "colUpdated"] as const).map((key) => <th key={key} className={key === "colAmount" ? thRightClass : thClass} style={{ color: A.gray1 }} {...(key === "colNumber" ? { "data-card-title": "" } : {})}>{t(key)}</th>)}</tr>
              </thead>
              <tbody>
                {recent.map((row, index) => (
                  <tr key={`${row.type}-${row.id}`} className={listRowClass} style={listRowStyle(index, recent.length)}>
                    <td className={tdNameClass} style={{ color: A.sub }}>{t(`type_${row.type}` as TodayCopyKey) || row.type}</td>
                    <td className={tdIdClass}><Link to={row.canonicalRoute} className={LINK}>{row.number}</Link></td>
                    <td className={tdNowrapClass}><StatusChip label={t.status(row.status)} tone={documentTone(row.status)} /></td>
                    <td className={`${tdNameClass} max-w-[240px] truncate`} title={row.partner || undefined}>{row.partner || "—"}</td>
                    <td className={tdNumericRightClass}>{money(row.amount, row.currency)}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{formatDateTimeInTimeZone(row.updatedAt, locale, timezone)}</td>
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
