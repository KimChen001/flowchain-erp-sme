import { A, Chip } from "../../components/ui";
import {
  listTableCardsRef,
  tableBodyTextClass,
  tableMinSmClass,
  tableScrollClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";
import type { PaymentTerm, TaxCode, WarehouseBin } from "../../types/scm";
import type { MasterDataTableTab } from "./Page";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { dueDateRule, NOT_PROVIDED, orNotProvided, formatPercent, taxTypeLabel, useMasterDataCopy } from "./masterDataCopy";

function statusStyle(status: string) {
  if (["启用", "已认证", "可用"].includes(status)) return { color: A.green, bg: "#f0faf4" };
  if (["停用", "冻结", "高"].includes(status)) return { color: A.red, bg: "#fff1f0" };
  return { color: A.orange, bg: "#fff8f0" };
}

function BoolText({ value }: { value: boolean }) {
  const { copy } = useMasterDataCopy();
  return <span style={{ color: value ? A.green : A.gray2 }}>{copy(value ? "Yes" : "No")}</span>;
}

function HeaderRow({ labels }: { labels: string[] }) {
  const { copy } = useMasterDataCopy();
  return (
    <thead><tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
      {labels.map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{copy(label)}</th>)}
    </tr></thead>
  );
}

// Items and suppliers have their own workbenches (ItemMasterWorkbench and the
// supplier pages), so this component only renders the remaining reference
// tables.
export default function MasterDataTables({
  tab,
  warehouses,
  taxCodes,
  paymentTerms,
}: {
  tab: Exclude<MasterDataTableTab, "items" | "suppliers">;
  warehouses: WarehouseBin[];
  taxCodes: TaxCode[];
  paymentTerms: PaymentTerm[];
}) {
  const { copy, language, locale } = useMasterDataCopy();

  if (tab === "warehouses") {
    // A column no warehouse has a value for is left out, and "Available"
    // shows only when some warehouse is not, so a short list is not mostly
    // dashes. Every dash is the same muted grey.
    const has = (pick: (item: WarehouseBin) => unknown) => warehouses.some((item) => { const value = pick(item); return value !== null && value !== undefined && value !== "" && value !== 0; });
    const columns: Array<{ label: string; show: boolean; cell: (item: WarehouseBin) => React.ReactNode; className?: string }> = [
      { label: "Warehouse code", show: true, className: tdIdClass, cell: (item) => <BusinessEntityLink entityType="warehouse" entityId={item.warehouseId || item.warehouseCode}>{item.warehouseCode}</BusinessEntityLink> },
      { label: "Warehouse name", show: true, className: `${tdNameClass} max-w-[180px] truncate font-medium`, cell: (item) => <span style={{ color: A.label }}>{item.warehouseName}</span> },
      { label: "Zone", show: has((item) => item.zone), cell: (item) => orNotProvided(item.zone) },
      { label: "Bin", show: has((item) => item.bin), cell: (item) => item.bin ? <BusinessEntityLink entityType="bin" entityId={item.bin}>{item.bin}</BusinessEntityLink> : NOT_PROVIDED },
      { label: "Capacity", show: has((item) => item.capacity), className: tdNumericClass, cell: (item) => item.capacity ? item.capacity.toLocaleString(locale) : NOT_PROVIDED },
      { label: "Utilization", show: has((item) => item.capacity), className: tdNumericClass, cell: (item) => item.capacity ? <span style={{ color: item.utilization > 0.85 ? A.red : A.label }}>{formatPercent(item.utilization, locale)}</span> : NOT_PROVIDED },
      { label: "Temperature requirement", show: has((item) => item.temperatureRequirement), cell: (item) => orNotProvided(item.temperatureRequirement) },
      { label: "QA status", show: true, cell: (item) => { const style = statusStyle(item.qaStatus); return <Chip label={item.qaStatus} color={style.color} bg={style.bg} />; } },
      { label: "Available", show: warehouses.some((item) => !item.available), cell: (item) => <BoolText value={item.available} /> },
      { label: "Owner", show: has((item) => item.owner), cell: (item) => orNotProvided(item.owner) },
      { label: "Actions", show: true, cell: (item) => <BusinessEntityLink entityType="warehouse" entityId={item.warehouseId || item.warehouseCode} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">{copy("Details")}</BusinessEntityLink> },
    ];
    const shown = columns.filter((column) => column.show);
    return (
      <div className={tableScrollClass} ref={listTableCardsRef}>
        <table className={shown.length > 6 ? tableMinSmClass : `w-full text-left ${tableBodyTextClass}`}>
          <HeaderRow labels={shown.map((column) => column.label)} />
          <tbody>{warehouses.map((item, index) => (
            <tr key={`${item.warehouseCode}-${item.bin}`} style={{ borderBottom: index < warehouses.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
              {shown.map((column) => <td key={column.label} className={column.className || tdNowrapClass} style={column.className ? undefined : { color: A.sub }}>{column.cell(item)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
  }

  if (tab === "tax-codes") {
    return (
      <div className={tableScrollClass} ref={listTableCardsRef}>
        <table className={tableMinSmClass}>
          <HeaderRow labels={["Tax code", "Tax code name", "Tax rate", "Tax type", "Region", "Default", "Status", "Description", "Actions"]} />
          <tbody>{taxCodes.map((item, index) => {
            const style = statusStyle(item.status);
            return (
              <tr key={item.code} style={{ borderBottom: index < taxCodes.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                <td className={tdIdClass}><BusinessEntityLink entityType="tax_code" entityId={item.code}>{item.code}</BusinessEntityLink></td>
                <td className={`${tdNameClass} max-w-[180px] truncate font-medium`} style={{ color: A.label }}>{item.name}</td>
                <td className={tdNumericClass} style={{ color: A.sub }}>{formatPercent(item.rate, locale)}</td>
                <td className={tdNowrapClass} style={{ color: A.sub }}>{taxTypeLabel(item.type, language)}</td>
                <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.region)}</td>
                <td className={tdNowrapClass}><BoolText value={item.isDefault} /></td>
                <td className={tdNowrapClass}><Chip label={item.status} color={style.color} bg={style.bg} /></td>
                <td className="px-4 py-3 max-w-[320px] truncate" style={{ color: A.sub }}>{orNotProvided(item.description)}</td>
                <td className={tdNowrapClass}><BusinessEntityLink entityType="tax_code" entityId={item.code} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">{copy("Details")}</BusinessEntityLink></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    );
  }

  return (
    <div className={tableScrollClass} ref={listTableCardsRef}>
      <table className={tableMinSmClass}>
        <HeaderRow labels={["Term code", "Term name", "Net days", "Discount rule", "Due date rule", "Status", "Description", "Actions"]} />
        <tbody>{paymentTerms.map((item, index) => {
          const style = statusStyle(item.status);
          return (
            <tr key={item.code} style={{ borderBottom: index < paymentTerms.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
              <td className={tdIdClass}><BusinessEntityLink entityType="payment_term" entityId={item.code}>{item.code}</BusinessEntityLink></td>
              <td className={`${tdNameClass} max-w-[180px] truncate font-medium`} style={{ color: A.label }}>{item.name}</td>
              <td className={tdNumericClass} style={{ color: A.sub }}>{item.netDays}</td>
              <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.discountRule)}</td>
              <td className={tdNowrapClass} style={{ color: A.sub }}>{item.dueDateRule || dueDateRule(item.netDays, language)}</td>
              <td className={tdNowrapClass}><Chip label={item.status} color={style.color} bg={style.bg} /></td>
              <td className="px-4 py-3 max-w-[360px] truncate" style={{ color: A.sub }}>{orNotProvided(item.description)}</td>
              <td className={tdNowrapClass}><BusinessEntityLink entityType="payment_term" entityId={item.code} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">{copy("Details")}</BusinessEntityLink></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
