import { SupplierForm, type PaymentTermOption } from "./SupplierForm";
import { supplierCopy } from "./supplierCopy";
import { SupplierPerformancePanel, supplierPerformanceTabLabel } from "./supplierPerformance";
import { SupplierActivityCards } from "./supplierActivity";
import { SupplierTierPanel, TierChip, type Tier, type TierHistoryRow } from "./SupplierTier";
import type { SupplierInsight, SupplierInsights } from "./supplierInsights";
import { useEffect, useState, useRef } from "react";
import { Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, thClass } from "../../components/ui/workbenchTable";
import { EntityLink } from "../../components/business/EntityLink";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { useMasterDataWriteAccess } from "../master-data/writeAccess";
import { PriceHistoryFacts, priceHistoryKey, usePriceHistory } from "../procurement/PriceHistoryFacts";
import { DataImportLink } from "../master-data/DataImportLink";

type Supplier = {
  id: string;
  supplierCode: string;
  supplierName: string;
  shortName: string;
  status: "draft" | "active" | "inactive";
  businessType: string;
  categories: string[];
  contactName: string;
  telephone: string;
  email: string;
  address: string;
  postalCode: string;
  deliveryCycleDays: number;
  defaultCurrency: string;
  paymentTermsId: string;
  settlementMethod: string;
  creditCode: string;
  taxIdentificationNumber: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  internalComment: string;
  version: number;
  updatedAt: string;
  tier: Tier;
  tierReason: string | null;
  tierSetAt: string | null;
  tierSetBy: { id: string; name: string | null } | null;
  businessOwner: { id: string; name: string | null } | null;
  tierHistory?: TierHistoryRow[];
};
// The list's tabs: everything and the signed-in user's suppliers. Counts come
// from the server. Tiers are not a list tab: what a tier means differs per
// company, so they live on Supplier evaluation (owner decision 2026-10-09).
type ListTab = "all" | "mine";
type TabCounts = { all: number; mine: number };
const LIST_TABS: Array<{ tab: ListTab; label: string; count: keyof TabCounts }> = [
  { tab: "all", label: "All", count: "all" },
  { tab: "mine", label: "Managed by me", count: "mine" },
];
type Relationship = {
  relationshipId: string;
  itemId: string;
  supplierId: string;
  supplierSku: string;
  active: boolean;
  approved: boolean;
  preferred: boolean;
  leadTimeDays: number | null;
  minimumOrderQuantity: number | null;
  referencePrice: number;
  currency: string;
  version: number;
  item?: Item | null;
};
type Item = { itemId: string; sku: string; itemName: string; status: string };
const request = <T,>(url: string, method = "GET", body?: unknown) =>
  apiJson<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const empty = (currency = "") => ({
  supplierCode: "",
  supplierName: "",
  shortName: "",
  status: "active",
  businessType: "",
  categories: "",
  contactName: "",
  telephone: "",
  email: "",
  address: "",
  postalCode: "",
  deliveryCycleDays: "",
  defaultCurrency: currency,
  // Empty until someone records the agreed term.
  paymentTermsId: "",
  settlementMethod: "",
  creditCode: "",
  taxIdentificationNumber: "",
  bankName: "",
  bankAccountName: "",
  bankAccountNumber: "",
  internalComment: "",
});
const statusLabel = { draft: "草稿", active: "启用", inactive: "停用" };
// The list's long metric headers wrap to two lines; the list scrolls
// sideways with the code and actions columns kept in view, as on purchase orders.
const WRAPPED_HEADERS = new Set(["经营品类", "Business owner", "Spend, 12 months", "Open POs", "Overdue POs", "On time (PO date), 90 days", "Open issues"]);

function normalizeSupplier(value: Partial<Supplier> & Record<string, unknown>): Supplier {
  const text = (candidate: unknown, fallback = "") => String(candidate ?? "").trim() || fallback;
  const id = text(value.id || value.supplierCode || value.name || value.supplierName);
  const supplierName = text(value.supplierName || value.name, id);
  const rawStatus = text(value.status, "active");
  return {
    id,
    supplierCode: text(value.supplierCode, id),
    supplierName,
    shortName: text(value.shortName),
    status: (["draft", "active", "inactive"].includes(rawStatus) ? rawStatus : "active") as Supplier["status"],
    businessType: text(value.businessType),
    categories: Array.isArray(value.categories) ? value.categories.map((item) => text(item)).filter(Boolean) : [],
    contactName: text(value.contactName),
    telephone: text(value.telephone),
    email: text(value.email),
    address: text(value.address),
    postalCode: text(value.postalCode),
    deliveryCycleDays: Number(value.deliveryCycleDays || 0),
    defaultCurrency: text(value.defaultCurrency),
    paymentTermsId: text(value.paymentTermsId),
    settlementMethod: text(value.settlementMethod),
    creditCode: text(value.creditCode),
    taxIdentificationNumber: text(value.taxIdentificationNumber),
    bankName: text(value.bankName),
    bankAccountName: text(value.bankAccountName),
    bankAccountNumber: text(value.bankAccountNumber),
    internalComment: text(value.internalComment),
    version: Number(value.version || 1),
    updatedAt: text(value.updatedAt),
    tier: ([1, 2, 3].includes(Number(value.tier)) ? Number(value.tier) : null) as Tier,
    tierReason: text(value.tierReason) || null,
    tierSetAt: text(value.tierSetAt) || null,
    tierSetBy: (value.tierSetBy as Supplier["tierSetBy"]) || null,
    businessOwner: (value.businessOwner as Supplier["businessOwner"]) || null,
    tierHistory: Array.isArray(value.tierHistory) ? (value.tierHistory as TierHistoryRow[]) : [],
  };
}

export default function SupplierMasterPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  initialView?: string;
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (moduleId: string, focus?: unknown) => void;
  onActiveContextChange?: (context: any) => void;
}) {
  const { language, locale } = useI18n();
  const copy = (label: string) => supplierCopy(workspaceCopy(label, language), language);
  const listSeparator = language === "en-US" ? ", " : "、";
  // Supplier edits need master_data.supplier.manage; the supplied-item links
  // are item edits and need master_data.item.manage.
  const writes = useMasterDataWriteAccess();
  const [saving, setSaving] = useState(false);
  const [currencyWarning, setCurrencyWarning] = useState(false);
  const [workspaceCurrency, setWorkspaceCurrency] = useState('');
  // The workspace's payment terms for the form; null when they could not load.
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermOption[] | null>([]);
  const loadPaymentTerms = async () => {
    try {
      const { options } = await request<{ options: Array<{ id: string; code?: string; label?: string; metadata?: { recordId?: string | null } }> }>('/api/master-data/payment-terms/select');
      setPaymentTerms(options.map(option => ({ id: option.code || option.id, label: option.label || option.code || option.id, recordId: option.metadata?.recordId ?? null })));
    } catch { setPaymentTerms(null); }
  };
  const savingRef = useRef(false);
  const [rows, setRows] = useState<Supplier[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [category, setCategory] = useState(""),
    [tab, setTab] = useState<ListTab>("all"),
    [owner, setOwner] = useState(""),
    [counts, setCounts] = useState<TabCounts | null>(null);
  // Every owner seen so far, for the owner filter.
  const [knownOwners, setKnownOwners] = useState<Array<{ id: string; name: string | null }>>([]);
  // Metrics for every supplier, read once per page load, not on every search.
  const [insights, setInsights] = useState<SupplierInsights | null>(null);
  const [sortBy, setSortBy] = useState<"name" | "spend" | "overdue" | "issues">("name");
  const loadInsights = async () => {
    try { setInsights(await request<SupplierInsights>("/api/master-data/supplier-insights")); }
    catch { setInsights(null); }
  };
  useEffect(() => { loadInsights(); }, []);
  const [detailTab, setDetailTab] = useState<"details" | "performance">("details");
  const [selected, setSelected] = useState<Supplier | null>(null),
    [editing, setEditing] = useState<Supplier | null>(null),
    [form, setForm] = useState<any>(empty()),
    [showForm, setShowForm] = useState(false),
    [fieldErrors, setFieldErrors] = useState<any[]>([]),
    [relationships, setRelationships] = useState<Relationship[]>([]),
    [items, setItems] = useState<Item[]>([]),
    [relationshipLimitation, setRelationshipLimitation] = useState(""),
    [relationForm, setRelationForm] = useState({
      itemId: "",
      preferred: false,
      approved: true,
      active: true,
      leadTimeDays: "",
      minimumOrderQuantity: "",
      referencePrice: "",
      // Empty means "use the supplier's default currency" when saving.
      currency: "",
    });
  // Only the latest request may fill the list: an older, slower one is dropped.
  const loadSequence = useRef(0);
  const loadedOnce = useRef(false);
  // Every category seen so far, so choosing one does not empty the filter's own options.
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const tabFilter = tab === "mine" ? "&owner=me" : "";
      const ownerFilter = tab !== "mine" && owner ? `&owner=${encodeURIComponent(owner)}` : "";
      const data = await request<{ suppliers: Supplier[]; counts?: TabCounts }>(
        `/api/master-data/suppliers?query=${encodeURIComponent(query)}&status=${status}&category=${encodeURIComponent(category)}${tabFilter}${ownerFilter}`,
      );
      if (sequence !== loadSequence.current) return;
      const next = (data.suppliers || []).map((supplier) => normalizeSupplier(supplier));
      setRows(next);
      setCounts(data.counts || null);
      setKnownCategories((current) => [...new Set([...current, ...next.flatMap((r) => r.categories || [])])]);
      setKnownOwners((current) => {
        const byId = new Map(current.map((person) => [person.id, person]));
        for (const row of next) if (row.businessOwner) byId.set(row.businessOwner.id, row.businessOwner);
        return [...byId.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      });
    } catch (e: any) {
      if (sequence === loadSequence.current) setError(e.message || "供应商数据加载失败");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };
  // Filters apply as they change; typing waits for a short pause.
  useEffect(() => {
    const timer = setTimeout(load, loadedOnce.current ? 300 : 0);
    loadedOnce.current = true;
    return () => clearTimeout(timer);
  }, [query, status, category, tab, owner]);
  useEffect(() => {
    if (focus?.entityType === "supplier" && focus.entityId)
      openDetail(focus.entityId);
  }, [focus?.at]);
  const categories = knownCategories;
  const openDetail = async (id: string) => {
    try {
      const { supplier } = await request<{ supplier: Supplier }>(
        `/api/master-data/suppliers/${encodeURIComponent(id)}`,
      );
      const normalizedSupplier = normalizeSupplier(supplier);
      if (normalizedSupplier.id !== selected?.id) setDetailTab("details");
      setSelected(normalizedSupplier);
      const [rels, catalog] = await Promise.allSettled([
        request<{ relationships: Relationship[] }>(
          `/api/master-data/suppliers/${encodeURIComponent(id)}/items`,
        ),
        request<{ items: Item[] }>("/api/master-data/items?purchasable=true"),
      ]);
      setRelationships(rels.status === "fulfilled" ? rels.value.relationships : []);
      setItems(catalog.status === "fulfilled" ? (catalog.value.items || []).map((item) => ({
        itemId: String(item.itemId || (item as any).id || item.sku || ""),
        sku: String(item.sku || ""),
        itemName: String(item.itemName || (item as any).name || item.sku || ""),
        status: String(item.status || "active"),
      })) : []);
      setRelationshipLimitation(
        rels.status === "rejected"
          ? rels.reason instanceof Error ? rels.reason.message : "供应商–SKU 关系暂不可用"
          : "",
      );
      onActiveContextChange?.({
        module: "srm",
        entityType: "supplier",
        entityId: normalizedSupplier.id,
        entityLabel: normalizedSupplier.supplierName,
      });
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  useEffect(() => { loadPaymentTerms(); }, []);
  // A stored term by its name, whether the supplier holds its code or row id.
  const termName = (stored: string) => {
    const term = (paymentTerms || []).find(option => option.id === stored || option.recordId === stored);
    return term ? `${term.label} (${term.id})` : stored;
  };
  const startCreate = async () => {
    let currency = '';
    try { currency = (await request<{ company: { currency: string } }>('/api/settings-runtime')).company.currency; } catch { /* Let the user choose explicitly. */ }
    setCurrencyWarning(!currency);
    setWorkspaceCurrency(currency);
    setEditing(null);
    setForm(empty(currency));
    setFieldErrors([]);
    setShowForm(true);
    loadPaymentTerms();
  };
  const startEdit = (supplier: Supplier) => {
    setEditing(supplier);
    setCurrencyWarning(false);
    setForm({ ...supplier, categories: (supplier.categories || []).join(",") });
    setFieldErrors([]);
    setShowForm(true);
    loadPaymentTerms();
  };
  const save = async () => {
    if (savingRef.current) return;
    const issues = [];
    if (!String(form.supplierCode).trim()) issues.push({ field: 'supplierCode', message: 'Enter a supplier code.' });
    if (!String(form.supplierName).trim()) issues.push({ field: 'supplierName', message: 'Enter a supplier name.' });
    if (!form.defaultCurrency) issues.push({ field: 'defaultCurrency', message: 'Choose a valid currency.' });
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) issues.push({ field: 'email', message: 'Enter a valid email address.' });
    if (form.deliveryCycleDays && (!Number.isInteger(Number(form.deliveryCycleDays)) || Number(form.deliveryCycleDays) < 0)) issues.push({ field: 'deliveryCycleDays', message: 'Lead time must be a whole number of days, zero or greater.' });
    setFieldErrors(issues);
    if (issues.length) { document.getElementById('supplier-' + issues[0].field)?.focus(); return; }
    savingRef.current = true; setSaving(true);
    try {
      const body: any = {
        ...form,
        categories: String(form.categories)
          .split(/[,，]/)
          .map((x: string) => x.trim())
          .filter(Boolean),
        deliveryCycleDays: Number(form.deliveryCycleDays || 0),
        expectedVersion: editing?.version,
      };
      // A value shown masked ("****1234") was not readable; leave it as stored.
      if (editing)
        for (const key of ["creditCode", "taxIdentificationNumber", "bankAccountName", "bankAccountNumber"] as const)
          if (String(body[key] || "").startsWith("****")) delete body[key];
      const result = editing
        ? await request<{ supplier: Supplier }>(
            `/api/master-data/suppliers/${editing.id}`,
            "PATCH",
            body,
          )
        : await request<{ supplier: Supplier }>(
            "/api/master-data/suppliers",
            "POST",
            body,
          );
      toast.success(copy("Supplier saved"));
      // Open the saved supplier before closing the form, so the list does not
      // flash between the two.
      await openDetail(result.supplier.id);
      setShowForm(false);
      await load();
    } catch (e: unknown) {
      setFieldErrors(
        e instanceof ApiError && e.details.length
          ? e.details
          : [{ message: e instanceof Error ? copy(e.message) : copy("Could not save supplier. Please try again.") }],
      );
    } finally { savingRef.current = false; setSaving(false); }
  };
  const toggle = async (supplier: Supplier) => {
    await request(`/api/master-data/suppliers/${supplier.id}`, "PATCH", {
      status: supplier.status === "active" ? "inactive" : "active",
      expectedVersion: supplier.version,
    });
    await load();
    if (selected?.id === supplier.id) await openDetail(supplier.id);
  };
  const addRelationship = async () => {
    if (!selected || !relationForm.itemId) return;
    try {
      await request(
        `/api/master-data/items/${relationForm.itemId}/suppliers`,
        "POST",
        {
          ...relationForm,
          supplierId: selected.id,
          // A blank lead time or MOQ is sent as not recorded, never 0 or 1.
          leadTimeDays: String(relationForm.leadTimeDays ?? "").trim() === "" ? null : Number(relationForm.leadTimeDays),
          minimumOrderQuantity: String(relationForm.minimumOrderQuantity ?? "").trim() === "" ? null : Number(relationForm.minimumOrderQuantity),
          referencePrice: Number(relationForm.referencePrice || 0),
          currency: relationForm.currency || selected.defaultCurrency || undefined,
        },
      );
      await openDetail(selected.id);
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const updateRelationship = async (
    relationship: Relationship,
    patch: Partial<Relationship>,
  ) => {
    if (!selected) return;
    try {
      await request(
        `/api/master-data/items/${relationship.itemId}/suppliers/${relationship.relationshipId}`,
        "PATCH",
        { ...patch, expectedVersion: relationship.version },
      );
      await openDetail(selected.id);
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const insightOf = (id: string): SupplierInsight | undefined => insights?.suppliers[id];
  const hiddenCell = <span title={copy("Hidden for your role")} style={{ color: A.sub }}>—</span>;
  const count = (value: number | null | undefined) => (value === null || value === undefined ? hiddenCell : <span className="tabular-nums">{value}</span>);
  const moneyText = (amount: number, currency: string) => {
    try { return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount); }
    catch { return `${currency} ${amount}`; }
  };
  const spendCell = (insight?: SupplierInsight) => {
    if (!insight || insight.spend12m === null) return hiddenCell;
    if (!insight.spend12m.length) return <span className="tabular-nums">0</span>;
    const [first, ...others] = insight.spend12m;
    return <span className="tabular-nums" title={insight.spend12m.map((row) => moneyText(row.amount, row.currency)).join(" · ")}>
      {moneyText(first.amount, first.currency)}{others.length ? <span style={{ color: A.sub }}> +{others.length} {copy("currencies")}</span> : null}
    </span>;
  };
  const onTimeCell = (insight?: SupplierInsight) => {
    if (!insight || insight.onTime === null) return hiddenCell;
    if (insight.onTime.rate === null) return <span title={copy("Fewer than 5 deliveries in 90 days")} style={{ color: A.sub }}>—</span>;
    // Deliveries measured against the date on the PO, which may be the buyer's need date.
    const detail = copy("{count} of {of} deliveries on time against the date on the PO, which may be the buyer's need date").replace("{count}", String(insight.onTime.count)).replace("{of}", String(insight.onTime.of));
    return <span className="tabular-nums" title={detail}>{new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(insight.onTime.rate)}</span>;
  };
  // The reader chooses the order; it never comes from a hidden weight. Spend
  // sorts by currency, then amount, and never compares across currencies.
  const sortedRows = (() => {
    if (sortBy === "name") return rows;
    const value = (row: Supplier) => {
      const insight = insightOf(row.id);
      if (sortBy === "overdue") return insight?.overduePos ?? -1;
      if (sortBy === "issues") return insight?.openIssues ?? -1;
      return insight?.spend12m?.[0]?.amount ?? -1;
    };
    const currencyOf = (row: Supplier) => insightOf(row.id)?.spend12m?.[0]?.currency || "";
    return [...rows].sort((a, b) => (sortBy === "spend" ? currencyOf(a).localeCompare(currencyOf(b)) : 0) || value(b) - value(a) || a.supplierName.localeCompare(b.supplierName));
  })();
  // Earlier PO prices of each supplied item from this supplier only, in the
  // link currency and the item's unit, in one request. Display only.
  // The item being linked gets the same facts under its reference price, in
  // the currency the link will be saved in. Never fills the price.
  const relationshipHistoryKey = (r: Relationship) => (selected ? priceHistoryKey({ itemId: r.itemId, currency: r.currency, supplierId: selected.id }) : "");
  const relationFormHistoryKey = selected && writes.items ? priceHistoryKey({ itemId: relationForm.itemId, currency: relationForm.currency || selected.defaultCurrency, supplierId: selected.id }) : "";
  const relationshipHistory = usePriceHistory([...relationships.map(relationshipHistoryKey), relationFormHistoryKey]);
  if (showForm) return <SupplierForm form={form} editing={!!editing} saving={saving} errors={fieldErrors} currencyWarning={currencyWarning} workspaceCurrency={workspaceCurrency} paymentTerms={paymentTerms} onChange={(key, value) => { setForm((current: any) => ({ ...current, [key]: value })); setFieldErrors(current => current.filter(error => error.field !== key)); }} onSave={save} onCancel={() => setShowForm(false)} />;
  if (selected)
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => {
              setSelected(null);
              onActiveContextChange?.(null);
            }}
          >
            {copy("返回供应商列表")}</button>
          {writes.suppliers && (
            <div className="flex gap-2">
              <button
                onClick={() => startEdit(selected)}
                className="inline-flex items-center gap-1 rounded border px-3 py-2 text-xs"
              >
                <Pencil size={14} />
                {copy("编辑")}</button>
              <button
                onClick={() => toggle(selected)}
                className="rounded border px-3 py-2 text-xs"
              >
                {copy(selected.status === "active" ? "停用" : "启用")}
              </button>
            </div>
          )}
        </div>
        <div role="tablist" aria-label={selected.supplierName} className="flex gap-1 border-b" style={{ borderColor: A.border }}>
          {(["details", "performance"] as const).map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={detailTab === tab} data-testid={`supplier-tab-${tab}`} onClick={() => setDetailTab(tab)}
              className="px-4 py-2 text-xs font-semibold" style={{ color: detailTab === tab ? A.blue : A.gray1, borderBottom: detailTab === tab ? `2px solid ${A.blue}` : "2px solid transparent" }}>
              {supplierPerformanceTabLabel(language, tab)}
            </button>
          ))}
        </div>
        {detailTab === "performance" ? <SupplierPerformancePanel supplierId={selected.id} /> : <>
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{selected.supplierName}</h1>
            <TierChip tier={selected.tier} />
          </div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>
            {selected.supplierCode} · {copy(statusLabel[selected.status])}
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {[
              [
                "基本信息",
                `${selected.shortName || "-"} · ${selected.businessType || "-"} · ${(selected.categories || []).join(listSeparator) || "-"}`,
              ],
              [
                "联系与地址",
                `${selected.contactName || "-"} · ${selected.telephone || "-"} · ${selected.email || "-"} · ${selected.address || "-"}`,
              ],
              [
                "商业条款",
                `${selected.defaultCurrency || copy("Not recorded")} · ${copy("Payment terms")}: ${selected.paymentTermsId ? termName(selected.paymentTermsId) : copy("Not recorded")} · ${selected.settlementMethod || "-"}`,
              ],
              [
                "财税与银行",
                `${selected.creditCode || "-"} · ${selected.taxIdentificationNumber || "-"} · ${selected.bankName || "-"} · ${selected.bankAccountNumber || "-"}`,
              ],
            ].map(([title, value]) => (
              <section key={copy(title)}>
                <h2 className="text-xs font-semibold">{copy(title)}</h2>
                <p className="mt-2 text-xs leading-5" style={{ color: A.sub }}>
                  {value}
                </p>
              </section>
            ))}
          </div>
        </Card>
        <SupplierTierPanel supplier={selected} canEdit={writes.suppliers} onChanged={async () => { await openDetail(selected.id); await load(); }} />
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{copy("可供应物料")}</h2>
          {relationshipLimitation && <p role="alert" className="mt-2 text-xs text-amber-700">{copy("Supplied-item links are currently unavailable.")}</p>}
          {writes.items && <div className="mt-3 grid gap-2 md:grid-cols-4">
            <select
              aria-label={copy("选择 SKU")}
              value={relationForm.itemId}
              onChange={(e) =>
                setRelationForm({ ...relationForm, itemId: e.target.value })
              }
              style={inputStyle}
            >
              <option value="">{copy("选择 SKU")}</option>
              {items
                .filter(
                  (i) => !relationships.some((r) => r.itemId === i.itemId),
                )
                .map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {i.sku} · {i.itemName}
                  </option>
                ))}
            </select>
            <label className="text-xs">
              <input
                type="checkbox"
                checked={relationForm.preferred}
                onChange={(e) =>
                  setRelationForm({
                    ...relationForm,
                    preferred: e.target.checked,
                  })
                }
              />{" "}
              Preferred
            </label>
            <div>
              <input
                aria-label={copy("参考价格")}
                placeholder={copy("参考价格")}
                value={relationForm.referencePrice}
                onChange={(e) =>
                  setRelationForm({
                    ...relationForm,
                    referencePrice: e.target.value,
                  })
                }
                style={inputStyle}
              />
              {relationFormHistoryKey && <PriceHistoryFacts history={relationshipHistory.histories.get(relationFormHistoryKey)} state={relationshipHistory.state} testId="supplied-item-form-price-history" />}
            </div>
            <button
              onClick={addRelationship}
              className="rounded bg-blue-600 px-3 py-2 text-xs text-white"
            >
              {copy("新增供应商关系")}</button>
          </div>}
          {relationships.length === 0 ? (
            <div className="py-8 text-center text-xs" style={{ color: A.sub }}>
              {copy("暂无可供应物料")}</div>
          ) : (
            <table className="mt-3 w-full text-xs">
              <thead>
                <tr>
                  {[
                    "SKU",
                    "Preferred",
                    "Approved",
                    "Lead Time",
                    "MOQ",
                    "参考价格",
                    "状态",
                    ...(writes.items ? ["操作"] : []),
                  ].map((h) => (
                    <th key={copy(h)} className="p-2 text-left">
                      {copy(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {relationships.map((r) => (
                  <tr key={r.relationshipId} className="border-t">
                    <td className="p-2">
                      <EntityLink kind="item" id={r.itemId} className="text-blue-600">
                        {r.item?.sku || r.itemId} · {r.item?.itemName || ""}
                      </EntityLink>
                    </td>
                    <td className="p-2">{copy(r.preferred ? "是" : "否")}</td>
                    <td className="p-2">{copy(r.approved ? "是" : "否")}</td>
                    <td className="p-2">{r.leadTimeDays ?? "—"}</td>
                    <td className="p-2">{r.minimumOrderQuantity ?? "—"}</td>
                    <td className="p-2">
                      {r.currency} {r.referencePrice}
                      {relationshipHistoryKey(r) && <PriceHistoryFacts compact history={relationshipHistory.histories.get(relationshipHistoryKey(r))} state={relationshipHistory.state} testId={`supplied-item-price-history-${r.itemId}`} />}
                    </td>
                    <td className="p-2">{copy(r.active ? "启用" : "停用")}</td>
                    {writes.items && <td className="p-2 space-x-2">
                      {!r.preferred && (
                        <button
                          onClick={() =>
                            updateRelationship(r, { preferred: true })
                          }
                        >
                          {copy("设为首选")}</button>
                      )}
                      <button
                        onClick={() =>
                          updateRelationship(r, { active: !r.active })
                        }
                      >
                        {copy(r.active ? "停用" : "启用")}
                      </button>
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <SupplierActivityCards
          supplierId={selected.id}
          titles={{ orders: copy("采购记录"), risks: copy("风险与异常") }}
          empty={{ orders: copy("暂无采购交易记录"), risks: copy("暂无风险或异常") }}
        />
        </>}
      </div>
    );
  // Laid out like the other list pages (purchase orders, items): a search
  // card with labelled filters, then the list with its tabs. The module shell
  // already shows the page title.
  const filtersApplied = Boolean(query || status || category || owner || tab !== "all");
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Supplier search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Search suppliers by code, name, status, category and owner.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={load}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
              style={{ background: A.gray6, color: A.label }}
            >
              <RefreshCw size={13} />
              {copy("刷新")}
            </button>
            <DataImportLink type="suppliers" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700" />
            {writes.suppliers && (
              <button
                type="button"
                onClick={startCreate}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white"
              >
                <Plus size={13} />
                {copy("新增供应商")}
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={copy("Search")}>
            <label className="flex items-center gap-2" style={{ ...inputStyle, paddingTop: 0, paddingBottom: 0 }}>
              <Search size={14} style={{ color: A.gray2 }} />
              <input
                aria-label={copy("搜索供应商")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={copy("编号或名称")}
                className="h-9 min-w-0 flex-1 bg-transparent outline-none"
              />
            </label>
          </Field>
          <Field label={copy("状态")}>
            <select aria-label={copy("状态筛选")} value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              <option value="">{copy("全部状态")}</option>
              <option value="active">{copy("启用")}</option>
              <option value="inactive">{copy("停用")}</option>
              <option value="draft">{copy("草稿")}</option>
            </select>
          </Field>
          <Field label={copy("经营品类")}>
            <select aria-label={copy("经营品类筛选")} value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
              <option value="">{copy("全部品类")}</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label={copy("Business owner")}>
            <select
              aria-label={copy("Owner filter")}
              value={tab === "mine" ? "" : owner}
              disabled={tab === "mine"}
              onChange={(e) => setOwner(e.target.value)}
              style={inputStyle}
            >
              <option value="">{copy("All owners")}</option>
              <option value="none">{copy("No owner")}</option>
              {knownOwners.map((person) => (
                <option key={person.id} value={person.id}>{person.name || person.id}</option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-end gap-3 px-5 pt-3" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div role="tablist" aria-label={copy("Supplier list")} className="flex flex-wrap gap-1">
            {LIST_TABS.map((item) => (
              <button key={item.tab} type="button" role="tab" aria-selected={tab === item.tab} data-testid={`supplier-list-tab-${item.tab}`} onClick={() => setTab(item.tab)}
                className="px-3 py-2 text-xs font-semibold" style={{ color: tab === item.tab ? A.blue : A.gray1, borderBottom: tab === item.tab ? `2px solid ${A.blue}` : "2px solid transparent" }}>
                {copy(item.label)}{counts ? <span className="ml-1 font-normal tabular-nums" style={{ color: A.sub }}>{counts[item.count]}</span> : null}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 pb-2">
            <label className="flex items-center gap-1.5 text-xs" style={{ color: A.sub }}>
              {copy("Sort by")}
              <select aria-label={copy("Sort by")} value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} style={{ ...inputStyle, width: "auto", minWidth: 120, paddingTop: 4, paddingBottom: 4 }}>
                <option value="name">{copy("Name")}</option>
                <option value="spend">{copy("Spend")}</option>
                <option value="overdue">{copy("Overdue")}</option>
                <option value="issues">{copy("Issues")}</option>
              </select>
            </label>
          </div>
        </div>
        {error ? (
          <div className="p-8 text-center">
            <div className="text-sm text-red-700">{copy("供应商数据加载失败")}</div>
            <button onClick={load} className="mt-3 text-xs text-blue-600">
              {copy("重试")}
            </button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="p-8 text-center text-xs">{copy("加载中")}</div>
        ) : rows.length === 0 && filtersApplied ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }}>
            {copy("没有符合筛选条件的供应商")}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }}>
            {copy("暂无供应商")}
            {writes.suppliers && <>
              <br />
              <span className="text-xs">{copy("点击“新增供应商”开始维护供应商资料。")}</span>
            </>}
          </div>
        ) : (
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[1180px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                  {[
                    "供应商编号",
                    "供应商名称",
                    "经营品类",
                    "Business owner",
                    "Spend, 12 months",
                    "Open POs",
                    "Overdue POs",
                    "On time (PO date), 90 days",
                    "Open issues",
                    "状态",
                    ...(writes.suppliers ? ["操作"] : []),
                  ].map((h) => (
                    <th key={copy(h)} className={`${thClass} align-bottom${WRAPPED_HEADERS.has(h) ? " !whitespace-normal min-w-[96px] max-w-[132px]" : ""}${h === "供应商编号" ? " sticky left-0 z-20 bg-white" : h === "操作" ? " sticky right-0 z-20 bg-white" : ""}`} style={{ color: A.gray1 }}>
                      {copy(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, index) => (
                  <tr key={row.id} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < sortedRows.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <EntityLink kind="supplier" id={row.id} className={tableLinkClass}>
                        {row.supplierCode}
                      </EntityLink>
                    </td>
                    <td className={`${tdNameClass} max-w-[220px] truncate font-medium`} style={{ color: A.label }} title={row.supplierName}>{row.supplierName}</td>
                    <td className={`${tdNameClass} max-w-[200px] truncate`} style={{ color: A.sub }}>
                      {(row.categories || []).join(listSeparator) || "—"}
                    </td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{row.businessOwner?.name || "—"}</td>
                    <td className={tdNowrapClass}>{spendCell(insightOf(row.id))}</td>
                    <td className={tdNowrapClass}>{count(insightOf(row.id)?.openPos)}</td>
                    <td className={tdNowrapClass}>{count(insightOf(row.id)?.overduePos)}</td>
                    <td className={tdNowrapClass}>{onTimeCell(insightOf(row.id))}</td>
                    <td className={tdNowrapClass}>{count(insightOf(row.id)?.openIssues)}</td>
                    <td className={tdNowrapClass}>
                      {row.status === "active"
                        ? <Chip label={copy(statusLabel[row.status])} color={A.green} bg="#f0faf4" />
                        : row.status === "draft"
                          ? <Chip label={copy(statusLabel[row.status])} color={A.orange} bg="#fff8f0" />
                          : <Chip label={copy(statusLabel[row.status])} color={A.gray1} bg={A.gray6} />}
                    </td>
                    {writes.suppliers && <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={() => startEdit(row)} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium">{copy("编辑")}</button>
                        <button type="button" onClick={() => toggle(row)} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium">
                          {copy(row.status === "active" ? "Set inactive" : "Set active")}
                        </button>
                      </div>
                    </td>}
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
