import React from "react";
import { Link, useNavigate } from "react-router";
import { defaultRouteForModule, moduleRoute, recoveryModuleForPath, routesForModule } from "../../app/routeRegistry";
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
  const root = moduleRoute(route.moduleId) || route;
  const subRoutes = routesForModule(route.moduleId).filter((item) =>
    isRouteVisibleInNavigation(item, "SECONDARY", routeAccess),
  );
  const activeMenuId = route.currentActiveMenuId || route.id;
  const showModuleHeader = route.id === root.id;
  const showPageHeader = route.id !== root.id && route.pageType !== "detail" && route.moduleId !== "reports";
  return (
    <div className="fc-module-shell" data-testid="module-shell" data-route-id={route.id}>
      <AppBreadcrumb route={route} />
      {!showModuleHeader && <span className="sr-only" data-testid="module-title">{routeLabel(root, true)}</span>}
      {showModuleHeader && <div className="fc-module-header">
        <div>
          <h1 className="fc-module-title" data-testid="module-title">{route.moduleId === "settings" && workspaceName ? workspaceName : routeLabel(root, true)}</h1>
        </div>
      </div>}
      {subRoutes.length > 0 && (
        <nav className="fc-module-subnav" aria-label={language === "en-US" ? `${routeLabel(root, true)} navigation` : `${routeLabel(root, true)}二级导航`} data-testid="module-subnav">
          {subRoutes.map((item) => <Link key={item.id} to={item.path} aria-current={activeMenuId === item.id ? "page" : undefined} className={activeMenuId === item.id ? "is-active" : ""}>{routeLabel(item)}</Link>)}
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
  const root = recoveryModuleForPath(pathname);
  return <div className="mx-auto max-w-2xl rounded-2xl bg-white p-8 text-center" data-testid="not-found-recovery" style={{ border: `1px solid ${A.border}` }}>
    <div className="fc-caption" style={{ color: A.gray2 }}>404</div>
    <h1 className="fc-module-title mt-2">未找到页面</h1>
    <p className="fc-body mt-2" style={{ color: A.sub }}>{root ? `“${root.moduleLabel}”中不存在这个子页面。` : "当前链接不存在或已被移除。"}</p>
    <div className="mt-5 flex justify-center gap-2">
      {root && <button className="fc-action-button fc-action-secondary" onClick={() => navigate(defaultRouteForModule(root.moduleId)?.path || root.path)}>返回{root.moduleLabel}默认页面</button>}
      <button className="fc-action-button fc-action-primary" onClick={() => navigate("/app/overview")}>返回首页</button>
    </div>
  </div>;
}
