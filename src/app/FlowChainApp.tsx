import { workspaceCopy } from "../i18n/workspaceCopy";
import { FadeIn, PageSkeleton, PageTransition } from "../components/motion/Motion";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { Toaster, toast } from "sonner";
import {
  AlertTriangle,
  Bell,
  LogOut,
  Search,
  Settings,
  User,
  Activity,
  Sparkles,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Lock,
  X,
  ChevronRight,
} from "lucide-react";
import { navGroups, navItems } from "./routes.tsx";
import {
  currentRouteFor,
  defaultRouteForModule,
  entityIdForRoutePath,
  primarySurfaceRoute,
  redirectTargetForPath,
  routeById,
  routeByPath,
  routePathForId,
} from "./routeRegistry";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../lib/constants";
import {
  ApiError,
  apiJson,
  AUTH_TOKEN_KEY,
  CURRENT_USER_KEY,
  migrateLegacySessionStorage,
} from "../lib/api-client";
import { roleLabel } from "../../shared/roles.mjs";
import {
  navigationIntentFromGlobalSearchResult,
  navigationIntentFromModule,
  type CanonicalFocusTarget,
  type CanonicalNavigationIntent,
} from "../lib/evidenceLinks";
import {
  A,
  Card,
  Field,
  inputStyle,
  Modal,
} from "../components/ui";
import {
  ModuleShell,
  NotFoundRecovery,
} from "../components/navigation/ModuleShell";
import type { WorkflowContext } from "../lib/workflowContext";
import { buildReturnContext } from "../lib/workflowContext";
import { typography } from "../components/ui/typography";
import type { WorkspaceUser, PurchaseIntent } from "../types/scm";
import {
  readExperimentalModuleIds,
  resolveCapabilityRouteAccess,
  type CapabilityLoadState,
  type ModuleCapability,
} from "./capabilityRouteGuard";
import { RouteAvailabilityProvider } from "./routeAvailability";
import {
  capabilityIdForRoute,
  hasRoutePermission,
  isRouteVisibleInNavigation,
  type GovernedRouteAccessContext,
  type RouteRegistryLoadState,
} from "./routes/index.ts";

import ReceivingPanel from "../modules/receiving/Page";
import ReceivingPostingWorkbench from "../modules/receiving/ReceivingPostingWorkbench";
import InventoryPanel from "../modules/inventory/Page";
import ForecastPanel from "../modules/forecast/Page";
import OverviewPanel from "../modules/overview/Page";
import ProcurementPanel from "../modules/procurement/Page";
import { CanonicalRfqDetailPage } from "../modules/procurement/CanonicalRfqDetailPage";
import { CanonicalRfqComparisonPage } from "../modules/procurement/CanonicalRfqComparisonPage";
import { PurchaseOrderDocumentPage } from "../modules/business-documents/PurchaseOrderDocumentPage";
import { CustomerInvoiceDocumentPage } from "../modules/business-documents/CustomerInvoiceDocumentPage";
import FinanceWorkbench from "../modules/finance/Page";
import SrmPage from "../modules/srm/Page";
import MasterDataPage from "../modules/master-data/Page";
import DataImportPage from "../modules/master-data/DataImportPage";
import AiPanel, { type ActiveContext } from "../modules/ai-assistant/Panel";
import {
  ActionDraftReviewShell,
  type ActionDraftPreview,
  type ActionDraftPreviewRequest,
} from "../modules/action-drafts/ActionDraftReviewShell";
import { isStructuredDraftType, structuredDraftTarget } from "../modules/action-drafts/structuredDraftHandoff";
import ExceptionCasesPage from "../modules/exception-cases/Page";
import SalesDemandPage from "../modules/sales/Page";
import CollaborationDraftsPage from "../modules/collaboration-drafts/Page";
import SettingsPage from "../modules/settings/Page";
import AuditHistoryPage from "../modules/audit-history/Page";
import PilotReadinessPage from "../modules/pilot-readiness/Page";
import { ReviewFirstActionWorkflowV2 } from "../components/actions/ReviewFirstActionWorkflowV2";
import { BusinessEntityDetailPage } from "../components/business/BusinessEntityDetailPage";
import {
  businessEntityPath,
  businessEntityRouteRegistry,
  type BusinessEntityType,
} from "../components/business/businessEntityRoutes";
import OutboundWorkbench from "../modules/sales/OutboundWorkbench";
import InventoryOperationsWorkbench from "../modules/inventory/InventoryOperationsWorkbench";
import ReorderListPage from "../modules/inventory/ReorderListPage";
import MobileOperationsPage from "../modules/mobile/MobileOperationsPage";
import ReturnQuarantineWorkbench from "../modules/inventory/ReturnQuarantineWorkbench";
import { useI18n } from "../i18n/I18n";
import {
  LoginScreen,
  SIGN_IN_CONFIRM_PATH,
  ACCEPT_INVITATION_PATH,
  AcceptInvitationScreen,
  SignInConfirmScreen,
  type LocalDevelopmentStatus,
} from "./SignInScreens";

const ReportsPanel = React.lazy(() => import("../modules/reports/Page"));
const ImportsPanel = React.lazy(() => import("../modules/imports/Page"));
const UniversalIntakePanel = React.lazy(() => import("../modules/intake/Page"));

const DRAFT_MESSAGES = {
  unavailable: { en: "A draft preview is not available yet. Add more context and try again.", zh: "草稿预览暂不可用，请补充上下文后重试。" },
  unsupported: { en: "This action needs human review and has no draft preview yet.", zh: "当前动作需要人工复核，尚未接入草稿预览。" },
  previewBoundary: { en: "Draft preview problem: the service did not confirm the draft is preview-only.", zh: "草稿预览边界异常：接口未返回 previewOnly。" },
  saved: { en: "Draft saved", zh: "草稿已保存" },
  savedDetail: { en: "Only a draft for review was kept. No business document was created.", zh: "仅保存待复核草稿，不会创建业务单据。" },
  createsDocument: { en: "Draft problem: the service said saving would create a business document, so nothing was kept.", zh: "留存边界异常：接口声明会创建业务单据。" },
};
const draftMessage = (key: keyof typeof DRAFT_MESSAGES, language: string) => DRAFT_MESSAGES[key][language === "en-US" ? "en" : "zh"];

function actionDraftErrorMessage(error: unknown, language: string) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return draftMessage("unavailable", language);
  if (/^\s*[{[]/.test(message) || /<html|stack|trace| at /i.test(message)) {
    return draftMessage("unsupported", language);
  }
  return message;
}

type GlobalSearchResult = {
  id: string;
  type: string;
  label: string;
  subtitle: string;
  status: string;
  moduleId: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  evidence: Array<{ label: string; value: string }>;
  score: number;
  matchedFields: string[];
};

type GlobalSearchFocus = {
  entityType: string;
  entityId: string;
  focusArea?: CanonicalFocusTarget["focusArea"];
  entityLabel?: string;
  source?: string;
  at: number;
};

// Labels in both interface languages, picked with labelIn().
type LabelPair = { en: string; zh: string };
const labelIn = (label: LabelPair | undefined, language: string) =>
  label ? label[language === "en-US" ? "en" : "zh"] : undefined;

const SEARCH_TYPE_LABELS: Record<string, LabelPair> = {
  sales_order: { en: "Sales order", zh: "销售订单" },
  purchase_request: { en: "PR", zh: "PR" },
  rfq: { en: "RFQ", zh: "RFQ" },
  purchase_order: { en: "PO", zh: "PO" },
  receiving_doc: { en: "GRN", zh: "GRN" },
  supplier_invoice: { en: "Bill", zh: "发票" },
  supplier: { en: "Supplier", zh: "供应商" },
  item: { en: "Item", zh: "物料" },
  inventory_item: { en: "Stock", zh: "库存" },
  warehouse: { en: "Warehouse", zh: "仓库" },
  bin: { en: "Location", zh: "库位" },
};

const SEARCH_GROUP_LABELS: Record<string, LabelPair> = {
  sales_order: { en: "Sales orders", zh: "销售订单" },
  purchase_request: { en: "Purchase requests", zh: "采购申请" },
  rfq: { en: "RFQs / sourcing", zh: "RFQ / 寻源" },
  purchase_order: { en: "Purchase orders", zh: "采购订单" },
  receiving_doc: { en: "Receipts", zh: "采购收货单" },
  supplier_invoice: { en: "Bills", zh: "供应商发票" },
  supplier: { en: "Suppliers", zh: "供应商资料" },
  item: { en: "Items", zh: "物料" },
  inventory_item: { en: "Inventory", zh: "库存" },
  warehouse: { en: "Warehouses / locations", zh: "仓库 / 库位" },
};

const SEARCH_GROUP_ORDER = [
  "sales_order",
  "purchase_order",
  "purchase_request",
  "rfq",
  "supplier_invoice",
  "receiving_doc",
  "supplier",
  "item",
  "inventory_item",
  "warehouse",
];
const SEARCH_GROUP_VISIBLE_LIMIT = 5;

const FOCUS_ENTITY_LABELS: Record<string, LabelPair> = {
  customer_order: { en: "Sales order", zh: "销售订单" },
  sales_order: { en: "Sales order", zh: "销售订单" },
  inventory_availability: { en: "Stock availability", zh: "库存可用量" },
  inventory_item: { en: "SKU", zh: "SKU" },
  item: { en: "SKU", zh: "SKU" },
  sku: { en: "SKU", zh: "SKU" },
  purchase_request: { en: "Purchase request", zh: "采购申请" },
  rfq: { en: "RFx", zh: "RFx" },
  purchase_order: { en: "Purchase order", zh: "采购订单" },
  receiving_doc: { en: "Receipt", zh: "收货单" },
  supplier: { en: "Supplier", zh: "供应商" },
  supplier_invoice: { en: "Bill", zh: "供应商发票" },
  exception_case: { en: "Exception case", zh: "异常工单" },
  // Any other record.
  record: { en: "Business record", zh: "业务对象" },
};
const focusEntityLabel = (entityType: string, language: string) =>
  labelIn(FOCUS_ENTITY_LABELS[entityType] || FOCUS_ENTITY_LABELS.record, language);

function searchGroupKey(type: string) {
  return type === "bin" ? "warehouse" : type;
}

type PanelErrorBoundaryProps = {
  children: React.ReactNode;
  moduleLabel: string;
  language?: "en-US" | "zh-CN";
};

type PanelErrorBoundaryState = {
  hasError: boolean;
  errorMessage: string;
};

class PanelErrorBoundary extends React.Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  state: PanelErrorBoundaryState = { hasError: false, errorMessage: "" };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMessage: error.message || "" };
  }

  componentDidCatch(error: Error) {
    console.error("FlowChain module crashed", error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const english = this.props.language === "en-US";

    return (
      <Card className="p-8">
        <div className="max-w-xl">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
            style={{ background: "#fff1f0", color: A.red }}
          >
            <AlertTriangle size={18} />
          </div>
          <h2
            className="text-base font-semibold mb-2"
            style={{ color: A.label }}
          >
            {english ? `${this.props.moduleLabel} could not be displayed` : `${this.props.moduleLabel}模块加载失败`}
          </h2>
          <p className="text-sm leading-6 mb-5" style={{ color: A.gray1 }}>
            {english
              ? "Your data is kept and you are still signed in; only this part of the page failed to display. Details: "
              : "页面数据已经保留，当前只是这个模块渲染时遇到异常，不会退出登录。错误信息："}
            {this.state.errorMessage || (english ? "Unknown error" : "未知错误")}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, errorMessage: "" })}
            className="h-9 px-4 rounded-lg text-sm font-semibold text-white"
            style={{ background: A.blue }}
          >
            {english ? "Reload" : "重新加载模块"}
          </button>
        </div>
      </Card>
    );
  }
}

function CapabilityRouteStatus({
  moduleLabel,
  maturity,
  reason,
  loading = false,
  onNavigate,
}: {
  moduleLabel: string;
  maturity: ModuleCapability["maturity"];
  reason: string;
  loading?: boolean;
  onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  if (loading) {
    return (
      <Card
        className="p-10 text-center"
        data-testid="capability-route-loading"
        aria-live="polite"
      >
        <Loader2
          size={20}
          className="mx-auto animate-spin"
          style={{ color: A.blue }}
        />
        <h1 className="mt-3 text-base font-semibold" style={{ color: A.label }}>
          {t("capability.loading")}
        </h1>
        <p className="mt-2 text-xs" style={{ color: A.sub }}>
          {t("capability.loadingBody", { module: moduleLabel })}
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-10 text-center" data-testid="capability-route-blocked">
      <AlertTriangle
        size={22}
        className="mx-auto"
        style={{ color: A.orange }}
      />
      <h1 className="mt-3 text-base font-semibold" style={{ color: A.label }}>
        {t("capability.blocked", { module: moduleLabel })}
      </h1>
      <p className="mt-2 text-xs" style={{ color: A.sub }}>
        {t("capability.maturity", { maturity })}
      </p>
      <p
        className="mx-auto mt-3 max-w-2xl text-sm leading-6"
        style={{ color: A.gray1 }}
      >
        {reason || t("capability.reason")}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => onNavigate("/app/overview")}
          className="h-9 rounded-lg px-4 text-sm font-semibold text-white"
          style={{ background: A.blue }}
        >
          {t("capability.back")}
        </button>
        <button
          type="button"
          onClick={() => onNavigate("/app/procurement")}
          className="h-9 rounded-lg px-4 text-sm font-semibold"
          style={{ background: A.gray6, color: A.label }}
        >
          {t("capability.available")}
        </button>
      </div>
    </Card>
  );
}

export default function FlowChainApp() {
  const { t, routeLabel, workspaceName, language } = useI18n();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const [localStatus, setLocalStatus] = useState<LocalDevelopmentStatus | null>(null);
  const [purchaseIntent, setPurchaseIntent] = useState<PurchaseIntent | null>(
    null,
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    apiJson<{ commitSha: string; branch: string; runtimeMode: string }>(
      "/api/health",
    )
      .then((identity) => {
        document.documentElement.dataset.flowchainCommit = identity.commitSha;
        document.documentElement.dataset.flowchainBranch = identity.branch;
        console.info("FlowChain build identity", identity);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    apiJson<LocalDevelopmentStatus>("/api/dev/local-status").then(setLocalStatus).catch(() => setLocalStatus(null));
  }, []);
  const [draftShellOpen, setDraftShellOpen] = useState(false);
  const [draftPreview, setDraftPreview] = useState<ActionDraftPreview | null>(
    null,
  );
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [aiOpenSignal, setAiOpenSignal] = useState(0);
  const [aiActiveContext, setAiActiveContext] = useState<ActiveContext | null>(
    null,
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [expandedNavGroups, setExpandedNavGroups] = useState<
    Record<string, boolean>
  >({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  // The reader's role hides some record types from search.
  const [searchRestricted, setSearchRestricted] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchFocus, setSearchFocus] = useState<GlobalSearchFocus | null>(
    null,
  );
  const [, setFocusReturnActive] = useState("overview");
  const [, setFocusReturnContext] =
    useState<WorkflowContext | null>(null);
  const searchRef = useRef<HTMLFormElement | null>(null);
  migrateLegacySessionStorage();
  const [authToken, setAuthToken] = useState(
    () => localStorage.getItem(AUTH_TOKEN_KEY) || "",
  );
  const [capabilities, setCapabilities] = useState<
    Record<string, ModuleCapability>
  >({});
  const [capabilityLoadState, setCapabilityLoadState] =
    useState<CapabilityLoadState>("loading");
  const [authorizationLoadState, setAuthorizationLoadState] =
    useState<RouteRegistryLoadState>("loading");
  const [effectivePermissionCodes, setEffectivePermissionCodes] = useState<
    Set<string>
  >(new Set());
  const [authorizationVisibility, setAuthorizationVisibility] = useState<
    Record<
      string,
      {
        visible: boolean;
        permissionAllowed: boolean;
        capabilityAllowed: boolean;
      }
    >
  >({});
  const [experimentalModuleIds, setExperimentalModuleIds] = useState<
    Set<string>
  >(() => readExperimentalModuleIds());
  const [enabledModuleIds, setEnabledModuleIds] = useState<Set<string> | null>(
    () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem("flowchain:module-settings") || "null",
        );
        return saved?.items
          ? new Set(
              saved.items
                .filter((item: { enabled: boolean }) => item.enabled)
                .map((item: { id: string }) => item.id),
            )
          : null;
      } catch {
        return null;
      }
    },
  );
  const [user, setUser] = useState<WorkspaceUser | null>(() => {
    try {
      const raw = localStorage.getItem(CURRENT_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const refreshModuleSettings = () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem("flowchain:module-settings") || "null",
        );
        setEnabledModuleIds(
          saved?.items
            ? new Set(
                saved.items
                  .filter((item: { enabled: boolean }) => item.enabled)
                  .map((item: { id: string }) => item.id),
              )
            : null,
        );
      } catch {
        setEnabledModuleIds(null);
      }
    };
    window.addEventListener("flowchain:module-settings", refreshModuleSettings);
    const refreshExperiments = () =>
      setExperimentalModuleIds(readExperimentalModuleIds());
    window.addEventListener(
      "flowchain:experimental-modules",
      refreshExperiments,
    );
    return () => {
      window.removeEventListener(
        "flowchain:module-settings",
        refreshModuleSettings,
      );
      window.removeEventListener(
        "flowchain:experimental-modules",
        refreshExperiments,
      );
    };
  }, []);

  useEffect(() => {
    if (location.pathname === "/" || location.pathname === "/app") {
      routerNavigate("/app/overview", { replace: true });
    } else {
      const route = routeByPath(location.pathname);
      if (
        route?.directAccessBehavior === "LEGACY_REDIRECT" &&
        route.canonicalReplacement
      ) {
        const destination = redirectTargetForPath(
          location.pathname,
          location.search,
          location.hash,
        );
        if (destination) routerNavigate(destination, { replace: true });
      } else if (
        route &&
        !route.parentId &&
        route.entryBehavior === "redirect-to-default-child"
      ) {
        const destination = defaultRouteForModule(route.moduleId);
        if (destination && destination.path !== route.path)
          routerNavigate(destination.path, { replace: true });
      }
    }
  }, [location.hash, location.pathname, location.search, routerNavigate]);

  const activeRoute = routeByPath(location.pathname);
  const active = activeRoute?.id || "not-found";
  const activeModule = activeRoute?.moduleId || "overview";
  const activeView = activeRoute?.viewId;
  const panelModule = activeRoute?.panelId || activeModule;

  useEffect(() => {
    setCapabilityLoadState("loading");
    if (!authToken) return;
    apiJson<{ capabilities: ModuleCapability[] }>("/api/capabilities")
      .then(({ capabilities: rows }) => {
        const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
        setCapabilities(byId);
        setCapabilityLoadState("ready");
        setEnabledModuleIds(
          new Set(
            rows
              .filter(
                (row) =>
                  row.enabled ||
                  (row.maturity === "preview" &&
                    experimentalModuleIds.has(row.id)),
              )
              .map((row) => row.id),
          ),
        );
      })
      .catch(() => {
        setCapabilities({});
        setCapabilityLoadState("failed");
        setEnabledModuleIds(
          new Set([
            "overview",
            "master-data",
            "procurement",
            "sales",
            "inventory",
            "reports",
          ]),
        );
      });
  }, [authToken, experimentalModuleIds]);

  useEffect(() => {
    if (!authToken) {
      setAuthorizationLoadState("loading");
      setEffectivePermissionCodes(new Set());
      setAuthorizationVisibility({});
      return;
    }
    setAuthorizationLoadState("loading");
    setEffectivePermissionCodes(new Set());
    apiJson<{
      effectivePermissions: string[];
      moduleVisibility: Record<
        string,
        {
          visible: boolean;
          permissionAllowed: boolean;
          capabilityAllowed: boolean;
        }
      >;
    }>("/api/authorization/context")
      .then((result) => {
        setAuthorizationVisibility(result.moduleVisibility);
        setEffectivePermissionCodes(new Set(result.effectivePermissions));
        setAuthorizationLoadState("ready");
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) {
          localStorage.removeItem(AUTH_TOKEN_KEY);
          localStorage.removeItem(CURRENT_USER_KEY);
          setAuthToken("");
          setUser(null);
          return;
        }
        setAuthorizationVisibility({});
        setEffectivePermissionCodes(new Set());
        setAuthorizationLoadState("failed");
      });
  }, [authToken]);

  useEffect(() => {
    if (!activeRoute?.entityType || !activeRoute.entityIdParam) {
      setSearchFocus((current) =>
        current?.source === "detailUrl" ? null : current,
      );
      return;
    }
    const entityId = entityIdForRoutePath(activeRoute, location.pathname);
    if (!entityId) return;
    const focusArea = new URLSearchParams(location.search).get("focus") as CanonicalFocusTarget["focusArea"] | null;
    setSearchFocus((current) =>
      current?.entityType === activeRoute.entityType &&
      current.entityId === entityId &&
      current.focusArea === (focusArea || undefined)
        ? current
        : {
            entityType: activeRoute.entityType!,
            entityId,
            focusArea: focusArea || undefined,
            entityLabel: entityId,
            source: "detailUrl",
            at: Date.now(),
          },
    );
  }, [activeRoute?.id, location.pathname, location.search]);

  const localizedNavItems = useMemo(() => navItems.map(item => {
    const root = routeById(item.routeId);
    return {
      ...item,
      label:
        (item.navigationLabel ? workspaceCopy(item.navigationLabel, language) : "") ||
        (root ? routeLabel(root, !root.parentId) : item.label),
      children: item.children?.map(child => {
        const route = routeById(child.id);
        return { ...child, label: route ? routeLabel(route) : child.label };
      }),
    };
  }), [routeLabel, language]);

  const activeNavigationRouteId = activeRoute?.currentActiveMenuId || active;
  const activePrimarySurfaceId = activeRoute
    ? primarySurfaceRoute(activeRoute).id
    : activeNavigationRouteId;
  const activeNavItem =
    localizedNavItems.find(
      (item) => item.routeId === activePrimarySurfaceId,
    ) ||
    localizedNavItems.find(
      (item) =>
        item.children?.some((child) => child.id === activeNavigationRouteId),
    ) ||
    localizedNavItems.find(
      (item) => item.moduleId === activeModule && !routeById(item.routeId)?.parentId,
    );
  const activeModuleLabel =
    (activeRoute ? routeLabel(activeRoute, true) : "") || activeNavItem?.label || activeModule;
  const activeChildLabel = activeRoute?.parentId
    ? routeLabel(activeRoute)
    : undefined;
  const activeCapabilityId = activeRoute
    ? capabilityIdForRoute(activeRoute)
    : undefined;
  const capabilityAccess = activeCapabilityId
    ? resolveCapabilityRouteAccess({
        moduleId: activeCapabilityId,
        loadState: capabilityLoadState,
        capabilities,
        experimentalModuleIds,
      })
    : null;
  const routeAccess = useMemo<GovernedRouteAccessContext>(
    () => ({
      capabilityLoadState,
      enabledCapabilityIds: enabledModuleIds,
      authorizationLoadState,
      effectivePermissionCodes,
      moduleVisibility: authorizationVisibility,
    }),
    [
      authorizationLoadState,
      capabilityLoadState,
      effectivePermissionCodes,
      enabledModuleIds,
      authorizationVisibility,
    ],
  );
  const activeRouteHasPermission = activeRoute
    ? hasRoutePermission(activeRoute, effectivePermissionCodes)
    : false;
  // Mirrors the route gate below so in-page links are hidden instead of
  // landing on the "Access denied" or "Capability unavailable" screens.
  const canOpenRoute = useCallback(
    (routeId: string) => {
      // A moved route answers for the page it now redirects to.
      const route = currentRouteFor(routeById(routeId));
      if (!route) return false;
      // Frozen, retired and internal pages render a lock screen, not the page.
      if (
        [
          "FROZEN_UNAVAILABLE",
          "LEGACY_REDIRECT",
          "LEGACY_UNAVAILABLE",
          "INTERNAL_ONLY",
          "NOT_IMPLEMENTED",
        ].includes(route.directAccessBehavior)
      )
        return false;
      if (
        route.requiredPermission &&
        (authorizationLoadState !== "ready" ||
          !hasRoutePermission(route, effectivePermissionCodes))
      )
        return false;
      const capabilityId = capabilityIdForRoute(route);
      if (!capabilityId) return true;
      return (
        resolveCapabilityRouteAccess({
          moduleId: capabilityId,
          loadState: capabilityLoadState,
          capabilities,
          experimentalModuleIds,
        }).status === "allowed"
      );
    },
    [
      authorizationLoadState,
      capabilities,
      capabilityLoadState,
      effectivePermissionCodes,
      experimentalModuleIds,
    ],
  );
  const contentMaxWidthClass =
    panelModule === "srm"
      ? "max-w-[1440px]"
      : [
            "overview",
            "reports",
            "imports",
            "universal-intake",
            "review-actions",
            "collaboration-drafts",
            "audit-history",
            "pilot-readiness",
            "settings",
          ].includes(activeModule)
        ? "max-w-[1360px]"
        : "max-w-[1320px]";
  const searchGroups = useMemo(() => {
    const grouped = new Map<string, GlobalSearchResult[]>();
    searchResults.forEach((result) => {
      const key = searchGroupKey(result.type);
      grouped.set(key, [...(grouped.get(key) || []), result]);
    });
    return Array.from(grouped.entries())
      .sort(([left], [right]) => {
        const leftIndex = SEARCH_GROUP_ORDER.indexOf(left);
        const rightIndex = SEARCH_GROUP_ORDER.indexOf(right);
        return (
          (leftIndex === -1 ? 99 : leftIndex) -
          (rightIndex === -1 ? 99 : rightIndex)
        );
      })
      .map(([type, results]) => ({
        type,
        label: labelIn(SEARCH_GROUP_LABELS[type], language) || type,
        results: results.slice(0, SEARCH_GROUP_VISIBLE_LIMIT),
        hiddenCount: Math.max(0, results.length - SEARCH_GROUP_VISIBLE_LIMIT),
      }));
  }, [searchResults, language]);
  const visibleSearchResults = useMemo(
    () => searchGroups.flatMap((group) => group.results),
    [searchGroups],
  );

  useEffect(() => {
    setAiActiveContext((current) => {
      const contextModule = current?.module;
      const activeContextModule =
        activeModule === "rfq" ||
        activeModule === "purchaseRequests" ||
        activeModule === "purchasing"
          ? "procurement"
          : activeModule;
      if (!contextModule || contextModule === activeContextModule)
        return current;
      return null;
    });
  }, [activeModule]);

  useEffect(() => {
    setActiveSearchIndex(visibleSearchResults.length ? 0 : -1);
  }, [visibleSearchResults.length]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!searchRef.current?.contains(event.target as Node))
        setSearchOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  async function runGlobalSearch(query = searchQuery) {
    const trimmed = query.trim();
    setSearchQuery(query);
    setSearchError("");
    setSearchRestricted(false);
    if (!trimmed) {
      setSearchResults([]);
      setSearchOpen(false);
      setActiveSearchIndex(-1);
      return;
    }
    setSearchLoading(true);
    setSearchOpen(true);
    try {
      const payload = await apiJson<{
        query: string;
        results: GlobalSearchResult[];
        total: number;
        restrictedSubjects?: string[];
      }>(`/api/search?q=${encodeURIComponent(trimmed)}`);
      setSearchResults(payload.results);
      setSearchRestricted(Boolean(payload.restrictedSubjects?.length));
      setActiveSearchIndex(payload.results.length ? 0 : -1);
    } catch (error) {
      setSearchResults([]);
      setSearchError(error instanceof Error ? error.message : t("top.searchUnavailable"));
    } finally {
      setSearchLoading(false);
    }
  }

  function applyNavigationIntent(
    intent: CanonicalNavigationIntent,
    returnContext?: WorkflowContext | null,
  ) {
    routerNavigate(routePathForId(intent.activeId));
    if (intent.returnTo) setFocusReturnActive(intent.returnTo);
    if (returnContext !== undefined) setFocusReturnContext(returnContext);
    setSearchFocus(
      intent.focusTarget
        ? {
            ...intent.focusTarget,
            entityLabel: intent.entityLabel,
            source: intent.source,
            at: Date.now(),
          }
        : null,
    );
  }

  function navigateTo(
    moduleId: string,
    focusTarget?: CanonicalFocusTarget | null,
    options: {
      returnTo?: string;
      entityLabel?: string;
      returnContext?: WorkflowContext | null;
      source?: string;
      query?: Record<string, string>;
    } = {},
  ) {
    const requestedRoute = currentRouteFor(routeById(moduleId));
    const navigationRoute =
      requestedRoute &&
      !requestedRoute.parentId &&
      requestedRoute.entryBehavior === "redirect-to-default-child"
        ? defaultRouteForModule(requestedRoute.moduleId)
        : requestedRoute;
    const navigationId = navigationRoute?.id || moduleId;
    const sourceLabel = activeChildLabel || activeModuleLabel;
    const focusLabel = focusTarget
      ? `${focusEntityLabel(focusTarget.entityType, language)} ${focusTarget.entityId}`
      : "";
    const inferredReturnContext = focusTarget
      ? buildReturnContext({
          sourceModule: activeModule,
          sourceRoute: active,
          sourceEntityType: searchFocus?.entityType,
          sourceEntityId: searchFocus?.entityId,
          sourceLabel: searchFocus?.entityLabel || focusLabel || sourceLabel,
          originIntent: options.source || "businessNavigation",
          returnLabel: searchFocus?.entityId
            ? language === "en-US"
              ? `Back to ${focusEntityLabel(searchFocus.entityType, language)} ${searchFocus.entityId}`
              : `返回 ${focusEntityLabel(searchFocus.entityType, language)} ${searchFocus.entityId}`
            : options.source === "ai" || options.source === "aiRuntimeGateway"
              ? language === "en-US" ? "Back to AI results" : "返回 AI 结果"
              : options.source === "globalSearch"
                ? language === "en-US" ? "Back to search" : "返回全局搜索"
                : language === "en-US" ? `Back to ${sourceLabel}` : `返回${sourceLabel}`,
        })
      : null;
    const nextIntent = navigationIntentFromModule(navigationId, {
      focusTarget,
      source: options.source || (focusTarget ? "evidence" : undefined),
      returnTo: options.returnTo,
      entityLabel: options.entityLabel,
    });
    if (options.query && Object.keys(options.query).length) {
      const query = new URLSearchParams(options.query);
      routerNavigate(`${routePathForId(nextIntent.activeId)}?${query.toString()}`);
      if (nextIntent.returnTo) setFocusReturnActive(nextIntent.returnTo);
      setFocusReturnContext(options.returnContext !== undefined ? options.returnContext : inferredReturnContext);
      setSearchFocus(null);
      return;
    }
    if (focusTarget && focusTarget.entityType in businessEntityRouteRegistry) {
      const entityType = focusTarget.entityType as BusinessEntityType;
      const params = new URLSearchParams();
      if (focusTarget.focusArea) params.set("focus", focusTarget.focusArea);
      const detailPath = businessEntityPath(entityType, focusTarget.entityId);
      routerNavigate(params.size ? `${detailPath}?${params.toString()}` : detailPath);
      if (nextIntent.returnTo) setFocusReturnActive(nextIntent.returnTo);
      setFocusReturnContext(options.returnContext !== undefined ? options.returnContext : inferredReturnContext);
      setSearchFocus({
        ...focusTarget,
        entityLabel: options.entityLabel,
        source: options.source || "businessNavigation",
        at: Date.now(),
      });
      return;
    }
    applyNavigationIntent(
      nextIntent,
      options.returnContext !== undefined
        ? options.returnContext
        : inferredReturnContext,
    );
  }

  async function openActionDraftReview(request: ActionDraftPreviewRequest) {
    if (isStructuredDraftType(request.type)) {
      const target = structuredDraftTarget(request.type, request.payload, request.source);
      navigateTo(target.moduleId, null, { returnTo: "ai", entityLabel: request.title, source: "ai", query: target.query });
      return;
    }
    setDraftShellOpen(true);
    setDraftPreview(null);
    setDraftError("");
    setDraftLoading(true);
    try {
      const response = await apiJson<{
        draft: ActionDraftPreview;
        previewOnly: boolean;
      }>("/api/action-drafts/preview", {
        method: "POST",
        body: JSON.stringify(request),
      });
      setDraftPreview(response.draft);
      if (!response.previewOnly)
        setDraftError(draftMessage("previewBoundary", language));
    } catch (error) {
      setDraftError(actionDraftErrorMessage(error, language));
    } finally {
      setDraftLoading(false);
    }
  }

  async function saveActionDraftReview(draft: ActionDraftPreview) {
    const response = await apiJson<{
      draft: ActionDraftPreview;
      persisted: boolean;
      createsBusinessDocument: boolean;
      requiresConfirmation: boolean;
    }>("/api/action-drafts/save", {
      method: "POST",
      body: JSON.stringify({ draft }),
    });
    if (response.createsBusinessDocument) {
      throw new Error(draftMessage("createsDocument", language));
    }
    setDraftPreview(response.draft);
    toast.success(draftMessage("saved", language), {
      description: draftMessage("savedDetail", language),
    });
  }

  function openSearchResult(result: GlobalSearchResult) {
    applyNavigationIntent(
      navigationIntentFromGlobalSearchResult(result, { returnTo: active }),
      {
        sourceModule: activeModule,
        sourceRoute: active,
        sourceLabel: activeChildLabel || activeModuleLabel,
        returnLabel: language === "en-US" ? "Back to search" : "返回全局搜索",
        originIntent: "globalSearch",
      },
    );
    setSearchOpen(false);
    setActiveSearchIndex(-1);
  }

  const panels: Record<string, React.ReactNode> = {
    overview: (
      <OverviewPanel
        initialView={activeView}
        onNavigate={navigateTo}
        onOpenAi={() => setAiOpenSignal(Date.now())}
        onReviewActionDraft={openActionDraftReview}
      />
    ),
    sales: (
      <SalesDemandPage
        initialView={activeView as any}
        focus={searchFocus}
        onNavigate={navigateTo}
        onOpenAi={() => setAiOpenSignal(Date.now())}
      />
    ),
    inventory: (
      <InventoryPanel
        initialView={activeView as any}
        focus={searchFocus}
        onNavigate={navigateTo}
        onActiveContextChange={setAiActiveContext}
        onReviewActionDraft={openActionDraftReview}
      />
    ),
    forecast: (
      <ForecastPanel
        initialView={activeView as any}
        onNavigate={navigateTo}
        onReviewActionDraft={openActionDraftReview}
      />
    ),
    // Compatibility aliases for older dashboard/report actions; sidebar uses module:view ids.
    purchaseRequests: (
      <ProcurementPanel
        view="requests"
        intent={purchaseIntent}
        focus={searchFocus}
        onOpenRfq={() => navigateTo("procurement:rfq")}
        onNavigate={navigateTo}
        onActiveContextChange={setAiActiveContext}
      />
    ),
    purchasing: (
      <ProcurementPanel
        view="orders"
        focus={searchFocus}
        onNavigate={navigateTo}
      />
    ),
    rfq: (
      <ProcurementPanel
        view="rfq"
        focus={searchFocus}
        onNavigate={navigateTo}
        onActiveContextChange={setAiActiveContext}
      />
    ),
    receiving: <ReceivingPanel focus={searchFocus} onNavigate={navigateTo} />,
    "receiving-workbench": (
      <ReceivingPostingWorkbench
        receivingDocumentId={
          searchFocus?.entityType === "receiving_doc"
            ? searchFocus.entityId
            : decodeURIComponent(
                location.pathname.split("/").filter(Boolean).at(-1) || "",
              )
        }
        onNavigate={navigateTo}
      />
    ),
    "outbound-workbench": <OutboundWorkbench />,
    "inventory-operations": <InventoryOperationsWorkbench />,
    "inventory-reorder": <ReorderListPage />,
    "returns-quarantine": <ReturnQuarantineWorkbench />,
    procurement: (
      <ProcurementPanel
        view={activeView as any}
        intent={purchaseIntent}
        focus={searchFocus}
        onOpenRfq={() => navigateTo("procurement:rfq")}
        onNavigate={navigateTo}
        onActiveContextChange={setAiActiveContext}
      />
    ),
    srm: (
      <SrmPage
        initialView={activeView as any}
        focus={searchFocus}
        onNavigate={navigateTo}
        onActiveContextChange={setAiActiveContext}
      />
    ),
    "master-data": (
      <MasterDataPage
        initialView={activeView as any}
        focus={searchFocus}
        onNavigate={navigateTo}
        onActiveContextChange={setAiActiveContext}
      />
    ),
    "data-import": <DataImportPage />,
    finance: (
      <FinanceWorkbench
        initialView={activeView as any}
        onNavigate={navigateTo}
      />
    ),
    "mobile-operations": <MobileOperationsPage initialView={activeView} />,
    reports: (
      <ReportsPanel initialView={activeView as any} onNavigate={navigateTo} />
    ),
    imports: (
      <ImportsPanel initialView={activeView as any} onNavigate={navigateTo} />
    ),
    "universal-intake": <UniversalIntakePanel />,
    "exception-cases": <ExceptionCasesPage onNavigate={navigateTo} />,
    "collaboration-drafts": <CollaborationDraftsPage onNavigate={navigateTo} />,
    "review-actions": <ReviewFirstActionWorkflowV2 onNavigate={navigateTo} />,
    "audit-history": <AuditHistoryPage onNavigate={navigateTo} />,
    "pilot-readiness": <PilotReadinessPage onNavigate={navigateTo} />,
    settings: (
      <SettingsPage initialView={activeView as any} onNavigate={navigateTo} />
    ),
  };

  function handleLogin(nextUser: WorkspaceUser, token: string) {
    setUser(nextUser);
    setAuthToken(token);
    window.dispatchEvent(new Event("flowchain:localization-changed"));
  }

  function logout() {
    // End the server session too; the local sign-out happens either way.
    apiJson("/api/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(CURRENT_USER_KEY);
    setAuthToken("");
    setUser(null);
    window.dispatchEvent(new Event("flowchain:localization-changed"));
  }

  // An emailed sign-in link lands here, signed in or not.
  if (location.pathname === SIGN_IN_CONFIRM_PATH) {
    return (
      <SignInConfirmScreen
        onSignedIn={(nextUser, token) => {
          handleLogin(nextUser, token);
          routerNavigate("/", { replace: true });
        }}
      />
    );
  }

  // An invitation link lands here, signed in or not.
  if (location.pathname === ACCEPT_INVITATION_PATH) {
    return <AcceptInvitationScreen localStatus={localStatus} />;
  }

  if (!authToken || !user) {
    return <LoginScreen localStatus={localStatus} />;
  }

  return (
    <div
      className="h-screen flex overflow-hidden"
      style={{ background: A.bg, fontFamily: "var(--fc-font-family)" }}
    >
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            borderRadius: 14,
            fontSize: 12,
            fontFamily: "var(--fc-font-family)",
            boxShadow:
              "0 8px 24px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06)",
          },
        }}
      />
      <aside
        className="hidden w-56 shrink-0 flex-col lg:flex"
        style={{
          background: A.sidebar,
          borderRight: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div
          className="px-5 py-5"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center"
              style={{ background: A.blue }}
            >
              <Activity size={14} className="text-white" strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-sm font-semibold leading-none text-white">
                {PRODUCT_NAME}
              </div>
              <div className="fc-caption mt-1" style={{ color: A.sidebarSub }}>
                {language === "en-US" ? "AI-powered inventory and supply chain workspace" : PRODUCT_TAGLINE}
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {navGroups.map((group) => {
            const isCollapsible =
              "defaultCollapsed" in group && group.defaultCollapsed;
            const isExpanded = !isCollapsible || expandedNavGroups[group.label];
            return (
              <div key={group.label}>
                {isCollapsible ? (
                  <button
                    type="button"
                    aria-expanded={Boolean(isExpanded)}
                    onClick={() =>
                      setExpandedNavGroups((current) => ({
                        ...current,
                        [group.label]: !current[group.label],
                      }))
                    }
                    className="w-full flex items-center justify-between gap-2 fc-caption font-semibold uppercase tracking-widest px-2 mb-2"
                    style={{ color: "rgba(148,163,184,0.58)" }}
                  >
                    <span>{group.label === "主导航" ? t("nav.primary") : t("nav.advanced")}</span>
                    <ChevronRight
                      size={12}
                      className="transition-transform"
                      style={{
                        transform: isExpanded
                          ? "rotate(90deg)"
                          : "rotate(0deg)",
                      }}
                    />
                  </button>
                ) : (
                  <div
                    className="fc-caption font-semibold uppercase tracking-widest px-2 mb-2"
                    style={{ color: "rgba(148,163,184,0.58)" }}
                  >
                    {group.label === "主导航" ? t("nav.primary") : t("nav.advanced")}
                  </div>
                )}
                {isExpanded && (
                  <div className="space-y-0.5">
                    {group.itemIds.map((itemId) => {
                      const item = localizedNavItems.find(
                        (entry) => entry.id === itemId,
                      );
                      const governedRoute = item
                        ? routeById(item.routeId)
                        : undefined;
                      if (
                        !item ||
                        !governedRoute ||
                        !isRouteVisibleInNavigation(
                          governedRoute,
                          "PRIMARY",
                          routeAccess,
                        )
                      )
                        return null;
                      const isActive = activeNavItem?.id === item.id;
                      return (
                        <div key={item.id} className="space-y-0.5">
                          <button
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => navigateTo(item.routeId)}
                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-colors duration-150"
                            style={
                              isActive
                                ? {
                                    background: A.sidebarAccent,
                                    color: "#f8fafc",
                                  }
                                : {
                                    background: "transparent",
                                    color: A.sidebarSub,
                                  }
                            }
                          >
                            <item.icon
                              size={15}
                              strokeWidth={isActive ? 2 : 1.8}
                            />
                            {/* Long labels such as "Payables & receivables" wrap instead of being cut off. */}
                            <span className="min-w-0 text-left leading-snug">{item.label}</span>
                            {governedRoute.requiredCapability &&
                              capabilities[governedRoute.requiredCapability]
                                ?.maturity === "beta" && (
                              <span className="ml-auto rounded bg-blue-500/20 px-1.5 py-0.5 text-[9px] text-blue-100">
                                Beta
                              </span>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div
          className="p-3 space-y-1"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <button
            onClick={() => setAiOpenSignal(Date.now())}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-colors duration-150"
            style={{ background: "transparent", color: A.sidebarSub }}
          >
            <Sparkles size={15} strokeWidth={1.8} />
            <span>{t("nav.ai")}</span>
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Topbar */}
        <header
          className="h-12 flex items-center justify-between px-3 sm:px-6 shrink-0 bg-white"
          style={{
            borderBottom: `1px solid ${A.border}`,
          }}
        >
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <select
              aria-label={t("nav.primary")}
              value={activeNavItem?.routeId || activeModule}
              onChange={(event) => navigateTo(event.target.value)}
              className="max-w-[150px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs lg:hidden"
            >
              {localizedNavItems
                .filter((item) => {
                  const governedRoute = routeById(item.routeId);
                  return Boolean(
                    governedRoute &&
                      isRouteVisibleInNavigation(
                        governedRoute,
                        "PRIMARY",
                        routeAccess,
                      ),
                  );
                })
                .map((item) => (
                  <option key={item.id} value={item.routeId}>
                    {item.label}
                  </option>
                ))}
            </select>
            <span className="fc-label font-medium" style={{ color: A.label }}>
              {workspaceName || user.company}
            </span>
            {localStatus && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" title={`User ${user.email} · Demo ${localStatus.demoMasterDataLoaded ? "loaded" : "not loaded"} · Scenario ${localStatus.demoScenarioLoaded ? "loaded" : "not loaded"} · Universal Intake ${localStatus.universalIntakeEnabled ? "enabled" : "disabled"}`}>Local Development</span>}
          </div>
          <div className="flex items-center gap-2">
            <form
              ref={searchRef}
              onSubmit={(event) => {
                event.preventDefault();
                runGlobalSearch();
              }}
              className="relative hidden sm:block"
            >
              <div
                className="flex items-center gap-2 w-72 px-3 py-1.5 rounded-lg text-xs"
                style={{ color: A.gray1, background: A.gray6 }}
              >
                <button
                  type="submit"
                  className="shrink-0"
                  aria-label={t("top.search")}
                >
                  {searchLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Search size={14} />
                  )}
                </button>
                <input
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    if (!event.target.value.trim()) {
                      setSearchResults([]);
                      setSearchOpen(false);
                    }
                  }}
                  onFocus={() => {
                    if (searchQuery.trim()) setSearchOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSearchOpen(false);
                      return;
                    }
                    if (!searchOpen || visibleSearchResults.length === 0)
                      return;
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveSearchIndex(
                        (current) =>
                          (current + 1 + visibleSearchResults.length) %
                          visibleSearchResults.length,
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveSearchIndex(
                        (current) =>
                          (current - 1 + visibleSearchResults.length) %
                          visibleSearchResults.length,
                      );
                      return;
                    }
                    if (event.key === "Enter" && activeSearchIndex >= 0) {
                      event.preventDefault();
                      openSearchResult(visibleSearchResults[activeSearchIndex]);
                    }
                  }}
                  placeholder={t("top.search")}
                  className="w-full bg-transparent outline-none text-xs"
                  style={{ color: A.label }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label={t("top.searchClear")}
                    onClick={() => {
                      setSearchQuery("");
                      setSearchResults([]);
                      setSearchOpen(false);
                      setSearchError("");
                    }}
                    className="shrink-0"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              {searchOpen && (
                <div
                  className="absolute right-0 top-full mt-2 w-[420px] rounded-xl shadow-xl z-30 overflow-hidden"
                  style={{
                    background: A.white,
                    border: `1px solid ${A.border}`,
                  }}
                >
                  <div
                    className="px-3 py-2 flex items-center justify-between"
                    style={{ borderBottom: `1px solid ${A.border}` }}
                  >
                    <span
                      className={typography.searchResultTitle}
                      style={{ color: A.label }}
                    >
                      {t("top.searchResults")}
                    </span>
                    <span
                      className={typography.searchResultMeta}
                      style={{ color: A.gray2 }}
                    >
                      {searchLoading
                        ? t("top.searching")
                        : t(searchResults.length === 1 ? "top.searchCountOne" : "top.searchCount", { count: searchResults.length })}
                    </span>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {searchLoading && (
                      <div
                        className="px-4 py-6 text-xs flex items-center gap-2"
                        style={{ color: A.gray1 }}
                      >
                        <Loader2 size={14} className="animate-spin" /> {t("top.searching")}
                      </div>
                    )}
                    {!searchLoading && searchError && (
                      <div
                        className="px-4 py-6 text-xs"
                        style={{ color: A.red }}
                      >
                        {searchError}
                      </div>
                    )}
                    {!searchLoading &&
                      !searchError &&
                      searchResults.length === 0 && (
                        <div
                          className="px-4 py-6 text-xs"
                          style={{ color: A.gray2 }}
                        >
                          {t("top.searchEmpty")}
                        </div>
                      )}
                    {!searchLoading &&
                      !searchError &&
                      searchGroups.length > 0 &&
                      (() => {
                        let rowIndex = -1;
                        return searchGroups.map((group) => (
                          <div key={group.type}>
                            <div
                              className="px-3 pt-3 pb-1 fc-caption font-semibold uppercase tracking-normal"
                              style={{ color: A.gray2 }}
                            >
                              {group.label}
                            </div>
                            {group.results.map((result) => {
                              rowIndex += 1;
                              const activeResult =
                                rowIndex === activeSearchIndex;
                              const hint = result.evidence?.[0]
                                ? `${workspaceCopy(result.evidence[0].label, language)}: ${result.evidence[0].value}`
                                : result.matchedFields.slice(0, 2).join(" / ");
                              return (
                                <button
                                  key={result.id}
                                  type="button"
                                  onClick={() => openSearchResult(result)}
                                  aria-selected={activeResult}
                                  className="w-full text-left px-3 py-3 transition-colors"
                                  style={{
                                    borderBottom: `1px solid ${A.border}`,
                                    background: activeResult
                                      ? "#eef4ff"
                                      : "transparent",
                                  }}
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span
                                          className="fc-caption px-1.5 py-0.5 rounded font-semibold"
                                          style={{
                                            background: activeResult
                                              ? A.white
                                              : "#eef4ff",
                                            color: A.blue,
                                          }}
                                        >
                                          {labelIn(SEARCH_TYPE_LABELS[result.type], language) ||
                                            result.type}
                                        </span>
                                        <span
                                          className={`${typography.searchResultTitle} truncate`}
                                          style={{ color: A.label }}
                                        >
                                          {result.label}
                                        </span>
                                      </div>
                                      <div
                                        className={`${typography.searchResultMeta} mt-1 truncate`}
                                        style={{ color: A.sub }}
                                      >
                                        {/* Runtime results repeat the server's status label as the subtitle. */}
                                        {result.subtitle && result.subtitle === result.status
                                          ? workspaceCopy(result.status, language)
                                          : result.subtitle || result.entityLabel}
                                      </div>
                                      {hint && (
                                        <div
                                          className={`${typography.searchResultMeta} mt-1 truncate`}
                                          style={{ color: A.gray2 }}
                                        >
                                          {hint}
                                        </div>
                                      )}
                                    </div>
                                    {result.status && (
                                      <span
                                        className="shrink-0 fc-caption px-2 py-0.5 rounded-full font-medium"
                                        style={{
                                          background: A.gray6,
                                          color: A.gray1,
                                        }}
                                      >
                                        {workspaceCopy(result.status, language)}
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                            {group.hiddenCount > 0 && (
                              <div
                                className={`${typography.searchResultMeta} px-3 py-2`}
                                style={{
                                  color: A.gray2,
                                  borderBottom: `1px solid ${A.border}`,
                                }}
                              >
                                {t("top.searchMore", { count: group.hiddenCount })}
                              </div>
                            )}
                          </div>
                        ));
                      })()}
                    {!searchLoading && !searchError && searchRestricted && (
                      <div
                        className={`${typography.searchResultMeta} px-3 py-2`}
                        style={{ color: A.gray2 }}
                      >
                        {t("top.searchRestricted")}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </form>
            <button
              type="button"
              disabled
              aria-label={language === 'en-US' ? 'Notifications unavailable' : '通知中心尚未接入'}
              title={language === 'en-US' ? 'Notifications unavailable' : '通知中心尚未接入'}
              className="relative p-2 rounded-md opacity-45"
              style={{ color: A.gray1 }}
            >
              <Bell size={15} strokeWidth={1.8} />
            </button>
            <div className="relative">
              <button
                onClick={() => setProfileOpen((value) => !value)}
                className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-md hover:bg-slate-100 transition-colors"
              >
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-[11px] font-semibold">
                  {user.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="hidden sm:block text-left">
                  <div
                    className="text-[12px] font-medium leading-tight"
                    style={{ color: A.label }}
                  >
                    {user.name}
                  </div>
                  <div
                    className="fc-caption leading-tight"
                    style={{ color: A.gray2 }}
                  >
                    {workspaceCopy(user.roleLabel || roleLabel(user.role), language)}
                  </div>
                </div>
              </button>

              {profileOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setProfileOpen(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-20">
                    {[
                      {
                        icon: User,
                        label: t("top.profile"),
                        onClick: () => navigateTo("settings:profile"),
                      },
                      {
                        icon: Settings,
                        label: t("top.settings"),
                        onClick: () => navigateTo("settings:company"),
                      },
                      { icon: LogOut, label: t("top.logout"), onClick: logout },
                    ].map(({ icon: Icon, label, onClick }) => (
                      <button
                        key={label}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                        onClick={() => {
                          setProfileOpen(false);
                          onClick();
                        }}
                      >
                        <Icon size={13} className="text-slate-400" />
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          <main
            className="flex-1 overflow-auto p-3 sm:p-6"
            data-testid="app-main"
          >
            <div
              id="module-export-scope"
              data-testid="module-export-scope"
              className={`mx-auto w-full ${contentMaxWidthClass}`}
            >
              <RouteAvailabilityProvider value={canOpenRoute}>
              {activeRoute ? (
                <ModuleShell route={activeRoute} routeAccess={routeAccess}>
                  {activeRoute.directAccessBehavior === "LEGACY_REDIRECT" ? (
                    <Card className="p-10 text-center" data-testid="legacy-route-redirecting">
                      <Loader2 className="mx-auto animate-spin text-slate-500" size={32} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "This page has moved. Opening its new location…" : "页面已迁移，正在打开新位置…"}</h2>
                    </Card>
                  ) : activeRoute.directAccessBehavior === "NOT_IMPLEMENTED" ? (
                    <Card className="p-10 text-center" data-testid="route-not-implemented">
                      <AlertTriangle className="mx-auto text-amber-600" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Page unavailable" : "页面尚未接通"}</h2>
                      <p className="mt-2 text-sm text-slate-500">
                        {activeRoute.knownLimitations || (language === "en-US" ? "This route is recognized, but its production page is not connected." : "当前路径已识别，但正式业务页面尚未接通。")}
                      </p>
                      <button
                        type="button"
                        className="mt-5 text-sm font-semibold text-blue-600 hover:underline"
                        onClick={() =>
                          routerNavigate(
                            routeById(activeRoute.returnListRouteId || "")?.path ||
                              "/app/overview",
                          )
                        }
                      >
                        {language === "en-US" ? "Back to " : "返回"}{routeById(activeRoute.returnListRouteId || "") ? routeLabel(routeById(activeRoute.returnListRouteId || "")!) : (language === "en-US" ? "previous page" : "上一层")}
                      </button>
                    </Card>
                  ) : activeRoute.directAccessBehavior === "LEGACY_UNAVAILABLE" ? (
                    // The retired imports pages are an unavailable module: the same
                    // "Capability unavailable" page, with no link onward.
                    <Card className="p-10 text-center" data-testid="capability-route-blocked" data-legacy-route="true">
                      <Lock className="mx-auto text-slate-500" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Capability unavailable" : "能力暂不可用"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "This page is no longer part of the product." : "该页面已不再属于产品功能。"}</p>
                    </Card>
                  ) : activeRoute.directAccessBehavior === "INTERNAL_ONLY" ? (
                    <Card className="p-10 text-center" data-testid="internal-route-blocked">
                      <Lock className="mx-auto text-slate-500" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Internal page" : "内部页面不可从普通工作台进入"}</h2>
                      <p className="mt-2 text-sm text-slate-500">
                        {language === "en-US" ? "This governance page is not available from the standard SME workspace." : "此页面属于内部治理边界，不是默认 SME 产品入口。"}
                      </p>
                    </Card>
                  ) : activeRoute.directAccessBehavior === "FROZEN_UNAVAILABLE" ? (
                    <Card className="p-10 text-center" data-testid="capability-route-blocked">
                      <Lock className="mx-auto text-slate-500" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Capability unavailable" : "能力暂不可用"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "This frozen product surface is not available." : "该冻结业务能力未作为正式产品功能启用。"}</p>
                    </Card>
                  ) : activeRoute.requiredPermission &&
                    authorizationLoadState === "loading" ? (
                    <Card className="p-10 text-center" data-testid="authorization-route-loading">
                      <Loader2 className="mx-auto animate-spin text-slate-500" size={32} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Checking access" : "正在验证访问权限"}</h2>
                    </Card>
                  ) : activeRoute.requiredPermission &&
                    authorizationLoadState === "failed" ? (
                    <Card className="p-10 text-center" data-testid="authorization-route-unavailable">
                      <ShieldAlert className="mx-auto text-amber-600" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Could not check access" : "无法验证当前访问权限"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "Refresh the page or sign in again." : "请刷新页面或重新登录。"}</p>
                    </Card>
                  ) : activeRoute.requiredPermission &&
                    !activeRouteHasPermission ? (
                    <Card className="p-10 text-center" data-testid="authorization-route-denied">
                      <ShieldAlert className="mx-auto text-amber-600" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Access denied" : "无权访问"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "Your effective permissions do not grant access to this route." : "当前有效权限未授予此页面的读取权限。"}</p>
                    </Card>
                  ) : activeCapabilityId &&
                    capabilityLoadState === "loading" ? (
                    <CapabilityRouteStatus
                      moduleLabel={activeModuleLabel}
                      maturity={capabilityAccess?.capability.maturity || "unavailable"}
                      reason={capabilityAccess?.capability.reason || ""}
                      loading
                      onNavigate={routerNavigate}
                    />
                  ) : activeCapabilityId &&
                    capabilityLoadState === "failed" ? (
                    <Card className="p-10 text-center" data-testid="capability-registry-unavailable">
                      <Lock className="mx-auto text-slate-500" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Capability registry unavailable" : "能力注册表暂不可用"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "The application could not verify whether this capability is enabled." : "无法验证该扩展能力是否启用，页面已按安全策略关闭。"}</p>
                    </Card>
                  ) : activeCapabilityId &&
                    capabilityAccess?.status === "blocked" ? (
                    <Card className="p-10 text-center" data-testid="capability-route-blocked">
                      <Lock className="mx-auto text-slate-500" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Capability unavailable" : "能力暂不可用"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "Permission is present, but this capability is disabled." : "权限已具备，但该业务能力当前未启用。"}</p>
                    </Card>
                  ) : (
                    <PanelErrorBoundary
                      key={location.pathname}
                      moduleLabel={activeChildLabel || activeModuleLabel}
                      language={language}
                    >
                      <PageTransition>
                      <React.Suspense
                        fallback={<PageSkeleton label={language === "en-US" ? "Loading module" : "模块加载中"} />}
                      >
                        <FadeIn>
                        {activeRoute.id === "procurement:rfq-detail" ? (
                          <CanonicalRfqDetailPage
                            documentId={entityIdForRoutePath(activeRoute, location.pathname)}
                            effectivePermissionCodes={effectivePermissionCodes}
                            authorizationLoadState={authorizationLoadState}
                          />
                        ) : activeRoute.id === "procurement:rfq-comparison" ? (
                          <CanonicalRfqComparisonPage
                            documentId={entityIdForRoutePath(activeRoute, location.pathname)}
                            effectivePermissionCodes={effectivePermissionCodes}
                            authorizationLoadState={authorizationLoadState}
                          />
                        ) : activeRoute.id === "procurement:order-document" ? (
                          <PurchaseOrderDocumentPage orderId={entityIdForRoutePath(activeRoute, location.pathname)} />
                        ) : activeRoute.id === "sales:invoice-document" ? (
                          <CustomerInvoiceDocumentPage invoiceId={entityIdForRoutePath(activeRoute, location.pathname)} />
                        ) : activeRoute.panelId === "receiving-workbench" ? (
                          panels["receiving-workbench"]
                        ) : activeRoute.panelId === "outbound-workbench" ? (
                          panels["outbound-workbench"]
                        ) : activeRoute.panelId === "inventory-operations" ? (
                          panels["inventory-operations"]
                        ) : activeRoute.panelId === "returns-quarantine" ? (
                          panels["returns-quarantine"]
                        ) : activeRoute.pageType === "detail" &&
                          activeRoute.entityType &&
                          ![
                            "purchase_request",
                            "purchase_order",
                            "supplier",
                            "item",
                            "settlement_document",
                            "supplier_invoice",
                            "customer_invoice",
                            "three_way_match",
                          ].includes(activeRoute.entityType) ? (
                          <BusinessEntityDetailPage route={activeRoute} />
                        ) : (
                          panels[panelModule] ||
                          panels[activeModule] ||
                          panels.overview
                        )}
                        </FadeIn>
                      </React.Suspense>
                      </PageTransition>
                    </PanelErrorBoundary>
                  )}
                </ModuleShell>
              ) : (
                <NotFoundRecovery pathname={location.pathname} />
              )}
              </RouteAvailabilityProvider>
            </div>
          </main>
        </div>
      </div>
      {/* A rendering error in the assistant must not take the page down. */}
      <PanelErrorBoundary moduleLabel={language === "en-US" ? "AI assistant" : "AI 助手"} language={language}>
        <AiPanel
          moduleId={activeModule}
          activeContext={aiActiveContext}
          openSignal={aiOpenSignal}
          onNavigate={navigateTo}
          onReviewActionDraft={openActionDraftReview}
        />
      </PanelErrorBoundary>
      <ActionDraftReviewShell
        open={draftShellOpen}
        loading={draftLoading}
        error={draftError}
        draft={draftPreview}
        onClose={() => setDraftShellOpen(false)}
        onCancelPreview={() => {
          setDraftPreview(null);
          setDraftError("");
          setDraftShellOpen(false);
        }}
        onSaveDraft={saveActionDraftReview}
        onNavigate={navigateTo}
      />
    </div>
  );
}
