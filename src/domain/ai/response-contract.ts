export type AiResponseV2Severity = "info" | "warning" | "risk" | "success";
export type AiResponseV2Confidence = "high" | "medium" | "low";
export type AiResponseV2ActionPriority = "high" | "medium" | "low";

export type AiResponseV2Scope = {
  module?: string;
  entityType?: string;
  entityId?: string;
  timeRange?: string;
  dataScopeLabel: string;
};

export type AiResponseV2Conclusion = {
  title: string;
  summary: string;
  severity: AiResponseV2Severity;
  confidence: AiResponseV2Confidence;
};

export type AiResponseV2LinkTarget = {
  moduleId: string;
  entityType?: string;
  entityId?: string;
};

export type AiResponseV2EvidenceItem = {
  id: string;
  label: string;
  entityLabel: string;
  entityType: string;
  entityId: string;
  moduleId: string;
  evidenceType: string;
  summary: string;
  value?: string | number | null;
  status?: string;
  severity?: AiResponseV2Severity;
  sourceLabel?: string;
  linkTarget?: AiResponseV2LinkTarget;
};

export type AiResponseV2BusinessImpactItem = {
  area: string;
  impact: string;
  severity: AiResponseV2Severity;
  explanation: string;
  affectedObjects?: string[];
};

export type AiResponseV2RecommendedAction = {
  label: string;
  description: string;
  actionType: string;
  priority: AiResponseV2ActionPriority;
  reviewRequired: boolean;
  targetModule?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  disabledReason?: string;
};

export type AiResponseV2NavigationLink = {
  label: string;
  moduleId: string;
  entityType?: string;
  entityId?: string;
  returnLabel?: string;
  returnTo?: string;
  source?: string;
  reason?: string;
  returnContext?: unknown;
  focusTarget?: {
    entityType: string;
    entityId: string;
    focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance";
  };
};

export type AiResponseV2DataLimitation = {
  label: string;
  description: string;
  severity: AiResponseV2Severity;
  missingData?: string[];
  consequence?: string;
};

export type AiResponseV2ReviewCard = {
  title: string;
  description: string;
  previewOnly: true;
  reviewRequired?: true;
  requiresHumanReview: true;
  prohibitedActions: string[];
  allowedNextStep: string;
  targetModule?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  draftType?: string;
  draftTitle?: string;
  payload?: Record<string, unknown>;
  originEvidence?: Record<string, unknown>[];
};

export type AiRuntimeContextBreadcrumb = {
  label: string;
  moduleId?: string;
  entityLabel?: string;
  returnTo: "ai-assistant";
};

export type AiRuntimeBusinessEntityRef = {
  entityType: string;
  entityId?: string;
  entityLabel: string;
  source?: string;
  confidence?: AiResponseV2Confidence;
};

export type AiRuntimeResolvedContext = {
  resolvedFrom: "currentMessage" | "activePage" | "previousResponse" | "session" | "notResolved";
  entityRefs: AiRuntimeBusinessEntityRef[];
  intentCarryOver?: string;
  confidence: AiResponseV2Confidence;
  limitationLabel?: string;
};

export type AiRuntimeFollowUpSuggestion = {
  label: string;
  prompt: string;
  intentHint?: string;
  requiresReview?: boolean;
};

export type AiResponseV2 = {
  version: "v2";
  query: string;
  intent: string;
  scope: AiResponseV2Scope;
  conclusion: AiResponseV2Conclusion;
  keyEvidence: AiResponseV2EvidenceItem[];
  contextCards?: AiResponseV2EvidenceItem[];
  realEvidenceCount?: number;
  contextCardCount?: number;
  limitationCount?: number;
  businessImpact: AiResponseV2BusinessImpactItem[];
  recommendedActions: AiResponseV2RecommendedAction[];
  navigationLinks: AiResponseV2NavigationLink[];
  dataLimitations: AiResponseV2DataLimitation[];
  reviewCards: AiResponseV2ReviewCard[];
  followUpQuestions?: string[];
  contextBreadcrumbs?: AiRuntimeContextBreadcrumb[];
  followUpSuggestions?: AiRuntimeFollowUpSuggestion[];
  resolvedContext?: AiRuntimeResolvedContext;
};
