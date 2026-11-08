import type { ReactNode } from "react";
import { isUnavailableProductRoute } from "../../../shared/unavailable-product-routes.mjs";
import { Link, useLocation } from "react-router";
import { businessEntityPath, businessEntityRouteRegistry, type BusinessEntityType } from "./businessEntityRoutes";
import { businessEntityCopy } from "./businessEntityCopy";
import { useI18n } from "../../i18n/I18n";
import { isDocumentNumberType, useDocumentNumber } from "../../lib/documentNumbers";
import { useBackLabel } from "../navigation/backLabel";

type Props = {
  entityType: BusinessEntityType;
  entityId?: string | null;
  children?: ReactNode;
  className?: string;
  exists?: boolean;
  returnLabel?: string;
  /** The document number when the payload carries it (purchase requests, RFQs and purchase orders). */
  number?: string | null;
};

export function BusinessEntityLink({ entityType, entityId, children, className = "", exists = true, returnLabel, number }: Props) {
  const location = useLocation();
  // The i18n language, not <html lang>, which is updated only after a language change renders.
  const { language } = useI18n();
  const copy = (label: string) => businessEntityCopy(label, language);
  const backLabel = useBackLabel();
  const value = entityId?.trim();
  // Purchase requests, RFQs and purchase orders are shown by their number; the id stays in the link.
  const shown = useDocumentNumber(isDocumentNumberType(entityType) ? entityType : null, value, number) || value;
  const text = children === undefined || children === null || children === value ? shown : children;
  if (!value || !exists) return <span className={className || undefined}>{value ? text : children ?? "—"}</span>;
  const route = businessEntityRouteRegistry[entityType];
  // A record of a frozen or unavailable surface is shown as text, not a link.
  if (isUnavailableProductRoute(route.routeId)) return <span className={className || undefined}>{text}</span>;
  const params = new URLSearchParams();
  params.set("returnTo", `${location.pathname}${location.search}`);
  // Back goes to this page, so the label names this page unless the caller
  // gave one.
  params.set("returnLabel", returnLabel ? copy(returnLabel) : backLabel() || copy(route.returnLabel));
  const href = `${businessEntityPath(entityType, value)}?${params.toString()}`;
  return (
    <Link
      to={href}
      aria-label={`${copy(route.label)} ${shown}`}
      className={`font-semibold text-blue-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded-sm ${className}`}
    >
      {text}
    </Link>
  );
}
