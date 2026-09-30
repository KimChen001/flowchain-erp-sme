import { createContext, useContext } from "react";

// Answers "would opening this route render the page, rather than a lock
// screen?" for in-page links. The app shell supplies the answer from the
// capability registry and effective permissions; the route gate in
// FlowChainApp stays authoritative for direct access.
export type RouteAvailability = (routeId: string) => boolean;

const RouteAvailabilityContext = createContext<RouteAvailability>(() => true);

export const RouteAvailabilityProvider = RouteAvailabilityContext.Provider;

export function useRouteAvailability(): RouteAvailability {
  return useContext(RouteAvailabilityContext);
}
