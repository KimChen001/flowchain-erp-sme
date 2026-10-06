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
type Supplier = { id: string; code: string; name: string; leadTimeDays: number | null; minimumOrderQuantity: number | null };
type ReorderRow = {
  itemId: string;
  sku: string;
  itemName: string;
  unit: string | null;
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
  purchaseRequest: { itemId: string; supplierId: string | null; quantity: number | null };
};
type ReorderList = {
  today: string;
  timeZone: string;
  scope: { kind: "all_warehouses" | "reader_warehouses"; warehouseCount: number | null };
  rule: { windowDays: number; minShipmentDays: number };
  rows: ReorderRow[];
  notJudged: { itemId: string; sku: string; itemName: string; reason: string }[];
  noReorderPoint: { count: number; href: string };
  summary: { listed: number; orderNow: number; notJudged: number; noReorderPoint: number; aboveReorderPointWithoutHistory: number };
  suppliers: { id: string; code: string; name: string }[];
};

const NO_SUPPLIER = "__none__";

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
    shipment_other_unit: () => t("shipmentOtherUnit", { count: flag.count ?? 0, unit: flag.unit || "" }),
    shipment_unit_not_recorded: () => t("shipmentUnitNotRecorded", { count: flag.count ?? 0 }),
    stock_unit_not_recorded: () => t("stockUnitNotRecorded"),
    purchase_unit_differs: () => t("purchaseUnitDiffers", { unit: flag.unit || "" }),
  };
  return (byCode[flag.code] || (() => flag.code))();
}

// The purchase request form, prefilled from the row (shared/purchase-request-prefill.mjs).
// The quantity is left out when the request line's unit would differ.
function purchaseRequestHref(row: ReorderRow, reason: string) {
  const params = new URLSearchParams({ itemId: row.purchaseRequest.itemId, origin: "reorder_list", reason });
  if (row.purchaseRequest.quantity !== null) params.set("quantity", String(row.purchaseRequest.quantity));
  if (row.purchaseRequest.supplierId) params.set("suppliers", row.purchaseRequest.supplierId);
  return `/app/procurement/requests?${params.toString()}`;
}

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

  const scopeLabel = list?.scope.kind === "reader_warehouses" ? t("scopeReader", { n: list.scope.warehouseCount ?? 0 }) : t("scopeAll");
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
            {list.noReorderPoint.count > 0 && (
              <p data-testid="reorder-list-no-reorder-point">
                {list.noReorderPoint.count === 1 ? t("noReorderPointOne") : t("noReorderPoint", { n: list.noReorderPoint.count })}{" "}
                <Link to={list.noReorderPoint.href} className="font-semibold" style={{ color: A.blue }}>{t("setIt")}</Link>
              </p>
            )}
            {list.summary.aboveReorderPointWithoutHistory > 0 && (
              <p style={{ color: A.sub }}>
                {list.summary.aboveReorderPointWithoutHistory === 1 ? t("aboveWithoutHistoryOne") : t("aboveWithoutHistory", { n: list.summary.aboveReorderPointWithoutHistory })}
              </p>
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
              {!list.rows.length && <p className="mt-2 text-xs" style={{ color: A.sub }}>{t("emptyBody")}</p>}
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
                              <div style={{ color: A.sub }}>{t("demandDays", { n: row.demand.shipmentDays, window: row.demand.windowDays })}</div>
                            </>
                          ) : (
                            <div style={{ color: A.sub }}>{t("notEnoughHistory", { n: row.demand.shipmentDays })}</div>
                          )}
                        </td>
                        <td className="px-3 py-3">{withUnit(row.shortfall, row.unit)}</td>
                        <td className="px-3 py-3" data-testid="reorder-supplier">
                          {row.supplier ? (
                            <>
                              <div className="font-semibold">{row.supplier.name}</div>
                              <div style={{ color: A.sub }}>{row.supplier.leadTimeDays === null ? t("leadTimeNotRecorded") : t("leadTime", { n: row.supplier.leadTimeDays })}</div>
                              <div style={{ color: A.sub }}>{row.supplier.minimumOrderQuantity === null ? t("moqNotRecorded") : t("moq", { n: formatQuantity(row.supplier.minimumOrderQuantity) })}</div>
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

          {list.notJudged.length > 0 && (
            <Card className="p-4 text-xs" data-testid="reorder-list-not-judged">
              <div className="font-semibold">{t("notJudgedTitle")}</div>
              <p className="mt-1" style={{ color: A.sub }}>{t("notJudgedBody")}</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {list.notJudged.map((row) => <li key={row.itemId} className="rounded-md px-2 py-1" style={{ background: A.gray6 }}>{row.sku} · {row.itemName}</li>)}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
