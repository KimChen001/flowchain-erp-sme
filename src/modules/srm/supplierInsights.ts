// Supplier list metrics, as GET /api/master-data/supplier-insights serves
// them (server/domain/supplier-insights.mjs). A metric the reader may not see
// is null. FlowChain never suggests a tier: a person sets it.
// A scorecard rate over 90 days: null below the minimum sample, with the
// counts behind it; withheld counts the deliveries left out because they were
// received in a warehouse the reader cannot see.
export type SupplierRate = { rate: number | null; count: number; of: number; sampleStatus: string; withheld?: number };
export type SupplierInsight = {
  spend12m: Array<{ currency: string; amount: number }> | null;
  spendComplete: boolean | null;
  orders12m: number | null;
  openPos: number | null;
  overduePos: number | null;
  onTime: SupplierRate | null;
  otif?: SupplierRate | null;
  openIssues: number | null;
};
export type SupplierInsights = {
  asOf: string;
  visibility: { orders: boolean; amounts: boolean; onTime: boolean; issues: boolean };
  suppliers: Record<string, SupplierInsight>;
};
