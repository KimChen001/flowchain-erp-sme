import React, { useState, useEffect, useMemo, useRef } from "react";
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
import { navGroups, navItems } from "./routes";
import {
  defaultRouteForModule,
  routeById,
  routeByPath,
  routePathForId,
} from "./routeRegistry";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../lib/constants";
import {
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
  RecoveryActions,
} from "../components/ui";
import { BusinessBackLink } from "../components/navigation/BusinessBackLink";
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

import ReceivingPanel from "../modules/receiving/Page";
import ReceivingPostingWorkbench from "../modules/receiving/ReceivingPostingWorkbench";
import InventoryPanel from "../modules/inventory/Page";
import ForecastPanel from "../modules/forecast/Page";
import OverviewPanel from "../modules/overview/Page";
import ProcurementPanel from "../modules/procurement/Page";
import FinanceWorkbench from "../modules/finance/Page";
import SrmPage from "../modules/srm/Page";
import MasterDataPage from "../modules/master-data/Page";
import AiPanel, { type ActiveContext } from "../modules/ai-assistant/Panel";
import {
  ActionDraftReviewShell,
  type ActionDraftPreview,
  type ActionDraftPreviewRequest,
  type ConfirmedActionResult,
} from "../modules/action-drafts/ActionDraftReviewShell";
import ExceptionCasesPage from "../modules/exception-cases/Page";
import SalesDemandPage from "../modules/sales/Page";
import CollaborationDraftsPage from "../modules/collaboration-drafts/Page";
import SettingsPage from "../modules/settings/Page";
import AuditHistoryPage from "../modules/audit-history/Page";
import PilotReadinessPage from "../modules/pilot-readiness/Page";
import { ReviewFirstActionWorkflowV2 } from "../components/actions/ReviewFirstActionWorkflowV2";
import { BusinessEntityDetailPage } from "../components/business/BusinessEntityDetailPage";
import OutboundWorkbench from "../modules/sales/OutboundWorkbench";
import InventoryOperationsWorkbench from "../modules/inventory/InventoryOperationsWorkbench";
import MobileOperationsPage from "../modules/mobile/MobileOperationsPage";
import ReturnQuarantineWorkbench from "../modules/inventory/ReturnQuarantineWorkbench";
import { useI18n } from "../i18n/I18n";

const ReportsPanel = React.lazy(() => import("../modules/reports/Page"));
const ImportsPanel = React.lazy(() => import("../modules/imports/Page"));
const UniversalIntakePanel = React.lazy(() => import("../modules/intake/Page"));

function actionDraftErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return "草稿预览暂不可用，请补充上下文后重试。";
  if (/^\s*[{[]/.test(message) || /<html|stack|trace| at /i.test(message)) {
    return "当前动作需要人工复核，尚未接入草稿预览。";
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
  entityLabel?: string;
  source?: string;
  at: number;
};

const SEARCH_TYPE_LABELS: Record<string, string> = {
  sales_order: "销售订单",
  purchase_request: "PR",
  rfq: "RFQ",
  purchase_order: "PO",
  receiving_doc: "GRN",
  supplier_invoice: "发票",
  supplier: "供应商",
  item: "物料",
  inventory_item: "库存",
  warehouse: "仓库",
  bin: "库位",
};

const SEARCH_GROUP_LABELS: Record<string, string> = {
  sales_order: "销售订单",
  purchase_request: "采购申请",
  rfq: "RFQ / 寻源",
  purchase_order: "采购订单",
  receiving_doc: "采购收货单",
  supplier_invoice: "供应商发票",
  supplier: "供应商资料",
  item: "物料",
  inventory_item: "库存",
  warehouse: "仓库 / 库位",
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

type LocalDevelopmentStatus = {
  localDevelopment: true;
  tenantId: string;
  workspaceName: string;
  availableLoginEmails: string[];
  demoMasterDataLoaded: boolean;
  demoScenarioLoaded: boolean;
  universalIntakeEnabled: boolean;
};

const FOCUS_ENTITY_LABELS: Record<string, string> = {
  customer_order: "销售订单",
  sales_order: "销售订单",
  inventory_availability: "库存可用量",
  inventory_item: "SKU",
  item: "SKU",
  sku: "SKU",
  purchase_request: "采购申请",
  rfq: "RFx",
  purchase_order: "采购订单",
  receiving_doc: "收货单",
  supplier: "供应商",
  supplier_invoice: "供应商发票",
  exception_case: "异常工单",
};

function searchGroupKey(type: string) {
  return type === "bin" ? "warehouse" : type;
}

function LoginScreen({
  onLogin,
  localStatus,
}: {
  onLogin: (user: WorkspaceUser, token: string) => void;
  localStatus: LocalDevelopmentStatus | null;
}) {
  const [form, setForm] = useState({
    company: "FlowChain Workspace",
    name: "Kim",
    email: "kim@example.com",
  });
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await apiJson<{ token: string; user: WorkspaceUser }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify(form),
        },
      );
      localStorage.setItem(AUTH_TOKEN_KEY, result.token);
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(result.user));
      onLogin(result.user, result.token);
      toast.success("登录成功，用户档案已保存");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "登录失败，请检查服务连接状态",
      );
    } finally {
      setLoading(false);
    }
  }

  const update =
    (key: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [key]: event.target.value }));
    };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: A.bg, fontFamily: "var(--fc-font-family)" }}
    >
      <Toaster position="top-right" />
      <div className="w-full max-w-5xl grid grid-cols-[1.05fr_0.95fr] gap-8 items-center">
        <section className="space-y-8">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, #0071e3 0%, #32ade6 100%)",
              }}
            >
              <Activity size={20} className="text-white" strokeWidth={2.5} />
            </div>
            <div>
              <div
                className="text-2xl font-semibold"
                style={{ color: A.label }}
              >
                {PRODUCT_NAME}
              </div>
              <div className="text-sm" style={{ color: A.sub }}>
                {PRODUCT_TAGLINE}
              </div>
            </div>
          </div>

          <div>
            <h1
              className="text-[38px] leading-tight font-semibold mb-4"
              style={{ color: A.label }}
            >
              把基础资料、采购、销售、库存和经营分析连接到同一个工作台。
            </h1>
            <p
              className="text-base leading-7 max-w-xl"
              style={{ color: A.sub }}
            >
              FlowChain 是面向中小企业的 ERP
              进销存协同平台，当前连接基础资料、采购、销售、库存、经营分析和运营财务。付款、收款、退款、税务与总账执行尚未启用。
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 max-w-xl">
            {[
              ["采", "采购协同"],
              ["库", "库存管理"],
              ["析", "经营洞察"],
            ].map(([value, label]) => (
              <div
                key={label}
                className="rounded-2xl px-4 py-3"
                style={{
                  background: A.white,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                }}
              >
                <div
                  className="text-lg font-semibold"
                  style={{ color: A.label }}
                >
                  {value}
                </div>
                <div className="text-xs" style={{ color: A.gray1 }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
        </section>

        <form
          onSubmit={submit}
          className="rounded-[20px] p-6 space-y-4"
          style={{
            background: A.white,
            boxShadow:
              "0 18px 60px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.08)",
          }}
        >
          <div className="flex items-center gap-3 pb-2">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: "#f0f6ff", color: A.blue }}
            >
              <Lock size={16} />
            </div>
            <div>
              <div
                className="text-base font-semibold"
                style={{ color: A.label }}
              >
                进入工作台
              </div>
              <div className="text-xs" style={{ color: A.gray1 }}>
                输入用户信息，进入 FlowChain 工作台
              </div>
            </div>
          </div>
          {localStatus && (
            <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900" data-testid="local-login-metadata">
              <div className="font-semibold">Local Development · {localStatus.workspaceName}</div>
              <div className="mt-1">本地可用账户：{localStatus.availableLoginEmails.join("、")}</div>
              <div className="mt-2 flex gap-2">
                {localStatus.availableLoginEmails.map((email) => (
                  <button key={email} type="button" className="rounded-md bg-white px-2 py-1" onClick={() => setForm((current) => ({ ...current, email }))}>
                    {email === "admin@flowchain.local" ? "使用本地管理员" : "使用本地经理"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(
            [
              ["company", "公司名称"],
              ["name", "姓名"],
              ["email", "邮箱"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs font-medium" style={{ color: A.gray1 }}>
                {label}
              </span>
              <input
                value={form[key]}
                onChange={update(key)}
                className="mt-1 w-full h-11 rounded-xl px-3 text-sm outline-none"
                style={{
                  background: A.gray6,
                  color: A.label,
                  border: "0.5px solid rgba(0,0,0,0.08)",
                }}
                type={key === "email" ? "email" : "text"}
                required
              />
            </label>
          ))}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-white disabled:opacity-70"
            style={{ background: A.blue }}
          >
            {loading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <ShieldCheck size={15} />
            )}
            {loading ? "正在进入" : `进入 ${PRODUCT_NAME}`}
          </button>
        </form>
      </div>
    </div>
  );
}

type PanelErrorBoundaryProps = {
  children: React.ReactNode;
  moduleLabel: string;
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
    return { hasError: true, errorMessage: error.message || "未知错误" };
  }

  componentDidCatch(error: Error) {
    console.error("FlowChain module crashed", error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

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
            {this.props.moduleLabel}模块加载失败
          </h2>
          <p className="text-sm leading-6 mb-5" style={{ color: A.gray1 }}>
            页面数据已经保留，当前只是这个模块渲染时遇到异常，不会退出登录。错误信息：
            {this.state.errorMessage}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, errorMessage: "" })}
            className="h-9 px-4 rounded-lg text-sm font-semibold text-white"
            style={{ background: A.blue }}
          >
            重新加载模块
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
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchFocus, setSearchFocus] = useState<GlobalSearchFocus | null>(
    null,
  );
  const [focusReturnActive, setFocusReturnActive] = useState("overview");
  const [focusReturnContext, setFocusReturnContext] =
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
  const [authorizationVisibility, setAuthorizationVisibility] = useState<Record<string, { visible: boolean; permissionAllowed: boolean; capabilityAllowed: boolean }> | null>(null);
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
        route &&
        !route.parentId &&
        route.entryBehavior === "redirect-to-default-child"
      ) {
        const destination = defaultRouteForModule(route.moduleId);
        if (destination && destination.path !== route.path)
          routerNavigate(destination.path, { replace: true });
      }
    }
  }, [location.pathname, routerNavigate]);

  const activeRoute = routeByPath(location.pathname);
  const active = activeRoute?.id || "not-found";
  const activeModule = activeRoute?.moduleId || "overview";
  const activeView = activeRoute?.viewId;
  const panelModule = activeRoute?.panelId || activeModule;

  useEffect(() => {
    setCapabilityLoadState("loading");
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
    if (!authToken) { setAuthorizationVisibility(null); return; }
    apiJson<{ moduleVisibility: Record<string, { visible: boolean; permissionAllowed: boolean; capabilityAllowed: boolean }> }>("/api/authorization/context")
      .then((result) => setAuthorizationVisibility(result.moduleVisibility))
      .catch(() => setAuthorizationVisibility(null));
  }, [authToken]);

  useEffect(() => {
    if (!activeRoute?.entityType || !activeRoute.entityIdParam) return;
    const entityId = decodeURIComponent(
      location.pathname.split("/").filter(Boolean).at(-1) || "",
    );
    if (!entityId) return;
    setSearchFocus((current) =>
      current?.entityType === activeRoute.entityType &&
      current.entityId === entityId
        ? current
        : {
            entityType: activeRoute.entityType!,
            entityId,
            entityLabel: entityId,
            source: "detailUrl",
            at: Date.now(),
          },
    );
  }, [activeRoute?.id, location.pathname]);

  const localizedNavItems = useMemo(() => navItems.map(item => {
    const root = routeById(item.routeId);
    return {
      ...item,
      label: root ? routeLabel(root, true) : item.label,
      children: item.children?.map(child => {
        const route = routeById(child.id);
        return { ...child, label: route ? routeLabel(route) : child.label };
      }),
    };
  }), [routeLabel]);

  function navItemMatchesActive(item: (typeof localizedNavItems)[number]) {
    return (
      item.id === activeModule ||
      Boolean(
        item.children?.some(
          (child) => child.id === (activeRoute?.currentActiveMenuId || active),
        ),
      )
    );
  }

  const activeNavItem = localizedNavItems.find(navItemMatchesActive);
  const activeModuleLabel =
    (activeRoute ? routeLabel(activeRoute, true) : "") || activeNavItem?.label || activeModule;
  const activeChildLabel = activeRoute?.parentId
    ? routeLabel(activeRoute)
    : undefined;
  const capabilityAccess = resolveCapabilityRouteAccess({
    moduleId: activeRoute?.capabilityId || activeModule,
    loadState: capabilityLoadState,
    capabilities,
    experimentalModuleIds,
  });
  const authorizationModule = panelModule === "returns-quarantine" ? "returns-quarantine" : panelModule === "receiving-posting" ? "receiving" : activeModule;
  const authorizationAccess = authorizationVisibility?.[authorizationModule];
  const navPermissionVisible = (moduleId: string) => {
    if (!authorizationVisibility) return true;
    if (moduleId === "inventory") return Boolean(authorizationVisibility.inventory?.visible || authorizationVisibility["returns-quarantine"]?.visible);
    return authorizationVisibility[moduleId]?.visible ?? true;
  };
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
        label: SEARCH_GROUP_LABELS[type] || type,
        results: results.slice(0, SEARCH_GROUP_VISIBLE_LIMIT),
        hiddenCount: Math.max(0, results.length - SEARCH_GROUP_VISIBLE_LIMIT),
      }));
  }, [searchResults]);
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
      }>(`/api/search?q=${encodeURIComponent(trimmed)}`);
      setSearchResults(payload.results);
      setActiveSearchIndex(payload.results.length ? 0 : -1);
    } catch (error) {
      setSearchResults([]);
      setSearchError(error instanceof Error ? error.message : "搜索暂不可用");
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
    } = {},
  ) {
    const requestedRoute = routeById(moduleId);
    const navigationRoute =
      requestedRoute &&
      !requestedRoute.parentId &&
      requestedRoute.entryBehavior === "redirect-to-default-child"
        ? defaultRouteForModule(requestedRoute.moduleId)
        : requestedRoute;
    const navigationId = navigationRoute?.id || moduleId;
    const sourceLabel = activeChildLabel || activeModuleLabel;
    const focusLabel = focusTarget
      ? `${FOCUS_ENTITY_LABELS[focusTarget.entityType] || "业务对象"} ${focusTarget.entityId}`
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
            ? `返回 ${FOCUS_ENTITY_LABELS[searchFocus.entityType] || "业务对象"} ${searchFocus.entityId}`
            : options.source === "ai" || options.source === "aiRuntimeGateway"
              ? "返回 AI 结果"
              : options.source === "globalSearch"
                ? "返回全局搜索"
                : `返回${sourceLabel}`,
        })
      : null;
    applyNavigationIntent(
      navigationIntentFromModule(navigationId, {
        focusTarget,
        source: options.source || (focusTarget ? "evidence" : undefined),
        returnTo: options.returnTo,
        entityLabel: options.entityLabel,
      }),
      options.returnContext !== undefined
        ? options.returnContext
        : inferredReturnContext,
    );
  }

  async function openActionDraftReview(request: ActionDraftPreviewRequest) {
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
        setDraftError("草稿预览边界异常：接口未返回 previewOnly。");
    } catch (error) {
      setDraftError(actionDraftErrorMessage(error));
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
      throw new Error("留存边界异常：接口声明会创建业务单据。");
    }
    setDraftPreview(response.draft);
    toast.success("草稿已保存", {
      description: "仅保存待复核草稿，不会创建业务单据。",
    });
  }

  function confirmedActionTypeForPreview(type: string) {
    const map: Record<string, string> = {
      purchase_request_draft: "create_purchase_request",
      rfq_draft: "create_rfq",
      supplier_followup_draft: "save_supplier_followup_note",
    };
    return map[type] || "save_reviewed_draft";
  }

  async function confirmSafeActionDraft(
    draft: ActionDraftPreview,
  ): Promise<ConfirmedActionResult> {
    const response = await apiJson<{
      createdRecordId?: string;
      status?: string;
      auditEventId?: string | null;
      mutatesLinkedBusinessRecords?: boolean;
      sideEffects?: Record<string, unknown>;
    }>("/api/user-confirmed-actions", {
      method: "POST",
      body: JSON.stringify({
        actionType: confirmedActionTypeForPreview(draft.type),
        draftId: draft.id,
        sourceTrigger: draft.source || "action_draft_review",
        reviewedFields: draft.payload || {},
        linkedRecords: draft.originEvidence || [],
        evidenceReferences: draft.originEvidence || [],
        auditPreview: draft.auditTrail || [],
        confirm: true,
        actor: "current_user",
      }),
    });
    if (
      response.mutatesLinkedBusinessRecords ||
      response.sideEffects?.issuesPo ||
      response.sideEffects?.sendsExternalEmail
    ) {
      throw new Error("确认边界异常：接口声明存在禁止的业务副作用。");
    }
    toast.success("安全动作已确认", {
      description: `${response.createdRecordId || "记录"} · ${response.status || "已保存"}`,
    });
    return {
      createdRecordId: response.createdRecordId,
      status: response.status,
      auditEventId: response.auditEventId,
    };
  }

  function clearFocus() {
    setSearchFocus(null);
    setFocusReturnContext(null);
  }

  function returnFromFocus() {
    const context = focusReturnContext;
    routerNavigate(
      routePathForId(context?.sourceRoute || focusReturnActive || "overview"),
    );
    setSearchFocus(
      context?.sourceEntityId && context.sourceEntityType
        ? {
            entityType: context.sourceEntityType,
            entityId: context.sourceEntityId,
            entityLabel: context.sourceLabel,
            source: context.originIntent || "businessReturn",
            at: Date.now(),
          }
        : null,
    );
    setFocusReturnContext(null);
  }

  function openSearchResult(result: GlobalSearchResult) {
    applyNavigationIntent(
      navigationIntentFromGlobalSearchResult(result, { returnTo: active }),
      {
        sourceModule: activeModule,
        sourceRoute: active,
        sourceLabel: activeChildLabel || activeModuleLabel,
        returnLabel: "返回全局搜索",
        originIntent: "globalSearch",
      },
    );
    setSearchOpen(false);
    setActiveSearchIndex(-1);
  }

  const focusEntityLabel = searchFocus
    ? `${SEARCH_TYPE_LABELS[searchFocus.entityType] || searchFocus.entityType} · ${searchFocus.entityLabel || searchFocus.entityId}`
    : "";
  const focusSourceLabel =
    searchFocus?.source === "ai" || searchFocus?.source === "aiRuntimeGateway"
      ? "AI 助手"
      : searchFocus?.source === "globalSearch"
        ? "全局搜索"
        : searchFocus?.source === "evidenceGraph" ||
            searchFocus?.source === "evidence"
          ? "证据链"
          : "业务跳转";
  const focusReturnHint =
    searchFocus?.source === "ai" || searchFocus?.source === "aiRuntimeGateway"
      ? "返回 AI 结果"
      : "可返回来源对象或返回列表";

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
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(CURRENT_USER_KEY);
    setAuthToken("");
    setUser(null);
    window.dispatchEvent(new Event("flowchain:localization-changed"));
  }

  if (!authToken || !user) {
    return <LoginScreen onLogin={handleLogin} localStatus={localStatus} />;
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
                {PRODUCT_TAGLINE}
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
                      if (
                        !item ||
                        (enabledModuleIds && !enabledModuleIds.has(item.id)) ||
                        !navPermissionVisible(item.id)
                      )
                        return null;
                      const isActive = activeNavItem?.id === item.id;
                      return (
                        <div key={item.id} className="space-y-0.5">
                          <button
                            aria-label={
                              item.id === "reports" ? "报表与分析" : undefined
                            }
                            onClick={() => navigateTo(item.id)}
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
                            <span className="truncate">{item.label}</span>
                            {capabilities[item.id]?.maturity === "beta" && (
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
              value={activeModule}
              onChange={(event) => navigateTo(event.target.value)}
              className="max-w-[150px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs lg:hidden"
            >
              {localizedNavItems
                .filter(
                  (item) => !enabledModuleIds || enabledModuleIds.has(item.id),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
            <span className="fc-label font-medium" style={{ color: A.label }}>
              {workspaceName || user.company}
            </span>
            {localStatus && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" title={`用户 ${user.email} · Demo ${localStatus.demoMasterDataLoaded ? "loaded" : "not loaded"} · Scenario ${localStatus.demoScenarioLoaded ? "loaded" : "not loaded"} · Universal Intake ${localStatus.universalIntakeEnabled ? "enabled" : "disabled"}`}>Local Development</span>}
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
                    aria-label="清空搜索"
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
                      搜索结果
                    </span>
                    <span
                      className={typography.searchResultMeta}
                      style={{ color: A.gray2 }}
                    >
                      {searchLoading
                        ? "搜索中..."
                        : `${searchResults.length} 条`}
                    </span>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {searchLoading && (
                      <div
                        className="px-4 py-6 text-xs flex items-center gap-2"
                        style={{ color: A.gray1 }}
                      >
                        <Loader2 size={14} className="animate-spin" /> 搜索中...
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
                          未找到匹配的业务记录
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
                                ? `${result.evidence[0].label}: ${result.evidence[0].value}`
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
                                          {SEARCH_TYPE_LABELS[result.type] ||
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
                                        {result.subtitle || result.entityLabel}
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
                                        {result.status}
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
                                还有 {group.hiddenCount} 条，请进入对应模块查看
                              </div>
                            )}
                          </div>
                        ));
                      })()}
                  </div>
                </div>
              )}
            </form>
            <button
              type="button"
              disabled
              aria-label="通知中心尚未接入"
              title="通知中心尚未接入"
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
                    {user.roleLabel || roleLabel(user.role)}
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
              {activeRoute ? (
                <ModuleShell route={activeRoute} capabilities={capabilities}>
                  {searchFocus && (
                    <div
                      className="mb-4 rounded-xl px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                      data-testid="focus-banner"
                      style={{
                        background: "#f0f6ff",
                        border: `1px solid ${A.border}`,
                      }}
                    >
                      <div className="min-w-0">
                        <div
                          className="text-[11px] font-semibold"
                          style={{ color: A.blue }}
                        >
                          当前聚焦
                        </div>
                        <div
                          className="mt-1 truncate text-sm font-semibold tabular-nums"
                          style={{ color: A.label }}
                        >
                          {focusEntityLabel}
                        </div>
                        <div
                          className="mt-1 text-[11px]"
                          style={{ color: A.sub }}
                        >
                          来源：{focusSourceLabel}，{focusReturnHint}。
                        </div>
                      </div>
                      <RecoveryActions
                        className="shrink-0"
                        actions={[
                          {
                            key: "previous",
                            label: "返回上一层",
                            onClick: returnFromFocus,
                            kind: "previous",
                            tone: "primary",
                          },
                          {
                            key: "module",
                            label: "返回列表",
                            onClick: () =>
                              routerNavigate(
                                routeById(
                                  activeRoute.defaultChildId ||
                                    activeRoute.parentId ||
                                    activeModule,
                                )?.path || "/app/overview",
                              ),
                            kind: "module",
                          },
                          {
                            key: "clear",
                            label: "清除聚焦",
                            onClick: clearFocus,
                            kind: "clear",
                            tone: "subtle",
                          },
                        ]}
                      />
                      <BusinessBackLink
                        context={focusReturnContext}
                        onReturn={returnFromFocus}
                      />
                    </div>
                  )}
                  {capabilityAccess.status === "loading" ? (
                    <CapabilityRouteStatus
                      moduleLabel={activeModuleLabel}
                      maturity={capabilityAccess.capability.maturity}
                      reason={capabilityAccess.capability.reason}
                      loading
                      onNavigate={routerNavigate}
                    />
                  ) : authorizationAccess && !authorizationAccess.permissionAllowed ? (
                    <Card className="p-10 text-center" data-testid="authorization-route-denied">
                      <ShieldAlert className="mx-auto text-amber-600" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Access denied" : "无权访问"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "Your effective roles do not grant read permission for this module." : "当前有效角色未授予此模块的读取权限。"}</p>
                    </Card>
                  ) : authorizationAccess && !authorizationAccess.capabilityAllowed ? (
                    <Card className="p-10 text-center" data-testid="capability-route-blocked">
                      <Lock className="mx-auto text-slate-500" size={34} />
                      <h2 className="mt-3 text-lg font-semibold">{language === "en-US" ? "Capability unavailable" : "能力暂不可用"}</h2>
                      <p className="mt-2 text-sm text-slate-500">{language === "en-US" ? "Permission is present, but this capability is disabled." : "权限已具备，但该业务能力当前未启用。"}</p>
                    </Card>
                  ) : capabilityAccess.status === "blocked" ? (
                    <CapabilityRouteStatus
                      moduleLabel={activeModuleLabel}
                      maturity={capabilityAccess.capability.maturity}
                      reason={capabilityAccess.reason}
                      onNavigate={routerNavigate}
                    />
                  ) : (
                    <PanelErrorBoundary
                      key={location.pathname}
                      moduleLabel={activeChildLabel || activeModuleLabel}
                    >
                      <React.Suspense
                        fallback={
                          <div
                            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
                            aria-label="模块加载中"
                          >
                            {[0, 1, 2, 3].map((item) => (
                              <div
                                key={item}
                                className="h-24 animate-pulse rounded-xl"
                                style={{ background: A.gray5 }}
                              />
                            ))}
                          </div>
                        }
                      >
                        {activeRoute.panelId === "receiving-workbench" ? (
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
                          ].includes(activeRoute.entityType) ? (
                          <BusinessEntityDetailPage route={activeRoute} />
                        ) : (
                          panels[panelModule] ||
                          panels[activeModule] ||
                          panels.overview
                        )}
                      </React.Suspense>
                    </PanelErrorBoundary>
                  )}
                </ModuleShell>
              ) : (
                <NotFoundRecovery pathname={location.pathname} />
              )}
            </div>
          </main>
        </div>
      </div>
      <AiPanel
        moduleId={activeModule}
        activeContext={aiActiveContext}
        openSignal={aiOpenSignal}
        onNavigate={navigateTo}
        onReviewActionDraft={openActionDraftReview}
      />
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
        onConfirmSafeAction={confirmSafeActionDraft}
        onNavigate={navigateTo}
      />
    </div>
  );
}
