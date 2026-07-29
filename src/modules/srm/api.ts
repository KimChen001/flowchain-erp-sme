import { apiJson } from "../../lib/api-client";
import type { SupplierMaster } from "../../types/scm";

export type SrmSupplierProfile = SupplierMaster & {
  legacyCode?: string;
  legacyName?: string;
  matchNames?: string[];
};

type ApiMasterSupplier = {
  id?: string;
  name?: string;
  status?: string;
  risk?: string;
  score?: string | number;
  defaultCurrency?: string;
  paymentTermsId?: string;
  categories?: string[];
  preferred?: boolean;
};

function text(value: unknown, fallback = "") {
  const next = String(value ?? "").trim();
  return next || fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function supplierStatus(value: unknown): SupplierMaster["status"] {
  const raw = text(value).toLowerCase();
  if (["inactive", "disabled", "停用"].includes(raw)) return "停用";
  if (["draft", "review", "pending", "待完善", "待复核"].includes(raw)) return "待完善";
  return "启用";
}

function riskStatus(value: unknown): SupplierMaster["riskStatus"] {
  const raw = text(value).toLowerCase();
  if (["high", "高"].includes(raw)) return "高";
  if (["low", "低"].includes(raw)) return "低";
  return "中";
}

function fallbackSupplier(fallbackSuppliers: SupplierMaster[], apiSupplier: ApiMasterSupplier, index: number) {
  const key = text(apiSupplier.id || apiSupplier.name).toLowerCase();
  return fallbackSuppliers.find((supplier) =>
    [supplier.code, supplier.name].some((candidate) => text(candidate).toLowerCase() === key)
  ) || fallbackSuppliers[index];
}

function supplierNameFallback(apiSupplier: ApiMasterSupplier, fallback?: SupplierMaster, index = 0) {
  return text(apiSupplier.name, fallback?.name || text(apiSupplier.id, `供应商 ${index + 1}`));
}

function uniqueText(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const next = text(value);
    const key = next.toLowerCase();
    if (!next || seen.has(key)) return;
    seen.add(key);
    result.push(next);
  });
  return result;
}

function isSupplierArrayPayload(payload: unknown): payload is { suppliers: ApiMasterSupplier[] } {
  return Boolean(payload) && typeof payload === "object" && Array.isArray((payload as { suppliers?: unknown }).suppliers);
}

export function normalizeSrmSupplierProfiles(
  apiSuppliers: ApiMasterSupplier[] | undefined,
  fallbackSuppliers: SupplierMaster[],
): SrmSupplierProfile[] {
  if (!apiSuppliers) return fallbackSuppliers;
  return apiSuppliers.map((apiSupplier, index) => {
    const fallback = fallbackSupplier(fallbackSuppliers, apiSupplier, index);
    const preferred = apiSupplier.preferred === true;
    const code = text(apiSupplier.id, fallback?.code || `SUP-${index + 1}`);
    const name = supplierNameFallback(apiSupplier, fallback, index);
    return {
      code,
      name,
      category: text(apiSupplier.categories?.[0], fallback?.category || "未分类"),
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
      certificationStatus: fallback?.certificationStatus || (preferred ? "已认证" : "待复核"),
      status: supplierStatus(apiSupplier.status || fallback?.status),
      legacyCode: fallback?.code && fallback.code !== code ? fallback.code : undefined,
      legacyName: fallback?.name && fallback.name !== name ? fallback.name : undefined,
      matchNames: uniqueText([code, name, fallback?.code, fallback?.name]),
    };
  });
}

export async function fetchSrmSupplierProfiles(fallbackSuppliers: SupplierMaster[]): Promise<SrmSupplierProfile[]> {
  try {
    const payload = await apiJson<unknown>("/api/master-data/suppliers");
    if (!isSupplierArrayPayload(payload)) return fallbackSuppliers;
    if (payload.suppliers.length === 0) {
      // SRM needs supplier rows to preserve scoring and collaboration views until backend parity is broader.
      return fallbackSuppliers;
    }
    return normalizeSrmSupplierProfiles(payload.suppliers, fallbackSuppliers);
  } catch (error) {
    if ((import.meta as any).env?.DEV) {
      console.warn("[srm] falling back to local supplier profiles", error);
    }
    return fallbackSuppliers;
  }
}
