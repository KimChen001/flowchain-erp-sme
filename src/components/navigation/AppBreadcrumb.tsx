import { ChevronRight, Home } from "lucide-react";
import { Link, generatePath, matchPath, useLocation } from "react-router";
import { breadcrumbRoutes, type AppRouteDefinition } from "../../app/routeRegistry";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { looksLikeStoredId, useDetailCrumbLabel } from "./detailCrumb";

export function AppBreadcrumb({ route }: { route: AppRouteDefinition }) {
  const location = useLocation();
  const { routeLabel, t, language } = useI18n();
  const items = breadcrumbRoutes(route);
  const detailLabel = useDetailCrumbLabel(location.pathname);
  // A sidebar entry is named as the sidebar names it (Today, Purchasing,
  // Receiving); other pages by their own label.
  const crumbLabel = (item: AppRouteDefinition) => {
    if (item.navigationVisibility === "PRIMARY" && item.navigationLabel) return workspaceCopy(item.navigationLabel, language);
    return item.parentId ? routeLabel(item) : routeLabel(item, true);
  };
  // A detail page shows the name it gave itself, else the last address part
  // when it is the record's key and reads as a name (PO-42AA497A), else the
  // page's own label: never a stored id, nor a fixed word such as "document".
  const detailName = (item: AppRouteDefinition) => {
    const segment = decodeURIComponent(location.pathname.split("/").at(-1) || "");
    const keyed = (item.path.split("/").at(-1) || "").startsWith(":");
    return detailLabel || (keyed && segment && !looksLikeStoredId(segment) ? segment : routeLabel(item));
  };
  // A parent detail page (the PO above its document, the RFQ above its
  // comparison) takes its :id from the current address; a crumb never links
  // to a route pattern. A parent whose params cannot be filled is not linked.
  const params = matchPath(route.path, location.pathname)?.params ?? {};
  const crumbHref = (item: AppRouteDefinition) => {
    if (!item.path.includes(":")) return item.path;
    try {
      return generatePath(item.path, params);
    } catch {
      return null;
    }
  };
  // A one-step trail (Today on Today) only repeats the page's tab and title
  // below it, so a top-level page shows none.
  if (items.length < 2) return null;
  return (
    // On a phone a list page's trail repeats its tab and title, so only a
    // record's page, where it leads back to the list, keeps it there.
    <nav aria-label={t("breadcrumb")} className={`fc-breadcrumb ${route.pageType === "detail" ? "" : "max-sm:hidden"}`} data-testid="app-breadcrumb">
      {items.map((item, index) => {
        const current = index === items.length - 1;
        const href = current ? null : crumbHref(item);
        return <span key={item.id} className="inline-flex min-w-0 items-center gap-1.5">
          {index > 0 && <ChevronRight size={12} aria-hidden style={{ color: A.gray3 }} />}
          {current ? (
            <span aria-current="page" className="fc-caption min-w-0 truncate font-semibold" style={{ color: A.label }}>{index === 0 && <Home size={12} className="mr-1 inline" />}{item.pageType === "detail" ? detailName(item) : crumbLabel(item)}</span>
          ) : href ? (
            <Link className="fc-caption inline-flex items-center gap-1 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded" style={{ color: A.blue }} to={href}>
              {index === 0 && <Home size={12} />}{crumbLabel(item)}
            </Link>
          ) : (
            <span className="fc-caption inline-flex items-center gap-1" style={{ color: A.gray1 }}>{index === 0 && <Home size={12} />}{crumbLabel(item)}</span>
          )}
        </span>;
      })}
    </nav>
  );
}
