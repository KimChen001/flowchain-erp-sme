import { A } from "../../components/ui";
import { PORTAL_SUPPLIERS } from "../../data/empty-business-state";
import type { SupplierInvoiceMatchStatus } from "../../types/scm";

export type SupplierPerformance = typeof PORTAL_SUPPLIERS[number] & {
  category?: string;
  received?: number;
  passed?: number;
  failed?: number;
  exceptions?: number;
  rejectRate?: number;
  score?: number;
  risk?: string;
  lastIssue?: string;
};

export function matchStatusStyle(status: SupplierInvoiceMatchStatus) {
  if (status === "自动匹配" || status === "已解决") return { color: A.green, bg: "#f0faf4" };
  if (status === "差异待处理") return { color: A.red, bg: "#fff1f0" };
  if (status === "人工复核") return { color: A.orange, bg: "#fff8f0" };
  return { color: A.gray1, bg: A.gray6 };
}
