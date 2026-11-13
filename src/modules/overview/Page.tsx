import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { Link } from "react-router";
import { AlarmClock, ArrowRight, CheckCircle2, ChevronDown, Circle, ListChecks, RefreshCw } from "lucide-react";
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
import { documentStatusLabel } from "../../i18n/statusLabels";
import { reorderListText } from "../inventory/reorderListCopy";
import { useTodayCopy, type TodayCopyKey } from "./todayCopy";
import { groupsByKind, reorderRequestHref, type ReorderRequest } from "./todayRows";
import { DecisionSection, type TodayDecisions } from "./DecisionCards";
import { useTodayRowFormat } from "./todayRowFormat";

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

// An opened kind lists its first ten rows; "Show all" opens the rest.
const GROUP_ROWS = 10;

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
// An approved supplier invoice still to pay, or an issued customer invoice
// still to be paid, is in progress (blue); the shared tones do not know the
// codes.
const documentTone = (status: string) => (status === "to_pay" || status === "to_be_paid" ? "info" : statusToneOf(status));

// The value of a Today tile, at the KPI size of the list pages' cards from a
// tablet up and a step smaller three to a row on a phone.
const TILE_VALUE = "text-xl font-semibold leading-7 tabular-nums sm:text-2xl";

function TileIcon({ icon: Icon, color }: { icon: ElementType; color: string }) {
  return (
    <span aria-hidden className="mb-3 hidden h-8 w-8 items-center justify-center rounded-lg sm:flex" style={{ background: `${color}12`, color }}>
      <Icon size={15} strokeWidth={1.8} />
    </span>
  );
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
  // Today's work is one line per kind; the kinds opened, and those showing
  // every row rather than the first GROUP_ROWS.
  const [openKinds, setOpenKinds] = useState<Partial<Record<WorkKind, boolean>>>({});
  const [fullKinds, setFullKinds] = useState<Partial<Record<WorkKind, boolean>>>({});
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
  // A row's date chip and its colours, as the assistant's decision cards show them too.
  const { day, dateText, tone } = useTodayRowFormat(overview?.today || "");

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
  const shown = filter === "overdue" ? items.filter((item) => item.overdueDays > 0) : items;
  // One line per kind, in the order of each kind's earliest row.
  const groups = groupsByKind(shown);
  const toggleKind = (kind: WorkKind) => setOpenKinds((open) => ({ ...open, [kind]: !open[kind] }));
  const recent = overview?.recentDocuments || [];
  // A unit reads in the interface language (unitLabel): "35 pcs" in English.
  const quantity = (value: unknown, unit?: string | null) => `${formatQuantity(value as number)}${unit ? ` ${unitLabel(unit, t.language, Number(value))}` : ""}`;
  // Amounts use the document currency; a hidden amount (null) is never shown as 0.
  const money = (value: unknown, currency?: string | null) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "—" : formatLocaleAmount(Number(value), currency, locale, { maximumFractionDigits: 2 });
  // A reorder row opens the purchase request the reorder list's "Create
  // purchase request" opens for the item, with the same reason.
  const reorderHref = (item: WorkItem) => {
    const request = item.detail?.purchaseRequest as ReorderRequest | null | undefined;
    if (!request?.itemId) return null;
    const reason = reorderListText(t.language, "reason", { position: quantity(item.detail.position, item.detail.unit), reorderPoint: quantity(item.detail.reorderPoint, item.detail.unit), date: item.date || "" });
    return reorderRequestHref(request, reason, item.detail.shortfall);
  };

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
    { id: "all" as const, label: t("tileWork"), note: t("tileWorkNote"), value: workTotal, icon: ListChecks, color: A.blue },
    { id: "overdue" as const, label: t("tileOverdue"), note: t("tileOverdueNote"), value: overdueTotal, icon: AlarmClock, color: A.red },
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

  // The tiles read like the cards on top of every list page
  // (ActionableMetricCard): icon, count, label, note. The two counts filter the
  // list below. Decisions show their count in their own section, and the
  // documents changed today sit with Recent documents (owner 11/13: Today was
  // too full). On a phone the two sit in one short row without icons or notes.
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

      <div className="grid grid-cols-2 gap-2 sm:gap-4" data-testid="today-tiles">
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            aria-pressed={filter === tile.id}
            onClick={() => setFilter(tile.id)}
            className={`${tileClass} outline-none transition hover:bg-slate-50 focus:ring-2 focus:ring-blue-500`}
            style={{ ...tileStyle, background: filter === tile.id ? "#f0f6ff" : A.white, borderColor: filter === tile.id ? "#bfdbfe" : A.border }}
            data-testid={`today-tile-${tile.id}`}
          >
            <TileIcon icon={tile.icon} color={tile.color} />
            <div className={TILE_VALUE}>{tile.value}</div>
            <div className="fc-label mt-0.5" style={{ color: A.sub }}>{tile.label}</div>
            <div className="fc-caption mt-1 hidden sm:block" style={{ color: A.gray2 }}>{tile.note}</div>
          </button>
        ))}
      </div>

      {decisions && state === "loaded" ? (
        <div id="today-decisions" className="scroll-mt-4">
          <DecisionSection
            decisions={decisions}
            overdueOnly={filter === "overdue"}
            today={today}
            day={day}
            dateText={dateText}
            tone={tone}
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
        {state === "loading" ? (
          <div className="py-10 text-center text-xs">{t("loading")}</div>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: A.sub }}>
            <p>{filter === "overdue" ? t("noOverdueWork") : t("noWork")}</p>
            {filter === "all" ? <div className="mx-auto mt-1 max-w-md text-xs">{t("noWorkHint")}</div> : null}
          </div>
        ) : (
          // One line per kind: the earliest row's date, the kind and how many,
          // with the earliest record's link on a wide screen; opening a kind
          // lists its rows (the first GROUP_ROWS, then "Show all").
          <ul className="mt-3 divide-y" data-testid="today-work-list">
            {groups.map(({ kind, rows }) => {
              const open = Boolean(openKinds[kind]);
              const head = rows[0];
              const listed = fullKinds[kind] ? rows : rows.slice(0, GROUP_ROWS);
              return (
                <li key={kind} data-testid="today-work-group" data-kind={kind} data-count={rows.length}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleKind(kind)}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg py-2 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500"
                      data-testid="today-work-group-toggle"
                    >
                      {/* A fixed column, so every kind starts at the same place;
                          on a phone the date sits under the kind instead. */}
                      <span className="hidden w-36 shrink-0 sm:block"><span className="inline-block max-w-full rounded px-2 py-1 text-xs font-medium" style={tone(head)}>{dateText(head)}</span></span>
                      <span className="min-w-0 flex-1 text-sm font-medium">
                        <span>{t(`kind_${kind}` as TodayCopyKey)}</span>
                        {/* Rows the response left out are counted once, under the list ("{n} more are not shown"). */}
                        <span className="ml-2 text-xs font-normal" style={{ color: A.sub }} data-testid="today-work-group-count">{t("kindAll", { n: rows.length })}</span>
                        <span className="mt-1 block sm:hidden"><span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={tone(head)}>{dateText(head)}</span></span>
                      </span>
                      <ChevronDown size={16} aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} style={{ color: A.gray2 }} />
                    </button>
                    {!open ? <Link to={head.href} className={`hidden max-w-[16rem] shrink-0 truncate text-xs md:inline ${LINK}`} title={labelOf(head)}>{t("groupEarliest", { label: labelOf(head) })}</Link> : null}
                  </div>
                  {open ? (
                    <ul className="mb-2 divide-y rounded-lg sm:ml-36" style={{ background: "#f8fafc" }}>
                      {listed.map((item) => (
                        <li key={item.id} className="flex items-start gap-3 px-3 py-2.5" data-testid="today-work-item" data-kind={item.kind}>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2">
                              <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={tone(item)} data-testid="today-work-date">{dateText(item)}</span>
                              <Link to={item.href} className={`text-xs ${LINK} ${PHONE_TAP}`}>{labelOf(item)}</Link>
                            </div>
                            <div className="mt-0.5 text-xs" style={{ color: A.sub }}>{reasons(item).join(" · ")}</div>
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
                      {rows.length > GROUP_ROWS ? (
                        <li className="px-3 py-2">
                          <button type="button" className={`text-xs font-medium text-blue-600 hover:underline ${PHONE_TAP}`} onClick={() => setFullKinds((full) => ({ ...full, [kind]: !full[kind] }))} data-testid="today-work-group-all">
                            {fullKinds[kind] ? t("showFewer") : t("showAll", { n: rows.length })}
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
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
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b p-5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t("recentTitle")}</h2>
            <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("recentNote")}</p>
          </div>
          {/* How many documents changed today, and when the last change was. */}
          <div className="text-xs sm:text-right" data-testid="today-changes" title={today ? t("changesNote", { date: day(today) }) : undefined}>
            <div className="font-semibold" style={{ color: A.label }}>{t("changesCount", { n: overview?.todayChanges ?? 0 })}</div>
            {changesSub ? <div className="mt-0.5" style={{ color: A.sub }} data-testid="today-changes-note">{changesSub}</div> : null}
          </div>
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
                    {/* A customer invoice words "Issued" as the finance pages do, a purchase order as purchasing does (documentStatusLabel). */}
                    <td className={tdNowrapClass}><StatusChip label={documentStatusLabel(row.type, row.status, t.language) ?? t.status(row.status)} tone={documentTone(row.status)} /></td>
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
