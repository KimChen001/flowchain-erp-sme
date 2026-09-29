import { apiJson } from "../../lib/api-client";
export type ReviewActionNavigationLink = {
  label: string;
  moduleId: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  returnTo?: string;
  source?: string;
  reason?: string;
};

export type ReviewActionDraft = {
  id: string;
  draftNo: string;
  title: string;
  draftType: string;
  draftTypeLabel: string;
  sourceModule: string;
  sourceLabel: string;
  sourceCategory: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceEntityLabel: string;
  targetModule: string;
  targetEntityType: string;
  targetEntityId: string;
  targetEntityLabel: string;
  status: string;
  priority: string;
  owner: string;
  createdAtLabel: string;
  dueLabel: string;
  conclusion: string;
  keyEvidence: string[];
  businessImpact: string[];
  proposedDraftContent: string;
  reviewChecklist: string[];
  missingInformation: string[];
  navigationLinks: ReviewActionNavigationLink[];
  allowedTransitions: Array<{ from: string; to: string; reasonRequired: boolean }>;
  reviewActions: Array<{ label: string; transitionTo: string; reasonRequired: boolean; previewOnly: boolean; requiresHumanReview: boolean; boundary: string }>;
  boundaryLabels: string[];
  dataLimitations: Array<{ label: string; description: string; severity: string; affectedModules?: string[] }>;
  auditTrailPreview: string[];
};

export type ReviewFirstActionWorkflowV2 = {
  summary: {
    totalDraftCount: number;
    waitingReviewCount: number;
    changesRequestedCount: number;
    cancelledCount: number;
    manuallyHandledCount: number;
    highPriorityCount: number;
    dataLimitedCount: number;
    sourceCount: number;
    overallStatusLabel: string;
  };
  drafts: ReviewActionDraft[];
  sourceSummary: Array<{
    sourceCategory: string;
    sourceLabel: string;
    draftCount: number;
    highPriorityCount: number;
    dataLimitationCount: number;
    topDraft: string;
    navigationLinks: ReviewActionNavigationLink[];
  }>;
  lifecyclePolicy: {
    statuses: Array<{ status: string; description: string }>;
    allowedTransitions: Array<{ from: string; to: string; reasonRequired: boolean }>;
    reasonRequiredTransitions: string[];
    boundaryLabels: string[];
  };
  dataLimitations: Array<{ label: string; description: string; severity: string; affectedModules?: string[] }>;
  generatedAt: string;
  dataScopeLabel: string;
};

export async function fetchReviewFirstActionWorkflowV2(): Promise<ReviewFirstActionWorkflowV2> {
  return apiJson<ReviewFirstActionWorkflowV2>("/api/review-first-action-workflow");
}
