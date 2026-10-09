import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { RefreshCw, Search } from "lucide-react";
import { A, Card, Field, inputStyle } from "../../components/ui";
import {
  tableBodyTextClass,
  tableLinkClass,
  tableScrollClass,
  tdIdClass,
  tdNowrapClass,
  tdNumericRightClass,
  thClass,
  thRightClass,
} from "../../components/ui/workbenchTable";
import { apiJson } from "../../lib/api-client";
import { ResponsiveFilters } from "../../components/business/ResponsiveFilters";
import { formatDateTimeInTimeZone, formatQuantity } from "../../lib/format";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { useI18n } from "../../i18n/I18n";
import { NOT_PROVIDED, useMasterDataCopy } from "./masterDataCopy";

// Bins are not kept as records of their own: a bin is the location on a
// posted stock balance (GET /api/inventory/balances, scoped to the warehouses
// the reader may see). This list groups those balances by warehouse and bin,
// so a bin that never held stock is not listed.

type Balance = {
  sku: string;
  warehouseId: string;
  location?: string | null;
  locationKey?: string | null;
  onHandQuantity?: string | number | null;
  availableQuantity?: string | number | null;
  unit?: string | null;
  updatedAt?: string | null;
};
type BalancePage = { balances?: Balance[]; total?: number };
type Bin = {
  key: string;
  warehouseId: string;
  location: string;
  locationKey: string;
  skus: Set<string>;
  onHand: Map<string, bigint>;
  available: Map<string, bigint>;
  updatedAt: string;
};

const PAGE_SIZE = 200;
// At most this many pages are read; the list says so when stock has more rows.
const MAX_PAGES = 10;
const SCALE = 10_000n;

// Quantities are decimal strings with up to four places; they are added as
// whole ten-thousandths so no rounding creeps in.
function toUnits(value: string | number | null | undefined) {
  const match = /^(-?)(\d+)(?:\.(\d{0,4}))?/.exec(String(value ?? "0").trim());
  if (!match) return 0n;
  const units = BigInt(match[2]) * SCALE + BigInt((match[3] || "").padEnd(4, "0") || "0");
  return match[1] ? -units : units;
}
function fromUnits(units: bigint) {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / SCALE}.${String(absolute % SCALE).padStart(4, "0")}`;
}
const add = (totals: Map<string, bigint>, unit: string, value: string | number | null | undefined) =>
  totals.set(unit, (totals.get(unit) || 0n) + toUnits(value));

export default function BinListPage() {
  const { copy } = useMasterDataCopy();
  const { locale, timezone } = useI18n();
  const warehouseName = useWarehouseNames();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [search, setSearch] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setState("loading");
    (async () => {
      const rows: Balance[] = [];
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await apiJson<BalancePage>(`/api/inventory/balances?page=${page}&pageSize=${PAGE_SIZE}`);
        rows.push(...(result.balances || []));
        total = Number(result.total || 0);
        if (rows.length >= total || !(result.balances || []).length) break;
      }
      return { rows, more: rows.length < total };
    })()
      .then(({ rows, more }) => { if (!alive) return; setBalances(rows); setTruncated(more); setState("ready"); })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [reloadKey]);

  const bins = useMemo(() => {
    const grouped = new Map<string, Bin>();
    for (const row of balances) {
      const locationKey = String(row.locationKey || "").trim();
      const key = `${row.warehouseId}\u0000${locationKey}`;
      const bin = grouped.get(key) || {
        key, warehouseId: row.warehouseId, location: String(row.location || row.locationKey || "").trim(), locationKey,
        skus: new Set<string>(), onHand: new Map<string, bigint>(), available: new Map<string, bigint>(), updatedAt: "",
      };
      const unit = String(row.unit || "").trim();
      bin.skus.add(row.sku);
      add(bin.onHand, unit, row.onHandQuantity);
      add(bin.available, unit, row.availableQuantity ?? row.onHandQuantity);
      if (String(row.updatedAt || "") > bin.updatedAt) bin.updatedAt = String(row.updatedAt);
      grouped.set(key, bin);
    }
    // By warehouse, then bin; stock with no bin recorded comes last.
    return [...grouped.values()].sort((a, b) =>
      warehouseName(a.warehouseId).localeCompare(warehouseName(b.warehouseId), locale)
      || Number(!a.locationKey) - Number(!b.locationKey)
      || a.location.localeCompare(b.location, locale, { numeric: true }));
  }, [balances, warehouseName, locale]);

  const warehouses = useMemo(() => [...new Set(bins.map((bin) => bin.warehouseId))], [bins]);
  const query = search.trim().toLowerCase();
  const shown = bins.filter((bin) =>
    (!warehouse || bin.warehouseId === warehouse) &&
    (!query || [bin.location, bin.locationKey, bin.warehouseId, warehouseName(bin.warehouseId)].some((value) => String(value || "").toLowerCase().includes(query))));
  const filtered = Boolean(query || warehouse);
  // One total per unit: quantities in different units are never added.
  const totals = (byUnit: Map<string, bigint>) => [...byUnit.entries()]
    .map(([unit, units]) => `${formatQuantity(fromUnits(units))}${unit ? ` ${unit}` : ""}`).join(" · ") || NOT_PROVIDED;
  // The inventory balances list filtered to this bin. Stock with no bin has no
  // such filter, so it gets no link.
  const stockLink = (bin: Bin) => `/app/inventory/stock?${new URLSearchParams({ warehouseId: bin.warehouseId, locationKey: bin.locationKey })}`;

  return (
    <div className="space-y-5" data-testid="bin-list-page">
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Bin search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Bins come from posted stock: every bin that holds a stock record is listed, with its warehouse.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { setSearch(""); setWarehouse(""); }} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
              {copy("Reset")}
            </button>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
              <RefreshCw size={13} />{copy("Refresh")}
            </button>
          </div>
        </div>
        <ResponsiveFilters
          className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4"
          activeCount={warehouse ? 1 : 0}
          onReset={() => { setSearch(""); setWarehouse(""); }}
          leading={
          <Field label={copy("Search")}>
            <label className="flex items-center gap-2" style={{ ...inputStyle, paddingTop: 0, paddingBottom: 0 }}>
              <Search size={14} style={{ color: A.gray2 }} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={copy("Bin search")}
                placeholder={copy("Bin or warehouse")} className="h-9 min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          </Field>
          }
        >
          <Field label={copy("Warehouse")}>
            <select aria-label={copy("Warehouse")} value={warehouse} onChange={(event) => setWarehouse(event.target.value)} style={inputStyle}>
              <option value="">{copy("All warehouses")}</option>
              {warehouses.map((id) => <option key={id} value={id}>{warehouseName(id)}</option>)}
            </select>
          </Field>
        </ResponsiveFilters>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{copy("Bin list")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>
              {state === "ready" ? copy(bins.length === 1 ? "1 bin, {shown} shown" : "{total} bins, {shown} shown", { total: bins.length, shown: shown.length }) : NOT_PROVIDED}
            </div>
          </div>
        </div>
        {truncated && state === "ready" ? (
          <p className="px-5 pt-3 text-xs" style={{ color: A.orange }} data-testid="bin-list-truncated">
            {copy("Read the first {count} stock records; bins beyond them are not listed.", { count: balances.length })}
          </p>
        ) : null}
        {state === "loading" ? (
          <div className="px-6 py-12 text-center text-sm" style={{ color: A.sub }} aria-live="polite">{copy("Loading bins…")}</div>
        ) : state === "error" ? (
          <div className="px-6 py-12 text-center text-sm">
            <div style={{ color: A.red }}>{copy("Could not load the bins.")}</div>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="mt-3 text-xs text-blue-600">{copy("Try again")}</button>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm" style={{ color: A.sub }}>
            {filtered ? copy("No records match these filters") : copy("No bins yet. A bin is listed once stock is received or opening stock is posted into it.")}
          </div>
        ) : (
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`} data-testid="bin-list-table">
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                  {["Bin", "Warehouse"].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                  {["SKUs", "On hand", "Available"].map((label) => <th key={label} className={thRightClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                  {["Last updated", "Actions"].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((bin, index) => (
                  <tr key={bin.key} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < shown.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={tdIdClass}>
                      {bin.location
                        ? <Link to={stockLink(bin)} className={tableLinkClass}>{bin.location}</Link>
                        : <span style={{ color: A.sub }}>{copy("No bin recorded")}</span>}
                    </td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{warehouseName(bin.warehouseId)}</td>
                    <td className={tdNumericRightClass}>{bin.skus.size}</td>
                    <td className={tdNumericRightClass}>{totals(bin.onHand)}</td>
                    <td className={tdNumericRightClass}>{totals(bin.available)}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{formatDateTimeInTimeZone(bin.updatedAt || null, locale, timezone)}</td>
                    <td className={tdNowrapClass}>
                      {bin.locationKey ? <Link to={stockLink(bin)} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">{copy("View stock")}</Link> : <span style={{ color: A.gray2 }}>{NOT_PROVIDED}</span>}
                    </td>
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
