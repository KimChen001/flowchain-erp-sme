import type { ReactNode } from "react";
import { isUnavailableProductRoute } from "../../../shared/unavailable-product-routes.mjs";
import { Link, useLocation } from "react-router";
import { businessEntityPath, businessEntityRouteRegistry, type BusinessEntityType } from "./businessEntityRoutes";
import { workspaceCopy } from "../../i18n/workspaceCopy";

const copy = (label: string) =>
  workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

type Props = {
  entityType: BusinessEntityType;
  entityId?: string | null;
  children?: ReactNode;
  className?: string;
  exists?: boolean;
  returnLabel?: string;
};

export function BusinessEntityLink({ entityType, entityId, children, className = "", exists = true, returnLabel }: Props) {
  const location = useLocation();
  const value = entityId?.trim();
  if (!value || !exists) return <span className={className || undefined}>{children ?? value ?? "—"}</span>;
  const route = businessEntityRouteRegistry[entityType];
  // A record of a frozen or unavailable surface is shown as text, not a link.
  if (isUnavailableProductRoute(route.routeId)) return <span className={className || undefined}>{children ?? value}</span>;
  const params = new URLSearchParams();
  params.set("returnTo", `${location.pathname}${location.search}`);
  params.set("returnLabel", copy(returnLabel || route.returnLabel));
  const href = `${businessEntityPath(entityType, value)}?${params.toString()}`;
  return (
    <Link
      to={href}
      aria-label={`${copy(route.label)} ${value}`}
      className={`font-semibold text-blue-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded-sm ${className}`}
    >
      {children ?? value}
    </Link>
  );
}
