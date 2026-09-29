import { A, Chip } from "../../components/ui";
import {
  tableMinMdClass,
  tableMinSmClass,
  tableScrollClass,
  tdActionClass,
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
    return (
      <div className={tableScrollClass}>
        <table className={tableMinMdClass}>
          <HeaderRow labels={["Warehouse code", "Warehouse name", "Zone", "Bin", "Capacity", "Utilization", "Temperature requirement", "QA status", "Available", "Owner", "Actions"]} />
          <tbody>{warehouses.map((item, index) => {
            const style = statusStyle(item.qaStatus);
            return (
              <tr key={`${item.warehouseCode}-${item.bin}`} style={{ borderBottom: index < warehouses.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                <td className={tdIdClass}><BusinessEntityLink entityType="warehouse" entityId={item.warehouseCode}>{item.warehouseCode}</BusinessEntityLink></td>
                <td className={`${tdNameClass} max-w-[180px] truncate font-medium`} style={{ color: A.label }}>{item.warehouseName}</td>
                <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.zone)}</td>
                <td className={tdNowrapClass}>{item.bin ? <BusinessEntityLink entityType="bin" entityId={item.bin}>{item.bin}</BusinessEntityLink> : NOT_PROVIDED}</td>
                <td className={tdNumericClass} style={{ color: A.sub }}>{item.capacity ? item.capacity.toLocaleString(locale) : NOT_PROVIDED}</td>
                <td className={`${tdNumericClass} font-medium`} style={{ color: item.utilization > 0.85 ? A.red : A.label }}>{item.capacity ? formatPercent(item.utilization, locale) : NOT_PROVIDED}</td>
                <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.temperatureRequirement)}</td>
                <td className={tdNowrapClass}><Chip label={item.qaStatus} color={style.color} bg={style.bg} /></td>
                <td className={tdNowrapClass}><BoolText value={item.available} /></td>
                <td className={tdNowrapClass} style={{ color: A.sub }}>{orNotProvided(item.owner)}</td>
                <td className={tdActionClass}><BusinessEntityLink entityType="warehouse" entityId={item.warehouseCode} className="rounded-md bg-slate-100 px-2 py-1">{copy("Details")}</BusinessEntityLink></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    );
  }

  if (tab === "tax-codes") {
    return (
      <div className={tableScrollClass}>
        <table className={tableMinMdClass}>
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
                <td className={tdActionClass}><BusinessEntityLink entityType="tax_code" entityId={item.code} className="rounded-md bg-slate-100 px-2 py-1">{copy("Details")}</BusinessEntityLink></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    );
  }

  return (
    <div className={tableScrollClass}>
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
              <td className={tdActionClass}><BusinessEntityLink entityType="payment_term" entityId={item.code} className="rounded-md bg-slate-100 px-2 py-1">{copy("Details")}</BusinessEntityLink></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
