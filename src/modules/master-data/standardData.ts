export type CustomerMaster = {
  code: string; name: string; contact: string; phone: string; address: string;
  // "" means the workspace has not recorded a credit status.
  creditStatus: "正常" | "受限" | "待评估" | "";
  paymentTerms: string; status: "启用" | "停用";
};

export type PrintTemplateCatalogItem = {
  id: string; name: string; documentType: string; isDefault: boolean;
  // ISO timestamp, formatted in the workspace locale when shown.
  updatedAt: string;
  // Name of the template this one was copied from, so the copy's label
  // follows the interface language.
  copyOf?: string;
};

export const PRINT_TEMPLATE_CATALOG: PrintTemplateCatalogItem[] = [
  { id: "default-receive-sheet", name: "Standard receiving slip", documentType: "Purchase receipt / receiving slip", isDefault: true, updatedAt: "2026-07-10T09:30:00" },
  { id: "default-delivery-note", name: "Standard delivery note", documentType: "Sales shipment / delivery note", isDefault: true, updatedAt: "2026-07-10T09:30:00" },
  { id: "default-sign-receipt", name: "Standard delivery receipt", documentType: "Delivery receipt", isDefault: true, updatedAt: "2026-07-10T09:30:00" },
];
