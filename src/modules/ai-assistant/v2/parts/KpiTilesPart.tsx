import { isUnavailableProductRoute } from "../../../../../shared/unavailable-product-routes.mjs";
import { A } from "../../../../components/ui";
import { cardStyle, usePartCopy, type Navigate } from "./partKit";
import type { KpiTilesProps } from "./types";

// Two to six workspace figures. A figure the role may not see says so,
// rather than showing a dash that reads as "none".
export function KpiTilesPart({ props, language, onNavigate }: { props: KpiTilesProps; language?: string; onNavigate?: Navigate }) {
  const copy = usePartCopy(language);
  return (
    <ul data-testid="ai-v2-kpis" lang={copy.language} className="grid grid-cols-2 gap-2">
      {props.tiles.map((tile) => {
        const body = (
          <>
            <span className="block text-[12px] leading-4" style={{ color: A.sub }}>{copy.known("ai.v2.kpi", tile.code)}</span>
            {tile.hidden
              ? <span data-testid="ai-v2-kpi-hidden" className="mt-1 block text-[12px] leading-4" style={{ color: A.sub }}>{copy.t("ai.v2.hiddenForRole")}</span>
              : <span className="mt-1 block text-lg font-semibold tabular-nums leading-6" style={{ color: A.label }}>{copy.value(tile.value, tile.unit, tile.currency)}</span>}
          </>
        );
        const route = tile.route && onNavigate && !isUnavailableProductRoute(tile.route.moduleId) ? tile.route : null;
        return (
          <li key={tile.code} data-testid="ai-v2-kpi" className="rounded-xl px-3 py-2" style={cardStyle}>
            {route ? <button type="button" onClick={() => onNavigate?.(route.moduleId, null, { returnTo: "ai", source: "ai", query: route.query })} className="w-full text-left">{body}</button> : body}
          </li>
        );
      })}
    </ul>
  );
}
