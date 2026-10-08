import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ClipboardList, RefreshCw } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import { apiJson } from "../../lib/api-client";
import { formatQuantity } from "../../lib/format";
import { useI18n } from "../../i18n/I18n";
import { useReorderListCopy, type ReorderListCopyKey } from "./reorderListCopy";

// The items to reorder, ranked by the day each one's stock position is
// expected to reach its recorded reorder point (GET /api/inventory/reorder-list,
// server/domain/reorder-list.mjs). Every row prints its inputs so a person can
// check the date. The only action opens a prefilled purchase request; nothing
// is ordered from here.

type Flag = { code: string; orderNumber?: string | null; unit?: string; dueDay?: string; count?: number };
type Supplier = { id: string; code: string; name: string; leadTimeDays: number | null; minimumOrderQuantity: number | null; moqUnit: string | null };
type ReorderRow = {
  itemId: string;
  sku: string;
  itemName: string;
  unit: string;
  orderByDate: string;
  orderNow: boolean;
  daysUntilOrderBy: number;
  onHand: number;
  reserved: number;
  incoming: number;
  position: number;
  reorderPoint: number;
  shortfall: number;
  demand: { averageDailyDemand: number | null; shipmentDays: number; shippedQuantity: number; windowDays: number; enough: boolean };
  supplier: Supplier | null;
  flags: Flag[];
  purchaseRequest: { itemId: string; supplierId: string | null; quantity: number | null; raisedToMinimum?: boolean };
};
type ItemRef = { itemId: string; sku: string; itemName: string };
type NotChecked = ItemRef & { reason: "stock_incomplete" | "stock_unit_not_recorded" | "warehouse_scope" };
type ReorderList = {
  today: string;
  timeZone: string;
  scope: { kind: "all_warehouses" | "reader_warehouses"; warehouseCount: number | null; totalWarehouseCount: number | null };
  rule: { windowDays: number; minShipmentDays: number };
  rows: ReorderRow[];
  notJudged: NotChecked[];
  noReorderPoint: { count: number; href: string; items: ItemRef[] };
  summary: { listed: number; orderNow: number; notJudged: number; noReorderPoint: number; aboveReorderPointWithoutHistory: number };
  suppliers: { id: string; code: string; name: string }[];
  truncatedSubjects?: { subject: string; limit: number }[];
};

const NO_SUPPLIER = "__none__";
const NOT_CHECKED_SECTIONS: { reason: NotChecked["reason"]; title: ReorderListCopyKey; body: ReorderListCopyKey }[] = [
  { reason: "warehouse_scope", title: "checkScopeTitle", body: "checkScopeBody" },
  { reason: "stock_unit_not_recorded", title: "checkNoUnitTitle", body: "checkNoUnitBody" },
  { reason: "stock_incomplete", title: "checkStockIncompleteTitle", body: "checkStockIncompleteBody" },
];
const SUBJECT_KEYS: Record<string, ReorderListCopyKey> = {
  items: "subjectItems",
  shipment_lines: "subjectShipmentLines",
  purchase_orders: "subjectPurchaseOrders",
  inventory_items: "subjectStockBalances",
  sales_orders: "subjectSalesOrders",
};

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

const withUnit = (value: number | null | undefined, unit: string | null) => (value === null || value === undefined ? "—" : `${formatQuantity(value)}${unit ? ` ${unit}` : ""}`);

function flagText(flag: Flag, t: ReturnType<typeof useReorderListCopy>) {
  const hidden = !flag.orderNumber;
  const byCode: Record<string, () => string> = {
    po_line_other_unit: () => t(hidden ? "poOtherUnitHidden" : "poOtherUnit", { po: flag.orderNumber || "", unit: flag.unit || "" }),
    po_line_due_after_order_by: () => t(hidden ? "poAfterOrderByHidden" : "poAfterOrderBy", { po: flag.orderNumber || "", day: flag.dueDay || "" }),
    po_line_no_due_day: () => t(hidden ? "poNoDueDayHidden" : "poNoDueDay", { po: flag.orderNumber || "" }),
    po_line_unit_not_recorded: () => t("poUnitNotRecorded"),
    all_incoming_counted: () => t("allIncomingCounted"),
    shipment_other_unit: () => t.count("shipmentOtherUnit", flag.count ?? 0, { unit: flag.unit || "" }),
    shipment_unit_not_recorded: () => t.count("shipmentUnitNotRecorded", flag.count ?? 0),
    purchase_unit_differs: () => t("purchaseUnitDiffers", { unit: flag.unit || "" }),
  };
  return (byCode[flag.code] || (() => flag.code))();
}

// The purchase request form, prefilled from the row (shared/purchase-request-prefill.mjs).
// Without a shortfall in the request line's unit the quantity is left for the
// person to enter.
function purchaseRequestHref(row: ReorderRow, reason: string) {
  const params = new URLSearchParams({ itemId: row.purchaseRequest.itemId, origin: "reorder_list", reason });
  if (row.purchaseRequest.quantity !== null) params.set("quantity", String(row.purchaseRequest.quantity));
  if (row.purchaseRequest.supplierId) params.set("suppliers", row.purchaseRequest.supplierId);
  return `/app/procurement/requests?${params.toString()}`;
}

const itemHref = (itemId: string) => `/app/master-data/items/${encodeURIComponent(itemId)}`;

export default function ReorderListPage() {
  const t = useReorderListCopy();
  const { locale } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [list, setList] = useState<ReorderList | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const supplierFilter = searchParams.get("supplier") || "";

  const load = () => {
    setState("loading");
    apiJson<ReorderList>("/api/inventory/reorder-list")
      .then((payload) => {
        setList(payload);
        setState("ready");
      })
      .catch((error: any) => setState(error?.status === 409 || error?.code === "REORDER_LIST_NOT_AVAILABLE" ? "unavailable" : "error"));
  };
  useEffect(load, []);

  const rows = useMemo(() => {
    const all = list?.rows || [];
    if (!supplierFilter) return all;
    if (supplierFilter === NO_SUPPLIER) return all.filter((row) => !row.supplier);
    return all.filter((row) => row.supplier?.id === supplierFilter);
  }, [list, supplierFilter]);

  const setSupplierFilter = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("supplier", value);
    else next.delete("supplier");
    setSearchParams(next, { replace: true });
  };

  const total = list?.scope.totalWarehouseCount ?? list?.scope.warehouseCount ?? 0;
  const scopeLabel = list?.scope.kind === "reader_warehouses" ? t.count("scopeReader", list.scope.warehouseCount ?? 0, { total }) : t("scopeAll");
  const truncated = (list?.truncatedSubjects || []).map((entry) => t(SUBJECT_KEYS[entry.subject] || "subjectOther"));
  const columns: ReorderListCopyKey[] = ["colOrderBy", "colItem", "colOnHand", "colReserved", "colIncoming", "colPosition", "colReorderPoint", "colDemand", "colShortfall", "colSupplier", "colAction"];

  return (
    <div className="space-y-4" data-testid="reorder-list-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5" style={{ color: A.sub }}>{t("subtitle")}</p>
        </div>
        <button onClick={load} aria-label={t("refresh")} className="rounded-md p-2" style={{ color: A.blue }}>
          <RefreshCw size={16} />
        </button>
      </div>

      {state === "loading" && <Card className="p-8 text-sm" style={{ color: A.sub }}>{t("loading")}</Card>}
      {state === "error" && <Card className="p-8 text-sm" style={{ color: A.red }}>{t("error")}</Card>}
      {state === "unavailable" && <Card className="p-8 text-sm" style={{ color: A.sub }}>{t("notAvailable")}</Card>}

      {state === "ready" && list && (
        <>
          <Card className="space-y-2 p-4 text-xs leading-5" data-testid="reorder-list-rules">
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="reorder-list-scope"><Chip label={scopeLabel} color={A.blue} bg="#eef5ff" /></span>
            </div>
            <p style={{ color: A.sub }}>{t("rule", { window: list.rule.windowDays, min: list.rule.minShipmentDays })}</p>
            <p style={{ color: A.sub }} data-testid="reorder-list-horizon">{t("horizon")}</p>
            <p style={{ color: A.sub }}>{t("units")}</p>
            {truncated.length > 0 && (
              <p data-testid="reorder-list-truncated" style={{ color: A.orange }}>{t("truncated", { subjects: truncated.join(", ") })}</p>
            )}
            {list.noReorderPoint.count > 0 && (
              <div data-testid="reorder-list-no-reorder-point">
                <p>{t.count("noReorderPoint", list.noReorderPoint.count)}</p>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {list.noReorderPoint.items.map((item) => (
                    <li key={item.itemId}>
                      <Link to={itemHref(item.itemId)} className="font-semibold" style={{ color: A.blue }}>{item.sku}</Link>
                    </li>
                  ))}
                  {list.noReorderPoint.count > list.noReorderPoint.items.length && (
                    <li>
                      <Link to={list.noReorderPoint.href} style={{ color: A.blue }}>{t("noReorderPointMore", { n: list.noReorderPoint.count - list.noReorderPoint.items.length })}</Link>
                    </li>
                  )}
                </ul>
              </div>
            )}
            {list.summary.aboveReorderPointWithoutHistory > 0 && (
              <p style={{ color: A.sub }}>{t.count("aboveWithoutHistory", list.summary.aboveReorderPointWithoutHistory)}</p>
            )}
          </Card>

          {list.rows.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{t("supplierFilter")}</span>
              <select
                data-testid="reorder-list-supplier-filter"
                value={supplierFilter}
                onChange={(event) => setSupplierFilter(event.target.value)}
                className="rounded-md border px-2 py-1"
                style={{ borderColor: A.border }}
              >
                <option value="">{t("allSuppliers")}</option>
                {list.suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
                <option value={NO_SUPPLIER}>{t("noSupplier")}</option>
              </select>
            </label>
          )}

          {rows.length === 0 ? (
            <Card className="p-10 text-center" data-testid="reorder-list-empty">
              <ClipboardList className="mx-auto mb-3" size={28} color={A.gray2} />
              <div className="text-sm font-semibold">{list.rows.length ? t("filteredEmpty") : t("emptyTitle")}</div>
              {!list.rows.length && list.scope.kind === "all_warehouses" && <p className="mt-2 text-xs" style={{ color: A.sub }}>{t("emptyBody")}</p>}
              {!list.rows.length && list.notJudged.length > 0 && <p className="mt-1 text-xs" style={{ color: A.sub }}>{t.count("emptyNotChecked", list.notJudged.length)}</p>}
            </Card>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-xs">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                    {columns.map((key) => <th key={key} className="px-3 py-3 text-left">{t(key)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const reason = t("reason", { position: withUnit(row.position, row.unit), reorderPoint: withUnit(row.reorderPoint, row.unit), date: row.orderByDate });
                    return (
                      <tr key={row.itemId} data-testid={`reorder-row-${row.sku}`} style={{ borderBottom: `1px solid ${A.border}` }} className="align-top">
                        <td className="px-3 py-3" data-testid="reorder-order-by">
                          <div className="font-semibold">{formatDay(row.orderByDate, locale)}</div>
                          {row.orderNow ? (
                            <span className="mt-1 inline-block"><Chip label={t("orderNow")} color={A.orange} bg="#fff4e8" /></span>
                          ) : (
                            <div style={{ color: A.sub }}>{row.daysUntilOrderBy === 0 ? t("today") : row.daysUntilOrderBy === 1 ? t("inOneDay") : t("inDays", { n: row.daysUntilOrderBy })}</div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold">{row.sku}</div>
                          <div style={{ color: A.sub }}>{row.itemName}</div>
                          {row.flags.length > 0 && (
                            <ul className="mt-1 space-y-0.5" data-testid="reorder-flags">
                              {row.flags.map((flag, index) => <li key={`${flag.code}-${index}`} style={{ color: A.orange }}>{flagText(flag, t)}</li>)}
                            </ul>
                          )}
                        </td>
                        <td className="px-3 py-3">{withUnit(row.onHand, row.unit)}</td>
                        <td className="px-3 py-3">{withUnit(row.reserved, row.unit)}</td>
                        <td className="px-3 py-3">{withUnit(row.incoming, row.unit)}</td>
                        <td className="px-3 py-3 font-semibold">{withUnit(row.position, row.unit)}</td>
                        <td className="px-3 py-3">{withUnit(row.reorderPoint, row.unit)}</td>
                        <td className="px-3 py-3" data-testid="reorder-demand">
                          {row.demand.enough ? (
                            <>
                              <div>{withUnit(row.demand.averageDailyDemand, row.unit)}</div>
                              <div style={{ color: A.sub }}>{t.count("demandDays", row.demand.shipmentDays, { window: row.demand.windowDays })}</div>
                            </>
                          ) : (
                            <div style={{ color: A.sub }}>{t.count("notEnoughHistory", row.demand.shipmentDays)}</div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {withUnit(row.shortfall, row.unit)}
                          {row.purchaseRequest.raisedToMinimum && row.purchaseRequest.quantity !== null && (
                            <div style={{ color: A.sub }} data-testid={`reorder-order-minimum-${row.sku}`}>
                              {t("orderMinimum", { n: formatQuantity(row.purchaseRequest.quantity), unit: row.unit })}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3" data-testid="reorder-supplier">
                          {row.supplier ? (
                            <>
                              <div className="font-semibold">{row.supplier.name}</div>
                              <div style={{ color: A.sub }}>{row.supplier.leadTimeDays === null ? t("leadTimeNotRecorded") : t.count("leadTime", row.supplier.leadTimeDays)}</div>
                              <div style={{ color: A.sub }}>
                                {row.supplier.minimumOrderQuantity === null
                                  ? t("moqNotRecorded")
                                  : t(row.supplier.moqUnit ? "moq" : "moqNoUnit", { n: formatQuantity(row.supplier.minimumOrderQuantity), unit: row.supplier.moqUnit || "" })}
                              </div>
                            </>
                          ) : (
                            <span style={{ color: A.sub }}>{t("notRecorded")}</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <Link
                            to={purchaseRequestHref(row, reason)}
                            data-testid={`reorder-create-request-${row.sku}`}
                            className="inline-block whitespace-nowrap rounded-md px-3 py-1.5 font-semibold"
                            style={{ background: "#f0f6ff", color: A.blue }}
                          >
                            {t("createRequest")}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}

          {NOT_CHECKED_SECTIONS.map((section) => {
            const items = list.notJudged.filter((row) => row.reason === section.reason);
            if (!items.length) return null;
            const body = section.reason === "warehouse_scope" ? t.count("checkScopeBody", list.scope.warehouseCount ?? 0, { total }) : t(section.body);
            return (
              <Card key={section.reason} className="p-4 text-xs" data-testid={`reorder-list-not-checked-${section.reason}`}>
                <div className="font-semibold">{t(section.title)}</div>
                <p className="mt-1" style={{ color: A.sub }}>{body}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {items.map((row) => (
                    <li key={row.itemId} className="rounded-md px-2 py-1" style={{ background: A.gray6 }}>
                      <Link to={itemHref(row.itemId)} style={{ color: A.blue }}>{row.sku}</Link> · {row.itemName}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
