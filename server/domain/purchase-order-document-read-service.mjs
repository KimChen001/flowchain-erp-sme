import { buildPurchaseOrderDocument } from "../../shared/business-documents.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { listItemSupplierRecords, mapItemSupplierRecord } from "./master-data-commands.mjs";
import { mergeOperationalSettings } from "./workspace-settings-contract.mjs";

const text = (value) => String(value ?? "").trim();

// The purchase order document a person prints or saves as PDF and sends
// themselves. The caller has already read the PO through readPurchaseOrder,
// with the detail route's permission, tenant and price masking; this reads
// the rest in the same workspace: the stored supplier row (not the master
// data view, which defaults a currency and payment terms nobody recorded),
// the supplier's item links for supplier SKUs, the delivery warehouse, and
// the workspace's letterhead and PO template. Addresses are read live, so a
// reprint shows the supplier's current address.
export function createPurchaseOrderDocumentReadService({ prisma, env = process.env } = {}) {
  const db = async () => prisma || getPrismaClient(env);

  async function readPurchaseOrderDocument({ tenantId, order, access }) {
    if (!text(tenantId)) throw Object.assign(new Error("A tenant is required."), { code: "TENANT_CONTEXT_REQUIRED", status: 403 });
    const client = await db();
    const supplierId = text(order?.supplierId);
    const warehouseId = text(order?.metadata?.targetWarehouseId);
    const [tenant, supplier, warehouse, links] = await Promise.all([
      client.tenant.findUnique({ where: { id: tenantId }, select: { name: true, legalName: true, operationalSettings: true } }),
      // Only the fields a document prints come out of the builder; tax and
      // bank details in the metadata are never copied.
      supplierId ? client.supplier.findFirst({ where: { tenantId, id: supplierId }, select: { id: true, code: true, name: true, metadata: true } }) : null,
      warehouseId ? client.warehouse.findFirst({ where: { tenantId, id: warehouseId }, select: { id: true, code: true, name: true } }) : null,
      supplierId ? listItemSupplierRecords(client, tenantId, { supplierId }) : [],
    ]);
    const settings = mergeOperationalSettings(tenant?.operationalSettings).documents;
    return buildPurchaseOrderDocument({
      order,
      supplier,
      warehouse,
      supplierSkus: links.map((row) => mapItemSupplierRecord(row)),
      letterhead: settings.letterhead,
      template: settings.purchaseOrder,
      documentLanguage: settings.documentLanguage,
      workspace: { legalName: tenant?.legalName, name: tenant?.name },
      access: { prices: access?.prices === true },
    });
  }

  return { readPurchaseOrderDocument };
}
