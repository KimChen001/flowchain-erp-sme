import { Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import OperationalFinanceO2cWorkbench, {
  type O2cView,
} from "./OperationalFinanceO2cWorkbench";
import OperationalFinanceP2pWorkbench from "./OperationalFinanceP2pWorkbench";
import InternalSettlementWorkbench from "./InternalSettlementWorkbench";
import BankReconciliationWorkbench from "./BankReconciliationWorkbench";
import { NewSupplierInvoice, SupplierInvoiceDetail } from "./SupplierInvoiceScreens";

export type FinanceTab =
  | "invoices"
  | "overview"
  | "payables"
  | "credits"
  | "reconciliation"
  | "bank-statements"
  | "bank-reconciliation"
  | "settlement"
  | "settlement-detail"
  | "match"
  | "supplier-invoice-new"
  | "supplier-invoice-detail"
  | O2cView;

const fallbackCopy = [
  "finance.emptyTitle",
  "finance.emptyDescription",
] as const;

export default function FinanceWorkbench({ initialView = "invoices" }: { initialView?: FinanceTab; onNavigate?: (routeId: string) => void }) {
  const { t } = useI18n();
  if (["customer-invoices", "customer-invoice-new", "customer-invoice-detail", "receivables", "aging", "customer-credit-notes"].includes(initialView))
    return <OperationalFinanceO2cWorkbench view={initialView as O2cView} />;
  if (initialView === "supplier-invoice-new") return <NewSupplierInvoice />;
  if (initialView === "supplier-invoice-detail") return <SupplierInvoiceDetail />;
  if (["overview", "invoices", "payables", "credits", "match"].includes(initialView))
    return <OperationalFinanceP2pWorkbench view={initialView as "overview" | "invoices" | "payables" | "credits" | "match"} />;
  if (initialView === "reconciliation") return <InternalSettlementWorkbench view="cashbook" />;
  if (initialView === "bank-statements" || initialView === "bank-reconciliation") return <BankReconciliationWorkbench initialView={initialView} />;
  if (initialView === "settlement" || initialView === "settlement-detail") return <InternalSettlementWorkbench view={initialView} />;
  const copy = fallbackCopy;
  return <Card className="py-16 text-center"><h2 className="text-base font-semibold">{t(copy[0])}</h2><p className="mt-2 text-xs text-slate-500">{t(copy[1])}</p></Card>;
}
