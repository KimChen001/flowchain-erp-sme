export const CAPABILITY_NOT_IMPLEMENTED_CODE = 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED'

const disabled = (method, pathname, capability, message, limitations) => Object.freeze({
  method,
  pathname,
  capability,
  classification: 'capability-disabled',
  message,
  limitations: Object.freeze(limitations),
})

export const runtimeRouteAuthority = Object.freeze([
  disabled('GET', '/api/mrp-plan', 'material-requirements-planning', 'Material requirements planning is not implemented for the PostgreSQL-only runtime.', [
    'No PostgreSQL authoritative planning profile or BOM model is available.',
    'No static or in-memory planning facts are returned.',
  ]),
  disabled('GET', '/api/sop-cycle', 'sales-and-operations-planning', 'S&OP cycles are not implemented for the PostgreSQL-only runtime.', [
    'No PostgreSQL authoritative S&OP cycle model is available.',
    'No generated cycle is returned from forecast or MRP fixtures.',
  ]),
  disabled('POST', '/api/sop-cycle', 'sales-and-operations-planning', 'S&OP cycles are not implemented for the PostgreSQL-only runtime.', [
    'S&OP cycle persistence is unavailable.',
  ]),
  disabled('GET', '/api/supplier-performance', 'supplier-performance', 'Supplier performance is not implemented for the PostgreSQL-only runtime.', [
    'No authoritative PostgreSQL supplier performance projection is available.',
  ]),
  disabled('GET', '/api/supplier-recommendations', 'supplier-recommendations', 'Supplier recommendations are not implemented for the PostgreSQL-only runtime.', [
    'No authoritative quote, capacity, contract-price, or FX model is available.',
    'No static supplier recommendation is returned.',
  ]),
  disabled('GET', '/api/forecast-plans', 'forecast-planning', 'Forecast planning is not implemented for the PostgreSQL-only runtime.', [
    'No authoritative PostgreSQL forecast plan model is available.',
  ]),
  disabled('POST', '/api/forecast-plans', 'forecast-planning', 'Forecast planning is not implemented for the PostgreSQL-only runtime.', [
    'Forecast plan persistence is unavailable.',
  ]),
  disabled('GET', '/api/external-signals', 'external-signals', 'External signals are not configured for the PostgreSQL-only runtime.', [
    'No external provider with explicit provenance is configured.',
  ]),
  disabled('GET', '/api/market-prices', 'market-prices', 'Market prices are not configured for the PostgreSQL-only runtime.', [
    'No external market-data provider with explicit provenance is configured.',
  ]),
  disabled('POST', '/api/market-prices/refresh', 'market-prices', 'Market prices are not configured for the PostgreSQL-only runtime.', [
    'No external market-data provider refresh is configured.',
  ]),
])

export function capabilityDisabledRoute(method = '', pathname = '') {
  return runtimeRouteAuthority.find((route) => route.method === String(method).toUpperCase() && route.pathname === pathname) || null
}

export function capabilityNotImplementedPayload(route) {
  return {
    code: CAPABILITY_NOT_IMPLEMENTED_CODE,
    capability: route.capability,
    message: route.message,
    limitations: [...route.limitations],
  }
}
