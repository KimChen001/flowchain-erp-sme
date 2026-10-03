declare module '../../shared/roles.mjs' {
  export const ROLE_LABELS: Readonly<Record<string, string>>;
  export function roleLabel(role: string): string;
}
declare module '../../../shared/unavailable-product-routes.mjs' {
  export const FROZEN_PRODUCT_ROUTE_IDS: readonly string[];
  export function isUnavailableProductRoute(target: string | null | undefined): boolean;
}
declare module '../../shared/unavailable-product-routes.mjs' {
  export const FROZEN_PRODUCT_ROUTE_IDS: readonly string[];
  export function isUnavailableProductRoute(target: string | null | undefined): boolean;
}
