import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { A, Card } from "../../components/ui";
import { ContractTable } from "./ContractTable";
import { CONTRACT_PAGE_SIZE, contractErrorText, contractsApi, useContractCopy, type ContractList } from "./contractShared";

// The supplier page's Contracts tab (docs/contracts-module-design.md §3):
// that supplier's contracts, newest first, and a New contract button that
// opens the form with the supplier filled in. Shown only when the contracts
// capability is on and the reader has contracts.contract.read.
export function SupplierContractsPanel({ supplierId }: { supplierId: string }) {
  const t = useContractCopy();
  const [data, setData] = useState<ContractList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    contractsApi.list(new URLSearchParams({ supplierId, pageSize: String(CONTRACT_PAGE_SIZE) }))
      .then((value) => { if (alive) setData(value); })
      .catch((caught) => { if (alive) setError(caught); });
    return () => { alive = false; };
  }, [supplierId, tick]);
  const contracts = data?.contracts || [];
  const newButton = data?.access.manage ? (
    <Link to={`/app/contracts/new?supplierId=${encodeURIComponent(supplierId)}`} data-testid="supplier-contract-new" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">
      <Plus size={13} /> {t("New contract")}
    </Link>
  ) : null;
  return (
    <Card data-testid="supplier-contracts">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
        <div>
          <div className="text-sm font-semibold" style={{ color: A.label }}>{t("This supplier's contracts")}</div>
          {data && <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{t(data.total === 1 ? "1 contract, {shown} shown" : "{total} contracts, {shown} shown", { total: data.total, shown: contracts.length })}</div>}
        </div>
        {newButton}
      </div>
      {error ? (
        <div className="p-8 text-center">
          <div role="alert" className="text-sm" style={{ color: A.red }}>{t("Could not load contracts.")} {contractErrorText(error, t)}</div>
          <button type="button" onClick={() => setTick((value) => value + 1)} className="mt-3 text-xs text-blue-600">{t("Retry")}</button>
        </div>
      ) : !data ? (
        <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{t("Loading…")}</div>
      ) : contracts.length === 0 ? (
        <div className="py-12 text-center text-sm" style={{ color: A.sub }} data-testid="supplier-contracts-empty">{t("No contracts with this supplier yet.")}</div>
      ) : (
        <ContractTable contracts={contracts} canManage={data.access.manage} showSupplier={false} testId="supplier-contract-table" />
      )}
    </Card>
  );
}
