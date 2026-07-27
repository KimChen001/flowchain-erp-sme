import { ApiError, apiJson } from "../../lib/api-client";
import type { ItemMaster, PaymentTerm, SupplierMaster, TaxCode, WarehouseBin } from "../../types/scm";
import type { CustomerMaster } from "./standardData";

type ApiMasterItem = {
  id?: string;
  itemId?: string;
  sku?: string;
  name?: string;
  itemName?: string;
  category?: string;
  baseUom?: string;
  baseUnit?: string;
  defaultWarehouseId?: string;
  preferredSupplierId?: string;
  leadTimeDays?: number;
  moq?: number;
  batchMultiple?: number;
  status?: string;
};

type ApiMasterSupplier = {
  id?: string;
  supplierCode?: string;
  supplierName?: string;
  name?: string;
  status?: string;
  risk?: string;
  score?: string | number;
  defaultCurrency?: string;
  paymentTermsId?: string;
  categories?: string[];
  preferred?: boolean;
};

type ApiMasterWarehouse = {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  parentId?: string | null;
};

type ApiPaymentTerm = {
  id?: string;
  label?: string;
  days?: number;
  status?: string;
};

type ApiTaxCode = {
  id?: string;
  label?: string;
  rate?: number;
  status?: string;
};

type MasterDataApiSnapshot = {
  items?: ApiMasterItem[];
  suppliers?: ApiMasterSupplier[];
  warehouses?: ApiMasterWarehouse[];
  paymentTerms?: ApiPaymentTerm[];
  taxCodes?: ApiTaxCode[];
  customers?: CustomerMaster[];
};

export type MasterDataSnapshot = {
  items: ItemMaster[];
  suppliers: SupplierMaster[];
  warehouses: WarehouseBin[];
  paymentTerms: PaymentTerm[];
  taxCodes: TaxCode[];
  customers: CustomerMaster[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function arrayField<T>(payload: unknown, key: string): T[] {
  if (!isRecord(payload) || !Array.isArray(payload[key])) throw new Error(`Invalid master data response: ${key}`);
  return payload[key] as T[];
}

function text(value: unknown, fallback = "") {
  const next = String(value ?? "").trim();
  return next || fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function backendStatus(value: unknown) {
  const raw = text(value).toLowerCase();
  if (["inactive", "disabled", "停用"].includes(raw)) return "停用";
  if (["draft", "review", "pending", "待完善", "待复核"].includes(raw)) return "待完善";
  return "启用";
}

function reviewStatus(value: unknown): "启用" | "待复核" | "停用" {
  const raw = text(value).toLowerCase();
  if (["inactive", "disabled", "停用"].includes(raw)) return "停用";
  if (["draft", "review", "pending", "待完善", "待复核"].includes(raw)) return "待复核";
  return "启用";
}

function riskStatus(value: unknown): SupplierMaster["riskStatus"] {
  const raw = text(value).toLowerCase();
  if (["high", "高"].includes(raw)) return "高";
  if (["low", "低"].includes(raw)) return "低";
  return "中";
}

function supplierByIdOrName(suppliers: SupplierMaster[], value: unknown) {
  const key = text(value).toLowerCase();
  if (!key) return null;
  return suppliers.find((supplier) =>
    [supplier.code, supplier.name].some((candidate) => candidate.toLowerCase() === key)
  ) || null;
}

function fallbackItem(fallback: ItemMaster[], apiItem: ApiMasterItem, index: number) {
  const key = text(apiItem.sku || apiItem.itemId || apiItem.id || apiItem.itemName || apiItem.name).toLowerCase();
  return fallback.find((item) =>
    [item.sku, item.name].some((candidate) => candidate.toLowerCase() === key)
  ) || fallback[index];
}

function fallbackSupplier(fallback: SupplierMaster[], apiSupplier: ApiMasterSupplier, index: number) {
  const key = text(apiSupplier.supplierCode || apiSupplier.id || apiSupplier.supplierName || apiSupplier.name).toLowerCase();
  return fallback.find((supplier) =>
    [supplier.code, supplier.name].some((candidate) => candidate.toLowerCase() === key)
  ) || fallback[index];
}

export function normalizeItemRows(
  apiItems: ApiMasterItem[] | undefined,
  fallbackItems: ItemMaster[],
  suppliers: SupplierMaster[],
): ItemMaster[] {
  if (!apiItems) return fallbackItems;
  return apiItems.map((apiItem, index) => {
    const fallback = fallbackItem(fallbackItems, apiItem, index);
    const supplier = supplierByIdOrName(suppliers, apiItem.preferredSupplierId);
    const status = backendStatus(apiItem.status);
    return {
      sku: text(apiItem.sku || apiItem.itemId || apiItem.id, fallback?.sku || `ITEM-${index + 1}`),
      name: text(apiItem.itemName || apiItem.name, fallback?.name || text(apiItem.sku || apiItem.itemId || apiItem.id, `物料 ${index + 1}`)),
      category: text(apiItem.category, fallback?.category || "未分类"),
      specification: fallback?.specification || "",
      unit: text(apiItem.baseUnit || apiItem.baseUom, fallback?.unit || "件"),
      defaultWarehouse: text(apiItem.defaultWarehouseId, fallback?.defaultWarehouse || ""),
      defaultBin: fallback?.defaultBin || "",
      safetyStock: numberValue(fallback?.safetyStock, 0),
      maxStock: numberValue(fallback?.maxStock, 0),
      reorderPoint: numberValue(apiItem.moq, fallback?.reorderPoint || 0),
      leadTimeDays: numberValue(apiItem.leadTimeDays, fallback?.leadTimeDays || 0),
      batchManaged: fallback?.batchManaged ?? false,
      serialManaged: fallback?.serialManaged ?? false,
      qaRequired: fallback?.qaRequired ?? false,
      defaultSupplier: supplier?.name || text(apiItem.preferredSupplierId, fallback?.defaultSupplier || ""),
      defaultTaxCode: fallback?.defaultTaxCode || "",
      status: statusValue(status, ["启用", "待完善", "停用"] as const, "启用"),
    };
  });
}

export function normalizeSupplierRows(
  apiSuppliers: ApiMasterSupplier[] | undefined,
  fallbackSuppliers: SupplierMaster[],
): SupplierMaster[] {
  if (!apiSuppliers) return fallbackSuppliers;
  return apiSuppliers.map((apiSupplier, index) => {
    const fallback = fallbackSupplier(fallbackSuppliers, apiSupplier, index);
    const category = text(apiSupplier.categories?.[0], fallback?.category || "未分类");
    return {
      code: text(apiSupplier.supplierCode || apiSupplier.id, fallback?.code || `SUP-${index + 1}`),
      name: text(apiSupplier.supplierName || apiSupplier.name, fallback?.name || `供应商 ${index + 1}`),
      category,
      contact: fallback?.contact || "",
      email: fallback?.email || "",
      phone: fallback?.phone || "",
      paymentTerms: text(apiSupplier.paymentTermsId, fallback?.paymentTerms || ""),
      currency: text(apiSupplier.defaultCurrency, fallback?.currency || "CNY"),
      taxId: fallback?.taxId || "",
      defaultTaxCode: fallback?.defaultTaxCode || "",
      rating: numberValue(apiSupplier.score, fallback?.rating || 0),
      onTimeRate: fallback?.onTimeRate || 0,
      qualityRate: fallback?.qualityRate || 0,
      riskStatus: riskStatus(apiSupplier.risk || fallback?.riskStatus),
      certificationStatus: fallback?.certificationStatus || (apiSupplier.preferred ? "已认证" : "待复核"),
      status: statusValue(backendStatus(apiSupplier.status || fallback?.status), ["启用", "待完善", "停用"] as const, "启用"),
    };
  });
}

export function normalizeWarehouseRows(
  apiWarehouses: ApiMasterWarehouse[] | undefined,
  fallbackWarehouses: WarehouseBin[],
): WarehouseBin[] {
  if (!apiWarehouses) return fallbackWarehouses;
  return apiWarehouses.map((apiWarehouse, index) => {
    const fallback = fallbackWarehouses.find((item) => item.warehouseCode === apiWarehouse.id || item.warehouseName === apiWarehouse.name) || fallbackWarehouses[index];
    const status = text(apiWarehouse.status).toLowerCase();
    const blocked = ["inactive", "disabled", "frozen", "停用", "冻结"].includes(status);
    return {
      warehouseCode: text(apiWarehouse.id, fallback?.warehouseCode || `WH-${index + 1}`),
      warehouseName: text(apiWarehouse.name, fallback?.warehouseName || text(apiWarehouse.id, `仓库 ${index + 1}`)),
      zone: fallback?.zone || text(apiWarehouse.type, "默认库区"),
      bin: fallback?.bin || text(apiWarehouse.id, `BIN-${index + 1}`),
      capacity: numberValue(fallback?.capacity, 0),
      utilization: numberValue(fallback?.utilization, 0),
      temperatureRequirement: fallback?.temperatureRequirement || "常温",
      qaStatus: blocked ? "冻结" : fallback?.qaStatus || "可用",
      available: blocked ? false : fallback?.available ?? true,
      owner: fallback?.owner || "",
    };
  });
}

export function normalizePaymentTermRows(
  apiPaymentTerms: ApiPaymentTerm[] | undefined,
  fallbackPaymentTerms: PaymentTerm[],
): PaymentTerm[] {
  if (!apiPaymentTerms) return fallbackPaymentTerms;
  return apiPaymentTerms.map((apiTerm, index) => {
    const fallback = fallbackPaymentTerms.find((item) => item.code === apiTerm.id || item.name === apiTerm.label) || fallbackPaymentTerms[index];
    return {
      code: text(apiTerm.id, fallback?.code || `TERM-${index + 1}`),
      name: text(apiTerm.label, fallback?.name || text(apiTerm.id, `付款条款 ${index + 1}`)),
      netDays: numberValue(apiTerm.days, fallback?.netDays || 0),
      discountRule: fallback?.discountRule || "无现金折扣",
      dueDateRule: fallback?.dueDateRule || `发票日期后 ${numberValue(apiTerm.days, fallback?.netDays || 0)} 天到期`,
      status: reviewStatus(apiTerm.status || fallback?.status),
      description: fallback?.description || "",
    };
  });
}

export function normalizeTaxCodeRows(
  apiTaxCodes: ApiTaxCode[] | undefined,
  fallbackTaxCodes: TaxCode[],
): TaxCode[] {
  if (!apiTaxCodes) return fallbackTaxCodes;
  return apiTaxCodes.map((apiCode, index) => {
    const fallback = fallbackTaxCodes.find((item) => item.code === apiCode.id || item.name === apiCode.label) || fallbackTaxCodes[index];
    return {
      code: text(apiCode.id, fallback?.code || `TAX-${index + 1}`),
      name: text(apiCode.label, fallback?.name || text(apiCode.id, `税码 ${index + 1}`)),
      rate: numberValue(apiCode.rate, fallback?.rate || 0),
      type: fallback?.type || (numberValue(apiCode.rate, 0) > 0 ? "进项税" : "免税"),
      region: fallback?.region || "中国大陆",
      isDefault: fallback?.isDefault ?? index === 0,
      status: reviewStatus(apiCode.status || fallback?.status),
      description: fallback?.description || "",
    };
  });
}

export type AsyncDataStatus = "loading" | "ready_with_data" | "ready_empty" | "unauthenticated" | "forbidden" | "not_found" | "server_error" | "network_error";

export function masterDataErrorStatus(error: unknown): Exclude<AsyncDataStatus, "loading" | "ready_with_data" | "ready_empty"> {
  if (error instanceof ApiError) {
    if (error.status === 401) return "unauthenticated";
    if (error.status === 403) return "forbidden";
    if (error.status === 404) return "not_found";
    return "server_error";
  }
  return "network_error";
}

export async function fetchMasterDataSnapshot(fallback: MasterDataSnapshot): Promise<MasterDataSnapshot> {
  const payload = await apiJson<unknown>("/api/master-data");
  const items = arrayField<ApiMasterItem>(payload, "items");
  const suppliers = arrayField<ApiMasterSupplier>(payload, "suppliers");
  const warehouses = arrayField<ApiMasterWarehouse>(payload, "warehouses");
  const paymentTerms = arrayField<ApiPaymentTerm>(payload, "paymentTerms");
  const taxCodes = arrayField<ApiTaxCode>(payload, "taxCodes");
  const customers = arrayField<CustomerMaster>(payload, "customers");
  const apiSnapshot: MasterDataApiSnapshot = { items, suppliers, customers, warehouses, paymentTerms, taxCodes };
  const normalizedSuppliers = normalizeSupplierRows(apiSnapshot.suppliers, fallback.suppliers);
  return {
    suppliers: normalizedSuppliers,
    items: normalizeItemRows(apiSnapshot.items, fallback.items, normalizedSuppliers),
    warehouses: normalizeWarehouseRows(apiSnapshot.warehouses, fallback.warehouses),
    paymentTerms: normalizePaymentTermRows(apiSnapshot.paymentTerms, fallback.paymentTerms),
    taxCodes: normalizeTaxCodeRows(apiSnapshot.taxCodes, fallback.taxCodes),
    customers: apiSnapshot.customers,
  };
}
