import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, FilePlus2, RefreshCw } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { A, Card, Chip } from "../../components/ui";
import { createSecureClientMutationId } from "../../lib/client-id";

type Capability = { enabled?: boolean; maturity?: string; reason?: string };
type Invoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  shipmentId: string;
  shipmentNumber?: string;
  dueDate: string;
  totalAmount: string;
  currency: string;
  status: string;
  version: number;
  availableActions: string[];
};
type Receivable = {
  id: string;
  obligationNumber: string;
  customerInvoiceNumber?: string;
  customerName?: string;
  outstandingAmount: string;
  currency: string;
  dueDate: string;
  status: string;
  disputeStatus: string;
  externalSettlementReference?: string;
  settlementVerified: false;
  availableActions: string[];
};
type CreditNote = {
  id: string;
  creditNoteNumber: string;
  customerInvoiceNumber?: string;
  returnPostingNumber?: string;
  customerName: string;
  totalAmount: string;
  currency: string;
  status: string;
  refundExecuted: false;
};
type ListPayload<T> = {
  dataSource: string;
  items: T[];
  total: number;
  capabilities: Record<string, Capability>;
};
type AgingPayload = {
  dataSource: string;
  timezone: string;
  currencyAggregationStatus: string;
  fxConverted: false;
  groups: Array<{
    currency: string;
    count: number;
    current: string;
    "1_30": string;
    "31_60": string;
    "61_90": string;
    "90_plus": string;
    total: string;
  }>;
};
type EntryData = {
  postedShipments: Array<{
    id: string;
    shipmentNumber: string;
    customerName: string;
    currency: string;
    lines: Array<{
      id: string;
      sku: string;
      itemName: string;
      postedQuantity: string;
      unitPrice: string | null;
    }>;
  }>;
  capabilities: Record<string, Capability>;
};
type InvoicePlan = {
  allowed: boolean;
  blockingIssues: Array<{ code: string; message: string }>;
  invoice?: { totalAmount: string; currency: string };
  source?: { shipmentNumber: string; customerName: string };
};

const field =
  "h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400";
const button =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const queryString = () => {
  const params = new URLSearchParams(window.location.search);
  const allowed = ["status", "currency", "search", "page", "pageSize"];
  const next = new URLSearchParams();
  for (const key of allowed)
    if (params.get(key)) next.set(key, params.get(key) as string);
  return next.toString();
};
const money = (value: string, currency: string, locale: string) =>
  /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 4,
      }).format(Number(value))
    : `${value} ${currency}`;
const date = (value: string, locale: string) =>
  value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value)) : "—";
const canPrepare = () => {
  try {
    const role = String(
      JSON.parse(localStorage.getItem("flowchain:current-user") || "{}").role ||
        "",
    ).toLowerCase();
    return [
      "admin",
      "manager",
      "business-specialist",
      "business_specialist",
    ].includes(role);
  } catch {
    return false;
  }
};

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 shrink-0" size={16} />
      <span>{children}</span>
    </div>
  );
}

function Filters() {
  const { t } = useI18n();
  const params = new URLSearchParams(window.location.search);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    value ? next.set(key, value) : next.delete(key);
    window.history.pushState({}, "", `${window.location.pathname}?${next}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <div className="flex flex-wrap gap-2">
      <input
        aria-label={t("top.search")}
        className={`${field} w-56`}
        defaultValue={params.get("search") || ""}
        placeholder={t("top.search")}
        onKeyDown={(event) => {
          if (event.key === "Enter")
            set("search", (event.target as HTMLInputElement).value);
        }}
      />
      <input
        aria-label={t("finance.currency")}
        className={`${field} w-28 uppercase`}
        defaultValue={params.get("currency") || ""}
        placeholder={t("finance.currency")}
        maxLength={3}
        onBlur={(event) => set("currency", event.target.value.toUpperCase())}
      />
      <select
        aria-label={t("finance.status")}
        className={field}
        value={params.get("status") || ""}
        onChange={(event) => set("status", event.target.value)}
      >
        <option value="">{t("finance.status")}</option>
        {["draft", "submitted", "approved", "issued", "open", "overdue", "disputed"].map(
          (status) => (
            <option value={status} key={status}>
              {status}
            </option>
          ),
        )}
      </select>
    </div>
  );
}

function InvoiceList() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ListPayload<Invoice> | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    void apiJson<ListPayload<Invoice>>(
      `/api/finance/customer-invoices?${queryString()}`,
    )
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : t("finance.loadFailed")),
      );
  };
  useEffect(load, []);
  useEffect(() => {
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  }, []);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled =
    data.capabilities["customer-invoice"]?.enabled && canPrepare();
  return (
    <div className="space-y-4" data-testid="customer-invoice-workbench">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Filters />
        <a
          href="/app/finance/customer-invoices/new"
          aria-disabled={!enabled}
          className={`${button} text-white ${!enabled ? "pointer-events-none opacity-50" : ""}`}
          style={{ background: A.blue }}
        >
          <FilePlus2 size={15} />
          {t("finance.newCustomerInvoice")}
        </a>
      </div>
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-xs text-slate-500">
          {t("finance.authoritative")} · {data.total}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                {[
                  t("finance.invoiceNumber"),
                  t("finance.customer"),
                  t("finance.source"),
                  t("finance.dueDate"),
                  t("finance.amount"),
                  t("finance.status"),
                  t("finance.actions"),
                ].map((label) => (
                  <th className="px-4 py-3 font-medium" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr className="border-b border-slate-50" key={row.id}>
                  <td className="px-4 py-3">
                    <a
                      className="font-medium text-blue-700"
                      href={`/app/finance/customer-invoices/${encodeURIComponent(row.id)}`}
                    >
                      {row.invoiceNumber}
                    </a>
                  </td>
                  <td className="px-4 py-3">{row.customerName}</td>
                  <td className="px-4 py-3">{row.shipmentNumber || row.shipmentId}</td>
                  <td className="px-4 py-3">{date(row.dueDate, locale)}</td>
                  <td className="px-4 py-3 font-medium">
                    {money(row.totalAmount, row.currency, locale)}
                  </td>
                  <td className="px-4 py-3">
                    <Chip label={row.status} color={A.blue} bg="#eff6ff" />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {row.availableActions.join(" · ") || "—"}
                  </td>
                </tr>
              ))}
              {!data.items.length && (
                <tr>
                  <td className="px-4 py-10 text-center text-slate-500" colSpan={7}>
                    {t("common.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Receivables() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ListPayload<Receivable> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson<ListPayload<Receivable>>(
      `/api/finance/receivables?${queryString()}`,
    )
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : t("finance.loadFailed")));
  }, []);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  return (
    <div className="space-y-4" data-testid="receivables-workbench">
      <Notice>{t("finance.noCollection")}</Notice>
      <Filters />
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-slate-500">
              {[
                t("finance.invoiceNumber"),
                t("finance.customer"),
                t("finance.dueDate"),
                t("finance.amount"),
                t("finance.status"),
                t("finance.actions"),
              ].map((label) => (
                <th className="px-4 py-3 font-medium" key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr className="border-b border-slate-50" key={row.id}>
                <td className="px-4 py-3">{row.customerInvoiceNumber || row.obligationNumber}</td>
                <td className="px-4 py-3">{row.customerName || "—"}</td>
                <td className="px-4 py-3">{date(row.dueDate, locale)}</td>
                <td className="px-4 py-3 font-medium">
                  {money(row.outstandingAmount, row.currency, locale)}
                </td>
                <td className="px-4 py-3">
                  {row.status} · {row.disputeStatus}
                  {row.externalSettlementReference && (
                    <div className="mt-1 text-xs text-amber-700">
                      {t("finance.externalUnverified")}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {row.availableActions.join(" · ") || "—"}
                </td>
              </tr>
            ))}
            {!data.items.length && (
              <tr><td className="px-4 py-10 text-center text-slate-500" colSpan={6}>{t("common.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Aging() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<AgingPayload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson<AgingPayload>(`/api/finance/aging?${queryString()}`)
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : t("finance.loadFailed")));
  }, []);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  return (
    <div className="space-y-4" data-testid="receivables-aging">
      {data.currencyAggregationStatus === "multi_currency_unconverted" && (
        <Notice>{t("finance.unconverted")}</Notice>
      )}
      <div className="text-xs text-slate-500">
        {t("finance.authoritative")} · {data.timezone} · FX: {data.fxConverted ? "yes" : "no"}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.groups.map((group) => (
          <Card className="p-5" key={group.currency}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">{group.currency}</h3>
              <strong>{money(group.total, group.currency, locale)}</strong>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              {[
                ["Current", group.current],
                ["1–30", group["1_30"]],
                ["31–60", group["31_60"]],
                ["61–90", group["61_90"]],
                ["90+", group["90_plus"]],
              ].map(([label, value]) => (
                <div className="rounded-lg bg-slate-50 p-3" key={label}>
                  <div className="text-xs text-slate-500">{label}</div>
                  <div className="mt-1 font-medium">{value}</div>
                </div>
              ))}
            </div>
          </Card>
        ))}
        {!data.groups.length && <Card className="p-10 text-center">{t("common.empty")}</Card>}
      </div>
    </div>
  );
}

function CreditNotes() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ListPayload<CreditNote> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson<ListPayload<CreditNote>>(
      `/api/finance/customer-credit-notes?${queryString()}`,
    )
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : t("finance.loadFailed")));
  }, []);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  return (
    <div className="space-y-4" data-testid="customer-credit-notes">
      <Notice>{t("finance.noRefund")}</Notice>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-sm">
          <thead><tr className="border-b text-left text-xs text-slate-500">
            {[t("finance.invoiceNumber"), t("finance.customer"), t("finance.source"), t("finance.amount"), t("finance.status")].map((label) => (
              <th className="px-4 py-3 font-medium" key={label}>{label}</th>
            ))}
          </tr></thead>
          <tbody>
            {data.items.map((row) => (
              <tr className="border-b border-slate-50" key={row.id}>
                <td className="px-4 py-3">{row.creditNoteNumber}<div className="text-xs text-slate-500">{row.customerInvoiceNumber}</div></td>
                <td className="px-4 py-3">{row.customerName}</td>
                <td className="px-4 py-3">{row.returnPostingNumber || "—"}</td>
                <td className="px-4 py-3 font-medium">{money(row.totalAmount, row.currency, locale)}</td>
                <td className="px-4 py-3">{row.status}</td>
              </tr>
            ))}
            {!data.items.length && <tr><td className="px-4 py-10 text-center text-slate-500" colSpan={5}>{t("common.empty")}</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function NewInvoice() {
  const { t, locale } = useI18n();
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [shipmentId, setShipmentId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [taxes, setTaxes] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<InvoicePlan | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void apiJson<EntryData>("/api/finance/entry-data")
      .then(setEntry)
      .catch((reason) => setNotice(reason instanceof Error ? reason.message : t("finance.loadFailed")));
  }, []);
  const shipment = useMemo(
    () => entry?.postedShipments.find((row) => row.id === shipmentId),
    [entry, shipmentId],
  );
  const body = () => ({
    invoiceNumber,
    shipmentId,
    currency: shipment?.currency || "",
    invoiceDate: new Date().toISOString(),
    dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : "",
    lines:
      shipment?.lines
        .filter((line) => Number(quantities[line.id] || 0) > 0)
        .map((line) => ({
          shipmentLineId: line.id,
          quantity: quantities[line.id],
          enteredTaxAmount: taxes[line.id] || "0",
        })) || [],
  });
  const preview = async () => {
    setNotice("");
    try {
      setPlan(
        await apiJson<InvoicePlan>("/api/finance/customer-invoices/preview", {
          method: "POST",
          body: JSON.stringify(body()),
        }),
      );
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : t("finance.loadFailed"));
    }
  };
  const create = async () => {
    setNotice("");
    try {
      const result = await apiJson<{ entityId: string }>(
        "/api/finance/customer-invoices",
        {
          method: "POST",
          body: JSON.stringify({
            ...body(),
            idempotencyKey: createSecureClientMutationId("o2c"),
          }),
        },
      );
      window.location.assign(
        `/app/finance/customer-invoices/${encodeURIComponent(result.entityId)}`,
      );
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : t("finance.loadFailed"));
    }
  };
  if (!entry) return notice ? <Notice>{notice}</Notice> : <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = entry.capabilities["customer-invoice"]?.enabled && canPrepare();
  return (
    <div className="space-y-4" data-testid="new-customer-invoice">
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs">{t("finance.invoiceNumber")}<input className={`${field} mt-1 w-full`} value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /></label>
          <label className="text-xs">{t("finance.postedShipment")}<select className={`${field} mt-1 w-full`} value={shipmentId} onChange={(event) => { setShipmentId(event.target.value); setPlan(null); }}><option value="">—</option>{entry.postedShipments.map((row) => <option value={row.id} key={row.id}>{row.shipmentNumber} · {row.customerName} · {row.currency}</option>)}</select></label>
          <label className="text-xs">{t("finance.dueDate")}<input type="date" className={`${field} mt-1 w-full`} value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        </div>
        {shipment?.lines.map((line) => (
          <div className="grid items-end gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-4" key={line.id}>
            <div><div className="font-medium">{line.sku} · {line.itemName}</div><div className="text-xs text-slate-500">{line.postedQuantity} · {line.unitPrice === null ? "price unavailable" : money(line.unitPrice, shipment.currency, locale)}</div></div>
            <label className="text-xs">{t("finance.quantity")}<input className={`${field} mt-1 w-full`} value={quantities[line.id] || ""} onChange={(event) => setQuantities({ ...quantities, [line.id]: event.target.value })} /></label>
            <label className="text-xs">{t("finance.tax")}<input className={`${field} mt-1 w-full`} value={taxes[line.id] || ""} onChange={(event) => setTaxes({ ...taxes, [line.id]: event.target.value })} /></label>
          </div>
        ))}
        <div className="flex gap-2">
          <button className={`${button} border border-slate-200`} disabled={!enabled} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
          <button className={`${button} text-white`} style={{ background: A.blue }} disabled={!enabled || !plan?.allowed} onClick={() => void create()}><FilePlus2 size={14} />{t("finance.createDraft")}</button>
        </div>
      </Card>
      {plan && <Card className="p-5"><div className="font-semibold">{plan.allowed ? `${plan.invoice?.totalAmount} ${plan.invoice?.currency}` : plan.blockingIssues.map((issue) => issue.message).join(" · ")}</div></Card>}
    </div>
  );
}

function InvoiceDetail() {
  const { t, locale } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) || "");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson(`/api/finance/customer-invoices/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : t("finance.loadFailed")));
  }, [id]);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  return (
    <div className="space-y-4" data-testid="customer-invoice-detail">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold">{data.invoiceNumber}</h2><p className="mt-1 text-sm text-slate-500">{data.customerName}</p></div>
          <div className="text-right"><strong>{money(data.totalAmount, data.currency, locale)}</strong><div className="text-xs text-slate-500">{data.status}</div></div>
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="mb-3 font-semibold">{t("finance.source")}</h3>
        {data.evidence.map((row: any) => <div className="mb-2 rounded-lg bg-slate-50 p-3 text-sm" key={`${row.type}-${row.id}`}>{row.type} · {row.number || row.id} · {row.authoritative ? t("finance.authoritative") : ""}</div>)}
      </Card>
      {data.receivable && <Notice>{t("finance.noCollection")}</Notice>}
    </div>
  );
}

export type O2cView =
  | "customer-invoices"
  | "customer-invoice-new"
  | "customer-invoice-detail"
  | "receivables"
  | "aging"
  | "customer-credit-notes";

export default function OperationalFinanceO2cWorkbench({ view }: { view: O2cView }) {
  if (view === "customer-invoice-new") return <NewInvoice />;
  if (view === "customer-invoice-detail") return <InvoiceDetail />;
  if (view === "receivables") return <Receivables />;
  if (view === "aging") return <Aging />;
  if (view === "customer-credit-notes") return <CreditNotes />;
  return <InvoiceList />;
}
