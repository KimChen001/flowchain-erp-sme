import { Link } from "react-router";
import { A } from "../../components/ui";
import { tableBodyTextClass, tableLinkClass, tableScrollClass } from "../../components/ui/workbenchTable";
import { typography } from "../../components/ui/typography";
import { EntityLink } from "../../components/business/EntityLink";
import { ContractStateChip, TYPE_LABEL, keyDateLabel, useContractCopy, useContractFormat, type ContractView } from "./contractShared";

// The contracts table on the list, Ending soon and the supplier's Contracts
// tab: the number (their reference under it), title, supplier, type, dates,
// the key date and what it is, the owner and the state, with the action
// pinned on the right. Rows keep the order the server gave them. Cells are a
// little tighter than the workbench default and the long text columns wrap,
// so at 1440 px every column, the state included, shows beside the pinned
// action without scrolling.
const th = `px-2.5 py-3 text-left ${typography.tableHeader} whitespace-nowrap align-bottom`;
const td = "px-2.5 py-3 align-top";
const nowrap = `${td} whitespace-nowrap tabular-nums`;

export function ContractTable({ contracts, canManage, showSupplier = true, testId = "contract-table" }: { contracts: ContractView[]; canManage: boolean; showSupplier?: boolean; testId?: string }) {
  const t = useContractCopy();
  const f = useContractFormat();
  return (
    <div className={tableScrollClass}>
      <table className={`w-full ${showSupplier ? "min-w-[1080px]" : "min-w-[940px]"} text-left ${tableBodyTextClass}`} data-testid={testId}>
        <thead>
          <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
            <th className={`${th} sticky left-0 z-20 bg-white pl-4`} style={{ color: A.gray1 }}>{t("Number")}</th>
            <th className={th} style={{ color: A.gray1 }}>{t("Title")}</th>
            {showSupplier && <th className={th} style={{ color: A.gray1 }}>{t("Supplier")}</th>}
            {["Type", "Start", "End", "Key date", "Owner", "Status"].map((label) => <th key={label} className={th} style={{ color: A.gray1 }}>{t(label)}</th>)}
            <th className={`${th} sticky right-0 z-20 bg-white pr-4`} style={{ color: A.gray1 }}>{t("Actions")}</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((contract, index) => {
            const kind = keyDateLabel(contract);
            const editable = canManage && contract.status !== "terminated";
            return (
              <tr key={contract.id} data-testid="contract-row" data-contract-id={contract.id} data-state={contract.state} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < contracts.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                <td className={`${td} sticky left-0 z-10 whitespace-nowrap bg-white pl-4 font-medium`}>
                  <EntityLink kind="contract" id={contract.id} className={tableLinkClass}>{contract.number}</EntityLink>
                  {contract.externalReference && <div className="max-w-[150px] truncate text-[11px] font-normal" style={{ color: A.sub }} title={`${t("Their reference")}: ${contract.externalReference}`}>{contract.externalReference}</div>}
                </td>
                <td className={`${td} min-w-[140px] max-w-[190px]`} title={contract.title}>
                  <div className="line-clamp-2 font-medium" style={{ color: A.label }}>{contract.title}</div>
                </td>
                {showSupplier && (
                  <td className={`${td} min-w-[110px] max-w-[150px]`}>
                    {contract.supplier ? <EntityLink kind="supplier" id={contract.supplier.id} className={tableLinkClass}>{contract.supplier.name}</EntityLink> : <span style={{ color: A.gray2 }}>—</span>}
                  </td>
                )}
                <td className={`${td} min-w-[76px] max-w-[96px]`}>{t(TYPE_LABEL[contract.type] || "Other")}</td>
                <td className={nowrap}>{f.day(contract.startDate)}</td>
                <td className={nowrap}>{contract.endDate ? f.day(contract.endDate) : <span className="font-sans" style={{ color: A.sub }}>{t("No end date")}</span>}</td>
                <td className={nowrap} data-testid="contract-key-date" data-date={contract.keyDate || ""}>
                  {contract.keyDate ? (
                    <>
                      <div>{f.day(contract.keyDate)}</div>
                      {kind && <div className="text-[11px]" style={{ color: A.sub }}>{t(kind)}</div>}
                    </>
                  ) : <span style={{ color: A.gray2 }}>—</span>}
                </td>
                <td className={`${td} min-w-[80px] max-w-[110px]`} style={{ color: A.sub }}>{contract.owner?.name || "—"}</td>
                <td className={`${td} whitespace-nowrap`}><ContractStateChip state={contract.state} /></td>
                <td className={`${td} sticky right-0 z-10 whitespace-nowrap bg-white pr-4`}>
                  {editable ? (
                    <Link to={`/app/contracts/${encodeURIComponent(contract.id)}?edit=1`} data-testid="contract-row-edit" className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ background: "#f0f6ff", color: A.blue }}>{t("Edit")}</Link>
                  ) : (
                    <Link to={`/app/contracts/${encodeURIComponent(contract.id)}`} data-testid="contract-row-open" className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium" style={{ color: A.label }}>{t("Open")}</Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
