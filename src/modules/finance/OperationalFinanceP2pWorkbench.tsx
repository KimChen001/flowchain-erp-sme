import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";

type Landing = {
  dataSource: string;
  cards: Record<string, number>;
  currencyLimitations: {
    currencies: string[];
    aggregationStatus: string;
    fxConverted: false;
    message: string;
  };
  settlementClaims: {
    payableMeansPaid: false;
    receivableMeansCollected: false;
  };
};
type ListPayload = {
  items: Array<Record<string, any>>;
  total: number;
  capabilities: Record<string, { enabled?: boolean }>;
};
const value = (row: Record<string, any>, ...keys: string[]) =>
  keys.map((key) => row[key]).find((entry) => entry !== undefined && entry !== null);
const query = () => window.location.search.replace(/^\?/, "");
// A hidden or missing amount is null and shows as a dash, never as 0.
const money = (amount: unknown, currency: unknown, locale: string) => {
  if (amount === null || amount === undefined || amount === "") return "—";
  const code = String(currency || "");
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "—";
  return /^[A-Z]{3}$/.test(code)
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 4,
      }).format(numeric)
    : `${amount} ${code}`.trim();
};
type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];
const tokenKeys: Record<string, TranslationKey> = {
  draft: "finance.status.draft",
  submitted: "finance.status.submitted",
  matched: "finance.status.matched",
  exception: "finance.status.exception",
  approved: "finance.status.approved",
  held: "finance.status.held",
  export_ready: "finance.status.export_ready",
  open: "finance.status.open",
  reviewed: "finance.status.reviewed",
  resolved: "finance.status.resolved",
  cancelled: "finance.status.cancelled",
  revise: "finance.action.revise",
  submit: "finance.action.submit",
  match: "finance.action.match",
  approve: "finance.action.approve",
  cancel: "finance.action.cancel",
  hold: "finance.action.hold",
  mark_export_ready: "finance.action.mark_export_ready",
  release: "finance.action.release",
};

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 shrink-0" size={16} />
      <span>{children}</span>
    </div>
  );
}

export function FinanceLanding() {
  const { t } = useI18n();
  const [data, setData] = useState<Landing | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson<Landing>("/api/finance/landing")
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : t("finance.loadFailed")),
      );
  }, []);
  if (error) return <Warning>{error}</Warning>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const cards = [
    ["supplierInvoicesAwaitingMatch", t("finance.awaitingMatch"), "/app/finance/invoices?status=submitted"],
    ["matchExceptions", t("finance.matchExceptions"), "/app/finance/three-way-match?status=open"],
    ["approvedPayableObligations", t("finance.approvedPayables"), "/app/finance/payables?status=approved"],
    ["customerInvoicesAwaitingIssue", t("finance.awaitingIssue"), "/app/finance/customer-invoices?status=approved"],
    ["overdueReceivables", t("finance.overdueReceivables"), "/app/finance/receivables?status=overdue"],
    ["disputedReceivables", t("finance.disputedReceivables"), "/app/finance/receivables?disputeStatus=open"],
    ["supplierCreditMemos", t("finance.supplierCredits"), "/app/finance/credits"],
    ["customerCreditNotes", t("finance.customerCredits"), "/app/finance/customer-credit-notes"],
  ] as const;
  return (
    <div className="space-y-4" data-testid="operational-finance-landing">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([key, label, href]) => (
          <a href={href} key={key}>
            <Card className="h-full p-4 transition hover:border-blue-200">
              <div className="text-xs text-slate-500">{label}</div>
              <div className="mt-2 flex items-end justify-between">
                <strong className="text-2xl">{data.cards[key] || 0}</strong>
                <ArrowRight size={15} color={A.blue} />
              </div>
            </Card>
          </a>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Warning>{t("finance.notPaid")}</Warning>
        <Warning>{t("finance.notCollected")}</Warning>
      </div>
      <Card className="p-4" data-testid="finance-currency-limitation">
        <div className="font-semibold">{t("finance.currency")}</div>
        <div className="mt-1 text-sm text-slate-600">
          {data.currencyLimitations.aggregationStatus ===
          "multi_currency_unconverted"
            ? t("finance.unconverted")
            : data.currencyLimitations.aggregationStatus === "single_currency"
              ? t("finance.singleCurrency")
              : t("finance.noCurrencyData")}
        </div>
        <div className="mt-2 text-xs text-slate-500">
          {data.currencyLimitations.currencies.join(" · ") || "—"} · {t("finance.fxNotConverted")}
        </div>
      </Card>
    </div>
  );
}

function FinanceList({
  endpoint,
  capability,
  kind,
}: {
  endpoint: string;
  capability: string;
  kind: "invoice" | "payable" | "credit" | "match";
}) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ListPayload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson<ListPayload>(`${endpoint}?${query()}`)
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : t("finance.loadFailed")),
      );
  }, [endpoint]);
  if (error) return <Warning>{error}</Warning>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = data.capabilities?.[capability]?.enabled;
  return (
    <div className="space-y-4" data-testid={`operational-finance-${kind}-list`}>
      {!enabled && <Warning>{t("finance.capabilityDisabled")}</Warning>}
      {kind === "invoice" && enabled && (
        <div className="flex justify-end">
          <a data-testid="supplier-invoice-new" href="/app/finance/invoices/new" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white" style={{ background: A.blue }}>{t("finance.newSupplierInvoice")}</a>
        </div>
      )}
      {kind === "payable" && <Warning>{t("finance.notPaid")}</Warning>}
      {kind === "credit" && <Warning>{t("finance.noRefund")}</Warning>}
      <Card className="overflow-x-auto">
        <div className="border-b px-4 py-3 text-xs text-slate-500">
          {t("finance.authoritative")} · {data.total}
        </div>
        <table className="w-full min-w-[850px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-slate-500">
              <th className="px-4 py-3">{t("finance.invoiceNumber")}</th>
              <th className="px-4 py-3">{t("finance.source")}</th>
              <th className="px-4 py-3">{t("finance.amount")}</th>
              <th className="px-4 py-3">{t("finance.status")}</th>
              <th className="px-4 py-3">{t("finance.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => {
              const id = String(value(row, "id") || "");
              const label = String(
                (kind === "match"
                  ? value(row, "exceptionType", "matchNumber")
                  : value(
                      row,
                      "invoiceNumber",
                      "obligationNumber",
                      "creditMemoNumber",
                    )) || id,
              );
              const source = String(
                (kind === "match"
                  ? value(row, "invoiceNumber", "supplierInvoiceId")
                  : value(
                      row,
                      "supplierName",
                      "supplierInvoiceNumber",
                      "returnPostingNumber",
                      "supplierInvoiceId",
                    )) || "—",
              );
              const amount = value(
                row,
                "totalAmount",
                "outstandingAmount",
                "varianceValue",
              );
              const rawStatus = String(
                value(row, "status", "matchStatus") || "",
              );
              const statusLabel = tokenKeys[rawStatus]
                ? t(tokenKeys[rawStatus])
                : rawStatus || "—";
              const actionLabels = (value(row, "availableActions") || []).map(
                (action: string) =>
                  tokenKeys[action] ? t(tokenKeys[action]) : action,
              );
              return (
                <tr className="border-b border-slate-50" key={id}>
                  <td className="px-4 py-3 font-medium">
                    {kind === "invoice" && id ? <a className="text-blue-600 hover:underline" href={`/app/finance/invoices/${encodeURIComponent(id)}`}>{label}</a> : label}
                  </td>
                  <td className="px-4 py-3">{source}</td>
                  <td className="px-4 py-3">
                    {money(amount, value(row, "currency"), locale)}
                  </td>
                  <td className="px-4 py-3">
                    <Chip
                      label={statusLabel}
                      color={A.blue}
                      bg="#eff6ff"
                    />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {actionLabels.join(" · ") || "—"}
                  </td>
                </tr>
              );
            })}
            {!data.items.length && (
              <tr>
                <td className="px-4 py-10 text-center text-slate-500" colSpan={5}>
                  {t("common.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function OperationalFinanceP2pWorkbench({
  view,
}: {
  view: "overview" | "invoices" | "payables" | "credits" | "match";
}) {
  if (view === "overview") return <FinanceLanding />;
  if (view === "payables")
    return (
      <FinanceList
        endpoint="/api/finance/payables"
        capability="payable-obligation"
        kind="payable"
      />
    );
  if (view === "credits")
    return (
      <FinanceList
        endpoint="/api/finance/supplier-credit-memos"
        capability="supplier-credit-memo"
        kind="credit"
      />
    );
  if (view === "match")
    return (
      <FinanceList
        endpoint="/api/finance/match-exceptions"
        capability="three-way-match"
        kind="match"
      />
    );
  return (
    <FinanceList
      endpoint="/api/finance/supplier-invoices"
      capability="supplier-invoice"
      kind="invoice"
    />
  );
}
