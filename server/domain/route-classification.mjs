export const ROUTE_CLASSES = Object.freeze({
  readOnly: 'read-only',
  previewOnly: 'preview-only',
  controlledPersistence: 'controlled-persistence',
  capabilityDisabled: 'capability-disabled',
  legacyMutation: 'legacy-mutation',
  diagnostics: 'diagnostics',
  static: 'static',
  unknownApi: 'unknown-api',
})

export const DATABASE_MODE_MUTATION_BLOCKED_ERROR = 'This mutation is not available in database persistence mode yet.'

const routeDefinitions = [
  { method: 'GET', pattern: /^\/api\/health$/, group: 'health', classification: ROUTE_CLASSES.diagnostics, writesJson: false, databaseMode: 'allowed' },
  { method: 'OPTIONS', pattern: /^\/.*$/, group: 'cors-preflight', classification: ROUTE_CLASSES.diagnostics, writesJson: false, databaseMode: 'allowed' },

  { method: 'GET', pattern: /^\/api\/me$/, group: 'auth-context', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'GET', pattern: /^\/api\/tenants\/current$/, group: 'auth-context', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, group: 'auth', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-local-session' },
  { method: 'GET', pattern: /^\/api\/auth\/me$/, group: 'auth', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },

  { method: 'GET', pattern: /^\/api\/ai\/tools$/, group: 'ai', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'POST', pattern: /^\/api\/ai\/chat$/, group: 'ai', classification: ROUTE_CLASSES.readOnly, writesJson: 'best-effort-audit', databaseMode: 'allowed-no-json-persist' },
  { method: 'GET', pattern: /^\/api\/search$/, group: 'search', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'GET', pattern: /^\/api\/today-cockpit$/, group: 'today-cockpit', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },

  { method: 'GET', pattern: /^\/api\/sales-demand\/(?:summary|orders|risks|impact|po-impact)(?:\/.*)?$/, group: 'sales-demand', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/evidence-graph(?:\/.*)?$/, group: 'evidence-graph', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/master-data\/(?:items|suppliers|warehouses|payment-terms|tax-codes)(?:\/[^/]+)?$/, group: 'master-data', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/procurement\/(?:documents|links|followups|summary)(?:\/.*)?$/, group: 'procurement-read', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/procurement\/(?:transaction-baseline|transaction-chain|supplier-responses)(?:\/.*)?$/, group: 'procurement-transactions', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'GET', pattern: /^\/api\/procurement\/purchase-requests\/[^/]+\/operational-detail$/, group: 'procurement-transactions', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'POST', pattern: /^\/api\/procurement\/(?:rfq-drafts\/from-pr|supplier-responses|supplier-responses\/compare|award-recommendations\/draft|po-drafts\/from-award)$/, group: 'procurement-transactions', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-runtime-repository' },
  { method: 'GET', pattern: /^\/api\/inventory\/(?:items|lots|serials|movements|exceptions|summary|availability|allocation|shortages|demand-supply-gap|available-to-promise|reservation-preview|sales-order-impact|po-supply-impact)(?:\/.*)?$/, group: 'inventory-read', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/inventory-movements$/, group: 'inventory-movements', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },

  { method: 'GET', pattern: /^\/api\/action-drafts\/schema$/, group: 'action-drafts', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-json-read-fallback' },
  { method: 'POST', pattern: /^\/api\/action-drafts\/preview$/, group: 'action-drafts', classification: ROUTE_CLASSES.previewOnly, writesJson: false, databaseMode: 'allowed-json-read-fallback' },
  { method: 'POST', pattern: /^\/api\/action-drafts(?:\/save)?$/, group: 'action-drafts', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/user-confirmed-actions(?:\/baseline)?$/, group: 'user-confirmed-actions', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'POST', pattern: /^\/api\/user-confirmed-actions(?:\/validate)?$/, group: 'user-confirmed-actions', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-runtime-repository' },
  { method: 'GET', pattern: /^\/api\/audit-log$/, group: 'audit-log', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },

  { method: 'GET', pattern: /^\/api\/mrp-plan$/, group: 'planning', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/sop-cycle$/, group: 'planning', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'POST', pattern: /^\/api\/sop-cycle$/, group: 'planning', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/supplier-performance$/, group: 'supplier', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/supplier-recommendations$/, group: 'supplier', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/external-signals$/, group: 'market', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/market-prices$/, group: 'market', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'POST', pattern: /^\/api\/market-prices\/refresh$/, group: 'market', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },

  { method: 'GET', pattern: /^\/api\/forecast-plans$/, group: 'forecast', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'POST', pattern: /^\/api\/forecast-plans$/, group: 'forecast', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },

  { method: 'GET', pattern: /^\/api\/purchase-requests$/, group: 'purchase-requests', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'POST', pattern: /^\/api\/purchase-requests$/, group: 'purchase-requests', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },
  { method: 'PATCH', pattern: /^\/api\/purchase-requests\/[^/]+\/status$/, group: 'purchase-requests', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },
  { method: 'POST', pattern: /^\/api\/purchase-requests\/[^/]+\/convert-to-po$/, group: 'purchase-requests', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },

  { method: 'GET', pattern: /^\/api\/rfqs$/, group: 'rfqs', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/rfqs$/, group: 'rfqs', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },
  { method: 'PATCH', pattern: /^\/api\/rfqs\/[^/]+\/status$/, group: 'rfqs', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },

  { method: 'GET', pattern: /^\/api\/purchase-orders$/, group: 'purchase-orders', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'POST', pattern: /^\/api\/purchase-orders$/, group: 'purchase-orders', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },
  { method: 'PATCH', pattern: /^\/api\/purchase-orders\/[^/]+\/status$/, group: 'purchase-orders', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },

  { method: 'GET', pattern: /^\/api\/receiving-docs$/, group: 'receiving', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed' },
  { method: 'GET', pattern: /^\/api\/procurement\/receiving\/[^/]+(?:\/(?:impact-preview|evidence|links|reconciliation))?$/, group: 'receiving-workbench', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/procurement\/purchase-orders\/[^/]+\/receiving-summary$/, group: 'receiving-workbench', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/(?:me\/profile|workspace(?:\/(?:users|warehouses|invitations))?)$/, group: 'pilot-workspace', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'PATCH', pattern: /^\/api\/(?:me\/profile|workspace|workspace\/users\/[^/]+)$/, group: 'pilot-workspace', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'PUT', pattern: /^\/api\/workspace\/users\/[^/]+\/warehouse-scopes$/, group: 'pilot-workspace', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'POST', pattern: /^\/api\/workspace\/invitations(?:\/accept|\/[^/]+\/revoke)?$/, group: 'pilot-workspace', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/authorization\/(?:context|roles)$/, group: 'authorization', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/authorization\/roles$/, group: 'authorization', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'PATCH', pattern: /^\/api\/authorization\/roles\/[^/]+$/, group: 'authorization', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'PUT', pattern: /^\/api\/authorization\/users\/[^/]+\/roles$/, group: 'authorization', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/imports\/[^/]+(?:\/issues)?$/, group: 'legacy-imports', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'POST', pattern: /^\/api\/imports\/(?:preview|[^/]+\/(?:commit|cancel))$/, group: 'legacy-imports', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/import-batches(?:\/[^/]+)?$/, group: 'legacy-imports', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'POST', pattern: /^\/api\/import-batches\/[^/]+\/rollback$/, group: 'legacy-imports', classification: ROUTE_CLASSES.capabilityDisabled, writesJson: false, databaseMode: 'capability-disabled' },
  { method: 'GET', pattern: /^\/api\/pilot\/exports\/[^/]+$/, group: 'pilot-exports', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'GET', pattern: /^\/api\/admin\/pilot-diagnostics$/, group: 'pilot-diagnostics', classification: ROUTE_CLASSES.diagnostics, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/procurement\/receiving\/[^/]+\/(?:post|reverse)$/, group: 'receiving-posting', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/sync\/(?:initial|changes)$/, group: 'mobile-sync', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/sync\/(?:clients\/register|acknowledge|clients\/[^/]+\/revoke)$/, group: 'mobile-sync', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/mobile\/.+$/, group: 'mobile-operations', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/mobile\/.+$/, group: 'mobile-operations', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'PATCH', pattern: /^\/api\/mobile\/.+$/, group: 'mobile-operations', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/(?:uploads\/[^/]+\/status|attachments\/[^/]+\/download)$/, group: 'attachments', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/(?:uploads\/stage|finance\/settlements\/[^/]+\/attachments|receiving\/drafts\/[^/]+\/attachments)$/, group: 'attachments', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'DELETE', pattern: /^\/api\/attachments\/[^/]+$/, group: 'attachments', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'GET', pattern: /^\/api\/sales\/(?:orders\/[^/]+\/outbound-state|shipments\/[^/]+\/posting-state)$/, group: 'sales-outbound-read', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/sales\/(?:orders\/[^/]+\/(?:reservations\/(?:preview|release-preview)|shipments\/preview)|shipments\/[^/]+\/(?:cancel-preview|post-preview|reverse-preview))$/, group: 'sales-outbound-preview', classification: ROUTE_CLASSES.readOnly, writesJson: false, databaseMode: 'allowed-db-read' },
  { method: 'POST', pattern: /^\/api\/sales\/(?:orders\/[^/]+\/(?:reservations\/(?:reserve|release)|shipments)|shipments\/[^/]+\/(?:cancel|post|reverse))$/, group: 'sales-outbound-command', classification: ROUTE_CLASSES.controlledPersistence, writesJson: false, databaseMode: 'allowed-db-persistence' },
  { method: 'POST', pattern: /^\/api\/receiving-docs$/, group: 'receiving', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },
  { method: 'PATCH', pattern: /^\/api\/receiving-docs\/[^/]+$/, group: 'receiving', classification: ROUTE_CLASSES.legacyMutation, writesJson: true, databaseMode: 'blocked' },
]

function normalizeMethod(method = '') {
  return String(method || '').trim().toUpperCase()
}

export function listRouteClassifications() {
  return routeDefinitions.map((route) => ({ ...route }))
}

export function classifyRoute(method = '', pathname = '') {
  const normalizedMethod = normalizeMethod(method)
  const path = String(pathname || '/')

  if (!path.startsWith('/api/')) {
    return {
      method: normalizedMethod,
      pathname: path,
      group: 'static',
      classification: ROUTE_CLASSES.static,
      writesJson: false,
      databaseMode: 'allowed',
    }
  }

  const definition = routeDefinitions.find((route) =>
    route.method === normalizedMethod && route.pattern.test(path)
  )

  if (definition) {
    return {
      method: normalizedMethod,
      pathname: path,
      group: definition.group,
      classification: definition.classification,
      writesJson: definition.writesJson,
      databaseMode: definition.databaseMode,
    }
  }

  return {
    method: normalizedMethod,
    pathname: path,
    group: 'unknown-api',
    classification: ROUTE_CLASSES.unknownApi,
    writesJson: false,
    databaseMode: normalizedMethod === 'GET' ? 'allowed' : 'review-required',
  }
}

export function isLegacyMutationRoute(method, pathname) {
  return classifyRoute(method, pathname).classification === ROUTE_CLASSES.legacyMutation
}

export function isDatabaseModeWriteBlocked({ persistenceMode = 'json', method = '', pathname = '' } = {}) {
  return persistenceMode === 'database' && isLegacyMutationRoute(method, pathname)
}

export function databaseModeMutationBlockedPayload() {
  return { error: DATABASE_MODE_MUTATION_BLOCKED_ERROR }
}

export function sendDatabaseModeMutationBlocked(res, send) {
  return send(res, 501, databaseModeMutationBlockedPayload())
}
