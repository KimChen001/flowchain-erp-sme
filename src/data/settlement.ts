import type {
  SupplierCreditMemo,
  SupplierInvoice,
  SupplierReconciliationStatement,
} from "../types/scm";

// UI initialization only. Finance facts are loaded from PostgreSQL APIs.
export const PAYABLES: Array<Record<string, never>> = [];
export const SUPPLIER_INVOICES: SupplierInvoice[] = [];
export const SUPPLIER_RECONCILIATION_STATEMENTS: SupplierReconciliationStatement[] = [];
export const SUPPLIER_CREDIT_MEMOS: SupplierCreditMemo[] = [];
