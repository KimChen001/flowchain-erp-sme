// Supplier list metrics, as GET /api/master-data/supplier-insights serves
// them (server/domain/supplier-insights.mjs). A metric the reader may not see
// is null. FlowChain never suggests a tier: a person sets it.
export type SupplierInsight = {
  spend12m: Array<{ currency: string; amount: number }> | null;
  spendComplete: boolean | null;
  orders12m: number | null;
  openPos: number | null;
  overduePos: number | null;
  onTime: { rate: number | null; count: number; of: number; sampleStatus: string } | null;
  openIssues: number | null;
};
export type SupplierInsights = {
  asOf: string;
  visibility: { orders: boolean; amounts: boolean; onTime: boolean; issues: boolean };
  suppliers: Record<string, SupplierInsight>;
};
