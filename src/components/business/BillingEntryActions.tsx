import { FilePlus2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useRouteAvailability } from "../../app/routeAvailability";
import { useI18n } from "../../i18n/I18n";
import { usePermissionSet } from "../../lib/usePermissionSet";

// A bill is recorded against a purchase order, before or after its goods are
// received, and an invoice against goods that were shipped
// (docs/bills-invoices-and-accounting-handoff.md). These buttons open the
// entry form with the source document already chosen; the server checks
// quantities, prices and permissions again, and a bill is paid only after the
// three-way match.

// English source copy with its Chinese translation.
const COPY = {
  recordBill: ["Record supplier invoice", "录入采购发票"],
  recordBillNote: ["Paid only after the three-way match", "三单匹配后才能付款"],
  createInvoice: ["Create customer invoice", "开销售发票"],
  createInvoiceNote: ["For goods already shipped", "按已发出的货物开票"],
} as const;

const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50";

function EntryButton({ testId, label, note, to, showNote }: { testId: string; label: string; note: string; to: string; showNote: boolean }) {
  const navigate = useNavigate();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" data-testid={testId} className={buttonClass} onClick={() => navigate(to)}>
        <FilePlus2 size={14} />
        {label}
      </button>
      {showNote && <span className="text-[11px] text-slate-500">{note}</span>}
    </span>
  );
}

// "Record bill" on a purchase order or a posted receipt.
export function RecordBillAction({ purchaseOrderId, receiptId, showNote = false }: { purchaseOrderId?: string; receiptId?: string; showNote?: boolean }) {
  const { language } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  const source = receiptId ? `receipt=${encodeURIComponent(receiptId)}` : purchaseOrderId ? `po=${encodeURIComponent(purchaseOrderId)}` : "";
  if (!source || !permissions?.has("finance.supplier_invoice.create") || !canOpenRoute("procurement:bill-new")) return null;
  return <EntryButton testId="record-bill" label={tr("recordBill")} note={tr("recordBillNote")} to={`/app/procurement/bills/new?${source}`} showNote={showNote} />;
}

// "Create invoice" on a sales order or a posted shipment.
export function CreateInvoiceAction({ salesOrderId, shipmentId, showNote = false }: { salesOrderId?: string; shipmentId?: string; showNote?: boolean }) {
  const { language } = useI18n();
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  const source = shipmentId ? `shipment=${encodeURIComponent(shipmentId)}` : salesOrderId ? `salesOrder=${encodeURIComponent(salesOrderId)}` : "";
  if (!source || !permissions?.has("finance.customer_invoice.create") || !canOpenRoute("sales:invoice-new")) return null;
  return <EntryButton testId="create-invoice" label={tr("createInvoice")} note={tr("createInvoiceNote")} to={`/app/sales/invoices/new?${source}`} showNote={showNote} />;
}
