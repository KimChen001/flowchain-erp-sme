import { matchPath, useLocation } from "react-router";
import { appRouteRegistry } from "../../app/routeRegistry";
import { useI18n } from "../../i18n/I18n";
import { useDetailCrumbLabel } from "./detailCrumb";

// The wording of a link back to the page shown now ("Back to purchase
// orders", "Back to SO-202611-0006"), for links that carry this page as their
// returnTo: the label names where Back goes, not the record being opened.
// The route list is read when the label is needed, never while modules load.
export function useBackLabel() {
  const location = useLocation();
  const { routeLabel, language } = useI18n();
  const detail = useDetailCrumbLabel(location.pathname);
  return () => {
    const route = appRouteRegistry.find((item) => matchPath({ path: item.path, end: true }, location.pathname));
    const name = detail || (route ? routeLabel(route) : "");
    if (!name) return "";
    if (language !== "en-US") return `返回${name}`;
    return `Back to ${detail ? name : name.charAt(0).toLowerCase() + name.slice(1)}`;
  };
}
