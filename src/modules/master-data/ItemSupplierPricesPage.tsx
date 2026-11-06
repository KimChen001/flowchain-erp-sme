import { useEffect, useRef, useState } from "react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import {
  tableBodyTextClass,
  tableLinkClass,
  tableScrollClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericRightClass,
  thClass,
  thRightClass,
} from "../../components/ui/workbenchTable";
import { EntityLink } from "../../components/business/EntityLink";
import { DataImportLink } from "./DataImportLink";
import { NOT_PROVIDED, useMasterDataCopy } from "./masterDataCopy";

// Supplier prices (owner decision 2026-10-09): every item-supplier link across
// items, from GET /api/master-data/item-suppliers. Read only; links are
// edited where they are today. A reference price the reader may not see
// (procurement.prices.read) comes back null and is shown as hidden, never 0.

type LinkRow = {
  relationshipId: string;
  itemId: string;
  supplierId: string;
  supplierSku: string;
  active: boolean;
  approved: boolean;
  preferred: boolean;
  leadTimeDays: number | null;
  minimumOrderQuantity: number | null;
  referencePrice: number | null;
  currency: string;
  restrictedFields?: string[];
  item: { itemId: string; sku: string; itemName: string; status: string | null };
  supplier: { supplierId: string; supplierCode: string; supplierName: string; status: string | null };
};
type ItemOption = { id: string; sku: string; itemName: string };
type SupplierOption = { id: string; supplierCode: string; supplierName: string };
type LinkPage = {
  rows: LinkRow[];
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  options?: { items: ItemOption[]; suppliers: SupplierOption[] };
  visibility: { prices: boolean };
};

const PAGE_SIZE = 200;

export default function ItemSupplierPricesPage() {
  const { copy, locale } = useMasterDataCopy();
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [pricesVisible, setPricesVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [itemId, setItemId] = useState("");
  // The filters' options come with an unfiltered read and are kept, so
  // choosing one never empties the lists.
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [items, setItems] = useState<ItemOption[]>([]);
  const sequence = useRef(0);
  const loadedOnce = useRef(false);

  const load = async (offset = 0) => {
    const current = ++sequence.current;
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({ query, supplierId, itemId, limit: String(PAGE_SIZE), offset: String(offset) });
      const page = await apiJson<LinkPage>(`/api/master-data/item-suppliers?${params}`);
      if (current !== sequence.current) return;
      setRows((existing) => (offset ? [...existing, ...page.rows] : page.rows));
      setTotal(page.total);
      setTruncated(Boolean(page.truncated));
      setPricesVisible(page.visibility?.prices !== false);
      if (page.options) {
        setSuppliers(page.options.suppliers);
        setItems(page.options.items);
      }
    } catch {
      if (current === sequence.current) setError(true);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  // Filters apply as they change; typing waits for a short pause.
  useEffect(() => {
    const timer = setTimeout(() => load(0), loadedOnce.current ? 300 : 0);
    loadedOnce.current = true;
    return () => clearTimeout(timer);
  }, [query, supplierId, itemId]);

  const filtered = Boolean(query || supplierId || itemId);
  const resetFilters = () => { setQuery(""); setSupplierId(""); setItemId(""); };
  const number = (value: number, digits = 0) => value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) });
  const muted = (title: string) => <span title={title} style={{ color: A.gray2 }}>{NOT_PROVIDED}</span>;
  const price = (row: LinkRow) => {
    if (row.referencePrice !== null) return number(row.referencePrice, 2);
    return row.restrictedFields?.includes("referencePrice") ? muted(copy("Hidden for your role")) : muted(copy("Not recorded"));
  };
  const remaining = Math.max(0, total - rows.length);

  return (
    <div className="space-y-5" data-testid="item-supplier-prices">
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Supplier price search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Read only. Search every item's suppliers by item, supplier or supplier SKU.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={resetFilters} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>{copy("Reset")}</button>
            <button type="button" onClick={() => load(0)} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>{copy("Refresh")}</button>
            <DataImportLink type="item-suppliers" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={copy("Search")}>
            <input aria-label={copy("Search supplier prices")} placeholder={copy("SKU, item, supplier or supplier SKU")} value={query} onChange={(event) => setQuery(event.target.value)} style={inputStyle} />
          </Field>
          <Field label={copy("Supplier")}>
            <select aria-label={copy("Filter by supplier")} value={supplierId} onChange={(event) => setSupplierId(event.target.value)} style={inputStyle}>
              <option value="">{copy("All suppliers")}</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplierName} · {supplier.supplierCode}</option>)}
            </select>
          </Field>
          <Field label={copy("Item")}>
            <select aria-label={copy("Filter by item")} value={itemId} onChange={(event) => setItemId(event.target.value)} style={inputStyle}>
              <option value="">{copy("All items")}</option>
              {items.map((item) => <option key={item.id} value={item.id}>{item.sku}{item.itemName ? ` · ${item.itemName}` : ""}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{copy("Supplier price list")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }} data-testid="item-supplier-prices-count">
              {copy(total === 1 ? "1 link, {shown} shown" : "{total} links, {shown} shown", { total, shown: rows.length })}
            </div>
          </div>
        </div>
        {!pricesVisible && <p className="px-5 pt-3 text-[11px]" style={{ color: A.sub }} data-testid="item-supplier-prices-hidden">{copy("Reference prices are hidden for your role.")}</p>}
        {truncated && <p className="px-5 pt-1 text-[11px]" style={{ color: A.orange }}>{copy("Not every link could be read at once. Choose a supplier or an item to see all of its links.")}</p>}
        {error ? (
          <div className="p-8 text-center">
            <div className="text-sm" style={{ color: A.red }}>{copy("Could not load supplier prices.")}</div>
            <button type="button" onClick={() => load(0)} className="mt-3 text-xs text-blue-600">{copy("Try again")}</button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{copy("Loading supplier prices…")}</div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }} data-testid="item-supplier-prices-empty">
            <span className="font-semibold" style={{ color: A.label }}>{copy(filtered ? "No supplier prices match these filters" : "No supplier prices yet")}</span>
            <br />
            <span className="text-xs">{copy(filtered ? "Reset the filters to see every link." : "Link items to a supplier under Supplied items on the supplier's page, or import a file of item–supplier links.")}</span>
          </div>
        ) : (
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[1180px] text-left ${tableBodyTextClass}`} data-testid="item-supplier-prices-table">
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>SKU</th>
                  {["Item name", "Supplier", "Supplier SKU"].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{copy("Reference price")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{copy("Currency")}</th>
                  {["MOQ", "Lead time"].map((label) => <th key={label} className={thRightClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                  {["Preferred", "Approved", "Status"].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.relationshipId} data-testid="item-supplier-price-row" className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < rows.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <EntityLink kind="item" id={row.itemId} className={tableLinkClass}>{row.item.sku}</EntityLink>
                    </td>
                    <td className={`${tdNameClass} max-w-[240px] truncate font-medium`} style={{ color: A.label }} title={row.item.itemName}>{row.item.itemName || NOT_PROVIDED}</td>
                    <td className={`${tdNameClass} max-w-[220px]`} title={row.supplier.supplierName}>
                      <EntityLink kind="supplier" id={row.supplierId} className={tableLinkClass}>{row.supplier.supplierName}</EntityLink>
                      <div className="text-[11px]" style={{ color: A.sub }}>{row.supplier.supplierCode}</div>
                    </td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{row.supplierSku || NOT_PROVIDED}</td>
                    <td className={tdNumericRightClass} data-testid="item-supplier-price">{price(row)}</td>
                    <td className={tdNowrapClass}>{row.currency || NOT_PROVIDED}</td>
                    <td className={tdNumericRightClass}>{row.minimumOrderQuantity === null ? muted(copy("Not recorded")) : number(row.minimumOrderQuantity)}</td>
                    <td className={tdNumericRightClass}>{row.leadTimeDays === null ? muted(copy("Not recorded")) : copy("{count} days", { count: number(row.leadTimeDays) })}</td>
                    <td className={tdNowrapClass}>{row.preferred ? <Chip label={copy("Preferred")} color={A.blue} bg="#f0f6ff" /> : <span style={{ color: A.gray2 }}>{NOT_PROVIDED}</span>}</td>
                    <td className={tdNowrapClass}>{row.approved ? <Chip label={copy("Approved")} color={A.green} bg="#f0faf4" /> : <Chip label={copy("Not approved")} color={A.orange} bg="#fff8f0" />}</td>
                    <td className={tdNowrapClass}>{row.active ? <Chip label={copy("Active")} color={A.green} bg="#f0faf4" /> : <Chip label={copy("Inactive")} color={A.gray1} bg={A.gray6} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {remaining > 0 && (
              <div className="flex justify-center p-4">
                <button type="button" disabled={loading} onClick={() => load(rows.length)} className="h-8 rounded-lg px-3 text-xs font-medium disabled:opacity-50" style={{ background: A.gray6, color: A.label }}>
                  {copy("Load {count} more", { count: Math.min(PAGE_SIZE, remaining) })}
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
