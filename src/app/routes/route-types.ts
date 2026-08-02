import type React from "react";

export type RouteClassification =
  | "CORE"
  | "EXTENSION"
  | "INTERNAL"
  | "FROZEN"
  | "LEGACY";

export type NavigationVisibility =
  | "PRIMARY"
  | "SECONDARY"
  | "CONTEXTUAL"
  | "HIDDEN";

export type DirectAccessBehavior =
  | "RENDER"
  | "CAPABILITY_REQUIRED"
  | "PERMISSION_REQUIRED"
  | "FROZEN_UNAVAILABLE"
  | "INTERNAL_ONLY"
  | "LEGACY_REDIRECT"
  | "LEGACY_UNAVAILABLE"
  | "NOT_IMPLEMENTED";

export type RouteMaturity =
  | "AUTHORITATIVE"
  | "CAPABILITY_GATED"
  | "PREVIEW"
  | "UNAVAILABLE"
  | "INTERNAL_PREVIEW"
  | "RETIRED";

export type AppPageType =
  | "module-overview"
  | "list"
  | "detail"
  | "create"
  | "edit"
  | "analysis"
  | "settings";

export type AppEntryBehavior = "redirect-to-default-child" | "landing";

export type RouteAuthorityMetadata = {
  classification: RouteClassification;
  navigationVisibility: NavigationVisibility;
  navigationOrder?: number;
  navigationLabel?: string;
  directAccessBehavior: DirectAccessBehavior;
  owner: string;
  businessObject?: string;
  apiDependency?: string;
  repositoryAuthority: string;
  readMaturity: RouteMaturity;
  writeMaturity: RouteMaturity;
  requiredCapability?: string;
  requiredPermission?: string;
  compatibilityOnly?: boolean;
  canonicalReplacement?: string;
  knownLimitations?: string;
};

export type AppRouteDefinition = {
  id: string;
  path: string;
  moduleId: string;
  moduleLabel: string;
  label: string;
  description?: string;
  parentId?: string;
  defaultChildId?: string;
  entryBehavior?: AppEntryBehavior;
  icon?: React.ElementType;
  showInSidebar?: boolean;
  showInModuleNav?: boolean;
  showInBreadcrumb?: boolean;
  pageType?: AppPageType;
  currentActiveMenuId?: string;
  entityType?: string;
  entityIdParam?: string;
  returnListRouteId?: string;
  legacyIds?: string[];
  panelId?: string;
  viewId?: string;
  capabilityId?: string;
  group?: "主导航" | "高级与内部";
  order: number;
} & Partial<RouteAuthorityMetadata>;

export type GovernedAppRouteDefinition = AppRouteDefinition &
  RouteAuthorityMetadata;
