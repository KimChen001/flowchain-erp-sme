import { buildCustomerInvoiceDocument } from "../../shared/business-documents.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { CUSTOMER_NAMESPACE } from "./master-data-commands.mjs";
import { OperationalFinanceReadError } from "./operational-finance-read-service.mjs";
import { mergeOperationalSettings } from "./workspace-settings-contract.mjs";

const text = (value) => String(value ?? "").trim();

// What the reader may see on the invoice, as the detail read decided it: the
// amounts (finance.amounts.read) and the customer (finance.partner_snapshot.read).
// Nothing is checked again here, so the document never shows more than the
// detail does.
export function customerInvoiceDocumentAccess(invoice) {
  const visibility = invoice?.fieldVisibility || {};
  return {
    amounts: visibility.totalAmount?.visible === true,
    partner: visibility.customerName?.visible === true,
  };
}

// The stored customer an invoice names: its id is the customer's own id (or,
// for older records, the row id or the code). The id match wins over the others.
function pickCustomer(rows, customerId) {
  const byPayload = rows.find((row) => text(row.payload?.id) === customerId);
  return byPayload || rows.find((row) => row.id === customerId) || rows.find((row) => row.recordKey === customerId) || null;
}

// The workspace's payment terms a recorded value names (by id or code), so
// the document prints the recorded name; none when nothing was recorded.
export async function readPaymentTerms(client, tenantId, value) {
  const stored = text(value);
  if (!stored || typeof client.paymentTerm?.findMany !== "function") return [];
  return client.paymentTerm.findMany({ where: { tenantId, OR: [{ id: stored }, { code: stored }] }, select: { id: true, code: true, name: true }, take: 2 });
}

// The customer invoice document a person prints or saves as PDF and sends
// themselves. The caller has already read the invoice through
// customerInvoiceDetail, with the detail route's permission, tenant and field
// masking; this reads the rest in the same workspace: the stored customer
// record (only when the customer may be seen, and not the master data view)
// and the workspace's letterhead and invoice template. The customer's address
// is read live, so a reprint shows the current one.
export function createCustomerInvoiceDocumentReadService({ prisma, env = process.env } = {}) {
  const db = async () => prisma || getPrismaClient(env);

  async function readCustomerInvoiceDocument({ tenantId, invoice }) {
    if (!text(tenantId)) throw new OperationalFinanceReadError("TENANT_CONTEXT_REQUIRED", "A tenant is required.", 403);
    const client = await db();
    const access = customerInvoiceDocumentAccess(invoice);
    const customerId = access.partner ? text(invoice?.customerId) : "";
    const [tenant, customers] = await Promise.all([
      client.tenant.findUnique({ where: { id: tenantId }, select: { name: true, legalName: true, operationalSettings: true } }),
      // Only the fields a document prints come out of the builder; the
      // customer's currency and credit standing are never copied.
      customerId
        ? client.runtimeRecord.findMany({
            where: { tenantId, namespace: CUSTOMER_NAMESPACE, OR: [{ id: customerId }, { recordKey: customerId }, { payload: { path: ["id"], equals: customerId } }] },
            select: { id: true, recordKey: true, payload: true },
            take: 3,
          })
        : [],
    ]);
    const settings = mergeOperationalSettings(tenant?.operationalSettings).documents;
    const customer = pickCustomer(customers, customerId);
    return buildCustomerInvoiceDocument({
      invoice,
      customer,
      paymentTerms: await readPaymentTerms(client, tenantId, customer?.payload?.paymentTerms),
      letterhead: settings.letterhead,
      template: settings.customerInvoice,
      documentLanguage: settings.documentLanguage,
      workspace: { legalName: tenant?.legalName, name: tenant?.name },
      access,
    });
  }

  return { readCustomerInvoiceDocument };
}
