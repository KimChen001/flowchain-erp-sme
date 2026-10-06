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
  // Workspace skill and business query answers: the server's order and the raw
  // status code. `status` is then the label in the answer language.
  rank?: number | null;
  statusCode?: string;
  // What to do next about this record, in the answer language.
  nextStep?: string;
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
  // The answer line (evidence id) this draft belongs to, when it was offered on a line.
  lineEvidenceId?: string;
  // Which payload fields were suggested, and from where (record, default, template).
  prefill?: Record<string, { source: "record" | "default" | "template" | "history" | "workspace_history" | "model"; ref?: string; value: string }>;
  originEvidence?: Record<string, unknown>[];
  // Set on the cards of an order the assistant was asked to start
  // (prepare_action_draft, mode order): true opens the card's form as the
  // answer arrives. Their allowedNextStep names the SKU and is the button label.
  autoOpen?: boolean;
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
  skillHint?: string;
  requiresReview?: boolean;
};

export type AiBusinessQuerySectionCard = {
  goal: string;
  label: string;
  state: "confirmed" | "confirmed_zero" | "incomplete" | "hidden" | "unavailable";
  stateLabel: string;
  counts: Record<string, number | null>;
  amounts: Record<string, number | null>;
  rows: Array<Record<string, unknown>>;
  limitations: string[];
};

export type AiBusinessQueryPresentation = {
  planningVersion: "business-query-plan-v1";
  plannerStatus: string;
  scopeBadge: string;
  scopeMode: "single" | "set" | "all" | "current_context" | "previous_result";
  goalLabels: string[];
  sectionCards: AiBusinessQuerySectionCard[];
  clarification?: { needed: boolean; question?: string | null };
  fieldVisibility?: { amounts?: boolean; partner?: boolean };
  validitySummary?: { validCount?: number; incompleteCount?: number; invalidCount?: number; hiddenCount?: number; unavailable?: boolean } | null;
};

// One part of a question with several parts (a compound answer): the skill
// that answered it, its own title and summary, and the evidence it cited.
export type AiResponseV2Section = {
  id: string;
  skillId: string;
  mode?: string | null;
  question: string;
  title: string;
  summary: string;
  severity: AiResponseV2Severity;
  evidenceIds: string[];
  figureKeys?: string[];
};

export type AiResponseV2 = {
  supplementalKnowledge?: { title: string; summary: string; rag: { mode: string; citations: Array<{ id: string; documentId: string; title: string; heading?: string | null; position: number; excerpt: string; sourceNumber?: number }> } };
  rag?: { mode: string; citations: Array<{ id: string; documentId: string; title: string; heading?: string | null; position: number; excerpt: string; sourceNumber?: number }> };
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
  businessQuery?: AiBusinessQueryPresentation;
  // Workspace skill answers say where the answer came from and what was read.
  language?: "en-US" | "zh-CN";
  answerSource?: "workspace_rules" | string;
  answerSourceLabel?: string;
  checked?: string[];
  checkedLabel?: string;
  skill?: { id: string; version: string; asOf?: string | null; timezone?: string | null; signalVersion?: string };
  // Set when the workspace reached this month's AI limit: the answer comes from workspace rules.
  aiModelAccess?: { status: "over_cap" };
  // A compound answer has a section per part; a one-part answer has none.
  sections?: AiResponseV2Section[];
  metrics?: {
    asOf?: string;
    openPurchaseOrders: number | null;
    overduePurchaseOrders: number | null;
    committedSpend: Array<{ currency: string | null; amount: number | null }> | null;
    committedInvoices: Array<{ currency: string | null; amount: number | null }> | null;
    atRiskSkus: string[] | null;
    atRiskSkuCount?: number | null;
  };
};
