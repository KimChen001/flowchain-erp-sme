import { workspaceCopy } from "../../i18n/workspaceCopy";
import React from "react";
import { Link, useNavigate } from "react-router";
import { LayoutGroup, motion } from "motion/react";
import {
  defaultRouteForModule,
  moduleRoute,
  primarySurfaceRoute,
  recoveryModuleForPath,
  routesForModule,
  routesForPrimarySurface,
} from "../../app/routeRegistry";
import {
  isRouteVisibleInNavigation,
  type GovernedAppRouteDefinition,
  type GovernedRouteAccessContext,
} from "../../app/routes/index.ts";
import { A } from "../ui";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { useI18n } from "../../i18n/I18n";

export function ModuleShell({ route, children, routeAccess }: { route: GovernedAppRouteDefinition; children: React.ReactNode; routeAccess: GovernedRouteAccessContext }) {
  const navigate = useNavigate();
  const { routeLabel, workspaceName, language } = useI18n();
  const moduleRoot = moduleRoute(route.moduleId) || route;
  const root = primarySurfaceRoute(route);
  const standalonePrimarySurface = root.id !== moduleRoot.id;
  const rootLabel = (root.navigationLabel ? workspaceCopy(root.navigationLabel, language) : "") || routeLabel(root, !standalonePrimarySurface);
  const subRoutes = standalonePrimarySurface
    ? routesForPrimarySurface(root).filter(
        (item) =>
          (item.id === root.id &&
            isRouteVisibleInNavigation(item, "PRIMARY", routeAccess)) ||
          isRouteVisibleInNavigation(item, "SECONDARY", routeAccess),
      )
    : routesForModule(route.moduleId).filter(
        (item) =>
          primarySurfaceRoute(item).id === moduleRoot.id &&
          isRouteVisibleInNavigation(item, "SECONDARY", routeAccess),
      );
  const activeMenuId = route.currentActiveMenuId || route.id;
  // A sidebar entry that is itself a list with sub-pages (Suppliers, Items)
  // is laid out like its sub-pages, as Inventory is: the sub-nav, then the
  // page title card, so the title does not move when the tab changes.
  const rootWithTabs = route.id === root.id && subRoutes.length > 1 && route.pageType !== "detail";
  const showModuleHeader = route.id === root.id && !rootWithTabs;
  const showPageHeader = (route.id !== root.id || rootWithTabs) && route.pageType !== "detail" && route.moduleId !== "reports";
  return (
    <div className="fc-module-shell" data-testid="module-shell" data-route-id={route.id}>
      <AppBreadcrumb route={route} />
      {!showModuleHeader && <span className="sr-only" data-testid="module-title">{rootLabel}</span>}
      {showModuleHeader && <div className="fc-module-header">
        <div>
          <h1 className="fc-module-title" data-testid="module-title">{route.moduleId === "settings" && workspaceName ? workspaceName : rootLabel}</h1>
        </div>
      </div>}
      {subRoutes.length > 1 && (
        <nav className="fc-module-subnav" aria-label={language === "en-US" ? `${rootLabel} navigation` : `${rootLabel}二级导航`} data-testid="module-subnav">
          {/* The active tab's background slides to the newly chosen tab. */}
          <LayoutGroup id={`fc-subnav-${root.id}`}>
            {subRoutes.map((item) => {
              const active = activeMenuId === item.id;
              return <Link key={item.id} to={item.path} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""}>
                {active && <motion.span layoutId="fc-subnav-pill" className="fc-subnav-pill" aria-hidden="true" transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.8 }} />}
                <span className="fc-subnav-label">{routeLabel(item)}</span>
              </Link>;
            })}
          </LayoutGroup>
        </nav>
      )}
      {showPageHeader && (
        <div className="fc-page-header" data-testid="page-header">
          <div className="min-w-0">
            <h1 className="fc-page-title" data-testid="page-title">{workspaceName && route.moduleId === "settings" ? `${workspaceName} · ${routeLabel(route)}` : routeLabel(route)}</h1>
          </div>
        </div>
      )}
      <div className="fc-module-content">{children}</div>
    </div>
  );
}

export function NotFoundRecovery({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { routeLabel, language } = useI18n();
  const root = recoveryModuleForPath(pathname);
  const english = language === "en-US";
  const moduleLabel = root ? routeLabel(root, true) : "";
  return <div className="mx-auto max-w-2xl rounded-2xl bg-white p-8 text-center" data-testid="not-found-recovery" style={{ border: `1px solid ${A.border}` }}>
    <div className="fc-caption" style={{ color: A.gray2 }}>404</div>
    <h1 className="fc-module-title mt-2">{english ? "Page not found" : "未找到页面"}</h1>
    <p className="fc-body mt-2" style={{ color: A.sub }}>{root
      ? (english ? `${moduleLabel} has no page at this address.` : `“${moduleLabel}”中不存在这个子页面。`)
      : (english ? "This link does not exist or has been removed." : "当前链接不存在或已被移除。")}</p>
    <div className="mt-5 flex justify-center gap-2">
      {/* Under the home module, the home button already leads to its default page. */}
      {root && root.moduleId !== "overview" && <button className="fc-action-button fc-action-secondary" onClick={() => navigate(defaultRouteForModule(root.moduleId)?.path || root.path)}>{english ? `Go to ${moduleLabel}` : `返回${moduleLabel}默认页面`}</button>}
      <button className="fc-action-button fc-action-primary" onClick={() => navigate("/app/overview")}>{english ? "Go to home" : "返回首页"}</button>
    </div>
  </div>;
}
