import { ChevronRight, Home } from "lucide-react";
import { Link, useLocation } from "react-router";
import { breadcrumbRoutes, type AppRouteDefinition } from "../../app/routeRegistry";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";
import { looksLikeStoredId, useDetailCrumbLabel } from "./detailCrumb";

export function AppBreadcrumb({ route }: { route: AppRouteDefinition }) {
  const location = useLocation();
  const { routeLabel, t } = useI18n();
  const items = breadcrumbRoutes(route);
  const detailLabel = useDetailCrumbLabel(location.pathname);
  // A detail page shows the name it gave itself, else the last address part
  // when it reads as a name (PO-42AA497A), else the page's own label: never
  // a stored id.
  const detailName = (item: AppRouteDefinition) => {
    const segment = decodeURIComponent(location.pathname.split("/").at(-1) || "");
    return detailLabel || (segment && !looksLikeStoredId(segment) ? segment : routeLabel(item));
  };
  return (
    <nav aria-label={t("breadcrumb")} className="fc-breadcrumb" data-testid="app-breadcrumb">
      {items.map((item, index) => {
        const current = index === items.length - 1;
        return <span key={item.id} className="inline-flex items-center gap-1.5">
          {index > 0 && <ChevronRight size={12} aria-hidden style={{ color: A.gray3 }} />}
          {current ? (
            <span aria-current="page" className="fc-caption font-semibold" style={{ color: A.label }}>{index === 0 && <Home size={12} className="mr-1 inline" />}{item.pageType === "detail" ? detailName(item) : routeLabel(item)}</span>
          ) : (
            <Link className="fc-caption inline-flex items-center gap-1 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded" style={{ color: A.blue }} to={item.path}>
              {index === 0 && <Home size={12} />}{item.parentId ? routeLabel(item) : routeLabel(item, true)}
            </Link>
          )}
        </span>;
      })}
    </nav>
  );
}
