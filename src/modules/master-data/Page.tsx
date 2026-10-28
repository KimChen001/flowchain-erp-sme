import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, Search } from "lucide-react";
import { A, Card, Field, inputStyle } from "../../components/ui";
import type { ActiveContext } from "../ai-assistant/Panel";
import MasterDataTables from "./MasterDataTables";
import { fetchMasterDataSnapshot, masterDataErrorStatus, type AsyncDataStatus, type MasterDataSnapshot } from "./api";
import { exportMasterDataCsv } from "./export";
import { CustomerTable, PrintTemplateTable } from "./StandardMasterTables";
import { PRINT_TEMPLATE_CATALOG, type PrintTemplateCatalogItem } from "./standardData";
import ItemMasterWorkbench from "./ItemMasterWorkbench";
import { useMasterDataCopy } from "./masterDataCopy";
import { DataImportLink } from "./DataImportLink";
import { useMasterDataWriteAccess } from "./writeAccess";

export type MasterDataTab = "overview" | "items" | "suppliers" | "customers" | "warehouses" | "tax-codes" | "payment-terms" | "print-templates";
export type MasterDataTableTab = Exclude<MasterDataTab, "overview" | "customers" | "print-templates">;
// The overview redirects to items, items render ItemMasterWorkbench and
// suppliers render the supplier pages, so this page shows the other tabs.
type ReferenceTableTab = Exclude<MasterDataTableTab, "items" | "suppliers">;

const emptyMasterData: MasterDataSnapshot = {
  items: [], suppliers: [], customers: [], warehouses: [], taxCodes: [], paymentTerms: [],
};

const LOAD_ERRORS: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again to view master data.",
  forbidden: "You do not have permission to view master data.",
  not_found: "The master data service route was not found.",
  server_error: "The master data service failed. Try again later.",
  network_error: "Could not reach the master data service. Check your network or the local API.",
};

type ListTab = ReferenceTableTab | "customers" | "print-templates";
// The search and list card copy of each reference list.
const VIEWS: Record<ListTab, { search: string; hint: string; list: string; statusLabel: string; allStatuses: string; empty: string }> = {
  customers: { search: "Customer search", hint: "Search customers by code, name, contact, phone, address or payment terms.", list: "Customer list", statusLabel: "Status", allStatuses: "All statuses", empty: "No customers yet. Create or import customers to continue." },
  warehouses: { search: "Warehouse search", hint: "Search warehouses by code, name, zone, bin or owner.", list: "Warehouse list", statusLabel: "QA status", allStatuses: "All QA statuses", empty: "No warehouses yet." },
  "tax-codes": { search: "Tax code search", hint: "Search tax codes by code, name, type, region or description.", list: "Tax code list", statusLabel: "Status", allStatuses: "All statuses", empty: "No tax codes yet." },
  "payment-terms": { search: "Payment term search", hint: "Search payment terms by code, name or description.", list: "Payment term list", statusLabel: "Status", allStatuses: "All statuses", empty: "No payment terms yet." },
  "print-templates": { search: "Print template search", hint: "Search templates by name or document type.", list: "Print template list", statusLabel: "Document type", allStatuses: "All document types", empty: "No print templates yet." },
};

export default function MasterDataPage({
  initialView = "items",
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  initialView?: MasterDataTab;
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (routeId: string, focus?: unknown) => void;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  const { copy } = useMasterDataCopy();
  const [tab, setTab] = useState<MasterDataTab>(initialView);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // Creating customers needs master_data.customer.manage; the form opens in the list.
  const canEditCustomers = useMasterDataWriteAccess().customers;
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [masterData, setMasterData] = useState<MasterDataSnapshot>(emptyMasterData);
  const [loadStatus, setLoadStatus] = useState<AsyncDataStatus>("loading");
  const [templateCatalog, setTemplateCatalog] = useState<PrintTemplateCatalogItem[]>(PRINT_TEMPLATE_CATALOG);
  // Bumped after a customer is created or changed, to read the data again.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setTab(initialView);
    setSearch("");
    setStatusFilter("");
    setCreatingCustomer(false);
  }, [initialView]);

  useEffect(() => { onActiveContextChange?.(null); }, [onActiveContextChange]);

  useEffect(() => {
    if (!focus?.entityId) return;
    if (focus.entityType === "warehouse" || focus.entityType === "bin") {
      if (initialView !== "warehouses") return;
      setTab("warehouses");
      setSearch(focus.entityId);
    }
  }, [focus?.at, focus?.entityType, focus?.entityId, initialView]);

  useEffect(() => {
    let alive = true;
    fetchMasterDataSnapshot(emptyMasterData)
      .then((snapshot) => {
        if (!alive) return;
        setMasterData(snapshot);
        const total = snapshot.items.length + snapshot.suppliers.length + snapshot.customers.length + snapshot.warehouses.length + snapshot.paymentTerms.length + snapshot.taxCodes.length;
        setLoadStatus(total > 0 ? "ready_with_data" : "ready_empty");
      })
      .catch((error) => { if (alive) { setMasterData(emptyMasterData); setLoadStatus(masterDataErrorStatus(error)); } });
    return () => { alive = false; };
  }, [reloadKey]);

  const query = search.trim().toLowerCase();
  const matches = (values: unknown[]) => !query || values.some((value) => String(value || "").toLowerCase().includes(query));
  // The second filter: the status (QA status for warehouses, document type for templates).
  const matchesStatus = (value: string) => !statusFilter || value === statusFilter;
  const filteredWarehouses = useMemo(() => masterData.warehouses.filter((item) => matches([item.warehouseId, item.warehouseCode, item.warehouseName, item.zone, item.bin, item.owner]) && matchesStatus(item.qaStatus)), [masterData.warehouses, query, statusFilter]);
  const filteredTaxCodes = useMemo(() => masterData.taxCodes.filter((item) => matches([item.code, item.name, item.type, item.region, item.description]) && matchesStatus(item.status)), [masterData.taxCodes, query, statusFilter]);
  const filteredPaymentTerms = useMemo(() => masterData.paymentTerms.filter((item) => matches([item.code, item.name, item.description]) && matchesStatus(item.status)), [masterData.paymentTerms, query, statusFilter]);
  const filteredCustomers = useMemo(() => masterData.customers.filter((item) => matches([item.code, item.name, item.contact, item.phone, item.address, item.paymentTerms]) && matchesStatus(item.status)), [masterData.customers, query, statusFilter]);
  const filteredTemplates = useMemo(() => templateCatalog.filter((item) => matches([item.name, copy(item.name), item.documentType, copy(item.documentType)]) && matchesStatus(item.documentType)), [query, statusFilter, templateCatalog, copy]);

  function exportCurrent() {
    if (tab === "warehouses" || tab === "tax-codes" || tab === "payment-terms") {
      exportMasterDataCsv(tab, { warehouses: filteredWarehouses, taxCodes: filteredTaxCodes, paymentTerms: filteredPaymentTerms }, copy);
    }
  }

  // Items have their own list page, laid out like the other list pages.
  if (tab === "items" || tab === "overview" || tab === "suppliers") {
    return <ItemMasterWorkbench focus={focus} onNavigate={onNavigate} />;
  }

  if (loadStatus === "loading") return <Card className="p-6" aria-live="polite">{copy("正在加载基础资料…")}</Card>;
  if (!["ready_with_data", "ready_empty"].includes(loadStatus)) {
    return <Card className="p-6"><h2 className="text-sm font-semibold" style={{ color: A.red }}>{copy("基础资料加载失败")}</h2><p className="mt-2 text-sm" style={{ color: A.sub }}>{copy(LOAD_ERRORS[loadStatus] || LOAD_ERRORS.server_error)}</p><button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm">{copy("重新加载")}</button></Card>;
  }

  const view = VIEWS[tab];
  const canExport = tab === "warehouses" || tab === "tax-codes" || tab === "payment-terms";
  const [all, shown, statusValues] =
    tab === "customers" ? [masterData.customers.length, filteredCustomers.length, masterData.customers.map((item) => item.status)]
    : tab === "warehouses" ? [masterData.warehouses.length, filteredWarehouses.length, masterData.warehouses.map((item) => item.qaStatus)]
    : tab === "tax-codes" ? [masterData.taxCodes.length, filteredTaxCodes.length, masterData.taxCodes.map((item) => item.status)]
    : tab === "payment-terms" ? [masterData.paymentTerms.length, filteredPaymentTerms.length, masterData.paymentTerms.map((item) => item.status)]
    : [templateCatalog.length, filteredTemplates.length, templateCatalog.map((item) => item.documentType)];
  const statusOptions = [...new Set(statusValues.filter(Boolean))];
  const filtered = Boolean(query || statusFilter);
  const resetFilters = () => { setSearch(""); setStatusFilter(""); };

  // Laid out like the other list pages (purchase orders, items): a search
  // card with labelled filters, then the list card.
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy(view.search)}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{copy(view.hint)}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={resetFilters} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
              {copy("Reset")}
            </button>
            {canExport && <button type="button" onClick={exportCurrent}
              className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
              style={{ background: "#f0f6ff", color: A.blue }}>
              <FileSpreadsheet size={13} /> {copy("导出当前结果")}
            </button>}
            {tab === "customers" && <>
              <DataImportLink type="customers" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700" />
              {canEditCustomers && !creatingCustomer && <button type="button" data-testid="customer-new" onClick={() => setCreatingCustomer(true)} className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">{copy("New customer")}</button>}
            </>}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={copy("Search")}>
            <label className="flex items-center gap-2" style={{ ...inputStyle, paddingTop: 0, paddingBottom: 0 }}>
              <Search size={14} style={{ color: A.gray2 }} />
              <input value={search} onChange={(event) => setSearch(event.target.value)}
                aria-label={copy(view.search)}
                placeholder={copy("搜索基础资料")}
                className="h-9 min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          </Field>
          <Field label={copy(view.statusLabel)}>
            <select aria-label={copy(view.statusLabel)} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={inputStyle}>
              <option value="">{copy(view.allStatuses)}</option>
              {statusOptions.map((value) => <option key={value} value={value}>{copy(value)}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{copy(view.list)}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{copy(all === 1 ? "1 record, {shown} shown" : "{total} records, {shown} shown", { total: all, shown })}</div>
          </div>
        </div>
        {shown === 0 && !creatingCustomer ? (
          <div className="px-6 py-12 text-center text-sm" style={{ color: A.sub }}>
            {filtered ? copy("No records match these filters") : copy(view.empty)}
          </div>
        ) : tab === "customers" ? (
          <CustomerTable customers={filteredCustomers} creating={creatingCustomer} onCreatingDone={() => setCreatingCustomer(false)} onChanged={() => setReloadKey((key) => key + 1)} />
        ) : tab === "print-templates" ? (
          <PrintTemplateTable templates={filteredTemplates} onCopy={(item) => setTemplateCatalog((current) => [...current, { ...item, id: `${item.id}-copy-${Date.now()}`, copyOf: item.copyOf || item.name, isDefault: false, updatedAt: new Date().toISOString() }])} />
        ) : (
          <MasterDataTables
            tab={tab as ReferenceTableTab}
            warehouses={filteredWarehouses}
            taxCodes={filteredTaxCodes}
            paymentTerms={filteredPaymentTerms}
          />
        )}
      </Card>
    </div>
  );
}
