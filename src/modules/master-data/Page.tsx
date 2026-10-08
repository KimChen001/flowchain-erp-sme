import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, Search } from "lucide-react";
import { A, Card } from "../../components/ui";
import type { ActiveContext } from "../ai-assistant/Panel";
import MasterDataTables from "./MasterDataTables";
import { fetchMasterDataSnapshot, masterDataErrorStatus, type AsyncDataStatus, type MasterDataSnapshot } from "./api";
import { exportMasterDataCsv } from "./export";
import { CustomerTable, PrintTemplateTable } from "./StandardMasterTables";
import { PRINT_TEMPLATE_CATALOG, type PrintTemplateCatalogItem } from "./standardData";
import ItemMasterWorkbench from "./ItemMasterWorkbench";
import { useMasterDataCopy } from "./masterDataCopy";

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
  const [masterData, setMasterData] = useState<MasterDataSnapshot>(emptyMasterData);
  const [loadStatus, setLoadStatus] = useState<AsyncDataStatus>("loading");
  const [templateCatalog, setTemplateCatalog] = useState<PrintTemplateCatalogItem[]>(PRINT_TEMPLATE_CATALOG);
  // Bumped after a customer is created or changed, to read the data again.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setTab(initialView);
    setSearch("");
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
  const filteredWarehouses = useMemo(() => masterData.warehouses.filter((item) => matches([item.warehouseCode, item.warehouseName, item.zone, item.bin, item.owner])), [masterData.warehouses, query]);
  const filteredTaxCodes = useMemo(() => masterData.taxCodes.filter((item) => matches([item.code, item.name, item.type, item.region, item.description])), [masterData.taxCodes, query]);
  const filteredPaymentTerms = useMemo(() => masterData.paymentTerms.filter((item) => matches([item.code, item.name, item.description])), [masterData.paymentTerms, query]);
  const filteredCustomers = useMemo(() => masterData.customers.filter((item) => matches([item.code, item.name, item.contact, item.phone, item.address, item.paymentTerms])), [masterData.customers, query]);
  const filteredTemplates = useMemo(() => templateCatalog.filter((item) => matches([item.name, copy(item.name), item.documentType, copy(item.documentType)])), [query, templateCatalog, copy]);

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

  const canExport = tab === "warehouses" || tab === "tax-codes" || tab === "payment-terms";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-8 px-2 rounded-lg flex items-center gap-1.5" style={{ background: A.white, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>
            <Search size={12} style={{ color: A.gray2 }} />
            <input value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder={copy("搜索基础资料")}
              className="w-44 bg-transparent outline-none text-xs"
              style={{ color: A.label }} />
          </div>
          {canExport && <button onClick={exportCurrent}
            className="h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5"
            style={{ background: "#f0f6ff", color: A.blue }}>
            <FileSpreadsheet size={13} /> {copy("导出当前结果")}
          </button>}
        </div>
      </div>

      <Card>
        {tab === "customers" ? (
          <CustomerTable customers={filteredCustomers} onChanged={() => setReloadKey((key) => key + 1)} />
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
