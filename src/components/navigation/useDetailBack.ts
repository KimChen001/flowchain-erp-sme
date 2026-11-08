import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useI18n } from "../../i18n/I18n";

// The Back control of a workbench detail (an item, a supplier). On the
// detail's own address it leaves that address: to the page the record was
// opened from when the link says so (returnTo, with its returnLabel), else to
// the list. Opened inside the list, it only closes the detail.
export function useDetailBack(listPath: string, listLabel: readonly [string, string], close: () => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { language } = useI18n();
  const returnTo = params.get("returnTo") || "";
  const safeReturn = returnTo.startsWith("/app/") ? returnTo : "";
  const returnLabel = params.get("returnLabel") || "";
  const onDetailRoute = location.pathname.startsWith(`${listPath}/`);
  const label = safeReturn && returnLabel ? returnLabel : listLabel[language === "en-US" ? 0 : 1];
  const back = () => {
    close();
    if (safeReturn || onDetailRoute) navigate(safeReturn || listPath);
  };
  return { label, back };
}
