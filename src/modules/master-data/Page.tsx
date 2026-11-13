import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { ListCard, ListSearchCard, ResetButton, listButtonClass } from "../../components/ui/listLayout";
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
import { ListPager, usePagedRows } from "../procurement/listPaging";
import { useI18n } from "../../i18n/I18n";

// A workspace can hold a thousand customers or more: the list draws 50 at a time.
const CUSTOMER_PAGE_SIZE = 50;

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
  not_found: "This master data page could not be found. Refresh and try again.",
  server_error: "Master data could not be loaded. Try again later.",
  network_error: "Could not connect. Check your network and try again.",
};

type ListTab = ReferenceTableTab | "customers" | "print-templates";
// The search and list card copy of each reference list.
const VIEWS: Record<ListTab, { search: string; hint: string; placeholder: string; list: string; statusLabel: string; allStatuses: string; empty: string }> = {
  customers: { search: "Customer search", hint: "Search customers by code, name, contact, phone, address or payment terms.", placeholder: "Code, name, contact or phone", list: "Customer list", statusLabel: "Status", allStatuses: "All statuses", empty: "No customers yet. Create or import customers to continue." },
  warehouses: { search: "Warehouse search", hint: "Search warehouses by code, name, zone, bin or owner.", placeholder: "Code, name, zone or owner", list: "Warehouse list", statusLabel: "QA status", allStatuses: "All QA statuses", empty: "No warehouses yet." },
  "tax-codes": { search: "Tax code search", hint: "Search tax codes by code, name, type, region or description.", placeholder: "Code, name, type or region", list: "Tax code list", statusLabel: "Status", allStatuses: "All statuses", empty: "No tax codes yet." },
  "payment-terms": { search: "Payment term search", hint: "Search payment terms by code, name or description.", placeholder: "Code, name or description", list: "Payment term list", statusLabel: "Status", allStatuses: "All statuses", empty: "No payment terms yet." },
  "print-templates": { search: "Print template search", hint: "Search templates by name or document type.", placeholder: "Template name or document type", list: "Print template list", statusLabel: "Document type", allStatuses: "All document types", empty: "No print templates yet." },
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
  const { formatNumber } = useI18n();
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
  const customerPage = usePagedRows(filteredCustomers, CUSTOMER_PAGE_SIZE, [query, statusFilter].join("|"));
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

  // Laid out like the other list pages (purchase orders, items): the shared
  // search card (its filters fold away on a phone), then the list card with
  // "N total, M shown".
  return (
    <div className="space-y-5">
      <ListSearchCard
        title={copy(view.search)}
        subtitle={copy(view.hint)}
        activeFilters={statusFilter ? 1 : 0}
        actions={<>
          <ResetButton onClick={resetFilters} />
          {canExport && <button type="button" onClick={exportCurrent} className={listButtonClass.export}>
            <FileSpreadsheet size={13} /> {copy("导出当前结果")}
          </button>}
          {tab === "customers" && <>
            <DataImportLink type="customers" className={listButtonClass.secondary} />
            {canEditCustomers && !creatingCustomer && <button type="button" data-testid="customer-new" onClick={() => setCreatingCustomer(true)} className={listButtonClass.primary}>{copy("New customer")}</button>}
          </>}
        </>}
      >
        <Field label={copy("Search")}>
          <input value={search} onChange={(event) => setSearch(event.target.value)}
            aria-label={copy(view.search)}
            placeholder={copy(view.placeholder)}
            style={inputStyle} />
        </Field>
        <Field label={copy(view.statusLabel)}>
          <select aria-label={copy(view.statusLabel)} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={inputStyle}>
            <option value="">{copy(view.allStatuses)}</option>
            {statusOptions.map((value) => <option key={value} value={value}>{copy(value)}</option>)}
          </select>
        </Field>
      </ListSearchCard>

      <ListCard title={copy(view.list)} total={all} shown={tab === "customers" ? customerPage.pageRows.length : shown} testId={`master-data-${tab}-list`}>
        {shown === 0 && !creatingCustomer ? (
          <div className="px-6 py-12 text-center text-sm" style={{ color: A.sub }}>
            {filtered ? copy("No records match these filters") : copy(view.empty)}
          </div>
        ) : tab === "customers" ? (
          <>
            <CustomerTable customers={customerPage.pageRows} creating={creatingCustomer} onCreatingDone={() => setCreatingCustomer(false)} onChanged={() => setReloadKey((key) => key + 1)} />
            <ListPager page={customerPage.page} pageSize={CUSTOMER_PAGE_SIZE} total={filteredCustomers.length} onPage={customerPage.setPage} testId="customer-pager" />
          </>
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
      </ListCard>
    </div>
  );
}
