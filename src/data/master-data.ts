import type { ItemMaster, PaymentTerm, SupplierMaster, TaxCode, WarehouseBin } from "../types/scm";

// UI initialization only. Authoritative records are loaded from PostgreSQL APIs.
export const supplierData: Array<Record<string, never>> = [];
export const PORTAL_SUPPLIERS: Array<Record<string, never>> = [];
export const SKU_CATALOG: Array<Record<string, never>> = [];
export const SUPPLIER_LIST: string[] = [];
export const OWNERS: string[] = [];
export const TAX_CODES: TaxCode[] = [];
export const PAYMENT_TERMS: PaymentTerm[] = [];
export const ITEM_MASTER: ItemMaster[] = [];
export const SUPPLIER_MASTER: SupplierMaster[] = [];
export const WAREHOUSE_BINS: WarehouseBin[] = [];
