import { useEffect, useMemo, useState } from "react";
import { Database, FileSpreadsheet, Package, Printer, Search, Tags, Truck, Users, Warehouse } from "lucide-react";
import ContextualImportActions from "../../components/import/ContextualImportActions";
import { A, Card, KpiCard } from "../../components/ui";
import type { ActiveContext } from "../ai-assistant/Panel";
import MasterDataDetailModal, { type DetailRecord } from "./MasterDataDetailModal";
import MasterDataOverview from "./MasterDataOverview";
import MasterDataTables from "./MasterDataTables";
import { fetchMasterDataSnapshot, masterDataErrorStatus, type AsyncDataStatus, type MasterDataSnapshot } from "./api";
import { exportMasterDataCsv } from "./export";
import { CustomerTable, PrintTemplateTable } from "./StandardMasterTables";
import { PRINT_TEMPLATE_CATALOG, type PrintTemplateCatalogItem } from "./standardData";
import ItemMasterWorkbench from "./ItemMasterWorkbench";

export type MasterDataTab = "overview" | "items" | "suppliers" | "customers" | "warehouses" | "tax-codes" | "payment-terms" | "print-templates";
export type MasterDataTableTab = Exclude<MasterDataTab, "overview" | "customers" | "print-templates">;

const tabs = [
  { id: "overview", label: "基础资料总览", icon: Database },
  { id: "items", label: "物料资料", icon: Package },
  { id: "suppliers", label: "供应商资料", icon: Truck },
  { id: "customers", label: "客户资料", icon: Users },
  { id: "warehouses", label: "仓库资料", icon: Warehouse },
  { id: "tax-codes", label: "条款与税码", icon: Tags },
  { id: "payment-terms", label: "付款条款", icon: FileSpreadsheet },
  { id: "print-templates", label: "打印模板", icon: Printer },
] as const;

const fallbackMasterData: MasterDataSnapshot = {
  items: [], suppliers: [], customers: [], warehouses: [], taxCodes: [], paymentTerms: [],
};

export default function MasterDataPage({
  initialView = "overview",
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  initialView?: MasterDataTab;
  focus?: { entityType: string; entityId: string; at: number } | null;
  onNavigate?: (routeId: string, focus?: unknown) => void;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  const [tab, setTab] = useState<MasterDataTab>(initialView);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<DetailRecord | null>(null);
  const [masterData, setMasterData] = useState<MasterDataSnapshot>(fallbackMasterData);
  const [loadStatus, setLoadStatus] = useState<AsyncDataStatus>("loading");
  const [templateCatalog, setTemplateCatalog] = useState<PrintTemplateCatalogItem[]>(PRINT_TEMPLATE_CATALOG);

  function openTab(next: MasterDataTab) {
    const routeId = next === "overview" ? "master-data" : `master-data:${next}`;
    if (onNavigate) onNavigate(routeId);
    else setTab(next);
  }

  useEffect(() => {
    if (initialView) {
      setTab(initialView);
      setDetail(null);
      setSearch("");
    }
  }, [initialView]);

  useEffect(() => {
    if (!focus?.entityId) return;
    const normalized = String(focus.entityId || "").toLowerCase();
    if (focus.entityType === "item") {
      if (initialView !== "overview" && initialView !== "items") return;
      setTab("items");
      return;
    }
    if (focus.entityType === "supplier") {
      if (initialView !== "overview" && initialView !== "suppliers") return;
      const supplier = masterData.suppliers.find((entry) =>
        String(entry.code || "").toLowerCase() === normalized ||
        String(entry.name || "").toLowerCase() === normalized
      );
      if (!supplier) return;
      setTab("suppliers");
      setDetail({ type: "suppliers", item: supplier });
      return;
    }
    if (focus.entityType === "warehouse" || focus.entityType === "bin") {
      if (initialView !== "overview" && initialView !== "warehouses") return;
      setTab("warehouses");
      setSearch(focus.entityId);
    }
  }, [focus?.at, focus?.entityType, focus?.entityId, initialView, masterData]);

  useEffect(() => {
    let alive = true;
    fetchMasterDataSnapshot(fallbackMasterData)
      .then((snapshot) => {
        if (!alive) return;
        setMasterData(snapshot);
        const total = snapshot.items.length + snapshot.suppliers.length + snapshot.customers.length + snapshot.warehouses.length + snapshot.paymentTerms.length + snapshot.taxCodes.length;
        setLoadStatus(total > 0 ? "ready_with_data" : "ready_empty");
      })
      .catch((error) => { if (alive) { setMasterData(fallbackMasterData); setLoadStatus(masterDataErrorStatus(error)); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!detail || (detail.type !== "items" && detail.type !== "suppliers")) {
      onActiveContextChange?.(null);
      return;
    }
    if (detail.type === "items") {
      onActiveContextChange?.({
        module: "master-data",
        entityType: "item",
        entityId: detail.item.sku,
        entityLabel: detail.item.name || detail.item.sku,
        view: "items",
      });
      return () => onActiveContextChange?.(null);
    }
    onActiveContextChange?.({
      module: "master-data",
      entityType: "supplier",
      entityId: detail.item.code,
      entityLabel: detail.item.name,
      view: "suppliers",
    });
    return () => onActiveContextChange?.(null);
  }, [detail, onActiveContextChange]);

  const query = search.trim().toLowerCase();
  const filteredItems = useMemo(() => masterData.items.filter((item) =>
    !query || [item.sku, item.name, item.category, item.defaultSupplier, item.defaultBin, item.defaultTaxCode].some((value) => String(value || "").toLowerCase().includes(query))
  ), [masterData.items, query]);
  const filteredSuppliers = useMemo(() => masterData.suppliers.filter((item) =>
    !query || [item.code, item.name, item.category, item.contact, item.paymentTerms, item.defaultTaxCode].some((value) => String(value || "").toLowerCase().includes(query))
  ), [masterData.suppliers, query]);
  const filteredWarehouses = useMemo(() => masterData.warehouses.filter((item) =>
    !query || [item.warehouseCode, item.warehouseName, item.zone, item.bin, item.owner].some((value) => String(value || "").toLowerCase().includes(query))
  ), [masterData.warehouses, query]);
  const filteredTaxCodes = useMemo(() => masterData.taxCodes.filter((item) =>
    !query || [item.code, item.name, item.type, item.region, item.description].some((value) => String(value || "").toLowerCase().includes(query))
  ), [masterData.taxCodes, query]);
  const filteredPaymentTerms = useMemo(() => masterData.paymentTerms.filter((item) =>
    !query || [item.code, item.name, item.description].some((value) => String(value || "").toLowerCase().includes(query))
  ), [masterData.paymentTerms, query]);
  const filteredCustomers = useMemo(() => masterData.customers.filter((item) => !query || [item.code, item.name, item.contact, item.phone, item.address, item.paymentTerms].some((value) => String(value || "").toLowerCase().includes(query))), [masterData.customers, query]);
  const filteredTemplates = useMemo(() => templateCatalog.filter((item) => !query || [item.name, item.documentType].some((value) => String(value || "").toLowerCase().includes(query))), [query, templateCatalog]);

  function exportCurrent() {
    if (tab === "customers" || tab === "print-templates") return;
    exportMasterDataCsv(tab, {
      items: filteredItems,
      suppliers: filteredSuppliers,
      warehouses: filteredWarehouses,
      taxCodes: filteredTaxCodes,
      paymentTerms: filteredPaymentTerms,
    });
  }

  const importLabels = {
    overview: ["基础资料", "基础资料"],
    items: ["物料资料", "物料"],
    suppliers: ["供应商资料", "供应商"],
    customers: ["客户资料", "客户"],
    warehouses: ["仓库库位", "库位"],
    "tax-codes": ["税码", "税码"],
    "payment-terms": ["付款条款", "付款条款"],
    "print-templates": ["打印模板", "打印模板"],
  } satisfies Record<MasterDataTab, [string, string]>;

  const [entityLabel, templateName] = importLabels[tab];

  if (loadStatus === "loading") return <Card className="p-6" aria-live="polite">正在加载基础资料…</Card>;
  if (!["ready_with_data", "ready_empty"].includes(loadStatus)) {
    const messages: Record<string, string> = {
      unauthenticated: "登录已失效，请重新登录后查看基础资料。",
      forbidden: "当前用户没有查看基础资料的权限。",
      not_found: "基础资料服务路由不存在。",
      server_error: "基础资料服务发生错误，请稍后重试。",
      network_error: "无法连接基础资料服务，请检查网络或本地 API。",
    };
    return <Card className="p-6"><h2 className="text-sm font-semibold" style={{ color: A.red }}>基础资料加载失败</h2><p className="mt-2 text-sm" style={{ color: A.sub }}>{messages[loadStatus]}</p><button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm">重新加载</button></Card>;
  }

  return (
    <div className="space-y-4">
      <MasterDataDetailModal detail={detail} onClose={() => setDetail(null)} />
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label="物料资料" value={String(masterData.items.length)} sub={`${masterData.items.filter((item) => item.status === "待完善").length} 条待完善`} icon={Package} color={A.blue} />
        <KpiCard label="供应商资料" value={String(masterData.suppliers.length)} sub={`${masterData.suppliers.filter((item) => item.riskStatus === "高").length} 个高风险`} icon={Truck} color={A.purple} />
        <KpiCard label="仓库 / 库位" value={String(masterData.warehouses.length)} sub={`${masterData.warehouses.filter((item) => item.available).length} 个可用`} icon={Warehouse} color={A.green} />
        <KpiCard label="客户资料" value={String(masterData.customers.length)} sub={`${masterData.customers.filter((item) => item.creditStatus !== "正常").length} 个需关注`} icon={Users} color={A.orange} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ContextualImportActions entityLabel={entityLabel} templateName={templateName} compact />
          <div className="h-8 px-2 rounded-lg flex items-center gap-1.5" style={{ background: A.white, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}>
            <Search size={12} style={{ color: A.gray2 }} />
            <input value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索基础资料"
              className="w-44 bg-transparent outline-none text-xs"
              style={{ color: A.label }} />
          </div>
          <button onClick={exportCurrent}
            className="h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5"
            style={{ background: "#f0f6ff", color: A.blue }}>
            <FileSpreadsheet size={13} /> 导出当前结果
          </button>
        </div>
      </div>

      <Card>
        {tab === "items" ? (
          <ItemMasterWorkbench focus={focus} onNavigate={onNavigate} />
        ) : tab === "overview" ? (
          <MasterDataOverview data={masterData} onOpenTab={openTab} />
        ) : tab === "customers" ? (
          filteredCustomers.length ? <CustomerTable customers={filteredCustomers} /> : <div className="p-10 text-center"><h2 className="font-semibold">暂无客户资料</h2><p className="mt-2 text-sm text-slate-500">可以通过 Structured Intake 导入，或在本地运行 pilot:setup:demo。</p></div>
        ) : tab === "print-templates" ? (
          <PrintTemplateTable templates={filteredTemplates} onCopy={(item) => setTemplateCatalog((current) => [...current, { ...item, id: `${item.id}-copy-${Date.now()}`, name: `${item.name} 副本`, isDefault: false, updatedAt: new Date().toLocaleString("zh-CN") }])} />
        ) : tab === "suppliers" && !filteredSuppliers.length ? (
          <div className="p-10 text-center"><h2 className="font-semibold">暂无供应商资料</h2><p className="mt-2 text-sm text-slate-500">可以通过 Structured Intake 导入，或在本地运行 pilot:setup:demo。</p></div>
        ) : (
          <MasterDataTables
            tab={tab as MasterDataTableTab}
            items={filteredItems}
            suppliers={filteredSuppliers}
            warehouses={filteredWarehouses}
            taxCodes={filteredTaxCodes}
            paymentTerms={filteredPaymentTerms}
            onDetail={setDetail}
          />
        )}
      </Card>
    </div>
  );
}
