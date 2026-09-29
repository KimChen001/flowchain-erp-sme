import { apiJson } from "../../lib/api-client";
export type ReportNavigationLink = {
  label: string;
  moduleId: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  returnTo?: string;
  source?: string;
  reason?: string;
};

export type ReportsAnalyticsV2 = {
  summary: {
    totalPrCount: number;
    totalRfqCount: number;
    totalPoCount: number;
    totalGrnCount: number;
    totalInvoiceCount: number;
    matchVarianceCount: number;
    supplierRiskCount: number;
    inventoryRiskCount: number;
    controlTowerOpenItemCount: number;
    dataQualityIssueCount: number;
    overallHealthLabel: string;
  };
  p2pPipeline: Array<{
    stage: string;
    label: string;
    count: number;
    riskCount: number;
    blockedCount: number;
    amount: number;
    averageAgeLabel: string;
    topIssue: string;
    navigationLinks: ReportNavigationLink[];
    dataLimitations: string[];
  }>;
  supplierAnalytics: Array<Record<string, unknown> & { supplierName: string; navigationLinks: ReportNavigationLink[] }>;
  inventoryAnalytics: Array<Record<string, unknown> & { sku: string; navigationLinks: ReportNavigationLink[] }>;
  financeAnalytics: Array<Record<string, unknown> & { invoiceId: string; navigationLinks: ReportNavigationLink[] }>;
  controlTowerAnalytics: Array<Record<string, unknown> & { category: string; categoryLabel: string; navigationLinks: ReportNavigationLink[] }>;
  dataQualityImpact: Array<Record<string, unknown> & { issueCategory: string; navigationLinks: ReportNavigationLink[] }>;
  reportInsights: Array<{
    title: string;
    insightType: string;
    severity: string;
    conclusion: string;
    keyEvidence: string[];
    businessImpact: string;
    suggestedAction: string;
    reviewOnlyAction: { label: string; previewOnly: boolean; requiresHumanReview: boolean; boundary: string };
    navigationLinks: ReportNavigationLink[];
    dataLimitations: Array<{ label: string; description: string }>;
  }>;
  navigationLinks: ReportNavigationLink[];
  dataLimitations: Array<{ label: string; description: string; severity: string; affectedMetrics: string[] }>;
  generatedAt: string;
  dataScopeLabel: string;
};

export async function fetchReportsAnalyticsV2(): Promise<ReportsAnalyticsV2> {
  return apiJson<ReportsAnalyticsV2>("/api/reports-analytics");
}
