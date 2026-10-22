import { useNavigate, useSearchParams } from "react-router";
import { ContractsListPage } from "./ContractsListPage";
import { ContractDetailPage } from "./ContractDetailPage";
import { ContractForm } from "./ContractForm";

// The Contracts module (docs/contracts-module-design.md, K1): the list, Ending
// soon, the new contract form and one contract's page, by route. The route
// gate in FlowChainApp has already checked the contracts capability and
// contracts.contract.read; every write is checked again by the API.
export default function ContractsPage({ routeId, contractId }: { routeId: string; contractId: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  if (routeId === "contracts:ending") return <ContractsListPage key="ending" mode="ending" />;
  if (routeId === "contracts:new") {
    // Opened from a supplier's page, the form starts with that supplier and
    // Cancel goes back there.
    const supplierId = params.get("supplierId") || "";
    return (
      <ContractForm
        initialSupplierId={supplierId}
        onCancel={() => navigate(supplierId ? `/app/master-data/suppliers/${encodeURIComponent(supplierId)}` : "/app/contracts/list")}
        onSaved={(contract) => navigate(`/app/contracts/${encodeURIComponent(contract.id)}`, { replace: true })}
      />
    );
  }
  if (routeId === "contracts:detail" && contractId) return <ContractDetailPage key={contractId} contractId={contractId} />;
  return <ContractsListPage key="all" mode="all" />;
}
