import { apiJson } from "../../lib/api-client";
export type DataAccessNavigationLink = {
  label: string;
  moduleId: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  returnTo?: string;
  source?: string;
  reason?: string;
};

export type DataQualityFixPreview = {
  title: string;
  description: string;
  previewOnly: true;
  requiresHumanReview: true;
  draftType: string;
  targetObject: string;
  allowedNextStep: string;
  prohibitedActions: string[];
  payload: Record<string, unknown>;
};

export type DataAccessQualityV2 = {
  summary: {
    sourceCount: number;
    connectedSourceCount: number;
    mappedFieldCount: number;
    unmappedFieldCount: number;
    criticalIssueCount: number;
    warningIssueCount: number;
    relationshipGapCount: number;
    evidenceGapCount: number;
    affectedAiInsightCount: number;
    affectedControlTowerItemCount: number;
    overallQualityLabel: string;
  };
  sources: Array<{
    id: string;
    label: string;
    businessArea: string;
    status: string;
    recordCount: number;
    lastUpdated: string;
    coverageLabel: string;
    missingObjects: string[];
    downstreamUsage: string[];
  }>;
  fieldMappings: Array<{
    sourceId: string;
    sourceLabel: string;
    fieldLabel: string;
    canonicalField: string;
    businessObject: string;
    status: string;
    confidence: number;
    issue: string;
    downstreamImpact: string;
    suggestedMapping: string;
    reviewRequired: boolean;
  }>;
  qualityIssues: Array<{
    id: string;
    title: string;
    severity: string;
    category: string;
    businessObjectType: string;
    businessObjectId: string;
    businessObjectLabel: string;
    fieldLabel: string;
    issueType: string;
    explanation: string;
    businessImpact: string;
    suggestedFix: string;
    affectedModule: string;
    affectedControlTowerCategories: string[];
    navigationLinks: DataAccessNavigationLink[];
    reviewActions: Array<{
      label: string;
      description: string;
      previewOnly: boolean;
      requiresHumanReview: boolean;
      allowedNextStep: string;
      prohibitedActions: string[];
    }>;
    blockedActions: string[];
    dataLimitations: Array<{ label: string; description: string }>;
  }>;
  relationshipGaps: Array<{
    id: string;
    title: string;
    severity: string;
    fromObject: string;
    toObject: string;
    missingRelationship: string;
    explanation: string;
    affectedModule: string;
    affectedAiQuestion: string;
    suggestedFix: string;
    navigationLinks: DataAccessNavigationLink[];
  }>;
  evidenceGaps: Array<{
    id: string;
    title: string;
    severity: string;
    evidenceType: string;
    affectedObject: string;
    missingEvidence: string;
    consequence: string;
    suggestedNextStep: string;
    navigationLinks: DataAccessNavigationLink[];
  }>;
  downstreamImpacts: Array<{
    id: string;
    target: string;
    targetType: string;
    affectedQuestion: string;
    affectedModule: string;
    impactSummary: string;
    dataLimitationLabel: string;
    relatedIssueIds: string[];
  }>;
  recommendedFixes: DataQualityFixPreview[];
  dataLimitations: Array<{
    label: string;
    description: string;
    severity: string;
    affectedModules: string[];
  }>;
  generatedAt: string;
  dataScopeLabel: string;
};

export async function fetchDataAccessQualityV2(): Promise<DataAccessQualityV2> {
  return apiJson<DataAccessQualityV2>("/api/data-access-quality");
}
