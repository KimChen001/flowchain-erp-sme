import { workspaceCopy } from "../../i18n/workspaceCopy";
import React from "react";
import { Link, useNavigate } from "react-router";
import { LayoutGroup, motion } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
  const subnav = useSubnavTrack(route.id, subRoutes.length);
  const english = language === "en-US";
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
        <nav className="fc-module-subnav relative" aria-label={language === "en-US" ? `${rootLabel} navigation` : `${rootLabel}二级导航`} data-testid="module-subnav">
          {/* One row of tabs that scrolls sideways when they do not fit (ten
              under Settings, six on a phone), with the active one in view and
              a fade on the side that has more. The active tab's background
              slides to the newly chosen tab. */}
          <div className="fc-subnav-track" ref={subnav.ref} data-more-start={subnav.start ? "" : undefined} data-more-end={subnav.end ? "" : undefined}>
          <LayoutGroup id={`fc-subnav-${root.id}`}>
            {subRoutes.map((item) => {
              const active = activeMenuId === item.id;
              return <Link key={item.id} to={item.path} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""}>
                {active && <motion.span layoutId="fc-subnav-pill" className="fc-subnav-pill" aria-hidden="true" transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.8 }} />}
                <span className="fc-subnav-label">{routeLabel(item)}</span>
              </Link>;
            })}
          </LayoutGroup>
          </div>
          {/* A mouse cannot easily scroll a row sideways, so from a tablet up
              an arrow on the side with more tabs moves the row along. */}
          {subnav.start ? <button type="button" className="fc-subnav-arrow left-1" onClick={() => subnav.move(-1)} aria-label={english ? "Show earlier tabs" : "显示前面的标签"} data-testid="module-subnav-earlier"><ChevronLeft size={16} aria-hidden /></button> : null}
          {subnav.end ? <button type="button" className="fc-subnav-arrow right-1" onClick={() => subnav.move(1)} aria-label={english ? "Show more tabs" : "显示更多标签"} data-testid="module-subnav-more"><ChevronRight size={16} aria-hidden /></button> : null}
        </nav>
      )}
      {showPageHeader && route.moduleId === "overview" ? (
        // Today: its tab row (Today, AI priorities) is the header, so the
        // title is read out but not drawn a second time (owner 11/13: Today
        // said "Today" four times).
        <h1 className="sr-only" data-testid="page-title">{routeLabel(route)}</h1>
      ) : showPageHeader && (
        <div className="fc-page-header" data-testid="page-header">
          <div className="min-w-0">
            {/* The page's one heading; settings cards below carry no second title. */}
            <h1 className="fc-page-title" data-testid="page-title">{routeLabel(route)}</h1>
          </div>
        </div>
      )}
      <div className="fc-module-content">{children}</div>
    </div>
  );
}

// The tab row's scroll box: brings the active tab into view without moving
// the page, says which sides have tabs scrolled out of view, and moves the
// row most of its width along for the arrows.
function useSubnavTrack(routeId: string, tabs: number) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [more, setMore] = React.useState({ start: false, end: false });
  // Set once the reader moves the row, so it is never pulled back.
  const moved = React.useRef(false);
  const move = React.useCallback((direction: -1 | 1) => {
    const track = ref.current;
    moved.current = true;
    if (track) track.scrollBy({ left: direction * Math.max(120, track.clientWidth * 0.7), behavior: "smooth" });
  }, []);
  React.useEffect(() => {
    const track = ref.current;
    if (!track) return;
    moved.current = false;
    const active = track.querySelector<HTMLElement>('[aria-current="page"]');
    // An active tab out of view is centred: again while the row and the tab
    // still change size (0 wide on the first render, wider once its label
    // turns bold), until the reader moves the row.
    const place = () => {
      if (moved.current || !active || track.clientWidth === 0 || track.scrollWidth <= track.clientWidth) return;
      const outside = active.offsetLeft < track.scrollLeft || active.offsetLeft + active.offsetWidth > track.scrollLeft + track.clientWidth;
      if (outside) track.scrollLeft = Math.max(0, active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2);
    };
    const update = () => {
      place();
      const rest = track.scrollWidth - track.clientWidth - track.scrollLeft;
      const next = { start: track.scrollLeft > 2, end: rest > 2 };
      setMore((current) => (current.start === next.start && current.end === next.end ? current : next));
    };
    const byReader = () => { moved.current = true; };
    update();
    track.addEventListener("scroll", update, { passive: true });
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"] as const) track.addEventListener(name, byReader, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(track);
    if (active) observer?.observe(active);
    return () => {
      track.removeEventListener("scroll", update);
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"] as const) track.removeEventListener(name, byReader);
      observer?.disconnect();
    };
  }, [routeId, tabs]);
  return { ref, ...more, move };
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
